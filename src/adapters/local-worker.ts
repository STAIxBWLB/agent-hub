import type { ModelOverrideSelection } from "./registry-types.ts";
import { isNativeModelToken } from "./model-token.ts";
import { isReviewObserverExcluded, reviewCaptureExcluded } from "../hub/memory-policy.ts";
import { DecisionPolicyChangedError, type DecisionHost } from "../models/route/decision.ts";
import { HubRouteRuntime, type RouteEvent, type AdvisorEvent } from "../models/route/runtime.ts";
import type { HubRoute } from "../models/route/config.ts";
import type { RouteLabelEvent, RouteTurnOutcome } from "../models/route/labels.ts";
import type { StaySwitchPolicy } from "../models/route/stage-fallback.ts";
import type { NativeToolObservation as ToolObservation } from "../hub/progress.ts";
import { createHash, randomUUID } from "node:crypto";
import { MAX_HOP, remoteEnvelope, renderDigest, replyAudience, replyParent, STANDING_INSTRUCTION, USER, type Envelope, type EnvelopeOpts, type PeerId } from "../hub/envelope.ts";
import { CONDUCTOR_TOOL_NAMES, CONDUCTOR_TOOLS, TASK_TOOL_NAMES, TASK_TOOLS, profileTaskTools, SESSION_TITLE_TOOL } from "../hub/hub-tools.ts";
import { BasePeer, type SessionTitleResult } from "../hub/peers.ts";
import type { PublishResult } from "../hub/bus.ts";
import { profile, proxyEnv, type SandboxNetwork } from "../local/sandbox.ts";
import type { DocReadPort } from "../local/doc-read.ts";
import type { WebFetchPort } from "../local/web-fetch.ts";
import { DOC_READ_SCHEMA, WEB_FETCH_SCHEMA, runTool, toolResultFailed, TOOL_SCHEMAS, touchedPaths, ApprovalWaitStop, planProbeTool, requireProbeToolWrite,
  type ProbeToolResourcePlan, type ToolApproval, type ApprovalProvenance, type ToolContext } from "../local/tools.ts";
import type { Capture } from "../memory/capture.ts";
import type { ChatMessage, ChatResult, OmniRoute, ToolCall } from "../omniroute/client.ts";
import { safeModelLabel } from "../omniroute/usage.ts";
import { effectiveLocalRoute } from "../hub/routing.ts";
import type { ExecutionBudgetDecision } from "../hub/execution-budget.ts";
import type { OwnedInputContext, OwnedInputObserver } from "./claude-print-child.ts";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { GUIDANCE_PROBE_MODEL, GUIDANCE_PROBE_SESSION_BYTES, guidanceProbeCanonical, probeHash, probeInteger,
  type ProbeResourceCharges, type ProbeSlot, type ProbeStoredState } from "../hub/guidance-probes.ts";
import { ProbeLocalError, probeLocalEffect, probeObservedTokens, type ProbeLocalModelConfig, type ProbeLocalRequest,
  type ProbeLocalResult, type ProbeLocalSession, type ProbePreparedLocalInput } from "../local/probe-types.ts";
import { requireProbeConfinement, type ProbeConfinement } from "../local/probe-sandbox.ts";
import { reserveProbeWorkspaceBytes } from "../local/probe-workspace.ts";

export interface LocalOptions {
  /** Host-only choice sampled once at the next turn/review boundary. */
  getModelOverride?: () => ModelOverrideSelection;
  profile?: import("../hub/profiles.ts").ProfileSelection;
  sdlcStages?: readonly string[];
  sdlcCriteria?: boolean;
  /** Host-owned conditional instruction, sampled once per delivered turn. */
  titlePreface?: () => string | undefined;
  cwd: string;
  omni: OmniRoute;
  /** In-process hub route id; legacy routes use the fixed model. */
  route?: string;
  /** Model alias sent straight to OmniRoute when no hub route is active or its call fails. */
  fixedModel: string;
  hubRoutes?: () => Record<string, HubRoute>;
  /** Current host public-view screen for bounded decision evidence; absent means no text is released. */
  routeEvidencePublic?: (text: string) => boolean;
  routeDecisionContext?: DecisionHost["decisionContext"];
  /** routing.toml `stay_switch` for hub stage routes (#197). */
  staySwitch?: () => StaySwitchPolicy | undefined;
  onRoute?: (event: RouteEvent) => void;
  onAdvisor?: (event: AdvisorEvent) => void;
  onRouteOutcome?: (event: RouteLabelEvent) => void;
  /**
   * #1054: the worker ended its turn at a ceiling it enforces itself, as a closed fact and never its text: `steps` (it ran out of `maxSteps`, or the review asked for more at the last
   * step) or `budget` (an execution budget stopped it). The daemon records it as the run's `limit` evidence; a turn that reports none is `done`.
   */
  onLimit?: (kind: "steps" | "budget") => void;
  /** The daemon turn id created synchronously on busy, shared with turn_start/end. */
  turnId?: () => string | undefined;
  onApprovalStop?: (reason: string) => void;
  onTool?: (observation: ToolObservation, task?: string) => void;
  tools: { docRead?: DocReadPort; webFetch?: WebFetchPort; deny: string[]; permit: ToolContext["permit"]; shellExecutionCheck?: ToolContext["shellExecutionCheck"]; bashNetwork?: SandboxNetwork; readAllow?: string[]; readOnly?: string[] };
  capture?: Capture;
  /** Runs a hub task tool (hub_task_*, hub_review, hub_remember) as this peer. Absent = the tools are not offered. */
  taskTool?: (name: string, args: Record<string, unknown>, turn: { pii: boolean; signal?: AbortSignal }) => Promise<string>;
  /** Final per-turn input binding after the Bus pre-handoff hold; never a native-session authority port. */
  beforeInput?: OwnedInputObserver;
  /** Actual local model handoff metadata; never a budget, native-session or task-authority port. */
  inputReleased?: OwnedInputObserver;
  /** Successful provider responses only; usage may be absent when the gateway omits it. Never includes prompt data. */
  onUsage?: (record: { id: string; at: string; usage?: ChatResult["usage"]; requestedModel: string; servedModel?: string; provider?: string; task?: number }) => void;
  /** Atomic task/run admission immediately before every model request or tool execution. */
  admitBudget?: (envs: Envelope[], unit: "model_calls" | "tool_calls") => Promise<ExecutionBudgetDecision[]>;
  /** Per-turn policy from the task the delivery carries: the class's route, and whether it is a PII task. */
  turnPolicy?: (envs: Envelope[]) => { route?: string; fixedModel?: string; pii: boolean; task?: string } | undefined;
  /** Role contract, appended to the system prompt. */
  preamble?: string;
  watchdogMs?: number;
  maxSteps?: number;
  log?: (line: string) => void;
}

const HISTORY_CHARS = 100_000;
/** One turn may hold this much before its oldest tool outputs are replaced by a stub. */
const TURN_CHARS = 120_000;
/** Tools whose effects outlive a failed turn: once one ran, the turn is never redelivered. */
const SIDE_EFFECTS = new Set(["write", "edit", "bash", "git", "hub_send"]);
class ExecutionBudgetStop extends Error { readonly budgetStop = true; }
const chars = (msgs: ChatMessage[]) => msgs.reduce((n, m) => n + (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? "").length, 0);

const asFunction = (t: { name: string; description: string; inputSchema: unknown }) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } });

const system = (cwd: string, preamble = "") =>
  [
    `You are "local", a coding agent run by agent-hub on a self-hosted model, working in ${cwd}.`,
    "You take bulk and low-stakes work (mechanical edits, summaries, test runs) from the other agents and the hub console user.",
    STANDING_INSTRUCTION,
    "Tools: read, write, edit, bash, git, hub_send. They only work inside the project directory; secrets are unreadable; write, edit, bash and mutating git wait for the user's approval, so batch your changes and do not retry a refused call.",
    "When the work is done, answer with a short conclusion: what changed, what you verified, what is left. No tool output, no code dumps.",
    "If a message needs no work from you, answer in one line.",
    preamble,
  ].filter(Boolean).join("\n");

const probeSchemas = () => TOOL_SCHEMAS.filter(tool => ["read", "write", "edit"].includes(tool.function.name));
const probePolicy = () => `${system("/workspace")}\nThis is a private guidance probe. Only read, write and edit are available. Do not send messages, change sessions or invoke hub, package, shell or network operations.`;
const probeRoleInstruction = (role: Exclude<ProbeSlot["role"], "worker">): string => ({
  proposal: "Propose one guidance revision using only this task and its admitted evidence. Return the proposed text for private host inspection.",
  compose: "Compose one guidance revision from the admitted proposals and evidence. Return the proposed text for private host inspection.",
  select: "Compare only the anonymous deliverables and admitted task sources. Return a reasoned private selection using their anonymous names.",
  reflect: "Review only the admitted evidence from the closed round. Return bounded observations and unresolved questions for private host inspection.",
})[role];

function probeRuntimeHash(): string {
  const sources = [import.meta.url, new URL("../local/probe-types.ts", import.meta.url), new URL("../local/probe-session.ts", import.meta.url),
    new URL("../local/probe-workspace.ts", import.meta.url), new URL("../local/probe-sandbox.ts", import.meta.url),
    new URL("../local/tools.ts", import.meta.url), new URL("../local/sandbox.ts", import.meta.url), new URL("../omniroute/client.ts", import.meta.url)].map(value => {
    const file = openSync(new URL(value), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(file);
      if (!before.isFile() || before.size > GUIDANCE_PROBE_SESSION_BYTES) throw new ProbeLocalError("invalid");
      const buffer = Buffer.alloc(GUIDANCE_PROBE_SESSION_BYTES + 1), bytes = readSync(file, buffer, 0, buffer.length, 0), after = fstatSync(file);
      if (bytes !== before.size || before.size !== after.size || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
        throw new ProbeLocalError("drift");
      return createHash("sha256").update(buffer.subarray(0, bytes)).digest("hex");
    } finally { closeSync(file); }
  });
  return probeHash(guidanceProbeCanonical({ engine: process.versions.bun ?? null, platform: process.platform, arch: process.arch, sources }));
}

/** Host preregistration helper; fingerprints actual trusted policy, code, tool schemas and frozen generation configuration. */
export function localProbeFingerprints(config: Readonly<ProbeLocalModelConfig>): {
  systemPolicy: string; runtimeSha256: string; toolsetSha256: string; modelConfigSha256: string;
} {
  if (!probeInteger(config.maxSteps) || !config.maxSteps || !probeInteger(config.maxOutputTokens) || !config.maxOutputTokens
    || config.tokenUpperBound !== undefined && (!probeInteger(config.tokenUpperBound) || !config.tokenUpperBound)) throw new ProbeLocalError("invalid");
  const modelConfig = { maxSteps: config.maxSteps, maxOutputTokens: config.maxOutputTokens,
    ...(config.tokenUpperBound === undefined ? {} : { tokenUpperBound: config.tokenUpperBound }) };
  return { systemPolicy: probePolicy(), runtimeSha256: probeRuntimeHash(), toolsetSha256: probeHash(guidanceProbeCanonical(probeSchemas())),
    modelConfigSha256: probeHash(guidanceProbeCanonical(modelConfig)) };
}

/** Exact initial wire request, before any worker or materialization effect. Guidance is one explicit host slot. */
export function prepareLocalProbeInput(state: ProbeStoredState, slot: ProbeSlot, guidance: string,
  files: ProbePreparedLocalInput["files"], config: Readonly<ProbeLocalModelConfig>): ProbePreparedLocalInput {
  const actual = localProbeFingerprints(config), manifest = state.registration.manifest, snapshots = state.registration.snapshots;
  if (manifest.runtime.runtimeSha256 !== actual.runtimeSha256 || manifest.runtime.toolsetSha256 !== actual.toolsetSha256
    || manifest.runtime.modelConfigSha256 !== actual.modelConfigSha256 || snapshots.systemPolicy !== actual.systemPolicy
    || manifest.model.requested !== GUIDANCE_PROBE_MODEL || manifest.model.expectedServed !== GUIDANCE_PROBE_MODEL
    || manifest.limits.tokens !== undefined && config.tokenUpperBound === undefined) throw new ProbeLocalError("drift");
  const rolePolicy = snapshots.dataPolicy.roles[slot.role];
  if (!rolePolicy || files.length !== rolePolicy.dataIds.length || files.some(file => !rolePolicy.dataIds.includes(file.dataId))) throw new ProbeLocalError("invalid");
  const visibleFiles = files.map(({ relative, sha256, bytes }) => ({ relative, sha256, bytes }));
  const context = slot.role === "reflect" ? { role: slot.role, files: visibleFiles }
    : slot.role === "select" ? { role: slot.role, task: snapshots.task, files: visibleFiles }
      : { role: slot.role, task: snapshots.task, baselineContext: snapshots.baselineContext, files: visibleFiles,
        ...((slot.role === "proposal" || slot.role === "compose") && snapshots.dataPolicy.roles[slot.role].improverContext
          ? { improverContext: snapshots.improverContext ?? (() => { throw new ProbeLocalError("invalid"); })() } : {}) };
  const requestFor = (slotGuidance: string): ProbeLocalRequest => ({ model: GUIDANCE_PROBE_MODEL,
    messages: [{ role: "system", content: actual.systemPolicy }, { role: "system", content: slot.role === "worker" ? slotGuidance : probeRoleInstruction(slot.role) }, { role: "user", content: JSON.stringify(context) }],
    tools: probeSchemas(), max_tokens: config.maxOutputTokens, stream: false });
  const request = requestFor(guidance), inputFrame = JSON.stringify(request);
  return { inputFrame, inputSha256: probeHash(inputFrame), nonGuidanceInputSha256: probeHash(JSON.stringify(requestFor(""))),
    request: JSON.parse(inputFrame) as ProbeLocalRequest, role: slot.role, files };
}

/** Hub-native agent loop: the hub owns every model call, so it can choose the model per call (L2) and the gateway (L3). */
export class LocalPeer extends BasePeer {
  readonly hubNative = true;
  readonly deliveryOnly: boolean = true;
  readonly hubOwned: boolean = true;
  private readonly history: ChatMessage[] = [];
  private title = "";
  get sessionTitle(): string { return this.title; }
  get titleSession(): string { return this.sessionId; }
  /** Privacy-only identity for review-observer provenance; intentionally not PeerAdapter.nativeSession. */
  get observerSessionId(): string { return this.sessionId; }
  async setSessionTitle(title: string, onlyIfUnnamed: boolean, current?: () => boolean): Promise<SessionTitleResult> {
    if (typeof title !== "string" || !title.trim() || [...title].length > 80 || typeof onlyIfUnnamed !== "boolean") return { ok: false, reason: "invalid", error: "Session title must contain 1-80 normalized characters and use a conditional-write flag; correct the title request and try again." };
    if (this.state === "offline") return { ok: false, reason: "invalid", error: "Local worker session is offline; start the peer and check ahub status before naming it." };
    let admitted = false;
    try { admitted = current?.() !== false; } catch { /* host admission failure is a refusal */ }
    if (!admitted) return { ok: false, reason: "invalid", error: "Session title admission changed before the write; check ahub status and retry only in the current public session." };
    if (onlyIfUnnamed && this.title) return { ok: false, reason: "already_named", error: "This session already has a title; keep it or ask the person to rename it with ahub title." };
    this.title = title;
    try { this.onDoing?.("title", title); } catch { /* observation failure cannot undo the saved local title */ }
    return { ok: true };
  }
  private readonly sessionId = `agent-hub-local-${randomUUID()}`;
  private readonly routes: HubRouteRuntime;
  private readonly warnedLegacyRoutes = new Set<string>();
  private routeEnvs: Envelope[] = [];
  private routePii = false;
  private routeReviewScope: { excluded: boolean } | undefined;
  private routeTask?: number;
  private labelTurnId?: string;
  private turn = 0; // generation guard, as in acp.ts: a turn aborted by the watchdog must not touch the next one
  private abort: AbortController | undefined;
  private budgetTimer?: ReturnType<typeof setTimeout>;
  private budgetStopReason = "";
  private approvalExpiries = 0;
  private approvalAnswerEpoch: number | undefined;
  private approvalStopReason = "";
  private activeDeliveryId: string | undefined;
  private currentObserverInputContext: OwnedInputContext | undefined;
  private observerInputReleasedId: string | undefined;
  private readonly sandboxProfile: string; // built once: profile() spawns git and must stay off the per-call path
  private probeSession: ProbeLocalSession | undefined;
  private probePromise: Promise<ProbeLocalResult> | undefined;
  private probeStarted = false;
  private probeStopping = false;
  private probeCalls = 0;
  private probeServedModel: string | null = null;
  private probeServedExact = false;
  private probeUsageKnown = true;
  private probeToolPlan: ProbeToolResourcePlan | undefined;
  private readonly probePermits = new Set<Promise<unknown>>();
  /** What served the last call, for `ahub status`. */
  lastServedBy = "";

  constructor(
    id: PeerId,
    private readonly opts: LocalOptions,
    private readonly probeConfinement?: ProbeConfinement,
    private readonly probeFixture?: "fixture_only",
  ) {
    super(id, opts.watchdogMs);
    this.routes = new HubRouteRuntime({
      execute: async (model, messages, judge, signal, maxTokens) => {
        if (signal.aborted) throw new Error("turn cancelled before model request");
        const envs = this.routeEnvs, pii = this.routePii, generation = this.turn, task = this.routeTask;
        await this.requireBudget(envs, "model_calls");
        if (generation !== this.turn) throw new Error("route belongs to an ended turn");
        if (signal.aborted) throw new Error("turn cancelled before model request");
        const tools = judge ? undefined : [...this.toolSchemas(), ...(this.opts.taskTool ? [...profileTaskTools(this.opts.profile, this.opts.sdlcStages, this.opts.sdlcCriteria).filter(tool => tool.name !== "hub_delivery_retry"), ...CONDUCTOR_TOOLS].concat(SESSION_TITLE_TOOL).map(asFunction) : [])];
        this.releaseObserverInput(this.currentObserverInputContext, envs);
        const result = await this.opts.omni.chat({ model, messages, ...(tools ? { tools } : {}), ...(judge ? { max_tokens: maxTokens ?? 2048 } : {}) }, { signal, ...(pii ? { onCampusOnly: true } : {}) });
        this.recordUsage(result, model, task);
        if (generation !== this.turn) throw new Error("route belongs to an ended turn");
        this.lastServedBy = `hub ${model} (provider ${result.provider ?? "?"})`;
        return result;
      },
      onCampus: () => this.opts.omni.onCampus(),
      decisionContext: () => this.decisionContext(),
      publicDecisionText: text => this.opts.routeEvidencePublic?.(text) === true,
      admitDecision: () => this.requireBudget(this.routeEnvs, "model_calls"),
      onDecisionIssue: reason => this.opts.log?.(`decision route observation ${reason}; using the original heuristic; check adec serve and routing.toml policy settings, then retry`),
      staySwitch: () => this.opts.staySwitch?.(),
      onRoute: event => this.opts.onRoute?.(event),
      onAdvisor: event => this.opts.onAdvisor?.(event),
      onRouteOutcome: event => this.opts.onRouteOutcome?.(event),
    });
    this.sandboxProfile = probeConfinement?.profile ?? profile(opts.cwd, opts.tools.bashNetwork ?? false, opts.tools.readAllow, opts.tools.deny, opts.tools.readOnly);
  }

  private decisionContext(): { pii: boolean; private: boolean; excluded: boolean } {
    const current = this.opts.routeDecisionContext?.();
    if (this.opts.routeDecisionContext && (!current || typeof current.private !== "boolean" || typeof current.excluded !== "boolean" || current.pii !== undefined && typeof current.pii !== "boolean")) throw new DecisionPolicyChangedError();
    return { pii: this.routePii || current?.pii === true, private: this.routeEnvs.some(env => env.private === true) || current?.private === true,
      excluded: this.routeEnvs.some(env => remoteEnvelope(env) || isReviewObserverExcluded(env)) || this.routeReviewScope?.excluded === true || current?.excluded === true };
  }

  recoveryMetadata(): Record<string, unknown> {
    return { launch: { kind: "local", cwd: this.opts.cwd, model: this.opts.fixedModel, ...(this.opts.route ? { route: this.opts.route } : {}) }, sessionId: this.sessionId };
  }

  async start(): Promise<void> {
    if (this.probeConfinement) throw new ProbeLocalError("invalid");
    this.opts.capture?.init(this.sessionId, "agent-hub local worker session");
    this.setState("idle");
  }

  async stop(reason?: string): Promise<void> {
    if (this.probeConfinement) return this.stopProbe();
    this.endRouteTurn(this.labelTurnId, "failed");
    if (this.activeDeliveryId) this.delivery({ id: this.activeDeliveryId, state: "needs_review", reason: reason ?? "turn stopped before settlement" });
    this.activeDeliveryId = undefined;
    this.turn++;
    clearTimeout(this.budgetTimer); this.budgetTimer = undefined;
    this.abort?.abort();
    this.setState("offline"); // fence direct delivery before the bounded memory request awaits
    await this.opts.capture?.end();
  }

  /** A host-owned private instance shares this loop, never ordinary delivery or observer settlement. */
  async runProbe(session: ProbeLocalSession, signal: AbortSignal): Promise<ProbeLocalResult> {
    if (!this.probeConfinement || this.probeStarted || this.probePromise || this.state !== "offline" || this.history.length || this.title || this.activeDeliveryId || signal.aborted
      || session.purpose !== "guidance_probe" || session.confinement !== this.probeConfinement || session.workspace !== this.probeConfinement.workspace
      || session.workspace.root !== this.opts.cwd || this.opts.fixedModel !== GUIDANCE_PROBE_MODEL || this.opts.maxSteps !== session.config.maxSteps
      || session.prepared.inputSha256 !== probeHash(session.prepared.inputFrame) || JSON.stringify(session.prepared.request) !== session.prepared.inputFrame)
      return Promise.reject(new ProbeLocalError("invalid"));
    if (!this.probeFixture) requireProbeConfinement(this.probeConfinement, session.workspace);
    session.accounting.current();
    this.probeStarted = true; this.probeSession = session;
    const turn = ++this.turn, controller = new AbortController(); this.abort = controller;
    const cancel = () => controller.abort(); signal.addEventListener("abort", cancel, { once: true });
    const msgs: ChatMessage[] = JSON.parse(JSON.stringify(session.prepared.request.messages.slice(1))) as ChatMessage[];
    const progress = { sideEffects: 0, last: "", answerComplete: false };
    this.probePromise = Promise.resolve().then(async () => {
      session.accounting.current();
      const answer = await this.run([], turn, msgs, progress, { pii: false }, {}, { excluded: false });
      if (signal.aborted || controller.signal.aborted || this.probeStopping || turn !== this.turn) throw new ProbeLocalError("interrupted");
      await session.reserve({ outputBytes: Buffer.byteLength(answer, "utf8") }, "probe-final-output");
      return { answer, complete: progress.answerComplete, servedModel: this.probeServedModel,
        servedModelExact: this.probeServedExact, usageKnown: this.probeUsageKnown };
    }).catch(error => { throw error instanceof ProbeLocalError ? error : new ProbeLocalError("interrupted"); })
      .finally(async () => {
        signal.removeEventListener("abort", cancel); this.clearWatchdog();
        await Promise.allSettled([...this.probePermits]);
        this.probeSession = undefined;
      });
    return this.probePromise;
  }

  /** No timeout is success: the outer owner may bound this join and retain its handle on uncertainty. */
  async stopProbe(): Promise<void> {
    this.probeStopping = true; this.turn++; this.abort?.abort(); this.clearWatchdog();
    if (this.probePromise) await this.probePromise.catch(() => {});
    await this.probeConfinement?.stop();
  }

  /** Private adapter bookkeeping, not an ordinary usage/status observer. */
  probeObservation(): Pick<ProbeLocalResult, "servedModel" | "servedModelExact" | "usageKnown"> {
    return { servedModel: this.probeServedModel, servedModelExact: this.probeServedExact, usageKnown: this.probeUsageKnown };
  }

  /** Resolves once the turn is claimed; a turn that cannot reach any model hands the envelopes back through onFailed. */
  async deliver(envs: Envelope[], deliveryId?: string): Promise<void> {
    if (this.probeConfinement) throw new ProbeLocalError("invalid");
    if (this.state !== "idle") {
      if (deliveryId) this.delivery({ id: deliveryId, state: "failed_safe", reason: `${this.id} is ${this.state}` });
      throw new Error(`${this.id} is ${this.state}`);
    }
    const inputContext: OwnedInputContext = Object.freeze({ sessionId: this.observerSessionId, inputId: randomUUID() });
    try { this.opts.beforeInput?.(inputContext, envs); }
    catch {
      if (deliveryId) this.delivery({ id: deliveryId, state: "failed_safe", reason: "review input provenance unavailable" });
      throw new Error("review input provenance unavailable");
    }
    this.currentObserverInputContext = inputContext;
    this.observerInputReleasedId = undefined;
    const turn = ++this.turn;
    this.budgetStopReason = "";
    this.approvalExpiries = 0; this.approvalAnswerEpoch = undefined; this.approvalStopReason = "";
    clearTimeout(this.budgetTimer); this.budgetTimer = undefined;
    this.activeDeliveryId = deliveryId;
    this.abort = new AbortController();
    this.setState("busy");
    let selected: ModelOverrideSelection | undefined, modelFailure: Error | undefined;
    try {
      selected = this.opts.getModelOverride?.();
      if (selected?.model !== undefined && !isNativeModelToken(selected.model)) throw new Error("invalid model");
    } catch { modelFailure = new Error("runtime model selection unavailable; check the peer model setting and retry"); }
    let modelApplied = false;
    const captured = selected;
    const selection = captured && { model: captured.model, applied: () => {
      if (modelApplied || turn !== this.turn) return;
      modelApplied = true; try { captured.applied(); } catch { /* Status acknowledgement is not model authority. */ }
    } };
    if (deliveryId) this.delivery({ id: deliveryId, state: "accepted" });
    // The turn works on its own message list and joins the history only as a whole, so a failed or aborted turn can
    // never leave a tool call without its result (strict servers reject that history forever after).
    const msgs: ChatMessage[] = [{ role: "user", content: [envs.some(env => env.private || remoteEnvelope(env)) ? undefined : this.opts.titlePreface?.(), renderDigest(envs, true)].filter(Boolean).join("\n") }];
    const progress = { sideEffects: 0, last: "", answerComplete: false };
    const requestedPolicy = this.opts.turnPolicy?.(envs);
    const policy = envs.some(env => env.private) ? { ...requestedPolicy, pii: true } : requestedPolicy;
    const remoteTurn = envs.some(remoteEnvelope);
    const reviewScope = { excluded: envs.some(isReviewObserverExcluded) };
    const preserveHistory = !policy?.pii && !remoteTurn;
    const labelTurn = this.beginRouteTurn(turn, !!policy?.pii || envs.some(env => env.private), policy?.task);
    let completed = false;
    // A PII turn speaks to the console user only, and privately: its answer must not be broadcast to cloud-hosted peers.
    // The task id travels with it, so the board can keep the text (`ahub task show`) while tail and log show a stub.
    const reply: EnvelopeOpts = { inReplyTo: replyParent(envs), to: replyAudience(envs), ...(policy?.pii ? { to: [USER], private: true, priority: "important" as const, ...(policy.task ? { refs: { task: policy.task } } : {}) } : {}) };
    this.run(envs, turn, msgs, progress, policy, reply, reviewScope, selection, modelFailure)
      .then((answer) => {
        if (turn !== this.turn) return;
        if (preserveHistory && !reviewScope.excluded) this.commit(msgs); // Private, remote and review turns never enter later local capture through model history.
        if (answer) this.finalAnswer(answer, reply, progress.answerComplete);
        if (deliveryId && this.activeDeliveryId === deliveryId) this.delivery({ id: deliveryId, state: "completed" });
        completed = true;
      })
      .catch((e: Error) => {
        if (turn !== this.turn) return; // aborted by the watchdog or stop(): nothing to report, nothing was committed
        if (e instanceof ApprovalWaitStop) {
          const message = remoteTurn ? "remote turn failed" : reviewScope.excluded ? "review turn failed" : e.message;
          this.completeMissingToolResults(msgs, "not run: turn ended after unanswered approvals");
          msgs.push({ role: "assistant", content: message });
          if (preserveHistory && !reviewScope.excluded) this.commit(msgs);
          this.onMessage?.(message, reply);
          if (deliveryId && this.activeDeliveryId === deliveryId) this.delivery({ id: deliveryId, state: "completed", reason: message });
          return; // even without effects, an unanswered approval must not trigger safe replay
        }
        if (this.budgetStopReason && !(e instanceof ExecutionBudgetStop)) e = new ExecutionBudgetStop(this.budgetStopReason);
        const message = remoteTurn ? "remote turn failed" : reviewScope.excluded ? "review turn failed" : e.message;
        this.opts.log?.(`[${this.id}] turn failed: ${message}`);
        if (e instanceof ExecutionBudgetStop) {
          this.reportBudgetStop(e, msgs, progress, reply, !preserveHistory || reviewScope.excluded, deliveryId, remoteTurn, reviewScope.excluded);
          return;
        }
        if (!progress.sideEffects) {
          if (deliveryId && this.activeDeliveryId === deliveryId) this.delivery({ id: deliveryId, state: "failed_safe", reason: message });
          else this.onFailed?.(envs); // legacy delivery: safe to redeliver
          return;
        }
        // Tools already changed things. Redelivering would redo approved writes and commits, so report instead.
        // A model call is the only thing that throws here, and every tool call before it has its result: msgs is consistent.
        const note = remoteTurn || reviewScope.excluded ? message : `(turn failed after ${progress.sideEffects} tool call(s) with side effects: ${message.slice(0, 200)}. The work may be partial; check before repeating it.) ${progress.last}`.trim();
        msgs.push({ role: "assistant", content: note });
        if (preserveHistory && !reviewScope.excluded) this.commit(msgs);
        this.onMessage?.(note, reply);
        if (deliveryId && this.activeDeliveryId === deliveryId) this.delivery({ id: deliveryId, state: "needs_review", reason: message });
      })
      .finally(() => {
        this.endRouteTurn(labelTurn, completed ? "completed" : "failed");
        if (turn === this.turn) { clearTimeout(this.budgetTimer); this.budgetTimer = undefined; }
        if (turn === this.turn && this.state === "busy") this.setState("idle");
        if (turn === this.turn && this.activeDeliveryId === deliveryId) this.activeDeliveryId = undefined;
      });
  }

  protected override onWatchdog(): void {
    if (this.probeConfinement) { this.probeStopping = true; this.turn++; this.abort?.abort(); this.clearWatchdog(); return; }
    this.endRouteTurn(this.labelTurnId, "failed");
    if (this.activeDeliveryId) this.delivery({ id: this.activeDeliveryId, state: "needs_review", reason: "turn watchdog timeout", failureCause: "timeout" });
    this.activeDeliveryId = undefined;
    this.turn++;
    clearTimeout(this.budgetTimer); this.budgetTimer = undefined;
    this.abort?.abort();
    super.onWatchdog();
  }

  private async run(
    envs: Envelope[],
    turn: number,
    msgs: ChatMessage[],
    progress: { sideEffects: number; last: string; answerComplete: boolean },
    policy: { route?: string; fixedModel?: string; pii: boolean; task?: string } | undefined,
    reply: EnvelopeOpts,
    reviewScope: { excluded: boolean },
    selection?: ModelOverrideSelection,
    modelFailure?: Error,
  ): Promise<string> {
    if (modelFailure) throw modelFailure;
    const { maxSteps = 30 } = this.opts;
    const turnSignal = this.abort!.signal;
    // Remote text/tool output is never memory evidence, even beside ordinary local work in the same turn.
    const remoteTurn = envs.some(remoteEnvelope);
    const capture = policy?.pii || remoteTurn ? undefined : this.opts.capture;
    const activeCapture = this.probeConfinement ? undefined : capture;
    // Unknown gateway state is never permission to send PII.
    if (policy?.pii && !(await this.opts.omni.onCampus())) {
      return "Refused: this is a PII task and the only reachable gateway is off campus (Cloudflare Access). Connect the VPN and assign it again.";
    }
    this.routeEnvs = envs;
    this.routePii = !!policy?.pii;
    this.routeReviewScope = reviewScope;
    if (turn !== this.turn || turnSignal.aborted) return "";
    const fixedPrompt = this.probeConfinement
      ? this.probeSession?.prepared.request.messages[0]?.content ?? (() => { throw new ProbeLocalError("invalid"); })()
      : this.turnRecordPrompt(system(this.opts.cwd, this.opts.preamble));
    const ctx = this.toolContext(envs, turnSignal, !!policy?.pii, reply);
    let usedTools = false;
    let captureInvocation = 0;
    for (let step = 0; step < maxSteps; step++) {
      this.elide(msgs);
      const res = await this.call(msgs, policy, envs, selection, fixedPrompt);
      if (turn !== this.turn) return "";
      if (!this.probeConfinement) this.touch();
      msgs.push(res.message);
      progress.last = res.message.content?.trim() || progress.last;
      if (!res.message.tool_calls?.length) {
        const concluded = await this.conclude(msgs, policy, turn, step, maxSteps, progress.last, turnSignal, res.routeDecision, selection, fixedPrompt);
        if (turn !== this.turn) return "";
        if (concluded === undefined) continue;
        if (usedTools && !reviewScope.excluded) activeCapture?.summarize(concluded.answer);
        progress.answerComplete = concluded.complete;
        return concluded.answer;
      }
      if (!this.probeConfinement && res.message.tool_calls.some(call => call.function.name.replace(/^mcp__[^ ]+__/, "") === "hub_review" && reviewCaptureExcluded(call.function.name, call.function.arguments))) reviewScope.excluded = true;
      const results: ChatMessage[] = [];
      try {
        for (const call of res.message.tool_calls) {
          // A tool has its own timeout (bash up to 600 s) and an approval can take 120 s: neither is the model going silent.
          const alive = this.probeConfinement ? undefined : setInterval(() => this.state === "busy" && turn === this.turn && this.touch(), 30_000);
          const name = call.function.name;
          try {
            await this.requireBudget(envs, "tool_calls");
            if (turnSignal.aborted) throw new ExecutionBudgetStop(this.budgetStopReason || "turn cancelled before tool execution");
          } catch (error) { clearInterval(alive); throw error; }
          const taskToolName = name.replace(/^mcp__[^ ]+__/, "");
          const reviewNoteWrite = taskToolName === "hub_remember" || taskToolName === "hub_task_propose";
          const toolRun = () => this.probeConfinement && !["read", "write", "edit"].includes(name)
            ? Promise.resolve("error: tool unavailable in guidance probe")
            : reviewScope.excluded && reviewNoteWrite
            ? Promise.resolve("error: anchored review in this batch; save notes in a later turn")
            : (TASK_TOOL_NAMES.has(name) || CONDUCTOR_TOOL_NAMES.has(name)) && this.opts.taskTool
              ? this.opts.taskTool(name, safeParse(call.function.arguments), { pii: !!policy?.pii, signal: turnSignal }).catch((e: Error) => `error: ${e.message}`)
              : runTool(name, call.function.arguments, ctx);
          const probe = this.probeSession;
          const plan = probe ? planProbeTool(name, call.function.arguments, ctx) : undefined;
          if (probe && plan && !this.probeFixture) reserveProbeWorkspaceBytes(probe.workspace, plan.scratchBytes + plan.outputBytes);
          if (probe) this.probeToolPlan = plan;
          const charges: ProbeResourceCharges | undefined = plan ? { scratchBytes: plan.scratchBytes, outputBytes: plan.outputBytes } : undefined;
          const running = probe ? probeLocalEffect(probe.accounting, "tool_calls", JSON.stringify({ name, arguments: call.function.arguments }), charges, undefined,
            async () => ({ value: await toolRun(), usage: 1 })) : toolRun();
          const output = await running.finally(() => { clearInterval(alive); if (probe) this.probeToolPlan = undefined; });
          if (turn !== this.turn) return "";
          if (!this.probeConfinement) this.touch();
          usedTools = true;
          if (SIDE_EFFECTS.has(call.function.name) && !output.startsWith("error:")) progress.sideEffects++;
          const result: ChatMessage = { role: "tool", tool_call_id: call.id, content: output, is_error: toolResultFailed(name, output) };
          msgs.push(result); results.push(result);
          if (this.approvalStopReason) { this.abort?.abort(); throw new ApprovalWaitStop(this.approvalStopReason); }
          if (!remoteTurn && !reviewScope.excluded && name !== "hub_set_title" && name !== "hub_ask" && !reviewCaptureExcluded(name, call.function.arguments)) this.observeTool(call, output, policy, `${this.sessionId}.${turn}.${step}`);
          // Hub tool arguments/results are not capture evidence; Tasks owns its screened memory writes.
          // doc_read text is converted document content (a converter can surface hidden text), never memory evidence: not captured, whatever the turn.
          // web_fetch text is a third party's page and its URL is the model's own request: neither is memory evidence either (#515b).
          if (!reviewScope.excluded && name !== "hub_send" && name !== "doc_read" && name !== "web_fetch" && !TASK_TOOL_NAMES.has(name) && !CONDUCTOR_TOOL_NAMES.has(name)) activeCapture?.observe({ tool: call.function.name, args: call.function.arguments, output, id: call.id, sourceId: `${this.sessionId}.${turn}.${step}.${captureInvocation++}`, paths: touchedPaths(call.function.name, safeParse(call.function.arguments)) });
        }
      } finally { if (results.length && !this.probeConfinement) this.routes.observeResults(res.routeDecision, res.message, results); }
    }
    if (usedTools && !reviewScope.excluded) activeCapture?.summarize(progress.last);
    if (!this.probeConfinement) this.opts.onLimit?.("steps");
    return `(stopped after ${maxSteps} steps) ${progress.last}`.trim();
  }

  /** The base tools, plus `doc_read` and `web_fetch` only when the project opted in (`local.doc_read`, `local.web_fetch.allow`; both off by default). */
  private toolSchemas() { if (this.probeConfinement) return probeSchemas(); const extra = [...(this.opts.tools.docRead ? [DOC_READ_SCHEMA] : []), ...(this.opts.tools.webFetch ? [WEB_FETCH_SCHEMA] : [])]; return extra.length ? [...TOOL_SCHEMAS, ...extra] : TOOL_SCHEMAS; }

  private toolContext(envs: Envelope[], turnSignal: AbortSignal, pii: boolean, reply: EnvelopeOpts): ToolContext {
    const executionGeneration=this.turn;
    const probe = this.probeSession;
    const context: ToolContext = {
      ...(this.opts.tools.docRead ? { docRead: { ...this.opts.tools.docRead, pii } } : {}),
      ...(this.opts.tools.webFetch ? { webFetch: { ...this.opts.tools.webFetch, pii } } : {}),
      cwd: this.opts.cwd,
      deny: this.opts.tools.deny,
      readOnly: this.opts.tools.readOnly,
      ...(probe ? { probe: { root: probe.workspace.root, writableRoots: probe.workspace.allowedWrites,
        current: () => {
          if (turnSignal.aborted || this.probeStopping) throw new ProbeLocalError("interrupted");
          probe.accounting.current(); if (!this.probeFixture) requireProbeConfinement(probe.confinement, probe.workspace);
        },
        reserveWrite: async (bytes: number, canonicalPath: string) => {
          if (!this.probeToolPlan) throw new ProbeLocalError("invalid");
          requireProbeToolWrite(this.probeToolPlan, bytes, canonicalPath, context);
        } } } : {}),
      permit: async (title, tool, _signal, canonicalTarget, _observe, originalPath, input, policy) => {
        if (turnSignal.aborted) return "aborted";
        const generation = this.turn;
        let observed = false;
        const observe = (provenance: ApprovalProvenance) => {
          observed = true;
          if (generation !== this.turn || turnSignal.aborted || this.approvalStopReason) return;
          if (this.approvalAnswerEpoch !== provenance.answerEpoch) {
            this.approvalExpiries = 0; this.approvalAnswerEpoch = provenance.answerEpoch;
          }
          if (provenance.source === "person") this.approvalExpiries = 0;
          if (provenance.source === "expired" && provenance.eligibleExpiry !== false && ++this.approvalExpiries >= 2) {
            this.approvalStopReason = "Local turn stopped after two unanswered approvals; no person answered. Do not retry the calls; inspect prior work before handoff or stopping.";
            try { if (!this.probeConfinement) this.opts.onApprovalStop?.(this.approvalStopReason); } catch { /* stop remains authoritative */ }
          }
        };
        const picked = await new Promise<ToolApproval>((resolve, reject) => {
          const finish = (decision: ToolApproval) => { turnSignal.removeEventListener("abort", onAbort); resolve(decision); };
          const onAbort = () => finish("aborted");
          turnSignal.addEventListener("abort", onAbort, { once: true });
          const asking = this.opts.tools.permit(title, tool, turnSignal, canonicalTarget, observe, originalPath, input, policy);
          if (this.probeConfinement) this.probePermits.add(asking);
          void asking.then(finish, (error) => { turnSignal.removeEventListener("abort", onAbort); reject(error); })
            .finally(() => { this.probePermits.delete(asking); });
        });
        if (generation !== this.turn || (turnSignal.aborted && picked !== "expired")) return "aborted";
        // Legacy permit callbacks can represent a person's denial without provenance. A true
        // result may be automatic, so it must never reset the unanswered-request streak.
        if (!observed && picked === false) observe({ source: "person", answerEpoch: (this.approvalAnswerEpoch ?? 0) + 1 });
        if (!observed && picked === "expired") observe({ source: "expired", answerEpoch: this.approvalAnswerEpoch ?? 0, eligibleExpiry: true });
        return picked;
      },
      shellExecutionCheck: input=>turnSignal.aborted||executionGeneration!==this.turn?"aborted":this.opts.tools.shellExecutionCheck?.(input)??"valid",
      sandboxProfile: this.sandboxProfile,
      sandboxEnv: this.probeConfinement ? { ...this.probeConfinement.env } : { ...proxyEnv(this.opts.tools.bashNetwork ?? false), AGENTHUB_PEER_ID: this.id },
      signal: turnSignal,
      send: (text, to) => {
        if (this.probeConfinement) return "error: messaging unavailable in guidance probe";
        const result = this.onMessage?.(text, pii ? reply : { inReplyTo: replyParent(envs), to: to?.length ? to : replyAudience(envs) }) as PublishResult | string | undefined;
        if (typeof result === "string") return `not sent: ${result}`;
        if (result?.dropped === "hop") return `not delivered: reply chain reached the hop cap (${MAX_HOP}); send a new message without reply_to`;
        return pii ? "sent to the console user only (PII task)" : "sent";
      },
    };
    return context;
  }

  private reportBudgetStop(e: Error, msgs: ChatMessage[], progress: { sideEffects: number; last: string }, reply: EnvelopeOpts, privateHistory: boolean, deliveryId?: string, remoteTurn = false, reviewTurn = false): void {
    this.opts.onLimit?.("budget");
    const message = remoteTurn ? "remote turn failed" : reviewTurn ? "review turn failed" : e.message;
    this.completeMissingToolResults(msgs, `not run: ${message}`);
    const detail = remoteTurn || reviewTurn ? message : progress.sideEffects
      ? `(execution budget stopped after ${progress.sideEffects} tool call(s) with side effects; partial work may exist and needs review) ${progress.last}`.trim()
      : `(execution budget stopped before any tool side effects; no work was repeated) ${progress.last}`.trim();
    msgs.push({ role: "assistant", content: detail });
    if (!privateHistory) this.commit(msgs);
    this.onMessage?.(detail, reply);
    if (deliveryId && this.activeDeliveryId === deliveryId) this.delivery({ id: deliveryId, state: "needs_review", reason: message });
  }

  private async requireBudget(envs: Envelope[], unit: "model_calls" | "tool_calls"): Promise<void> {
    if (this.probeConfinement) return;
    if (!this.opts.admitBudget) return;
    const decisions = await this.opts.admitBudget(envs, unit);
    const denied = decisions.find((decision) => !decision.allowed);
    if (denied) throw new ExecutionBudgetStop(`execution budget ${denied.reason ?? "exhausted"}: ${denied.scope} ${denied.unit} used ${denied.used}${denied.limit === null ? "" : ` of ${denied.limit}`}`);
    const remaining = decisions.filter((decision) => decision.unit === "elapsed_ms" && decision.remaining !== null).reduce<number | undefined>((min, decision) => min === undefined ? decision.remaining! : Math.min(min, decision.remaining!), undefined);
    if (remaining !== undefined) {
      clearTimeout(this.budgetTimer);
      this.budgetTimer = setTimeout(() => {
        this.budgetStopReason = "execution budget exhausted: elapsed_ms wall cap reached";
        this.abort?.abort();
      }, Math.max(0, remaining));
    }
  }

  /** Preserve valid model history when admission stops in the middle of a parallel tool-call batch. */
  private completeMissingToolResults(msgs: ChatMessage[], result: string): void {
    const called = new Set<string>();
    for (const msg of msgs) if (msg.role === "tool" && msg.tool_call_id) called.add(msg.tool_call_id);
    const missing: string[] = [];
    for (const msg of msgs) if (msg.role === "assistant") for (const call of msg.tool_calls ?? []) if (call.id && !called.has(call.id)) {
      called.add(call.id); missing.push(call.id);
    }
    for (const tool_call_id of missing) msgs.push({ role: "tool", tool_call_id, content: result });
  }

  /** Hub-owned in-process policy, with a fixed OmniRoute alias as fallback. */
  private async call(turnMsgs: ChatMessage[], policy: { route?: string; fixedModel?: string; pii?: boolean; task?: string } | undefined, envs: Envelope[], selection?: ModelOverrideSelection, fixedPrompt = system(this.opts.cwd, this.opts.preamble)): Promise<ChatResult> {
    if (this.probeConfinement) return this.callProbe(turnMsgs, fixedPrompt);
    const { omni } = this.opts;
    const route = selection?.model === undefined ? effectiveLocalRoute(this.opts.route, policy?.route, policy?.fixedModel) : undefined;
    if (route && !route.startsWith("hub/") && !this.warnedLegacyRoutes.has(route)) {
      this.warnedLegacyRoutes.add(route);
      this.opts.log?.(`legacy route ${route} is deprecated and ignored; using fixed model`);
    }
    const fixedModel = selection?.model ?? policy?.fixedModel ?? this.opts.fixedModel;
    const task = policy?.task === undefined ? undefined : Number(policy.task);
    const tools = [...this.toolSchemas(), ...(this.opts.taskTool ? [...profileTaskTools(this.opts.profile, this.opts.sdlcStages, this.opts.sdlcCriteria).filter(tool => tool.name !== "hub_delivery_retry"), ...CONDUCTOR_TOOLS].concat(SESSION_TITLE_TOOL).map(asFunction) : [])];
    const signal = this.abort!.signal;
    const messages: ChatMessage[] = [{ role: "system", content: fixedPrompt }, ...this.history, ...turnMsgs];
    const routed = await this.hubCall(route, messages, policy, signal);
    if (routed) { selection?.applied(); return routed; }
    await this.requireBudget(envs, "model_calls");
    this.releaseObserverInput(this.currentObserverInputContext, envs);
    const res = await omni.chat({ model: fixedModel, messages, tools }, { signal, ...(policy?.pii ? { onCampusOnly: true } : {}) });
    selection?.applied();
    this.lastServedBy = `omniroute ${fixedModel} (provider ${res.provider ?? "?"})`;
    this.recordUsage(res, fixedModel, task);
    return res;
  }

  private async callProbe(turnMsgs: ChatMessage[], fixedPrompt: string): Promise<ChatResult> {
    const probe = this.probeSession;
    if (!probe || this.probeStopping || this.abort?.signal.aborted) throw new ProbeLocalError("interrupted");
    probe.accounting.current();
    if (!this.probeFixture) requireProbeConfinement(probe.confinement, probe.workspace);
    const body = JSON.parse(JSON.stringify({ model: GUIDANCE_PROBE_MODEL,
      messages: [{ role: "system", content: fixedPrompt }, ...turnMsgs.map(({ is_error: _internal, ...message }) => message)], tools: probe.prepared.request.tools,
      max_tokens: probe.config.maxOutputTokens, stream: false })) as ProbeLocalRequest;
    const frame = JSON.stringify(body), first = this.probeCalls === 0;
    if (first && frame !== probe.prepared.inputFrame) throw new ProbeLocalError("drift");
    const result = await probeLocalEffect(probe.accounting, "model_calls", frame, first ? undefined : { inputBytes: Buffer.byteLength(frame, "utf8") },
      probe.config.tokenUpperBound, async signal => {
        if (signal.aborted || this.abort?.signal.aborted) throw new ProbeLocalError("interrupted");
        const value = await this.opts.omni.chat(body, { signal: this.abort!.signal });
        return { value, usage: probeObservedTokens(value) };
      });
    this.probeCalls++;
    this.probeServedModel = result.servedModel ?? null;
    this.probeServedExact = result.servedModelExact === true;
    this.probeUsageKnown = this.probeUsageKnown && probeObservedTokens(result) !== null;
    if (!this.probeUsageKnown) throw new ProbeLocalError("usage");
    if (result.servedModel !== GUIDANCE_PROBE_MODEL || result.servedModelExact !== true) throw new ProbeLocalError("model");
    return result;
  }

  private releaseObserverInput(context: OwnedInputContext | undefined, envs: Envelope[]): void {
    if (this.probeConfinement) return;
    if (!context || this.currentObserverInputContext !== context || this.observerInputReleasedId === context.inputId) return;
    this.observerInputReleasedId = context.inputId;
    try { this.opts.inputReleased?.(context, envs); } catch { /* observer metadata never changes the local model result */ }
  }

  private beginRouteTurn(generation: number, pii: boolean, task?: string): string {
    let id: string | undefined;
    try { id = this.opts.turnId?.(); } catch { /* optional host metadata */ }
    id ??= `${this.id}#${this.sessionId}.${generation}`;
    const number = task ? Number(task) : undefined;
    this.routeTask = Number.isSafeInteger(number) && number! > 0 ? number : undefined;
    this.labelTurnId = id;
    this.routes.beginTurn({ turn: id, pii, ...(Number.isSafeInteger(number) && number! > 0 ? { task: number } : {}) });
    return id;
  }

  private endRouteTurn(id: string | undefined, outcome: RouteTurnOutcome): void {
    if (!id) return;
    this.routes.endTurn(id, outcome);
    if (this.labelTurnId === id) this.labelTurnId = undefined;
  }

  private hubConfig(route?: string): HubRoute | undefined {
    try { return route?.startsWith("hub/") ? this.opts.hubRoutes?.()[route] : undefined; }
    catch { return undefined; } // optional model policy must not fail a turn
  }

  private routeScope(pii: boolean, turn = this.turn): string {
    return pii ? `${this.sessionId}:pii:${turn}` : this.sessionId;
  }

  private async hubCall(route: string | undefined, messages: ChatMessage[], policy: { pii?: boolean } | undefined, signal: AbortSignal): Promise<ChatResult | undefined> {
    const config = this.hubConfig(route);
    if (!route || !config) return undefined;
    try { return await this.routes.call(route, config, messages, this.routeScope(!!policy?.pii), !!policy?.pii, signal); }
    catch (error) {
      if (signal.aborted || error instanceof ExecutionBudgetStop || error instanceof DecisionPolicyChangedError) throw error;
      this.opts.log?.(`hub route ${route} unavailable; using fixed model`);
      return undefined;
    }
  }

  private async conclude(msgs: ChatMessage[], policy: { route?: string; fixedModel?: string; pii: boolean } | undefined, turn: number, step: number, maxSteps: number, answer: string, signal: AbortSignal, decisionId?: string, selection?: ModelOverrideSelection, fixedPrompt = system(this.opts.cwd, this.opts.preamble)): Promise<{ answer: string; complete: boolean } | undefined> {
    if (this.probeConfinement) return { answer, complete: true };
    const route = selection?.model === undefined ? effectiveLocalRoute(this.opts.route, policy?.route, policy?.fixedModel) : undefined, config = this.hubConfig(route);
    if (!route || !config) return { answer, complete: true };
    const messages: ChatMessage[] = [{ role: "system", content: fixedPrompt }, ...this.history, ...msgs];
    const feedback = await this.routes.review(route, config, messages, this.routeScope(!!policy?.pii, turn), !!policy?.pii, signal, decisionId);
    if (turn !== this.turn || !feedback) return { answer, complete: true };
    msgs.push({ role: "user", content: feedback });
    if (step + 1 >= maxSteps) this.opts.onLimit?.("steps");
    return step + 1 < maxSteps ? undefined : { answer: `(review requested changes; step limit reached) ${answer}`, complete: false };
  }

  private observeTool(call: ToolCall, output: string, policy: { pii: boolean; task?: string } | undefined, nativeTurn: string): void {
    if (this.probeConfinement) return;
    if (policy?.pii || call.function.name === "doc_read" || call.function.name === "web_fetch") return; // document and web text: no research observation carries it
    try {
      const command = safeParse(call.function.arguments).command;
      this.opts.onTool?.({ name: call.function.name, ...(typeof command === "string" ? { command } : {}), resultText: output, isError: toolResultFailed(call.function.name, output), source: "local", turn: nativeTurn }, policy?.task);
    } catch { /* optional research observations */ }
  }

  private recordUsage(res: ChatResult, requestedModel: string, task?: number): void {
    if (this.probeConfinement) return;
    try {
      this.opts.onUsage?.({
        id: randomUUID(),
        at: new Date().toISOString(),
        ...(res.usage ? { usage: res.usage } : {}),
        requestedModel: safeModelLabel(requestedModel) ?? "unknown",
        ...(Number.isSafeInteger(task) && task! > 0 ? { task } : {}),
        ...(safeModelLabel(res.servedModel) ? { servedModel: safeModelLabel(res.servedModel)! } : {}),
        ...(safeModelLabel(res.provider) ? { provider: safeModelLabel(res.provider)! } : {}),
      });
    } catch {
      // Usage persistence is optional and must never affect a provider call or turn.
    }
  }

  /** A finished turn joins the history; whole old turns (user message up to the next one) fall off the front, so tool calls keep their results. */
  private commit(msgs: ChatMessage[]): void {
    this.history.push(...msgs);
    while (chars(this.history) > HISTORY_CHARS) {
      const next = this.history.findIndex((m, i) => i > 0 && m.role === "user");
      if (next === -1) break;
      this.history.splice(0, next);
    }
  }

  /** Inside a long turn the oldest tool outputs are replaced by a stub: the structure stays valid, the context stays bounded. */
  private elide(msgs: ChatMessage[]): void {
    for (const m of msgs) {
      if (chars(msgs) <= TURN_CHARS) return;
      if (m.role === "tool" && (m.content?.length ?? 0) > 200) m.content = "(output elided to save context; run the tool again if you need it)";
    }
  }
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) ?? {};
  } catch {
    return {};
  }
}

export function isLocalPeer(value: unknown): value is LocalPeer {
  return value instanceof LocalPeer;
}
