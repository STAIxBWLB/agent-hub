import type { ChildProcess } from "node:child_process";
import { OwnedPrintChild, PrintChildCleanupError } from "./claude-print-child.ts";
import { randomUUID } from "node:crypto";
import { HUB, frame, sanitize } from "../hub/envelope.ts";
import { BasePeer } from "../hub/peers.ts";
import type { Envelope } from "../hub/envelope.ts";
import type { ReviewerMcpSession, ReviewerToolName } from "./reviewer-mcp.ts";

/** #722: the closed list of legs a reviewer's per-review start can fail on. A class names a leg, never a path, content or token. */
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

export interface ReviewerPrintUsage { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
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
}
export interface ReviewerBackend {
  id: string;
  taskMcp?: true;
  nativePolicy?: true;
  prepare(context: ReviewerPrepareContext): Promise<ReviewerLaunch | { unavailable: string; causeClass?: ReviewerCauseClass; detail?: string }>;
  usage?(event: unknown): ReviewerPrintUsage | undefined;
  failure?(event: unknown): "quota" | undefined;
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
}

export interface ReviewerReviewBinding { readonly head?: string; readonly flowRevision?: number }
export interface ReviewerPrintOptions {
  cwd: string;
  command?: readonly string[];
  mcpConfig: string;
  systemPrompt: string;
  privatePaths?: readonly string[];
  watchdogMs: number;
  backend: ReviewerBackend;
  facts?(env: Envelope): string | undefined;
  verdictSince(task: number, since: number): boolean;
  onUsage?(usage: ReviewerPrintUsage, task: number): void;
  /** True confirms that the host re-offered the current review; void/false retains uncertainty. */
  onUnavailable?(failure: ReviewerFailure, current: () => boolean): boolean | void | Promise<boolean | void>;
  onNoVerdict?(diagnostic: ReviewerNoVerdict, current: () => boolean): void;
  log?(line: string): void;
  taskMcp?(task: number, current: () => boolean): ReviewerMcpSession;
  /** Synchronous host task/privacy/policy fence, checked again after awaited preparation. */
  admit?(env: Envelope): boolean;
  bindingCurrent?(task: number, binding: ReviewerReviewBinding): boolean;
}

type ReviewTarget = Omit<ReviewerFailure, "cause">;
interface ReviewBatch { targets: (ReviewTarget | undefined)[]; next: number; failures: ReviewerFailure[] }
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
  readonly hubNative = true;
  private generation = 0;
  private child: OwnedPrintChild | undefined;
  private childCleanup: (() => Promise<void>) | undefined;
  private childCurrent: (() => boolean) | undefined;
  private reviewMcpClose: (() => void) | undefined;
  private activeDeliveryId: string | undefined;
  private batch: ReviewBatch | undefined;
  private preparation: { abort: AbortController; done: Promise<ReviewerLaunch> } | undefined;
  private receipt: ReviewerIsolationReceipt | undefined;
  get isolationReceipt(): ReviewerIsolationReceipt | undefined { return this.receipt; }
  /** The task whose review the running child was started for (R4: the hub records `fresh` for its verdict). */
  reviewing: number | undefined;
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
    if (this.child) this.setState("busy"); // unavailable, not offline, until the group is confirmed gone
    await this.kill(); // throws when the child could not be stopped; its handle is kept and the peer stays busy
    this.setState("offline");
  }

  protected override onWatchdog(): void { this.abortReview("review watchdog timeout"); }

  private abortReview(reason: "review watchdog timeout" | "review output limit exceeded" | "review policy changed"): void {
    const generation = ++this.generation, batch = this.batch, preparation = this.preparation;
    this.reviewing = undefined;
    this.reviewMcpClose?.();
    this.receipt = undefined;
    this.clearWatchdog();
    preparation?.abort.abort();
    this.settle("needs_review", reason);
    // Revoke first, then confirm both preparation and the model's whole group are gone before fallback.
    void (async () => {
      if (preparation) await preparation.done.catch(() => {});
      if (generation !== this.generation) return;
      await this.kill();
      if (generation !== this.generation) return; // a person's stop owns the hold; never reroute it
      if (batch) await this.reportFailures([...batch.failures, ...remainingFailures(batch, batch.next, "no_verdict")], generation);
      if (generation === this.generation && this.state === "busy") { this.batch = undefined; super.onWatchdog(); }
    })().catch((error: Error) => this.opts.log?.(`[${this.id}] review cleanup failed, staying busy`));
  }

  async deliver(envs: Envelope[], deliveryId?: string): Promise<void> {
    if (this.state !== "idle") {
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
      let result: { code: number | null; quota: boolean; trace: ReviewerTraceState };
      try { result = await this.review(env, task, generation); }
      catch (error) {
        if (generation !== this.generation) return;
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
          // Unavailable until a stop confirms the group gone: no new review runs beside the survivors.
          this.opts.log?.(`[${this.id}] review of task #${task}: ${error.message}`);
          this.settle("needs_review", `review process group still running: ${error.message}`);
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
        if (target) reroute.push({ ...target, cause: result.quota ? "quota" : "no_verdict" });
        if (result.quota) {
          reroute.push(...remainingFailures(batch, index + 1, "quota"));
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

  private prepare(sessionId: string, input?: string, task?: number, mcpConfig?: string): Promise<ReviewerLaunch> {
    const abort = new AbortController();
    const done = (async () => {
      if (this.opts.backend.taskMcp && !this.opts.taskMcp) throw new Error("task-bound reviewer MCP is unavailable");
      const launch = await this.opts.backend.prepare({ peer: this.id, cwd: this.opts.cwd, sessionId,
        mcpConfig: this.opts.backend.taskMcp ? (mcpConfig ?? '{"mcpServers":{}}') : this.opts.mcpConfig,
        systemPrompt: this.opts.systemPrompt, privatePaths: this.opts.privatePaths ?? [], command: this.opts.command, signal: abort.signal,
        ...(input === undefined ? {} : { input }), ...(task === undefined ? {} : { task }) });
      if ("unavailable" in launch) throw new ReviewerUnavailableError(launch.unavailable, launch.causeClass ?? "unknown", launch.detail);
      const proof = launch.isolation;
      const policy = this.opts.backend.nativePolicy
        ? proof?.enforcement === "native-policy" && proof.freshSession === true && proof.hubToolsOnly === true
        : proof?.strictMcp === true && proof.ephemeral === true;
      if (abort.signal.aborted || !proof || proof.backend !== this.opts.backend.id || proof.readOnly !== true || !policy || !proof.binary || !proof.version || !proof.profile || !proof.evidence.length || !launch.command.length) {
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

  private async review(env: Envelope, task: number, generation: number): Promise<{ code: number | null; quota: boolean; trace: ReviewerTraceState }> {
    const revision=Number(env.refs?.reviewRevision);
    const binding: ReviewerReviewBinding=Object.freeze({head:env.refs?.commit,flowRevision:Number.isSafeInteger(revision)&&revision>0?revision:undefined});
    this.assertAdmission(env, task, binding);
    let facts: string | undefined;
    try { facts = this.opts.facts?.(env); } catch (error) { this.opts.log?.(`[${this.id}] review facts for task #${task} failed: ${(error as Error).message}`); }
    const input = `${frame(env)}${facts ? `\n\n${facts}` : ""}`;
    let launch: ReviewerLaunch | undefined;
    const trace: ReviewerTraceState = { reviewCalled: false };
    this.activeTrace = { task, generation, value: trace };
    const mcp = this.opts.backend.taskMcp ? this.opts.taskMcp?.(task, () => generation === this.generation && this.reviewToken(task) !== undefined && this.opts.bindingCurrent?.(task,binding) !== false) : undefined;
    let mcpClosed=false;
    const closeMcp=()=>{ if(mcpClosed)return; mcpClosed=true; mcp?.close(); if(this.reviewMcpClose===closeMcp)this.reviewMcpClose=undefined; };
    this.reviewMcpClose=closeMcp;
    let ownedChild: OwnedPrintChild | undefined, releasing: Promise<void> | undefined;
    let policyTimer: ReturnType<typeof setInterval> | undefined;
    const release = () => releasing ??= Promise.resolve().then(() => launch?.cleanup?.()).then(() => {});
    try {
    launch = await this.prepare(randomUUID(), input, task, mcp?.config);
    if (generation !== this.generation) throw new ReviewerAdmissionError("stale_binding");
    this.assertAdmission(env, task, binding);
    if (launch.current?.() === false) throw new ReviewerUnavailableError("reviewer isolation changed before child spawn", "binary");
    this.receipt = launch.isolation;
    let quota = false;
    const child = new OwnedPrintChild({ peer: this.id, command: launch.command, args: launch.args,
      cwd: launch.cwd ?? this.opts.cwd, env: launch.env, envMode: launch.envMode, input,
      current: () => generation === this.generation, stop: launch.stop,
      onError: () => { if (this.child === child) this.child = undefined; },
      onSpawn: () => {
        this.runningBinding={task,binding};
        this.reviewing = task; this.reviewSeq++;
        if (this.childCurrent) policyTimer = setInterval(() => { this.reviewToken(task); }, 100);
      },
      onFrame: event => {
        try {
          const observed = this.opts.backend.toolTrace?.(event);
          if (observed && generation === this.generation) this.observeTool(trace, observed);
        } catch { /* Optional trace metadata never changes review execution. */ }
        const usage = this.opts.backend.usage?.(event);
        if (usage) this.opts.onUsage?.(usage, task);
        if (this.opts.backend.failure?.(event) === "quota") quota = true;
      },
      onActivity: () => this.touch(),
      onLimit: () => this.abortReview("review output limit exceeded"),
      onLeaderExit: () => {
        if (this.child === child) { this.reviewing = undefined; this.runningBinding=undefined; }
      },
    });
    // Owned before any await, so a stop that lands before "spawn" still finds and kills it.
    this.child = ownedChild = child;
    this.childCleanup = release;
    this.childCurrent = launch.watchCurrent ? launch.current : undefined;
    const code = await child.done;
    if (this.child === child) this.child = undefined;
    return { code, quota, trace };
    } finally {
      if (this.activeTrace?.value === trace) this.activeTrace = undefined;
      closeMcp();
      if (policyTimer) clearInterval(policyTimer);
      try { if (!ownedChild || this.child !== ownedChild) { await release(); if (this.childCleanup === release) this.childCleanup = undefined; } }
      catch { this.opts.log?.(`[${this.id}] reviewer isolation cleanup incomplete`); }
    }
  }

  private settle(state: "completed" | "failed_safe" | "needs_review", reason?: string): void {
    const id = this.activeDeliveryId;
    this.activeDeliveryId = undefined;
    if (id) this.delivery({ id, state, ...(reason ? { reason } : {}) });
  }

  /** Revokes the verdict authority at once, then stops the child; on failure the handle is kept and the error thrown. */
  private async kill(): Promise<void> {
    this.reviewing = undefined;
    this.runningBinding=undefined;
    const child = this.child;
    if (!child) return;
    await child.stop();
    if (this.child === child) { await this.childCleanup?.(); this.child = undefined; this.childCleanup = undefined; this.childCurrent = undefined; }
  }
}

export function isReviewerPrintPeer(value: unknown): value is ReviewerPrintPeer {
  return value instanceof ReviewerPrintPeer;
}
