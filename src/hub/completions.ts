/**
 * #1054 T2: runs a person started, and the completion each one earns when it settles. Pure: the daemon supplies the facts (an adapter signal, the pending-work reads) and the
 * store, this decides. Ids and counts only: no prompt or reply text is ever passed in, kept or returned.
 *
 * A run starts at the `turn_start` that consumes a person-originated delivery. It is settled only when ALL hold for its peer: the adapter's own settle signal fired, no queued
 * delivery will start a continuation turn, no permission or question is open, and no owned child, running check or held delivery remains. While any is open the run reads as
 * working (or, for a permission or question, as needing the person), even after a `turn_end`.
 *
 * An adapter that declares no `settle` signal creates no completion: nothing here guesses one (owner decision 2026-11-04, issue #1054).
 *
 * Restart reconstruction reads the store's open-run rows (`completions-store.ts`), not `events.jsonl`: a `turn_start` event does not say who started the turn, so events alone
 * would invent completions for runs nobody asked for. A run is recorded, ids only, when it starts and removed when it settles or is stopped quietly.
 */

/** The facts one settle check reads, all counts the daemon already holds. */
export interface SettleFacts {
  /** The adapter's settle signal fired for the run's last turn (a verified native Stop, `turn/completed`, `agent_settled`, a route outcome, a prompt response, `message_stop`). */
  signal: boolean;
  /** Deliveries in the peer's queue that will start another turn (task, chat, review, important), never a notice that starts none. */
  queuedContinuations: number;
  openPermissions: number;
  openQuestions: number;
  /** An owned child process the hub can see (a headless implementer's print child that outlived its turn). */
  ownedChildren: number;
  /** Check runs (`src/hub/check-runner.ts`) owned by this peer that are queued or running. */
  runningChecks: number;
  /** Rows held or in `needs_review`: uncertain, so never settled. */
  heldDeliveries: number;
}

export type RunState = "working" | "needs-input" | "settled";

/** The one rule. A permission or question wins over everything else: the person has to act, so the run is needs-input and never "done". */
export function settleVerdict(facts: SettleFacts): RunState {
  if (facts.openPermissions > 0 || facts.openQuestions > 0) return "needs-input";
  if (!facts.signal || facts.queuedContinuations > 0 || facts.ownedChildren > 0 || facts.runningChecks > 0 || facts.heldDeliveries > 0) return "working";
  return "settled";
}

export const OUTCOMES = Object.freeze(["done", "failed", "limit", "interrupted"] as const);
export type Outcome = (typeof OUTCOMES)[number];

/** What a run saw while it lasted. Closed facts the daemon sets; none carries text. */
export interface RunEvidence {
  /** A turn of this run ended in a failure the adapter reported (a prompt that ended without normal completion, a refused turn). */
  failed?: true;
  /** A budget, step ceiling or context limit ended it. */
  limit?: true;
}

export const outcomeOf = (evidence: RunEvidence): Exclude<Outcome, "interrupted"> => evidence.limit ? "limit" : evidence.failed ? "failed" : "done";

export interface Run {
  peer: string;
  /** The turn id of the `turn_start` that began the run: the deduplication key of its completion. */
  runTurn: string;
  /** The latest turn of the run (a continuation moves it). */
  lastTurn: string;
  startedAt: number;
  /** Envelope ids only, so a display can read the prompt and the reply later through the usual privacy path. */
  promptEnvelope?: string;
  replyEnvelope?: string;
  private: boolean;
  evidence: RunEvidence;
  /** The adapter's settle signal for the latest turn has fired. */
  signalled: boolean;
}

/** In-memory runs, one per peer. The store keeps an id-only row for each open run, so a restart can settle it `interrupted`. */
export class RunTracker {
  private readonly runs = new Map<string, Run>();

  get(peer: string): Run | undefined { return this.runs.get(peer); }
  open(): Run[] { return [...this.runs.values()]; }

  /**
   * A turn started. It begins a run only when `personOriginated` and the peer has none; a turn that starts while a run is open is a continuation and moves `lastTurn`,
   * whoever started it. Returns the run the turn belongs to, or undefined when it belongs to none (an ordinary agent-to-agent turn).
   */
  turnStarted(input: { peer: string; turn: string; at: number; personOriginated: boolean; promptEnvelope?: string; private: boolean }): Run | undefined {
    const current = this.runs.get(input.peer);
    if (current) {
      current.lastTurn = input.turn; current.signalled = false;
      if (input.private) current.private = true;
      return current;
    }
    if (!input.personOriginated) return undefined;
    const run: Run = { peer: input.peer, runTurn: input.turn, lastTurn: input.turn, startedAt: input.at, ...(input.promptEnvelope ? { promptEnvelope: input.promptEnvelope } : {}), private: input.private, evidence: {}, signalled: false };
    this.runs.set(input.peer, run);
    return run;
  }

  /** The adapter's settle signal fired for the peer's latest turn. */
  signalled(peer: string, replyEnvelope?: string): Run | undefined {
    const run = this.runs.get(peer);
    if (!run) return undefined;
    run.signalled = true;
    if (replyEnvelope) run.replyEnvelope = replyEnvelope;
    return run;
  }

  note(peer: string, evidence: RunEvidence): void {
    const run = this.runs.get(peer);
    if (!run) return;
    if (evidence.failed) run.evidence.failed = true;
    if (evidence.limit) run.evidence.limit = true;
  }

  /** An explicit stop by the person: the run ends and creates nothing. */
  quietStop(peer: string): boolean { return this.runs.delete(peer); }

  /** Remove the run once its completion exists. */
  close(peer: string): void { this.runs.delete(peer); }

  /** The state a settle check reads off a run's own signal plus the pending-work facts. */
  state(peer: string, pending: Omit<SettleFacts, "signal">): RunState | undefined {
    const run = this.runs.get(peer);
    return run ? settleVerdict({ ...pending, signal: run.signalled }) : undefined;
  }
}
