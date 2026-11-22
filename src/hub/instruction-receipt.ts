import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { openHubDatabase, type Database } from "./db-schema.ts";
import { realPath } from "./project.ts";

export const INSTRUCTION_PROBED_VERSIONS = ["2.1.328", "2.1.329"] as const;
export const INSTRUCTION_PREFIX = "/agent-hub:ahub";
export const MAX_PROMPT_BYTES = 16 * 1024;
const MAX_TRANSCRIPT_TAIL = 1024 * 1024;
const MAX_AGE_MS = 10 * 60 * 1000;
const MAX_OPERATIONS = 10;
const MAX_RECEIPTS = 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keep internal whitespace byte-for-byte; a transcript delimiter is not an argument. */
export function canonicalInstruction(prompt: unknown): string | undefined {
  if (typeof prompt !== "string" || !prompt.isWellFormed() || Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES || !prompt.startsWith(INSTRUCTION_PREFIX)) return;
  const rest = prompt.slice(INSTRUCTION_PREFIX.length);
  if (rest && !/^\s/u.test(rest)) return;
  const args = rest.trim();
  if (/[<>&]/u.test(args) || Buffer.from(args).includes(0)) return;
  return args;
}
export function instructionHash(args: string): string {
  return createHash("sha256").update(INSTRUCTION_PREFIX).update(Buffer.from([0])).update(args).digest("hex");
}
export interface PendingInstruction {
  session: string; promptId: string; transcript: string; home: string; cwd: string; project: string; hash: string; peer?: string;
}
interface Row {
  id: string; session: string; prompt_id: string; transcript: string; home: string; cwd: string; project: string; hash: string; peer: string | null; created: number; state: string; uses: number; record_uuid: string | null;
}
export interface ConfirmedInstruction { id: string; session: string; args: string; peer?: string }
/** Supplied by the daemon from its own session and managed-home inventory, never from a control message. */
export interface InstructionSessionEvidence { session: string; transcript: string; home: string; cwd: string; peer: string }
export type InstructionEvidence = (session: string, peer: string) => Promise<InstructionSessionEvidence | undefined>;

/** Session transcript must be its own file under this home's exact project directory. */
function transcriptTail(row: Row): string | undefined {
  if (!UUID.test(row.session) || !isAbsolute(row.home) || !isAbsolute(row.cwd) || !isAbsolute(row.transcript)) return;
  let fd: number | undefined;
  try {
    const home = realPath(row.home), cwd = realPath(row.cwd);
    const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const expected = join(home, "projects", slug, `${row.session}.jsonl`);
    if (row.transcript !== expected || realPath(expected) !== expected) return;
    fd = openSync(expected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) return;
    const start = Math.max(0, stat.size - MAX_TRANSCRIPT_TAIL);
    const bytes = Buffer.alloc(stat.size - start);
    const n = readSync(fd, bytes, 0, bytes.length, start);
    let data = bytes.subarray(0, n);
    if (start) { const newline = data.indexOf(10); if (newline < 0) return; data = data.subarray(newline + 1); }
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch { return; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function commandRecord(raw: unknown, row: Row, now: number): { uuid: string; args: string } | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const record = raw as Record<string, any>, message = record.message;
  if (record.type !== "user" || (record.isMeta !== undefined && record.isMeta !== false) || record.isSidechain !== false || record.origin?.kind !== "human" || Object.hasOwn(record, "promptSource")
    || record.sessionId !== row.session || record.cwd !== row.cwd || !INSTRUCTION_PROBED_VERSIONS.includes(record.version as typeof INSTRUCTION_PROBED_VERSIONS[number]) || record.promptId !== row.prompt_id || !UUID.test(record.uuid ?? "") || !message || message.role !== "user" || typeof message.content !== "string") return;
  if (typeof record.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(record.timestamp)) return;
  const at = Date.parse(record.timestamp);
  if (!Number.isFinite(at) || at < row.created || at > now) return;
  const match = /^<command-message>agent-hub:ahub<\/command-message>\n<command-name>\/agent-hub:ahub<\/command-name>\n<command-args>([\s\S]*)<\/command-args>$/.exec(message.content);
  if (!match) return;
  const args = canonicalInstruction(`${INSTRUCTION_PREFIX} ${match[1]!}`);
  if (args === undefined || instructionHash(args) !== row.hash) return;
  return { uuid: record.uuid.toLowerCase(), args };
}

/** Private local state. No caller receives prompt text until host-only confirmation. */
export class InstructionReceipts {
  private readonly db: Database;
  private readonly exactLeases = new Map<string, { session: string; created: number }>();
  constructor(path: string, private readonly evidence: InstructionEvidence, private readonly clock: () => number = Date.now) {
    this.db = openHubDatabase(path, { create: true });
    this.db.run(`CREATE TABLE IF NOT EXISTS instruction_receipts (
      id TEXT PRIMARY KEY, session TEXT NOT NULL, prompt_id TEXT NOT NULL, transcript TEXT NOT NULL, home TEXT NOT NULL, cwd TEXT NOT NULL, project TEXT NOT NULL,
      hash TEXT NOT NULL, peer TEXT, created INTEGER NOT NULL, state TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 0, record_uuid TEXT UNIQUE)`);
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS instruction_prompt_id ON instruction_receipts(session, prompt_id)");
    this.db.run("CREATE TABLE IF NOT EXISTS instructed_mode (id INTEGER PRIMARY KEY CHECK (id = 1), mode TEXT NOT NULL)");
  }
  close(): void { this.exactLeases.clear(); this.db.close(); }
  /** A new witness inherits an off or exact display copy; a retained witness always wins. */
  seedMode(display: () => "off" | "exact" | "intent" | undefined): void {
    if (this.db.query("SELECT 1 FROM instructed_mode WHERE id = 1").get()) return;
    const value = display();
    if (value === "off" || value === "exact") this.db.query("INSERT OR IGNORE INTO instructed_mode(id, mode) VALUES(1, ?)").run(value);
  }
  /** Missing witness uses the shipped default; malformed retained state never enables the tier. */
  mode(): "off" | "exact" | "intent" {
    const row = this.db.query("SELECT mode FROM instructed_mode WHERE id = 1").get() as { mode: unknown } | null;
    if (!row) return "intent";
    if (row.mode !== "off" && row.mode !== "exact" && row.mode !== "intent") throw new Error("instructed mode witness is invalid");
    return row.mode;
  }
  hasIntentWitness(): boolean {
    const row = this.db.query("SELECT mode FROM instructed_mode WHERE id = 1").get() as { mode: unknown } | null;
    if (!row) return false;
    if (row.mode !== "off" && row.mode !== "exact" && row.mode !== "intent") throw new Error("instructed mode witness is invalid");
    return row.mode === "intent";
  }
  setMode(value: "off" | "exact" | "intent"): void {
    if (value !== "off" && value !== "exact" && value !== "intent") throw new Error("invalid instructed mode");
    this.db.query("INSERT INTO instructed_mode(id, mode) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET mode = excluded.mode").run(value);
  }
  pending(value: PendingInstruction, now: number): boolean {
    if (!UUID.test(value.session) || !UUID.test(value.promptId)
      || !/^[0-9a-f]{64}$/.test(value.hash) || !Number.isSafeInteger(now) || now < 0 || !isAbsolute(value.home) || !isAbsolute(value.cwd) || !isAbsolute(value.project) || !isAbsolute(value.transcript)
      || [value.home, value.cwd, value.project, value.transcript].some(path => path.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(path))
      || value.peer !== undefined && !/^[a-z][a-z0-9_-]{0,63}$/.test(value.peer)) return false;
    return this.db.transaction(() => {
      for (const [id, lease] of this.exactLeases) if (lease.created <= now - MAX_AGE_MS || lease.created > now) this.exactLeases.delete(id);
      this.db.query("DELETE FROM instruction_receipts WHERE created <= ?").run(now - MAX_AGE_MS);
      const count = this.db.query("SELECT COUNT(*) AS n FROM instruction_receipts").get() as { n: number };
      if (count.n >= MAX_RECEIPTS) return false;
      return this.db.query("INSERT OR IGNORE INTO instruction_receipts(id, session, prompt_id, transcript, home, cwd, project, hash, peer, created, state) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')")
        .run(randomUUID(), value.session, value.promptId, value.transcript, value.home, value.cwd, value.project, value.hash, value.peer ?? null, now).changes === 1;
    })();
  }
  forPeer(peer: string): { confirmReceipt(session: string, now: number): Promise<ConfirmedInstruction | undefined>; confirmIntent(session: string, now: number): Promise<ConfirmedInstruction | undefined> } {
    return { confirmReceipt: (session, now) => this.confirmForPeer(session, now, peer).catch(() => undefined), confirmIntent: (session, now) => this.confirmForPeer(session, now, peer, true).catch(() => undefined) };
  }
  private async confirmForPeer(session: string, now: number, peer: string, reusable = false): Promise<ConfirmedInstruction | undefined> {
    if (!UUID.test(session) || !Number.isSafeInteger(now) || !/^[a-z][a-z0-9_-]{0,63}$/.test(peer)) return;
    const evidence = await this.evidence(session, peer);
    if (!evidence || evidence.session !== session || evidence.peer !== peer) return;
    this.db.query("UPDATE instruction_receipts SET state = 'closed' WHERE state != 'closed' AND (created <= ? OR created > ?)").run(now - MAX_AGE_MS, now);
    let rows = this.db.query(reusable ? "SELECT * FROM instruction_receipts WHERE session = ? ORDER BY created DESC, id DESC" : "SELECT * FROM instruction_receipts WHERE session = ? AND state = 'pending' ORDER BY created, id").all(session) as Row[];
    if (reusable && rows[0] && rows[1]?.created === rows[0].created) return; // Equal timestamps do not establish which instruction is current.
    if (reusable) rows = rows.slice(0, 1);
    if (rows.length === 0 || reusable && rows[0]!.state === "closed") return;
    const boundEvidence = { ...rows[0], session, home: evidence.home, cwd: evidence.cwd, transcript: evidence.transcript } as Row;
    const tail = transcriptTail(boundEvidence); if (tail === undefined) return;
    const lines = tail.split("\n");
    const byPrompt = new Map<string, unknown[]>();
    for (const line of lines) {
      let parsed: unknown; try { parsed = JSON.parse(line); } catch { continue; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const id = (parsed as { promptId?: unknown }).promptId;
      if (typeof id !== "string") continue;
      const bucket = byPrompt.get(id) ?? []; bucket.push(parsed); byPrompt.set(id, bucket);
    }
    for (const row of rows) {
      if (now < row.created || now - row.created >= MAX_AGE_MS || (row.peer !== null && row.peer !== peer) || row.transcript !== evidence.transcript) continue;
      const bound = { ...row, home: evidence.home, cwd: evidence.cwd, transcript: evidence.transcript };
      const candidates: { uuid: string; args: string; at: number }[] = [];
      for (const parsed of byPrompt.get(row.prompt_id) ?? []) {
        const record = commandRecord(parsed, bound, now); if (!record) continue;
        candidates.push({ ...record, at: Date.parse((parsed as { timestamp: string }).timestamp) });
      }
      candidates.sort((a, b) => a.at - b.at || a.uuid.localeCompare(b.uuid));
      for (const record of candidates) {
        const current = await this.evidence(session, peer);
        const checkedAt = this.clock();
        if (!Number.isSafeInteger(checkedAt) || checkedAt < now || checkedAt - row.created >= MAX_AGE_MS) {
          this.db.query("UPDATE instruction_receipts SET state = 'closed' WHERE id = ?").run(row.id);
          return;
        }
        if (!current || current.session !== evidence.session || current.peer !== evidence.peer || current.home !== evidence.home || current.cwd !== evidence.cwd || current.transcript !== evidence.transcript) return;
        const refreshed = transcriptTail(bound);
        if (refreshed !== tail) return;
        const finalAt = this.clock();
        if (!Number.isSafeInteger(finalAt) || finalAt < checkedAt || finalAt - row.created >= MAX_AGE_MS) {
          this.db.query("UPDATE instruction_receipts SET state = 'closed' WHERE id = ?").run(row.id);
          return;
        }
        if (reusable && row.state === "confirmed" && row.peer === peer && row.record_uuid === record.uuid) {
          const stillOpen = this.db.query("SELECT 1 FROM instruction_receipts WHERE id = ? AND state = 'confirmed' AND peer = ? AND record_uuid = ?").get(row.id, peer, record.uuid);
          if (stillOpen) return { id: row.id, session, args: record.args, peer };
          continue;
        }
        const changed = this.db.query("UPDATE instruction_receipts SET state = 'confirmed', record_uuid = ?, peer = ? WHERE id = ? AND state = 'pending' AND NOT EXISTS (SELECT 1 FROM instruction_receipts WHERE record_uuid = ?)")
          .run(record.uuid, peer, row.id, record.uuid);
        if (changed.changes === 1) return { id: row.id, session, args: record.args, ...(row.peer ? { peer: row.peer } : {}) };
      }
    }
  }
  consume(id: string, now: number): boolean {
    if (!Number.isSafeInteger(now) || now < 0) return false;
    this.db.query("UPDATE instruction_receipts SET state = 'closed' WHERE id = ? AND state != 'closed' AND (created <= ? OR created > ?)").run(id, now - MAX_AGE_MS, now);
    return this.db.query("UPDATE instruction_receipts SET uses = uses + 1, state = CASE WHEN uses + 1 >= ? THEN 'closed' ELSE state END WHERE id = ? AND state = 'confirmed' AND created <= ? AND created > ? AND uses < ?")
      .run(MAX_OPERATIONS, id, now, now - MAX_AGE_MS, MAX_OPERATIONS).changes === 1;
  }
  /** Exact mode closes the durable receipt before the effect; a host-only lease tracks an in-flight stop. */
  consumeExact(id: string, now: number): boolean {
    if (!Number.isSafeInteger(now) || now < 0) return false;
    const row = this.db.query("UPDATE instruction_receipts SET uses = 1, state = 'closed' WHERE id = ? AND state = 'confirmed' AND uses = 0 AND created <= ? AND created > ? RETURNING session, created")
      .get(id, now, now - MAX_AGE_MS) as { session: string; created: number } | null;
    if (!row) return false;
    this.exactLeases.set(id, row);
    return true;
  }
  /** Serialize intent operations and retain a revocable lease even for the tenth use. */
  consumeIntent(id: string, now: number): boolean {
    if (!Number.isSafeInteger(now) || now < 0 || this.exactLeases.has(id)) return false;
    const row = this.db.query("UPDATE instruction_receipts SET uses = uses + 1, state = CASE WHEN uses + 1 >= ? THEN 'closed' ELSE state END WHERE id = ? AND state = 'confirmed' AND created <= ? AND created > ? AND uses < ? RETURNING session, created")
      .get(MAX_OPERATIONS, id, now, now - MAX_AGE_MS, MAX_OPERATIONS) as { session: string; created: number } | null;
    if (!row) return false;
    this.exactLeases.set(id, row);
    return true;
  }
  exactCurrent(id: string, now: number): boolean {
    const lease = this.exactLeases.get(id);
    return !!lease && Number.isSafeInteger(now) && now >= lease.created && now - lease.created < MAX_AGE_MS;
  }
  finishExact(id: string): void { this.exactLeases.delete(id); }
  stop(session: string, peer?: string): void {
    if (!UUID.test(session)) return;
    for (const [id, lease] of this.exactLeases) if (lease.session === session) this.exactLeases.delete(id);
    this.db.query("UPDATE instruction_receipts SET state = 'closed' WHERE session = ? AND state != 'closed' AND (? IS NULL OR peer IS NULL OR peer = ?)").run(session, peer ?? null, peer ?? null);
  }
}
