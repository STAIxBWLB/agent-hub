import { HubRouteRuntime, type RouteEvent, type AdvisorEvent } from "../models/route/runtime.ts";
import type { HubRoute } from "../models/route/config.ts";
import type { RouteLabelEvent, RouteTurnOutcome } from "../models/route/labels.ts";
import type { StaySwitchPolicy } from "../models/route/stage.ts";
import type { ToolObservation } from "../models/route/signals.ts";
import { randomUUID } from "node:crypto";
import { renderDigest, replyAudience, replyParent, STANDING_INSTRUCTION, USER, type Envelope, type EnvelopeOpts, type PeerId } from "../hub/envelope.ts";
import { CONDUCTOR_TOOL_NAMES, CONDUCTOR_TOOLS, TASK_TOOL_NAMES, TASK_TOOLS } from "../hub/hub-tools.ts";
import { BasePeer } from "../hub/peers.ts";
import { profile, proxyEnv, type SandboxNetwork } from "../local/sandbox.ts";
import { runTool, toolResultFailed, TOOL_SCHEMAS, touchedPaths, ApprovalWaitStop, type ToolApproval, type ApprovalProvenance, type ToolContext } from "../local/tools.ts";
import type { Capture } from "../memory/capture.ts";
import type { ChatMessage, ChatResult, OmniRoute, ToolCall } from "../omniroute/client.ts";
import { safeModelLabel } from "../omniroute/usage.ts";
import type { Sidecar } from "../switchyard/sidecar.ts";
import type { ExecutionBudgetDecision } from "../hub/execution-budget.ts";

export interface LocalOptions {
  cwd: string;
  omni: OmniRoute;
  /** Absent = always the fixed model on OmniRoute. */
  sidecar?: Sidecar;
  /** Switchyard route id asked of the sidecar. */
  route?: string;
  /** Model id sent straight to OmniRoute when the sidecar is absent, unhealthy or fails a call. */
  fixedModel: string;
  hubRoutes?: () => Record<string, HubRoute>;
  /** routing.toml `stay_switch` for hub stage routes (#197). */
  staySwitch?: () => StaySwitchPolicy | undefined;
  onRoute?: (event: RouteEvent) => void;
  onAdvisor?: (event: AdvisorEvent) => void;
  onRouteOutcome?: (event: RouteLabelEvent) => void;
  /** The daemon turn id created synchronously on busy, shared with turn_start/end. */
  turnId?: () => string | undefined;
  onApprovalStop?: (reason: string) => void;
  onTool?: (observation: ToolObservation, task?: string) => void;
  tools: { deny: string[]; permit: ToolContext["permit"]; bashNetwork?: SandboxNetwork; readAllow?: string[] };
  capture?: Capture;
  /** Runs a hub task tool (hub_task_*, hub_review, hub_remember) as this peer. Absent = the tools are not offered. */
  taskTool?: (name: string, args: Record<string, unknown>, turn: { pii: boolean }) => Promise<string>;
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

/** Hub-native agent loop: the hub owns every model call, so it can choose the model per call (L2) and the gateway (L3). */
export class LocalPeer extends BasePeer {
  readonly hubNative = true;
  private readonly history: ChatMessage[] = [];
  private readonly sessionId = `agent-hub-local-${randomUUID()}`;
  private readonly routes: HubRouteRuntime;
  private routeEnvs: Envelope[] = [];
  private routePii = false;
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
  private readonly sandboxProfile: string; // built once: profile() spawns git and must stay off the per-call path
  /** What served the last call, for `ahub status`. */
  lastServedBy = "";

  constructor(
    id: PeerId,
    private readonly opts: LocalOptions,
  ) {
    super(id, opts.watchdogMs);
    this.routes = new HubRouteRuntime({
      execute: async (model, messages, judge, signal, maxTokens) => {
        if (signal.aborted) throw new Error("turn cancelled before model request");
        const envs = this.routeEnvs, pii = this.routePii, generation = this.turn, task = this.routeTask;
        await this.requireBudget(envs, "model_calls");
        if (generation !== this.turn) throw new Error("route belongs to an ended turn");
        if (signal.aborted) throw new Error("turn cancelled before model request");
        const tools = judge ? undefined : [...TOOL_SCHEMAS, ...(this.opts.taskTool ? [...TASK_TOOLS, ...CONDUCTOR_TOOLS].map(asFunction) : [])];
        const result = await this.opts.omni.chat({ model, messages, ...(tools ? { tools } : {}), ...(judge ? { max_tokens: maxTokens ?? 2048 } : {}) }, { signal, ...(pii ? { onCampusOnly: true } : {}) });
        this.recordUsage(result, model, task);
        if (generation !== this.turn) throw new Error("route belongs to an ended turn");
        this.lastServedBy = `hub ${model} (provider ${result.provider ?? "?"})`;
        return result;
      },
      onCampus: () => this.opts.omni.onCampus(),
      staySwitch: () => this.opts.staySwitch?.(),
      onRoute: event => this.opts.onRoute?.(event),
      onAdvisor: event => this.opts.onAdvisor?.(event),
      onRouteOutcome: event => this.opts.onRouteOutcome?.(event),
    });
    this.sandboxProfile = profile(opts.cwd, opts.tools.bashNetwork ?? false, opts.tools.readAllow, opts.tools.deny);
  }

  recoveryMetadata(): Record<string, unknown> {
    return { launch: { kind: "local", cwd: this.opts.cwd, model: this.opts.fixedModel, ...(this.opts.route ? { route: this.opts.route } : {}) }, sessionId: this.sessionId };
  }

  async start(): Promise<void> {
    this.opts.capture?.init(this.sessionId, "agent-hub local worker session");
    this.setState("idle");
  }

  async stop(): Promise<void> {
    this.endRouteTurn(this.labelTurnId, "failed");
    if (this.activeDeliveryId) this.delivery({ id: this.activeDeliveryId, state: "needs_review", reason: "turn stopped before settlement" });
    this.activeDeliveryId = undefined;
    this.turn++;
    clearTimeout(this.budgetTimer); this.budgetTimer = undefined;
    this.abort?.abort();
    await this.opts.capture?.end();
    this.setState("offline");
  }

  /** Resolves once the turn is claimed; a turn that cannot reach any model hands the envelopes back through onFailed. */
  async deliver(envs: Envelope[], deliveryId?: string): Promise<void> {
    if (this.state !== "idle") {
      if (deliveryId) this.delivery({ id: deliveryId, state: "failed_safe", reason: `${this.id} is ${this.state}` });
      throw new Error(`${this.id} is ${this.state}`);
    }
    const turn = ++this.turn;
    this.budgetStopReason = "";
    this.approvalExpiries = 0; this.approvalAnswerEpoch = undefined; this.approvalStopReason = "";
    clearTimeout(this.budgetTimer); this.budgetTimer = undefined;
    this.activeDeliveryId = deliveryId;
    this.abort = new AbortController();
    this.setState("busy");
    if (deliveryId) this.delivery({ id: deliveryId, state: "accepted" });
    // The turn works on its own message list and joins the history only as a whole, so a failed or aborted turn can
    // never leave a tool call without its result (strict servers reject that history forever after).
    const msgs: ChatMessage[] = [{ role: "user", content: renderDigest(envs, true) }];
    const progress = { sideEffects: 0, last: "" };
    const requestedPolicy = this.opts.turnPolicy?.(envs);
    const policy = envs.some(env => env.private) ? { ...requestedPolicy, pii: true } : requestedPolicy;
    const labelTurn = this.beginRouteTurn(turn, !!policy?.pii || envs.some(env => env.private), policy?.task);
    let completed = false;
    // A PII turn speaks to the console user only, and privately: its answer must not be broadcast to cloud-hosted peers.
    // The task id travels with it, so the board can keep the text (`ahub task show`) while tail and log show a stub.
    const reply: EnvelopeOpts = { inReplyTo: replyParent(envs), to: replyAudience(envs), ...(policy?.pii ? { to: [USER], private: true, priority: "important" as const, ...(policy.task ? { refs: { task: policy.task } } : {}) } : {}) };
    this.run(envs, turn, msgs, progress, policy, reply)
      .then((answer) => {
        if (turn !== this.turn) return;
        if (!policy?.pii) this.commit(msgs); // a PII turn leaves nothing in the history later turns send along
        if (answer) this.onMessage?.(answer, reply);
        if (deliveryId && this.activeDeliveryId === deliveryId) this.delivery({ id: deliveryId, state: "completed" });
        completed = true;
      })
      .catch((e: Error) => {
        if (turn !== this.turn) return; // aborted by the watchdog or stop(): nothing to report, nothing was committed
        if (e instanceof ApprovalWaitStop) {
          this.completeMissingToolResults(msgs, "not run: turn ended after unanswered approvals");
          msgs.push({ role: "assistant", content: e.message });
          if (!policy?.pii) this.commit(msgs);
          this.onMessage?.(e.message, reply);
          if (deliveryId && this.activeDeliveryId === deliveryId) this.delivery({ id: deliveryId, state: "needs_review", reason: e.message });
          return; // even without effects, an unanswered approval must not trigger safe replay
        }
        if (this.budgetStopReason && !(e instanceof ExecutionBudgetStop)) e = new ExecutionBudgetStop(this.budgetStopReason);
        this.opts.log?.(`[${this.id}] turn failed: ${e.message}`);
        if (e instanceof ExecutionBudgetStop) {
          this.reportBudgetStop(e, msgs, progress, reply, !!policy?.pii, deliveryId);
          return;
        }
        if (!progress.sideEffects) {
          if (deliveryId && this.activeDeliveryId === deliveryId) this.delivery({ id: deliveryId, state: "failed_safe", reason: e.message });
          else this.onFailed?.(envs); // legacy delivery: safe to redeliver
          return;
        }
        // Tools already changed things. Redelivering would redo approved writes and commits, so report instead.
        // A model call is the only thing that throws here, and every tool call before it has its result: msgs is consistent.
        const note = `(turn failed after ${progress.sideEffects} tool call(s) with side effects: ${e.message.slice(0, 200)}. The work may be partial; check before repeating it.) ${progress.last}`.trim();
        msgs.push({ role: "assistant", content: note });
        if (!policy?.pii) this.commit(msgs);
        this.onMessage?.(note, reply);
        if (deliveryId && this.activeDeliveryId === deliveryId) this.delivery({ id: deliveryId, state: "needs_review", reason: e.message });
      })
      .finally(() => {
        this.endRouteTurn(labelTurn, completed ? "completed" : "failed");
        if (turn === this.turn) { clearTimeout(this.budgetTimer); this.budgetTimer = undefined; }
        if (turn === this.turn && this.state === "busy") this.setState("idle");
        if (turn === this.turn && this.activeDeliveryId === deliveryId) this.activeDeliveryId = undefined;
      });
  }

  protected override onWatchdog(): void {
    this.endRouteTurn(this.labelTurnId, "failed");
    if (this.activeDeliveryId) this.delivery({ id: this.activeDeliveryId, state: "needs_review", reason: "turn watchdog timeout" });
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
    progress: { sideEffects: number; last: string },
    policy: { route?: string; fixedModel?: string; pii: boolean; task?: string } | undefined,
    reply: EnvelopeOpts,
  ): Promise<string> {
    const { maxSteps = 30 } = this.opts;
    const turnSignal = this.abort!.signal;
    // claude-mem's observer is a cloud model: nothing of a PII turn is captured.
    const capture = policy?.pii ? undefined : this.opts.capture;
    // Positive confirmation, and for the path this turn will really take: a sidecar generated against the off-campus URL
    // keeps sending there even after the client has found the campus gateway again.
    const viaOffCampus = !(policy?.route ?? this.opts.route)?.startsWith("hub/") && !!this.opts.sidecar?.upstream && this.opts.omni.isAccessHost(this.opts.sidecar.upstream);
    if (policy?.pii && (viaOffCampus || !(await this.opts.omni.onCampus()))) {
      return "Refused: this is a PII task and the only reachable gateway is off campus (Cloudflare Access). Connect the VPN and assign it again.";
    }
    this.routeEnvs = envs;
    this.routePii = !!policy?.pii;
    const ctx = this.toolContext(envs, turnSignal, !!policy?.pii, reply);
    let usedTools = false;
    for (let step = 0; step < maxSteps; step++) {
      this.elide(msgs);
      const res = await this.call(msgs, policy, envs);
      if (turn !== this.turn) return "";
      this.touch();
      msgs.push(res.message);
      progress.last = res.message.content?.trim() || progress.last;
      if (!res.message.tool_calls?.length) {
        const concluded = await this.conclude(msgs, policy, turn, step, maxSteps, progress.last, turnSignal, res.routeDecision);
        if (turn !== this.turn) return "";
        if (concluded === undefined) continue;
        if (usedTools) capture?.summarize(concluded);
        return concluded;
      }
      const results: ChatMessage[] = [];
      try {
        for (const call of res.message.tool_calls) {
          // A tool has its own timeout (bash up to 600 s) and an approval can take 120 s: neither is the model going silent.
          const alive = setInterval(() => this.state === "busy" && turn === this.turn && this.touch(), 30_000);
          const name = call.function.name;
          try {
            await this.requireBudget(envs, "tool_calls");
            if (turnSignal.aborted) throw new ExecutionBudgetStop(this.budgetStopReason || "turn cancelled before tool execution");
          } catch (error) { clearInterval(alive); throw error; }
          const running = (TASK_TOOL_NAMES.has(name) || CONDUCTOR_TOOL_NAMES.has(name)) && this.opts.taskTool ? this.opts.taskTool(name, safeParse(call.function.arguments), { pii: !!policy?.pii }).catch((e: Error) => `error: ${e.message}`) : runTool(name, call.function.arguments, ctx);
          const output = await running.finally(() => clearInterval(alive));
          if (turn !== this.turn) return "";
          this.touch();
          usedTools = true;
          if (SIDE_EFFECTS.has(call.function.name) && !output.startsWith("error:")) progress.sideEffects++;
          const result: ChatMessage = { role: "tool", tool_call_id: call.id, content: output, is_error: toolResultFailed(name, output) };
          msgs.push(result); results.push(result);
          if (this.approvalStopReason) { this.abort?.abort(); throw new ApprovalWaitStop(this.approvalStopReason); }
          this.observeTool(call, output, policy, `${this.sessionId}.${turn}.${step}`);
          // Hub tool arguments/results are not capture evidence; Tasks owns its screened memory writes.
          if (name !== "hub_send" && !TASK_TOOL_NAMES.has(name) && !CONDUCTOR_TOOL_NAMES.has(name)) capture?.observe({ tool: call.function.name, args: call.function.arguments, output, id: call.id, paths: touchedPaths(call.function.name, safeParse(call.function.arguments)) });
        }
      } finally { if (results.length) this.routes.observeResults(res.routeDecision, res.message, results); }
    }
    if (usedTools) capture?.summarize(progress.last);
    return `(stopped after ${maxSteps} steps) ${progress.last}`.trim();
  }

  private toolContext(envs: Envelope[], turnSignal: AbortSignal, pii: boolean, reply: EnvelopeOpts): ToolContext {
    return {
      cwd: this.opts.cwd,
      deny: this.opts.tools.deny,
      permit: async (title, tool, _signal, canonicalTarget) => {
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
            try { this.opts.onApprovalStop?.(this.approvalStopReason); } catch { /* stop remains authoritative */ }
          }
        };
        const picked = await new Promise<ToolApproval>((resolve, reject) => {
          const finish = (decision: ToolApproval) => { turnSignal.removeEventListener("abort", onAbort); resolve(decision); };
          const onAbort = () => finish("aborted");
          turnSignal.addEventListener("abort", onAbort, { once: true });
          this.opts.tools.permit(title, tool, turnSignal, canonicalTarget, observe).then(finish, (error) => { turnSignal.removeEventListener("abort", onAbort); reject(error); });
        });
        if (generation !== this.turn || (turnSignal.aborted && picked !== "expired")) return "aborted";
        // Legacy permit callbacks can represent a person's denial without provenance. A true
        // result may be automatic, so it must never reset the unanswered-request streak.
        if (!observed && picked === false) observe({ source: "person", answerEpoch: (this.approvalAnswerEpoch ?? 0) + 1 });
        if (!observed && picked === "expired") observe({ source: "expired", answerEpoch: this.approvalAnswerEpoch ?? 0, eligibleExpiry: true });
        return picked;
      },
      sandboxProfile: this.sandboxProfile,
      sandboxEnv: { ...proxyEnv(this.opts.tools.bashNetwork ?? false), AGENTHUB_PEER_ID: this.id },
      signal: turnSignal,
      send: (text, to) => {
        const refused = this.onMessage?.(text, pii ? reply : { inReplyTo: replyParent(envs), to: to?.length ? to : replyAudience(envs) });
        if (typeof refused === "string") return `not sent: ${refused}`;
        return pii ? "sent to the console user only (PII task)" : "sent";
      },
    };
  }

  private reportBudgetStop(e: Error, msgs: ChatMessage[], progress: { sideEffects: number; last: string }, reply: EnvelopeOpts, pii: boolean, deliveryId?: string): void {
    this.completeMissingToolResults(msgs, `not run: ${e.message}`);
    const detail = progress.sideEffects
      ? `(execution budget stopped after ${progress.sideEffects} tool call(s) with side effects; partial work may exist and needs review) ${progress.last}`.trim()
      : `(execution budget stopped before any tool side effects; no work was repeated) ${progress.last}`.trim();
    msgs.push({ role: "assistant", content: detail });
    if (!pii) this.commit(msgs);
    this.onMessage?.(detail, reply);
    if (deliveryId && this.activeDeliveryId === deliveryId) this.delivery({ id: deliveryId, state: "needs_review", reason: e.message });
  }

  private async requireBudget(envs: Envelope[], unit: "model_calls" | "tool_calls"): Promise<void> {
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

  /** L2 when the sidecar is up, otherwise (or when a call through it fails) the fixed model on L3. */
  private async call(turnMsgs: ChatMessage[], policy: { route?: string; fixedModel?: string; pii?: boolean; task?: string } | undefined, envs: Envelope[]): Promise<ChatResult> {
    const { omni, sidecar } = this.opts;
    // A task turn asks for its class's route; a route needs the sidecar, which exists only when the worker was started with one.
    const route = policy?.route ?? this.opts.route;
    const fixedModel = policy?.fixedModel ?? this.opts.fixedModel;
    const task = policy?.task === undefined ? undefined : Number(policy.task);
    const tools = [...TOOL_SCHEMAS, ...(this.opts.taskTool ? [...TASK_TOOLS, ...CONDUCTOR_TOOLS].map(asFunction) : [])];
    const signal = this.abort!.signal;
    const messages: ChatMessage[] = [{ role: "system", content: system(this.opts.cwd, this.opts.preamble) }, ...this.history, ...turnMsgs];
    const routed = await this.hubCall(route, messages, policy, signal);
    if (routed) return routed;
    const via = await this.sidecarEndpoint(route, !!policy?.pii);
    if (via) {
      await this.requireBudget(envs, "model_calls");
      try {
        const res = await omni.chat({ model: route!, messages, tools }, { via, sessionId: this.sessionId, signal });
        this.lastServedBy = `switchyard ${route} -> ${res.selectedModel ?? "?"}`;
        this.recordUsage(res, route!, task);
        return res;
      } catch (e) {
        if (signal.aborted) throw e;
        sidecar!.disable((e as Error).message);
      }
    }
    await this.requireBudget(envs, "model_calls");
    const res = await omni.chat({ model: fixedModel, messages, tools }, { signal, ...(policy?.pii ? { onCampusOnly: true } : {}) });
    this.lastServedBy = `omniroute ${fixedModel} (provider ${res.provider ?? "?"})`;
    this.recordUsage(res, fixedModel, task);
    return res;
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
      if (signal.aborted || error instanceof ExecutionBudgetStop) throw error;
      this.opts.log?.(`hub route ${route} unavailable; using fixed model`);
      return undefined;
    }
  }

  private async sidecarEndpoint(route: string | undefined, pii: boolean): Promise<string | undefined> {
    if (!route || route.startsWith("hub/") || pii) return undefined;
    return this.opts.sidecar?.endpoint();
  }

  private async conclude(msgs: ChatMessage[], policy: { route?: string; pii: boolean } | undefined, turn: number, step: number, maxSteps: number, answer: string, signal: AbortSignal, decisionId?: string): Promise<string | undefined> {
    const route = policy?.route ?? this.opts.route, config = this.hubConfig(route);
    if (!route || !config) return answer;
    const messages: ChatMessage[] = [{ role: "system", content: system(this.opts.cwd, this.opts.preamble) }, ...this.history, ...msgs];
    const feedback = await this.routes.review(route, config, messages, this.routeScope(!!policy?.pii, turn), !!policy?.pii, signal, decisionId);
    if (turn !== this.turn || !feedback) return answer;
    msgs.push({ role: "user", content: feedback });
    return step + 1 < maxSteps ? undefined : `(review requested changes; step limit reached) ${answer}`;
  }

  private observeTool(call: ToolCall, output: string, policy: { pii: boolean; task?: string } | undefined, nativeTurn: string): void {
    if (policy?.pii) return;
    try {
      const command = safeParse(call.function.arguments).command;
      this.opts.onTool?.({ name: call.function.name, ...(typeof command === "string" ? { command } : {}), resultText: output, isError: toolResultFailed(call.function.name, output), source: "local", turn: nativeTurn }, policy?.task);
    } catch { /* optional research observations */ }
  }

  private recordUsage(res: ChatResult, requestedModel: string, task?: number): void {
    try {
      this.opts.onUsage?.({
        id: randomUUID(),
        at: new Date().toISOString(),
        ...(res.usage ? { usage: res.usage } : {}),
        requestedModel: safeModelLabel(requestedModel) ?? "unknown",
        ...(Number.isSafeInteger(task) && task! > 0 ? { task } : {}),
        ...(safeModelLabel(res.servedModel ?? res.selectedModel) ? { servedModel: safeModelLabel(res.servedModel ?? res.selectedModel)! } : {}),
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
