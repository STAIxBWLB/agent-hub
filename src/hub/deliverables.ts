import { createHash } from "node:crypto";

/**
 * Deliverable records (#509a): which bytes a task delivered, bound to content hashes the hub computed itself. A claim names a file and its
 * format; the hub opens the file (`deliverable-files.ts`), hashes what it finds and records that. A hash an agent supplies is never read:
 * `parseDeliverableClaims` refuses any field it does not own, so a claimed `sha256` is a refusal, not an input.
 *
 * Pure: no filesystem, clock or config. Plain folders work because nothing here (or in the file reader) needs git, a PR or a snapshot.
 */

export const DELIVERABLE_LIMITS = Object.freeze({
  /** Records on one task. */
  count: 16,
  /** One file the hub will hash: larger is refused, never hashed in part. */
  fileBytes: 256 * 1024 * 1024,
  /** All files of one call. */
  totalBytes: 512 * 1024 * 1024,
  pathChars: 512,
  formatChars: 32,
  versionChars: 64,
});

/** What an agent may say about a deliverable. The hash, the size and the id are the hub's. */
export interface DeliverableClaim { path: string; format: string; version?: string }

/**
 * What the board stores: the claim plus what the hub measured. The board keeps the path of every record, because "changed since review" needs
 * it to find the file again (a PII task's row holds its full text there too). `private` marks a record whose path no other peer, log, event or
 * memory may see: every view goes through `publicDeliverables`, which shows a private record by id, hash and size only.
 */
export interface DeliverableRecord {
  id: string;
  /** Project-relative, forward slashes. Absent only in a public view of a private record. */
  path?: string;
  format: string;
  version?: string;
  sha256: string;
  bytes: number;
  private?: true;
}

export type DeliverableState = "unchanged" | "changed" | "missing" | "unknown";
export interface DeliverableStatus { id: string; sha256: string; state: DeliverableState; path?: string; format: string; version?: string; private?: true }

const FORMAT = /^[a-z0-9][a-z0-9.+-]{0,31}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^d-[0-9a-f]{12}$/;

const own = (value: unknown, keys: readonly string[], label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected an object`);
  const extra = Object.keys(value).filter(key => !keys.includes(key));
  if (extra.length) throw new Error(`${label}: unsupported field ${extra[0]!.slice(0, 32)}${extra.includes("sha256") || extra.includes("hash") || extra.includes("bytes") ? " (the hub hashes the file itself; a claimed hash is not used)" : ""}`);
  return value as Record<string, unknown>;
};

/** A project-relative spelling: forward slashes, no `.` or `..` segments, no NUL or control characters, not empty, not absolute. */
export function deliverablePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > DELIVERABLE_LIMITS.pathChars) throw new Error("deliverable path: expected 1 to 512 characters");
  if (/[\u0000-\u001f\u007f\\]/.test(value) || value.startsWith("/") || /^[A-Za-z]:/.test(value)) throw new Error("deliverable path: expected a relative path with forward slashes");
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) throw new Error("deliverable path: no empty, . or .. segments");
  return parts.join("/");
}

/** The claims of a `hub_task_done` or `hub_sdlc_record` call. A bad claim is refused whole: no partial record. */
export function parseDeliverableClaims(value: unknown): DeliverableClaim[] {
  if (!Array.isArray(value)) throw new Error("deliverables: expected a list");
  if (!value.length || value.length > DELIVERABLE_LIMITS.count) throw new Error(`deliverables: 1 to ${DELIVERABLE_LIMITS.count} entries`);
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const claim = own(raw, ["path", "format", "version"], `deliverables[${index}]`);
    const path = deliverablePath(claim.path);
    if (typeof claim.format !== "string" || !FORMAT.test(claim.format)) throw new Error(`deliverables[${index}].format: expected a lowercase label such as md, pdf, docx or csv`);
    if (claim.version !== undefined && (typeof claim.version !== "string" || !VERSION.test(claim.version))) throw new Error(`deliverables[${index}].version: expected a short label such as v2 or 2026-10`);
    if (seen.has(path)) throw new Error(`deliverables[${index}]: ${path} is named twice`);
    seen.add(path);
    return { path, format: claim.format, ...(claim.version !== undefined ? { version: claim.version } : {}) };
  });
}

/** An opaque stable id for a deliverable: its path and format, so a changed file keeps its id and an unrelated one never shares it. */
export function deliverableId(path: string, format: string): string {
  return `d-${createHash("sha256").update(`${format}\0${path}`).digest("hex").slice(0, 12)}`;
}

/** Records read back from the board: the same bounds, so a damaged row is refused rather than trusted. */
export function parseDeliverableRecords(value: unknown): DeliverableRecord[] {
  if (!Array.isArray(value) || !value.length || value.length > DELIVERABLE_LIMITS.count) throw new Error("deliverable records: 1 to 16 entries");
  const ids = new Set<string>();
  return value.map((raw, index) => {
    const row = own(raw, ["id", "path", "format", "version", "sha256", "bytes", "private"], `deliverable record ${index}`);
    if (typeof row.id !== "string" || !ID.test(row.id) || ids.has(row.id)) throw new Error(`deliverable record ${index}: expected a distinct hub id`);
    ids.add(row.id);
    if (typeof row.sha256 !== "string" || !SHA256.test(row.sha256)) throw new Error(`deliverable record ${index}: expected a sha256`);
    if (typeof row.bytes !== "number" || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > DELIVERABLE_LIMITS.fileBytes) throw new Error(`deliverable record ${index}: expected a bounded size`);
    if (typeof row.format !== "string" || !FORMAT.test(row.format)) throw new Error(`deliverable record ${index}: expected a format label`);
    if (row.version !== undefined && (typeof row.version !== "string" || !VERSION.test(row.version))) throw new Error(`deliverable record ${index}: expected a version label`);
    if (row.private !== undefined && row.private !== true) throw new Error(`deliverable record ${index}: private is true or absent`);
    const path = deliverablePath(row.path);
    if (row.id !== deliverableId(path, row.format)) throw new Error(`deliverable record ${index}: the id does not match its path and format`);
    return { id: row.id, path, format: row.format, ...(row.version !== undefined ? { version: row.version } : {}), sha256: row.sha256, bytes: row.bytes, ...(row.private === true ? { private: true as const } : {}) };
  });
}

/** The records as another peer may see them: a private record, or one whose path matches a PII pattern, shows no path, whatever else is shown. */
export function publicDeliverables(records: readonly DeliverableRecord[] | undefined, screen: (text: string) => boolean): DeliverableRecord[] | undefined {
  if (!records?.length) return undefined;
  return records.map(record => {
    const { path, ...rest } = record;
    return path !== undefined && !record.private && screen(path) ? { ...rest, path } : { ...rest, private: true as const };
  });
}

type Entry = { event: string; deliverables?: DeliverableRecord[] };
/** What the newest `done`, `done (checking)` or lifecycle record said was delivered. An approval's own copy is not a delivery. */
export function latestDeliverables(history: readonly Entry[]): DeliverableRecord[] | undefined {
  for (let i = history.length - 1; i >= 0; i--) if (history[i]!.event !== "approved" && history[i]!.deliverables?.length) return history[i]!.deliverables;
  return undefined;
}
/** What the newest approval bound: the bytes that were reviewed and approved. */
export function approvedDeliverables(history: readonly Entry[]): DeliverableRecord[] | undefined {
  for (let i = history.length - 1; i >= 0; i--) if (history[i]!.event === "approved" && history[i]!.deliverables?.length) return history[i]!.deliverables;
  return undefined;
}
