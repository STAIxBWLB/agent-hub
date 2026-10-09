import type { ChatMessage, ChatResult } from "../../omniroute/client.ts";
import { AdvisorGate, buildAdvisorJudgeRequest, redoFeedback } from "./advisor.ts";
import type { HubRoute } from "./config.ts";
import { buildEscalationJudgeRequest, parseEscalationVerdict } from "./escalation.ts";
import { normalizeConversation } from "./normalize.ts";
import { extractToolSignals, turnKind } from "./signals.ts";
import { RouteLabelTracker, type RouteLabelEvent, type RouteTurnContext, type RouteTurnOutcome } from "./labels.ts";
import { dimensionsFromSignal, estimateInputTokens, selectStage, stayOrSwitch, type StageState, type StaySwitchPolicy, type SwitchTrace, type Tier } from "./stage.ts";
import { EscalationState, SessionState } from "./state.ts";
import { parseAdvisorVerdict } from "./text.ts";
import { planExecutePhase, type PlanExecuteState } from "./plan-execute.ts";

export interface RouteEvent extends Partial<SwitchTrace> {
  route: string; tier: string; source: "override" | "dimensions" | "hold" | "classifier" | "default"; score: number; ms: number;
  decision?: string; turn?: string; task?: number; pii?: boolean; severity?: number; spinning?: number; exploring?: number; production?: number;
}
export interface AdvisorEvent { route: string; trigger: string; verdict: "approve" | "redo" | "failed"; discardedChars: number }
interface RouteState { fingerprint: string; stage: StageState; pin?: Tier; plan: PlanExecuteState; escalation: EscalationState; advisor: AdvisorGate }
export interface RouteHost {
  execute: (model: string, messages: ChatMessage[], judge: boolean, signal: AbortSignal, maxTokens?: number) => Promise<ChatResult>;
  onCampus: () => Promise<boolean>;
  /** Read on every stage call (#197); absent is the shadow default. */
  staySwitch?: () => StaySwitchPolicy | undefined;
  onRoute?: (event: RouteEvent) => void;
  onRouteOutcome?: (event: RouteLabelEvent) => void;
  onAdvisor?: (event: AdvisorEvent) => void;
}

/** Transport stays in the host. Optional judge work has one deadline and five-minute failure backoff. */
export class HubRouteRuntime {
  private readonly states = new SessionState<RouteState>();
  private readonly labels: RouteLabelTracker;
  private judgeOffUntil = 0;
  constructor(private readonly host: RouteHost, private readonly judgeTimeoutMs = 8000) {
    this.labels = new RouteLabelTracker(event => this.host.onRouteOutcome?.(event));
  }

  beginTurn(context: RouteTurnContext): void { try { this.labels.beginTurn(context); } catch { /* labels are optional telemetry */ } }

  endTurn(turnId: string, outcome: RouteTurnOutcome): void {
    try { this.labels.endTurn(turnId, outcome, event => this.host.onRouteOutcome?.(event)); } catch { /* labels are optional telemetry */ }
  }

  observeResults(decisionId: string | undefined, assistant: ChatMessage, toolMessages: ChatMessage[]): void {
    try { this.labels.observeResults(decisionId, assistant, toolMessages); } catch { /* model output cannot break a turn through telemetry */ }
  }

  private state(route: string, config: HubRoute, scope: string): RouteState {
    const key = `${scope}:${route}`, fingerprint = JSON.stringify(config);
    const prior = this.states.get(key);
    if (prior?.fingerprint === fingerprint) return prior;
    const value: RouteState = { fingerprint, stage: { capableHoldTurnsRemaining: 0 }, plan: { executingSessions: [] }, escalation: new EscalationState(), advisor: new AdvisorGate({ trigger: config.trigger, pattern: config.pattern, maxReviews: config.max_reviews, gateStallTurns: config.gate_stall_turns, gateMinToolResults: config.gate_min_tool_results, transcriptMaxChars: config.transcript_max_chars }) };
    this.states.set(key, value); return value;
  }

  /** Executor failures retry the fixed model only in the caller; no tool has run yet. */
  async call(route: string, config: HubRoute, messages: ChatMessage[], scope: string, pii: boolean, signal: AbortSignal): Promise<ChatResult> {
    const labelTurn = this.labels.captureTurn();
    const started = performance.now(), state = this.state(route, config, scope);
    const conversation = normalizeConversation(messages), signals = extractToolSignals(conversation);
    const dimensions = dimensionsFromSignal(signals);
    const efficient = config.efficient ?? "fast", capable = config.capable ?? "coding";
    let model = efficient, source: RouteEvent["source"] = "default", score = 0;
    let sent = messages, trace: Partial<SwitchTrace> = {};
    if (config.type === "stage") {
      const decision = selectStage(signals, { confidenceThreshold: config.confidence_threshold, capableHoldTurns: config.hold_turns }, state.stage);
      state.stage = decision.state;
      // OmniRoute models publish no context limit to the hub, so every tier fits here; the estimate leaves out the tool
      // schemas the host adds to each call, as the relay counts what Pi sends. A PII conversation's size says
      // something about its text, as a private envelope's does: the planner never sees it (no prefill bound, so no
      // plan or reason can depend on it) and the event leaves it out.
      const staged = stayOrSwitch(this.host.staySwitch?.(), state.pin, decision, turnKind(conversation), { inputTokens: pii ? 0 : estimateInputTokens(messages), fits: () => true });
      state.pin = staged.pin;
      const { prefillTokens, ...shape } = staged.trace;
      trace = pii ? shape : staged.trace;
      model = staged.tier === "capable" ? capable : efficient;
      score = decision.score;
      source = decision.source === "capable_hold" ? "hold" : decision.source === "override" || decision.source === "dimensions" ? decision.source : "default";
    } else if (config.type === "plan_execute") {
      const decision = planExecutePhase(signals, scope, state.plan);
      model = decision.tier === "capable" ? capable : efficient;
      state.plan = decision.state;
      if (decision.planningPrompt) sent = [{ role: "system", content: decision.planningPrompt }, ...messages];
    } else if (config.type === "escalation" && state.escalation.snapshot().latched) model = capable;
    let decisionId = this.emitRoute({ route, tier: model, source, score, ms: performance.now() - started, ...trace }, labelTurn, dimensions, pii, messages);
    const result = await this.host.execute(model, sent, false, signal);
    if (config.type !== "escalation" || state.escalation.snapshot().latched) return this.withDecision(result, decisionId);
    const request = buildEscalationJudgeRequest(normalizeConversation([...messages, result.message]), signals.assistantTurnCount + 1);
    const answer = await this.judge(config.judge ?? capable, [{ role: "system", content: request.systemPrompt }, ...request.messages], pii, signal, request.maxOutputTokens);
    const verdict = answer ? parseEscalationVerdict(answer) : undefined;
    if (answer && !verdict) this.judgeOffUntil = Date.now() + 5 * 60_000;
    const snapshot = state.escalation.apply(verdict, config.confirmations ?? 2);
    if (snapshot.latched) { try { this.labels.setLatched(labelTurn, true); } catch { /* optional labels */ } }
    if (!snapshot.latched || signal.aborted) return this.withDecision(result, decisionId);
    // The discarded efficient response is not inserted into history or executed as a tool batch.
    decisionId = this.emitRoute({ route, tier: capable, source: "classifier", score: 0, ms: performance.now() - started }, labelTurn, dimensions, pii, messages);
    return this.withDecision(await this.host.execute(capable, messages, false, signal), decisionId);
  }

  /** Reviews held no-tool responses. A redo is fed into the same local turn and bounded by its normal step cap. */
  async review(route: string, config: HubRoute, messages: ChatMessage[], scope: string, pii: boolean, signal: AbortSignal, decisionId?: string): Promise<string | undefined> {
    if (config.type !== "advisor") return undefined;
    const state = this.state(route, config, scope), conversation = normalizeConversation(messages);
    const latest = messages.at(-1);
    if (!state.advisor.shouldReview(conversation, { hasToolUse: !!latest?.tool_calls?.length, visibleText: latest?.content ?? "" }, scope) || !state.advisor.reserve(scope)) return undefined;
    const request = buildAdvisorJudgeRequest(conversation, latest?.content ?? undefined, config.transcript_max_chars);
    const answer = await this.judge(config.judge ?? config.capable ?? "coding", [{ role: "system", content: request.systemPrompt }, ...request.messages], pii, signal, request.maxOutputTokens);
    const verdict = answer ? parseAdvisorVerdict(answer) : undefined;
    state.advisor.settle(scope, verdict ? "success" : "failure");
    try { this.labels.observeAdvisor(decisionId, verdict?.kind ?? "failed"); } catch { /* optional labels */ }
    if (answer && !verdict) this.judgeOffUntil = Date.now() + 5 * 60_000;
    try { this.host.onAdvisor?.({ route, trigger: config.trigger ?? "no_tool_call", verdict: verdict?.kind ?? "failed", discardedChars: Math.max(0, [...JSON.stringify(conversation.messages)].length - (config.transcript_max_chars ?? 200_000)) }); } catch { /* optional telemetry */ }
    return verdict?.kind === "redo" ? redoFeedback(verdict, latest?.content ?? "").user : undefined;
  }

  private withDecision(result: ChatResult, decisionId: string | undefined): ChatResult {
    return decisionId ? { ...result, routeDecision: decisionId } : result;
  }

  private emitRoute(event: RouteEvent, turn: ReturnType<RouteLabelTracker["captureTurn"]>, dimensions: ReturnType<typeof dimensionsFromSignal>, pii: boolean, priorMessages: ChatMessage[]): string | undefined {
    if (turn && turn.closed) return undefined;
    let decision: string | undefined;
    try {
      decision = this.labels.addDecision(turn, {
        severity: dimensions.severity,
        spinning: dimensions.spinning,
        exploring: dimensions.exploring,
        production: dimensions.productionIntensity,
      }, priorMessages);
    } catch { /* model inputs cannot fail routing through telemetry */ }
    const labeled: RouteEvent = decision ? {
      ...event,
      decision,
      turn: turn!.context.turn,
      ...(turn!.context.task === undefined ? {} : { task: turn!.context.task }),
      pii: turn!.context.pii,
      severity: dimensions.severity,
      spinning: dimensions.spinning,
      exploring: dimensions.exploring,
      production: dimensions.productionIntensity,
    } : event;
    try { this.host.onRoute?.(labeled); } catch { /* optional telemetry */ }
    return decision;
  }

  private async judge(model: string, messages: ChatMessage[], pii: boolean, parent: AbortSignal, maxTokens = 2048): Promise<string | undefined> {
    if (parent.aborted || Date.now() < this.judgeOffUntil) return undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    parent.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = async (): Promise<string | undefined> => {
      if (pii && !(await this.host.onCampus())) return undefined;
      if (controller.signal.aborted) return undefined;
      const result = await this.host.execute(model, messages, true, controller.signal, maxTokens);
      return result.message.content?.trim() || undefined;
    };
    try {
      const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(undefined); }, this.judgeTimeoutMs); });
      const result = await Promise.race([work(), timeout]);
      if (!result && !parent.aborted) this.judgeOffUntil = Date.now() + 5 * 60_000;
      return result;
    } catch { if (!parent.aborted) this.judgeOffUntil = Date.now() + 5 * 60_000; return undefined; }
    finally { clearTimeout(timer); parent.removeEventListener("abort", abort); }
  }
}
