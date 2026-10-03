import { HubRouteRuntime, type RouteEvent, type AdvisorEvent } from "../models/route/runtime.ts";
import type { HubRoute } from "../models/route/config.ts";
import type { ToolObservation } from "../models/route/signals.ts";
import { randomUUID } from "node:crypto";
import { renderDigest, replyAudience, replyParent, STANDING_INSTRUCTION, USER, type Envelope, type EnvelopeOpts, type PeerId } from "../hub/envelope.ts";
import { TASK_TOOL_NAMES, TASK_TOOLS } from "../hub/hub-tools.ts";
import { BasePeer } from "../hub/peers.ts";
import { profile, proxyEnv, type SandboxNetwork } from "../local/sandbox.ts";
import { runTool, TOOL_SCHEMAS, touchedPaths, type ToolContext } from "../local/tools.ts";
import type { Capture } from "../memory/capture.ts";
import type { ChatMessage, ChatResult, OmniRoute } from "../omniroute/client.ts";
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
  onRoute?: (event: RouteEvent) => void;
  onAdvisor?: (event: AdvisorEvent) => void;
  onTool?: (observation: ToolObservation, task?: string) => void;
  tools: { deny: string[]; permit: ToolContext["permit"]; bashNetwork?: SandboxNetwork; readAllow?: string[] };
  capture?: Capture;
  /** Runs a hub task tool (hub_task_*, hub_review, hub_remember) as this peer. Absent = the tools are not offered. */
  taskTool?: (name: string, args: Record<string, unknown>, turn: { pii: boolean }) => Promise<string>;
  /** Successful provider responses only; usage may be absent when the gateway omits it. Never includes prompt data. */
  onUsage?: (record: { id: string; at: string; usage?: ChatResult["usage"]; requestedModel: string; servedModel?: string; provider?: string }) => void;
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
  private turn = 0; // generation guard, as in acp.ts: a turn aborted by the watchdog must not touch the next one
  private abort: AbortController | undefined;
  private budgetTimer?: ReturnType<typeof setTimeout>;
  private budgetStopReason = "";
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
        const envs = this.routeEnvs, pii = this.routePii, generation = this.turn;
        await this.requireBudget(envs, "model_calls");
        if (generation !== this.turn) throw new Error("route belongs to an ended turn");
        if (signal.aborted) throw new Error("turn cancelled before model request");
        const tools = judge ? undefined : [...TOOL_SCHEMAS, ...(this.opts.taskTool ? TASK_TOOLS.map(asFunction) : [])];
        const result = await this.opts.omni.chat({ model, messages, ...(tools ? { tools } : {}), ...(judge ? { max_tokens: maxTokens ?? 2048 } : {}) }, { signal, ...(pii ? { onCampusOnly: true } : {}) });
        this.recordUsage(result, model);
        if (generation !== this.turn) throw new Error("route belongs to an ended turn");
        this.lastServedBy = `hub ${model} (provider ${result.provider ?? "?"})`;
        return result;
      },
      onCampus: () => this.opts.omni.onCampus(),
      onRoute: event => this.opts.onRoute?.(event),
      onAdvisor: event => this.opts.onAdvisor?.(event),
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
    clearTimeout(this.budgetTimer); this.budgetTimer = undefined;
    this.activeDeliveryId = deliveryId;
    this.abort = new AbortController();
    this.setState("busy");
    if (deliveryId) this.delivery({ id: deliveryId, state: "accepted" });
    // The turn works on its own message list and joins the history only as a whole, so a failed or aborted turn can
    // never leave a tool call without its result (strict servers reject that history forever after).
    const msgs: ChatMessage[] = [{ role: "user", content: renderDigest(envs, true) }];
    const progress = { sideEffects: 0, last: "" };
    const policy = this.opts.turnPolicy?.(envs);
    // A PII turn speaks to the console user only, and privately: its answer must not be broadcast to cloud-hosted peers.
    // The task id travels with it, so the board can keep the text (`ahub task show`) while tail and log show a stub.
    const reply: EnvelopeOpts = { inReplyTo: replyParent(envs), to: replyAudience(envs), ...(policy?.pii ? { to: [USER], private: true, priority: "important" as const, ...(policy.task ? { refs: { task: policy.task } } : {}) } : {}) };
    this.run(envs, turn, msgs, progress, policy, reply)
      .then((answer) => {
        if (turn !== this.turn) return;
        if (!policy?.pii) this.commit(msgs); // a PII turn leaves nothing in the history later turns send along
        if (answer) this.onMessage?.(answer, reply);
        if (deliveryId && this.activeDeliveryId === deliveryId) this.delivery({ id: deliveryId, state: "completed" });
      })
      .catch((e: Error) => {
        if (turn !== this.turn) return; // aborted by the watchdog or stop(): nothing to report, nothing was committed
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
        if (turn === this.turn) { clearTimeout(this.budgetTimer); this.budgetTimer = undefined; }
        if (turn === this.turn && this.state === "busy") this.setState("idle");
        if (turn === this.turn && this.activeDeliveryId === deliveryId) this.activeDeliveryId = undefined;
      });
  }

  protected override onWatchdog(): void {
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
    const routeId = policy?.route ?? this.opts.route;
    const scope = policy?.pii ? `${this.sessionId}:pii:${turn}` : this.sessionId;
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
        const routeConfig = routeId?.startsWith("hub/") ? this.opts.hubRoutes?.()[routeId] : undefined;
        if (routeId && routeConfig) {
          const feedback = await this.routes.review(routeId, routeConfig, [{ role: "system", content: system(this.opts.cwd, this.opts.preamble) }, ...this.history, ...msgs], scope, !!policy?.pii, turnSignal);
          if (turn !== this.turn) return "";
          if (feedback && step + 1 < maxSteps) { msgs.push({ role: "user", content: feedback }); continue; }
          if (feedback) progress.last = `(review requested changes; step limit reached) ${progress.last}`;
        }
        if (usedTools) capture?.summarize(progress.last);
        return progress.last;
      }
      for (const call of res.message.tool_calls) {
        // A tool has its own timeout (bash up to 600 s) and an approval can take 120 s: neither is the model going silent.
        const alive = setInterval(() => this.state === "busy" && turn === this.turn && this.touch(), 30_000);
        const name = call.function.name;
        try {
          await this.requireBudget(envs, "tool_calls");
          if (turnSignal.aborted) throw new ExecutionBudgetStop(this.budgetStopReason || "turn cancelled before tool execution");
        } catch (error) { clearInterval(alive); throw error; }
        const running = TASK_TOOL_NAMES.has(name) && this.opts.taskTool ? this.opts.taskTool(name, safeParse(call.function.arguments), { pii: !!policy?.pii }).catch((e: Error) => `error: ${e.message}`) : runTool(name, call.function.arguments, ctx);
        const output = await running.finally(() => clearInterval(alive));
        if (turn !== this.turn) return "";
        this.touch();
        usedTools = true;
        if (SIDE_EFFECTS.has(call.function.name) && !output.startsWith("error:")) progress.sideEffects++;
        msgs.push({ role: "tool", tool_call_id: call.id, content: output });
        if (!policy?.pii) {
          try { this.opts.onTool?.({ name, ...(typeof safeParse(call.function.arguments).command === "string" ? { command: safeParse(call.function.arguments).command as string } : {}), resultText: output, isError: output.startsWith("error:"), source: "local" }, policy?.task); } catch { /* optional research observations */ }
        }
        capture?.observe({ tool: call.function.name, args: call.function.arguments, output, id: call.id, paths: touchedPaths(call.function.name, safeParse(call.function.arguments)) });
      }
    }
    if (usedTools) capture?.summarize(progress.last);
    return `(stopped after ${maxSteps} steps) ${progress.last}`.trim();
  }

  private toolContext(envs: Envelope[], turnSignal: AbortSignal, pii: boolean, reply: EnvelopeOpts): ToolContext {
    return {
      cwd: this.opts.cwd,
      deny: this.opts.tools.deny,
      permit: async (title) => {
        if (turnSignal.aborted) return false;
        return new Promise<boolean>((resolve, reject) => {
          const finish = (allowed: boolean) => { turnSignal.removeEventListener("abort", onAbort); resolve(allowed); };
          const onAbort = () => finish(false);
          turnSignal.addEventListener("abort", onAbort, { once: true });
          this.opts.tools.permit(title).then(finish, (error) => { turnSignal.removeEventListener("abort", onAbort); reject(error); });
        });
      },
      sandboxProfile: this.sandboxProfile,
      sandboxEnv: proxyEnv(this.opts.tools.bashNetwork ?? false),
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
  private async call(turnMsgs: ChatMessage[], policy: { route?: string; fixedModel?: string; pii?: boolean } | undefined, envs: Envelope[]): Promise<ChatResult> {
    const { omni, sidecar } = this.opts;
    // A task turn asks for its class's route; a route needs the sidecar, which exists only when the worker was started with one.
    const route = policy?.route ?? this.opts.route;
    const fixedModel = policy?.fixedModel ?? this.opts.fixedModel;
    const tools = [...TOOL_SCHEMAS, ...(this.opts.taskTool ? TASK_TOOLS.map(asFunction) : [])];
    const signal = this.abort!.signal;
    const messages: ChatMessage[] = [{ role: "system", content: system(this.opts.cwd, this.opts.preamble) }, ...this.history, ...turnMsgs];
    if (route?.startsWith("hub/")) {
      const config = this.opts.hubRoutes?.()[route];
      if (config) {
        try { return await this.routes.call(route, config, messages, policy?.pii ? `${this.sessionId}:pii:${this.turn}` : this.sessionId, !!policy?.pii, signal); }
        catch (error) { if (signal.aborted || error instanceof ExecutionBudgetStop) throw error; this.opts.log?.(`hub route ${route} unavailable; using fixed model`); }
      }
    }
    const via = route && !route.startsWith("hub/") && !policy?.pii ? await sidecar?.endpoint() : undefined;
    if (via) {
      await this.requireBudget(envs, "model_calls");
      try {
        const res = await omni.chat({ model: route!, messages, tools }, { via, sessionId: this.sessionId, signal });
        this.lastServedBy = `switchyard ${route} -> ${res.selectedModel ?? "?"}`;
        this.recordUsage(res, route!);
        return res;
      } catch (e) {
        if (signal.aborted) throw e;
        sidecar!.disable((e as Error).message);
      }
    }
    await this.requireBudget(envs, "model_calls");
    const res = await omni.chat({ model: fixedModel, messages, tools }, { signal, ...(policy?.pii ? { onCampusOnly: true } : {}) });
    this.lastServedBy = `omniroute ${fixedModel} (provider ${res.provider ?? "?"})`;
    this.recordUsage(res, fixedModel);
    return res;
  }

  private recordUsage(res: ChatResult, requestedModel: string): void {
    try {
      this.opts.onUsage?.({
        id: randomUUID(),
        at: new Date().toISOString(),
        ...(res.usage ? { usage: res.usage } : {}),
        requestedModel: safeModelLabel(requestedModel) ?? "unknown",
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
