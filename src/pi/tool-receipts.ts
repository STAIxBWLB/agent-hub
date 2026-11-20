import { chmodSync } from "node:fs";
import type { Database } from "../hub/db-schema.ts";
import { openHubDatabase } from "../hub/db-schema.ts";
import { createHash } from "node:crypto";
import { PreEffectToolRefusal } from "../hub/tool-refusal.ts";

export const PI_TOOL_RESULT_CAP = 100_000;
/** #1555 AC6: what a settled receipt of a closed session keeps. A replay inside that session never needs more than the outcome and, for a shell, its exit code. */
export const PI_CLOSED_RESULT_CAP = 2_000;
const COMPACTED = "\n[result compacted after the session closed]";
export function compactPiResult(result: string, cap = PI_CLOSED_RESULT_CAP): string {
  if (result.length <= cap) return result;
  try {
    const parsed = JSON.parse(result) as { kind?: unknown; text?: unknown; exitCode?: unknown };
    if (parsed && parsed.kind === "user-bash-result" && typeof parsed.text === "string") return JSON.stringify({ kind: parsed.kind, text: parsed.text.slice(0, Math.max(0, cap - 200)) + COMPACTED, exitCode: parsed.exitCode });
  } catch { /* plain text result */ }
  // bash and git results end with "(exit N)", which toolResultFailed reads to tell a failure from a success on a replay: keep that line.
  const exit = result.match(/\n\(exit [^\n)]+\)$/u)?.[0] ?? "";
  return result.slice(0, Math.max(0, cap - exit.length)) + COMPACTED + exit;
}
/** Bound encoded text before wrapping it so escaping never cuts off trusted exit metadata. */
export function packPiShellResult(text: string, exitCode: number | null): string {
  const pack = (value: string) => JSON.stringify({ kind: "user-bash-result", text: value, exitCode });
  const full = pack(text);
  if (full.length <= PI_TOOL_RESULT_CAP) return full;
  const suffix = "\n[output truncated]";
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (pack(text.slice(0, middle) + suffix).length <= PI_TOOL_RESULT_CAP) low = middle;
    else high = middle - 1;
  }
  return pack(text.slice(0, low) + suffix);
}

/** Private, session-scoped dedupe. An interrupted effect is never automatically repeated. */
export class PiToolReceipts {
  private readonly db: Database;
  private closing = false;
  private closed = false;
  private readonly pending = new Map<string, Promise<string>>();
  private currentSession: string | undefined;
  constructor(file: string) {
    this.db = openHubDatabase(file, { create: true });
    chmodSync(file, 0o600);
    this.db.run(`CREATE TABLE IF NOT EXISTS pi_tool_receipts (
      session TEXT NOT NULL, call_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      state TEXT NOT NULL, result TEXT, PRIMARY KEY(session, call_id))`);
  }

  async execute(session: string, callId: string, name: string, args: unknown, run: () => Promise<string>): Promise<string> {
    if (this.closing) return "error: Pi tool ledger is shutting down; no new operation was executed";
    if (!session || !callId || session.length > 512 || callId.length > 512) return "error: invalid Pi session/tool call identity";
    this.closeOthers(session);
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
    const settle = (result: string): string => {
      const text = result.slice(0, PI_TOOL_RESULT_CAP);
      this.db.query("UPDATE pi_tool_receipts SET state='done',result=? WHERE session=? AND call_id=?").run(text, session, callId);
      return text;
    };
    // Legacy pending rows have no refusal proof: neither the current board nor an error's text can settle them.
    const work = Promise.resolve().then(run).then(settle, (error: unknown) => {
      if (error instanceof PreEffectToolRefusal) return settle(`error: ${error.message}`);
      throw error;
    }).catch(() => "error: tool outcome is uncertain; stop and reconcile it, do not repeat the effect")
      .finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }

  /** A call from a new session closes the previous one: its settled results shrink, while the active session's receipts are never touched. */
  private closeOthers(session: string): void {
    if (this.currentSession === session) return;
    this.currentSession = session;
    try {
      const rows = this.db.query("SELECT session,call_id,result FROM pi_tool_receipts WHERE state='done' AND session != ? AND length(result) > ?").all(session, PI_CLOSED_RESULT_CAP) as { session: string; call_id: string; result: string }[];
      const update = this.db.query("UPDATE pi_tool_receipts SET result=? WHERE session=? AND call_id=? AND state='done'");
      this.db.transaction(() => { for (const row of rows) update.run(compactPiResult(row.result), row.session, row.call_id); })();
    } catch { /* retention only: a failed pass leaves every receipt as it was */ }
  }

  get unsettled(): boolean { return this.pending.size > 0 || !!this.db.query("SELECT 1 FROM pi_tool_receipts WHERE state != 'done' LIMIT 1").get(); }
  get inFlight(): number { return this.pending.size; }
  async drain(): Promise<void> { await Promise.allSettled(this.pending.values()); }

  async close(): Promise<void> {
    this.closing = true;
    await this.drain();
    if (!this.closed) { this.closed = true; this.db.close(); }
  }
}
