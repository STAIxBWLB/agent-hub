import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../../omniroute/client.ts";
import { projectOutcomeBatch, priorFailureDigests } from "./observation-signals.ts";

export type RouteTurnOutcome = "completed" | "failed";
export type RouteTestOutcome = "pass" | "fail" | "none";
export type RouteAdvisorOutcome = "approve" | "redo" | "failed";
export interface RouteDimensions { severity: number; spinning: number; exploring: number; production: number }
export interface RouteTurnContext { turn: string; task?: number; pii: boolean }
export interface RouteLabelEvent {
  decision: string;
  turnId: string;
  turn: RouteTurnOutcome;
  pii: boolean;
  task?: number;
  latched: boolean;
  next?: { severity: 0 | 0.3 | 0.7 | 1; tests: RouteTestOutcome; repeat: boolean };
  advisor?: RouteAdvisorOutcome;
}

interface DecisionLabel {
  id: string;
  dimensions: RouteDimensions;
  baselineFingerprints: Set<string> | undefined;
  next?: RouteLabelEvent["next"];
  advisor?: RouteAdvisorOutcome;
}
interface OpenTurn {
  context: RouteTurnContext;
  decisions: Map<string, DecisionLabel>;
  latched: boolean;
  closed: boolean;
}

/** Holds only identifiers, numeric dimensions, enums, and hashed diagnostic fingerprints. */
export class RouteLabelTracker {
  private active: OpenTurn | undefined;
  private readonly turns = new Map<string, OpenTurn>();
  private readonly decisionOwners = new Map<string, OpenTurn>();

  constructor(private readonly sink?: (event: RouteLabelEvent) => void) {}

  beginTurn(context: RouteTurnContext): void {
    const prior = this.active;
    if (prior && !prior.closed) this.endTurn(prior.context.turn, "failed");
    const turn: OpenTurn = { context: { ...context }, decisions: new Map(), latched: false, closed: false };
    this.turns.set(context.turn, turn);
    this.active = turn;
  }

  captureTurn(): OpenTurn | undefined { return this.active && !this.active.closed ? this.active : undefined; }

  addDecision(turn: OpenTurn | undefined, dimensions: RouteDimensions, priorMessages: ChatMessage[] = []): string | undefined {
    if (!turn || turn.closed || this.turns.get(turn.context.turn) !== turn) return undefined;
    const id = randomUUID();
    const baseline = priorFailureDigests(priorMessages);
    turn.decisions.set(id, { id, dimensions: { ...dimensions }, baselineFingerprints: baseline === undefined ? undefined : new Set(baseline) });
    this.decisionOwners.set(id, turn);
    return id;
  }

  setLatched(turn: OpenTurn | undefined, latched: boolean): void {
    if (turn && !turn.closed && this.turns.get(turn.context.turn) === turn) turn.latched ||= latched;
  }

  observeResults(decisionId: string | undefined, assistant: ChatMessage, tools: ChatMessage[]): void {
    const turn = decisionId ? this.decisionOwners.get(decisionId) : undefined;
    if (!turn || turn.closed || this.turns.get(turn.context.turn) !== turn || !decisionId) return;
    const decision = turn.decisions.get(decisionId);
    if (!decision) return;

    const outcome = projectOutcomeBatch(assistant, tools);
    const baseline = decision.baselineFingerprints;
    if (!outcome || !baseline) { delete decision.next; return; }
    const repeat = outcome.failureDigests.some(digest => baseline.has(digest));
    decision.next = { severity: outcome.severity, tests: outcome.tests, repeat };
  }

  observeAdvisor(decisionId: string | undefined, verdict: RouteAdvisorOutcome): void {
    const turn = decisionId ? this.decisionOwners.get(decisionId) : undefined;
    if (!turn || turn.closed || this.turns.get(turn.context.turn) !== turn || !decisionId) return;
    const decision = turn.decisions.get(decisionId);
    if (decision) decision.advisor = verdict;
  }

  endTurn(turnId: string, outcome: RouteTurnOutcome, sink?: (event: RouteLabelEvent) => void): void {
    const turn = this.turns.get(turnId);
    if (!turn || turn.closed) return;
    turn.closed = true;
    this.turns.delete(turnId);
    if (this.active === turn) this.active = undefined;
    for (const decision of turn.decisions.values()) {
      const event: RouteLabelEvent = {
        decision: decision.id,
        turnId,
        turn: outcome,
        pii: turn.context.pii,
        latched: turn.latched,
        ...(turn.context.task === undefined ? {} : { task: turn.context.task }),
        ...(decision.next === undefined ? {} : { next: decision.next }),
        ...(decision.advisor === undefined ? {} : { advisor: decision.advisor }),
      };
      try { (sink ?? this.sink)?.(event); } catch { /* optional labels cannot affect the turn */ }
      this.decisionOwners.delete(decision.id);
    }
    turn.decisions.clear();
  }
}
