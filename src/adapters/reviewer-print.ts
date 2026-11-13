import type { ModelOverrideSelection } from "./registry-types.ts";
import { isNativeModelToken } from "./model-token.ts";
import type { ChildProcess } from "node:child_process";
import { OwnedPrintChild, PrintChildCleanupError, type OwnedInputContext, type OwnedInputObserver, type OwnedStderrReceipt } from "./claude-print-child.ts";
import { randomUUID } from "node:crypto";
import { HUB, frame, sanitize } from "../hub/envelope.ts";
import { BasePeer } from "../hub/peers.ts";
import type { DeliveryFailureCause } from "../hub/delivery-failure.ts";
import type { Envelope } from "../hub/envelope.ts";
import type { ReviewerMcpSession, ReviewerToolName } from "./reviewer-mcp.ts";
import { createReviewerPolicyWatch, type ReviewerPolicyProbe, type ReviewerPolicyWatch } from "./reviewer-policy-watch.ts";
import { DEFAULT_REVIEW_MAX_MINUTES, MAX_REVIEW_MINUTES } from "../hub/review-budget.ts";
import { nativeReviewerQuota, type NativeReviewerQuota } from "./definitions/native-quota.ts";

/** #722: the closed list of legs a reviewer's per-review start can fail on. A class names a leg, never a path, content or token. */
class ReviewerUsageCleanupError extends PrintChildCleanupError {}
export const REVIEWER_CAUSE_CLASSES = ["version", "binary", "mcp_inventory", "plugins_hooks_apps", "sandbox_proof", "credential_root", "timeout", "unknown"] as const;
export type ReviewerCauseClass = typeof REVIEWER_CAUSE_CLASSES[number];
const REVIEWER_CAUSE_HINT: Record<ReviewerCauseClass, string> = {
  version: "the CLI version is neither verified nor trusted; see ahub agents",
  binary: "the CLI binary or a watched config file could not be bound, or changed during the proof; check the configured binary and retry",
  mcp_inventory: "the MCP server inventory or the hub server entry did not match the proof",
  plugins_hooks_apps: "plugins, hooks or apps could not be proven disabled",
  sandbox_proof: "the native sandbox proof did not pass",
  credential_root: "a host credential root is unusable; remove or repair it",
  timeout: "a proof command timed out",
  unknown: "unclassified; inspect hub.log",
};
/** The one wording for the unavailable reason, the log and `ahub status`. `detail` is only ever a credential-root path class. */
export function reviewerUnavailableReason(cause: ReviewerCauseClass, detail?: string): string {
  return `reviewer isolation unavailable [cause: ${cause}]: ${REVIEWER_CAUSE_HINT[cause]}${detail ? ` (${detail})` : ""}`;
}
/** A prepare refusal that carries its class to the host; the message stays the backend's own text. */
export class ReviewerUnavailableError extends Error {
  constructor(message: string, readonly causeClass: ReviewerCauseClass, readonly detail?: string) { super(message); }
}
/** A refused request says nothing about the reviewer's native isolation or ability to start. */
class ReviewerAdmissionError extends Error {
  constructor(readonly reason: "stale_binding" | "policy_changed") { super("review admission changed"); }
}
class ReviewerInputAdmissionError extends Error {}
class ReviewerPolicyCleanupError extends PrintChildCleanupError {
  constructor() { super("review policy worker cleanup unconfirmed; run ahub status and stop the peer before retrying"); }
}

export interface ReviewerPrintUsage { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
export interface ReviewerUsageIdentity { id: string; at: number; model?: string }
export interface ReviewerIsolationReceipt {
  backend: string;
  version: string;
  binary: string;
  profile: string;
  readOnly: true;
  strictMcp: boolean;
  ephemeral: boolean;
  enforcement?: "kernel" | "native-policy";
  freshSession?: true;
  hubToolsOnly?: true;
  evidence: readonly string[];
}
export interface ReviewerPrepareContext {
  peer: string;
  cwd: string;
  sessionId: string;
  mcpConfig: string;
  systemPrompt: string;
  privatePaths: readonly string[];
  command?: readonly string[];
  signal: AbortSignal;
  /** Host-framed public review evidence, never configuration-selected argv. */
  input?: string;
  task?: number;
  /** Captured host runtime override, absent leaves the backend's native default unchanged. */
  modelOverride?: string;
}
export interface ReviewerLaunch {
  command: readonly string[];
  args: readonly string[];
  isolation: ReviewerIsolationReceipt;
  /** Recheck the fixed producer's binary/config binding immediately before the model child is spawned. */
  current?: () => boolean;
  env?: NodeJS.ProcessEnv;
  cleanup?: () => void | Promise<void>;
  cwd?: string;
  envMode?: "replace";
  stop?: (child: ChildProcess) => Promise<void>;
  /** Latch a change in native policy for the running review, not just at spawn. */
  watchCurrent?: true;
  /** Fixed host factory: periodic work is separate from the synchronous current() authority fence. */
  startPolicyWatch?: () => ReviewerPolicyProbe;
  /** Runs only after owned teardown and before private-profile cleanup. Receives counts and opaque identity only. */
  readUsage?(startedAt: number, receive: (usage: ReviewerPrintUsage, identity: ReviewerUsageIdentity) => void): boolean;
}
export interface ReviewerBackend {
  id: string;
  taskMcp?: true;
  nativePolicy?: true;
  prepare(context: ReviewerPrepareContext): Promise<ReviewerLaunch | { unavailable: string; causeClass?: ReviewerCauseClass; detail?: string }>;
  usage?(event: unknown): ReviewerPrintUsage | undefined;
  /** #1402: the model a result frame says was served, by the backend's own native shape; absent when the frame names none. */
  model?(event: unknown): string | undefined;
  failure?(event: unknown): NativeReviewerQuota | "quota" | undefined;
  failureOnExit?(event: { exitCode: number | null; stderr: OwnedStderrReceipt }): NativeReviewerQuota | undefined;
  /** Structured native MCP events only, never model messages or tool arguments. */
  toolTrace?(event: unknown): ReviewerToolTrace | undefined;
}
export interface ReviewerToolTrace { tool: ReviewerToolName; refusal?: string }
export interface ReviewerNoVerdict extends ReviewerReviewBinding {
  task: number;
  exitCode: number | null;
  reviewCalled: boolean;
  lastTool?: ReviewerToolName;
  refusal?: string;
  /** Preserve the first full host error across later truncated native echoes; differing host errors stay uncertain. */
  hostRefusal?: string;
  refusalUncertain?: true;
}
type ReviewerTraceState = Pick<ReviewerNoVerdict, "reviewCalled" | "lastTool" | "refusal" | "hostRefusal" | "refusalUncertain">;
/** Host-produced receipt reason: an unconfirmed normal review fallback still needs a person's settlement. */
export const REVIEWER_FALLBACK_UNCONFIRMED = "reviewer fallback unconfirmed: ";
/** `safeRefusal` must have passed the host's complete privacy/secret screen before truncation. */
export function reviewerNoVerdictLine(peer: string, diagnostic: ReviewerNoVerdict, safeRefusal?: string, withheld = false): string {
  const prefix = `[${peer}] review of task #${diagnostic.task}: no verdict exit=${diagnostic.exitCode ?? "unknown"}; `;
  if (withheld) return prefix + "diagnostic withheld";
  const detail = diagnostic.lastTool ? `last hub tool ${diagnostic.lastTool}; ${diagnostic.reviewCalled ? "hub_review called" : "no hub_review call"}` : "no hub_review call";
  const line = safeRefusal === undefined ? undefined : Array.from(sanitize(safeRefusal).replace(/\s+/g, " "))
    .filter(char => !/\p{C}/u.test(char)).slice(0, 240).join("");
  return prefix + detail + (diagnostic.refusal === undefined && diagnostic.hostRefusal === undefined ? "" : `; refusal: ${line ?? "withheld"}`);
}
export interface ReviewerFailure {
  task: number;
  head?: string;
  flowRevision?: number;
  cause: "start_failed" | "quota" | "no_verdict";
  /** Only for `start_failed`: the leg that refused (#722). */
  causeClass?: ReviewerCauseClass;
  causeDetail?: string;
  reason?: "review time cap";
  quota?: readonly NativeReviewerQuota[];
}

export interface ReviewerReviewBinding { readonly head?: string; readonly flowRevision?: number }
export interface ReviewerPrintOptions {
  /** Host-only choice sampled once at the next turn/review boundary. */
  getModelOverride?: () => ModelOverrideSelection;
  cwd: string;
  command?: readonly string[];
  mcpConfig: string;
  systemPrompt: string;
  privatePaths?: readonly string[];
  watchdogMs: number;
  /** Sampled once for each actual child; activity never extends this wall-clock cap. */
  maxMinutes?(): number;
  /** Host-owned deterministic timer seam; never accepted from a review envelope. */
  reviewTimer?: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
  backend: ReviewerBackend;
  facts?(env: Envelope): string | undefined;
  verdictSince(task: number, since: number): boolean;
  onUsage?(usage: ReviewerPrintUsage, task: number, identity?: ReviewerUsageIdentity): void;
  /** Host journal ACK before any usage-producing child is constructed; absent port refuses that launch. */
  usageIntent?(attempt: string, task: number): boolean;
  /** Proven native quota is account evidence, independent of whether this task later reroutes. */
  onQuota?(reading: NativeReviewerQuota, attempt: string, current: () => boolean): boolean;
  /** Only after this attempt's owned group and watch have settled. Never grants task authority. */
  quotaSettled?(attempt: string): void;
  /** ACK after owned settlement and usage read; failed ACK retains the private profile for recovery. */
  usageSettled?(attempt: string, outcome: "complete" | "unknown", task: number): boolean;
  /** True confirms that the host re-offered the current review; void/false retains uncertainty. */
  onUnavailable?(failure: ReviewerFailure, current: () => boolean): boolean | void | Promise<boolean | void>;
  onNoVerdict?(diagnostic: ReviewerNoVerdict, current: () => boolean): void;
  log?(line: string): void;
  taskMcp?(task: number, current: () => boolean): ReviewerMcpSession;
  /** Synchronous host task/privacy/policy fence, checked again after awaited preparation. */
  admit?(env: Envelope): boolean;
  bindingCurrent?(task: number, binding: ReviewerReviewBinding): boolean;
  /** Private-profile observer input provenance only; never a native resume or budget identity. */
  beforeInput?: OwnedInputObserver;
  inputReleased?: OwnedInputObserver;
  /** Host privacy state for the currently attached reviewer input, read only for diagnostics. */
  reviewObserverHeld?(): boolean;
  /** Runs after this fresh child group, task MCP and launch cleanup are confirmed closed. */
  inputFinished?: OwnedInputObserver;
}

type ReviewTarget = Omit<ReviewerFailure, "cause">;
interface ReviewBatch { targets: (ReviewTarget | undefined)[]; next: number; failures: ReviewerFailure[] }
interface ReviewPolicyOwner { readonly child: OwnedPrintChild; readonly watch: ReviewerPolicyWatch; readonly cleanup: () => Promise<void>; readonly closed: () => void }
const reviewTarget = (env: Envelope): ReviewTarget | undefined => {
  const task = reviewTask(env);
  if (task === undefined || env.private) return undefined;
  const revision = Number(env.refs?.reviewRevision);
  return { task, ...(typeof env.refs?.commit === "string" ? { head: env.refs.commit } : {}), ...(Number.isSafeInteger(revision) && revision > 0 ? { flowRevision: revision } : {}) };
};
const remainingFailures = (batch: ReviewBatch, start: number, cause: ReviewerFailure["cause"], why?: { causeClass: ReviewerCauseClass; causeDetail?: string }): ReviewerFailure[] =>
  batch.targets.slice(start).flatMap(target => target ? [{ ...target, cause, ...(why ? { causeClass: why.causeClass, ...(why.causeDetail ? { causeDetail: why.causeDetail } : {}) } : {}) }] : []);
const reviewTask = (env: Envelope): number | undefined => {
  if (env.from !== HUB || env.kind !== "review") return undefined;
  const id = Number(env.refs?.task);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
};

export class ReviewerPrintPeer extends BasePeer {
  /** #1402: the model the last result frame named; read once at the turn end. */
  private servedModel: string | undefined;
  observedModel(): import("../hub/events.ts").ModelObservation | undefined {
    const model = this.servedModel; this.servedModel = undefined;
    return model ? { model, evidence: "served" } : undefined;
  }
  readonly hubNative = true;
  readonly hubOwned: boolean = true;
  private generation = 0;
  private child: OwnedPrintChild | undefined;
  private childCleanup: (() => Promise<void>) | undefined;
  private childCurrent: (() => boolean) | undefined;
  private policyWatch: ReviewPolicyOwner | undefined;
  private reviewMcpClose: (() => void) | undefined;
  private activeDeliveryId: string | undefined;
  private batch: ReviewBatch | undefined;
  private preparation: { abort: AbortController; done: Promise<ReviewerLaunch> } | undefined;
  private receipt: ReviewerIsolationReceipt | undefined;
  private observerSessionIdValue: string | undefined;
  get isolationReceipt(): ReviewerIsolationReceipt | undefined { return this.receipt; }
  reviewObserverInputHeld(): boolean { return this.opts.reviewObserverHeld?.() ?? false; }
  /** The task whose review the running child was started for (R4: the hub records `fresh` for its verdict). */
  reviewing: number | undefined;
  /** Privacy-only identity for a fresh review profile; never part of resume or budget authority. */
  get observerSessionId(): string | undefined { return this.observerSessionIdValue; }
  private reviewSeq = 0;
  private runningBinding: { task: number; binding: ReviewerReviewBinding } | undefined;
  private activeTrace: { task: number; generation: number; value: ReviewerTraceState } | undefined;
  /** Host observations are diagnostic data and never grant tool or verdict authority. */
  recordToolTrace(task: number, trace: ReviewerToolTrace): void {
    if (trace.tool !== "hub_review" && trace.tool !== "hub_task_show") return;
    const active = this.activeTrace, binding = this.runningBinding;
    if (!active || active.task !== task || active.generation !== this.generation || this.reviewing !== task || binding?.task !== task || this.opts.bindingCurrent?.(task, binding.binding) === false) return;
    if (typeof trace.refusal === "string") {
      if (active.value.hostRefusal === undefined) active.value.hostRefusal = trace.refusal;
      else if (active.value.hostRefusal !== trace.refusal) active.value.refusalUncertain = true;
    }
    this.observeTool(active.value, trace);
  }
  private observeTool(value: ReviewerTraceState, trace: ReviewerToolTrace): void {
    if (trace.tool !== "hub_review" && trace.tool !== "hub_task_show") return;
    value.lastTool = trace.tool;
    value.refusal = typeof trace.refusal === "string" ? trace.refusal : undefined;
    if (trace.tool === "hub_review") value.reviewCalled = true;
  }
  /** Immutable envelope identity of this running child, never the board's later head. */
  reviewBinding(task: number): ReviewerReviewBinding | undefined {
    return this.reviewing === task && this.runningBinding?.task === task ? this.runningBinding.binding : undefined;
  }
  /** Identifies the running child's authority over `task`; a replacement child for the same task gets a new token. */
  reviewToken(task: number): number | undefined {
    if (this.reviewing !== task) return undefined;
    try { if (this.childCurrent?.() === false) { this.abortReview("review policy changed"); return undefined; } }
    catch { this.abortReview("review policy changed"); return undefined; }
    return this.reviewSeq;
  }

  constructor(id: string, private readonly opts: ReviewerPrintOptions) { super(id, opts.watchdogMs); }

  recoveryMetadata(): Record<string, unknown> { return { launch: { kind: "reviewer-print", peer: this.id } }; }

  async start(): Promise<void> {
    // A retained child means a review's process group was never confirmed gone: no new review beside it.
    if (this.child) throw new Error(`${this.id}: an earlier review's process group is still running; stop it first`);
    if (this.policyWatch || this.childCleanup) throw new ReviewerPolicyCleanupError();
    if (this.preparation) throw new Error(`${this.id}: reviewer preparation is still running`);
    this.receipt = undefined;
    const generation = ++this.generation;
    try {
      const launch = await this.prepare(randomUUID());
      try {
        if (generation !== this.generation || launch.current?.() === false) throw new Error("reviewer isolation changed before startup");
        this.receipt = launch.isolation;
      } finally { await launch.cleanup?.(); }
    } catch (error) { if (generation === this.generation) this.setState("offline"); throw error; }
    if (generation === this.generation) this.setState("idle");
  }

  async stop(reason?: string): Promise<void> {
    this.generation++; // fence before the first await: a late exit settles nothing
    this.reviewMcpClose?.();
    this.receipt = undefined;
    this.batch = undefined;
    this.preparation?.abort.abort();
    await this.preparation?.done.catch(() => {});
    this.settle("needs_review", reason ?? "review stopped before settlement");
    if (this.child || this.policyWatch) this.setState("busy"); // unavailable until both owned resources are confirmed gone
    await this.kill(true); // An explicit stop may retry an earlier failed worker join.
    this.setState("offline");
  }

  protected override onWatchdog(): void { this.abortReview("review watchdog timeout", "timeout"); }

  private abortReview(reason: "review watchdog timeout" | "review output limit exceeded" | "review policy changed" | "review time cap", failureCause?: DeliveryFailureCause): void {
    const cappedTask = this.reviewing;
    const generation = ++this.generation, batch = this.batch, preparation = this.preparation;
    this.reviewing = undefined;
    this.reviewMcpClose?.();
    this.receipt = undefined;
    this.clearWatchdog();
    preparation?.abort.abort();
    this.settle("needs_review", reason, failureCause);
    // Revoke first, then confirm both preparation and the model's whole group are gone before fallback.
    void (async () => {
      if (preparation) await preparation.done.catch(() => {});
      if (generation !== this.generation) return;
      await this.kill();
      if (generation !== this.generation) return; // a person's stop owns the hold; never reroute it
      if (batch) await this.reportFailures([...batch.failures, ...remainingFailures(batch, batch.next, "no_verdict").map(failure => reason === "review time cap" && failure.task === cappedTask ? { ...failure, reason: "review time cap" as const } : failure)], generation);
      if (generation === this.generation && this.state === "busy") { this.batch = undefined; super.onWatchdog(); }
    })().catch((error: Error) => this.opts.log?.(`[${this.id}] review cleanup failed, staying busy`));
  }

  async deliver(envs: Envelope[], deliveryId?: string): Promise<void> {
    if (this.state !== "idle" || this.childCleanup) {
      if (deliveryId) this.delivery({ id: deliveryId, state: "failed_safe", reason: `${this.id} is ${this.state}` });
      throw new Error(`${this.id} is ${this.state}`);
    }
    const generation = ++this.generation;
    this.activeDeliveryId = deliveryId;
    this.batch = { targets: envs.map(reviewTarget), next: 0, failures: [] };
    this.setState("busy");
    if (deliveryId) this.delivery({ id: deliveryId, state: "accepted" });
    void this.run(envs, generation).catch((error: Error) => {
      if (generation !== this.generation) return;
      this.settle("needs_review", `reviewer failed: ${error.message}`);
      void this.kill().then(() => { if (generation === this.generation) { this.batch = undefined; this.setState("idle"); } }, () => undefined);
    });
  }

  private async run(envs: Envelope[], generation: number): Promise<void> {
    const missing: number[] = [];
    let started = false;
    const batch = this.batch!;
    const reroute = batch.failures;
    let failure: { state: "failed_safe" | "needs_review"; reason: string } | undefined;
    for (const [index, env] of envs.entries()) {
      batch.next = index;
      const task = reviewTask(env);
      if (task === undefined) continue; // a withdrawal or other notice: nothing to review
      if (env.private) { failure = { state: "needs_review", reason: "a private review is the person's, never a cloud reviewer's" }; break; }
      const since = Date.now();
      let result: { code: number | null; quota: boolean; quotaReadings?: readonly NativeReviewerQuota[]; trace: ReviewerTraceState };
      try { result = await this.review(env, task, generation); }
      catch (error) {
        if (generation !== this.generation) return;
        if (error instanceof ReviewerInputAdmissionError) {
          failure = { state: started ? "needs_review" : "failed_safe", reason: "review input provenance unavailable" };
          batch.next = envs.length;
          break;
        }
        if (error instanceof ReviewerAdmissionError) {
          this.opts.log?.(`[${this.id}] review of task #${task} skipped: ${error.reason === "stale_binding" ? "stale binding" : "review policy changed"}`);
          if (error.reason === "policy_changed") {
            missing.push(task);
            const target = batch.targets[index];
            if (target) reroute.push({ ...target, cause: "no_verdict" });
          }
          batch.next = index + 1;
          continue;
        }
        if (error instanceof PrintChildCleanupError) {
          if (error instanceof ReviewerUsageCleanupError) await this.reportFailures(batch.failures.filter(row => row.cause === "quota"), generation);
          // Unavailable until a stop confirms the group gone: no new review runs beside the survivors.
          this.opts.log?.(`[${this.id}] review of task #${task}: ${error.message}`);
          this.settle("needs_review", error instanceof ReviewerPolicyCleanupError ? error.message : `review process group still running: ${error.message}`);
          return;
        }
        // Once an earlier review in this batch ran, the batch had effects: hold it for a person, never requeue it.
        failure = { state: started ? "needs_review" : "failed_safe", reason: `reviewer could not start: ${(error as Error).message}` };
        const why = error instanceof ReviewerUnavailableError ? { causeClass: error.causeClass, causeDetail: error.detail } : { causeClass: "unknown" as const };
        this.opts.log?.(`[${this.id}] review of task #${task} could not start [cause: ${why.causeClass}]`);
        reroute.push(...remainingFailures(batch, index, "start_failed", why));
        batch.next = envs.length;
        break;
      }
      started = true;
      if (generation !== this.generation) return;
      let recorded = false;
      try { recorded = this.opts.verdictSince(task, since); } catch (error) { this.opts.log?.(`[${this.id}] verdict check for task #${task} failed: ${(error as Error).message}`); }
      if (!recorded) {
        missing.push(task);
        const target = batch.targets[index];
        const diagnostic = { ...target, task, exitCode: result.code, ...result.trace };
        try {
          if (this.opts.onNoVerdict) this.opts.onNoVerdict(diagnostic, () => generation === this.generation);
          else this.opts.log?.(reviewerNoVerdictLine(this.id, diagnostic));
        } catch { this.opts.log?.(reviewerNoVerdictLine(this.id, { task, exitCode: result.code, reviewCalled: false }, undefined, true)); }
        const quotaMetadata = result.quotaReadings?.length ? { quota: result.quotaReadings } : {};
        if (target) reroute.push({ ...target, cause: result.quota ? "quota" : "no_verdict", ...quotaMetadata });
        if (result.quota) {
          reroute.push(...remainingFailures(batch, index + 1, "quota").map(failure => ({ ...failure, ...quotaMetadata })));
          batch.next = envs.length;
          break;
        }
      }
      batch.next = index + 1;
      if (recorded && result.code !== 0) this.opts.log?.(`[${this.id}] review of task #${task} exited ${result.code}`);
    }
    if (generation !== this.generation) return;
    this.clearWatchdog(); // the child is gone; keep busy while the host settles the remaining walk
    const reoffered = await this.reportFailures(reroute, generation);
    if (generation !== this.generation) return;
    const unresolved = missing.length > 0 && !reoffered;
    const normalNoVerdict = !failure && reroute.length > 0 && reroute.every(value => value.cause === "no_verdict");
    this.settle(failure?.state ?? (unresolved ? "needs_review" : "completed"), failure?.reason ?? (unresolved ? `${normalNoVerdict ? REVIEWER_FALLBACK_UNCONFIRMED : ""}no verdict recorded for task ${missing.map(id => `#${id}`).join(", ")}` : undefined));
    if (generation === this.generation) { this.batch = undefined; this.setState("idle"); }
  }

  private async reportFailures(failures: readonly ReviewerFailure[], generation: number): Promise<boolean> {
    const seen = new Set<string>();
    let reoffered = true;
    for (const failed of failures) {
      if (generation !== this.generation) return false;
      const identity = JSON.stringify([failed.task, failed.head, failed.flowRevision]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      try { if (await this.opts.onUnavailable?.(failed, () => generation === this.generation) !== true) reoffered = false; }
      catch { reoffered = false; this.opts.log?.(`[${this.id}] reviewer fallback could not be recorded; inspect the task`); }
    }
    return reoffered;
  }

  private prepare(sessionId: string, input?: string, task?: number, mcpConfig?: string, modelOverride?: string): Promise<ReviewerLaunch> {
    const abort = new AbortController();
    const done = (async () => {
      if (this.opts.backend.taskMcp && !this.opts.taskMcp) throw new Error("task-bound reviewer MCP is unavailable");
      const launch = await this.opts.backend.prepare({ peer: this.id, cwd: this.opts.cwd, sessionId,
        mcpConfig: this.opts.backend.taskMcp ? (mcpConfig ?? '{"mcpServers":{}}') : this.opts.mcpConfig,
        systemPrompt: this.opts.systemPrompt, privatePaths: this.opts.privatePaths ?? [], command: this.opts.command, signal: abort.signal,
        ...(input === undefined ? {} : { input }), ...(task === undefined ? {} : { task }), ...(modelOverride === undefined ? {} : { modelOverride }) });
      if ("unavailable" in launch) throw new ReviewerUnavailableError(launch.unavailable, launch.causeClass ?? "unknown", launch.detail);
      const proof = launch.isolation;
      const policy = this.opts.backend.nativePolicy
        ? proof?.enforcement === "native-policy" && proof.freshSession === true && proof.hubToolsOnly === true
        : proof?.strictMcp === true && proof.ephemeral === true;
      if (abort.signal.aborted || !proof || proof.backend !== this.opts.backend.id || proof.readOnly !== true || !policy || !proof.binary || !proof.version || !proof.profile || !proof.evidence.length || !launch.command.length
        || launch.watchCurrent && (!launch.current || !launch.startPolicyWatch)) {
        await launch.cleanup?.();
        throw new ReviewerUnavailableError("reviewer isolation is unavailable or preparation was cancelled", "unknown");
      }
      return launch;
    })();
    const pending = { abort, done };
    this.preparation = pending;
    void done.finally(() => { if (this.preparation === pending) this.preparation = undefined; }).catch(() => {});
    return done;
  }

  private assertAdmission(env: Envelope, task: number, binding: ReviewerReviewBinding): void {
    if (this.opts.bindingCurrent?.(task, binding) === false) throw new ReviewerAdmissionError("stale_binding");
    if (this.opts.admit?.(env) === false) throw new ReviewerAdmissionError(this.opts.bindingCurrent?.(task, binding) === false ? "stale_binding" : "policy_changed");
  }

  private async review(env: Envelope, task: number, generation: number): Promise<{ code: number | null; quota: boolean; quotaReadings?: readonly NativeReviewerQuota[]; trace: ReviewerTraceState }> {
    const revision=Number(env.refs?.reviewRevision);
    const binding: ReviewerReviewBinding=Object.freeze({head:env.refs?.commit,flowRevision:Number.isSafeInteger(revision)&&revision>0?revision:undefined});
    this.assertAdmission(env, task, binding);
    const selection = this.opts.getModelOverride?.();
    if (selection?.model !== undefined && !isNativeModelToken(selection.model)) throw new ReviewerAdmissionError("policy_changed");
    let facts: string | undefined;
    try { facts = this.opts.facts?.(env); } catch (error) { this.opts.log?.(`[${this.id}] review facts for task #${task} failed: ${(error as Error).message}`); }
    const input = `${frame(env)}${facts ? `\n\n${facts}` : ""}`;
    const sessionId = randomUUID();
    const inputContext: OwnedInputContext = Object.freeze({ sessionId, inputId: randomUUID() });
    this.observerSessionIdValue = sessionId;
    try { this.opts.beforeInput?.(inputContext, [env]); }
    catch { this.observerSessionIdValue = undefined; throw new ReviewerInputAdmissionError(); }
    let launch: ReviewerLaunch | undefined;
    const trace: ReviewerTraceState = { reviewCalled: false };
    this.activeTrace = { task, generation, value: trace };
    const mcp = this.opts.backend.taskMcp ? this.opts.taskMcp?.(task, () => generation === this.generation && this.reviewToken(task) !== undefined && this.opts.bindingCurrent?.(task,binding) !== false) : undefined;
    let mcpClosed = false, mcpCloseConfirmed = false;
    const closeMcp = () => {
      if (mcpClosed) return;
      mcpClosed = true;
      try { mcp?.close(); mcpCloseConfirmed = true; }
      catch { this.opts.log?.(`[${this.id}] reviewer task MCP cleanup incomplete`); }
      if (this.reviewMcpClose === closeMcp) this.reviewMcpClose = undefined;
    };
    this.reviewMcpClose=closeMcp;
    let ownedChild: OwnedPrintChild | undefined, releasing: Promise<void> | undefined;
    let deadline: { handle: unknown } | undefined;
    const clearDeadline = () => {
      if (!deadline) return;
      if (this.opts.reviewTimer) this.opts.reviewTimer.clear(deadline.handle);
      else clearTimeout(deadline.handle as ReturnType<typeof setTimeout>);
      deadline = undefined;
    };
    let inputReleased = false, childClosed = false, launchCleanupConfirmed = false;
    let nativeStartedAt: number | undefined, usageRead = false;
    const quotaAttempt = randomUUID().replaceAll("-", "");
    let quotaSettlementSent = false;
    let accountingAttempt: string | undefined, accountingOutcome: "complete" | "unknown" = "unknown";
    let inputFinished = false;
    const finishInput = () => {
      const closedWithoutChild = !ownedChild || ownedChild.process.pid === undefined;
      if (!inputFinished && mcpCloseConfirmed && launchCleanupConfirmed && (closedWithoutChild || inputReleased && childClosed)) {
        inputFinished = true;
        try { this.opts.inputFinished?.(inputContext, [env]); } catch { /* A cleanup receipt never changes the verdict. */ }
      }
    };
    let policyOwner: ReviewPolicyOwner | undefined;
    const release = () => releasing ??= Promise.resolve().then(() => {
      if (!quotaSettlementSent) {
        quotaSettlementSent = true;
        this.opts.quotaSettled?.(quotaAttempt);
      }
      if (accountingAttempt) {
        if (!usageRead) {
          usageRead = true;
          if (ownedChild?.process.pid === undefined) accountingOutcome = "complete";
          else if (nativeStartedAt !== undefined && launch?.readUsage) {
            try { if (launch.readUsage(nativeStartedAt, (usage, identity) => this.opts.onUsage?.(usage, task, identity))) accountingOutcome = "complete"; }
            catch { /* An unreadable or uncommitted count remains unknown. */ }
          }
        }
        if (this.opts.usageSettled?.(accountingAttempt, accountingOutcome, task) !== true)
          throw new ReviewerUsageCleanupError("reviewer accounting settlement was not acknowledged");
        if (accountingOutcome === "unknown") throw new ReviewerUsageCleanupError("reviewer usage is incomplete; owned profile retained");
      }
      return launch?.cleanup?.();
    }).then(() => {});
    try {
    launch = await this.prepare(sessionId, input, task, mcp?.config, selection?.model);
    if (generation !== this.generation) throw new ReviewerAdmissionError("stale_binding");
    this.assertAdmission(env, task, binding);
    if (launch.current?.() === false) throw new ReviewerUnavailableError("reviewer isolation changed before child spawn", "binary");
    this.receipt = launch.isolation;
    const maxMinutes = this.opts.maxMinutes?.() ?? DEFAULT_REVIEW_MAX_MINUTES;
    if (!Number.isFinite(maxMinutes) || maxMinutes <= 0 || maxMinutes > MAX_REVIEW_MINUTES) throw new ReviewerAdmissionError("policy_changed");
    let quota = false;
    const quotaReadings = new Map<NativeReviewerQuota["id"], NativeReviewerQuota>();
    const publishedQuota = new Set<string>();
    const observeQuota = (reading: NativeReviewerQuota) => {
      const key = JSON.stringify(reading);
      if (publishedQuota.has(key)) return;
      try { if (this.opts.onQuota?.(reading, quotaAttempt, () => generation === this.generation) === true) publishedQuota.add(key); }
      catch { /* Retain the proven quota in the batch even if its immediate account write could not commit. */ }
    };
    const rememberQuota = () => {
      const batch = this.batch, target = batch?.targets[batch.next];
      if (!batch || generation !== this.generation || target?.task !== task) return;
      const failure: ReviewerFailure = { ...target, cause: "quota", ...(quotaReadings.size ? { quota: [...quotaReadings.values()] } : {}) };
      const prior = batch.failures.findIndex(row => row.task === target.task && row.head === target.head && row.flowRevision === target.flowRevision && row.cause === "quota");
      if (prior < 0) batch.failures.push(failure); else batch.failures[prior] = failure;
    };
    if (launch.readUsage) {
      const attempt = randomUUID().replaceAll("-", "");
      if (this.opts.usageIntent?.(attempt, task) !== true) throw new ReviewerAdmissionError("policy_changed");
      accountingAttempt = attempt;
      // The journal intent precedes spawn: the native agent-file already contains the review facts.
      this.assertAdmission(env, task, binding);
    }
    const child = new OwnedPrintChild({ peer: this.id, command: launch.command, args: launch.args,
      cwd: launch.cwd ?? this.opts.cwd, env: launch.env, envMode: launch.envMode, input,
      ...(this.opts.backend.failureOnExit ? { captureStderr: true as const } : {}),
      current: () => generation === this.generation, stop: launch.stop,
      onInputReleased: () => { inputReleased = true; this.opts.inputReleased?.(inputContext, [env]); },
      onError: () => { if (this.child === child) this.child = undefined; },
      onSpawn: () => {
        nativeStartedAt = Date.now();
        try { selection?.applied(); } catch { /* Native spawn remains authoritative. */ }
        this.runningBinding={task,binding};
        this.reviewing = task; this.reviewSeq++;
        const reviewSequence = this.reviewSeq;
        const expire = () => {
          if (this.child === child && generation === this.generation && this.reviewing === task && this.reviewSeq === reviewSequence)
            this.abortReview("review time cap", "timeout");
        };
        if (this.opts.reviewTimer) deadline = { handle: this.opts.reviewTimer.set(expire, maxMinutes * 60_000) };
        else { const timer = setTimeout(expire, maxMinutes * 60_000); timer.unref?.(); deadline = { handle: timer }; }
        if (launch!.watchCurrent) {
          try {
            const sequence = this.reviewSeq, probe = launch!.startPolicyWatch!();
            const watch = createReviewerPolicyWatch(probe, () => {
              // Batch generation alone is insufficient: later reviews can reuse its task and generation.
              if (this.policyWatch === policyOwner && this.child === child && generation === this.generation
                && this.reviewing === task && this.reviewSeq === sequence) this.abortReview("review policy changed");
            });
            policyOwner = { child, watch, cleanup: release, closed: () => {
              childClosed = true; launchCleanupConfirmed = true; finishInput();
            } };
            this.policyWatch = policyOwner;
            watch.start();
          } catch { this.abortReview("review policy changed"); }
        }
      },
      onFrame: event => {
        try {
          const observed = this.opts.backend.toolTrace?.(event);
          if (observed && generation === this.generation) this.observeTool(trace, observed);
        } catch { /* Optional trace metadata never changes review execution. */ }
        const usage = this.opts.backend.usage?.(event);
        if (usage) this.opts.onUsage?.(usage, task);
        try { const model = this.opts.backend.model?.(event); if (model) this.servedModel = model; } catch { /* optional metadata never changes review execution */ }
        try {
          const failure = this.opts.backend.failure?.(event);
          if (failure === "quota") { quota = true; rememberQuota(); } // Legacy synthetic backends carry no reset evidence.
          else {
            const reading = nativeReviewerQuota(failure);
            if (reading) { quota = true; quotaReadings.set(reading.id, reading); observeQuota(reading); rememberQuota(); }
          }
        } catch { /* Malformed optional metadata cannot manufacture a quota pause. */ }
      },
      onActivity: () => this.touch(),
      onLimit: () => this.abortReview("review output limit exceeded"),
      onLeaderExit: () => {
        clearDeadline();
        if (this.child === child) { this.reviewing = undefined; this.runningBinding=undefined; }
        void this.stopPolicyWatch(policyOwner).catch(() => {});
      },
    });
    // Owned before any await, so a stop that lands before "spawn" still finds and kills it.
    this.child = ownedChild = child;
    this.childCleanup = release;
    this.childCurrent = launch.watchCurrent ? launch.current : undefined;
    const code = await child.done;
    if (generation === this.generation && this.child === child && this.opts.backend.failureOnExit) {
      try {
        const reading = nativeReviewerQuota(this.opts.backend.failureOnExit({ exitCode: code, stderr: child.stderrAfterSettlement() }));
        if (reading) { quota = true; quotaReadings.set(reading.id, reading); observeQuota(reading); rememberQuota(); }
      } catch { /* Unknown or incomplete exit diagnostics remain ordinary failure. */ }
    }
    childClosed = true;
    if (this.child === child) this.child = undefined;
    return { code, quota, trace, ...(quotaReadings.size ? { quotaReadings: [...quotaReadings.values()] } : {}) };
    } finally {
      clearDeadline();
      if (this.activeTrace?.value === trace) this.activeTrace = undefined;
      closeMcp();
      // Joining the watcher precedes deletion of files it can still read, even when native cleanup failed.
      await this.stopPolicyWatch(policyOwner);
      try {
        if (!ownedChild || this.child !== ownedChild) {
          await release(); if (this.childCleanup === release) this.childCleanup = undefined;
          launchCleanupConfirmed = true;
          if (this.policyWatch === policyOwner) this.policyWatch = undefined;
        }
      } catch (error) { this.opts.log?.(`[${this.id}] reviewer isolation cleanup incomplete`); if (error instanceof ReviewerUsageCleanupError) throw error; }
      finishInput();
    }
  }

  private settle(state: "completed" | "failed_safe" | "needs_review", reason?: string, failureCause?: DeliveryFailureCause): void {
    const id = this.activeDeliveryId;
    this.activeDeliveryId = undefined;
    if (id) this.delivery({ id, state, ...(reason ? { reason } : {}), ...(failureCause ? { failureCause } : {}) });
  }

  /** Revokes the verdict authority at once, then stops the child; on failure the handle is kept and the error thrown. */
  private async stopPolicyWatch(owner: ReviewPolicyOwner | undefined, retry = false): Promise<void> {
    if (!owner) return;
    try { await owner.watch.stop(retry); }
    catch { throw new ReviewerPolicyCleanupError(); }
    // Retain the owner until native teardown and private cleanup also succeed, so a failed stop can be retried.
  }

  private async kill(retryWorker = false): Promise<void> {
    this.reviewing = undefined;
    this.runningBinding=undefined;
    const owner = this.policyWatch, child = this.child ?? owner?.child;
    const cleanup = this.childCleanup ?? owner?.cleanup;
    const workerStopped = this.stopPolicyWatch(owner, retryWorker);
    void workerStopped.catch(() => {}); // Native OAuth grace may outlast a failed join; observe it immediately.
    let childError: unknown, workerError: unknown;
    try { await child?.stop(); } catch (error) { childError = error; }
    try { await workerStopped; } catch (error) { workerError = error; }
    if (workerError) throw workerError;
    if (childError) throw childError;
    if (!child && cleanup) {
      await cleanup();
      if (this.childCleanup === cleanup) this.childCleanup = undefined;
    }
    if (child) {
      await cleanup?.();
      owner?.closed();
      if (this.child === child) this.child = undefined;
      if (this.childCleanup === cleanup) this.childCleanup = undefined;
      if (this.policyWatch === owner) this.policyWatch = undefined;
      if (!this.child && !this.policyWatch) this.childCurrent = undefined;
    }
  }
}

export function isReviewerPrintPeer(value: unknown): value is ReviewerPrintPeer {
  return value instanceof ReviewerPrintPeer;
}
