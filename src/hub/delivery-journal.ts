import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { BusSnapshot } from "./bus.ts";
import type { QueuePressure } from "./queue-backpressure.ts";
import { HUB, USER, type Envelope, type Kind } from "./envelope.ts";
import { heldDeliveryHints } from "./delivery-hints.ts";
import { processLiveness } from "../pi/process-signature.ts";
import { HUB_DB_BUSY_TIMEOUT_MS } from "./db-timeout.ts";
import { parseRemotePeerId } from "../rooms/application.ts";
import { validateDeferredHub } from "./deferred-hub.ts";

export type JournalDeliveryState =
  | "queued"
  | "dispatching"
  | "accepted"
  | "completed"
  | "needs_review"
  | "failed"
  | "discarded";
export type JournalResolution = "completed" | "retry" | "discard";
export const MAX_ENVELOPE_BODY = 1_000_000;
export const TERMINAL_CAP = 2048;
const SCHEMA_VERSION = 1,
  MAX_ROWS = 100_000,
  MAX_JSON = 20 * 1024 * 1024;
const STATES = new Set<JournalDeliveryState>([
  "queued",
  "dispatching",
  "accepted",
  "completed",
  "needs_review",
  "failed",
  "discarded",
]);
const ACTIONS = new Set<JournalResolution>(["completed", "retry", "discard"]);
// Hub presence ids survive context merges; they are not immutable attempted work.
const retryOriginals = (originals: readonly Envelope[]): Envelope[] => originals.filter(env => env.from !== HUB || env.kind !== "presence");

export interface JournalDelivery {
  id: string;
  peer: string;
  state: JournalDeliveryState;
  revision: number;
  createdAt: number;
  updatedAt: number;
  originals: Envelope[];
  out: Envelope[];
  reason?: string;
  attempt?: number;
  previousId?: string;
}
export interface DeliveryJournalOptions {
  file: string;
  projectRoot: string;
  projectId: string;
  instanceId: string;
  operationId?: string;
  /** Accepted live history target; only terminal mutations apply it, other pruning keeps the legacy cap. */
  terminalHistoryLimit?: () => number;
}
export interface JournalSnapshot {
  schemaVersion: number;
  revision: number;
  instanceId: string;
  bus: BusSnapshot;
  deliveries: JournalDelivery[];
  manualPaused: string[];
}

function fail(message: string): never {
  throw new Error(`invalid delivery journal: ${message}`);
}
function obj(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max = 4096): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max)
    fail(`${name} must be a non-empty string`);
  return value;
}
function integer(
  value: unknown,
  name: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    fail(`${name} is out of range`);
  return value as number;
}
function list(value: unknown, name: string, max = MAX_ROWS): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    fail(`${name} must be an array`);
  return value;
}
function checkedJSON(value: unknown, name: string): unknown {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    fail(`${name} is not serializable`);
  }
  if (encoded.length > MAX_JSON) fail(`${name} is too large`);
  return value;
}

function validateEnvelope(value: unknown, name: string, seen = false): Envelope {
  const e = obj(value, name);
  text(e.id, `${name}.id`, 256);
  text(e.trace, `${name}.trace`, 256);
  text(e.from, `${name}.from`, 256);
  integer(e.hop, `${name}.hop`, 0, seen ? Number.MAX_SAFE_INTEGER : 3);
  if (typeof e.body !== "string" || e.body.length > MAX_ENVELOPE_BODY) fail(`${name}.body is invalid`);
  integer(e.ts, `${name}.ts`);
  if (
    !new Set(["chat", "task", "review", "status", "budget", "presence"]).has(
      e.kind as string,
    )
  )
    fail(`${name}.kind is invalid`);
  if (!new Set(["important", "status", "fyi"]).has(e.priority as string))
    fail(`${name}.priority is invalid`);
  if (e.to !== undefined)
    for (const p of list(e.to, `${name}.to`, 256)) text(p, `${name}.to[]`, 256);
  if (e.private !== undefined && typeof e.private !== "boolean")
    fail(`${name}.private is invalid`);
  if (e.refs !== undefined) {
    const refs = obj(e.refs, `${name}.refs`);
    for (const k of ["repo", "branch", "commit", "task"])
      if (refs[k] !== undefined) text(refs[k], `${name}.refs.${k}`);
    if (refs.paths !== undefined)
      for (const p of list(refs.paths, `${name}.refs.paths`, 256))
        text(p, `${name}.refs.paths[]`);
  }
  return e as unknown as Envelope;
}
function validateBus(value: unknown, name = "bus"): BusSnapshot {
  const b = obj(value, name);
  if (b.schemaVersion !== 1) fail(`${name}.schemaVersion is unsupported`);
  const queues = obj(b.queues, `${name}.queues`);
  if (Object.keys(queues).length > 4096) fail(`${name}.queues is too large`);
  for (const [peer, items] of Object.entries(queues)) {
    text(peer, `${name}.queues key`, 256);
    list(items, `${name}.queues.${peer}`, 2048).forEach((e, i) =>
      validateEnvelope(e, `${name}.queues.${peer}[${i}]`),
    );
  }
  const prefaces = obj(b.prefaces, `${name}.prefaces`);
  for (const [peer, e] of Object.entries(prefaces)) {
    text(peer, `${name}.prefaces key`, 256);
    validateEnvelope(e, `${name}.prefaces.${peer}`);
  }
  list(b.seen, `${name}.seen`, 2048).forEach((e, i) =>
    validateEnvelope(e, `${name}.seen[${i}]`, true),
  );
  const attempts = obj(b.attempts, `${name}.attempts`);
  for (const [k, n] of Object.entries(attempts)) {
    text(k, `${name}.attempts key`);
    integer(n, `${name}.attempts.${k}`, 1, 100);
  }
  list(b.withdrawn, `${name}.withdrawn`, 100_000).forEach((id) =>
    text(id, `${name}.withdrawn[]`, 256),
  );
  if (b.manualPaused !== undefined)
    list(b.manualPaused, `${name}.manualPaused`, 4096).forEach((id) =>
      text(id, `${name}.manualPaused[]`, 256),
    );
  if (b.remoteQueueMembers !== undefined) {
    const members = obj(b.remoteQueueMembers, `${name}.remoteQueueMembers`);
    if (Object.keys(members).length > 12800) fail(`${name}.remoteQueueMembers is too large`);
    for (const [peer, member] of Object.entries(members)) {
      if (!parseRemotePeerId(peer) || !Array.isArray(queues[peer]) || typeof member !== "string" || !/^[0-9a-f]{64}$/.test(member)) fail(`${name}.remoteQueueMembers is invalid`);
    }
  }
  if (b.remoteQueueRooms !== undefined) {
    const rooms = obj(b.remoteQueueRooms, `${name}.remoteQueueRooms`);
    if (Object.keys(rooms).length > 12800) fail(`${name}.remoteQueueRooms is too large`);
    for (const [peer, room] of Object.entries(rooms)) {
      if (!parseRemotePeerId(peer) || !Array.isArray(queues[peer])) fail(`${name}.remoteQueueRooms key is invalid`);
      text(room, `${name}.remoteQueueRooms room`, 256);
    }
  }
  if (b.remoteQueueExpires !== undefined) {
    const expiries = obj(b.remoteQueueExpires, `${name}.remoteQueueExpires`);
    if (Object.keys(expiries).length > 4096) fail(`${name}.remoteQueueExpires is too large`);
    let count = 0;
    for (const [peer, values] of Object.entries(expiries)) {
      if (!parseRemotePeerId(peer)) fail(`${name}.remoteQueueExpires key is invalid`);
      const entries = Object.entries(obj(values, `${name}.remoteQueueExpires.${peer}`));
      if (entries.length > 200 || (count += entries.length) > 12800) fail(`${name}.remoteQueueExpires is too large`);
      for (const [id, expiry] of entries) { text(id, `${name}.remoteQueueExpires id`, 256); integer(expiry, `${name}.remoteQueueExpires expiry`); }
    }
  }
  const occupied = new Set<string>([
    ...(b.seen as Envelope[]).map(env => env.id),
    ...Object.values(queues).flatMap(items => (items as Envelope[]).map(env => env.id)),
  ]);
  validateDeferredHub(b.deferredHub, validateEnvelope, occupied, `${name}.deferredHub`);
  if (b.journal !== undefined) fail("nested journal snapshot is invalid");
  return b as unknown as BusSnapshot;
}
function validateDelivery(value: unknown, name = "delivery"): JournalDelivery {
  const d = obj(value, name);
  text(d.id, `${name}.id`, 256);
  text(d.peer, `${name}.peer`, 256);
  if (!STATES.has(d.state as JournalDeliveryState))
    fail(`${name}.state is invalid`);
  integer(d.revision, `${name}.revision`);
  integer(d.createdAt, `${name}.createdAt`);
  integer(d.updatedAt, `${name}.updatedAt`);
  const originals = list(d.originals, `${name}.originals`, 2048).map((e, i) =>
    validateEnvelope(e, `${name}.originals[${i}]`),
  );
  const out = list(d.out, `${name}.out`, 2048).map((e, i) =>
    validateEnvelope(e, `${name}.out[${i}]`),
  );
  if (d.reason !== undefined) text(d.reason, `${name}.reason`, 1_000_000);
  if (d.attempt !== undefined) integer(d.attempt, `${name}.attempt`, 0, 100);
  if (d.previousId !== undefined) text(d.previousId, `${name}.previousId`, 256);
  return {
    id: d.id as string,
    peer: d.peer as string,
    state: d.state as JournalDeliveryState,
    revision: d.revision as number,
    createdAt: d.createdAt as number,
    updatedAt: d.updatedAt as number,
    originals,
    out,
    ...(d.reason === undefined ? {} : { reason: d.reason as string }),
    ...(d.attempt === undefined ? {} : { attempt: d.attempt as number }),
    ...(d.previousId === undefined
      ? {}
      : { previousId: d.previousId as string }),
  };
}
/** Validate an externally supplied restart journal before it can affect a database. */
export function validateJournalSnapshot(
  value: unknown,
): value is JournalSnapshot {
  const s = obj(value, "snapshot");
  if (s.schemaVersion !== SCHEMA_VERSION)
    fail("snapshot.schemaVersion is unsupported");
  integer(s.revision, "snapshot.revision");
  text(s.instanceId, "snapshot.instanceId", 256);
  validateBus(s.bus);
  list(s.manualPaused, "snapshot.manualPaused", 4096).forEach((id) =>
    text(id, "snapshot.manualPaused[]", 256),
  );
  const deliveries = list(s.deliveries, "snapshot.deliveries").map((d, i) =>
    validateDelivery(d, `snapshot.deliveries[${i}]`),
  );
  const ids = new Set<string>();
  for (const d of deliveries) {
    if (ids.has(d.id)) fail(`duplicate delivery ${d.id}`);
    ids.add(d.id);
  }
  return true;
}

export class DeliveryJournal {
  readonly file: string;
  readonly projectRoot: string;
  readonly projectId: string;
  readonly instanceId: string;
  private readonly db: Database;
  private closed = false;
  private queueMetadataTracking = false;
  private queueMetadataInvalidated = false;
  private pruningDeferred = 0;
  private readonly operationId?: string;
  private readonly terminalHistoryLimit?: () => number;
  constructor(options: DeliveryJournalOptions) {
    this.file = options.file;
    this.projectRoot = text(options.projectRoot, "projectRoot", 4096);
    this.projectId = text(options.projectId, "projectId", 256);
    this.instanceId = text(options.instanceId, "instanceId", 256);
    this.operationId = options.operationId;
    this.terminalHistoryLimit = options.terminalHistoryLimit;
    mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 });
    this.db = new Database(options.file, { create: true });
    this.db.run(`PRAGMA busy_timeout = ${HUB_DB_BUSY_TIMEOUT_MS}`);
    this.harden();
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = FULL");
    this.createSchema();
    const meta = this.readMeta();
    if (!meta)
      this.db
        .query(
          "INSERT INTO delivery_meta (project_id, project_root, revision, instance_id, operation_id, retry_history_cursor) VALUES (?, ?, 0, ?, ?, 0)",
        )
        .run(
          this.projectId,
          this.projectRoot,
          this.instanceId,
          this.operationId ?? null,
        );
    else {
      this.validateStored(meta);
      this.rejectLiveOwner(meta);
      this.db.transaction(() => {
        this.db
          .query(
            "UPDATE delivery_meta SET project_root = ?, instance_id = ?, operation_id = COALESCE(?, operation_id) WHERE project_id = ?",
          )
          .run(
            this.projectRoot,
            this.instanceId,
            this.operationId ?? null,
            this.projectId,
          );
        // A new daemon cannot infer completion of an old process's handoffs, including
        // controlled restarts with silent native/bridge receipts still outstanding.
        for (const row of this.db.query("SELECT * FROM task_offer_reads WHERE project_id = ?").all(this.projectId) as Record<string, unknown>[]) this.validateOfferRead(row);
        this.recoverRetryHistory(meta);
        this.recoverRetryEvidence();
        this.recoverInterrupted();
      })();
    }
  }
  private harden(): void {
    chmodSync(this.file, 0o600);
    for (const suffix of ["-wal", "-shm"])
      if (existsSync(`${this.file}${suffix}`))
        chmodSync(`${this.file}${suffix}`, 0o600);
    try {
      chmodSync(dirname(this.file), 0o700);
    } catch {
      /* caller may own parent */
    }
  }
  private createSchema(): void {
    this.db.run(
      `CREATE TABLE IF NOT EXISTS delivery_meta (project_id TEXT PRIMARY KEY, project_root TEXT, schema_version INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL, instance_id TEXT NOT NULL, operation_id TEXT, manual_paused TEXT NOT NULL DEFAULT '[]', bus_snapshot TEXT NOT NULL DEFAULT '{}')`,
    );
    for (const [column, definition] of [
      ["project_root", "TEXT"],
      ["schema_version", "INTEGER NOT NULL DEFAULT 1"],
      ["operation_id", "TEXT"],
      ["retry_unknown_ids", "TEXT NOT NULL DEFAULT '{}'"],
      ["retry_history_cursor", "INTEGER NOT NULL DEFAULT 0"],
    ] as const) {
      const columns = this.db
        .query("PRAGMA table_info(delivery_meta)")
        .all() as { name: string }[];
      if (!columns.some((c) => c.name === column))
        this.db.run(
          `ALTER TABLE delivery_meta ADD COLUMN ${column} ${definition}`,
        );
    }
    this.db.run(
      `CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, peer TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, originals TEXT NOT NULL, out_json TEXT NOT NULL, reason TEXT, attempt INTEGER, previous_id TEXT)`,
    );
    this.db.run("CREATE TABLE IF NOT EXISTS delivery_queue_meta_state (project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL)");
    this.db.run("CREATE TABLE IF NOT EXISTS delivery_queue_meta (project_id TEXT NOT NULL, peer TEXT NOT NULL, queued INTEGER NOT NULL, oldest_at INTEGER, unknown_age INTEGER NOT NULL, PRIMARY KEY(project_id,peer))");
    this.db.run("CREATE TABLE IF NOT EXISTS task_offer_reads (project_id TEXT NOT NULL, peer TEXT NOT NULL, envelope_id TEXT NOT NULL, delivery_id TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('adapter','reply','pull')), offer_revision INTEGER NOT NULL CHECK(offer_revision >= 1), PRIMARY KEY(project_id,peer,envelope_id))");
    this.db.run(
      `CREATE TABLE IF NOT EXISTS resolution_history (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, delivery_id TEXT NOT NULL, observed_revision INTEGER NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, result_revision INTEGER NOT NULL, result_state TEXT NOT NULL, UNIQUE(project_id, delivery_id, observed_revision, action, reason))`,
    );
    this.db.run("CREATE TABLE IF NOT EXISTS delivery_retry_evidence (project_id TEXT NOT NULL, peer TEXT NOT NULL, original_id TEXT NOT NULL, proof_id TEXT NOT NULL, warning INTEGER NOT NULL CHECK(warning IN (0,1)), PRIMARY KEY(project_id, peer, original_id))");
    this.db.transaction(() => {
      const resolutionColumns = this.db.query("PRAGMA table_info(resolution_history)").all() as { name: string }[];
      if (!resolutionColumns.some((column) => column.name === "actor")) this.db.run("ALTER TABLE resolution_history ADD COLUMN actor TEXT NOT NULL DEFAULT 'user'");
      if (!resolutionColumns.some((column) => column.name === "peer")) this.db.run("ALTER TABLE resolution_history ADD COLUMN peer TEXT NOT NULL DEFAULT ''");
      if (!resolutionColumns.some((column) => column.name === "original_ids")) this.db.run("ALTER TABLE resolution_history ADD COLUMN original_ids TEXT NOT NULL DEFAULT '[]'");
      this.db.run("CREATE INDEX IF NOT EXISTS resolution_retry_peer ON resolution_history(project_id, peer, action)");
      this.db.run("CREATE INDEX IF NOT EXISTS deliveries_peer ON deliveries(project_id, peer, state)");
      this.db.run("CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries(project_id, created_at, id, peer) WHERE state IN ('queued', 'dispatching', 'accepted', 'needs_review')");
    })();
  }
  private recoverRetryHistory(meta: Record<string, unknown>): void {
    const cursor = Number(meta.retry_history_cursor ?? 0);
    const latest = Number((this.db.query("SELECT COALESCE(MAX(id), 0) AS n FROM resolution_history WHERE project_id = ?").get(this.projectId) as { n: number }).n);
    if (latest > cursor) {
      const legacy = this.db.query("SELECT r.id,d.peer,d.originals FROM resolution_history r LEFT JOIN deliveries d ON d.id = r.delivery_id AND d.project_id = r.project_id WHERE r.project_id = ? AND r.peer = '' AND r.id > ?").all(this.projectId, cursor) as { id: number; peer: string | null; originals: string | null }[];
      for (const row of legacy) if (row.peer && row.originals) this.db.query("UPDATE resolution_history SET peer = ?, original_ids = ? WHERE project_id = ? AND id = ?").run(row.peer, JSON.stringify(retryOriginals(JSON.parse(row.originals) as Envelope[]).map(env => env.id)), this.projectId, row.id);
      // A pruned pre-feature retry cannot be mapped back to its originals. Fence current legacy work only.
      if (this.db.query("SELECT 1 FROM resolution_history WHERE project_id = ? AND action = 'retry' AND peer = '' AND id > ? LIMIT 1").get(this.projectId, cursor)) {
        this.markRetryUnknown(this.list(), JSON.parse(String(meta.bus_snapshot || '{}')));
      }
      this.db.query("UPDATE delivery_meta SET retry_history_cursor = ? WHERE project_id = ?").run(latest, this.projectId);
    }
  }
  private validateRetryProof(row: Record<string, unknown>): void {
    text(row.peer, "retry proof peer", 256); text(row.original_id, "retry proof original", 256); text(row.proof_id, "retry proof id", 256);
    integer(row.warning, "retry proof warning", 0, 1);
  }
  private retryProof(peer: string, originals: readonly Envelope[]): { proof: string; warning: boolean } | undefined {
    originals = retryOriginals(originals);
    if (!originals.length) return undefined;
    const rows = this.db.query("SELECT peer,original_id,proof_id,warning FROM delivery_retry_evidence WHERE project_id = ? AND peer = ? AND original_id IN (SELECT value FROM json_each(?))").all(this.projectId, peer, JSON.stringify(originals.map(env => env.id))) as Record<string, unknown>[];
    for (const row of rows) this.validateRetryProof(row);
    return rows.length ? { proof: String(rows[0]!.proof_id), warning: rows.some(row => row.warning === 1) } : undefined;
  }
  private recordRetryEvidence(peer: string, originals: readonly Envelope[], proof: string, warning: boolean): void {
    const put = this.db.query("INSERT INTO delivery_retry_evidence (project_id,peer,original_id,proof_id,warning) VALUES (?,?,?,?,?) ON CONFLICT(project_id,peer,original_id) DO UPDATE SET warning = MAX(warning,excluded.warning)");
    for (const id of new Set(retryOriginals(originals).map(env => env.id))) put.run(this.projectId, peer, id, proof, warning ? 1 : 0);
  }
  private recoverRetryEvidence(): void {
    for (const row of this.db.query("SELECT peer,original_id,proof_id,warning FROM delivery_retry_evidence WHERE project_id = ?").all(this.projectId) as Record<string, unknown>[]) this.validateRetryProof(row);
    // An older writer can append attempt-bearing rows while this writer is absent.
    const rows = this.db.query("SELECT d.id,d.peer,d.originals FROM deliveries d WHERE d.project_id = ? AND d.attempt > 0 AND EXISTS (SELECT 1 FROM json_each(d.originals) env WHERE NOT EXISTS (SELECT 1 FROM delivery_retry_evidence e WHERE e.project_id = d.project_id AND e.peer = d.peer AND e.original_id = json_extract(env.value,'$.id')))").all(this.projectId) as { id: string; peer: string; originals: string }[];
    for (const row of rows) {
      const originals = retryOriginals(JSON.parse(row.originals) as Envelope[]);
      if (!originals.length) continue;
      const known = this.retryProof(row.peer, originals) || this.db.query("SELECT 1 FROM resolution_history r, json_each(r.original_ids) old, json_each(?) current WHERE r.project_id = ? AND r.peer = ? AND r.action = 'retry' AND old.value = current.value LIMIT 1").get(JSON.stringify(originals.map(env => env.id)), this.projectId, row.peer);
      this.recordRetryEvidence(row.peer, originals, row.id, this.retryWarning(row.peer, originals) || !known);
    }
  }
  private readMeta(): Record<string, unknown> | null {
    return this.db
      .query("SELECT * FROM delivery_meta WHERE project_id = ?")
      .get(this.projectId) as Record<string, unknown> | null;
  }
  private rejectLiveOwner(meta: Record<string, unknown>): void {
    if (String(meta.instance_id) === this.instanceId)
      return;
    const statusPath = dirname(this.file) + "/status.json";
    try {
      const status = JSON.parse(readFileSync(statusPath, "utf8")) as Record<
        string,
        unknown
      >;
      if (
        status.projectId === this.projectId &&
        status.cwd === this.projectRoot &&
        status.instanceId === meta.instance_id &&
        Number.isInteger(status.pid) &&
        Number(status.pid) > 0
      ) {
        // #226: a signed manifest whose pid was reused is gone; with a signature, an owner that cannot be identified is
        // refused like a live one. Unsigned, a pid that cannot be probed (EPERM) never refused here, as before.
        const signature = typeof status.pidSignature === "string" ? status.pidSignature : undefined;
        const owner = processLiveness(Number(status.pid), signature);
        if (owner === "live" || (signature && owner === "unknown"))
          throw new Error("delivery journal is owned by a live instance");
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("owned by a live")) throw e;
    }
  }
  private validateStored(meta: Record<string, unknown>): void {
    if (
      meta.project_root != null &&
      String(meta.project_root) !== this.projectRoot
    )
      fail("project root does not match database");
    if (
      Number(meta.schema_version) !== SCHEMA_VERSION ||
      !Number.isSafeInteger(Number(meta.revision)) ||
      Number(meta.revision) < 0
    )
      fail("metadata is corrupt");
    try {
      const bus = JSON.parse(String(meta.bus_snapshot || "{}"));
      if (!(bus && typeof bus === "object" && Object.keys(bus).length === 0))
        validateBus(bus);
      list(
        JSON.parse(String(meta.manual_paused || "[]")),
        "stored manualPaused",
      );
    } catch (e) {
      throw e instanceof Error &&
        e.message.startsWith("invalid delivery journal")
        ? e
        : new Error("invalid delivery journal: corrupt metadata JSON");
    }
    const rows = this.db
      .query("SELECT * FROM deliveries WHERE project_id = ? LIMIT ?")
      .all(this.projectId, MAX_ROWS) as Record<string, unknown>[];
    for (const row of rows) validateDelivery(parseDelivery(row));
    if (
      rows.length === MAX_ROWS &&
      this.db
        .query("SELECT 1 FROM deliveries WHERE project_id = ? LIMIT 1 OFFSET ?")
        .get(this.projectId, MAX_ROWS)
    )
      fail("too many delivery rows");
  }
  private recoverInterrupted(): void {
    this.db
      .query(
        "UPDATE deliveries SET state = 'needs_review', revision = revision + 1, updated_at = ?, reason = COALESCE(reason, 'daemon stopped during delivery') WHERE project_id = ? AND state IN ('dispatching', 'accepted')",
      )
      .run(Date.now(), this.projectId);
  }
  private ensureOpen(): void {
    if (this.closed) throw new Error("delivery journal is closed");
  }
  private bump(): number {
    const row = this.readMeta();
    if (!row) throw new Error("delivery journal metadata missing");
    if (String(row.instance_id) !== this.instanceId)
      throw new Error("delivery journal instance fence lost");
    const revision = Number(row.revision) + 1;
    this.db
      .query(
        "UPDATE delivery_meta SET revision = ? WHERE project_id = ? AND instance_id = ?",
      )
      .run(revision, this.projectId, this.instanceId);
    if (
      Number(
        (this.db.query("SELECT changes() AS n").get() as { n: number }).n,
      ) !== 1
    )
      throw new Error("delivery journal instance fence lost");
    // New writers carry unchanged summary provenance across non-queue revisions.
    // An older writer does not, so its next revision makes these rows unknown.
    if (this.queueMetadataTracking) this.db.query("UPDATE delivery_queue_meta_state SET revision=? WHERE project_id=? AND revision=?")
      .run(revision, this.projectId, revision - 1);
    return revision;
  }

  /** Atomically accompanies the bus snapshot, never extracts body JSON on a periodic path. */
  private writeQueueMetadata(bus: BusSnapshot, revision: number, tracking: boolean): void {
    if (!tracking) {
      // Invalidate once per disabled period; ordinary revisions already stale old summaries.
      if (!this.queueMetadataInvalidated) {
        this.db.query("UPDATE delivery_queue_meta_state SET revision=-1 WHERE project_id=? AND revision>=0").run(this.projectId);
        this.queueMetadataInvalidated = true;
      }
      return;
    }
    this.db.query("DELETE FROM delivery_queue_meta WHERE project_id=?").run(this.projectId);
    const put = this.db.query("INSERT INTO delivery_queue_meta(project_id,peer,queued,oldest_at,unknown_age) VALUES(?,?,?,?,?)");
    for (const [peer, queue] of Object.entries(bus.queues)) {
      const provenance = bus.queuedAt;
      const times = provenance && typeof provenance === "object" && !Array.isArray(provenance) && Object.hasOwn(provenance, peer) ? provenance[peer] : undefined;
      let oldest: number | undefined, unknown = false;
      for (const env of queue) {
        const at = times && typeof times === "object" && !Array.isArray(times) && Object.hasOwn(times, env.id) ? times[env.id] : null;
        if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) unknown = true;
        else oldest = oldest === undefined ? at : Math.min(oldest, at);
      }
      put.run(this.projectId, peer, queue.length, oldest ?? null, unknown ? 1 : 0);
    }
    this.db.query("INSERT INTO delivery_queue_meta_state(project_id,revision) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision")
      .run(this.projectId, revision);
    this.queueMetadataInvalidated = false;
  }

  /** Host policy only, refreshed before receipt/reply mutations as well as snapshot writes. No SQL. */
  setQueueMetadataTracking(tracking: boolean): void { this.queueMetadataTracking = tracking === true; }

  private queueMetadataTransaction<T>(tracking: boolean, fn: () => T): T {
    return this.transaction(() => { this.setQueueMetadataTracking(tracking); return fn(); });
  }
  private queueMetadataSnapshot(bus: BusSnapshot, tracking: boolean): BusSnapshot {
    if (tracking || bus.queuedAt === undefined) return bus;
    const legacy = { ...bus }; delete legacy.queuedAt;
    return legacy;
  }

  /** Indexed per-peer pending counts/age only, independent of delivery history and payload columns. */
  pendingQueueMetadata(peer: string): QueuePressure | undefined {
    this.ensureOpen();
    const row = this.db.query("SELECT m.revision,s.revision AS metadata_revision,q.peer AS metadata_peer,q.queued,q.oldest_at,q.unknown_age FROM delivery_meta m LEFT JOIN delivery_queue_meta_state s ON s.project_id=m.project_id LEFT JOIN delivery_queue_meta q ON q.project_id=m.project_id AND q.peer=? WHERE m.project_id=?")
      .get(peer, this.projectId) as { revision: number; metadata_revision: number | null; metadata_peer: string | null; queued: number | null; oldest_at: number | null; unknown_age: number | null } | null;
    if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0 || row.metadata_revision !== row.revision) return undefined;
    if (row.metadata_peer === null) return { queued: 0, oldestQueuedAt: null };
    if (typeof row.queued !== "number" || !Number.isSafeInteger(row.queued) || row.queued < 0 || row.queued > 2048 || ![0, 1].includes(row.unknown_age!)) return undefined;
    if (row.queued === 0) return row.oldest_at === null && row.unknown_age === 0 ? { queued: 0, oldestQueuedAt: null } : undefined;
    if (row.unknown_age === 1) return { queued: row.queued };
    if (!Number.isSafeInteger(row.oldest_at) || row.oldest_at! <= 0) return undefined;
    return { queued: row.queued, oldestQueuedAt: row.oldest_at! };
  }
  transaction<T>(fn: () => T): T {
    this.ensureOpen();
    const invalidated = this.queueMetadataInvalidated;
    try { return this.db.transaction(fn)(); }
    catch (error) { this.queueMetadataInvalidated = invalidated; throw error; }
  }
  snapshot(): JournalSnapshot {
    this.ensureOpen();
    const meta = this.readMeta();
    if (!meta) throw new Error("delivery journal metadata missing");
    this.validateStored(meta);
    const rows = this.db
      .query(
        "SELECT * FROM deliveries WHERE project_id = ? ORDER BY created_at, id",
      )
      .all(this.projectId) as Record<string, unknown>[];
    const storedBus = JSON.parse(String(meta.bus_snapshot || "{}"));
    const bus =
      Object.keys(storedBus).length === 0
        ? {
            schemaVersion: 1,
            queues: {},
            prefaces: {},
            seen: [],
            attempts: {},
            withdrawn: [],
          }
        : storedBus;
    const result = {
      schemaVersion: SCHEMA_VERSION,
      revision: Number(meta.revision),
      instanceId: String(meta.instance_id),
      bus,
      manualPaused: JSON.parse(String(meta.manual_paused || "[]")),
      deliveries: rows.map(parseDelivery),
    };
    validateJournalSnapshot(result);
    return result;
  }
  persistBus(bus: unknown, manualPaused: string[], trackQueuePressure = false): number {
    this.ensureOpen();
    let checkedBus = this.queueMetadataSnapshot(validateBus(bus), trackQueuePressure);
    let encodedBus: string;
    try { encodedBus = JSON.stringify(checkedJSON(checkedBus, "bus")); }
    catch (error) {
      if (checkedBus.queuedAt === undefined || !(error instanceof Error) || error.message !== "invalid delivery journal: bus is too large") throw error;
      checkedBus = { ...checkedBus }; delete checkedBus.queuedAt;
      encodedBus = JSON.stringify(checkedJSON(checkedBus, "bus"));
    }
    list(manualPaused, "manualPaused", 4096).forEach((id) =>
      text(id, "manualPaused[]", 256),
    );
    return this.queueMetadataTransaction(trackQueuePressure, () => {
      const revision = this.bump();
      this.db
        .query(
          "UPDATE delivery_meta SET bus_snapshot = ?, manual_paused = ? WHERE project_id = ?",
        )
        .run(
          encodedBus,
          JSON.stringify([...new Set(manualPaused)].sort()),
          this.projectId,
        );
      this.writeQueueMetadata(checkedBus, revision, trackQueuePressure);
      this.harden();
      return revision;
    });
  }
  /** Atomically persist a bus snapshot and any fan-out rows created for that snapshot. */
  persistBusAndDeliveries(
    bus: BusSnapshot,
    manualPaused: string[],
    deliveries: Array<
      Omit<JournalDelivery, "revision" | "updatedAt"> & { updatedAt?: number }
    >,
    trackQueuePressure = false,
  ): number {
    this.ensureOpen();
    bus = this.queueMetadataSnapshot(validateBus(bus), trackQueuePressure);
    list(manualPaused, "manualPaused", 4096).forEach((id) =>
      text(id, "manualPaused[]", 256),
    );
    deliveries.forEach((d) =>
      validateDelivery({
        ...d,
        revision: 0,
        updatedAt: d.updatedAt ?? d.createdAt,
      }),
    );
    return this.queueMetadataTransaction(trackQueuePressure, () => {
      const revision = this.bump();
      this.db
        .query(
          "UPDATE delivery_meta SET bus_snapshot = ?, manual_paused = ? WHERE project_id = ?",
        )
        .run(
          JSON.stringify(bus),
          JSON.stringify([...new Set(manualPaused)].sort()),
          this.projectId,
        );
      this.writeQueueMetadata(bus, revision, trackQueuePressure);
      for (const d of deliveries)
        this.db
          .query(
            "INSERT INTO deliveries (id, project_id, peer, state, revision, created_at, updated_at, originals, out_json, reason, attempt, previous_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            d.id,
            this.projectId,
            d.peer,
            d.state,
            revision,
            d.createdAt,
            d.updatedAt ?? Date.now(),
            JSON.stringify(d.originals),
            JSON.stringify(d.out),
            d.reason ?? null,
            d.attempt ?? null,
            d.previousId ?? null,
          );
      this.harden();
      return revision;
    });
  }
  checkpointDelivery(
    bus: BusSnapshot,
    delivery: Omit<JournalDelivery, "revision" | "updatedAt"> & {
      state: "dispatching";
    },
    trackQueuePressure = false,
  ): JournalDelivery {
    bus = this.queueMetadataSnapshot(validateBus(bus), trackQueuePressure);
    validateDelivery({
      ...delivery,
      revision: 0,
      updatedAt: delivery.createdAt,
    });
    return this.queueMetadataTransaction(trackQueuePressure, () => {
      // Grouped parents are not linked until the handoff INSERT. Keep the whole
      // synchronous transaction intact; ordinary settlement prunes afterward.
      this.pruningDeferred++;
      try {
        const evidence = this.retryEvidence(delivery.peer, delivery.originals);
        if (evidence === "used") {
          // Inheritance commits with the handoff, before safe failure or pruning can erase a grouped parent.
          this.recordRetryEvidence(delivery.peer, delivery.originals, delivery.id, this.retryWarning(delivery.peer, delivery.originals));
          delivery = { ...delivery, attempt: Math.max(1, delivery.attempt ?? 0) };
        } else if (evidence === "unknown") this.markRetryUnknown([{ ...delivery, revision: 0, updatedAt: delivery.createdAt }], {});
        const ids = new Set(delivery.originals.map((env) => env.id)), immutableIds = new Set(retryOriginals(delivery.originals).map(env => env.id));
        for (const row of this.list(delivery.peer)) {
          if (row.state !== "queued" || !row.originals.some((env) => ids.has(env.id))) continue;
          this.transition(row.id, "discarded", `grouped into delivery ${delivery.id}`);
          if (retryOriginals(row.originals).some(env => immutableIds.has(env.id))) {
            delivery = { ...delivery, previousId: delivery.previousId ?? row.id };
            if ((row.attempt ?? 0) > 0) delivery = { ...delivery, attempt: Math.max(delivery.attempt ?? 0, row.attempt!) };
          }
        }
        const revision = this.bump();
        const now = Date.now();
        this.db
          .query(
            "UPDATE delivery_meta SET bus_snapshot = ?, manual_paused = ? WHERE project_id = ?",
          )
          .run(
            JSON.stringify(bus),
            JSON.stringify(bus.manualPaused ?? []),
            this.projectId,
          );
        this.writeQueueMetadata(bus, revision, trackQueuePressure);
        this.db
          .query(
            "INSERT INTO deliveries (id, project_id, peer, state, revision, created_at, updated_at, originals, out_json, reason, attempt, previous_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            delivery.id,
            this.projectId,
            delivery.peer,
            delivery.state,
            revision,
            delivery.createdAt,
            now,
            JSON.stringify(delivery.originals),
            JSON.stringify(delivery.out),
            delivery.reason ?? null,
            delivery.attempt ?? null,
            delivery.previousId ?? null,
          );
        this.harden();
        return { ...delivery, revision, updatedAt: now };
      } finally { this.pruningDeferred--; }
    });
  }
  createDelivery(
    input: Omit<JournalDelivery, "revision" | "updatedAt"> & {
      updatedAt?: number;
    },
  ): JournalDelivery {
    this.ensureOpen();
    validateDelivery({
      ...input,
      revision: 0,
      updatedAt: input.updatedAt ?? input.createdAt,
    });
    return this.db.transaction(() => {
      const revision = this.bump();
      const updatedAt = input.updatedAt ?? Date.now();
      this.db
        .query(
          "INSERT INTO deliveries (id, project_id, peer, state, revision, created_at, updated_at, originals, out_json, reason, attempt, previous_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.id,
          this.projectId,
          input.peer,
          input.state,
          revision,
          input.createdAt,
          updatedAt,
          JSON.stringify(input.originals),
          JSON.stringify(input.out),
          input.reason ?? null,
          input.attempt ?? null,
          input.previousId ?? null,
        );
      this.pruneTerminal(input.state, input.id);
      return { ...input, revision, updatedAt };
    })();
  }
  private validateOfferRead(row: Record<string, unknown>): void {
    text(row.peer, "offer read peer", 256); text(row.envelope_id, "offer read envelope", 256); text(row.delivery_id, "offer read delivery", 256);
    integer(row.offer_revision, "offer read revision", 1);
    if (!["adapter", "reply", "pull"].includes(String(row.source))) fail("offer read source is invalid");
  }
  /** Positive delivery provenance only; generic transitions and operator resolutions never call this. */
  completeDelivered(deliveryId: string, peer: string, source: "adapter" | "reply" | "pull", reason?: string): JournalDelivery {
    this.ensureOpen(); text(deliveryId, "delivery id", 256); text(peer, "delivery peer", 256);
    if (peer === HUB || peer === USER || !["adapter", "reply", "pull"].includes(source)) throw new Error("invalid delivered completion source");
    if (reason !== undefined) text(reason, "delivery completion reason", 1_000_000);
    return this.db.transaction((): JournalDelivery => {
      const row = this.get(deliveryId);
      if (!row || row.peer !== peer || !["dispatching", "accepted"].includes(row.state)) throw new Error("delivery is not active for this peer");
      const completed = this.transition(deliveryId, "completed", reason, row.revision);
      const put = this.db.query("INSERT OR IGNORE INTO task_offer_reads (project_id,peer,envelope_id,delivery_id,source,offer_revision) VALUES (?,?,?,?,?,?)");
      for (const env of row.originals) if (env.from === HUB && env.kind === "task" && Number.isSafeInteger(env.refs?.taskOffer) && env.refs!.taskOffer! >= 1) put.run(this.projectId, peer, env.id, deliveryId, source, env.refs!.taskOffer!);
      return completed;
    })();
  }
  /** Exact immutable offer id, independent of queue snapshots or generic completed rows. */
  offerRead(peer: string, envelopeId: string): boolean {
    this.ensureOpen(); text(peer, "offer read peer", 256); text(envelopeId, "offer read envelope", 256);
    const row = this.db.query("SELECT * FROM task_offer_reads WHERE project_id = ? AND peer = ? AND envelope_id = ?").get(this.projectId, peer, envelopeId) as Record<string, unknown> | null;
    if (!row) return false;
    this.validateOfferRead(row); return true;
  }
  transition(
    id: string,
    state: JournalDeliveryState,
    reason?: string,
    expectedRevision?: number,
  ): JournalDelivery {
    this.ensureOpen();
    if (!STATES.has(state)) throw new Error("invalid delivery state");
    return this.db.transaction(() => {
      const old = this.get(id);
      if (!old) throw new Error(`unknown delivery ${id}`);
      if (expectedRevision !== undefined && old.revision !== expectedRevision)
        throw new Error(`stale delivery revision for ${id}`);
      const revision = this.bump();
      this.db
        .query(
          "UPDATE deliveries SET state = ?, revision = ?, updated_at = ?, reason = ? WHERE id = ? AND project_id = ?",
        )
        .run(state, revision, Date.now(), reason ?? null, id, this.projectId);
      this.pruneTerminal(state, id);
      return this.get(id)!;
    })();
  }
  get(id: string): JournalDelivery | undefined {
    this.ensureOpen();
    const row = this.db
      .query("SELECT * FROM deliveries WHERE id = ? AND project_id = ?")
      .get(id, this.projectId) as Record<string, unknown> | null;
    return row ? parseDelivery(row) : undefined;
  }
  /** Hot roster reads never materialize completed envelope history. */
  pendingPeers(): string[] {
    this.ensureOpen();
    const rows = this.db.query("SELECT DISTINCT peer FROM deliveries WHERE project_id = ? AND state IN ('queued', 'dispatching', 'accepted', 'needs_review') ORDER BY peer").all(this.projectId) as { peer: unknown }[];
    return rows.map(row => text(row.peer, "delivery peer", 256));
  }
  /** The queue needs a current revision, not the recovery snapshot's payloads. */
  revision(): number {
    this.ensureOpen();
    const row = this.db.query("SELECT revision FROM delivery_meta WHERE project_id = ?").get(this.projectId) as { revision: unknown } | null;
    if (!row) throw new Error("delivery journal metadata missing");
    return integer(row.revision, "revision");
  }
  list(peer?: string): JournalDelivery[] {
    this.ensureOpen();
    const rows = (
      peer === undefined
        ? this.db
            .query(
              "SELECT * FROM deliveries WHERE project_id = ? ORDER BY created_at, id",
            )
            .all(this.projectId)
        : this.db
            .query(
              "SELECT * FROM deliveries WHERE project_id = ? AND peer = ? ORDER BY created_at, id",
            )
            .all(this.projectId, peer)
    ) as Record<string, unknown>[];
    return rows.map(parseDelivery);
  }
  unresolved(peer?: string): JournalDelivery[] {
    this.ensureOpen();
    const rows = (peer === undefined
      ? this.db.query("SELECT * FROM deliveries WHERE project_id = ? AND state IN ('queued', 'dispatching', 'accepted', 'needs_review') ORDER BY created_at, id").all(this.projectId)
      : this.db.query("SELECT * FROM deliveries WHERE project_id = ? AND peer = ? AND state IN ('queued', 'dispatching', 'accepted', 'needs_review') ORDER BY created_at, id").all(this.projectId, peer)) as Record<string, unknown>[];
    return rows.map(parseDelivery);
  }
  heldDeliveryHints(peer: string) {
    this.ensureOpen();
    const count = Number((this.db.query("SELECT COUNT(*) AS n FROM deliveries WHERE project_id = ? AND peer = ? AND state = 'needs_review'").get(this.projectId, peer) as { n: number }).n);
    const rows = this.db.query("SELECT d.id, d.created_at, (SELECT json_group_array(DISTINCT json_extract(env.value, '$.from')) FROM json_each(d.originals) env) AS senders, (SELECT json_group_array(DISTINCT json_extract(env.value, '$.kind')) FROM json_each(d.originals) env) AS kinds FROM deliveries d WHERE d.project_id = ? AND d.peer = ? AND d.state = 'needs_review' ORDER BY d.created_at, d.id LIMIT 33").all(this.projectId, peer) as { id: string; created_at: number; senders: string; kinds: string }[];
    return heldDeliveryHints(rows.map(row => ({ id: row.id, createdAt: row.created_at, senders: JSON.parse(row.senders) as string[], kinds: JSON.parse(row.kinds) as Kind[] })), count);
  }
  /** Explicit resolutions, not automatic safe failures, consume the immutable originals' retry lineage. */
  retryEvidence(peer: string, originals: readonly Envelope[]): "unused" | "used" | "unknown" {
    this.ensureOpen();
    originals = retryOriginals(originals);
    if (!originals.length) return "unused";
    const ids = JSON.stringify([...new Set(originals.map(env => env.id))]);
    const proof = this.retryProof(peer, originals);
    if (this.retryUnknown(peer, new Set(originals.map(env => env.id)))) return "unknown";
    if (proof) return "used";
    if (this.db.query("SELECT 1 FROM resolution_history r, json_each(r.original_ids) old, json_each(?) current WHERE r.project_id = ? AND r.peer = ? AND r.action = 'retry' AND old.value = current.value LIMIT 1").get(ids, this.projectId, peer)) return "used";
    const wanted = new Set(originals.map(env => env.id));
    type Ancestor = { id: string; peer: string; attempt: number | null; previous_id: string | null; originals: string };
    const related = this.db.query("SELECT d.id, d.peer, d.attempt, d.previous_id, d.originals FROM deliveries d WHERE d.project_id = ? AND d.peer = ? AND d.state IN ('queued','dispatching','accepted','needs_review') AND EXISTS (SELECT 1 FROM json_each(d.originals) env, json_each(?) ids WHERE json_extract(env.value, '$.id') = ids.value)").all(this.projectId, peer, ids) as Ancestor[];
    const retried = (id: string) => !!this.db.query("SELECT 1 FROM resolution_history WHERE project_id = ? AND delivery_id = ? AND action = 'retry' LIMIT 1").get(this.projectId, id);
    const inspected = new Set<string>();
    let unknown = false;
    for (const row of related) {
      const chain = new Set<string>();
      let current: Ancestor | undefined = row;
      while (current) {
        if (!retryOriginals(JSON.parse(current.originals) as Envelope[]).some(env => wanted.has(env.id))) break;
        if (chain.has(current.id)) { unknown = true; break; }
        if (inspected.has(current.id)) break;
        chain.add(current.id); inspected.add(current.id);
        if ((current.attempt ?? 0) > 0 || retried(current.id)) return "used";
        if (!current.previous_id) break;
        const parent = current.previous_id;
        current = this.db.query("SELECT id, peer, attempt, previous_id, originals FROM deliveries WHERE project_id = ? AND id = ?").get(this.projectId, parent) as Ancestor | undefined;
        if (!current || current.peer !== peer) { unknown = true; break; }
      }
    }
    return unknown || this.retryUnknown(peer, wanted) ? "unknown" : "unused";
  }
  /** Console retries consume the allowance too, but only recipient-requested/unknown lineage adds a warning. */
  retryWarning(peer: string, originals: readonly Envelope[]): boolean {
    this.ensureOpen();
    originals = retryOriginals(originals);
    if (!originals.length) return false;
    const wanted = new Set(originals.map(env => env.id));
    const ids = JSON.stringify([...wanted]);
    if (this.retryProof(peer, originals)?.warning) return true;
    if (this.db.query("SELECT 1 FROM resolution_history r, json_each(r.original_ids) old, json_each(?) current WHERE r.project_id = ? AND r.peer = ? AND r.action = 'retry' AND r.actor = ? AND old.value = current.value LIMIT 1").get(ids, this.projectId, peer, `peer:${peer}`)) return true;
    return this.retryUnknown(peer, wanted) || this.retryEvidence(peer, originals) === "unknown";
  }
  private retryUnknown(peer: string, wanted: ReadonlySet<string>): boolean {
    try {
      const map = JSON.parse(String(this.readMeta()?.retry_unknown_ids ?? '{}')) as Record<string, string[]>;
      if (!map || typeof map !== "object" || Array.isArray(map)) return true;
      const own = Object.hasOwn(map, peer) ? map[peer] : [];
      return !Array.isArray(own) || own.some(id => wanted.has(id));
    } catch { return true; }
  }
  private markRetryUnknown(deliveries: readonly JournalDelivery[], bus: Partial<BusSnapshot>): void {
    const map: Record<string, Set<string>> = Object.create(null);
    const existing = JSON.parse(String(this.readMeta()?.retry_unknown_ids ?? '{}')) as Record<string, unknown>;
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) throw new Error("retry lineage metadata unavailable");
    for (const [peer, ids] of Object.entries(existing)) {
      if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) throw new Error("retry lineage metadata unavailable");
      map[peer] = new Set(ids as string[]);
    }
    const add = (peer: string, envs: readonly Envelope[]) => { for (const env of retryOriginals(envs)) (map[peer] ??= new Set()).add(env.id); };
    for (const row of deliveries) add(row.peer, row.originals);
    for (const [peer, envs] of Object.entries(bus.queues ?? {})) add(peer, envs);
    for (const [peer, env] of Object.entries(bus.prefaces ?? {})) add(peer, [env]);
    this.db.query("UPDATE delivery_meta SET retry_unknown_ids = ? WHERE project_id = ?").run(JSON.stringify(Object.fromEntries(Object.entries(map).map(([peer, ids]) => [peer, [...ids]]))), this.projectId);
  }
  resolve(
    id: string,
    revision: number,
    action: JournalResolution,
    reason: string,
    requestRevision = revision,
    actor: string = "user",
  ): JournalDelivery {
    this.ensureOpen();
    text(reason, "resolution reason", 1_000_000);
    integer(revision, "observed revision");
    if (!ACTIONS.has(action)) throw new Error("invalid resolution action");
    return this.db.transaction(() => {
      const resolved = this.resolution(id);
      if (resolved) {
        const current = this.get(id);
        if (current && resolved.action === action && resolved.reason === reason && resolved.actor === actor && (requestRevision === resolved.observedRevision || requestRevision === current.revision)) return current;
        throw new Error("stale delivery revision or conflicting operator resolution");
      }
      const prior = this.db
        .query(
          "SELECT result_revision FROM resolution_history WHERE project_id = ? AND delivery_id = ? AND observed_revision = ? AND action = ? AND reason = ? AND actor = ?",
        )
        .get(this.projectId, id, requestRevision, action, reason, actor) as {
        result_revision: number;
      } | null;
      if (prior) return this.get(id)!;
      const current = this.get(id);
      if (!current) throw new Error(`unknown delivery ${id}`);
      if (actor.startsWith("peer:") && (action !== "retry" || current.peer !== actor.slice(5) || current.state !== "needs_review" || this.retryEvidence(current.peer, current.originals) !== "unused")) throw new Error("recipient retry unavailable; inspect the held delivery or ask the person");
      if (current.revision !== revision)
        throw new Error(`stale delivery revision for ${id}`);
      if (
        ["completed", "discarded"].includes(current.state) &&
        actionState(action) !== current.state
      )
        throw new Error(`delivery ${id} is already terminal`);
      const result = this.transition(id, actionState(action), reason, revision);
      if (action === "retry") {
        const childId = `${id}:retry:${(current.attempt ?? 0) + 1}`;
        if (!this.get(childId))
          this.createDelivery({
            id: childId,
            peer: current.peer,
            state: "queued",
            createdAt: Date.now(),
            originals: current.originals,
            out: current.out,
            attempt: (current.attempt ?? 0) + 1,
            previousId: id,
          });
      }
      this.db
        .query(
          "INSERT INTO resolution_history (project_id, delivery_id, observed_revision, action, reason, result_revision, result_state, actor, peer, original_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          this.projectId,
          id,
          requestRevision,
          action,
          reason,
          result.revision,
          result.state,
          actor,
          current.peer,
          JSON.stringify(retryOriginals(current.originals).map(env => env.id)),
        );
      if (action === "retry") this.recordRetryEvidence(current.peer, current.originals, id, actor === `peer:${current.peer}`);
      this.pruneTerminal(result.state, result.id);
      return result;
    })();
  }
  resolution(id: string): { action: JournalResolution; reason: string; observedRevision: number; actor: string } | undefined {
    const row = this.db.query("SELECT action,reason,observed_revision,actor FROM resolution_history WHERE project_id=? AND delivery_id=? ORDER BY id DESC LIMIT 1").get(this.projectId, id) as { action: JournalResolution; reason: string; observed_revision: number; actor: string } | null;
    return row ? { action: row.action, reason: row.reason, observedRevision: row.observed_revision, actor: row.actor } : undefined;
  }
  private pruneTerminal(state: JournalDeliveryState, currentId: string): void {
    if (this.pruningDeferred) return;
    const terminal = state === "completed" || state === "discarded" || state === "failed";
    const terminalCap = terminal ? this.terminalHistoryLimit?.() ?? TERMINAL_CAP : TERMINAL_CAP;
    // Never delete the receipt this mutation/resolve is still using, at any target.
    const count = Number(
      (
        this.db
          .query(
            "SELECT COUNT(*) AS n FROM deliveries WHERE project_id = ? AND state IN ('completed','discarded','failed')",
          )
          .get(this.projectId) as { n: number }
      ).n,
    );
    if (count <= terminalCap) return;
    this.db
      .query(
        "DELETE FROM deliveries WHERE id IN (SELECT d.id FROM deliveries d WHERE d.project_id = ? AND d.state IN ('completed','discarded','failed') AND d.id != ? AND NOT EXISTS (SELECT 1 FROM deliveries c WHERE c.project_id = d.project_id AND c.previous_id = d.id) ORDER BY d.updated_at, d.id LIMIT ?)",
      )
      .run(this.projectId, currentId, count - terminalCap);
  }
  importSnapshot(snapshot: JournalSnapshot, operationId: string, trackQueuePressure = false): boolean {
    this.ensureOpen();
    validateJournalSnapshot(snapshot);
    const bus = this.queueMetadataSnapshot(snapshot.bus, trackQueuePressure);
    text(operationId, "operationId", 256);
    if (this.operationId !== undefined && this.operationId !== operationId)
      throw new Error("recovery operation does not own delivery journal");
    const meta = this.readMeta();
    if (!meta) throw new Error("delivery journal metadata missing");
    this.validateStored(meta);
    const deliveries = this.db
      .query("SELECT 1 FROM deliveries WHERE project_id = ? LIMIT 1")
      .get(this.projectId);
    const storedBus = JSON.parse(String(meta.bus_snapshot || "{}"));
    if (
      Number(meta.revision) !== 0 ||
      deliveries ||
      Object.keys(storedBus).length !== 0
    )
      return false;
    return this.queueMetadataTransaction(trackQueuePressure, () => {
      this.db
        .query(
          "UPDATE delivery_meta SET revision = ?, bus_snapshot = ?, manual_paused = ?, operation_id = ? WHERE project_id = ?",
        )
        .run(
          snapshot.revision,
          JSON.stringify(bus),
          JSON.stringify(snapshot.manualPaused),
          operationId,
          this.projectId,
        );
      this.writeQueueMetadata(bus, snapshot.revision, trackQueuePressure);
      for (const row of snapshot.deliveries)
        this.db
          .query(
            "INSERT INTO deliveries (id, project_id, peer, state, revision, created_at, updated_at, originals, out_json, reason, attempt, previous_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            row.id,
            this.projectId,
            row.peer,
            row.state,
            row.revision,
            row.createdAt,
            row.updatedAt,
            JSON.stringify(row.originals),
            JSON.stringify(row.out),
            row.reason ?? null,
            row.attempt ?? null,
            row.previousId ?? null,
          );
      // Snapshots deliberately omit resolution history; only these imported originals have unknown retry rights.
      this.markRetryUnknown(snapshot.deliveries, bus);
      return true;
    });
  }
  close(): void {
    if (!this.closed) {
      this.harden();
      this.db.close();
      this.closed = true;
    }
  }
}
function actionState(action: JournalResolution): JournalDeliveryState {
  return action === "completed"
    ? "completed"
    : action === "discard"
      ? "discarded"
      : "failed";
}
function parseDelivery(row: Record<string, unknown>): JournalDelivery {
  return validateDelivery({
    id: String(row.id),
    peer: String(row.peer),
    state: String(row.state),
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    originals: JSON.parse(String(row.originals)),
    out: JSON.parse(String(row.out_json)),
    ...(row.reason == null ? {} : { reason: String(row.reason) }),
    ...(row.attempt == null ? {} : { attempt: Number(row.attempt) }),
    ...(row.previous_id == null ? {} : { previousId: String(row.previous_id) }),
  });
}
