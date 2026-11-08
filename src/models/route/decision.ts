import { createHash } from "node:crypto";
import { requestAdecRoute, type AdecPair, type AdecResult } from "./adec.ts";
import { buildDecisionEvidence } from "./decision-evidence.ts";
import type { HubRoute } from "./config.ts";
import type { ChatMessage } from "../../omniroute/client.ts";
import type { RouteLabelTracker } from "./labels.ts";
import { estimateInputTokens, type CodingAgentDimensions } from "./stage.ts";
import { SessionState } from "./state.ts";

export interface DecisionHost {
  onCampus: () => Promise<boolean>;
  /** Current host facts, never inferred from model text. */
  decisionContext?: () => { private: boolean; excluded: boolean };
  publicDecisionText?: (text: string) => boolean;
  admitDecision?: () => Promise<void>;
}
export interface DecisionTrace {
  decisionMode: "off" | "shadow" | "enforce";
  chosenAlias: string | null; chosenEffort: string | null; margin?: number; decisionLatencyMs?: number;
  decisionReason?: string; fallbackApplied?: boolean;
  decider?: { provider: string; model: string; latencyMs: number } | null;
}
interface Context {
  route: string; scope: string; turn: ReturnType<RouteLabelTracker["captureTurn"]>;
  current(): boolean; messages: ChatMessage[]; dimensions: CodingAgentDimensions; pii: boolean; signal: AbortSignal;
}
interface Selection { apply?: AdecPair; trace?: DecisionTrace; applied?(): void }
interface State { fingerprint: string; failure?: { turn: string; result: AdecResult }; currentPair?: { turn: string; pair: AdecPair } }
const ended = () => new Error("model route turn ended before execution; retry in the current turn");

/** Optional decision work never changes the baseline on failure; valid pins/rules remain owned by adec. */
export class DecisionRouteController {
  private readonly states = new SessionState<State>();
  constructor(private readonly host: DecisionHost, private readonly timeoutMs: number) {}
  async pick(config: HubRoute, context: Context): Promise<Selection> {
    if (config.type !== "decision" || (config.decision_mode ?? "off") === "off") return {};
    if (context.signal.aborted || context.turn?.closed) throw ended();
    try { return await this.select(config, context); }
    catch (error) {
      if (context.signal.aborted || context.turn?.closed) throw ended();
      if (error && typeof error === "object" && "budgetStop" in error) throw error;
      return this.skip(config, "unavailable");
    }
  }
  private skip(config: HubRoute, reason: string): Selection {
    return { trace: { decisionMode: config.decision_mode ?? "off", chosenAlias: null, chosenEffort: null, decisionReason: reason } };
  }
  private state(config: HubRoute, context: Context): State {
    const key = JSON.stringify([context.route, context.scope]), fingerprint = JSON.stringify(config);
    const prior = this.states.get(key);
    if (prior?.fingerprint === fingerprint) return prior;
    const state: State = { fingerprint }; this.states.set(key, state); return state;
  }
  private async select(config: HubRoute, context: Context): Promise<Selection> {
    const { turn, pii } = context;
    if (!turn) return this.skip(config, "turn_unavailable");
    const privacy = this.host.decisionContext?.() ?? { private: pii, excluded: false };
    if (privacy.excluded) return this.skip(config, "observer_excluded");
    if ((pii || privacy.private) && !(await this.host.onCampus())) return this.skip(config, "off_campus");
    if (!context.current()) throw ended();
    const state = this.state(config, context), key = createHash("sha256").update(JSON.stringify([context.route, context.scope, turn.context.turn])).digest("hex");
    const began = performance.now();
    const result = state.failure?.turn === key ? state.failure.result : await this.request(config, context, privacy.private, state, key);
    if (!context.current()) throw ended();
    if (!result.ok) return { trace: { decisionMode: config.decision_mode ?? "off", chosenAlias: null, chosenEffort: null, decisionReason: result.reason, decisionLatencyMs: Math.max(0, performance.now() - began) } };
    const d = result.decision, apply = config.decision_mode === "enforce" && d.alias !== null && d.effort !== null ? { alias: d.alias, effort: d.effort } : undefined;
    let decider: DecisionTrace["decider"];
    if (d.decider === null) decider = null;
    else if (this.host.publicDecisionText?.(JSON.stringify(d.decider)) === true) decider = { provider: d.decider.provider, model: d.decider.model, latencyMs: d.decider.latencyMs };
    return { ...(apply ? { apply } : {}), applied: () => { if (context.current()) state.currentPair = apply ? { turn: turn.context.turn, pair: apply } : undefined; },
      trace: { decisionMode: config.decision_mode ?? "off", chosenAlias: d.alias, chosenEffort: d.effort, margin: d.margin,
        decisionLatencyMs: Math.max(0, performance.now() - began), decisionReason: d.reason, fallbackApplied: d.fallbackApplied,
        ...(decider === undefined ? {} : { decider }) } };
  }
  private async request(config: HubRoute, context: Context, privateTurn: boolean, state: State, key: string): Promise<AdecResult> {
    await this.host.admitDecision?.();
    if (!context.current()) throw ended();
    const sensitive = context.pii || privateTurn;
    const evidence = buildDecisionEvidence(sensitive ? [] : context.messages, context.dimensions, text => this.host.publicDecisionText?.(text) === true);
    const pairs = config.candidates?.flatMap(candidate => candidate.efforts.map(effort => ({ alias: candidate.alias, effort }))) ?? [];
    const result = await requestAdecRoute(config.adec_endpoint ?? "http://127.0.0.1:8740/v1/route", {
      policyId: config.policy_id ?? "", turnId: `ahub:${key}`, evidence,
      constraints: { contextTokens: sensitive ? 0 : estimateInputTokens(context.messages), pii: context.pii, private: privateTurn,
        ...(state.currentPair?.turn === context.turn?.context.turn ? { current: state.currentPair!.pair } : {}) },
      candidates: [...new Set(pairs.map(pair => pair.alias))],
    }, pairs, context.signal, config.decision_timeout_ms ?? this.timeoutMs);
    // Only failed transports are held locally, never a valid pin: the service rechecks current hard rules.
    if (!result.ok) state.failure = { turn: key, result };
    return result;
  }
}
