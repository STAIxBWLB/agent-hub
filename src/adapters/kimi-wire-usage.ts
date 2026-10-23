import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, sep } from "node:path";
import { realPath } from "../hub/project.ts";
import { safeModelLabel } from "../omniroute/usage.ts";

/**
 * Kimi's session wire log as a usage source (#285 phase 2). This file is the only code that knows the format.
 *
 * Format followed: `<kimi home>/session_index.jsonl` rows `{ sessionId, sessionDir, ... }`, and per session
 * `<sessionDir>/agents/<agent>/wire.jsonl`, one JSON object per line. The first line is
 * `{ type: "metadata", protocol_version }`; each model request writes
 * `{ type: "usage.record", agentId, model, usage: { inputOther, output, inputCacheRead, inputCacheCreation }, usageScope, time }`.
 * Read from the wire logs of 524 sessions on one machine, all `protocol_version` 1.5, with the hub's own Kimi 2.3.0 install (the issue
 * recorded the same rows on 2.1.1; the hub verifies 2.2.0 and 2.3.0 in `compat.ts`). Which build wrote which log is not recorded in
 * them, and the live legs of #285 AC11 are a separate person receipt, so a protocol this file has not seen is `unknown`, never a count.
 *
 * Rules: the file is private and holds prompts, so only the four integers, the model label and the time are copied out of a usage
 * row, nothing is logged, and a line is looked at only when it is short. An error, a shrunk or replaced file, an unknown row shape, a
 * truncated last line or a missing index gives `unknown` and never a partial count: a read commits its offsets only when every file
 * of the session was read cleanly.
 */

export const KIMI_WIRE_PROTOCOLS: readonly string[] = ["1.5"];

export type KimiWireReason =
  | "no-index" | "outside-home" | "io-error" | "partial-line" | "no-metadata" | "untested-protocol"
  | "malformed-row" | "unknown-row-shape" | "oversized-row" | "shrunk" | "rotated" | "missing" | "moved";

/** One model request. `id` is opaque and stable across hub restarts: a hash of the session, the agent and the row's byte offset. */
export interface KimiWireRow {
  id: string;
  /** epoch ms the row was written, from Kimi's own clock */
  at: number;
  model?: string;
  inputOther: number;
  inputCacheCreation: number;
  inputCacheRead: number;
  output: number;
}

export type KimiWireRead =
  | { status: "ok"; rows: KimiWireRow[]; /** bytes remain unread because of the per-call bound: read again */ more: boolean }
  | { status: "unknown"; reason: KimiWireReason };

/** What counts against `budget.kimi_tokens_5h`: new input, cache writes and output. Cache reads are recorded and shown, never counted. */
export function kimiCountedTokens(row: Pick<KimiWireRow, "inputOther" | "inputCacheCreation" | "output">): number {
  return row.inputOther + row.inputCacheCreation + row.output;
}

/** Everything the row's four counters add up to, the cache reads included (the `usage` event's `totalTokens`). */
export function kimiRowTotal(row: Pick<KimiWireRow, "inputOther" | "inputCacheCreation" | "inputCacheRead" | "output">): number {
  return kimiCountedTokens(row) + row.inputCacheRead;
}

export interface KimiWireOptions {
  /** Kimi's data home (`KIMI_CODE_HOME`, else `~/.kimi-code`). */
  home: string;
  /** The ACP session id the hub owns; matched exactly against `session_index.jsonl`. */
  sessionId: string;
  /** Bytes read from one file per call. */
  maxBytes?: number;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const AGENT_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_AGENTS = 256;
/** A usage row is a few hundred bytes. A longer line is a prompt, a message or a tool output: skipped without being parsed. */
const LINE_CAP = 64 * 1024;
const INDEX_CAP = 16 * 1024 * 1024;
const DEFAULT_CHUNK = 1024 * 1024;
const MARKER = Buffer.from('"usage.record"');
const TRANSIENT: ReadonlySet<KimiWireReason> = new Set(["no-index", "io-error", "partial-line"]);

interface FileState { dev: number; ino: number; offset: number; skipping: boolean }
class Unknown extends Error { constructor(readonly reason: KimiWireReason) { super(reason); } }

const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const inside = (root: string, path: string): boolean => path.startsWith(root + sep);

export class KimiWireReader {
  private readonly home: string;
  private readonly sessionId: string;
  private readonly chunk: number;
  private dir: string | undefined;
  private files = new Map<string, FileState>();
  private broken: KimiWireReason | undefined;

  constructor(options: KimiWireOptions) {
    this.home = options.home;
    this.sessionId = options.sessionId;
    this.chunk = Math.max(LINE_CAP * 2, options.maxBytes ?? DEFAULT_CHUNK);
  }

  /** The rows written since the last successful read, sub-agents included. */
  read(): KimiWireRead {
    if (this.broken) return { status: "unknown", reason: this.broken };
    try {
      const dir = this.resolve();
      const next = new Map<string, FileState>();
      const rows: KimiWireRow[] = [];
      let more = false;
      const agents = this.agents(dir);
      for (const name of this.files.keys()) if (!agents.has(name)) throw new Unknown("missing");
      for (const [name, wire] of agents) {
        const result = this.readFile(name, wire, this.files.get(name));
        next.set(name, result.state);
        rows.push(...result.rows);
        more ||= result.more;
      }
      this.files = next;
      return { status: "ok", rows, more };
    } catch (error) {
      const reason: KimiWireReason = error instanceof Unknown ? error.reason : "io-error";
      if (!TRANSIENT.has(reason)) this.broken = reason; // the log no longer matches what was counted: stays unknown for this session
      return { status: "unknown", reason };
    }
  }

  /** The session directory from its index row, resolved once with realPath and kept inside `<home>/sessions`. */
  private resolve(): string {
    if (!SESSION_ID.test(this.sessionId)) throw new Unknown("no-index");
    let root: string;
    try { root = realPath(join(this.home, "sessions")); } catch { throw new Unknown("no-index"); }
    if (this.dir) {
      let again: string;
      try { again = realPath(this.dir); } catch { throw new Unknown("moved"); }
      if (again !== this.dir) throw new Unknown("moved");
      return this.dir;
    }
    let text: string;
    try {
      const file = join(this.home, "session_index.jsonl");
      if (lstatSync(file).size > INDEX_CAP) throw new Unknown("io-error");
      text = readFileSync(file, "utf8");
    } catch (error) { throw error instanceof Unknown ? error : new Unknown("no-index"); }
    let listed: string | undefined;
    for (const line of text.split("\n")) {
      if (!line.includes(this.sessionId)) continue;
      try {
        const row = JSON.parse(line);
        if (row && row.sessionId === this.sessionId && typeof row.sessionDir === "string" && row.sessionDir) listed = row.sessionDir;
      } catch { /* a line that is not ours is not our problem */ }
    }
    if (!listed) throw new Unknown("no-index");
    let dir: string;
    try { dir = realPath(listed); } catch { throw new Unknown("no-index"); }
    if (!inside(root, dir)) throw new Unknown("outside-home");
    this.dir = dir;
    return dir;
  }

  /** `agents/<name>/wire.jsonl` of every agent that has one: the main agent and its sub-agents. */
  private agents(dir: string): Map<string, string> {
    const out = new Map<string, string>();
    let names: string[];
    try { names = readdirSync(join(dir, "agents")).filter(name => AGENT_NAME.test(name)).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return out; throw new Unknown("io-error"); }
    if (names.length > MAX_AGENTS) throw new Unknown("io-error");
    for (const name of names) {
      const path = join(dir, "agents", name, "wire.jsonl");
      try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw new Unknown("io-error"); }
      let real: string;
      try { real = realPath(path); } catch { throw new Unknown("io-error"); }
      if (!inside(dir, real)) throw new Unknown("outside-home");
      out.set(name, real);
    }
    return out;
  }

  private readFile(agent: string, path: string, previous: FileState | undefined): { state: FileState; rows: KimiWireRow[]; more: boolean } {
    let fd: number;
    try { fd = openSync(path, "r"); } catch { throw new Unknown("io-error"); }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Unknown("io-error");
      if (previous && (previous.dev !== stat.dev || previous.ino !== stat.ino)) throw new Unknown("rotated");
      if (previous && stat.size < previous.offset) throw new Unknown("shrunk");
      const state: FileState = previous ? { ...previous } : { dev: stat.dev, ino: stat.ino, offset: 0, skipping: false };
      const rows: KimiWireRow[] = [];
      const length = Math.min(this.chunk, stat.size - state.offset);
      if (length <= 0) return { state, rows, more: false };
      const buffer = Buffer.allocUnsafe(length);
      let got = 0;
      while (got < length) {
        let n: number;
        try { n = readSync(fd, buffer, got, length - got, state.offset + got); } catch { throw new Unknown("io-error"); }
        if (n <= 0) break;
        got += n;
      }
      if (got < length) throw new Unknown("shrunk");
      const base = state.offset;
      const reachedEnd = base + length >= stat.size;
      let pos = 0;
      if (state.skipping) {
        const end = buffer.indexOf(10, 0);
        if (end < 0) return { state: { ...state, offset: base + length }, rows, more: !reachedEnd };
        pos = end + 1;
        state.skipping = false;
      }
      while (pos < length) {
        const end = buffer.indexOf(10, pos);
        if (end < 0) {
          const tail = length - pos;
          if (tail >= LINE_CAP) {
            // A line longer than any usage row: refuse only when it looks like one, else skip it unread.
            if (buffer.subarray(pos, pos + 256).includes(MARKER) || base + pos === 0) throw new Unknown(base + pos === 0 ? "no-metadata" : "oversized-row");
            state.skipping = true;
            pos = length;
            break;
          }
          if (reachedEnd) throw new Unknown("partial-line");
          break; // the chunk ended inside a line: it is read whole next call
        }
        const lineStart = base + pos, size = end - pos;
        if (size > LINE_CAP) {
          if (buffer.subarray(pos, pos + 256).includes(MARKER) || lineStart === 0) throw new Unknown(lineStart === 0 ? "no-metadata" : "oversized-row");
        } else if (lineStart === 0) {
          this.metadata(buffer.toString("utf8", pos, end));
        } else if (buffer.subarray(pos, end).includes(MARKER)) {
          const row = this.row(agent, lineStart, buffer.toString("utf8", pos, end));
          if (row) rows.push(row);
        }
        pos = end + 1;
      }
      state.offset = base + pos;
      return { state, rows, more: state.offset < stat.size };
    } finally { closeSync(fd); }
  }

  private metadata(line: string): void {
    let value: any;
    try { value = JSON.parse(line); } catch { throw new Unknown("no-metadata"); }
    if (!value || value.type !== "metadata" || typeof value.protocol_version !== "string") throw new Unknown("no-metadata");
    if (!KIMI_WIRE_PROTOCOLS.includes(value.protocol_version)) throw new Unknown("untested-protocol");
  }

  /** A line that mentions `usage.record`: a usage row, or (valid JSON of another type) something that only quotes it. */
  private row(agent: string, offset: number, line: string): KimiWireRow | undefined {
    let value: any;
    try { value = JSON.parse(line); } catch { throw new Unknown("malformed-row"); }
    if (!value || typeof value !== "object" || value.type !== "usage.record") return undefined;
    const usage = value.usage;
    const inputOther = count(usage?.inputOther), output = count(usage?.output), inputCacheRead = count(usage?.inputCacheRead), inputCacheCreation = count(usage?.inputCacheCreation);
    const at = value.time;
    if (inputOther === undefined || output === undefined || inputCacheRead === undefined || inputCacheCreation === undefined
      || (value.usageScope !== "turn" && value.usageScope !== "session")
      || typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0 || at > 8.64e15) throw new Unknown("unknown-row-shape");
    const model = safeModelLabel(value.model);
    const id = createHash("sha256").update(this.sessionId).update("\0").update(agent).update("\0").update(String(offset)).digest("hex").slice(0, 32);
    return { id, at, ...(model ? { model } : {}), inputOther, inputCacheCreation, inputCacheRead, output };
  }
}
