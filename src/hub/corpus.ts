import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, type Dirent, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDenied } from "../local/deny.ts";
import { foldSegment } from "./permission-mode.ts";
import { matchesPolicy, matchesPolicyLexically, policyRealPath } from "./path-policy.ts";
import { realPath } from "./project.ts";

// agent-hub #510 (hub task #331): the read-only plain-notes index. Spec: "Knowledge corpus (#510), owner decision 2026-10-22".
// The hub reads plain notes folders. A folder that is, lies in or contains an Obsidian vault is refused: a vault is reached only through the Obsidian MCP tools.

export const MAX_NOTES = 5000;
export const MAX_DIRS = 4096;
export const MAX_ENTRIES = 100_000;
export const MAX_DEPTH = 24;
export const MAX_NOTE_BYTES = 256 * 1024;
export const MAX_HEADINGS = 256;
export const MAX_LINKS = 512;
export const MAX_TAGS = 64;
export const MAX_FRONTMATTER_BYTES = 8 * 1024;
/** A single evidence request may open at most this many freshly checked notes. */
export const MAX_CORPUS_READS = 32;
const NOTE_EXT = /\.(md|markdown)$/i;
/** The one source of the sentence that names where a vault is read, so the refusal and its tests cannot drift. */
export const VAULT_REASON = "is, lies in or contains an Obsidian vault (a .obsidian/ folder); the hub never reads a vault from disk. Reach it through the Obsidian MCP tools (mcp__obsidian__*) instead";

export interface CorpusContext {
  cwd: string;
  paths: readonly string[];
  /** `pii.paths`: project-relative exact paths, subtrees or globs. A match is never read. */
  piiPaths?: readonly string[];
  /** `local.deny` substrings, on top of the built-in secrets denylist. */
  deny?: readonly string[];
  /** `signals.pii_patterns`: a note whose text matches (or whose pattern cannot be evaluated) is not indexed. */
  piiPatterns?: readonly string[];
}

export type CorpusRootCheck = { ok: true; real: string } | { ok: false; reason: string };

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const clean = (text: string): string => text.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Whether an entry named `.obsidian` exists directly in `dir`, in any folded spelling (the walk below a root folds names the same way, so a root and its ancestors are
 * judged alike on a case-sensitive disk, where `.OBSIDIAN` is a different name than `.obsidian`). A literal `lstat` answers first (it also covers a case-insensitive disk
 * without a listing); otherwise the folder is listed, bounded. A thrown error for anything but absence: unreadable evidence is never "no vault".
 */
function hasObsidian(dir: string): boolean {
  try { lstatSync(join(dir, ".obsidian")); return true; }
  catch (error) { if (errno(error) !== "ENOENT" && errno(error) !== "ENOTDIR") throw error; }
  let names: string[];
  try { names = readdirSync(dir); }
  catch (error) { if (errno(error) === "ENOTDIR") return false; throw error; }
  if (names.length > MAX_ENTRIES) throw Object.assign(new Error("too many entries"), { code: "E2BIG" });
  return names.some(name => foldSegment(name) === ".obsidian");
}

/**
 * Whether a configured corpus root may be read. The check runs on the `realPath` of the root (a symlink into a vault is caught), looks for `.obsidian/` at the
 * root and in every ancestor of the real path (a root inside a vault), and refuses on evidence it cannot read. `pii.paths` and the deny rules are checked here too:
 * a root under either is never a corpus, and the walk refuses a root that holds a protected folder, because that folder is never listed and cannot be shown free of a vault. The walk below the root (refusing any `.obsidian` it meets) is `CorpusIndex.refresh`.
 */
export function checkCorpusRoot(configured: string, ctx: CorpusContext): CorpusRootCheck {
  let real: string;
  try {
    const cwd = realPath(ctx.cwd);
    real = policyRealPath(resolve(cwd, configured));
    if (!lstatSync(real).isDirectory()) return { ok: false, reason: `${configured} is not a folder` };
    real = realPath(real);
  } catch (error) { return { ok: false, reason: `${configured} cannot be resolved (${errno(error) ?? "unreadable"}); a path that cannot be checked is never read` }; }
  try {
    for (let dir = real; ; dir = dirname(dir)) {
      if (hasObsidian(dir)) return { ok: false, reason: `${configured} ${VAULT_REASON}${dir === real ? "" : ` (the vault folder is ${dir})`}` };
      if (dirname(dir) === dir) break;
    }
  } catch (error) { return { ok: false, reason: `${configured}: a folder above it cannot be read (${errno(error) ?? "unreadable"}), so it cannot be shown to be free of a vault` }; }
  if (isDenied(real, [...(ctx.deny ?? [])])) return { ok: false, reason: `${configured} is on the secrets denylist or local.deny` };
  if (ctx.piiPaths?.length && matchesPolicy(ctx.cwd, real, [...ctx.piiPaths])) return { ok: false, reason: `${configured} is, or lies in, a path under pii.paths` };
  return { ok: true, real };
}

export interface NoteLink { target: string; heading?: string; embed: boolean }
export interface ParsedNote {
  title?: string;
  frontmatter: Record<string, string | string[]>;
  tags: string[];
  aliases: string[];
  headings: { level: number; text: string }[];
  links: NoteLink[];
  /** A cap cut headings, links or frontmatter short. */
  truncated: boolean;
}

const scalar = (raw: string): string => {
  const text = raw.trim();
  if ((text.startsWith('"') && text.endsWith('"') && text.length >= 2) || (text.startsWith("'") && text.endsWith("'") && text.length >= 2)) return clean(text.slice(1, -1));
  return clean(text);
};
const listOf = (raw: string): string[] => raw.trim().replace(/^\[/, "").replace(/\]$/, "").split(",").map(scalar).filter(Boolean);

/**
 * A bounded frontmatter reader for the shapes notes use: `key: value`, `key: [a, b]` and a block list under `key:`. It is not a YAML parser (zero runtime
 * dependencies): nested maps, anchors and multi-line scalars are kept as their first line or ignored, never executed or evaluated.
 * ponytail: ceiling is flat keys; upgrade path is a vetted YAML subset parser if notes need nested metadata.
 */
function frontmatterOf(text: string): { values: Record<string, string | string[]>; body: string; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return { values: {}, body: text, truncated: false };
  let end = -1, bytes = 0;
  for (let i = 1; i < lines.length; i++) {
    bytes += lines[i]!.length + 1;
    if (bytes > MAX_FRONTMATTER_BYTES) return { values: {}, body: lines.slice(i).join("\n"), truncated: true };
    if (/^(---|\.\.\.)\s*$/.test(lines[i]!)) { end = i; break; }
  }
  if (end < 0) return { values: {}, body: text, truncated: false };
  const values: Record<string, string | string[]> = {};
  let key: string | undefined;
  for (const line of lines.slice(1, end)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && key) { const current = values[key]; values[key] = [...(Array.isArray(current) ? current : current ? [current] : []), scalar(item[1]!)].filter(Boolean).slice(0, MAX_TAGS); continue; }
    const pair = /^([A-Za-z0-9_][A-Za-z0-9_ -]{0,63}):\s*(.*)$/.exec(line);
    if (!pair || /^\s/.test(line)) { if (!/^\s/.test(line)) key = undefined; continue; }
    key = pair[1]!.trim().toLowerCase();
    if (Object.hasOwn(values, key) || ["__proto__", "constructor", "prototype"].includes(key)) { key = undefined; continue; }
    const value = pair[2]!;
    if (value.startsWith("[")) values[key] = listOf(value).slice(0, MAX_TAGS);
    else if (value.trim() === "" ) values[key] = [];
    else values[key] = scalar(value).slice(0, 500);
  }
  return { values, body: lines.slice(end + 1).join("\n"), truncated: false };
}

/** The body without fenced and inline code, so a `[[link]]` or a `# heading` inside code is not read as one. */
function prose(body: string): { text: string; headings: { level: number; text: string }[]; truncated: boolean } {
  const kept: string[] = [], headings: { level: number; text: string }[] = [];
  let fence: string | undefined, truncated = false;
  for (const line of body.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) { const mark = marker[1]![0]!; if (!fence) fence = mark; else if (fence === mark) fence = undefined; continue; }
    if (fence) continue;
    const heading = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line); // a closing run of # is a closer only after whitespace: `# C#` is "C#"
    if (heading) { if (headings.length < MAX_HEADINGS) headings.push({ level: heading[1]!.length, text: clean(heading[2]!).slice(0, 200) }); else truncated = true; }
    kept.push(line.replace(/`[^`\n]*`/g, " "));
  }
  return { text: kept.join("\n"), headings: headings.filter(item => item.text), truncated };
}

/** Frontmatter, headings and wikilinks of one note. Never evaluates anything and never throws on malformed input. */
export function parseNote(text: string): ParsedNote {
  const { values, body, truncated: frontTruncated } = frontmatterOf(text);
  const { text: scan, headings, truncated: headTruncated } = prose(body);
  const links: NoteLink[] = [];
  let linkTruncated = false;
  for (const match of scan.matchAll(/(!?)\[\[([^\[\]\n|#]{1,200})(?:#([^\[\]\n|]{1,200}))?(?:\|[^\[\]\n]{0,200})?\]\]/g)) {
    const target = clean(match[2]!);
    if (!target) continue;
    if (links.length >= MAX_LINKS) { linkTruncated = true; break; }
    links.push({ target, ...(match[3] ? { heading: clean(match[3]) } : {}), embed: match[1] === "!" });
  }
  const list = (key: string): string[] => { const value = values[key]; return (Array.isArray(value) ? value : value ? value.split(",").map(scalar) : []).map(item => item.replace(/^#/, "")).filter(Boolean).slice(0, MAX_TAGS); };
  const title = typeof values.title === "string" && values.title ? values.title : headings.find(item => item.level === 1)?.text;
  return { ...(title ? { title } : {}), frontmatter: values, tags: [...new Set([...list("tags"), ...list("tag")])], aliases: [...new Set([...list("aliases"), ...list("alias")])], headings, links, truncated: frontTruncated || headTruncated || linkTruncated };
}

export interface NoteRecord extends ParsedNote {
  /** `note:<root label>/<path>`; a heading is cited as `<id>#<heading>`. */
  id: string;
  root: string;
  path: string;
  bytes: number;
  mtimeMs: number;
  sha256: string;
}
export interface CorpusRootReport {
  configured: string;
  label?: string;
  real?: string;
  refused?: string;
  notes: number;
  /** Counts of what was left out, by reason: never silently dropped. */
  skipped: { protected: number; links: number; large: number; unreadable: number; pii: number; overCap: number };
}
export interface CorpusRefresh { roots: CorpusRootReport[]; notes: number; parsed: number; reused: number; removed: number }
export interface CorpusRead { record: NoteRecord; text: string; path: string }

const sizeKey = (st: { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;

function readNote(path: string, expected: { dev: number; ino: number }): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.dev !== expected.dev || st.ino !== expected.ino || st.size > MAX_NOTE_BYTES) throw new Error("not a bounded regular note");
    const bytes = Buffer.alloc(st.size); let got = 0;
    while (got < bytes.length) { const n = readSync(fd, bytes, got, bytes.length - got, got); if (!n) break; got += n; }
    if (got !== st.size) throw new Error("note changed while read");
    return bytes;
  } finally { closeSync(fd); }
}

/**
 * The read-only index of the configured plain-notes folders. `refresh` walks each root (bounded in folders, entries and notes), skips what `pii.paths`, the deny
 * rules and symbolic links protect, refuses a root that holds an Obsidian vault anywhere, and re-reads only the notes whose size, times or identity changed.
 * It stores structure (title, tags, headings, links, a hash), never the note's text, and it writes nothing. The index is in memory: a restart rebuilds it.
 * ponytail: the cache is per process; persist it in hub.db if a rebuild becomes slow for big folders.
 */
export class CorpusIndex {
  private cache = new Map<string, { key: string; record: NoteRecord }>();
  private byId = new Map<string, NoteRecord>();
  constructor(private readonly ctx: CorpusContext) {}

  notes(): NoteRecord[] { return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id)); }
  get(id: string): NoteRecord | undefined { return this.byId.get(id); }

  /** Read one indexed note from disk after rebuilding the bounded index and rechecking current policy. Text is never cached. */
  read(id: string): CorpusRead | undefined { return this.readMany([id])[0]; }

  /**
   * Freshly read a bounded batch. One full refresh revalidates every configured root and its vault-safe walk; each selected file then gets current lexical policy,
   * path, inode, size, content-hash and PII checks immediately before any text is returned. A cache hit is metadata only and never supplies old text.
   */
  readMany(ids: readonly string[]): CorpusRead[] {
    if (ids.length === 0) return [];
    this.refresh();
    const selected = [...new Set(ids.slice(0, MAX_CORPUS_READS))];
    const roots = new Map(this.refreshReports().filter((item): item is CorpusRootReport & { label: string; real: string } => !!item.label && !!item.real).map(item => [item.label, item]));
    const checkedRoots = new Map<string, string>();
    for (const root of new Set(selected.map(id => this.byId.get(id)?.root).filter((label): label is string => !!label))) {
      const report = roots.get(root);
      if (!report) continue;
      const checked = checkCorpusRoot(report.configured, this.ctx);
      if (checked.ok && checked.real === report.real) checkedRoots.set(root, checked.real);
    }
    const output: CorpusRead[] = [];
    for (const id of selected) {
      const record = this.byId.get(id);
      if (!record) continue;
      const root = roots.get(record.root);
      const checkedReal = checkedRoots.get(record.root);
      if (!root || !checkedReal) continue;
      const abs = resolve(checkedReal, record.path);
      const rel = relative(checkedReal, abs);
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !NOTE_EXT.test(abs)) continue;
      const pii = [...(this.ctx.piiPaths ?? [])], deny = [...(this.ctx.deny ?? [])];
      if (isDenied(abs, deny) || (pii.length > 0 && (matchesPolicyLexically(this.ctx.cwd, abs, pii) || matchesPolicy(this.ctx.cwd, abs, pii)))) continue;
      try {
        let parent = checkedReal;
        const segments = record.path.split("/");
        if (!segments.length || segments.some(part => !part || part === "." || part === "..")) continue;
        for (const segment of segments.slice(0, -1)) {
          parent = join(parent, segment);
          const parentStat = lstatSync(parent);
          if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) { parent = ""; break; }
        }
        if (!parent) continue;
        const st = lstatSync(abs);
        if (!st.isFile() || st.nlink !== 1 || st.size > MAX_NOTE_BYTES || st.size !== record.bytes) continue;
        // Each root-relative parent is checked with lstat; an in-root symlink is not an approved notes path either.
        const bytes = readNote(abs, st);
        if (bytes.includes(0)) continue;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (createHash("sha256").update(bytes).digest("hex") !== record.sha256 || this.piiFlagged(text)) continue;
        output.push({ record, text, path: abs });
      } catch { /* A disappeared, replaced, unreadable or invalid note is not evidence. */ }
    }
    return output;
  }

  private refreshReports(): CorpusRootReport[] { return this.lastReports; }

  private lastReports: CorpusRootReport[] = [];

  /** The notes a wikilink target names, in the same root as `fromId`: by path (with or without the extension) or by file name, case and spelling folded. */
  resolveLink(fromId: string, target: string): NoteRecord[] {
    const from = this.byId.get(fromId);
    if (!from) return [];
    const want = foldSegment(target.replace(/\\/g, "/").replace(NOTE_EXT, "").replace(/^\/+/, ""));
    if (!want) return [];
    return this.notes().filter(note => {
      if (note.root !== from.root) return false;
      const path = foldSegment(note.path.replace(NOTE_EXT, ""));
      return want.includes("/") ? path === want || path.endsWith(`/${want}`) : path === want || path.endsWith(`/${want}`);
    });
  }

  refresh(): CorpusRefresh {
    const seen = new Set<string>(), labels = new Set<string>(), reports: CorpusRootReport[] = [];
    let parsed = 0, reused = 0;
    const nextById = new Map<string, NoteRecord>();
    for (const configured of this.ctx.paths) {
      const report: CorpusRootReport = { configured, notes: 0, skipped: { protected: 0, links: 0, large: 0, unreadable: 0, pii: 0, overCap: 0 } };
      reports.push(report);
      const checked = checkCorpusRoot(configured, this.ctx);
      if (!checked.ok) { report.refused = checked.reason; continue; }
      report.real = checked.real;
      let label = clean(basename(checked.real)).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "notes", n = 1;
      while (labels.has(label)) label = `${clean(basename(checked.real)).replace(/[^\w.-]+/g, "-") || "notes"}-${++n}`;
      labels.add(label); report.label = label;
      const found = this.walk(checked.real, report);
      if (typeof found === "string") { report.refused = `${configured} ${found}`; continue; }
      for (const file of found) {
        const abs = join(checked.real, file.path), key = sizeKey(file.st), id = `note:${label}/${file.path}`;
        const cached = this.cache.get(abs);
        let record: NoteRecord;
        if (cached && cached.key === key && cached.record.id === id) { record = cached.record; reused++; }
        else {
          try {
            const bytes = readNote(abs, file.st), text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
            if (bytes.includes(0) || text.includes("\uFFFD")) { report.skipped.unreadable++; continue; }
            if (this.piiFlagged(text)) { report.skipped.pii++; continue; }
            record = { ...parseNote(text), id, root: label, path: file.path, bytes: bytes.length, mtimeMs: file.st.mtimeMs, sha256: createHash("sha256").update(bytes).digest("hex") };
            parsed++;
          } catch { report.skipped.unreadable++; continue; }
        }
        this.cache.set(abs, { key, record }); seen.add(abs);
        nextById.set(record.id, record); report.notes++;
      }
    }
    let removed = 0;
    for (const path of [...this.cache.keys()]) if (!seen.has(path)) { this.cache.delete(path); removed++; }
    this.byId = nextById;
    this.lastReports = reports;
    return { roots: reports, notes: nextById.size, parsed, reused, removed };
  }

  private piiFlagged(text: string): boolean {
    if (!this.ctx.piiPatterns?.length) return false;
    try { return this.ctx.piiPatterns.some(pattern => new RegExp(pattern).test(text)); } catch { return true; } // a pattern that cannot be evaluated is not a clear verdict
  }

  /** The notes under `root`, or a refusal string (a vault below it, or evidence the walk could not read). Directories are visited in name order so a cap cuts deterministically. */
  private walk(root: string, report: CorpusRootReport): { path: string; st: Stats }[] | string {
    const out: { path: string; st: Stats }[] = [];
    let dirs = 0, entries = 0;
    const pii = [...(this.ctx.piiPaths ?? [])], deny = [...(this.ctx.deny ?? [])];
    const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
    while (stack.length) {
      const { dir, depth } = stack.pop()!;
      if (++dirs > MAX_DIRS || depth > MAX_DEPTH) return `has more than ${MAX_DIRS} folders or nests deeper than ${MAX_DEPTH}, so it cannot be shown to be free of a vault; point corpus.paths at a smaller folder`;
      let list: Dirent[];
      try { list = readdirSync(dir, { withFileTypes: true }); }
      catch (error) { return `has a folder that cannot be read (${errno(error) ?? "unreadable"}), so it cannot be shown to be free of a vault`; }
      list.sort((a, b) => a.name.localeCompare(b.name));
      const subdirs: string[] = [];
      for (const entry of list) {
        if (++entries > MAX_ENTRIES) return `has more than ${MAX_ENTRIES} entries, so it cannot be shown to be free of a vault; point corpus.paths at a smaller folder`;
        if (foldSegment(entry.name) === ".obsidian") return `${VAULT_REASON} (found ${join(dir, entry.name)})`;
        const abs = join(dir, entry.name);
        if (entry.isSymbolicLink()) { report.skipped.links++; continue; }
        const rel = relative(root, abs).split(sep).join("/");
        const protectedPath = () => isDenied(abs, deny) || (pii.length > 0 && (matchesPolicyLexically(this.ctx.cwd, abs, pii) || matchesPolicy(this.ctx.cwd, abs, pii)));
        if (entry.isDirectory()) {
          // A protected folder is never listed or read, so a vault anywhere below it cannot be ruled out: the root cannot be shown free of a vault, and it is refused
          // (the owner decision: evidence that cannot be checked refuses). Point corpus.paths at a folder that holds no protected folder. A protected FILE is only skipped.
          if (protectedPath()) return `holds the protected folder ${abs} (pii.paths, the deny rules or local.deny), which is never listed, so the root cannot be shown to be free of an Obsidian vault; point corpus.paths at a folder with no protected folder in it`;
          subdirs.push(abs);
        } else if (entry.isFile() && NOTE_EXT.test(entry.name)) {
          if (protectedPath()) { report.skipped.protected++; continue; }
          if (out.length >= MAX_NOTES) { report.skipped.overCap++; continue; }
          let st: Stats;
          try { st = lstatSync(abs); } catch { report.skipped.unreadable++; continue; }
          if (!st.isFile() || st.nlink !== 1) { report.skipped.links++; continue; }
          if (st.size > MAX_NOTE_BYTES) { report.skipped.large++; continue; }
          out.push({ path: rel, st });
        }
      }
      for (const sub of subdirs.reverse()) stack.push({ dir: sub, depth: depth + 1 });
    }
    return out;
  }
}

/** The paths, spelled for a person: configured text as written. Exported for the status line and tests. */
export const corpusRootLabel = (configured: string): string => isAbsolute(configured) ? configured : `./${configured}`;
