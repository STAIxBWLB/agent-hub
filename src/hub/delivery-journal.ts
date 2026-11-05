import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Database } from "./db-schema.ts";
import { openHubDatabase } from "./db-schema.ts";
import type { BusSnapshot } from "./bus.ts";
import type { QueuePressure } from "./queue-backpressure.ts";
import { HUB, KINDS, USER, type Envelope, type Kind } from "./envelope.ts";
import { heldDeliveryHints } from "./delivery-hints.ts";
import { processLiveness } from "../pi/process-signature.ts";
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
export const ACCEPTED_SETTLE_TIMEOUT_REASON = "channel delivery confirmation timed out; inspect effects before resolving";
const SCHEMA_VERSION = 1,
  MAX_ROWS = 100_000,
  MAX_REVIEW_INPUTS = 4096,
  REVIEW_INPUT_VERSION = 2,
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
export interface ReviewInputHold { peer: string; sessionHash: string; inputHash: string | null }
export interface ReviewInputProvenance { version: 2; instanceId: string; complete: boolean; coverageComplete: boolean; count: number; digest: string; holds: ReviewInputHold[]; incompletePeers: string[]; incompleteSessions: Array<{ peer: string; sessionHash: string }> }
export type ReviewInputState = { state: "clean" } | { state: "held"; inputHash: string } | { state: "unknown" };
export interface ReviewInputEvidence {
  provenance: "available" | "corrupt";
  coverageComplete: boolean;
  incompletePeer: boolean;
  incompleteSession: boolean;
  sessionState: "clean" | "held" | "unknown";
  retainedSessionHold: boolean;
  retainedPeerSessionHold: boolean;
}
export type ReviewInputHealthCause = "legacy_coverage" | "incomplete_markers" | "provenance_incomplete" | "provenance_corrupt";
export interface ReviewInputHealth {
  state: "healthy" | "incomplete" | "corrupt";
  cause: ReviewInputHealthCause | null;
  nextStep: string;
}
export interface AcceptedDeliveryCandidate { id: string; peer: string; revision: number; updatedAt: number; notifyConductor: boolean }
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
  reviewInputProvenance?: ReviewInputProvenance;
}
export type JournalTransportSnapshot = Omit<JournalSnapshot, "reviewInputProvenance">;

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
function hashText(value: unknown, name: string): string {
  const hash = text(value, name, 64);
  if (!/^[a-f0-9]{64}$/.test(hash)) fail(`${name} is invalid`);
  return hash;
}
function closedOwnDataFields(value: unknown, name: string, expected: readonly string[]): Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${name} must be a plain object`);
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.length || !expected.every(key => keys.includes(key))) fail(`${name} has unexpected fields`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some(key => typeof key !== "string" || !descriptors[key]?.enumerable || !("value" in descriptors[key]!))) fail(`${name} must contain own data fields`);
    return Object.fromEntries(keys.map(key => [key as string, descriptors[key as string]!.value]));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("invalid delivery journal:")) throw error;
    fail(`${name} is unreadable`);
  }
}
function reviewInputHold(value: unknown, name: string): ReviewInputHold {
  const fields = closedOwnDataFields(value, name, ["peer", "sessionHash", "inputHash"]);
  const peer = text(fields.peer, `${name}.peer`, 256);
  const sessionHash = hashText(fields.sessionHash, `${name}.sessionHash`);
  const inputHash = fields.inputHash === null ? null : hashText(fields.inputHash, `${name}.inputHash`);
  return { peer, sessionHash, inputHash };
}
function reviewInputDigest(instanceId: string, version: number, complete: boolean, coverageComplete: boolean, count: number, holds: readonly ReviewInputHold[], incompletePeers: readonly string[], incompleteSessions: readonly { peer: string; sessionHash: string }[]): string {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const normalizedHolds = [...holds].map(hold => ({ peer: hold.peer, sessionHash: hold.sessionHash, inputHash: hold.inputHash }))
    .sort((a, b) => compare(a.peer, b.peer) || compare(a.sessionHash, b.sessionHash));
  const normalizedPeers = [...incompletePeers].sort();
  const normalizedSessions = [...incompleteSessions].map(row => ({ peer: row.peer, sessionHash: row.sessionHash }))
    .sort((a, b) => compare(a.peer, b.peer) || compare(a.sessionHash, b.sessionHash));
  return createHash("sha256").update(JSON.stringify({ instanceId, version, complete, coverageComplete, count, holds: normalizedHolds, incompletePeers: normalizedPeers, incompleteSessions: normalizedSessions })).digest("hex");
}
function legacyReviewInputMarkerAbsent(meta: Record<string, unknown>): boolean {
  return Number(meta.review_input_version ?? 0) === 0 && Number(meta.review_input_complete ?? 0) === 0
    && Number(meta.review_input_coverage_complete ?? 0) === 0 && Number(meta.review_input_count ?? 0) === 0
    && String(meta.review_input_digest ?? "") === "" && String(meta.review_input_instance_id ?? "") === "";
}
function validateReviewInputProvenance(value: unknown, name = "review input provenance"): ReviewInputProvenance {
  const fields = closedOwnDataFields(value, name, ["version", "instanceId", "complete", "coverageComplete", "count", "digest", "holds", "incompletePeers", "incompleteSessions"]);
  if (fields.version !== REVIEW_INPUT_VERSION || typeof fields.complete !== "boolean" || typeof fields.coverageComplete !== "boolean") fail(`${name} version or completeness is invalid`);
  const instanceId = text(fields.instanceId, `${name}.instanceId`, 256);
  if (Array.isArray(fields.holds) && fields.holds.length > MAX_REVIEW_INPUTS || Array.isArray(fields.incompletePeers) && fields.incompletePeers.length > MAX_REVIEW_INPUTS || Array.isArray(fields.incompleteSessions) && fields.incompleteSessions.length > MAX_REVIEW_INPUTS) fail(`${name} exceeds ${MAX_REVIEW_INPUTS}`);
  const holds = list(fields.holds, `${name}.holds`, MAX_REVIEW_INPUTS).map((row, index) => reviewInputHold(row, `${name}.holds[${index}]`));
  const incompletePeers = list(fields.incompletePeers, `${name}.incompletePeers`, MAX_REVIEW_INPUTS).map((peer, index) => text(peer, `${name}.incompletePeers[${index}]`, 256));
  const incompleteSessions = list(fields.incompleteSessions, `${name}.incompleteSessions`, MAX_REVIEW_INPUTS).map((raw, index) => {
    const row = closedOwnDataFields(raw, `${name}.incompleteSessions[${index}]`, ["peer", "sessionHash"]);
    return { peer: text(row.peer, `${name}.incompleteSessions[${index}].peer`, 256), sessionHash: hashText(row.sessionHash, `${name}.incompleteSessions[${index}].sessionHash`) };
  });
  if (holds.length + incompletePeers.length + incompleteSessions.length > MAX_REVIEW_INPUTS) fail(`${name} exceeds ${MAX_REVIEW_INPUTS}`);
  const keys = new Set<string>();
  for (const hold of holds) {
    const key = JSON.stringify([hold.peer, hold.sessionHash]);
    if (keys.has(key)) fail(`${name} has duplicate sessions`);
    keys.add(key);
  }
  if (new Set(incompletePeers).size !== incompletePeers.length) fail(`${name} has duplicate incomplete peers`);
  const incompleteKeys = new Set(incompleteSessions.map(row => JSON.stringify([row.peer, row.sessionHash])));
  if (incompleteKeys.size !== incompleteSessions.length) fail(`${name} has duplicate incomplete sessions`);
  const count = integer(fields.count, `${name}.count`, 0, MAX_REVIEW_INPUTS);
  const digest = hashText(fields.digest, `${name}.digest`);
  if (count !== holds.length + incompletePeers.length + incompleteSessions.length || digest !== reviewInputDigest(instanceId, REVIEW_INPUT_VERSION, fields.complete, fields.coverageComplete, count, holds, incompletePeers, incompleteSessions)) fail(`${name} integrity does not match its rows`);
  return { version: REVIEW_INPUT_VERSION, instanceId, complete: fields.complete, coverageComplete: fields.coverageComplete, count, digest, holds, incompletePeers, incompleteSessions };
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
    !(KINDS as readonly string[]).includes(e.kind as string)
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
  if (Object.hasOwn(s, "reviewInputProvenance")) {
    const provenance = validateReviewInputProvenance(s.reviewInputProvenance, "snapshot.reviewInputProvenance");
    if (provenance.instanceId !== s.instanceId) fail("snapshot review input instance binding is invalid");
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
  private legacyReviewCandidateIds = new Set<string>();
  private legacyReviewCandidatesCaptured = false;
  private legacyReviewCandidatesOverflow = false;
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
    this.db = openHubDatabase(options.file, { create: true });
    this.harden();
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = FULL");
    this.createSchema();
    const meta = this.readMeta();
    if (!meta) {
      const holds = this.reviewInputRows(), incompletePeers = this.reviewInputIncompletePeerRows(), incompleteSessions = this.reviewInputIncompleteSessionRows();
      const legacyTable = this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_input_holds'").get();
      const legacyCount = legacyTable ? Number((this.db.query("SELECT COUNT(*) AS n FROM review_input_holds WHERE project_id=?").get(this.projectId) as { n: number }).n) : 0;
      const provenanceCount = holds.length + incompletePeers.length + incompleteSessions.length;
      const complete = provenanceCount === 0 || legacyCount === provenanceCount, coverageComplete = complete && legacyCount === 0;
      this.db
        .query(
          "INSERT INTO delivery_meta (project_id, project_root, revision, instance_id, operation_id, retry_history_cursor, review_input_version, review_input_complete, review_input_coverage_complete, review_input_count, review_input_digest, review_input_instance_id) VALUES (?, ?, 0, ?, ?, 0, 2, ?, ?, ?, ?, ?)",
        )
        .run(
          this.projectId,
          this.projectRoot,
          this.instanceId,
          this.operationId ?? null,
          complete ? 1 : 0,
          coverageComplete ? 1 : 0,
          provenanceCount,
          reviewInputDigest(this.instanceId, REVIEW_INPUT_VERSION, true, coverageComplete, holds.length + incompletePeers.length + incompleteSessions.length, holds, incompletePeers, incompleteSessions),
          this.instanceId,
        );
    } else {
      this.validateStored(meta);
      this.rejectLiveOwner(meta);
      let reviewInput: ReviewInputProvenance | undefined;
      try {
        const prior = this.readReviewInputProvenance(meta);
        reviewInput = { ...prior, instanceId: this.instanceId, digest: reviewInputDigest(this.instanceId, REVIEW_INPUT_VERSION, prior.complete, prior.coverageComplete, prior.count, prior.holds, prior.incompletePeers, prior.incompleteSessions) };
      }
      catch { /* corrupt provenance remains unknown; ordinary delivery state stays available */ }
      this.db.transaction(() => {
        this.db
          .query(
            "UPDATE delivery_meta SET project_root = ?, instance_id = ?, operation_id = COALESCE(?, operation_id), review_input_version = ?, review_input_instance_id = ?, review_input_complete = ?, review_input_coverage_complete = ?, review_input_count = ?, review_input_digest = ? WHERE project_id = ?",
          )
          .run(
            this.projectRoot,
            this.instanceId,
            this.operationId ?? null,
            REVIEW_INPUT_VERSION,
            this.instanceId,
            reviewInput?.complete === true ? 1 : 0,
            reviewInput?.coverageComplete === true ? 1 : 0,
            reviewInput?.count ?? Number(meta.review_input_count ?? 0),
            reviewInput?.digest ?? String(meta.review_input_digest ?? ""),
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
    this.captureLegacyReviewCandidates();
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
      `CREATE TABLE IF NOT EXISTS delivery_meta (project_id TEXT PRIMARY KEY, project_root TEXT, schema_version INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL, instance_id TEXT NOT NULL, operation_id TEXT, manual_paused TEXT NOT NULL DEFAULT '[]', bus_snapshot TEXT NOT NULL DEFAULT '{}', review_input_version INTEGER NOT NULL DEFAULT 0, review_input_complete INTEGER NOT NULL DEFAULT 0, review_input_coverage_complete INTEGER NOT NULL DEFAULT 0, review_input_count INTEGER NOT NULL DEFAULT 0, review_input_digest TEXT NOT NULL DEFAULT '', review_input_instance_id TEXT NOT NULL DEFAULT '')`,
    );
    for (const [column, definition] of [
      ["project_root", "TEXT"],
      ["schema_version", "INTEGER NOT NULL DEFAULT 1"],
      ["operation_id", "TEXT"],
      ["retry_unknown_ids", "TEXT NOT NULL DEFAULT '{}'"],
      ["retry_history_cursor", "INTEGER NOT NULL DEFAULT 0"],
      ["review_input_version", "INTEGER NOT NULL DEFAULT 0"],
      ["review_input_complete", "INTEGER NOT NULL DEFAULT 0"],
      ["review_input_coverage_complete", "INTEGER NOT NULL DEFAULT 0"],
      ["review_input_count", "INTEGER NOT NULL DEFAULT 0"],
      ["review_input_digest", "TEXT NOT NULL DEFAULT ''"],
      ["review_input_instance_id", "TEXT NOT NULL DEFAULT ''"],
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
    this.db.run("CREATE TABLE IF NOT EXISTS review_input_sessions (project_id TEXT NOT NULL, peer TEXT NOT NULL, session_hash TEXT NOT NULL, input_hash TEXT, PRIMARY KEY(project_id,peer,session_hash))");
    this.db.run("CREATE TABLE IF NOT EXISTS review_input_incomplete_peers (project_id TEXT NOT NULL, peer TEXT NOT NULL, PRIMARY KEY(project_id,peer))");
    this.db.run("CREATE TABLE IF NOT EXISTS review_input_incomplete_sessions (project_id TEXT NOT NULL, peer TEXT NOT NULL, session_hash TEXT NOT NULL, PRIMARY KEY(project_id,peer,session_hash))");
    const legacyColumns = this.db.query("PRAGMA table_info(review_input_holds)").all() as { name: string }[];
    const meta = this.readMeta();
    const hasCurrentProvenance = !!this.db.query("SELECT 1 FROM review_input_sessions WHERE project_id=? UNION ALL SELECT 1 FROM review_input_incomplete_peers WHERE project_id=? UNION ALL SELECT 1 FROM review_input_incomplete_sessions WHERE project_id=? LIMIT 1")
      .get(this.projectId, this.projectId, this.projectId);
    if (legacyColumns.length && (!meta || legacyReviewInputMarkerAbsent(meta) && !hasCurrentProvenance)) {
      this.db.transaction(() => {
        const hasSession = legacyColumns.some(column => column.name === "session_hash"), hasHash = legacyColumns.some(column => column.name === "input_hash");
        if (hasSession && hasHash) {
          const legacy = this.db.query("SELECT project_id,peer,session_hash,input_hash FROM review_input_holds WHERE project_id=? ORDER BY peer LIMIT ?").all(this.projectId, MAX_REVIEW_INPUTS) as Record<string, unknown>[];
          for (const row of legacy) {
            const project = this.projectId;
            try {
              const hold = reviewInputHold({ peer: row.peer, sessionHash: row.session_hash, inputHash: row.input_hash }, "legacy review input");
              this.db.query("INSERT OR IGNORE INTO review_input_sessions(project_id,peer,session_hash,input_hash) VALUES(?,?,?,?)").run(project, hold.peer, hold.sessionHash, hold.inputHash);
            } catch {
              if (typeof row.peer === "string" && row.peer.length > 0 && row.peer.length <= 256) {
                if (typeof row.session_hash === "string" && /^[a-f0-9]{64}$/.test(row.session_hash)) this.db.query("INSERT OR IGNORE INTO review_input_incomplete_sessions(project_id,peer,session_hash) VALUES(?,?,?)").run(project, row.peer, row.session_hash);
                else this.db.query("INSERT OR IGNORE INTO review_input_incomplete_peers(project_id,peer) VALUES(?,?)").run(project, row.peer);
              }
            }
          }
        }
        const holds = this.db.query("SELECT peer,session_hash,input_hash FROM review_input_sessions WHERE project_id=?").all(this.projectId) as Record<string, unknown>[];
        const normalized = holds.map((row, index) => reviewInputHold({ peer: row.peer, sessionHash: row.session_hash, inputHash: row.input_hash }, `migrated review input ${index}`));
        const incompletePeers = this.reviewInputIncompletePeerRows(), incompleteSessions = this.reviewInputIncompleteSessionRows();
        if (meta) {
          const instance = String(meta.instance_id), count = normalized.length + incompletePeers.length + incompleteSessions.length, digest = reviewInputDigest(instance, REVIEW_INPUT_VERSION, true, false, count, normalized, incompletePeers, incompleteSessions);
          this.db.query("UPDATE delivery_meta SET review_input_version=?,review_input_complete=1,review_input_coverage_complete=0,review_input_count=?,review_input_digest=?,review_input_instance_id=? WHERE project_id=?")
            .run(REVIEW_INPUT_VERSION, count, digest, instance, this.projectId);
        }
      })();
    }
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
  private reviewInputRows(): ReviewInputHold[] {
    const rows = this.db.query("SELECT peer,session_hash,input_hash FROM review_input_sessions WHERE project_id=? ORDER BY peer,session_hash LIMIT ?")
      .all(this.projectId, MAX_REVIEW_INPUTS + 1) as Record<string, unknown>[];
    if (rows.length > MAX_REVIEW_INPUTS) fail(`too many review input provenance rows (limit ${MAX_REVIEW_INPUTS})`);
    return rows.map((row, index) => reviewInputHold({ peer: row.peer, sessionHash: row.session_hash, inputHash: row.input_hash }, `stored review input ${index}`));
  }
  private reviewInputIncompletePeerRows(): string[] {
    const rows = this.db.query("SELECT peer FROM review_input_incomplete_peers WHERE project_id=? ORDER BY peer LIMIT ?")
      .all(this.projectId, MAX_REVIEW_INPUTS + 1) as { peer: unknown }[];
    if (rows.length > MAX_REVIEW_INPUTS) fail(`too many incomplete review input peers (limit ${MAX_REVIEW_INPUTS})`);
    return rows.map((row, index) => text(row.peer, `stored incomplete review input peer ${index}`, 256));
  }
  private reviewInputIncompleteSessionRows(): Array<{ peer: string; sessionHash: string }> {
    const rows = this.db.query("SELECT peer,session_hash FROM review_input_incomplete_sessions WHERE project_id=? ORDER BY peer,session_hash LIMIT ?")
      .all(this.projectId, MAX_REVIEW_INPUTS + 1) as Record<string, unknown>[];
    if (rows.length > MAX_REVIEW_INPUTS) fail(`too many incomplete review input sessions (limit ${MAX_REVIEW_INPUTS})`);
    return rows.map((row, index) => ({ peer: text(row.peer, `stored incomplete review input session peer ${index}`, 256), sessionHash: hashText(row.session_hash, `stored incomplete review input session hash ${index}`) }));
  }
  private readReviewInputProvenance(meta = this.readMeta()): ReviewInputProvenance {
    if (!meta) throw new Error("delivery journal metadata missing");
    const holds = this.reviewInputRows(), incompletePeers = this.reviewInputIncompletePeerRows(), incompleteSessions = this.reviewInputIncompleteSessionRows();
    if (holds.length + incompletePeers.length + incompleteSessions.length > MAX_REVIEW_INPUTS) fail(`too many review input provenance rows (limit ${MAX_REVIEW_INPUTS})`);
    const instanceId = text(String(meta.instance_id), "review input owner instance", 256), count = holds.length + incompletePeers.length + incompleteSessions.length;
    const version = Number(meta.review_input_version ?? 0), completeRaw = Number(meta.review_input_complete ?? 0), coverageRaw = Number(meta.review_input_coverage_complete ?? 0);
    if (version === 0 && completeRaw === 0 && coverageRaw === 0 && Number(meta.review_input_count ?? 0) === 0 && String(meta.review_input_digest ?? "") === "" && String(meta.review_input_instance_id ?? "") === "") {
      if (count) fail("legacy review input marker is missing for stored provenance rows");
      return { version: REVIEW_INPUT_VERSION, instanceId, complete: true, coverageComplete: false, count, digest: reviewInputDigest(instanceId, REVIEW_INPUT_VERSION, true, false, count, holds, incompletePeers, incompleteSessions), holds, incompletePeers, incompleteSessions };
    }
    if (version !== REVIEW_INPUT_VERSION || ![0, 1].includes(completeRaw)) fail("review input coverage metadata is invalid");
    if (![0, 1].includes(coverageRaw)) fail("review input coverage metadata is invalid");
    const storedInstance = text(String(meta.review_input_instance_id ?? ""), "review input coverage instance", 256);
    const storedCount = integer(Number(meta.review_input_count), "review input coverage count", 0, MAX_REVIEW_INPUTS);
    const storedDigest = hashText(meta.review_input_digest, "review input coverage digest");
    if (storedCount !== count || storedDigest !== reviewInputDigest(storedInstance, version, completeRaw === 1, coverageRaw === 1, storedCount, holds, incompletePeers, incompleteSessions)) fail("review input coverage integrity mismatch");
    const markerMatches = storedInstance === instanceId, complete = completeRaw === 1 && markerMatches, coverageComplete = coverageRaw === 1 && markerMatches;
    const digest = reviewInputDigest(instanceId, REVIEW_INPUT_VERSION, complete, coverageComplete, count, holds, incompletePeers, incompleteSessions);
    return { version: REVIEW_INPUT_VERSION, instanceId, complete, coverageComplete, count, digest, holds, incompletePeers, incompleteSessions };
  }
  /** Snapshot the pre-existing handed review rows once while legacy coverage is incomplete. */
  private captureLegacyReviewCandidates(force = false): void {
    this.legacyReviewCandidateIds = new Set();
    this.legacyReviewCandidatesCaptured = true;
    this.legacyReviewCandidatesOverflow = false;
    try {
      const provenance = this.readReviewInputProvenance();
      if (!provenance.complete || provenance.coverageComplete && !force) return;
      const rows = this.db.query(`SELECT d.id FROM deliveries d
        WHERE d.project_id=? AND d.state IN ('dispatching','accepted','needs_review')
          AND EXISTS (SELECT 1 FROM json_each(d.originals) e
            WHERE (json_extract(e.value,'$.from')='hub' AND json_extract(e.value,'$.kind')='review')
              OR (json_extract(e.value,'$.from') NOT IN ('hub','user') AND json_extract(e.value,'$.kind') IN ('chat','status')
                AND json_type(e.value,'$.refs.reviewResponse')='text'))
        LIMIT ?`).all(this.projectId, MAX_REVIEW_INPUTS + 1) as { id: unknown }[];
      if (rows.length > MAX_REVIEW_INPUTS) { this.legacyReviewCandidatesOverflow = true; return; }
      this.legacyReviewCandidateIds = new Set(rows.map(row => text(row.id, "legacy review delivery id", 256)));
    } catch {
      // An unbounded or unreadable candidate set cannot prove legacy coverage complete.
      this.legacyReviewCandidatesOverflow = true;
    }
  }
  /** Check only captured pre-upgrade rows; current guarded deliveries carry their own provenance. */
  private hasUnsettledReviewInput(): boolean {
    if (!this.legacyReviewCandidatesCaptured) this.captureLegacyReviewCandidates();
    if (this.legacyReviewCandidatesOverflow) return true;
    const ids = [...this.legacyReviewCandidateIds];
    for (let offset = 0; offset < ids.length; offset += 256) {
      const batch = ids.slice(offset, offset + 256);
      try {
        const rows = this.db.query(`SELECT d.state FROM json_each(?) candidate
          LEFT JOIN deliveries d ON d.project_id=? AND d.id=candidate.value`).all(JSON.stringify(batch), this.projectId) as { state: string | null }[];
        if (rows.length !== batch.length || rows.some(row => !row.state || !["completed", "failed", "discarded"].includes(row.state))) return true;
      } catch { return true; }
    }
    return false;
  }
  private markReviewInputCoverageIncomplete(prior: ReviewInputProvenance): void {
    if (prior.coverageComplete) this.captureLegacyReviewCandidates(true);
    this.transaction(() => {
      this.bump();
      this.writeReviewInputProvenance(prior.complete, false);
      this.harden();
    });
  }
  /** Complete legacy coverage after every handed review delivery is settled; then NULL means clean by absence. */
  private refreshReviewInputCoverage(inTransaction = false): void {
    let prior: ReviewInputProvenance;
    try { prior = this.readReviewInputProvenance(); }
    catch { return; } // Corrupt provenance stays held without blocking unrelated journal work.
    if (!prior.complete) return;
    const unsettled = !prior.coverageComplete && this.hasUnsettledReviewInput();
    const cleanRows = prior.coverageComplete ? Number((this.db.query("SELECT COUNT(*) AS n FROM review_input_sessions WHERE project_id=? AND input_hash IS NULL").get(this.projectId) as { n: number }).n) : 0;
    if (unsettled) return;
    if (!prior.coverageComplete || cleanRows > 0) {
      const update = () => {
        this.bump();
        if (!prior.coverageComplete) this.db.query("UPDATE delivery_meta SET review_input_coverage_complete=1 WHERE project_id=?").run(this.projectId);
        if (!prior.coverageComplete || cleanRows > 0) this.db.query("DELETE FROM review_input_sessions WHERE project_id=? AND input_hash IS NULL").run(this.projectId);
        this.writeReviewInputProvenance(prior.complete, true);
        this.harden();
      };
      if (inTransaction) update(); else this.transaction(update);
    }
  }
  private writeReviewInputProvenance(complete: boolean, coverageComplete: boolean): void {
    const holds = this.reviewInputRows(), incompletePeers = this.reviewInputIncompletePeerRows(), incompleteSessions = this.reviewInputIncompleteSessionRows();
    if (holds.length + incompletePeers.length + incompleteSessions.length > MAX_REVIEW_INPUTS) fail(`too many review input provenance rows (limit ${MAX_REVIEW_INPUTS})`);
    const count = holds.length + incompletePeers.length + incompleteSessions.length;
    this.db.query("UPDATE delivery_meta SET review_input_version=?,review_input_complete=?,review_input_coverage_complete=?,review_input_count=?,review_input_digest=?,review_input_instance_id=? WHERE project_id=?")
      .run(REVIEW_INPUT_VERSION, complete ? 1 : 0, coverageComplete ? 1 : 0, count, reviewInputDigest(this.instanceId, REVIEW_INPUT_VERSION, complete, coverageComplete, count, holds, incompletePeers, incompleteSessions), this.instanceId, this.projectId);
  }
  /** Persist the scoped unknown marker before changing this session's held/clear receipt. */
  private writePendingReviewInputSession(peer: string, sessionHash: string, complete: boolean, coverageComplete: boolean, clearIncompletePeer = false): void {
    this.transaction(() => {
      this.bump();
      this.db.query("INSERT OR IGNORE INTO review_input_incomplete_sessions(project_id,peer,session_hash) VALUES(?,?,?)")
        .run(this.projectId, peer, sessionHash);
      if (clearIncompletePeer) this.db.query("DELETE FROM review_input_incomplete_peers WHERE project_id=? AND peer=?").run(this.projectId, peer);
      this.writeReviewInputProvenance(complete, coverageComplete);
      this.harden();
    });
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
    const legacyReviewCandidateIds = this.legacyReviewCandidateIds;
    const legacyReviewCandidatesCaptured = this.legacyReviewCandidatesCaptured;
    const legacyReviewCandidatesOverflow = this.legacyReviewCandidatesOverflow;
    try { return this.db.transaction(fn)(); }
    catch (error) {
      this.queueMetadataInvalidated = invalidated;
      this.legacyReviewCandidateIds = legacyReviewCandidateIds;
      this.legacyReviewCandidatesCaptured = legacyReviewCandidatesCaptured;
      this.legacyReviewCandidatesOverflow = legacyReviewCandidatesOverflow;
      throw error;
    }
  }
  holdReviewInput(value: unknown): void {
    this.ensureOpen();
    const hold = reviewInputHold(value, "review input hold");
    if (hold.inputHash === null) fail("review input hold requires a positive input hash");
    const prior = this.readReviewInputProvenance();
    if (!prior.complete) fail("review input provenance is incomplete");
    const existing = prior.holds.find(row => row.peer === hold.peer && row.sessionHash === hold.sessionHash);
    const pending = prior.incompleteSessions.some(row => row.peer === hold.peer && row.sessionHash === hold.sessionHash);
    if (existing?.inputHash === hold.inputHash) return;
    if (!existing && !pending && prior.count >= MAX_REVIEW_INPUTS) {
      this.markReviewInputCoverageIncomplete(prior);
      fail(`too many review input provenance rows (limit ${MAX_REVIEW_INPUTS})`);
    }
    try {
      this.writePendingReviewInputSession(hold.peer, hold.sessionHash, prior.complete, prior.coverageComplete);
    } catch (error) {
      try { this.markReviewInputIncomplete(hold.peer, hold.sessionHash); } catch { /* a failed marker write still prevents the host handout */ }
      throw error;
    }
    this.transaction(() => {
      this.bump();
      this.db.query("INSERT INTO review_input_sessions(project_id,peer,session_hash,input_hash) VALUES(?,?,?,?) ON CONFLICT(project_id,peer,session_hash) DO UPDATE SET input_hash=excluded.input_hash")
        .run(this.projectId, hold.peer, hold.sessionHash, hold.inputHash);
      this.db.query("DELETE FROM review_input_incomplete_sessions WHERE project_id=? AND peer=? AND session_hash=?")
        .run(this.projectId, hold.peer, hold.sessionHash);
      this.writeReviewInputProvenance(prior.complete, prior.coverageComplete);
      this.harden();
    });
  }
  reviewInputState(peerValue: string, sessionHashValue?: string): ReviewInputState {
    try {
      const peer = text(peerValue, "review input peer", 256);
      const sessionHash = sessionHashValue === undefined ? undefined : hashText(sessionHashValue, "review input session hash");
      const provenance = this.readReviewInputProvenance();
      if (!provenance.complete || provenance.incompletePeers.includes(peer)) return { state: "unknown" };
      const peerRows = provenance.holds.filter(row => row.peer === peer);
      const incompleteSessions = provenance.incompleteSessions.filter(row => row.peer === peer);
      if (sessionHash === undefined) return peerRows.length || incompleteSessions.length || !provenance.coverageComplete ? { state: "unknown" } : { state: "clean" };
      const row = peerRows.find(value => value.sessionHash === sessionHash);
      if (row?.inputHash !== null && row?.inputHash !== undefined) return { state: "held", inputHash: row.inputHash };
      if (incompleteSessions.some(value => value.sessionHash === sessionHash)) return { state: "unknown" };
      if (row?.inputHash === null) return { state: "clean" };
      if (!provenance.coverageComplete) return { state: "unknown" };
      if (!row) return { state: "clean" };
      return { state: "unknown" };
    } catch { return { state: "unknown" }; }
  }
  /** Cause projection for host admission; preserves reviewInputState's stable public shape. */
  reviewInputEvidence(peerValue: string, sessionHashValue?: string): ReviewInputEvidence {
    this.ensureOpen();
    try {
      this.refreshReviewInputCoverage();
      const peer = text(peerValue, "review input peer", 256), sessionHash = sessionHashValue === undefined ? undefined : hashText(sessionHashValue, "review input session hash");
      const provenance = this.readReviewInputProvenance();
      if (!provenance.complete) return { provenance: "corrupt", coverageComplete: false, incompletePeer: false, incompleteSession: false, sessionState: "unknown", retainedSessionHold: false, retainedPeerSessionHold: false };
      const sessionState = this.reviewInputState(peer, sessionHash).state;
      return {
        provenance: "available",
        coverageComplete: provenance.coverageComplete,
        incompletePeer: provenance.incompletePeers.includes(peer),
        incompleteSession: sessionHash !== undefined && provenance.incompleteSessions.some(row => row.peer === peer && row.sessionHash === sessionHash),
        sessionState,
        retainedSessionHold: sessionHash !== undefined && provenance.holds.some(row => row.peer === peer && row.sessionHash === sessionHash && row.inputHash !== null),
        retainedPeerSessionHold: provenance.holds.some(row => row.peer === peer && row.inputHash !== null) || provenance.incompleteSessions.some(row => row.peer === peer),
      };
    } catch {
      return { provenance: "corrupt", coverageComplete: false, incompletePeer: false, incompleteSession: false, sessionState: "unknown", retainedSessionHold: false, retainedPeerSessionHold: false };
    }
  }
  /** Public-safe journal health; positive held receipts are normal, expected state. */
  reviewInputHealth(): ReviewInputHealth {
    this.ensureOpen();
    try {
      this.refreshReviewInputCoverage();
      const provenance = this.readReviewInputProvenance();
      if (!provenance.complete) return { state: "corrupt", cause: "provenance_incomplete", nextStep: "Keep affected peers held and inspect or repair only review-input provenance, preserving delivery and task state." };
      if (provenance.incompletePeers.length || provenance.incompleteSessions.length) return { state: "incomplete", cause: "incomplete_markers", nextStep: "Verify the peer's next ordinary input or confirmed session change to clear its incomplete marker." };
      if (!provenance.coverageComplete) return { state: "incomplete", cause: "legacy_coverage", nextStep: "Allow existing review-marked deliveries to settle; coverage clears when the journal confirms none remain." };
      return { state: "healthy", cause: null, nextStep: "No action required." };
    } catch {
      return { state: "corrupt", cause: "provenance_corrupt", nextStep: "Keep affected peers held and inspect or repair only review-input provenance, preserving delivery and task state." };
    }
  }
  /** Compatibility reader: only positive held hashes are returned; clean and unknown stay absent. */
  readReviewInput(peerValue: string, sessionHashValue: string): string | undefined {
    const state = this.reviewInputState(peerValue, sessionHashValue);
    return state.state === "held" ? state.inputHash : undefined;
  }
  clearReviewInput(peerValue: string, sessionHashValue: string): void {
    this.ensureOpen();
    const peer = text(peerValue, "review input peer", 256), sessionHash = hashText(sessionHashValue, "review input session hash");
    const prior = this.readReviewInputProvenance(), existing = prior.holds.find(row => row.peer === peer && row.sessionHash === sessionHash);
    if (!prior.complete) fail("review input provenance is incomplete");
    const pending = prior.incompleteSessions.some(row => row.peer === peer && row.sessionHash === sessionHash);
    const incompletePeer = prior.incompletePeers.includes(peer);
    const legacyConfirmation = !prior.coverageComplete && !existing && !pending;
    if ((!existing || existing.inputHash === null) && !pending && !legacyConfirmation && !incompletePeer) return;
    if (!existing && !pending && !incompletePeer && prior.count >= MAX_REVIEW_INPUTS) {
      this.markReviewInputCoverageIncomplete(prior);
      fail(`too many review input provenance rows (limit ${MAX_REVIEW_INPUTS})`);
    }
    this.writePendingReviewInputSession(peer, sessionHash, prior.complete, prior.coverageComplete, true);
    this.transaction(() => {
      this.bump();
      this.db.query("INSERT INTO review_input_sessions(project_id,peer,session_hash,input_hash) VALUES(?,?,?,NULL) ON CONFLICT(project_id,peer,session_hash) DO UPDATE SET input_hash=NULL")
        .run(this.projectId, peer, sessionHash);
      this.db.query("DELETE FROM review_input_incomplete_sessions WHERE project_id=? AND peer=? AND session_hash=?")
        .run(this.projectId, peer, sessionHash);
      this.db.query("DELETE FROM review_input_incomplete_peers WHERE project_id=? AND peer=?")
        .run(this.projectId, peer);
      this.writeReviewInputProvenance(prior.complete, prior.coverageComplete);
      this.harden();
    });
    this.refreshReviewInputCoverage();
  }
  /** A verified ordinary input or confirmed SID change clears only this peer-level incomplete marker. */
  clearReviewInputIncomplete(peerValue: string): void {
    this.ensureOpen();
    const peer = text(peerValue, "incomplete review input peer", 256), prior = this.readReviewInputProvenance();
    if (!prior.complete) fail("review input provenance is incomplete");
    if (!prior.incompletePeers.includes(peer)) return;
    this.transaction(() => {
      const current = this.readReviewInputProvenance();
      if (!current.incompletePeers.includes(peer)) return;
      this.bump();
      this.db.query("DELETE FROM review_input_incomplete_peers WHERE project_id=? AND peer=?").run(this.projectId, peer);
      this.writeReviewInputProvenance(current.complete, current.coverageComplete);
      this.harden();
    });
  }
  /** Forget one closed ephemeral observer receipt only if its exact positive/clear hash still matches. */
  forgetClosedObserverInput(peerValue: string, sessionHashValue: string, expectedInputHash: string | null): boolean {
    this.ensureOpen();
    try {
      const peer = text(peerValue, "review input peer", 256), sessionHash = hashText(sessionHashValue, "review input session hash");
      if (expectedInputHash !== null) hashText(expectedInputHash, "expected review input hash");
      const prior = this.readReviewInputProvenance();
      if (!prior.complete || prior.incompletePeers.includes(peer) || prior.incompleteSessions.some(row => row.peer === peer && row.sessionHash === sessionHash)) return false;
      if (!prior.holds.some(row => row.peer === peer && row.sessionHash === sessionHash && row.inputHash === expectedInputHash)) return false;
      return this.transaction(() => {
        const current = this.readReviewInputProvenance();
        if (!current.complete || current.incompletePeers.includes(peer) || current.incompleteSessions.some(row => row.peer === peer && row.sessionHash === sessionHash)
          || !current.holds.some(row => row.peer === peer && row.sessionHash === sessionHash && row.inputHash === expectedInputHash)) return false;
        this.bump();
        this.db.query("DELETE FROM review_input_sessions WHERE project_id=? AND peer=? AND session_hash=? AND input_hash IS ?")
          .run(this.projectId, peer, sessionHash, expectedInputHash);
        if (Number((this.db.query("SELECT changes() AS n").get() as { n: number }).n) !== 1) throw new Error("review input receipt changed during closed-session cleanup");
        this.writeReviewInputProvenance(current.complete, current.coverageComplete);
        this.harden();
        return true;
      });
    } catch { return false; }
  }
  markReviewInputIncomplete(peerValue: string, sessionHashValue?: string): void {
    this.ensureOpen();
    const peer = text(peerValue, "incomplete review input peer", 256);
    const prior = this.readReviewInputProvenance();
    if (!prior.complete) fail("review input provenance is incomplete");
    const sessionHash = sessionHashValue === undefined ? undefined : hashText(sessionHashValue, "incomplete review input session hash");
    if (sessionHash !== undefined && prior.incompleteSessions.some(row => row.peer === peer && row.sessionHash === sessionHash)) return;
    if (sessionHash === undefined && prior.incompletePeers.includes(peer)) return;
    if (prior.count >= MAX_REVIEW_INPUTS) {
      this.markReviewInputCoverageIncomplete(prior);
      fail(`too many review input provenance rows (limit ${MAX_REVIEW_INPUTS})`);
    }
    this.transaction(() => {
      this.bump();
      if (sessionHash === undefined) this.db.query("INSERT OR IGNORE INTO review_input_incomplete_peers(project_id,peer) VALUES(?,?)").run(this.projectId, peer);
      else this.db.query("INSERT OR IGNORE INTO review_input_incomplete_sessions(project_id,peer,session_hash) VALUES(?,?,?)").run(this.projectId, peer, sessionHash);
      this.writeReviewInputProvenance(prior.complete, prior.coverageComplete);
      this.harden();
    });
  }
  hasReviewInputState(): boolean {
    this.ensureOpen();
    try {
      this.refreshReviewInputCoverage();
      const provenance = this.readReviewInputProvenance();
      return !provenance.complete || !provenance.coverageComplete || provenance.holds.some(row => row.inputHash !== null) || provenance.incompletePeers.length > 0 || provenance.incompleteSessions.length > 0;
    } catch { return true; }
  }
  private snapshotTransportBase(meta: Record<string, unknown>): JournalTransportSnapshot {
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
    const result: JournalTransportSnapshot = {
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
  /** Transport restoration may proceed from the validated bus/delivery projection while review provenance remains unknown. */
  transportSnapshot(): JournalTransportSnapshot {
    this.ensureOpen();
    const meta = this.readMeta();
    if (!meta) throw new Error("delivery journal metadata missing");
    return this.snapshotTransportBase(meta);
  }
  /** Strict recovery snapshot: malformed or incomplete review provenance refuses recovery. */
  snapshot(): JournalSnapshot {
    this.ensureOpen();
    const meta = this.readMeta();
    if (!meta) throw new Error("delivery journal metadata missing");
    const base = this.snapshotTransportBase(meta);
    const result: JournalSnapshot = { ...base, reviewInputProvenance: this.readReviewInputProvenance(meta) };
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
      this.refreshReviewInputCoverage(true);
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
      this.refreshReviewInputCoverage(true);
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
      // Grouped parents are not linked until the handoff INSERT.
      return this.withPruningDeferred(() => {
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
      });
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
      const completed = this.withPruningDeferred(() => {
        const result = this.transition(deliveryId, "completed", reason, row.revision);
        const put = this.db.query("INSERT OR IGNORE INTO task_offer_reads (project_id,peer,envelope_id,delivery_id,source,offer_revision) VALUES (?,?,?,?,?,?)");
        for (const env of row.originals) if (env.from === HUB && env.kind === "task" && Number.isSafeInteger(env.refs?.taskOffer) && env.refs!.taskOffer! >= 1) put.run(this.projectId, peer, env.id, deliveryId, source, env.refs!.taskOffer!);
        return result;
      });
      // Proof is now durable in this transaction, and the return receipt is captured.
      this.pruneTerminal("completed", "");
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
      // A repeated accepted receipt is not fresh evidence and must not renew the settle deadline.
      if (old.state === state && state === "accepted") return old;
      const revision = this.bump();
      this.db
        .query(
          "UPDATE deliveries SET state = ?, revision = ?, updated_at = ?, reason = ? WHERE id = ? AND project_id = ?",
        )
        .run(state, revision, Date.now(), reason ?? null, id, this.projectId);
      this.refreshReviewInputCoverage(true);
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
  /** Explicit package recovery reads durable publication evidence, not the bounded in-memory reply cache. */
  reviewEnvelopeState(id: string, expected?: Envelope): JournalDeliveryState | undefined {
    this.ensureOpen();
    const published = this.db.query(`SELECT d.state AS state, e.value AS envelope FROM deliveries d, json_each(d.originals) e
      WHERE d.project_id=? AND json_extract(e.value,'$.id')=? AND json_extract(e.value,'$.from')='hub'
      AND json_extract(e.value,'$.kind')='review' AND json_extract(e.value,'$.refs.reviewPackage') GLOB 'review-*'
      ORDER BY d.updated_at DESC, d.revision DESC LIMIT 1`).get(this.projectId, id) as { state: JournalDeliveryState; envelope: string } | null;
    // A queued/deferred publication can precede its first physical delivery row.
    const saved = published ?? this.db.query(`SELECT e.value AS envelope FROM delivery_meta m, json_tree(m.bus_snapshot) e
      WHERE m.project_id=? AND e.type='object' AND json_extract(e.value,'$.id')=?
      AND json_extract(e.value,'$.from')='hub' AND json_extract(e.value,'$.kind')='review'
      AND json_extract(e.value,'$.refs.reviewPackage') GLOB 'review-*' LIMIT 1`).get(this.projectId, id) as { envelope: string } | null;
    if (saved && expected && !isDeepStrictEqual(validateEnvelope(JSON.parse(saved.envelope), "saved review package"), validateEnvelope(expected, "review package")))
      throw new Error("saved review envelope differs from its publication evidence; inspect the package and queue before retrying");
    return published?.state ?? (saved ? "queued" : undefined);
  }
  reviewEnvelopePublished(id: string, expected?: Envelope): boolean {
    return this.reviewEnvelopeState(id, expected) !== undefined;
  }
  /** Pending review recipients remain quote-bearing even when the task's current roles have moved. */
  hasUnsettledReviewScope(peer: string, task?: number): boolean {
    this.ensureOpen();
    const taskId = task === undefined ? null : String(task);
    return !!this.db.query(`SELECT 1 FROM deliveries d, json_each(d.originals) e
        WHERE d.project_id=?1 AND d.peer=?2 AND d.state IN ('queued','dispatching','accepted','needs_review')
          AND json_extract(e.value,'$.from')='hub' AND json_extract(e.value,'$.kind')='review'
          AND json_type(e.value,'$.refs.reviewPackage')='text' AND (?3 IS NULL OR json_extract(e.value,'$.refs.task')=?3)
      UNION ALL SELECT 1 FROM delivery_meta m, json_each(m.bus_snapshot,'$.queues') q, json_each(q.value) e
        WHERE m.project_id=?1 AND q.key=?2 AND json_extract(e.value,'$.from')='hub' AND json_extract(e.value,'$.kind')='review'
          AND json_type(e.value,'$.refs.reviewPackage')='text' AND (?3 IS NULL OR json_extract(e.value,'$.refs.task')=?3)
      UNION ALL SELECT 1 FROM delivery_meta m, json_each(m.bus_snapshot,'$.deferredHub') e, json_each(e.value,'$.to') recipient
        WHERE m.project_id=?1 AND recipient.value=?2 AND json_extract(e.value,'$.from')='hub' AND json_extract(e.value,'$.kind')='review'
          AND json_type(e.value,'$.refs.reviewPackage')='text' AND (?3 IS NULL OR json_extract(e.value,'$.refs.task')=?3)
      LIMIT 1`).get(this.projectId, peer, taskId);
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
  heldDeliveryHints(peer: string, includeAccepted = false) {
    this.ensureOpen();
    const states = includeAccepted ? "('needs_review','accepted')" : "('needs_review')";
    const count = Number((this.db.query(`SELECT COUNT(*) AS n FROM deliveries WHERE project_id = ? AND peer = ? AND state IN ${states}`).get(this.projectId, peer) as { n: number }).n);
    const rows = this.db.query(`SELECT d.id, d.revision, d.created_at, d.state, (SELECT json_group_array(DISTINCT json_extract(env.value, '$.from')) FROM json_each(d.originals) env) AS senders, (SELECT json_group_array(DISTINCT json_extract(env.value, '$.kind')) FROM json_each(d.originals) env) AS kinds FROM deliveries d WHERE d.project_id = ? AND d.peer = ? AND d.state IN ${states} ORDER BY d.created_at, d.id LIMIT 33`).all(this.projectId, peer) as { id: string; revision: number; created_at: number; state: "accepted" | "needs_review"; senders: string; kinds: string }[];
    return heldDeliveryHints(rows.map(row => ({ id: row.id, revision: row.revision, createdAt: row.created_at, ...(includeAccepted ? { state: row.state } : {}), senders: JSON.parse(row.senders) as string[], kinds: JSON.parse(row.kinds) as Kind[] })), count);
  }

  /** Bounded indexed scan; the caller performs a revision-fenced state transition. */
  expiredAccepted(cutoff: number, peers: readonly string[], limit = 256): AcceptedDeliveryCandidate[] {
    this.ensureOpen(); integer(cutoff, "accepted cutoff"); integer(limit, "accepted expiry limit", 1, 1024);
    if (!peers.length) return [];
    if (peers.length > 4096) fail("accepted expiry peer set is too large");
    for (const peer of peers) text(peer, "accepted expiry peer", 256);
    const placeholders = peers.map(() => "?").join(",");
    const rows = this.db.query(`SELECT d.id,d.peer,d.revision,d.updated_at,EXISTS(SELECT 1 FROM json_each(d.originals) env WHERE json_extract(env.value,'$.priority')='important' OR json_extract(env.value,'$.kind') IN ('review','task')) AS notify_conductor FROM deliveries d WHERE d.project_id = ? AND d.state = 'accepted' AND d.updated_at <= ? AND d.peer IN (${placeholders}) ORDER BY d.updated_at,d.id LIMIT ?`).all(this.projectId, cutoff, ...peers, limit) as { id: unknown; peer: unknown; revision: unknown; updated_at: unknown; notify_conductor: unknown }[];
    return rows.map(row => ({ id: text(row.id, "accepted expiry id", 256), peer: text(row.peer, "accepted expiry peer", 256), revision: integer(row.revision, "accepted expiry revision"), updatedAt: integer(row.updated_at, "accepted expiry age"), notifyConductor: row.notify_conductor === 1 }));
  }

  /** Cheap recovery guard for timeout holds; reads no delivery payloads. */
  hasAcceptedTimeoutHolds(): boolean {
    this.ensureOpen();
    return !!this.db.query("SELECT 1 FROM deliveries WHERE project_id = ? AND state = 'needs_review' AND reason = ? LIMIT 1").get(this.projectId, ACCEPTED_SETTLE_TIMEOUT_REASON);
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
    allowAcceptedPeerDisposition = false,
  ): JournalDelivery {
    this.ensureOpen();
    text(reason, "resolution reason", 1_000_000);
    integer(revision, "observed revision");
    if (!ACTIONS.has(action)) throw new Error("invalid resolution action");
    return this.transaction(() => {
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
      if (actor.startsWith("peer:")) {
        const peer = actor.slice(5);
        const recipientRetry = action === "retry" && current.peer === peer && current.state === "needs_review" && this.retryEvidence(current.peer, current.originals) === "unused";
        const ownerDisposition = (action === "completed" || action === "discard") && current.peer === peer && (current.state === "needs_review" || current.state === "accepted" && allowAcceptedPeerDisposition === true);
        if (!recipientRetry && !ownerDisposition) throw new Error("recipient delivery resolution unavailable; inspect the held delivery or ask the person");
      }
      if (current.revision !== revision)
        throw new Error(`stale delivery revision for ${id}`);
      if (
        ["completed", "discarded"].includes(current.state) &&
        actionState(action) !== current.state
      )
        throw new Error(`delivery ${id} is already terminal`);
      const retryChildId = action === "retry" ? `${id}:retry:${(current.attempt ?? 0) + 1}` : undefined;
      if (retryChildId && this.legacyReviewCandidateIds.has(id) && !this.legacyReviewCandidateIds.has(retryChildId)) {
        if (this.legacyReviewCandidateIds.size >= MAX_REVIEW_INPUTS) this.legacyReviewCandidatesOverflow = true;
        else this.legacyReviewCandidateIds = new Set([...this.legacyReviewCandidateIds, retryChildId]);
      }
      const result = this.transition(id, actionState(action), reason, revision);
      if (action === "retry") {
        const childId = retryChildId!;
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
  /** #1096: the ids of every delivery an operator action (completed, retry, discard) already settled. One query, so a list of any length costs one read. */
  resolvedIds(): Set<string> {
    this.ensureOpen();
    const rows = this.db.query("SELECT DISTINCT delivery_id FROM resolution_history WHERE project_id=?").all(this.projectId) as { delivery_id: string }[];
    return new Set(rows.map(row => row.delivery_id));
  }
  resolution(id: string): { action: JournalResolution; reason: string; observedRevision: number; actor: string } | undefined {
    const row = this.db.query("SELECT action,reason,observed_revision,actor FROM resolution_history WHERE project_id=? AND delivery_id=? ORDER BY id DESC LIMIT 1").get(this.projectId, id) as { action: JournalResolution; reason: string; observed_revision: number; actor: string } | null;
    return row ? { action: row.action, reason: row.reason, observedRevision: row.observed_revision, actor: row.actor } : undefined;
  }
  private withPruningDeferred<T>(body: () => T): T {
    this.pruningDeferred++;
    try { return body(); } finally { this.pruningDeferred--; }
  }
  private pruneTerminal(state: JournalDeliveryState, currentId: string): void {
    if (this.pruningDeferred) return;
    const terminal = state === "completed" || state === "discarded" || state === "failed";
    const terminalCap = terminal ? this.terminalHistoryLimit?.() ?? TERMINAL_CAP : TERMINAL_CAP;
    let protectedReviewCandidates: string[] = [];
    try {
      if (!this.readReviewInputProvenance().coverageComplete) protectedReviewCandidates = [...this.legacyReviewCandidateIds];
    } catch { protectedReviewCandidates = [...this.legacyReviewCandidateIds]; }
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
    // ponytail: person-package receipts retain their terminal payload alongside the saved board package.
    // A future package archival transaction can replace both with an IDs-only publication tombstone.
    this.db
      .query(
        "DELETE FROM deliveries WHERE id IN (SELECT d.id FROM deliveries d WHERE d.project_id = ? AND d.state IN ('completed','discarded','failed') AND d.id != ? AND NOT EXISTS (SELECT 1 FROM json_each(?) protected WHERE protected.value=d.id) AND NOT EXISTS (SELECT 1 FROM json_each(d.originals) e WHERE json_extract(e.value,'$.from')='hub' AND json_extract(e.value,'$.kind')='review' AND json_extract(e.value,'$.refs.reviewPackage') GLOB 'review-*') AND NOT EXISTS (SELECT 1 FROM deliveries c WHERE c.project_id = d.project_id AND c.previous_id = d.id) ORDER BY d.updated_at, d.id LIMIT ?)",
      )
      .run(this.projectId, currentId, JSON.stringify(protectedReviewCandidates), count - terminalCap);
  }
  importSnapshot(snapshot: JournalSnapshot, operationId: string, trackQueuePressure = false): boolean {
    this.ensureOpen();
    validateJournalSnapshot(snapshot);
    const bus = this.queueMetadataSnapshot(snapshot.bus, trackQueuePressure);
    const importedReviewInput = snapshot.reviewInputProvenance ?? { version: REVIEW_INPUT_VERSION, instanceId: snapshot.instanceId, complete: true, coverageComplete: false, count: 0, digest: reviewInputDigest(snapshot.instanceId, REVIEW_INPUT_VERSION, true, false, 0, [], [], []), holds: [], incompletePeers: [], incompleteSessions: [] };
    const reviewInputProvenance: ReviewInputProvenance = { ...importedReviewInput, instanceId: this.instanceId, digest: reviewInputDigest(this.instanceId, REVIEW_INPUT_VERSION, importedReviewInput.complete, importedReviewInput.coverageComplete, importedReviewInput.count, importedReviewInput.holds, importedReviewInput.incompletePeers, importedReviewInput.incompleteSessions) };
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
    const imported = this.queueMetadataTransaction(trackQueuePressure, () => {
      this.db
        .query(
          "UPDATE delivery_meta SET revision = ?, bus_snapshot = ?, manual_paused = ?, operation_id = ?, review_input_version=?,review_input_complete=?,review_input_coverage_complete=?,review_input_count=?,review_input_digest=?,review_input_instance_id=? WHERE project_id = ?",
        )
        .run(
          snapshot.revision,
          JSON.stringify(bus),
          JSON.stringify(snapshot.manualPaused),
          operationId,
          REVIEW_INPUT_VERSION,
          reviewInputProvenance.complete ? 1 : 0,
          reviewInputProvenance.coverageComplete ? 1 : 0,
          reviewInputProvenance.count,
          reviewInputProvenance.digest,
          this.instanceId,
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
      for (const raw of reviewInputProvenance.holds) {
        const hold = reviewInputHold(raw, "snapshot review input");
        this.db.query("INSERT INTO review_input_sessions(project_id,peer,session_hash,input_hash) VALUES(?,?,?,?)")
          .run(this.projectId, hold.peer, hold.sessionHash, hold.inputHash);
      }
      for (const peer of reviewInputProvenance.incompletePeers) this.db.query("INSERT INTO review_input_incomplete_peers(project_id,peer) VALUES(?,?)").run(this.projectId, peer);
      for (const row of reviewInputProvenance.incompleteSessions) this.db.query("INSERT INTO review_input_incomplete_sessions(project_id,peer,session_hash) VALUES(?,?,?)").run(this.projectId, row.peer, row.sessionHash);
      // Snapshots deliberately omit resolution history; only these imported originals have unknown retry rights.
      this.markRetryUnknown(snapshot.deliveries, bus);
      return true;
    });
    if (imported) this.captureLegacyReviewCandidates();
    return imported;
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
