/**
 * #1221 T2: bounded supervision proposals and their explicit accept/dismiss path.
 *
 * The rule layer (`supervision-rules.ts`) answers whether one of a closed set of conditions holds. This module is the
 * only place that turns such a reading into something a present role can decide on, and it decides nothing itself: it
 * stores proposals (three additive tables in hub.db, no format bump — an older hub ignores them, the way
 * `completions-store.ts` does), and it has no timer, no worker and no action of its own. Observation attaches to board
 * events the daemon already handles, and one reconcile pass runs at startup.
 *
 * What an acceptance runs is an existing action, through that action's own authority: the port `run` is supplied by the
 * caller and its outcome is recorded as a receipt beside the decision, never inside the task's own result. Intent
 * (this row's disposition), receipt (the action's outcome), task result (the board's own history) and a later review
 * stay four separate records, and an outcome the hub could not observe stays `unknown` until an existing record settles
 * it — it is never retried blind.
 */
import { randomUUID } from "node:crypto";
import { isClosedTaskState } from "./board.ts";
import { openHubDatabase, type Database } from "./db-schema.ts";
import {
  MAX_OBSERVATIONS,
  MAX_PER_REVISION,
  evaluateSupervision,
  revisionSpan,
  taskRevision,
  type SupervisionAction,
  type SupervisionFacts,
  type SupervisionObservation,
  type SupervisionReasonCode,
  type SupervisionRuleId,
} from "./supervision-rules.ts";

/** A decision is terminal. `expired` is the hub's: new input or a replaced native generation took the question away. */
export const SUPERVISION_PROPOSAL_STATES = ["pending", "accepted", "dismissed", "expired"] as const;
export type SupervisionProposalState = (typeof SUPERVISION_PROPOSAL_STATES)[number];
/** What an accepted proposal's action reported. `pending` is the intent record, written before the action runs. */
export const SUPERVISION_RECEIPTS = ["pending", "ran", "refused", "unknown"] as const;
export type SupervisionReceiptOutcome = (typeof SUPERVISION_RECEIPTS)[number];

/** The queue bound and the rate budget one task revision gets: the numbers the shadow reading is already held to. */
export const MAX_PROPOSALS = MAX_OBSERVATIONS;
export const MAX_PROPOSALS_PER_REVISION = MAX_PER_REVISION;
/** Terminal rows kept for dedupe and history. Past this the oldest terminal row goes; a replay could propose again. */
export const MAX_PROPOSAL_ROWS = 400;
/** One read returns this many proposals, pending first. */
export const MAX_PROPOSAL_READ = 50;

/** An acceptance's receipt: what the existing action did, as far as this hub could observe. */
export interface SupervisionReceipt {
  outcome: SupervisionReceiptOutcome;
  detail?: string;
  at: number;
}

export interface SupervisionProposal {
  id: string;
  /** Dedupe identity: `(rule, task, revision, trigger)`. A replayed reading keeps this key and adds nothing. */
  key: string;
  rule: SupervisionRuleId;
  version: number;
  task: number;
  revision: string;
  trigger: string;
  refs: string[];
  /** Records the rule read, and whether the revision was clipped. A clipped reading is never proposed on. */
  records: number;
  truncated: boolean;
  action: SupervisionAction;
  reason: SupervisionReasonCode;
  /** The native generation the reading was made under (`<owner>@<session>`); a replaced one expires the proposal. */
  generation: string;
  createdAt: number;
  state: SupervisionProposalState;
  actor?: string;
  disposedAt?: number;
  receipt?: SupervisionReceipt;
}

/** The ids a stored proposal's refs carry: `task:<id>`, `history:<index>`, `deliverable:<id>`. */
export const proposalKey = (observation: SupervisionObservation): string =>
  `${observation.rule}:${observation.task}:${observation.revision}:${observation.trigger}`;

interface RawProposal {
  id: string; key: string; rule: string; version: number; task: number; revision: string; trigger: string;
  refs: string; records: number; truncated: number; action: string; reason: string; generation: string; created_at: number;
  state: string; actor: string | null; disposed_at: number | null;
  receipt_outcome: string | null; receipt_detail: string | null; receipt_at: number | null;
}

const proposalOf = (raw: RawProposal): SupervisionProposal => ({
  id: raw.id, key: raw.key, rule: raw.rule as SupervisionRuleId, version: raw.version, task: raw.task, revision: raw.revision,
  trigger: raw.trigger, refs: JSON.parse(raw.refs) as string[], records: raw.records, truncated: raw.truncated === 1,
  action: raw.action as SupervisionAction, reason: raw.reason as SupervisionReasonCode, generation: raw.generation,
  createdAt: raw.created_at, state: raw.state as SupervisionProposalState,
  ...(raw.actor ? { actor: raw.actor } : {}), ...(raw.disposed_at === null ? {} : { disposedAt: raw.disposed_at }),
  ...(raw.receipt_outcome ? { receipt: { outcome: raw.receipt_outcome as SupervisionReceiptOutcome, ...(raw.receipt_detail ? { detail: raw.receipt_detail } : {}), at: raw.receipt_at ?? raw.created_at } } : {}),
});

/**
 * The proposal queue in hub.db. Additive only: `CREATE TABLE IF NOT EXISTS`, no `hub_schema` bump, so a hub that does
 * not know supervision simply reads its older tables and the daemon's feature guard keeps recovery honest.
 */
export class ProposalStore {
  private readonly db: Database;
  constructor(dbPath: string) {
    this.db = openHubDatabase(dbPath, { create: true });
    this.db.run(`CREATE TABLE IF NOT EXISTS supervision_proposals (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      rule TEXT NOT NULL, version INTEGER NOT NULL, task INTEGER NOT NULL, revision TEXT NOT NULL, trigger TEXT NOT NULL,
      refs TEXT NOT NULL, records INTEGER NOT NULL, truncated INTEGER NOT NULL DEFAULT 0,
      action TEXT NOT NULL, reason TEXT NOT NULL, generation TEXT NOT NULL, created_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','accepted','dismissed','expired')),
      actor TEXT, disposed_at INTEGER,
      receipt_outcome TEXT, receipt_detail TEXT, receipt_at INTEGER)`);
    this.db.run("CREATE INDEX IF NOT EXISTS supervision_proposals_by_task ON supervision_proposals(state, task, created_at)");
  }
  close(): void { try { this.db.close(); } catch { /* already closed */ } }

  get(id: string): SupervisionProposal | undefined {
    const raw = this.db.query("SELECT * FROM supervision_proposals WHERE id = ?").get(id) as RawProposal | null;
    return raw ? proposalOf(raw) : undefined;
  }
  byKey(key: string): SupervisionProposal | undefined {
    const raw = this.db.query("SELECT * FROM supervision_proposals WHERE key = ?").get(key) as RawProposal | null;
    return raw ? proposalOf(raw) : undefined;
  }
  /** Pending first, then the newest terminal rows. Bounded by the caller. */
  list(opts: { tasks?: readonly number[]; limit?: number } = {}): SupervisionProposal[] {
    const limit = Math.max(1, Math.min(opts.limit ?? MAX_PROPOSAL_READ, MAX_PROPOSAL_READ));
    const filter = opts.tasks ? `WHERE task IN (${opts.tasks.map(() => "?").join(",")})` : "";
    const rows = this.db.query(`SELECT * FROM supervision_proposals ${filter} ORDER BY CASE state WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC, id LIMIT ?`)
      .all(...(opts.tasks ?? []), limit) as RawProposal[];
    return rows.map(proposalOf);
  }
  pendingCount(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM supervision_proposals WHERE state = 'pending'").get() as { n: number }).n;
  }
  /** Every pending row, oldest first: the one list a startup reconcile walks. */
  pending(): SupervisionProposal[] {
    return (this.db.query("SELECT * FROM supervision_proposals WHERE state = 'pending' ORDER BY created_at, id").all() as RawProposal[]).map(proposalOf);
  }
  /** Every pending row of one task, oldest first: the read an invalidation walks, so no row is missed by a page bound. */
  pendingFor(task: number): SupervisionProposal[] {
    return (this.db.query("SELECT * FROM supervision_proposals WHERE state = 'pending' AND task = ? ORDER BY created_at, id").all(task) as RawProposal[]).map(proposalOf);
  }
  /** Acceptances whose action outcome was never recorded, oldest first. */
  unsettled(): SupervisionProposal[] {
    return (this.db.query("SELECT * FROM supervision_proposals WHERE receipt_outcome = 'pending' ORDER BY created_at, id").all() as RawProposal[]).map(proposalOf);
  }
  /** Every proposal one task revision has had, whatever its state: the rate budget counts decisions too. */
  inRevision(task: number, revision: string): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM supervision_proposals WHERE task = ? AND revision = ?").get(task, revision) as { n: number }).n;
  }
  /** One proposal per key: a replay, a duplicate event or a second read adds nothing. */
  insert(proposal: SupervisionProposal): boolean {
    const made = this.db.query(`INSERT OR IGNORE INTO supervision_proposals
      (id, key, rule, version, task, revision, trigger, refs, records, truncated, action, reason, generation, created_at, state, actor, disposed_at, receipt_outcome, receipt_detail, receipt_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`).run(
      proposal.id, proposal.key, proposal.rule, proposal.version, proposal.task, proposal.revision, proposal.trigger,
      JSON.stringify(proposal.refs), proposal.records, proposal.truncated ? 1 : 0, proposal.action, proposal.reason,
      proposal.generation, proposal.createdAt, proposal.state);
    return made.changes === 1;
  }
  /** A compare-and-set on "still pending": of two deciders racing on one proposal exactly one disposes it. */
  dispose(id: string, state: Exclude<SupervisionProposalState, "pending">, actor: string, at: number, receipt?: SupervisionReceipt): boolean {
    const made = receipt
      ? this.db.query("UPDATE supervision_proposals SET state = ?, actor = ?, disposed_at = ?, receipt_outcome = ?, receipt_detail = ?, receipt_at = ? WHERE id = ? AND state = 'pending'")
        .run(state, actor, at, receipt.outcome, receipt.detail ?? null, receipt.at, id)
      : this.db.query("UPDATE supervision_proposals SET state = ?, actor = ?, disposed_at = ? WHERE id = ? AND state = 'pending'").run(state, actor, at, id);
    return made.changes === 1;
  }
  /** Record what the action reported, after the intent already went in. */
  settle(id: string, receipt: SupervisionReceipt): boolean {
    return this.db.query("UPDATE supervision_proposals SET receipt_outcome = ?, receipt_detail = ?, receipt_at = ? WHERE id = ?")
      .run(receipt.outcome, receipt.detail ?? null, receipt.at, id).changes === 1;
  }
  /** Expire the pending rows of one task that the current reading no longer produces. Returns how many it expired. */
  expire(ids: readonly string[], actor: string, at: number): number {
    let count = 0;
    const write = this.db.transaction(() => { for (const id of ids) if (this.dispose(id, "expired", actor, at)) count += 1; });
    write();
    return count;
  }
  /** Retention: past the bound the oldest terminal rows go. A pending row is never pruned. */
  prune(keep = MAX_PROPOSAL_ROWS): number {
    const doomed = (this.db.query("SELECT id FROM supervision_proposals WHERE state <> 'pending' ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?")
      .all(Math.max(0, keep)) as { id: string }[]).map((row) => row.id);
    const write = this.db.transaction(() => { for (const id of doomed) this.db.query("DELETE FROM supervision_proposals WHERE id = ? AND state <> 'pending'").run(id); });
    write();
    return doomed.length;
  }
}

/** Everything the queue needs from the hub, as ports: this module imports no board, bus, daemon or peer module. */
export interface ProposalPorts {
  /** The bounded fact set for one task: its own side, the overlap partners the rules read, and its measurement. */
  facts: (task: number) => Promise<SupervisionFacts> | SupervisionFacts;
  /** A private task is never proposed on, read or decided. */
  isPrivate: (task: number) => boolean;
  /** The native generation this project reads for a task: `<owner>@<session>` or `<owner>@unknown`. */
  generation: (task: number) => string;
  /** A present role on the task: its owner, its reviewer, the planner, the conductor, or the person. */
  mayDecide: (actor: string, task: number) => boolean;
  /**
   * The action's own authority, which a decision does not carry: `escalate` is the conductor's move (the person may
   * always), while the hub's owner notice runs for whoever may decide. A refusal here leaves the row pending.
   */
  mayRun: (actor: string, proposal: SupervisionProposal) => boolean;
  /** The task's owner has a `needs_review` delivery: the person resolves that before this question is taken up. */
  held: (task: number) => boolean;
  /** Run the named existing action, under that action's own authority. */
  run: (proposal: SupervisionProposal, actor: string) => Promise<{ outcome: Exclude<SupervisionReceiptOutcome, "pending">; detail?: string }>;
  now: () => number;
}

export type ProposalDecision =
  | { ok: true; proposal: SupervisionProposal; receipt?: SupervisionReceipt }
  | { ok: false; error: string };

/** A refusal names its next step: the id is wrong or gone, and the pending ones are one read away. */
const UNKNOWN_PROPOSAL = "unknown supervision proposal: read the pending ones with hub_supervision_list";
const NOT_A_DECIDER = "not yours to decide: the task's owner, reviewer, planner, conductor or the person decides a supervision proposal";
const notRunnable = (action: SupervisionAction): string =>
  `the ${action} action runs under its own authority and you do not hold it; the proposal stays pending`;

const newId = (): string => `sup-${randomUUID().replaceAll("-", "").slice(0, 12)}`;

/**
 * The bounded queue and the decision path. Nothing here writes to the board: a proposal's acceptance hands the work to
 * `run`, and the board's own method is what records the task's result.
 */
export class SupervisionProposals {
  /** Readings a bound refused instead of storing; a full queue is counted, never silently dropped. */
  private refused = 0;

  constructor(private readonly store: ProposalStore, private readonly ports: ProposalPorts) {}

  /**
   * Read one task, keep the papers: expire the pending proposals its current reading no longer produces (new input
   * replaced them), then store what is new. A clipped reading expires nothing and proposes nothing — a prefix is
   * missing coverage, never a clean reading.
   */
  async observe(task: number): Promise<SupervisionProposal[]> {
    if (this.ports.isPrivate(task)) return [];
    const facts = await this.ports.facts(task);
    const side = facts.tasks.find((candidate) => candidate.id === task);
    if (!side) return [];
    const at = this.ports.now(), evaluation = evaluateSupervision(facts);
    // A prefix of a long revision is missing coverage, never a clean reading: it invalidates nothing and proposes
    // nothing of its own, because the rules may still name a pattern inside the prefix they did see.
    const clipped = evaluation.gap.some((gap) => gap.task === task && gap.reason === "history-truncated");
    const reading = evaluation.observations.filter((observation) => observation.task === task && !observation.limits.truncated);
    if (!clipped) {
      const fresh = new Set(reading.map(proposalKey));
      const stale = this.store.pendingFor(task).filter((proposal) => !fresh.has(proposal.key)).map((proposal) => proposal.id);
      if (stale.length) this.store.expire(stale, "hub", at);
    }
    const added: SupervisionProposal[] = [];
    for (const observation of reading) {
      const key = proposalKey(observation);
      if (this.store.byKey(key)) continue; // a replay adds nothing and is not counted as advice
      if (this.store.pendingCount() >= MAX_PROPOSALS || this.store.inRevision(observation.task, observation.revision) >= MAX_PROPOSALS_PER_REVISION) { this.refused += 1; continue; }
      const proposal: SupervisionProposal = {
        id: newId(), key, rule: observation.rule, version: observation.version, task: observation.task, revision: observation.revision,
        trigger: observation.trigger, refs: [...observation.refs], records: observation.limits.records, truncated: observation.limits.truncated,
        action: observation.action, reason: observation.reason, generation: this.ports.generation(task), createdAt: at, state: "pending",
      };
      if (this.store.insert(proposal)) added.push(proposal);
    }
    if (added.length) this.store.prune();
    return added;
  }

  /**
   * What a present role may read: the proposals on tasks it holds a role on, pending first. A private task's proposal
   * is never shown, and an `unknown` receipt is settled from the board's own record when that record exists — a read
   * costs no clock and starts nothing.
   */
  async read(actor: string, task?: number): Promise<SupervisionProposal[]> {
    const rows = this.store.list({ ...(task === undefined ? {} : { tasks: [task] }) });
    const shown: SupervisionProposal[] = [];
    for (const row of rows) {
      if (this.ports.isPrivate(row.task) || !this.ports.mayDecide(actor, row.task)) continue;
      shown.push(await this.reconcile(row));
    }
    return shown;
  }

  /**
   * Advisory presentation (AC5): the pending proposals a caller may see now, oldest first, at most `limit`. It is
   * synchronous because a console snapshot cannot wait on the board, and it settles nothing: an `unknown` receipt is
   * reconciled by `read`, never by a poll.
   */
  awaiting(actor: string, limit = MAX_PROPOSAL_READ): SupervisionProposal[] {
    const shown: SupervisionProposal[] = [];
    for (const proposal of this.store.pending()) {
      if (this.ports.isPrivate(proposal.task) || !this.ports.mayDecide(actor, proposal.task)) continue;
      shown.push(proposal);
      if (shown.length >= limit) break;
    }
    return shown;
  }

  /** How many readings a bound refused instead of storing, since this queue was built: a full queue is not silent. */
  refusedReadings(): number {
    return this.refused;
  }

  /**
   * Accept or dismiss one pending proposal. Every fence runs before any effect: an unknown or already-decided id, a
   * caller that holds no present role, a private task, a replaced revision or native generation, a reading that no
   * longer holds, and an existing `needs_review` hold for the owner. A refusal that is about the reading expires the
   * proposal; a refusal about the caller, the action's own authority or the hold leaves it pending for whoever can take
   * it up.
   */
  async decide(actor: string, id: unknown, verb: "accept" | "dismiss"): Promise<ProposalDecision> {
    if (typeof id !== "string" || !/^sup-[0-9a-f]{12}$/.test(id)) return { ok: false, error: UNKNOWN_PROPOSAL };
    const proposal = this.store.get(id);
    if (!proposal) return { ok: false, error: UNKNOWN_PROPOSAL };
    if (proposal.state !== "pending") return { ok: false, error: `this proposal is already ${proposal.state}` };
    if (!this.ports.mayDecide(actor, proposal.task)) return { ok: false, error: NOT_A_DECIDER };
    // The decision's role is not the action's authority: accepting a move this caller cannot make would spend the row on
    // a refusal the action itself would issue. The row stays pending for an actor that holds it.
    if (verb === "accept" && !this.ports.mayRun(actor, proposal)) return { ok: false, error: notRunnable(proposal.action) };
    if (this.ports.isPrivate(proposal.task)) return { ok: false, error: "a private task is never proposed on" };
    if (proposal.truncated) return { ok: false, error: "the reading was clipped, so it cannot be acted on; inspect the task and its history first" };
    const facts = await this.ports.facts(proposal.task), side = facts.tasks.find((candidate) => candidate.id === proposal.task);
    if (!side) return this.stale(proposal, "the task is no longer on the board");
    if (isClosedTaskState(side.state)) return this.stale(proposal, "the task is closed");
    if (taskRevision(side).revision !== proposal.revision) return this.stale(proposal, "the task moved to another revision");
    if (this.ports.generation(proposal.task) !== proposal.generation) return this.stale(proposal, "the native session it was read under was replaced");
    // Recheck the input identity immediately before any effect: the same reading has to still hold now.
    if (!evaluateSupervision(facts).observations.some((observation) => proposalKey(observation) === proposal.key)) return this.stale(proposal, "the reading changed: new input replaced this proposal");
    if (this.ports.held(proposal.task)) return { ok: false, error: "the owner has a needs_review delivery; resolve it before acting on this proposal" };
    // Authority is read again after the await: the board can move while the facts are being read, and a role or a
    // session that went away in that window must not run anything.
    if (!this.ports.mayDecide(actor, proposal.task)) return { ok: false, error: NOT_A_DECIDER };
    if (verb === "accept" && !this.ports.mayRun(actor, proposal)) return { ok: false, error: notRunnable(proposal.action) };
    const at = this.ports.now();
    if (verb === "dismiss") {
      if (!this.store.dispose(proposal.id, "dismissed", actor, at)) return { ok: false, error: "this proposal was decided meanwhile; read it again" };
      return { ok: true, proposal: this.store.get(proposal.id)! };
    }
    // Intent first, on its own record: the action, its outcome and the board's result stay separate.
    if (!this.store.dispose(proposal.id, "accepted", actor, at, { outcome: "pending", at })) return { ok: false, error: "this proposal was decided meanwhile; read it again" };
    let receipt: SupervisionReceipt;
    try {
      const run = await this.ports.run(proposal, actor);
      receipt = { outcome: run.outcome, ...(run.detail ? { detail: run.detail } : {}), at: this.ports.now() };
    } catch (error) {
      // The action's own pre-effect refusal is a certain outcome; anything else may have had an effect and stays unknown.
      receipt = { outcome: "unknown", detail: error instanceof Error ? error.message.slice(0, 200) : "the action failed without a message", at: this.ports.now() };
    }
    this.store.settle(proposal.id, receipt);
    return { ok: true, proposal: this.store.get(proposal.id)!, receipt };
  }

  /**
   * Startup reconcile (AC6): a pending proposal whose task moved, closed or left the board expires; an acceptance whose
   * action outcome was never recorded becomes `unknown`. Dedupe keys, dispositions and unknown outcomes all survive,
   * and nothing is replayed.
   */
  async recover(): Promise<{ expired: number; unknown: number }> {
    const at = this.ports.now();
    let expired = 0, unknown = 0;
    for (const proposal of this.store.pending()) {
      if (this.ports.isPrivate(proposal.task)) { if (this.store.dispose(proposal.id, "expired", "hub", at)) expired += 1; continue; }
      const side = (await this.ports.facts(proposal.task)).tasks.find((candidate) => candidate.id === proposal.task);
      if (!side || isClosedTaskState(side.state) || taskRevision(side).revision !== proposal.revision) {
        if (this.store.dispose(proposal.id, "expired", "hub", at)) expired += 1;
      }
    }
    // An acceptance whose action never reported is not retried: it stays unknown until the board's own record settles it.
    for (const proposal of this.store.unsettled()) {
      if (this.store.settle(proposal.id, { outcome: "unknown", detail: "the hub restarted before the action reported", at })) unknown += 1;
    }
    return { expired, unknown };
  }

  /**
   * An `unknown` acceptance is settled only by the task's own record of the action, never by a guess or a retry. The
   * boundary is the intent time (`disposedAt`), which no later write overwrites — the receipt time is not a boundary at
   * all: a caught failure stamps it after the action threw and a restart stamps it after the restart. The record also
   * has to sit inside the revision the proposal was read under, so a later unrelated escalation cannot settle it.
   */
  private async reconcile(proposal: SupervisionProposal): Promise<SupervisionProposal> {
    const receipt = proposal.receipt, intent = proposal.disposedAt;
    if (proposal.state !== "accepted" || receipt?.outcome !== "unknown" || intent === undefined) return proposal;
    const event = proposal.action === "escalate" ? "escalated" : undefined;
    if (!event) return proposal;
    const side = (await this.ports.facts(proposal.task)).tasks.find((candidate) => candidate.id === proposal.task);
    if (!side) return proposal;
    const span = revisionSpan(side.history, proposal.revision);
    if (!span) return proposal;
    const recorded = side.history.slice(span.from, span.to + 1).some((entry) => entry.event === event && entry.at >= intent);
    if (!recorded) return proposal;
    this.store.settle(proposal.id, { outcome: "ran", detail: `the board recorded ${event}`, at: receipt.at });
    return this.store.get(proposal.id)!;
  }

  private stale(proposal: SupervisionProposal, why: string): ProposalDecision {
    this.store.dispose(proposal.id, "expired", "hub", this.ports.now());
    return { ok: false, error: `${why}; the proposal expired` };
  }
}
