import { createHash } from "node:crypto";
import { openHubDatabase, type Database } from "./db-schema.ts";
import { isNativeModelToken } from "../adapters/model-token.ts";
import type { ModelOverrideSelection } from "../adapters/registry-types.ts";

export interface ModelOverrideRow { peer: string; model: string; setAt: number; by: "person" }
export type ModelSource = "override" | "instance" | "launch" | "native default";
export interface RuntimeModelStatus {
  peer: string;
  effectiveModel: string | null;
  source: ModelSource;
  desiredModel: string | null;
  pendingNextTurn: boolean;
  unsupported?: { reasonCode: "unverified_setter" | "unmanaged_attachment"; kind?: string; reason: string; nextStep: string };
}
const MAX_OVERRIDE_ROWS = 128;
const peerToken = (peer: unknown): peer is string => typeof peer === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(peer);
const invalid = () => new Error("model override state is invalid; inspect hub.db or clear the override with ahub model clear");
function row(value: unknown): ModelOverrideRow {
  if (!value || typeof value !== "object") throw invalid();
  const entry = value as Record<string, unknown>;
  if (!peerToken(entry.peer) || !isNativeModelToken(entry.model) || !Number.isSafeInteger(entry.set_at) || Number(entry.set_at) < 0 || entry.by !== "person") throw invalid();
  return { peer: entry.peer, model: entry.model, setAt: Number(entry.set_at), by: "person" };
}
const columns = "CASE WHEN typeof(peer)='text' AND length(CAST(peer AS BLOB))<=32 THEN peer END AS peer,CASE WHEN typeof(model)='text' AND length(CAST(model AS BLOB))<=128 THEN model END AS model,CASE WHEN typeof(set_at)='integer' AND set_at>=0 THEN set_at END AS set_at,CASE WHEN typeof(\"by\")='text' AND \"by\"='person' THEN 'person' END AS \"by\"";
/** Runtime state only: no configuration writes, native calls or authority grants. */
export class ModelOverrides {
  private readonly db: Database;
  private readonly revisions = new Map<string, number>();
  constructor(dbPath: string) {
    this.db = openHubDatabase(dbPath, { create: true });
    try { this.db.run('CREATE TABLE IF NOT EXISTS model_overrides(peer TEXT PRIMARY KEY,model TEXT NOT NULL,set_at INTEGER NOT NULL,"by" TEXT NOT NULL)'); }
    catch (error) { this.db.close(); throw error; }
  }
  get(peer: string): ModelOverrideRow | undefined {
    if (!peerToken(peer)) throw invalid();
    const found = this.db.query(`SELECT ${columns} FROM model_overrides WHERE peer=?`).get(peer);
    return found ? row(found) : undefined;
  }
  list(): ModelOverrideRow[] {
    const rows = this.db.query(`SELECT ${columns} FROM model_overrides ORDER BY peer LIMIT ?`).all(MAX_OVERRIDE_ROWS + 1);
    if (rows.length > MAX_OVERRIDE_ROWS) throw invalid();
    return rows.map(row);
  }
  revision(peer: string): string { return JSON.stringify([this.revisions.get(peer) ?? 0, this.get(peer) ?? null]); }
  set(peer: string, model: string, setAt = Date.now()): ModelOverrideRow {
    if (!peerToken(peer) || !isNativeModelToken(model) || !Number.isSafeInteger(setAt) || setAt < 0) throw new Error("invalid model selection; use a peer id and a bounded native model token, then retry ahub model set");
    if (!this.get(peer) && this.list().length >= MAX_OVERRIDE_ROWS) throw new Error("model override capacity reached; clear unused peer overrides before adding another");
    this.db.query('INSERT INTO model_overrides(peer,model,set_at,"by") VALUES(?,?,?,?) ON CONFLICT(peer) DO UPDATE SET model=excluded.model,set_at=excluded.set_at,"by"=excluded."by"').run(peer, model, setAt, "person");
    this.revisions.set(peer, (this.revisions.get(peer) ?? 0) + 1);
    return { peer, model, setAt, by: "person" };
  }
  clear(peer: string): boolean {
    if (!peerToken(peer)) throw invalid();
    const changed = this.db.query("DELETE FROM model_overrides WHERE peer=?").run(peer).changes > 0;
    if (changed) this.revisions.set(peer, (this.revisions.get(peer) ?? 0) + 1);
    return changed;
  }
  hasRecords(): boolean { return this.db.query("SELECT 1 FROM model_overrides LIMIT 1").get() !== null; }
  integrity(): { count: number; digest: string } {
    const rows = this.list();
    return { count: rows.length, digest: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
  }
  close(): void { this.db.close(); }
}
interface Captured {
  owner: object;
  turn: object;
  revision: string;
  model: string | undefined;
  selection: ModelOverrideSelection;
}
/** Selected and acknowledged are separate. A later desired write never changes a turn's captured selection. */
export class ModelOverrideLatches {
  private readonly captured = new Map<string, Captured>();
  private readonly acknowledged = new Map<string, { owner: object; revision: string | undefined; model: string | undefined; source: "override" | "native default" }>();
  constructor(private readonly store: ModelOverrides) {}
  capture(peer: string, owner: object, turn: object, current: () => boolean): ModelOverrideSelection {
    const previous = this.captured.get(peer);
    if (previous?.owner === owner && previous.turn === turn) return previous.selection;
    const revision = this.store.revision(peer), model = this.store.get(peer)?.model;
    const capture: Captured = { owner, turn, revision, model, selection: { model, applied: (nativeModel?: string) => {
      if (this.captured.get(peer) !== capture) return;
      try { if (!current()) return; } catch { return; }
      const hint = model === undefined && isNativeModelToken(nativeModel) ? nativeModel : undefined;
      this.acknowledged.set(peer, { owner, revision, model: model ?? hint, source: hint === undefined ? "override" : "native default" });
    } } };
    this.captured.set(peer, capture);
    return capture.selection;
  }
  status(peer: string, owner: object | undefined, fallback: { model?: string; source: Exclude<ModelSource, "override"> }, unsupported?: RuntimeModelStatus["unsupported"]): RuntimeModelStatus {
    const desired = this.store.get(peer), applied = this.acknowledged.get(peer);
    const active = !unsupported && applied?.owner === owner ? applied : undefined;
    const effective = active?.model;
    return { peer, effectiveModel: effective ?? fallback.model ?? null, source: effective === undefined ? fallback.source : active!.source, desiredModel: desired?.model ?? null,
      pendingNextTurn: !unsupported && (desired !== undefined || active !== undefined) && active?.revision !== this.store.revision(peer),
      ...(unsupported ? { unsupported } : {}) };
  }
  forget(peer: string): void { this.captured.delete(peer); this.acknowledged.delete(peer); }
  end(peer: string): void { this.captured.delete(peer); }
  observeNative(peer: string, owner: object, model: string): void {
    if (!isNativeModelToken(model)) return;
    this.acknowledged.set(peer, { owner, model, source: "native default", revision: this.store.get(peer) ? undefined : this.store.revision(peer) });
  }
}
