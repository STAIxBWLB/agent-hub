import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_PROJECTION_INPUT } from "./text-projection.ts";

/**
 * #508 (AC1, AC2, AC5): the source registry. A source is a snapshot of bytes a person registered, named by its content, kept under the hub state dir.
 * Pure over the filesystem: no daemon, no network (the URL fetch is a separate function the CLI calls), no model. Every refusal names its cap.
 */
export const MAX_SOURCE_BYTES = MAX_PROJECTION_INPUT;
export const MAX_REDIRECTS = 5;
export const MAX_SOURCES = 10_000;
const ID = /^src:[0-9a-f]{16}$/;
export type SourceKind = "file" | "url";
export interface SourceOrigin { kind: SourceKind; origin: string; added_at: number; private: boolean }
/** `meta.json`: the spec's `{id, kind, origin, sha256, bytes, added_at, private}` for the first registration, plus every origin ever registered for these bytes. */
export interface SourceMeta { id: string; kind: SourceKind; origin: string; sha256: string; bytes: number; added_at: number; private: boolean; origins: SourceOrigin[] }
export interface SourceAdd { id: string; created: boolean; private: boolean; upgraded: boolean; text: boolean }

export const sourceId = (sha256: string): string => {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("source id needs a SHA-256 hex digest");
  return `src:${sha256.slice(0, 16)}`;
};
export const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
export const validSourceId = (value: unknown): value is string => typeof value === "string" && ID.test(value);
/** `src:` is not a safe path segment on every filesystem, so the directory drops the colon. */
const dirName = (id: string): string => id.replace(":", "-");

function atomic(path: string, data: string | Buffer, mode = 0o600): void {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try { writeFileSync(temporary, data, { mode, flag: "wx" }); chmodSync(temporary, mode); renameSync(temporary, path); }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
}
/** A regular, single-link file read through one descriptor with a hard size cap; anything else is no record. */
function boundedRead(path: string, cap: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > cap) throw new Error("not a bounded regular file");
    const bytes = Buffer.alloc(st.size); let got = 0;
    while (got < bytes.length) { const n = readSync(fd, bytes, got, bytes.length - got, got); if (!n) break; got += n; }
    if (got !== st.size) throw new Error("file changed while read");
    return bytes;
  } finally { closeSync(fd); }
}
const cleanOrigin = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 2000 && !/[\x00-\x1f\x7f]/.test(value);
function parseMeta(text: string, id: string): SourceMeta | undefined {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const origins = raw.origins;
    if (raw.id !== id || !["file", "url"].includes(raw.kind as string) || !cleanOrigin(raw.origin) || typeof raw.sha256 !== "string" || sourceId(raw.sha256) !== id
      || !Number.isSafeInteger(raw.bytes) || (raw.bytes as number) < 0 || (raw.bytes as number) > MAX_SOURCE_BYTES || !Number.isSafeInteger(raw.added_at) || typeof raw.private !== "boolean"
      || !Array.isArray(origins) || !origins.length || origins.length > 256) return undefined;
    const kept: SourceOrigin[] = [];
    for (const item of origins as Record<string, unknown>[]) {
      if (!item || !["file", "url"].includes(item.kind as string) || !cleanOrigin(item.origin) || !Number.isSafeInteger(item.added_at) || typeof item.private !== "boolean") return undefined;
      kept.push({ kind: item.kind as SourceKind, origin: item.origin as string, added_at: item.added_at as number, private: item.private });
    }
    // The flag is the OR of every registration; a record whose flag is lower than one of its origins is damaged, not trusted.
    if (kept.some(item => item.private) && raw.private !== true) return undefined;
    return { id, kind: raw.kind as SourceKind, origin: raw.origin as string, sha256: raw.sha256, bytes: raw.bytes as number, added_at: raw.added_at as number, private: raw.private, origins: kept };
  } catch { return undefined; }
}

/**
 * `sources/<id>/` under the hub state dir: `meta.json`, `raw` (the exact bytes) and `text` (the projection, only when one exists).
 * The raw cap is the text-projection input cap, and nothing is truncated: an input over it is refused with the cap in the reason.
 */
export class SourceRegistry {
  readonly root: string;
  constructor(stateDir: string) { this.root = join(stateDir, "sources"); }

  private dir(id: string): string { return join(this.root, dirName(id)); }

  get(id: string): SourceMeta | undefined {
    if (!validSourceId(id)) return undefined;
    try { return parseMeta(boundedRead(join(this.dir(id), "meta.json"), 64 * 1024).toString("utf8"), id); } catch { return undefined; }
  }

  list(): SourceMeta[] {
    let names: string[];
    try { names = readdirSync(this.root); } catch { return []; }
    const rows: SourceMeta[] = [];
    for (const name of names.slice(0, MAX_SOURCES)) {
      const match = /^src-([0-9a-f]{16})$/.exec(name);
      const meta = match ? this.get(`src:${match[1]}`) : undefined;
      if (meta) rows.push(meta);
    }
    return rows.sort((a, b) => a.added_at - b.added_at || a.id.localeCompare(b.id));
  }

  /** The stored bytes of a source, re-hashed: a snapshot that no longer matches its id is no source. */
  readRaw(id: string): Buffer | undefined {
    const meta = this.get(id);
    if (!meta) return undefined;
    try { const bytes = boundedRead(join(this.dir(id), "raw"), MAX_SOURCE_BYTES); return sha256Of(bytes) === meta.sha256 ? bytes : undefined; } catch { return undefined; }
  }
  readText(id: string): string | undefined {
    if (!this.get(id)) return undefined;
    try { return boundedRead(join(this.dir(id), "text"), 512 * 1024).toString("utf8"); } catch { return undefined; }
  }

  /**
   * Register bytes. Equal bytes share one id, so a second registration returns the existing id. `private` is the OR over every registration of
   * those bytes: re-adding from a private path, or with text the PII screen flags, upgrades the record; re-adding from a public path never
   * downgrades it. Every origin is kept. `text` is the projection of the bytes (undefined when no converter handles them).
   */
  add(input: { bytes: Buffer; kind: SourceKind; origin: string; private: boolean; text?: string; now?: number }): SourceAdd {
    if (!Buffer.isBuffer(input.bytes)) throw new Error("a source is bytes");
    if (input.bytes.length > MAX_SOURCE_BYTES) throw new Error(`source is ${input.bytes.length} bytes, over the ${MAX_SOURCE_BYTES} byte cap (MAX_PROJECTION_INPUT); nothing was stored`);
    if (!cleanOrigin(input.origin)) throw new Error("source origin must be 1 to 2000 printable characters");
    const sha256 = sha256Of(input.bytes), id = sourceId(sha256), now = input.now ?? Date.now(), directory = this.dir(id);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (!existsSync(directory) && this.list().length >= MAX_SOURCES) throw new Error(`the registry holds ${MAX_SOURCES} sources already; nothing was stored`);
    const existing = this.get(id);
    if (existing) {
      const origin: SourceOrigin = { kind: input.kind, origin: input.origin, added_at: now, private: input.private };
      const known = existing.origins.some(item => item.kind === origin.kind && item.origin === origin.origin && item.private === origin.private);
      const privateNow = existing.private || input.private;
      const origins = known || existing.origins.length >= 256 ? existing.origins : [...existing.origins, origin];
      if (privateNow === existing.private && origins === existing.origins) return { id, created: false, private: existing.private, upgraded: false, text: this.readText(id) !== undefined };
      atomic(join(directory, "meta.json"), JSON.stringify({ ...existing, private: privateNow, origins }, null, 2) + "\n");
      return { id, created: false, private: privateNow, upgraded: privateNow && !existing.private, text: this.readText(id) !== undefined };
    }
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true }); // a half-written directory of an earlier crash is not a source
    const staging = `${directory}.${crypto.randomUUID()}.partial`;
    try {
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      writeFileSync(join(staging, "raw"), input.bytes, { mode: 0o600 });
      if (input.text !== undefined) writeFileSync(join(staging, "text"), input.text, { mode: 0o600 });
      const meta: SourceMeta = { id, kind: input.kind, origin: input.origin, sha256, bytes: input.bytes.length, added_at: now, private: input.private, origins: [{ kind: input.kind, origin: input.origin, added_at: now, private: input.private }] };
      writeFileSync(join(staging, "meta.json"), JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
      // The directory appears whole or not at all: a reader never sees raw without its meta.
      renameSync(staging, directory);
    } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
    return { id, created: true, private: input.private, upgraded: false, text: input.text !== undefined };
  }
}

/** Anything a person could paste that is not a plain https URL is refused before a connection is made. */
export function checkSourceUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("not a URL"); }
  if (url.protocol !== "https:") throw new Error("only https URLs can be registered");
  if (url.username || url.password) throw new Error("a URL with credentials is refused");
  if (!url.hostname) throw new Error("a URL needs a host");
  return url;
}

type FetchLike = (input: string, init: { redirect: "manual"; signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;
/**
 * Fetched once, by the person's CLI process (never a hub tool, agent or sandbox): https only, at most MAX_REDIRECTS redirects followed by hand (each one
 * re-checked as https without credentials), and a running byte cap on the body, so a huge or endless response is cut off at the cap with the cap in the
 * reason, never buffered whole and never truncated silently.
 */
export async function fetchSourceUrl(value: string, options: { fetch?: FetchLike; timeoutMs?: number; maxBytes?: number } = {}): Promise<{ bytes: Buffer; finalUrl: string; redirects: number }> {
  const cap = options.maxBytes ?? MAX_SOURCE_BYTES, doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  let url = checkSourceUrl(value), redirects = 0;
  for (;;) {
    const response = await doFetch(url.toString(), { redirect: "manual", signal, headers: { accept: "*/*", "user-agent": "agent-hub-source/1" } });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      if (++redirects > MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
      try { url = checkSourceUrl(new URL(response.headers.get("location")!, url).toString()); }
      catch (error) { throw new Error(`redirect refused: ${(error as Error).message}`); }
      await response.body?.cancel().catch(() => {});
      continue;
    }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`HTTP ${response.status}`); }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > cap) { await response.body?.cancel().catch(() => {}); throw new Error(`the response is ${declared} bytes, over the ${cap} byte cap (MAX_PROJECTION_INPUT); nothing was stored`); }
    const chunks: Uint8Array[] = []; let total = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("the response has no body");
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      total += chunk.byteLength;
      if (total > cap) { await reader.cancel().catch(() => {}); throw new Error(`the response is over the ${cap} byte cap (MAX_PROJECTION_INPUT); nothing was stored`); }
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks, total), finalUrl: url.toString(), redirects };
  }
}

/** Why a registration is private, in fixed words: the reason a person reads, never the matched text. */
export type PrivateReason = "path under pii.paths" | "text matches signals.pii_patterns" | "text could not be screened";
export interface RegisterPolicy {
  /** `pii.paths` of the project config. */
  piiPaths: readonly string[];
  /** `routing.signals.pii_patterns`: the same regular expressions the hub applies to task text. */
  piiPatterns: readonly string[];
  /** Project root the pii.paths are relative to. */
  cwd: string;
  /** The in-memory projection of the bytes (the existing text_projection converters), or undefined when none handles them. */
  project?: (bytes: Buffer) => string | undefined;
  matchesPolicy: (cwd: string, path: string, paths: string[]) => boolean;
}
/**
 * One decision, one place: whether a registration is private and what its text is. A path under `pii.paths` is private; so is bytes whose projected
 * (or, for a plain text file, decoded) text matches a configured PII pattern. A pattern that cannot be evaluated counts as flagged, never as clear.
 */
export function screenRegistration(input: { bytes: Buffer; kind: SourceKind; path?: string }, policy: RegisterPolicy): { private: boolean; reasons: PrivateReason[]; text?: string } {
  const reasons: PrivateReason[] = [];
  if (input.kind === "file" && input.path !== undefined && policy.matchesPolicy(policy.cwd, input.path, [...policy.piiPaths])) reasons.push("path under pii.paths");
  let text: string | undefined;
  try { text = policy.project?.(input.bytes); } catch { text = undefined; }
  // A plain text file is its own text when no converter handles it and it is valid UTF-8 without NUL bytes; anything else has no text to screen.
  if (text === undefined && !input.bytes.includes(0)) {
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(input.bytes);
    if (!decoded.includes("\uFFFD")) text = decoded;
  }
  if (text !== undefined && text.length) {
    try { if (policy.piiPatterns.some(pattern => new RegExp(pattern).test(text!))) reasons.push("text matches signals.pii_patterns"); }
    catch { reasons.push("text could not be screened"); }
  }
  return { private: reasons.length > 0, reasons, ...(text !== undefined ? { text } : {}) };
}

/** The origin a registration is shown with: a private record shows none to anyone but the person (the CLI is the person). */
export const publicSourceView = (meta: SourceMeta): { id: string; kind: SourceKind; private: true } | SourceMeta => meta.private ? { id: meta.id, kind: meta.kind, private: true } : meta;
/** Existence check that never throws: used to tell a fixture from a corrupt directory. */
export const sourceDirExists = (stateDir: string, id: string): boolean => { try { return lstatSync(join(stateDir, "sources", dirName(id))).isDirectory(); } catch { return false; } };
