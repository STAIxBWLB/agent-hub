/**
 * #1054 T2: the completions table in hub.db. Ids only, never a prompt or a reply: `prompt_envelope` and `reply_envelope` name envelopes the usual privacy path reads when a
 * person looks. Three additive tables (no format bump): an older hub ignores them, which `Daemon` guards for recovery with the `completions` feature.
 *
 * - `completion_runs`: one row per OPEN run (a person started it, it has not settled). A restart settles each one `interrupted`.
 * - `completions`: one row per settled run, keyed by the run's first turn id, so a repeated restart or a replayed settle can never make a second.
 * - `completion_receipts`: created here for the next task (receipts); nothing writes it yet.
 */
import { openHubDatabase, type Database } from "./db-schema.ts";
import { OUTCOMES, type Outcome, type Run } from "./completions.ts";

export interface Completion {
  id: string;
  peer: string;
  runTurn: string;
  lastTurn: string;
  outcome: Outcome;
  settledAt: number;
  startedAt: number;
  promptEnvelope?: string;
  replyEnvelope?: string;
  private: boolean;
}
interface RawCompletion {
  id: string; peer: string; run_turn: string; last_turn: string; outcome: string; settled_at: number; started_at: number;
  prompt_envelope: string | null; reply_envelope: string | null; private: number;
}
const completionOf = (raw: RawCompletion): Completion => ({
  id: raw.id, peer: raw.peer, runTurn: raw.run_turn, lastTurn: raw.last_turn, outcome: raw.outcome as Outcome, settledAt: raw.settled_at, startedAt: raw.started_at,
  ...(raw.prompt_envelope ? { promptEnvelope: raw.prompt_envelope } : {}), ...(raw.reply_envelope ? { replyEnvelope: raw.reply_envelope } : {}), private: raw.private === 1,
});

/** An open run as the store keeps it: the ids a restart needs to settle it, nothing else. */
export interface OpenRun { peer: string; runTurn: string; lastTurn: string; startedAt: number; promptEnvelope?: string; private: boolean }

export class CompletionStore {
  private readonly db: Database;
  constructor(dbPath: string) {
    this.db = openHubDatabase(dbPath, { create: true });
    this.db.run(`CREATE TABLE IF NOT EXISTS completion_runs (
      run_turn TEXT PRIMARY KEY, peer TEXT NOT NULL, last_turn TEXT NOT NULL, started_at INTEGER NOT NULL, prompt_envelope TEXT, private INTEGER NOT NULL DEFAULT 0)`);
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS completion_runs_by_peer ON completion_runs(peer)");
    this.db.run(`CREATE TABLE IF NOT EXISTS completions (
      id TEXT PRIMARY KEY, run_turn TEXT NOT NULL UNIQUE, peer TEXT NOT NULL, last_turn TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN (${OUTCOMES.map(outcome => `'${outcome}'`).join(",")})),
      settled_at INTEGER NOT NULL, started_at INTEGER NOT NULL, prompt_envelope TEXT, reply_envelope TEXT, private INTEGER NOT NULL DEFAULT 0)`);
    this.db.run("CREATE INDEX IF NOT EXISTS completions_by_peer ON completions(peer, settled_at)");
    // Unread means no receipt. One receipt per completion at most (UNIQUE), so a double mark is one write and a mark-unread has exactly one row to delete.
    this.db.run("CREATE TABLE IF NOT EXISTS completion_receipts (completion_id TEXT NOT NULL, seen_at INTEGER NOT NULL, surface TEXT NOT NULL)");
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS completion_receipts_by_completion ON completion_receipts(completion_id)");
  }
  close(): void { try { this.db.close(); } catch { /* already closed */ } }

  /** Record an open run. One per peer: a second start for the same peer replaces nothing (the first run is still the run). */
  openRun(run: Run): void {
    this.db.query("INSERT OR IGNORE INTO completion_runs(run_turn, peer, last_turn, started_at, prompt_envelope, private) VALUES(?, ?, ?, ?, ?, ?)")
      .run(run.runTurn, run.peer, run.lastTurn, run.startedAt, run.promptEnvelope ?? null, run.private ? 1 : 0);
  }
  /** A continuation moved the run's latest turn, or marked it private. */
  touchRun(run: Run): void {
    this.db.query("UPDATE completion_runs SET last_turn = ?, private = ? WHERE run_turn = ?").run(run.lastTurn, run.private ? 1 : 0, run.runTurn);
  }
  /** A run stopped quietly by the person, or one that never earned a completion: its row goes and nothing is created. */
  dropRun(runTurn: string): void { this.db.query("DELETE FROM completion_runs WHERE run_turn = ?").run(runTurn); }
  openRuns(): OpenRun[] {
    return (this.db.query("SELECT * FROM completion_runs ORDER BY started_at, run_turn").all() as { run_turn: string; peer: string; last_turn: string; started_at: number; prompt_envelope: string | null; private: number }[])
      .map(row => ({ peer: row.peer, runTurn: row.run_turn, lastTurn: row.last_turn, startedAt: row.started_at, ...(row.prompt_envelope ? { promptEnvelope: row.prompt_envelope } : {}), private: row.private === 1 }));
  }

  /**
   * Settle a run: write its completion and remove its open row in one transaction. Keyed by the run's first turn id (`UNIQUE`), so a replay, a second restart or two callers
   * racing on the same run yield exactly one completion; the loser gets undefined and creates nothing.
   */
  settle(run: OpenRun & { replyEnvelope?: string }, outcome: Outcome, now: number, id: string): Completion | undefined {
    const write = this.db.transaction(() => {
      const made = this.db.query(`INSERT OR IGNORE INTO completions(id, run_turn, peer, last_turn, outcome, settled_at, started_at, prompt_envelope, reply_envelope, private)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, run.runTurn, run.peer, run.lastTurn, outcome, now, run.startedAt, run.promptEnvelope ?? null, run.replyEnvelope ?? null, run.private ? 1 : 0);
      this.db.query("DELETE FROM completion_runs WHERE run_turn = ?").run(run.runTurn);
      return made.changes === 1;
    });
    return write() ? this.get(id) : undefined;
  }

  get(id: string): Completion | undefined {
    const raw = this.db.query("SELECT * FROM completions WHERE id = ?").get(id) as RawCompletion | null;
    return raw ? completionOf(raw) : undefined;
  }
  byRun(runTurn: string): Completion | undefined {
    const raw = this.db.query("SELECT * FROM completions WHERE run_turn = ?").get(runTurn) as RawCompletion | null;
    return raw ? completionOf(raw) : undefined;
  }
  /** Newest first, bounded. */
  list(limit = 100): Completion[] {
    return (this.db.query("SELECT * FROM completions ORDER BY settled_at DESC, id LIMIT ?").all(limit) as RawCompletion[]).map(completionOf);
  }
  /** Completions with no receipt: what the next task shows as unread. */
  unread(): Completion[] {
    return (this.db.query("SELECT c.* FROM completions c WHERE NOT EXISTS (SELECT 1 FROM completion_receipts r WHERE r.completion_id = c.id) ORDER BY c.settled_at DESC, c.id").all() as RawCompletion[]).map(completionOf);
  }
  /** One completion as the reads show it: the record and whether a receipt exists. Newest first. */
  listWithState(limit = 100): (Completion & { seenAt?: number; surface?: string })[] {
    return (this.db.query("SELECT c.*, r.seen_at AS seen_at, r.surface AS surface FROM completions c LEFT JOIN completion_receipts r ON r.completion_id = c.id ORDER BY c.settled_at DESC, c.id LIMIT ?").all(limit) as (RawCompletion & { seen_at: number | null; surface: string | null })[])
      .map(raw => ({ ...completionOf(raw), ...(raw.seen_at !== null ? { seenAt: raw.seen_at } : {}), ...(raw.surface ? { surface: raw.surface } : {}) }));
  }

  /**
   * Mark exactly one completion read. A compare-and-set on "no receipt yet": a completion that does not exist, or is already read, is refused with the reason, and of two callers
   * racing on one completion exactly one writes. Never infers "seen" from anything but this call.
   */
  markSeen(id: string, now: number, surface: string): { ok: true } | { ok: false; error: string } {
    if (!this.get(id)) return { ok: false, error: "no such result" };
    const made = this.db.query("INSERT OR IGNORE INTO completion_receipts(completion_id, seen_at, surface) VALUES(?, ?, ?)").run(id, now, surface);
    return made.changes === 1 ? { ok: true } : { ok: false, error: "that result is already read" };
  }
  /** Mark every unread completion of the project read, in one transaction. Returns the ids it marked. */
  markAllSeen(now: number, surface: string): string[] {
    const write = this.db.transaction(() => {
      const ids = (this.db.query("SELECT c.id FROM completions c WHERE NOT EXISTS (SELECT 1 FROM completion_receipts r WHERE r.completion_id = c.id) ORDER BY c.settled_at, c.id").all() as { id: string }[]).map(row => row.id);
      for (const id of ids) this.db.query("INSERT OR IGNORE INTO completion_receipts(completion_id, seen_at, surface) VALUES(?, ?, ?)").run(id, now, surface);
      return ids;
    });
    return write();
  }
  /** Relight the most recently settled READ completion (the one the person read last): its receipt is deleted. Undefined when nothing is read. */
  unmarkLast(): string | undefined {
    const write = this.db.transaction(() => {
      const row = this.db.query("SELECT r.completion_id AS id FROM completion_receipts r JOIN completions c ON c.id = r.completion_id ORDER BY c.settled_at DESC, c.id DESC LIMIT 1").get() as { id: string } | null;
      if (!row) return undefined;
      this.db.query("DELETE FROM completion_receipts WHERE completion_id = ?").run(row.id);
      return row.id;
    });
    return write();
  }

  /** What an older daemon would silently orphan: an open run, or a completion nobody has seen. */
  hasPending(): boolean {
    return (this.db.query(`SELECT (EXISTS(SELECT 1 FROM completion_runs)
      OR EXISTS(SELECT 1 FROM completions c WHERE NOT EXISTS (SELECT 1 FROM completion_receipts r WHERE r.completion_id = c.id))) AS present`).get() as { present: number }).present === 1;
  }
}
