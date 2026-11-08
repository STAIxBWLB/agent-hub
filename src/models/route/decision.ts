import { createHash } from "node:crypto";
import { requestAdecRoute, type AdecResult, type AdecFailure, type AdecReason } from "./adec.ts";
import { buildDecisionEvidence } from "./decision-evidence.ts";
import type { HubRoute } from "./config.ts";
import type { ChatMessage } from "../../omniroute/client.ts";
import type { RouteLabelTracker } from "./labels.ts";
import { estimateInputTokens, type CodingAgentDimensions } from "./stage.ts";
import { SessionState } from "./state.ts";

export interface DecisionHost {
  onCampus: () => Promise<boolean>;
  /** Current host facts, never inferred from model text. */
  decisionContext?: () => { pii?: boolean; private: boolean; excluded: boolean };
  publicDecisionText?: (text: string) => boolean;
  admitDecision?: () => Promise<void>;
  onDecisionIssue?: (reason: AdecFailure | AdecReason) => void;
}
export interface DecisionTrace {
  decisionMode: "off" | "shadow";
  chosenAlias: string | null; chosenEffort: string | null; margin?: number; decisionLatencyMs?: number;
  decisionReason?: string; fallbackApplied?: boolean;
  decider?: { provider: string; model: string; version?: string; latencyMs: number } | null;
}
interface Context {
  route: string; scope: string; turn: ReturnType<RouteLabelTracker["captureTurn"]>;
  current(): boolean; messages: ChatMessage[]; dimensions: CodingAgentDimensions; pii: boolean; signal: AbortSignal;
}
interface Privacy { pii: boolean; private: boolean; excluded: boolean }
interface Selection { trace?: DecisionTrace; check?(): void }
type Attempt = { result: AdecResult; privacy: Privacy } | { skipped: string };
export class DecisionPolicyChangedError extends Error {
  constructor() { super("decision routing privacy or observer policy changed or is unavailable during preparation; run ahub status, inspect current task policy and retry"); }
}
interface State { fingerprint: string; failure?: { turn: string; result: AdecResult } }
const ended = () => new Error("model route turn ended before execution; retry in the current turn");

/** Optional decision work never changes the baseline on failure; valid pins/rules remain owned by adec. */
export class DecisionRouteController {
  private readonly states = new SessionState<State>();
  private readonly issues = new SessionState<{ fingerprint: string; reason: AdecFailure | AdecReason | null }>();
  constructor(private readonly host: DecisionHost, private readonly timeoutMs: number) {}
  checkEntry(config: HubRoute, pii: boolean): void {
    if (config.type !== "decision" || (config.decision_mode ?? "off") === "off") return;
    const current = this.privacy(pii);
    if ((current.pii || current.private) && !pii) throw new DecisionPolicyChangedError();
  }
  async pick(config: HubRoute, context: Context): Promise<Selection> {
    if (config.type !== "decision" || (config.decision_mode ?? "off") === "off") { this.issues.delete(context.route); return {}; }
    if (context.signal.aborted || context.turn?.closed) throw ended();
    const privacy = this.privacy(context.pii);
    const checked = (selection: Selection): Selection => {
      this.fence(context, privacy);
      return { ...selection, check: () => { this.fence(context, privacy); selection.check?.(); } };
    };
    try { return checked(await this.select(config, context)); }
    catch (error) {
      if (context.signal.aborted || context.turn?.closed) throw ended();
      this.fence(context, privacy); // a rejected await is still an authority boundary
      if (error instanceof DecisionPolicyChangedError || error && typeof error === "object" && "budgetStop" in error) throw error;
      return checked(this.skip(config, "unavailable"));
    }
  }
  private issue(config: HubRoute, context: Context, reason: AdecFailure | AdecReason | null): void {
    const fingerprint = JSON.stringify(config), previous = this.issues.get(context.route);
    if (previous?.fingerprint === fingerprint && previous.reason === reason) return;
    this.issues.set(context.route, { fingerprint, reason });
    if (reason !== null) { try { this.host.onDecisionIssue?.(reason); } catch { /* diagnostics cannot change shadow routing */ } }
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
  /** Recheck after the async pick resolves, before its fields reach execution or telemetry. */
  confirm(selection: Selection): Selection {
    selection.check?.(); return selection;
  }
  private privacy(pii: boolean): Privacy {
    try {
      const current = this.host.decisionContext?.() ?? { private: pii, excluded: false };
      if (typeof current.private !== "boolean" || typeof current.excluded !== "boolean" || current.pii !== undefined && typeof current.pii !== "boolean") throw new DecisionPolicyChangedError();
      return { pii: pii || current.pii === true, private: current.private, excluded: current.excluded };
    } catch { throw new DecisionPolicyChangedError(); }
  }
  private same(a: Privacy, b: Privacy): boolean { return a.pii === b.pii && a.private === b.private && a.excluded === b.excluded; }
  private fence(context: Context, privacy: Privacy): void {
    if (!context.current()) throw ended();
    try { if (this.same(privacy, this.privacy(context.pii))) return; } catch { /* unavailable current facts refuse the handoff */ }
    throw new DecisionPolicyChangedError();
  }
  private async select(config: HubRoute, context: Context): Promise<Selection> {
    const { turn } = context;
    if (!turn) return this.skip(config, "turn_unavailable");
    const privacy = this.privacy(context.pii);
    if (privacy.excluded) return this.skip(config, "observer_excluded");
    // A newly private board context is not permission to reuse a public delivery's text.
    if ((privacy.pii || privacy.private) && !context.pii) throw new DecisionPolicyChangedError();
    const state = this.state(config, context), key = createHash("sha256").update(JSON.stringify([context.route, context.scope, turn.context.turn])).digest("hex");
    const began = performance.now();
    const attempt: Attempt = state.failure?.turn === key ? { result: state.failure.result, privacy } : await this.request(config, context, privacy, state, key);
    if (!context.current()) throw ended();
    if ("skipped" in attempt) return this.skip(config, attempt.skipped);
    this.fence(context, attempt.privacy);
    const result = attempt.result;
    if (!result.ok) { this.issue(config, context, result.reason); return { trace: { decisionMode: config.decision_mode ?? "off", chosenAlias: null, chosenEffort: null, decisionReason: result.reason, decisionLatencyMs: Math.max(0, performance.now() - began) } }; }
    const d = result.decision;
    this.issue(config, context, d.alias === null || d.fallbackApplied ? d.reason : null);
    let decider: DecisionTrace["decider"];
    if (d.decider === null) decider = null;
    else if (this.host.publicDecisionText?.(JSON.stringify(d.decider)) === true) decider = { provider: d.decider.provider, model: d.decider.model, latencyMs: d.decider.latencyMs, ...(d.decider.version === undefined ? {} : { version: d.decider.version }) };
    this.fence(context, attempt.privacy);
    return { check: () => this.fence(context, attempt.privacy),
      trace: { decisionMode: config.decision_mode ?? "off", chosenAlias: d.alias, chosenEffort: d.effort, margin: d.margin,
        decisionLatencyMs: Math.max(0, performance.now() - began), decisionReason: d.reason, fallbackApplied: d.fallbackApplied,
        ...(decider === undefined ? {} : { decider }) } };
  }
  private async request(config: HubRoute, context: Context, initial: Privacy, state: State, key: string): Promise<Attempt> {
    await this.host.admitDecision?.();
    if (!context.current()) throw ended();
    const privacy = this.privacy(context.pii);
    if (!this.same(initial, privacy)) throw new DecisionPolicyChangedError();
    const campus = privacy.pii || privacy.private ? await this.host.onCampus() === true : true;
    this.fence(context, privacy);
    if (!campus) return { skipped: "off_campus" };
    const sensitive = privacy.pii || privacy.private;
    const evidence = buildDecisionEvidence(sensitive ? [] : context.messages, context.dimensions, text => this.host.publicDecisionText?.(text) === true);
    const pairs = config.candidates?.flatMap(candidate => candidate.efforts.map(effort => ({ alias: candidate.alias, effort }))) ?? [];
    this.fence(context, privacy);
    const result = await requestAdecRoute(config.adec_endpoint ?? "http://127.0.0.1:8740/v1/route", {
      policyId: config.policy_id ?? "", turnId: `ahub:${key}`, evidence,
      constraints: { contextTokens: sensitive ? 0 : estimateInputTokens(context.messages), pii: privacy.pii, private: privacy.private },
      candidates: [...new Set(pairs.map(pair => pair.alias))],
    }, pairs, context.signal, config.decision_timeout_ms ?? this.timeoutMs);
    this.fence(context, privacy);
    // Only failed transports are held locally, never a valid pin: the service rechecks current hard rules.
    if (!result.ok) state.failure = { turn: key, result };
    return { result, privacy };
  }
}
