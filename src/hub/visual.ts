import type { VisualPayload, VisualSide, TableColumn } from "@staix/agent-console/contract";
import { types } from "node:util";
import { createHash } from "node:crypto";
import { openHubDatabase, type Database } from "./db-schema.ts";
import { sanitize } from "./envelope.ts";
export type { VisualPayload, VisualSide, TableColumn };
export type VisualInputSide = { text: string } | { path: string; alt: string };
export type VisualInput = Exclude<VisualPayload, { kind: "beforeAfter" }> | { kind: "beforeAfter"; caption?: string; before: VisualInputSide; after: VisualInputSide };
export interface VisualFile { asset: string; path: string; sha256: string; bytes: number; mime: "image/png" | "image/jpeg" | "image/webp" }
export interface VisualRecord { id: string; task?: number; from: string; kind: VisualPayload["kind"]; title: string; payload: VisualPayload; files: VisualFile[]; created: number }
export type VisualSummary = Pick<VisualRecord, "id" | "task" | "from" | "kind" | "title" | "created">;
export const VISUAL_ID_PATTERN = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
/** Acon 0.1.7 source limit counts UTF-16 code units; the hub's UTF-8 byte limit is intentionally stricter.
 * Option/point bounds come from contract.ts; table caps from shell.js UI_LIMITS.
 * Other byte ceilings are explicit hub admission bounds, not additions to the acon type. No truncation. */
export const VISUAL_LIMITS = Object.freeze({ source: 20 * 1024, options: 6, points: 10, rows: 500, columns: 12,
  title: 300, caption: 2000, alt: 1000, text: 20 * 1024, summary: 4000, point: 2000, cell: 4000, key: 128,
  path: 4096, asset: 256, payload: 1024 * 1024, filesJson: 32 * 1024, image: 8 * 1024 * 1024 });
const DAY_MS = 86_400_000, DEFAULT_RETENTION_DAYS = 30, DEFAULT_LIST_LIMIT = 20, MAX_LIST_LIMIT = 100;
const MERMAID = /^(?:flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram|gantt|mindmap|pie|journey|timeline)(?=\s|;|$)/;
type Screen = (text: string) => boolean;
const bytes = (value: string) => Buffer.byteLength(value, "utf8");
export class VisualValidationError extends Error {
  constructor(readonly field: string, reason: string) { super(`${field}: ${reason}; correct the field and retry hub_visual`); this.name = "VisualValidationError"; }
}
function fail(field: string, reason: string): never { throw new VisualValidationError(field, reason); }
/** Clone JSON through data descriptors only: no getters, toJSON, proxies, cycles or custom prototypes execute. */
function jsonCopy(input: unknown, field: string, cap: number): unknown {
  let size = 0; const ancestors = new Set<object>();
  const knownFields = new Set(["kind", "source", "title", "options", "summary", "pros", "cons", "recommended", "caption", "columns", "rows", "key", "label", "align", "format", "before", "after", "text", "path", "asset", "alt", "id", "task", "from", "payload", "files", "created", "sha256", "bytes", "mime"]);
  const add = (n: number) => { size += n; if (size > cap) fail(field, `serialized JSON exceeds ${cap} UTF-8 bytes`); };
  const copy = (value: unknown, depth: number, location: string): unknown => {
    if (depth > 8) fail(location, "JSON nesting exceeds the visual shape");
    if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number" && Number.isFinite(value)) {
      add(bytes(JSON.stringify(value))); return value;
    }
    if (!value || typeof value !== "object" || types.isProxy(value)) fail(location, "expected finite JSON data");
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail(location, "custom prototypes are not accepted");
    if (ancestors.has(value) || Object.getOwnPropertySymbols(value).length) fail(location, "cyclic or symbol-keyed data is not accepted");
    const descriptors = Object.getOwnPropertyDescriptors(value), names = Object.keys(descriptors);
    if (names.some(name => !Object.hasOwn(descriptors[name]!, "value"))) fail(location, "accessor properties are not accepted");
    ancestors.add(value);
    try {
      if (array) {
        const length = descriptors.length?.value;
        if (!Number.isInteger(length) || length < 0 || length > VISUAL_LIMITS.rows || names.length !== length + 1) fail(location, "expected a dense bounded array");
        add(2 + Math.max(0, length - 1)); const out: unknown[] = [];
        for (let i = 0; i < length; i++) { if (!Object.hasOwn(descriptors, String(i))) fail(location, "sparse arrays are not accepted"); out.push(copy(descriptors[String(i)]!.value, depth + 1, `${location}[${i}]`)); }
        return out;
      }
      add(2 + Math.max(0, names.length - 1)); const out: Record<string, unknown> = {};
      for (const name of names) {
        if (!descriptors[name]!.enumerable) fail(location, "non-enumerable data is not accepted");
        add(bytes(JSON.stringify(name)) + 1);
        Object.defineProperty(out, name, { value: copy(descriptors[name]!.value, depth + 1, `${location}.${knownFields.has(name) ? name : "value"}`), enumerable: true, writable: true, configurable: true });
      }
      return out;
    } finally { ancestors.delete(value); }
  };
  return copy(input, 0, field);
}
function object(value: unknown, required: readonly string[], optional: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field, "expected an object");
  const row = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) fail(field, "required fields are missing or unknown fields are present");
  return row;
}
function text(value: unknown, cap: number, field: string, screen: Screen, nonempty = false, preserve = false): string {
  if (typeof value !== "string" || bytes(value) > cap) fail(field, `expected text of at most ${cap} UTF-8 bytes`);
  const clean = sanitize(value);
  if (bytes(clean) > cap || nonempty && !clean.trim()) fail(field, "sanitized text is empty or exceeds its byte bound");
  try { if (screen(value) !== true || screen(clean) !== true) fail(field, "privacy pattern screen refused this text"); }
  catch (error) { if (error instanceof VisualValidationError) throw error; fail(field, "privacy screen unavailable"); }
  return preserve ? value : clean;
}
function identityText(value: unknown, cap: number, field: string, screen: Screen): string {
  const clean = text(value, cap, field, screen, true);
  if (clean !== value) fail(field, "sanitization changes an identifier; use a plain identifier");
  return clean;
}
function pathText(value: unknown, field: string, screen: Screen): string {
  const result = text(value, VISUAL_LIMITS.path, field, screen, true, true);
  if (/[\p{Cc}\p{Cf}]/u.test(result)) fail(field, "file paths cannot contain control characters");
  return result;
}
function list(value: unknown, maximum: number, field: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail(field, `expected an array of at most ${maximum} items`);
  return value;
}
function validate(input: unknown, screen: Screen, assets: boolean): VisualPayload | VisualInput {
  const raw = jsonCopy(input, "payload", VISUAL_LIMITS.payload), base = object(raw, ["kind"], ["source", "title", "options", "caption", "columns", "rows", "before", "after"], "payload");
  const optional = (row: Record<string, unknown>, key: string, cap: number, field: string) => Object.hasOwn(row, key) ? { [key]: text(row[key], cap, field, screen) } : {};
  let result: VisualPayload | VisualInput;
  if (base.kind === "mermaid") {
    const row = object(raw, ["kind", "source"], ["title"], "payload"), source = text(row.source, VISUAL_LIMITS.source, "payload.source", screen, true);
    const header = source.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith("%%"));
    if (!header || !MERMAID.test(header)) fail("payload.source", "first non-comment line must start with a known Mermaid diagram keyword");
    result = { kind: "mermaid", source, ...optional(row, "title", VISUAL_LIMITS.title, "payload.title") };
  } else if (base.kind === "comparison") {
    const row = object(raw, ["kind", "options"], ["title"], "payload"), options = list(row.options, VISUAL_LIMITS.options, "payload.options");
    if (options.length < 2) fail("payload.options", "comparison requires 2 to 6 options");
    result = { kind: "comparison", ...optional(row, "title", VISUAL_LIMITS.title, "payload.title"), options: options.map((value, i) => {
      const field = `payload.options[${i}]`, option = object(value, ["title"], ["summary", "pros", "cons", "recommended"], field);
      const out: Extract<VisualPayload, { kind: "comparison" }>["options"][number] = { title: text(option.title, VISUAL_LIMITS.title, `${field}.title`, screen), ...optional(option, "summary", VISUAL_LIMITS.summary, `${field}.summary`) };
      for (const key of ["pros", "cons"] as const) if (Object.hasOwn(option, key)) out[key] = list(option[key], VISUAL_LIMITS.points, `${field}.${key}`).map((point, n) => text(point, VISUAL_LIMITS.point, `${field}.${key}[${n}]`, screen));
      if (Object.hasOwn(option, "recommended")) { if (typeof option.recommended !== "boolean") fail(`${field}.recommended`, "expected a boolean"); out.recommended = option.recommended; }
      return out;
    }) };
  } else if (base.kind === "table") {
    const row = object(raw, ["kind", "columns", "rows"], ["caption"], "payload"), keys = new Set<string>();
    const columns: TableColumn[] = list(row.columns, VISUAL_LIMITS.columns, "payload.columns").map((value, i) => {
      const field = `payload.columns[${i}]`, column = object(value, ["key", "label"], ["align", "format"], field);
      const key = identityText(column.key, VISUAL_LIMITS.key, `${field}.key`, screen); if (keys.has(key)) fail(`${field}.key`, "column keys must be distinct"); keys.add(key);
      const out: TableColumn = { key, label: text(column.label, VISUAL_LIMITS.title, `${field}.label`, screen, true) };
      if (Object.hasOwn(column, "align")) { if (column.align !== "start" && column.align !== "end") fail(`${field}.align`, "expected start or end"); out.align = column.align; }
      if (Object.hasOwn(column, "format")) { if (column.format !== "text" && column.format !== "number" && column.format !== "percent") fail(`${field}.format`, "expected text, number or percent"); out.format = column.format; }
      return out;
    });
    const rows = list(row.rows, VISUAL_LIMITS.rows, "payload.rows").map((value, i) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) fail(`payload.rows[${i}]`, "expected a cell record");
      const out: Record<string, string | number> = {};
      for (const [rawKey, cell] of Object.entries(value)) {
        const key = identityText(rawKey, VISUAL_LIMITS.key, `payload.rows[${i}].key`, screen);
        const clean = typeof cell === "string" ? text(cell, VISUAL_LIMITS.cell, `payload.rows[${i}].cell`, screen) : cell;
        if (typeof clean !== "string" && (typeof clean !== "number" || !Number.isFinite(clean))) fail(`payload.rows[${i}].cell`, "expected text or a finite number");
        Object.defineProperty(out, key, { value: clean, enumerable: true, writable: true, configurable: true });
      }
      return out;
    });
    result = { kind: "table", ...optional(row, "caption", VISUAL_LIMITS.caption, "payload.caption"), columns, rows };
  } else if (base.kind === "beforeAfter") {
    const row = object(raw, ["kind", "before", "after"], ["caption"], "payload");
    const side = (value: unknown, field: string): VisualSide | VisualInputSide => {
      if (value && typeof value === "object" && Object.hasOwn(value, "text")) { const v = object(value, ["text"], [], field); return { text: text(v.text, VISUAL_LIMITS.text, `${field}.text`, screen) }; }
      const name = assets ? "asset" : "path", v = object(value, [name], ["alt"], field), alt = text(v.alt, VISUAL_LIMITS.alt, `${field}.alt`, screen);
      return assets ? { asset: identityText(v.asset, VISUAL_LIMITS.asset, `${field}.asset`, screen), alt } : { path: pathText(v.path, `${field}.path`, screen), alt };
    };
    const before = side(row.before, "payload.before"), after = side(row.after, "payload.after");
    if (!assets && "path" in before && "path" in after && before.path === after.path) fail("payload.after.path", "before and after must name different files");
    result = { kind: "beforeAfter", ...optional(row, "caption", VISUAL_LIMITS.caption, "payload.caption"), before, after } as VisualPayload | VisualInput;
  } else fail("payload.kind", "expected mermaid, comparison, table or beforeAfter");
  if (bytes(JSON.stringify(result)) > VISUAL_LIMITS.payload) fail("payload", "sanitized serialized payload exceeds 1 MiB");
  return result;
}
export function validateVisualInput(input: unknown, screen: Screen): VisualInput { return validate(input, screen, false) as VisualInput; }
export function validateVisualPayload(input: unknown, screen: Screen): VisualPayload { return validate(input, screen, true) as VisualPayload; }

function integer(value: unknown, field: string, minimum = 0): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail(field, "expected a safe integer in range"); return value; }
function visualId(value: unknown): string { if (typeof value !== "string" || !VISUAL_ID_PATTERN.test(value)) fail("id", "expected a canonical lowercase UUID"); return value; }
function summary(input: unknown): VisualSummary {
  const row = object(input, ["id", "from", "kind", "title", "created"], ["task"], "record"), allow = () => true;
  const kind = row.kind; if (!["mermaid", "comparison", "table", "beforeAfter"].includes(kind as string)) fail("record.kind", "unknown visual kind");
  return { id: visualId(row.id), ...(Object.hasOwn(row, "task") ? { task: integer(row.task, "record.task", 1) } : {}), from: identityText(row.from, 128, "record.from", allow), kind: kind as VisualPayload["kind"], title: text(row.title, VISUAL_LIMITS.caption, "record.title", allow), created: integer(row.created, "record.created") };
}
function fileMetadata(input: unknown): VisualFile[] {
  const files = list(input, 2, "record.files").map((value, i): VisualFile => {
    const field = `record.files[${i}]`, file = object(value, ["asset", "path", "sha256", "bytes", "mime"], [], field);
    if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) fail(`${field}.sha256`, "expected lowercase SHA-256");
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.mime as string)) fail(`${field}.mime`, "only PNG, JPEG and WebP are accepted");
    const size = integer(file.bytes, `${field}.bytes`, 1); if (size > VISUAL_LIMITS.image) fail(`${field}.bytes`, "image exceeds 8 MiB");
    return { asset: identityText(file.asset, VISUAL_LIMITS.asset, `${field}.asset`, () => true), path: pathText(file.path, `${field}.path`, () => true), sha256: file.sha256, bytes: size, mime: file.mime as VisualFile["mime"] };
  });
  if (files.length === 2 && files[0]!.path === files[1]!.path) fail("record.files", "before and after must name different files");
  return files;
}
function record(input: unknown): VisualRecord {
  const row = object(jsonCopy(input, "record", VISUAL_LIMITS.payload + VISUAL_LIMITS.filesJson + 16 * 1024), ["id", "from", "kind", "title", "payload", "files", "created"], ["task"], "record");
  const meta = summary(Object.fromEntries(Object.entries(row).filter(([key]) => key !== "payload" && key !== "files"))), payload = validateVisualPayload(row.payload, () => true);
  if (meta.kind !== payload.kind || meta.title !== (payload.kind === "table" || payload.kind === "beforeAfter" ? payload.caption ?? "" : payload.title ?? "")) fail("record.title", "kind/title must agree with the stored payload");
  const files = fileMetadata(row.files);
  const expected = payload.kind === "beforeAfter" ? (["before", "after"] as const).flatMap(side => "asset" in payload[side] ? [{ asset: payload[side].asset, side }] : []) : [];
  if (files.length !== expected.length || new Set(files.map(file => file.asset)).size !== files.length || expected.some(value => value.asset !== `${meta.id}:${value.side}` || !files.some(file => file.asset === value.asset))) fail("record.files", "files must bind exactly the payload's originating visual asset sides");
  if (bytes(JSON.stringify(files)) > VISUAL_LIMITS.filesJson) fail("record.files", "file metadata exceeds its byte bound");
  return { ...meta, payload, files };
}
interface Raw { id: unknown; task: unknown; from: unknown; kind: unknown; title: unknown; created: unknown; payload_json?: unknown; files_json?: unknown }
const metadataColumns = `CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))<=36 THEN id END AS id,
 task, CASE WHEN typeof("from")='text' AND length(CAST("from" AS BLOB))<=128 THEN "from" END AS "from",
 CASE WHEN typeof(kind)='text' AND length(CAST(kind AS BLOB))<=32 THEN kind END AS kind,
 CASE WHEN typeof(title)='text' AND length(CAST(title AS BLOB))<=2000 THEN title END AS title, created`;
const metaOf = (raw: Raw) => summary({ id: raw.id, ...(raw.task === null ? {} : { task: raw.task }), from: raw.from, kind: raw.kind, title: raw.title, created: raw.created });
const jsonColumns = `CASE WHEN typeof(payload_json)='text' AND length(CAST(payload_json AS BLOB))<=${VISUAL_LIMITS.payload} THEN payload_json END AS payload_json,
 CASE WHEN typeof(files_json)='text' AND length(CAST(files_json AS BLOB))<=${VISUAL_LIMITS.filesJson} THEN files_json END AS files_json`;
function readRaw(raw: Raw): VisualRecord {
  try {
    if (typeof raw.payload_json !== "string" || typeof raw.files_json !== "string") fail("record", "stored JSON exceeds its bound or is invalid");
    return record({ ...metaOf(raw), payload: JSON.parse(raw.payload_json), files: JSON.parse(raw.files_json) });
  } catch { fail("record", "stored visual is corrupt; inspect hub.db before retrying"); }
}
/** Structure is checked again here. Task/private-turn/pattern authority remains the daemon caller's pre-effect boundary. */
export class VisualStore {
  private readonly db: Database;
  constructor(dbPath: string) {
    this.db = openHubDatabase(dbPath, { create: true });
    try { this.db.transaction(() => {
      this.db.run('CREATE TABLE IF NOT EXISTS visuals (id TEXT PRIMARY KEY,task INTEGER,"from" TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,payload_json TEXT NOT NULL,files_json TEXT NOT NULL,created INTEGER NOT NULL)');
      this.db.run("CREATE INDEX IF NOT EXISTS visuals_created ON visuals(created DESC,id)");
      this.db.run("CREATE INDEX IF NOT EXISTS visuals_task_created ON visuals(task,created DESC,id)");
    }).immediate(); } catch (error) { this.db.close(); throw error; }
  }
  insert(input: VisualRecord): void {
    const value = record(input);
    this.db.query('INSERT INTO visuals(id,task,"from",kind,title,payload_json,files_json,created) VALUES(?,?,?,?,?,?,?,?)').run(value.id, value.task ?? null, value.from, value.kind, value.title, JSON.stringify(value.payload), JSON.stringify(value.files), value.created);
  }
  get(id: string): VisualRecord | undefined {
    const raw = this.db.query<Raw, [string]>(`SELECT ${metadataColumns},${jsonColumns} FROM visuals WHERE id=?`).get(visualId(id));
    return raw ? readRaw(raw) : undefined;
  }
  hasRecords(): boolean { return this.db.query("SELECT 1 AS present FROM visuals LIMIT 1").get() !== null; }
  /** Stream bounded raw rows, not images. Length-prefixed canonical tuples bind every stored field and row loss. */
  integrity(): { count: number; digest: string } {
    const hash = createHash("sha256").update("hub-visual-integrity-v1");
    const statement = this.db.prepare<Raw, []>(`SELECT ${metadataColumns},${jsonColumns} FROM visuals ORDER BY id`);
    let count = 0;
    try {
      for (const raw of statement.iterate()) {
        readRaw(raw); // Corrupt or oversize rows refuse the entire inventory, never disappear from it.
        const tuple = JSON.stringify([raw.id, raw.task, raw.from, raw.kind, raw.title, raw.payload_json, raw.files_json, raw.created]);
        hash.update(`${bytes(tuple)}:`).update(tuple); count++;
        if (!Number.isSafeInteger(count)) fail("integrity", "visual count exceeds its safe range");
      }
    } finally { statement.finalize(); }
    return { count, digest: hash.digest("hex") };
  }
  list(input: { task?: number; limit?: number } = {}, accept?: (summary: VisualSummary, paths: readonly string[]) => boolean): VisualSummary[] {
    const row = object(jsonCopy(input, "list", 1024), [], ["task", "limit"], "list"), limit = Object.hasOwn(row, "limit") ? integer(row.limit, "list.limit", 1) : DEFAULT_LIST_LIMIT;
    if (limit > MAX_LIST_LIMIT) fail("list.limit", "at most 100 metadata rows may be returned");
    const task = Object.hasOwn(row, "task") ? integer(row.task, "list.task", 1) : undefined;
    const columns = metadataColumns + (accept ? `,CASE WHEN typeof(files_json)='text' AND length(CAST(files_json AS BLOB))<=${VISUAL_LIMITS.filesJson} THEN files_json END AS files_json` : "");
    const rows = task === undefined ? this.db.query<Raw, [number]>(`SELECT ${columns} FROM visuals ORDER BY created DESC,id LIMIT ?`).all(limit)
      : this.db.query<Raw, [number, number]>(`SELECT ${columns} FROM visuals WHERE task=? ORDER BY created DESC,id LIMIT ?`).all(task, limit);
    return rows.flatMap(raw => {
      const meta = metaOf(raw);
      if (!accept) return [meta];
      if (typeof raw.files_json !== "string") fail("record.files", "stored file metadata exceeds its bound or is invalid");
      let files: VisualFile[];
      try { files = fileMetadata(JSON.parse(raw.files_json)); }
      catch { fail("record.files", "stored file metadata is corrupt"); }
      return accept(meta, files.map(file => file.path)) ? [meta] : [];
    });
  }
  prune(retentionDays = DEFAULT_RETENTION_DAYS, now = Date.now(), taskExists?: (task: number) => boolean): number {
    const duration = integer(retentionDays, "retentionDays") * DAY_MS; integer(now, "now");
    if (!Number.isSafeInteger(duration)) fail("retentionDays", "retention duration exceeds its safe range");
    return this.db.transaction(() => {
      let count = this.db.query("DELETE FROM visuals WHERE task IS NULL AND created<?").run(now - duration).changes;
      if (taskExists) for (const row of this.db.query<{ task: number }, []>("SELECT DISTINCT task FROM visuals WHERE task IS NOT NULL").all()) {
        const task = integer(row.task, "record.task", 1), exists = taskExists(task);
        if (typeof exists !== "boolean") fail("taskExists", "task existence check unavailable");
        if (!exists) count += this.db.query("DELETE FROM visuals WHERE task=?").run(task).changes;
      }
      return count;
    }).immediate();
  }
  close(): void { this.db.close(); }
}
