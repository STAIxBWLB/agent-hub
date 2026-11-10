import { createHash } from "node:crypto";
import { requestAdecRoute, type AdecPair, type AdecResult, type AdecFailure, type AdecReason, type AdecRouteRequest } from "./adec.ts";
import { buildDecisionEvidence } from "./decision-evidence.ts";
import type { HubRoute } from "./config.ts";
import type { ChatMessage } from "../../omniroute/client.ts";
import type { RouteLabelTracker } from "./labels.ts";
import { estimateInputTokens } from "./stage-input.ts";
import { sensitiveStageEvidence, type CodingAgentDimensions, type StageEvidence } from "./stage-evidence.ts";
import type { StageTier } from "./stage-fallback.ts";
import { ScopeStore } from "./turn-state.ts";
import { hostChoicePacket, startChoiceWindow, type ChoiceWindow, type HostChoicePurpose, type HostPhase } from "./judge-choice.ts";

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
  stageEvidence?: StageEvidence;
  hostChoice?: { purpose: HostChoicePurpose; phase?: HostPhase };
  deadline?: number;
  closed?(): boolean;
}
/** What one stage classification needs: bounded evidence instead of a conversation projection. */
export interface StageClassifyContext {
  route: string; scope: string; turn: ReturnType<RouteLabelTracker["captureTurn"]>;
  current(): boolean; messages: ChatMessage[]; evidence: StageEvidence; pii: boolean; signal: AbortSignal; tier: StageTier;
}
/** A purpose scopes the per-turn memo so one route type cannot read another's held answer. */
export type DecisionPurpose = "stage" | "decision" | "phase" | "judge";
export interface HostChoiceContext {
  route: string; scope: string; turn: ReturnType<RouteLabelTracker["captureTurn"]>;
  current(): boolean; messages: ChatMessage[]; evidence: StageEvidence; pii: boolean; signal: AbortSignal;
  purpose: HostChoicePurpose; phase?: HostPhase; deadline?: number;
}
interface Options { pairs: AdecPair[]; candidates: string[]; current?: AdecPair }
interface Privacy { pii: boolean; private: boolean; excluded: boolean }
export interface DecisionSelection { trace?: DecisionTrace; check?(): void }
type Selection = DecisionSelection;
type Attempt = { result: AdecResult; privacy: Privacy } | { skipped: string };
type PreparedRequest = { privacy: Privacy; input: AdecRouteRequest; options: Options; timeoutMs: number } | { skipped: string };
export class DecisionPolicyChangedError extends Error {
  constructor() { super("decision routing privacy or observer policy changed or is unavailable during preparation; run ahub status, inspect current task policy and retry"); }
}
interface State { fingerprint: string; failure?: { turn: string; result: AdecResult }; held?: { turn: string; trace: Partial<DecisionTrace>; privacy: Privacy } }
const ended = () => new Error("model route turn ended before execution; retry in the current turn");
const STAGE_PACKET_BYTES = 1024;
/** R1's stage packet: numeric and categorical fields only, never a conversation fragment. */
function stagePacket(context: Context, sensitive: boolean): string {
  const evidence = context.stageEvidence;
  if (!evidence) throw new Error("stage routing needs R1's stage evidence; inspect the route call before retrying");
  const packet = JSON.stringify(sensitive ? sensitiveStageEvidence(evidence) : evidence);
  if (Buffer.byteLength(packet, "utf8") > STAGE_PACKET_BYTES) throw new Error("stage evidence exceeds the numeric packet bound");
  return packet;
}

/** Optional decision work never changes the baseline on failure; valid pins/rules remain owned by adec. */
export class DecisionRouteController {
  private readonly states = new ScopeStore<State>();
  private readonly issues = new ScopeStore<{ fingerprint: string; reason: AdecFailure | AdecReason | null }>();
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
      messages: context.messages, dimensions: context.evidence.dimensions, stageEvidence: context.evidence, pii: context.pii, signal: context.signal };
    // An optional stage question never refuses a turn: the heuristic tier already stands, so a refusal records nothing to apply.
    if (inner.signal.aborted || inner.turn?.closed) return {};
    const state = this.state(config, inner, "stage"), key = this.turnKey("stage", inner);
    // One question per user turn, kept through the tool loop, exactly like the #197 pin rule. The held answer was
    // computed under the privacy and observer facts recorded with it, so a turn whose facts moved on drops it instead of
    // publishing a classification the current authority never approved; an unreadable authority read keeps propagating.
    const held = state.held;
    if (held?.turn === key) {
      const now = this.privacy(inner.pii);
      if (!inner.current() || !this.same(held.privacy, now)) { state.held = undefined; return {}; }
      return held.trace;
    }
    try {
      const trace = (await this.select(config, inner, "stage", options)).trace ?? {};
      this.hold(state, key, trace, inner);
      return trace;
    }
    catch (error) {
      // Changed or unavailable authority is not a service failure: it keeps refusing the stale turn, exactly as on a
      // decision route, instead of becoming a model fallback around that refusal. A closed turn only moots the question.
      if (error instanceof DecisionPolicyChangedError || error && typeof error === "object" && "budgetStop" in error) throw error;
      if (inner.signal.aborted || inner.turn?.closed) return {};
      const trace = this.skip(config, "unavailable").trace ?? {};
      this.hold(state, key, trace, inner);
      return trace;
    }
  }
  /** The memo keeps the facts an answer was computed under; an unreadable binding stores no publishable record. */
  private hold(state: State, key: string, trace: Partial<DecisionTrace>, context: Context): void {
    try { state.held = { turn: key, trace, privacy: this.privacy(context.pii) }; } catch { state.held = undefined; }
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
  /** A current host authority guard, independent of whether a service binding is enabled. */
  captureGuard(pii: boolean, current: () => boolean): () => void {
    const initial = this.privacy(pii);
    if ((initial.pii || initial.private) && !pii) throw new DecisionPolicyChangedError();
    return () => {
      if (!current()) throw ended();
      if (!this.same(initial, this.privacy(pii))) throw new DecisionPolicyChangedError();
    };
  }
  /** Host model choice records no applied pair; common preparation and HTTP have distinct lifetimes. */
  openHostChoice(config: HubRoute, context: HostChoiceContext): ChoiceWindow<Selection> | undefined {
    if (config.decision_backend !== "adec" || config.decision_mode !== "shadow") return undefined;
    if (context.purpose === "plan_execute_model" ? config.type !== "plan_execute"
      : context.purpose === "advisor_judge_model" ? config.type !== "advisor"
      : context.purpose === "escalation_judge_model" ? config.type !== "escalation" : true) return undefined;
    const purpose: DecisionPurpose = context.purpose === "plan_execute_model" ? "phase" : "judge";
    const inner: Context = { route: context.route, scope: context.scope, turn: context.turn, current: context.current,
      messages: context.messages, dimensions: context.evidence.dimensions, stageEvidence: context.evidence,
      hostChoice: { purpose: context.purpose, ...(context.phase ? { phase: context.phase } : {}) },
      pii: context.pii, signal: context.signal, ...(context.deadline === undefined ? {} : { deadline: context.deadline }) };
    const initial = this.privacy(context.pii);
    let state: State | undefined, key: string | undefined;
    const began = performance.now(), options = this.decisionOptions(config);
    type Prepared = PreparedRequest | { cached: AdecResult; privacy: Privacy };
    return startChoiceWindow<Prepared, Selection>({
      signal: context.signal,
      prepare: async closed => {
        inner.closed = closed;
        try {
          if (closed()) return undefined;
          this.fence(inner, initial);
          if (!inner.turn) return { skipped: "turn_unavailable" };
          if (initial.excluded) return { skipped: "observer_excluded" };
          if ((initial.pii || initial.private) && !inner.pii) throw new DecisionPolicyChangedError();
          state = this.state(config, inner, purpose); key = this.turnKey(purpose, inner);
          if (state.failure?.turn === key) return { cached: state.failure.result, privacy: initial };
          return await this.prepareRequest(config, inner, initial, key, options, purpose);
        } catch (error) {
          if (closed()) return undefined;
          this.fence(inner, initial);
          if (error instanceof DecisionPolicyChangedError || error && typeof error === "object" && "budgetStop" in error) throw error;
          return { skipped: "unavailable" };
        }
      },
      request: async (prepared, signal, closed) => {
        inner.signal = signal; inner.closed = closed;
        try {
          if (closed()) return undefined;
          const attempt: Attempt = "cached" in prepared ? { result: prepared.cached, privacy: prepared.privacy }
            : "skipped" in prepared ? prepared : state && key ? await this.sendRequest(config, inner, prepared, state, key) : { skipped: "unavailable" };
          if (closed()) return undefined;
          return this.selection(config, inner, attempt, began);
        } catch (error) {
          if (closed()) return undefined;
          this.fence(inner, initial);
          if (error instanceof DecisionPolicyChangedError || error && typeof error === "object" && "budgetStop" in error) throw error;
          return this.skip(config, "unavailable");
        }
      },
    });
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
    if (context.closed?.()) throw ended();
    this.publicationFence(context, privacy);
  }
  private publicationFence(context: Context, privacy: Privacy): void {
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
    const attempt: Attempt = state.failure?.turn === key ? { result: state.failure.result, privacy } : await this.request(config, context, privacy, state, key, options, purpose);
    return this.selection(config, context, attempt, began);
  }
  private selection(config: HubRoute, context: Context, attempt: Attempt, began: number): Selection {
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
    return { check: () => this.publicationFence(context, attempt.privacy),
      trace: { decisionMode: config.decision_mode ?? "off", chosenAlias: d.alias, chosenEffort: d.effort, margin: d.margin,
        decisionLatencyMs: Math.max(0, performance.now() - began), decisionReason: d.reason, fallbackApplied: d.fallbackApplied,
        ...(decider === undefined ? {} : { decider }) } };
  }
  private async request(config: HubRoute, context: Context, initial: Privacy, state: State, key: string, options: Options, purpose: DecisionPurpose): Promise<Attempt> {
    const prepared = await this.prepareRequest(config, context, initial, key, options, purpose);
    return "skipped" in prepared ? prepared : this.sendRequest(config, context, prepared, state, key);
  }
  private async prepareRequest(config: HubRoute, context: Context, initial: Privacy, key: string, options: Options, purpose: DecisionPurpose): Promise<PreparedRequest> {
    await this.host.admitDecision?.();
    if (context.closed?.() || !context.current()) throw ended();
    const privacy = this.privacy(context.pii);
    if (!this.same(initial, privacy)) throw new DecisionPolicyChangedError();
    const campus = privacy.pii || privacy.private ? await this.host.onCampus() === true : true;
    this.fence(context, privacy);
    if (!campus) return { skipped: "off_campus" };
    const sensitive = privacy.pii || privacy.private;
    let evidence: string | undefined;
    if (purpose === "stage") evidence = stagePacket(context, sensitive);
    else if (purpose === "decision") evidence = buildDecisionEvidence(sensitive ? [] : context.messages, context.dimensions, text => this.host.publicDecisionText?.(text) === true);
    else if (context.stageEvidence && context.hostChoice) evidence = hostChoicePacket(context.stageEvidence, context.hostChoice.purpose, context.hostChoice.phase, sensitive);
    if (evidence === undefined) return { skipped: "unavailable" };
    this.fence(context, privacy);
    const remaining = context.deadline === undefined ? undefined : context.deadline - performance.now();
    if (remaining !== undefined && remaining <= 0) return { skipped: "timeout" };
    const timeoutMs = Math.min(config.decision_timeout_ms ?? this.timeoutMs, remaining === undefined ? Infinity : Math.ceil(remaining));
    return { privacy, options, timeoutMs, input: {
      policyId: config.policy_id ?? "", turnId: `ahub:${key}`, evidence,
      constraints: { contextTokens: sensitive ? 0 : estimateInputTokens(context.messages), pii: privacy.pii, private: privacy.private,
        ...(options.current === undefined ? {} : { current: options.current }) },
      candidates: options.candidates,
    } };
  }
  private async sendRequest(config: HubRoute, context: Context, prepared: Exclude<PreparedRequest, { skipped: string }>, state: State, key: string): Promise<Attempt> {
    this.fence(context, prepared.privacy);
    const result = await requestAdecRoute(config.adec_endpoint ?? "http://127.0.0.1:8740/v1/route", prepared.input,
      prepared.options.pairs, context.signal, prepared.timeoutMs);
    this.fence(context, prepared.privacy);
    // Normal window closure refuses this path before storing a failed transport.
    if (!result.ok) state.failure = { turn: key, result };
    return { result, privacy: prepared.privacy };
  }
}
