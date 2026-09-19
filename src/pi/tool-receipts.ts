import { chmodSync } from "node:fs";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

/** Private, session-scoped dedupe. An interrupted effect is never automatically repeated. */
export class PiToolReceipts {
  private readonly db: Database;
  private closing = false;
  private closed = false;
  private readonly pending = new Map<string, Promise<string>>();
  constructor(file: string) {
    this.db = new Database(file, { create: true });
    chmodSync(file, 0o600);
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run(`CREATE TABLE IF NOT EXISTS pi_tool_receipts (
      session TEXT NOT NULL, call_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      state TEXT NOT NULL, result TEXT, PRIMARY KEY(session, call_id))`);
  }

  async execute(session: string, callId: string, name: string, args: unknown, run: () => Promise<string>): Promise<string> {
    if (this.closing) return "error: Pi tool ledger is shutting down; no new operation was executed";
    if (!session || !callId || session.length > 512 || callId.length > 512) return "error: invalid Pi session/tool call identity";
    const fingerprint = createHash("sha256").update(JSON.stringify({ name, args })).digest("hex");
    const key = JSON.stringify([session, callId]);
    const row = this.db.query("SELECT fingerprint,state,result FROM pi_tool_receipts WHERE session=? AND call_id=?").get(session, callId) as { fingerprint: string; state: string; result: string | null } | null;
    if (row) {
      if (row.fingerprint !== fingerprint) return "error: Pi tool call ID was reused with different arguments";
      if (row.state === "done") return row.result ?? "";
      const active = this.pending.get(key);
      return active ?? "error: previous tool outcome is uncertain; stop and reconcile it, do not repeat the effect";
    }
    const claim = this.db.query("INSERT OR IGNORE INTO pi_tool_receipts(session,call_id,fingerprint,state) VALUES(?,?,?,'pending')").run(session, callId, fingerprint);
    if (!claim.changes) return this.execute(session, callId, name, args, run);
    const work = Promise.resolve().then(run).then((result) => {
      const text = result.slice(0, 100_000);
      this.db.query("UPDATE pi_tool_receipts SET state='done',result=? WHERE session=? AND call_id=?").run(text, session, callId);
      return text;
    }).catch(() => "error: tool outcome is uncertain; stop and reconcile it, do not repeat the effect")
      .finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }

  get inFlight(): number { return this.pending.size; }
  async drain(): Promise<void> { await Promise.allSettled(this.pending.values()); }

  async close(): Promise<void> {
    this.closing = true;
    await this.drain();
    if (!this.closed) { this.closed = true; this.db.close(); }
  }
}
