import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configRepositoryPresent, configTracked } from "./config-trust.ts";
import { configTier, CONFIG_EDIT_FILES, type ConfigEditFile } from "./config-tier.ts";
import { sdlcConfig } from "./sdlc.ts";
import { VERSION } from "../version.ts";

/**
 * #689: structural config edits. This module is pure file work plus the loaders' verdict: it never publishes, never
 * touches the board and never reads a secret. The daemon owns authority, events and reload (src/hub/daemon.ts).
 */
export interface ConfigEditSet { path: string[]; /** `null` removes the key. */ value: unknown }
export interface ConfigEditRequest { file: ConfigEditFile; /** The file's revision as the form read it: a sha256, or `absent`. */ revision: string; set: ConfigEditSet[] }
export interface ConfigDiffRow { path: string; tier: 2 | 3; before: unknown; after: unknown; applies: "restart" | "next use" }
export type ConfigEditPlan =
  | { ok: true; request: ConfigEditRequest; before: string | null; next: string | null; diff: ConfigDiffRow[]; tier: 2 | 3; tier3Keys: string[]; tracked?: boolean; notes: string[] }
  | { ok: false; error: string; field?: string };
/** The loaders' verdict on a candidate file text, thrown as the reason. `null` is a file that would not exist. */
export type CandidateCheck = (file: ConfigEditFile, text: string | null) => void;

export const MAX_EDIT_SETS = 16;
export const MAX_VALUE_BYTES = 16 * 1024;
const MAX_FILE_BYTES: Record<ConfigEditFile, number> = { "config.local.json": 1024 * 1024, "sdlc.toml": 64 * 1024 };
export const BACKUPS_KEPT = 5;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
export const fileRevision = (text: string | null): string => text === null ? "absent" : sha(text);
/** A short, stable hash of a value for the audit event: the value itself never enters it. */
export const valueHash = (value: unknown): string | null => value === undefined ? null : sha(JSON.stringify(canonical(value))).slice(0, 16);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a) ?? null) === JSON.stringify(canonical(b) ?? null);

/** The field a loader's reason names, so a form can show it at that field. */
export function reasonField(message: string): string | undefined {
  return /\b(instances\.[a-z][a-z0-9-]*(?:\.[A-Za-z_]+)?|review\.[a-z_]+|snapshots\.[a-z_]+|approvals\.[a-z_]+|context\.[a-z_]+|sdlc\.[a-z_]+)\b/.exec(message)?.[1];
}

/** The file's text, or null when it is not there. A failure is named by its code: its own text holds absolute paths. */
export function readEditable(cwd: string, file: ConfigEditFile): string | null {
  // Only the last component used to be checked: a committed `.agenthub` symlink would have been read and written through.
  try { if (!lstatSync(join(cwd, ".agenthub")).isDirectory()) throw new Error(".agenthub must be a real directory, not a link"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; if (/must be a real directory/.test((error as Error).message)) throw error; throw new Error(`.agenthub could not be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`); }
  const path = join(cwd, ".agenthub", file);
  try {
    const info = lstatSync(path);
    if (!info.isFile()) throw Object.assign(new Error("not a regular file"), { code: "EMLINK" });
    if (info.size > MAX_FILE_BYTES[file]) throw Object.assign(new Error("too large"), { code: "EFBIG" });
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new Error(`.agenthub/${file} could not be read (${code ?? "unknown error"}): it must be a regular file inside its size limit`);
  }
}
/** The revisions for a view: a file that cannot be read safely is `unavailable`, so one bad file never takes the whole Settings view down. */
export const viewRevisions = (cwd: string): Record<ConfigEditFile, string> => Object.fromEntries(CONFIG_EDIT_FILES.map(file => { try { return [file, fileRevision(readEditable(cwd, file))]; } catch { return [file, "unavailable"]; } })) as Record<ConfigEditFile, string>;
export const editRevisions = (cwd: string): Record<ConfigEditFile, string> => Object.fromEntries(CONFIG_EDIT_FILES.map(file => [file, fileRevision(readEditable(cwd, file))])) as Record<ConfigEditFile, string>;

/** Strict shape of an untrusted request: unknown fields are refused, never dropped. */
export function parseConfigEditRequest(raw: unknown): ConfigEditRequest | string {
  if (!isObject(raw)) return "a config edit is an object with file, revision and set";
  const extra = Object.keys(raw).find(key => !["file", "revision", "set"].includes(key));
  if (extra) return `${extra}: unknown field; nothing was written`;
  if (!CONFIG_EDIT_FILES.includes(raw.file as ConfigEditFile)) return `file: one of ${CONFIG_EDIT_FILES.join(", ")}`;
  if (typeof raw.revision !== "string" || !/^(absent|[a-f0-9]{64})$/.test(raw.revision)) return "revision: the file revision the form read (reload and try again)";
  if (!Array.isArray(raw.set) || !raw.set.length || raw.set.length > MAX_EDIT_SETS) return `set: 1 to ${MAX_EDIT_SETS} entries`;
  const set: ConfigEditSet[] = [];
  for (const [index, entry] of raw.set.entries()) {
    if (!isObject(entry)) return `set[${index}]: an object with path and value`;
    const unknown = Object.keys(entry).find(key => !["path", "value"].includes(key));
    if (unknown) return `set[${index}].${unknown}: unknown field; nothing was written`;
    if (!Array.isArray(entry.path) || !entry.path.length || entry.path.length > 6 || entry.path.some(part => typeof part !== "string")) return `set[${index}].path: 1 to 6 strings`;
    if (!("value" in entry)) return `set[${index}].value: required (null removes the key)`;
    let size: number;
    try { size = Buffer.byteLength(JSON.stringify(entry.value) ?? "undefined"); } catch { return `set[${index}].value: must be plain JSON`; }
    if (size > MAX_VALUE_BYTES) return `set[${index}].value: at most ${MAX_VALUE_BYTES} bytes`;
    set.push({ path: [...entry.path as string[]], value: entry.value });
  }
  if (new Set(set.map(item => item.path.join("."))).size !== set.length) return "set: a path appears twice";
  return { file: raw.file as ConfigEditFile, revision: raw.revision, set };
}

function valueAt(doc: unknown, path: readonly string[]): unknown {
  let node = doc;
  for (const part of path) { if (!isObject(node) || !Object.hasOwn(node, part)) return undefined; node = node[part]; }
  return node;
}
/** Sets (or with null removes) one path; an emptied parent goes with it, so set then remove leaves the file as it was. */
function putPath(doc: Record<string, unknown>, path: readonly string[], value: unknown): void {
  const trail: [Record<string, unknown>, string][] = [];
  let node = doc;
  for (const part of path.slice(0, -1)) {
    if (!Object.hasOwn(node, part)) { if (value === null) return; node[part] = {}; }
    const next = node[part];
    if (!isObject(next)) throw new Error(`${path.slice(0, path.indexOf(part) + 1).join(".")} is not an object in the file; fix it in your editor first`);
    trail.push([node, part]); node = next;
  }
  const leaf = path.at(-1)!;
  if (value === null) {
    delete node[leaf];
    for (const [parent, part] of trail.reverse()) { if (Object.keys(parent[part] as object).length) break; delete parent[part]; }
  } else node[leaf] = structuredClone(value);
}

/** TOML top-level keys `mode` and `required_checks`, edited line by line so comments and every other table survive. */
function tomlValue(key: string, value: unknown): string {
  if (key === "mode") return `mode = ${JSON.stringify(value)}`;
  return `required_checks = [${(value as string[]).map(check => JSON.stringify(check)).join(", ")}]`;
}
const bracketDelta = (line: string): number => {
  const bare = line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "").replace(/#.*$/, "");
  return [...bare].reduce((sum, ch) => sum + (ch === "[" ? 1 : ch === "]" ? -1 : 0), 0);
};
/** The top-level key spans of a TOML file (before the first table header); a multi-line array keeps its lines together. */
function topLevel(lines: readonly string[]): { end: number; spans: Map<string, [number, number]> } {
  const spans = new Map<string, [number, number]>();
  let end = lines.length;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s*\[/.test(line)) { end = index; break; }
    const key = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1];
    if (!key) continue;
    let last = index, depth = bracketDelta(line.slice(line.indexOf("=") + 1));
    while (depth > 0 && last + 1 < lines.length) depth += bracketDelta(lines[++last]!);
    spans.set(key, [index, last]);
    index = last;
  }
  return { end, spans };
}
/**
 * Edits `mode` and `required_checks` line by line. Every line the edit does not touch keeps its own ending, so a one-key change never
 * rewrites a CRLF checkout; a line the edit writes or adds takes the ending of the first line break the file has (LF for a new file).
 */
function editSdlcText(text: string | null, set: ConfigEditSet[]): string | null {
  const raw = text === null ? [] : text.split("\n");
  const trailing = raw.length > 0 && raw.at(-1) === "";
  if (trailing) raw.pop();
  // Parallel arrays: the line's text and the ending it had. A line that was the file's last may have had none.
  const lines = raw.map(line => line.endsWith("\r") ? line.slice(0, -1) : line);
  const endings = raw.map((line, index) => line.endsWith("\r") ? "\r\n" : index === raw.length - 1 && !trailing ? "" : "\n");
  const own = text !== null && /\r?\n/.exec(text)?.[0] === "\r\n" ? "\r\n" : "\n";
  for (const { path, value } of set) {
    const key = path[0]!, { end, spans } = topLevel(lines), found = spans.get(key);
    if (found) {
      const fresh = value === null ? [] : [tomlValue(key, value)];
      const last = endings[found[1]]!;
      lines.splice(found[0], found[1] - found[0] + 1, ...fresh);
      endings.splice(found[0], found[1] - found[0] + 1, ...fresh.map(() => last === "" ? own : last));
    } else if (value !== null) {
      // A new key goes after the last top-level line, before the first table.
      let at = end;
      while (at > 0 && !lines[at - 1]!.trim()) at--;
      lines.splice(at, 0, tomlValue(key, value)); endings.splice(at, 0, own);
      if (at > 0 && endings[at - 1] === "") endings[at - 1] = own;
      if (at + 1 < lines.length && lines[at + 1]!.trim() !== "" && /^\s*\[/.test(lines[at + 1]!)) { lines.splice(at + 1, 0, ""); endings.splice(at + 1, 0, own); }
    }
  }
  if (!lines.length) return null;
  return lines.map((line, index) => line + (endings[index] === "" && index === lines.length - 1 ? own : endings[index])).join("");
}
const parseToml = (text: string | null): Record<string, unknown> => text === null ? {} : Bun.TOML.parse(text) as Record<string, unknown>;

/**
 * What the request would do, judged by the loaders before anything is written. The result carries the diff and the
 * candidate text; nothing has been written. A refusal names the key (`field`) when the loader's reason does.
 */
export function planConfigEdit(cwd: string, rawRequest: unknown, check: CandidateCheck): ConfigEditPlan {
  const request = parseConfigEditRequest(rawRequest);
  if (typeof request === "string") return { ok: false, error: request };
  try {
    const before = readEditable(cwd, request.file);
    if (fileRevision(before) !== request.revision) return { ok: false, error: `.agenthub/${request.file} changed on disk since it was read: reload it and review the change again; nothing was written` };
    const diff: ConfigDiffRow[] = [], tier3Keys: string[] = [];
    let next: string | null;
    if (request.file === "sdlc.toml") {
      for (const { path, value } of request.set) {
        const tier = configTier("sdlc.toml", path, value);
        if ("refused" in tier) return { ok: false, error: tier.refused, field: `sdlc.${path.join(".")}` };
        if (path[0] === "mode" && value !== null && !["off", "advise", "enforce"].includes(String(value))) return { ok: false, error: "sdlc.mode: expected off, advise or enforce; nothing was written", field: "sdlc.mode" };
        if (path[0] === "required_checks" && value !== null && !Array.isArray(value)) return { ok: false, error: "sdlc.required_checks: expected a list of check names; nothing was written", field: "sdlc.required_checks" };
      }
      const old = parseToml(before);
      next = editSdlcText(before, request.set);
      const after = parseToml(next);
      const expected = structuredClone(old);
      for (const { path, value } of request.set) putPath(expected, path, value);
      // A layout this edit cannot keep byte-faithful is refused rather than guessed: only the named keys may differ.
      if (!same(after, expected)) return { ok: false, error: "sdlc.toml has a layout the editor cannot change safely (a key repeated, or one split across tables); edit .agenthub/sdlc.toml in your editor; nothing was written" };
      sdlcConfig(after, VERSION); // the loader's own verdict, with its field-level reason
      for (const { path, value } of request.set) diff.push({ path: `sdlc.${path.join(".")}`, tier: 2, before: old[path[0]!], after: value === null ? undefined : value, applies: "restart" });
      check("sdlc.toml", next);
    } else {
      let doc: Record<string, unknown>;
      try { doc = before === null ? {} : JSON.parse(before); } catch { return { ok: false, error: ".agenthub/config.local.json is not valid JSON; fix it in your editor first; nothing was written" }; }
      if (!isObject(doc)) return { ok: false, error: ".agenthub/config.local.json must hold a JSON object; nothing was written" };
      const old = structuredClone(doc);
      for (const { path, value } of request.set) {
        const held = valueAt(old, path);
        const tier = configTier("config.local.json", path, value, held);
        if ("refused" in tier) return { ok: false, error: tier.refused, field: path.join(".") };
        if (tier.tier === 3) tier3Keys.push(tier.key);
        // A whole instance replaced by a tier 2 object must not drop a tier 3 field it held: that would silently erase a home or account.
        if (path[0] === "instances" && path.length === 2 && isObject(held) && isObject(value)) {
          const lost = Object.keys(held).find(field => !(field in value) && ["jcode_home", "provider", "model", "provider_profile"].includes(field));
          if (lost) return { ok: false, error: `instances.${path[1]}.${lost}: this replacement would drop a native home or account setting; set only the fields you change (instances.${path[1]}.<field>); nothing was written`, field: `instances.${path[1]}.${lost}` };
        }
        putPath(doc, path, value);
        diff.push({ path: path.join("."), tier: tier.tier, before: held, after: value === null ? undefined : value, applies: path[0] === "instances" ? "restart" : "next use" });
      }
      next = Object.keys(doc).length || before !== null ? `${JSON.stringify(doc, null, 2)}\n` : null;
      if (Buffer.byteLength(next ?? "") > MAX_FILE_BYTES["config.local.json"]) return { ok: false, error: ".agenthub/config.local.json would exceed its size limit; nothing was written" };
      check("config.local.json", next);
    }
    const changed = diff.filter(row => !same(row.before, row.after));
    if (!changed.length) return { ok: false, error: "nothing to change: the file already holds this; nothing was written" };
    const tracked = request.file === "config.local.json" ? undefined : configTracked(cwd, "sdlc.toml");
    const notes = request.file === "sdlc.toml" && tracked ? [".agenthub/sdlc.toml is tracked by git: the change is in your working tree, commit it to share it"] : [];
    return { ok: true, request, before, next, diff: changed, tier: tier3Keys.length ? 3 : 2, tier3Keys: [...new Set(tier3Keys)], ...(tracked === undefined ? {} : { tracked }), notes };
  } catch (error) {
    const message = (error as Error).message;
    return { ok: false, error: `${message}; nothing was written`, ...(reasonField(message) ? { field: reasonField(message) } : {}) };
  }
}

const backupDir = (stateDir: string): string => join(stateDir, "config-backups");
export interface ConfigBackup { name: string; file: ConfigEditFile; at: number; bytes: number }
/** The newest backups first, at most `BACKUPS_KEPT` per file. */
export function configBackups(stateDir: string): ConfigBackup[] {
  let names: string[];
  try { names = readdirSync(backupDir(stateDir)); } catch { return []; }
  return names.flatMap(name => {
    const match = /^(config\.local\.json|sdlc\.toml)\.(\d{13})\.[a-f0-9]{8}\.bak$/.exec(name);
    if (!match) return [];
    try { return [{ name, file: match[1] as ConfigEditFile, at: Number(match[2]), bytes: statSync(join(backupDir(stateDir), name)).size }]; } catch { return []; }
  }).sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
}

/** Temp file and rename in the same directory: a reader sees the old file or the new one, never half of one. */
function atomicWrite(path: string, text: string, mode: number): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try { writeFileSync(tmp, text, { mode, flag: "wx" }); chmodSync(tmp, mode); renameSync(tmp, path); }
  catch (error) { try { unlinkSync(tmp); } catch { /* nothing was written */ } throw error; }
}

/** A git-tracked machine-local file is never written: its content would travel with the repository. */
function refuseTrackedLocal(cwd: string): void {
  const tracked = configTracked(cwd, "config.local.json");
  if (tracked) throw new Error(".agenthub/config.local.json is committed to git; structural edits write only machine-local files. Remove it from the repository (git rm --cached) and ignore it");
  if (tracked === undefined && configRepositoryPresent(cwd)) throw new Error("git could not confirm that .agenthub/config.local.json is untracked; nothing was written");
}

/**
 * Writes a plan that `planConfigEdit` accepted: the revision is checked once more against the disk, the previous file is kept
 * as a bounded backup, then the file is replaced atomically. Returns what the audit event records (hashes, never values).
 */
export function writeConfigEdit(cwd: string, stateDir: string, plan: Extract<ConfigEditPlan, { ok: true }>, now: number = Date.now()): { backup?: string; fileBefore: string; fileAfter: string; paths: { path: string; before: string | null; after: string | null }[] } {
  const { file } = plan.request, path = join(cwd, ".agenthub", file);
  try {
    if (file === "config.local.json") refuseTrackedLocal(cwd);
    if (fileRevision(readEditable(cwd, file)) !== plan.request.revision) throw new Error(`.agenthub/${file} changed on disk since it was read: reload it and review the change again`);
    let backup: string | undefined;
    if (plan.before !== null) {
      mkdirSync(backupDir(stateDir), { recursive: true, mode: 0o700 });
      backup = `${file}.${String(now).padStart(13, "0")}.${sha(plan.before).slice(0, 8)}.bak`;
      writeFileSync(join(backupDir(stateDir), backup), plan.before, { mode: 0o600 });
      for (const old of configBackups(stateDir).filter(item => item.file === file).slice(BACKUPS_KEPT)) rmSync(join(backupDir(stateDir), old.name), { force: true });
    }
    mkdirSync(join(cwd, ".agenthub"), { recursive: true });
    let mode = 0o600;
    try { mode = statSync(path).mode & 0o777; } catch { /* a new file is the owner's alone */ }
    if (plan.next === null) rmSync(path, { force: true }); else atomicWrite(path, plan.next, mode);
    return { ...(backup ? { backup } : {}), fileBefore: fileRevision(plan.before), fileAfter: fileRevision(plan.next),
      // A tier 3 value (a model name, a provider, a home) is low-entropy and dictionary-recoverable from an unsalted hash, so it gets none:
      // the event shows that the key changed and the file revisions bind the change. A tier 2 value keeps its short hash.
      paths: plan.diff.map(row => row.tier === 3 ? { path: row.path, before: row.before === undefined ? null : "(set)", after: row.after === undefined ? null : "(set)" } : { path: row.path, before: valueHash(row.before), after: valueHash(row.after) }) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && !/\.agenthub|git/.test((error as Error).message)) throw new Error(`.agenthub/${file} could not be written (${code}); nothing was changed`);
    throw error;
  }
}
