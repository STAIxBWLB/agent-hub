import { createHash } from "node:crypto";
import { requestAdecRoute, type AdecPair, type AdecResult, type AdecFailure, type AdecReason } from "./adec.ts";
import { buildDecisionEvidence } from "./decision-evidence.ts";
import type { HubRoute } from "./config.ts";
import type { ChatMessage } from "../../omniroute/client.ts";
import type { RouteLabelTracker } from "./labels.ts";
import { estimateInputTokens } from "./stage-input.ts";
import type { CodingAgentDimensions, StageEvidence } from "./stage-evidence.ts";
import type { StageTier } from "./stage-fallback.ts";
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
/** What one stage classification needs: bounded evidence instead of a conversation projection. */
export interface StageClassifyContext {
  route: string; scope: string; turn: ReturnType<RouteLabelTracker["captureTurn"]>;
  current(): boolean; messages: ChatMessage[]; evidence: StageEvidence; pii: boolean; signal: AbortSignal; tier: StageTier;
}
/** A purpose scopes the per-turn memo so one route type cannot read another's held answer. */
export type DecisionPurpose = "stage" | "decision";
interface Options { pairs: AdecPair[]; candidates: string[]; current?: AdecPair }
interface Privacy { pii: boolean; private: boolean; excluded: boolean }
interface Selection { trace?: DecisionTrace; check?(): void }
type Attempt = { result: AdecResult; privacy: Privacy } | { skipped: string };
export class DecisionPolicyChangedError extends Error {
  constructor() { super("decision routing privacy or observer policy changed or is unavailable during preparation; run ahub status, inspect current task policy and retry"); }
}
interface State { fingerprint: string; failure?: { turn: string; result: AdecResult }; held?: { turn: string; trace: Partial<DecisionTrace> } }
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
    try { return checked(await this.select(config, context, "decision", this.decisionOptions(config))); }
    catch (error) {
      if (context.signal.aborted || context.turn?.closed) throw ended();
      this.fence(context, privacy); // a rejected await is still an authority boundary
      if (error instanceof DecisionPolicyChangedError || error && typeof error === "object" && "budgetStop" in error) throw error;
      return checked(this.skip(config, "unavailable"));
    }
  }
  /** Shadow only: the answer is recorded as a route event, and no tier is returned, so it cannot change routing. */
  async shadowClassify(config: HubRoute, context: StageClassifyContext): Promise<Partial<DecisionTrace>> {
    if (config.type !== "stage" || config.classifier !== "decision" || (config.decision_mode ?? "off") === "off") { this.issues.delete(context.route); return {}; }
    const options = this.stageOptions(config, context.tier);
    if (!options) return {};
    const inner: Context = { route: context.route, scope: context.scope, turn: context.turn, current: context.current,
      messages: context.messages, dimensions: context.evidence.dimensions, pii: context.pii, signal: context.signal };
    // An optional stage question never refuses a turn: the heuristic tier already stands, so a refusal records nothing to apply.
    if (inner.signal.aborted || inner.turn?.closed) return {};
    const state = this.state(config, inner, "stage"), key = this.turnKey("stage", inner);
    // One question per user turn, kept through the tool loop, exactly like the #197 pin rule.
    if (state.held?.turn === key) return state.held.trace;
    try {
      const trace = (await this.select(config, inner, "stage", options)).trace ?? {};
      state.held = { turn: key, trace };
      return trace;
    }
    catch (error) {
      // Changed or unavailable authority is not a service failure: it keeps refusing the stale turn, exactly as on a
      // decision route, instead of becoming a model fallback around that refusal. A closed turn only moots the question.
      if (error instanceof DecisionPolicyChangedError || error && typeof error === "object" && "budgetStop" in error) throw error;
      if (inner.signal.aborted || inner.turn?.closed) return {};
      const trace = this.skip(config, "unavailable").trace ?? {};
      state.held = { turn: key, trace };
      return trace;
    }
  }
  private turnKey(purpose: DecisionPurpose, context: Context): string {
    return createHash("sha256").update(JSON.stringify([purpose, context.route, context.scope, context.turn?.context.turn])).digest("hex");
  }
  private decisionOptions(config: HubRoute): Options {
    const pairs = config.candidates?.flatMap(candidate => candidate.efforts.map(effort => ({ alias: candidate.alias, effort }))) ?? [];
    return { pairs, candidates: [...new Set(pairs.map(pair => pair.alias))] };
  }
  /** A tier carries no effort, so both offerings use "none" and the answer maps back by alias equality. */
  private stageOptions(config: HubRoute, tier: StageTier): Options | undefined {
    const efficient = config.efficient, capable = config.capable;
    if (!efficient || !capable || efficient === capable) return undefined;
    const efficientPair: AdecPair = { alias: efficient, effort: "none" }, capablePair: AdecPair = { alias: capable, effort: "none" };
    return { pairs: [efficientPair, capablePair], candidates: [efficient, capable], current: tier === "capable" ? capablePair : efficientPair };
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
  private state(config: HubRoute, context: Context, purpose: DecisionPurpose): State {
    const key = JSON.stringify([purpose, context.route, context.scope]), fingerprint = JSON.stringify(config);
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
  private async select(config: HubRoute, context: Context, purpose: DecisionPurpose, options: Options): Promise<Selection> {
    const { turn } = context;
    if (!turn) return this.skip(config, "turn_unavailable");
    const privacy = this.privacy(context.pii);
    if (privacy.excluded) return this.skip(config, "observer_excluded");
    // A newly private board context is not permission to reuse a public delivery's text.
    if ((privacy.pii || privacy.private) && !context.pii) throw new DecisionPolicyChangedError();
    const state = this.state(config, context, purpose), key = this.turnKey(purpose, context);
    const began = performance.now();
    const attempt: Attempt = state.failure?.turn === key ? { result: state.failure.result, privacy } : await this.request(config, context, privacy, state, key, options);
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
  private async request(config: HubRoute, context: Context, initial: Privacy, state: State, key: string, options: Options): Promise<Attempt> {
    await this.host.admitDecision?.();
    if (!context.current()) throw ended();
    const privacy = this.privacy(context.pii);
    if (!this.same(initial, privacy)) throw new DecisionPolicyChangedError();
    const campus = privacy.pii || privacy.private ? await this.host.onCampus() === true : true;
    this.fence(context, privacy);
    if (!campus) return { skipped: "off_campus" };
    const sensitive = privacy.pii || privacy.private;
    const evidence = buildDecisionEvidence(sensitive ? [] : context.messages, context.dimensions, text => this.host.publicDecisionText?.(text) === true);
    this.fence(context, privacy);
    const result = await requestAdecRoute(config.adec_endpoint ?? "http://127.0.0.1:8740/v1/route", {
      policyId: config.policy_id ?? "", turnId: `ahub:${key}`, evidence,
      constraints: { contextTokens: sensitive ? 0 : estimateInputTokens(context.messages), pii: privacy.pii, private: privacy.private,
        ...(options.current === undefined ? {} : { current: options.current }) },
      candidates: options.candidates,
    }, options.pairs, context.signal, config.decision_timeout_ms ?? this.timeoutMs);
    this.fence(context, privacy);
    // Only failed transports are held locally, never a valid pin: the service rechecks current hard rules.
    if (!result.ok) state.failure = { turn: key, result };
    return { result, privacy };
  }
}
