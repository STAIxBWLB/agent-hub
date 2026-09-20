import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { BusSnapshot } from "./bus.ts";
import type { Envelope } from "./envelope.ts";

export type JournalDeliveryState =
  | "queued"
  | "dispatching"
  | "accepted"
  | "completed"
  | "needs_review"
  | "failed"
  | "discarded";
export type JournalResolution = "completed" | "retry" | "discard";
const SCHEMA_VERSION = 1,
  TERMINAL_CAP = 2048,
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
  if (typeof e.body !== "string" || e.body.length > 1_000_000) fail(`${name}.body is invalid`);
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
  private readonly operationId?: string;
  constructor(options: DeliveryJournalOptions) {
    this.file = options.file;
    this.projectRoot = text(options.projectRoot, "projectRoot", 4096);
    this.projectId = text(options.projectId, "projectId", 256);
    this.instanceId = text(options.instanceId, "instanceId", 256);
    this.operationId = options.operationId;
    mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 });
    this.db = new Database(options.file, { create: true });
    this.harden();
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = FULL");
    this.db.run("PRAGMA busy_timeout = 3000");
    this.createSchema();
    const meta = this.readMeta();
    if (!meta)
      this.db
        .query(
          "INSERT INTO delivery_meta (project_id, project_root, revision, instance_id, operation_id) VALUES (?, ?, 0, ?, ?)",
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
    this.db.run(
      `CREATE TABLE IF NOT EXISTS resolution_history (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, delivery_id TEXT NOT NULL, observed_revision INTEGER NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, result_revision INTEGER NOT NULL, result_state TEXT NOT NULL, UNIQUE(project_id, delivery_id, observed_revision, action, reason))`,
    );
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
        try {
          process.kill(Number(status.pid), 0);
          throw new Error("delivery journal is owned by a live instance");
        } catch (e) {
          if (e instanceof Error && e.message.includes("owned by a live"))
            throw e;
        }
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
    return revision;
  }
  transaction<T>(fn: () => T): T {
    this.ensureOpen();
    return this.db.transaction(fn)();
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
  persistBus(bus: unknown, manualPaused: string[]): number {
    this.ensureOpen();
    validateBus(bus);
    list(manualPaused, "manualPaused", 4096).forEach((id) =>
      text(id, "manualPaused[]", 256),
    );
    return this.db.transaction(() => {
      const revision = this.bump();
      this.db
        .query(
          "UPDATE delivery_meta SET bus_snapshot = ?, manual_paused = ? WHERE project_id = ?",
        )
        .run(
          JSON.stringify(checkedJSON(bus, "bus")),
          JSON.stringify([...new Set(manualPaused)].sort()),
          this.projectId,
        );
      this.harden();
      return revision;
    })();
  }
  /** Atomically persist a bus snapshot and any fan-out rows created for that snapshot. */
  persistBusAndDeliveries(
    bus: BusSnapshot,
    manualPaused: string[],
    deliveries: Array<
      Omit<JournalDelivery, "revision" | "updatedAt"> & { updatedAt?: number }
    >,
  ): number {
    this.ensureOpen();
    validateBus(bus);
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
    return this.db.transaction(() => {
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
    })();
  }
  checkpointDelivery(
    bus: BusSnapshot,
    delivery: Omit<JournalDelivery, "revision" | "updatedAt"> & {
      state: "dispatching";
    },
  ): JournalDelivery {
    validateBus(bus);
    validateDelivery({
      ...delivery,
      revision: 0,
      updatedAt: delivery.createdAt,
    });
    return this.db.transaction(() => {
      const ids = new Set(delivery.originals.map((env) => env.id));
      for (const row of this.list(delivery.peer)) {
        if (row.state !== "queued" || !row.originals.some((env) => ids.has(env.id))) continue;
        this.transition(row.id, "discarded", `grouped into delivery ${delivery.id}`);
        delivery = { ...delivery, previousId: delivery.previousId ?? row.id };
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
    })();
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
      return { ...input, revision, updatedAt };
    })();
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
      this.pruneTerminal();
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
  resolve(
    id: string,
    revision: number,
    action: JournalResolution,
    reason: string,
    requestRevision = revision,
  ): JournalDelivery {
    this.ensureOpen();
    text(reason, "resolution reason", 1_000_000);
    integer(revision, "observed revision");
    if (!ACTIONS.has(action)) throw new Error("invalid resolution action");
    return this.db.transaction(() => {
      const resolved = this.resolution(id);
      if (resolved) {
        const current = this.get(id);
        if (current && resolved.action === action && resolved.reason === reason && (requestRevision === resolved.observedRevision || requestRevision === current.revision)) return current;
        throw new Error("stale delivery revision or conflicting operator resolution");
      }
      const prior = this.db
        .query(
          "SELECT result_revision FROM resolution_history WHERE project_id = ? AND delivery_id = ? AND observed_revision = ? AND action = ? AND reason = ?",
        )
        .get(this.projectId, id, requestRevision, action, reason) as {
        result_revision: number;
      } | null;
      if (prior) return this.get(id)!;
      const current = this.get(id);
      if (!current) throw new Error(`unknown delivery ${id}`);
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
          "INSERT INTO resolution_history (project_id, delivery_id, observed_revision, action, reason, result_revision, result_state) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          this.projectId,
          id,
          requestRevision,
          action,
          reason,
          result.revision,
          result.state,
        );
      this.pruneTerminal();
      return result;
    })();
  }
  resolution(id: string): { action: JournalResolution; reason: string; observedRevision: number } | undefined {
    const row = this.db.query("SELECT action,reason,observed_revision FROM resolution_history WHERE project_id=? AND delivery_id=? ORDER BY id DESC LIMIT 1").get(this.projectId, id) as { action: JournalResolution; reason: string; observed_revision: number } | null;
    return row ? { action: row.action, reason: row.reason, observedRevision: row.observed_revision } : undefined;
  }
  private pruneTerminal(): void {
    const count = Number(
      (
        this.db
          .query(
            "SELECT COUNT(*) AS n FROM deliveries WHERE project_id = ? AND state IN ('completed','discarded')",
          )
          .get(this.projectId) as { n: number }
      ).n,
    );
    if (count <= TERMINAL_CAP) return;
    this.db
      .query(
        "DELETE FROM deliveries WHERE id IN (SELECT d.id FROM deliveries d WHERE d.project_id = ? AND d.state IN ('completed','discarded') AND NOT EXISTS (SELECT 1 FROM deliveries c WHERE c.project_id = d.project_id AND c.previous_id = d.id) ORDER BY d.updated_at, d.id LIMIT ?)",
      )
      .run(this.projectId, count - TERMINAL_CAP);
  }
  importSnapshot(snapshot: JournalSnapshot, operationId: string): boolean {
    this.ensureOpen();
    validateJournalSnapshot(snapshot);
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
    return this.db.transaction(() => {
      this.db
        .query(
          "UPDATE delivery_meta SET revision = ?, bus_snapshot = ?, manual_paused = ?, operation_id = ? WHERE project_id = ?",
        )
        .run(
          snapshot.revision,
          JSON.stringify(snapshot.bus),
          JSON.stringify(snapshot.manualPaused),
          operationId,
          this.projectId,
        );
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
      return true;
    })();
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
