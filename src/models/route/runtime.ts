import { DecisionRouteController, type DecisionHost, type DecisionTrace, type DecisionSelection, DecisionPolicyChangedError } from "./decision.ts";
import type { ChatMessage, ChatResult } from "../../omniroute/client.ts";
import { AdvisorTrigger } from "./advisor-trigger.ts";
import { buildAdvisorRequest, buildEscalationRequest, planningInstruction, redoFeedback } from "./hub-prompts.ts";
import { captureJudgeConversation, captureRouteView } from "./conversation-view.ts";
import { parseAdvisorReply, parseEscalationReply } from "./judge-replies.ts";
import { runHostJudge, type HostChoicePurpose } from "./judge-choice.ts";
import type { HubRoute } from "./config.ts";
import { RouteLabelTracker, type RouteLabelEvent, type RouteTurnContext, type RouteTurnOutcome } from "./labels.ts";
import { captureStageInput, estimateStageInputTokens } from "./stage-input.ts";
import { buildStageEvidence, type CodingAgentDimensions, type StageEvidence } from "./stage-evidence.ts";
import { selectFallbackStage, planStageSwitch, ambiguousStage, type FallbackStageState, type StaySwitchPolicy, type StageSwitchTrace as SwitchTrace, type StageTier as Tier } from "./stage-fallback.ts";
import { EscalationControl } from "./escalation-control.ts";
import { ScopeStore } from "./turn-state.ts";
import { PlanPhase } from "./plan-execute-choice.ts";

export interface RouteEvent extends Partial<SwitchTrace>, Partial<DecisionTrace> {
  decisionTarget?: "judge";
  route: string; tier: string; source: "override" | "dimensions" | "hold" | "classifier" | "default" | "decision"; score: number; ms: number;
  decision?: string; turn?: string; task?: number; pii?: boolean; severity?: number; spinning?: number; exploring?: number; production?: number;
}
export interface AdvisorEvent { route: string; trigger: string; verdict: "approve" | "redo" | "failed"; discardedChars: number }
interface RouteState { fingerprint: string; stage: FallbackStageState; pin?: Tier; plan: PlanPhase; escalation: EscalationControl; advisor: AdvisorTrigger }
export interface RouteHost extends DecisionHost {
  execute: (model: string, messages: ChatMessage[], judge: boolean, signal: AbortSignal, maxTokens?: number) => Promise<ChatResult>;
  /** Read on every stage call (#197); absent is the shadow default. */
  staySwitch?: () => StaySwitchPolicy | undefined;
  onRoute?: (event: RouteEvent) => void;
  onRouteOutcome?: (event: RouteLabelEvent) => void;
  onAdvisor?: (event: AdvisorEvent) => void;
}
/** Internal model-free proof only; no choice data or authority is exposed. */
export interface RouteProofPorts { choicePrepared?(ready: Promise<void>): void }

/** Transport stays in the host. Optional judge work has one deadline and five-minute failure backoff. */
export class HubRouteRuntime {
  private readonly states = new ScopeStore<RouteState>();
  private readonly labels: RouteLabelTracker;
  private readonly decisions: DecisionRouteController;
  private judgeOffUntil = 0;
  constructor(private readonly host: RouteHost, private readonly judgeTimeoutMs = 8000, private readonly proof?: RouteProofPorts) {
    this.decisions = new DecisionRouteController(host, judgeTimeoutMs);
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
    const value: RouteState = { fingerprint, stage: { recoveryHoldRemaining: 0 }, plan: new PlanPhase(), escalation: new EscalationControl(), advisor: new AdvisorTrigger({ trigger: config.trigger, pattern: config.pattern, maxReviews: config.max_reviews, gateStallTurns: config.gate_stall_turns, gateMinToolResults: config.gate_min_tool_results }) };
    this.states.set(key, value); return value;
  }

  /** Executor failures retry the fixed model only in the caller; no tool has run yet. */
  async call(route: string, config: HubRoute, messages: ChatMessage[], scope: string, pii: boolean, signal: AbortSignal): Promise<ChatResult> {
    const labelTurn = this.labels.captureTurn();
    this.decisions.checkEntry(config, pii);
    const started = performance.now(), state = this.state(route, config, scope);
    const input = captureStageInput(messages) ?? { turn: "other" as const, incomplete: true, assistantTurns: 0, results: [] };
    const evidence = buildStageEvidence(input), dimensions = evidence.dimensions;
    const efficient = config.efficient ?? "fast", capable = config.capable ?? "coding";
    let model = efficient, source: RouteEvent["source"] = "default", score = 0;
    let sent = messages, trace: Partial<SwitchTrace> = {};
    let phase: "planning" | "executing" | undefined;
    if (config.type === "stage" || config.type === "decision") {
      const decision = selectFallbackStage(evidence, { confidenceThreshold: config.confidence_threshold, holdTurns: config.hold_turns }, state.stage);
      state.stage = decision.state;
      // Public planner sizing is separate from local full-context admission. Sensitive size is omitted.
      const staged = planStageSwitch(this.host.staySwitch?.(), state.pin, decision, input.turn, { inputTokens: pii ? undefined : estimateStageInputTokens(messages), fits: () => true });
      state.pin = staged.pin;
      const { prefillTokens, ...shape } = staged.trace;
      trace = pii ? shape : staged.trace;
      model = staged.tier === "capable" ? capable : efficient;
      score = decision.score;
      source = decision.source;
      if (config.type === "stage" && config.classifier === "decision" && ambiguousStage(decision, { confidenceThreshold: config.confidence_threshold, ambiguousBand: config.ambiguous_band })) {
        // The band decides only whether adec is asked; the tier and model above stay exactly as the heuristic chose them.
        trace = { ...trace, ...await this.decisions.shadowClassify(config, { route, scope, turn: labelTurn, messages, evidence, pii, signal, tier: staged.tier,
          current: () => !signal.aborted && !labelTurn?.closed && this.labels.captureTurn() === labelTurn }) };
      }
    } else if (config.type === "plan_execute") {
      const decision = state.plan.observe(captureRouteView(messages), scope);
      phase = decision.phase;
      model = decision.fallbackTier === "capable" ? capable : efficient;
      if (decision.addPlanningInstruction) sent = [{ role: "system", content: planningInstruction }, ...messages];
    } else if (config.type === "escalation" && state.escalation.snapshot().latched) model = capable;
    const current = () => !signal.aborted && !labelTurn?.closed && this.labels.captureTurn() === labelTurn;
    let phaseGuard: ReturnType<DecisionRouteController["captureGuard"]> | undefined;
    let proposed: DecisionSelection = {};
    if (config.type === "decision") proposed = await this.decisions.pick(config, { route, scope, turn: labelTurn, messages, dimensions, pii, signal, current });
    else if (config.type === "plan_execute" && config.decision_backend === "adec" && (config.decision_mode ?? "off") === "shadow") {
      phaseGuard = this.decisions.captureGuard(pii, current);
      const timeout = config.decision_timeout_ms ?? this.judgeTimeoutMs;
      const window = this.decisions.openHostChoice(config, { route, scope, turn: labelTurn, messages, evidence, pii, signal, current,
        purpose: "plan_execute_model", phase, deadline: performance.now() + timeout });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (window) {
          timer = setTimeout(() => { void window.close().catch(() => {}); }, timeout);
          proposed = await window.result ?? {};
        }
      } finally { clearTimeout(timer); await window?.close(); }
      phaseGuard();
    }
    const picked = this.decisions.confirm(proposed);
    source = picked.trace ? "decision" : source;
    let decisionId = this.emitRoute({ route, tier: model, source, score, ms: performance.now() - started, ...trace, ...picked?.trace }, labelTurn, dimensions, pii, messages);
    const result = await this.host.execute(model, sent, false, signal);
    phaseGuard?.("executor reply");
    if (config.type !== "escalation" || state.escalation.snapshot().latched) return this.withDecision(result, decisionId);
    const conversation = captureJudgeConversation([...messages, result.message]);
    const request = buildEscalationRequest(conversation, conversation?.assistantTurns ?? 0);
    const answer = request ? await this.judge(config.judge ?? capable, [{ role: "system", content: request.systemPrompt }, ...request.messages], pii, signal, request.maxOutputTokens,
      { route, config, scope, turn: labelTurn, messages, evidence, purpose: "escalation_judge_model", current }) : undefined;
    const verdict = answer ? parseEscalationReply(answer) : undefined;
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
    const turn = this.labels.captureTurn(), current = () => !signal.aborted && !turn?.closed && this.labels.captureTurn() === turn;
    const guard = this.decisions.captureGuard(pii, current);
    const state = this.state(route, config, scope), conversation = captureJudgeConversation(messages), latest = messages.at(-1);
    if (!state.advisor.eligible(conversation, { hasToolUse: !!latest?.tool_calls?.length, visibleText: latest?.content ?? "" }, scope) || !state.advisor.reserve(scope)) return undefined;
    let settled = false;
    try {
      const request = buildAdvisorRequest(conversation, latest?.content ?? undefined, config.transcript_max_chars);
      const input = captureStageInput(messages) ?? { turn: "other" as const, incomplete: true, assistantTurns: 0, results: [] };
      const answer = request ? await this.judge(config.judge ?? config.capable ?? "coding", [{ role: "system", content: request.systemPrompt }, ...request.messages], pii, signal, request.maxOutputTokens,
        { route, config, scope, turn, messages, evidence: buildStageEvidence(input), purpose: "advisor_judge_model", current }) : undefined;
      guard("advisor reply");
      const verdict = answer ? parseAdvisorReply(answer) : undefined;
      state.advisor.settle(scope, verdict ? "success" : "failure"); settled = true;
      try { this.labels.observeAdvisor(decisionId, verdict?.kind ?? "failed"); } catch { /* optional telemetry */ }
      if (answer && !verdict) this.judgeOffUntil = Date.now() + 5 * 60_000;
      guard("advisor publication");
      try { this.host.onAdvisor?.({ route, trigger: config.trigger ?? "no_tool_call", verdict: verdict?.kind ?? "failed", discardedChars: request?.discardedChars ?? 0 }); }
      catch (error) { if (error instanceof DecisionPolicyChangedError) throw error; }
      guard("advisor publication");
      return verdict?.kind === "redo" ? redoFeedback(verdict, latest?.content ?? "").user : undefined;
    } finally { if (!settled) state.advisor.settle(scope, "failure"); }
  }

  private withDecision(result: ChatResult, decisionId: string | undefined): ChatResult {
    return decisionId ? { ...result, routeDecision: decisionId } : result;
  }

  private emitRoute(event: RouteEvent, turn: ReturnType<RouteLabelTracker["captureTurn"]>, dimensions: CodingAgentDimensions, pii: boolean, priorMessages: ChatMessage[]): string | undefined {
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

  private async judge(model: string, messages: ChatMessage[], pii: boolean, parent: AbortSignal, maxTokens = 2048,
    choice?: { route: string; config: HubRoute; scope: string; turn: ReturnType<RouteLabelTracker["captureTurn"]>; messages: ChatMessage[]; evidence: StageEvidence; purpose: HostChoicePurpose; current(): boolean }): Promise<string | undefined> {
    if (parent.aborted || Date.now() < this.judgeOffUntil) return undefined;
    const current = choice?.current ?? (() => !parent.aborted), guard = this.decisions.captureGuard(pii, current);
    const began = performance.now(), deadline = began + this.judgeTimeoutMs;
    try {
      const result = await runHostJudge<string, DecisionSelection>({
        parent, timeoutMs: this.judgeTimeoutMs, current: guard,
        common: async signal => {
          const campus = pii ? await this.host.onCampus() === true : true;
          if (signal.aborted) return false;
          guard(); return campus;
        },
        fallback: async signal => {
          guard();
          const result = await this.host.execute(model, messages, true, signal, maxTokens);
          return result.message.content?.trim() || undefined;
        },
        observe: signal => {
          const window = choice ? this.decisions.openHostChoice(choice.config, { route: choice.route, scope: choice.scope,
            turn: choice.turn, current: choice.current, messages: choice.messages, evidence: choice.evidence, pii, signal,
            purpose: choice.purpose, deadline }) : undefined;
          try {
            const notify = this.proof?.choicePrepared;
            if (window && notify) {
              const ready = window.result.then(() => undefined);
              void ready.catch(() => {});
              notify.call(this.proof, ready);
            }
          } catch { /* proof sinks have no authority; the original result is still awaited below */ }
          return window;
        },
      });
      guard("judge result");
      const observed = this.decisions.confirm(result.observation ?? {});
      if (observed.trace && choice) {
        guard("observation publication");
        // Metadata only: never enter emitRoute/addDecision, label, progress or usage paths.
        try { this.host.onRoute?.({ route: choice.route, tier: model, source: "default", score: 0,
          ms: Math.max(0, performance.now() - began), ...observed.trace, decisionTarget: "judge" }); }
        catch (error) { if (error instanceof DecisionPolicyChangedError) throw error; }
        guard("observation publication");
      }
      if (!result.value && !parent.aborted) this.judgeOffUntil = Date.now() + 5 * 60_000;
      return result.value;
    } catch (error) {
      if (error instanceof DecisionPolicyChangedError || error && typeof error === "object" && "budgetStop" in error) throw error;
      if (!parent.aborted) this.judgeOffUntil = Date.now() + 5 * 60_000;
      return undefined;
    }
  }
}
