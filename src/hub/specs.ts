import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, type Stats } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { join, relative, resolve } from "node:path";
import { hubGitSync } from "./git.ts";
import { realPath } from "./project.ts";
import { parseSpecsConfig, type SpecsConfig } from "./specs-config.ts";

export { DEFAULT_SPECS_CONFIG, parseSpecsConfig, type SpecsConfig, type SpecsReview } from "./specs-config.ts";

const MAX_FILES = 2000;
const MAX_FRONTMATTER_BYTES = 8 * 1024;
const MAX_STAMPS_FILE_BYTES = 4 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS = 2000;
const MAX_TRACKED_PATHS_PER_SCOPE = 4096;
const MAX_REPORT_ITEMS = 500;
const GIT_SAFE_OPTIONS = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-c", "core.pager=cat", "-c", "credential.helper=", "-c", "core.askpass="];
const LIST_KEYS = new Set(["depends-on", "references", "implements", "covers", "tags", "paths"]);
const TYPES = new Set(["goal", "architecture", "module", "submodule"]);
const STATUS = new Set(["draft", "active", "deprecated"]);
const RANK: Readonly<Record<string, number>> = { goal: 0, architecture: 1, module: 2, submodule: 3 };

export type SpecsSeverity = "error" | "warning" | "info";
export type SpecsFreshnessState = "fresh" | "stale" | "unverified" | "nonancestor" | "unknown";

export interface SpecsDiagnostic {
  severity: SpecsSeverity;
  code: string;
  message: string;
  cause: string;
  nextSteps: string;
  path?: string;
  id?: string;
  field?: string;
  relatedId?: string;
}

export interface SpecSummary {
  id: string;
  path: string;
  title: string;
  type: string;
  status: string | null;
  paths: string[];
}

export interface SpecsFreshness {
  path: string;
  id?: string;
  state: SpecsFreshnessState;
  commitsSince: number | null;
  dirty: boolean | null;
}

export interface SpecsListReport {
  specs: SpecSummary[];
  errors: number;
  truncated: boolean;
  items: SpecsDiagnostic[];
}

export interface SpecsCoverSummary { id: string; path: string; title: string }
export interface SpecsCoverReport { specs: SpecsCoverSummary[]; errors: number; truncated: boolean; items: SpecsDiagnostic[] }

export interface SpecsCheckReport {
  specCount: number;
  errors: number;
  warnings: number;
  stale: number;
  truncated: boolean;
  freshness: SpecsFreshness[];
  items: SpecsDiagnostic[];
}

interface SpecNode {
  path: string;
  id?: string;
  type?: string;
  title?: string;
  status?: string;
  parent?: string;
  dependsOn: string[];
  references: string[];
  implements: string[];
  supersededBy?: string;
  covers: string[];
  tags: string[];
  paths: string[];
  verifiedAgainst?: string;
  bodyLinks: string[];
  frontmatterIncomplete?: boolean;
}

interface CachedFile {
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  truncated: boolean;
  node?: SpecNode;
  items: SpecsDiagnostic[];
}

interface ScanResult {
  files: string[];
  nodes: SpecNode[];
  items: SpecsDiagnostic[];
  truncated: boolean;
}

function item(severity: SpecsSeverity, code: string, message: string, cause: string, nextSteps: string, extra: Partial<SpecsDiagnostic> = {}): SpecsDiagnostic {
  return { severity, code, message, cause, nextSteps, ...extra };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSafeRepoPath(value: string): boolean {
  return value.length > 0 && value.length <= 1024 && !value.startsWith("/") && !value.startsWith("-")
    && !/^[A-Za-z]:/.test(value) && !value.includes("\\") && !/[\u0000-\u001f\u007f]/.test(value)
    && !value.split("/").some(part => part === ".." || part === "" || part === ".");
}

function isSafePathspec(value: string): boolean {
  let pattern = value;
  if (pattern.startsWith(":(")) {
    const end = pattern.indexOf(")");
    if (end < 0) return false;
    const magic = pattern.slice(2, end).split(",");
    if (!magic.length || magic.some(flag => !["glob", "literal", "icase", "top"].includes(flag)) || new Set(magic).size !== magic.length) return false;
    pattern = pattern.slice(end + 1);
  }
  const normalized = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  return isSafeRepoPath(normalized) && !normalized.includes("\n") && !normalized.includes("\r");
}

function pathspecBody(value: string): { pattern: string; magic: string[] } {
  if (!value.startsWith(":(")) return { pattern: value, magic: [] };
  const end = value.indexOf(")");
  return { pattern: value.slice(end + 1), magic: value.slice(2, end).split(",") };
}

function pathspecMatchesPath(pathspec: string, candidate: string): boolean {
  if (!isSafeRepoPath(candidate) || !isSafePathspec(pathspec)) return false;
  const parsed = pathspecBody(pathspec), magic = parsed.magic;
  const pattern = parsed.pattern.endsWith("/") ? parsed.pattern.slice(0, -1) : parsed.pattern;
  const icase = magic.includes("icase"), globMagic = magic.includes("glob");
  const matchSegment = (glob: string, value: string, slash: boolean): boolean => {
    const p = icase ? glob.toLowerCase() : glob, v = icase ? value.toLowerCase() : value;
    let previous = new Array<boolean>(v.length + 1).fill(false); previous[0] = true;
    for (let index = 0; index < p.length; index++) {
      const char = p[index]!;
      const next = new Array<boolean>(v.length + 1).fill(false);
      if (char === "*") {
        next[0] = previous[0]!;
        for (let at = 1; at <= v.length; at++) next[at] = previous[at]! || next[at - 1]! && (slash || v[at - 1] !== "/");
      } else if (char === "?") {
        for (let at = 1; at <= v.length; at++) next[at] = previous[at - 1]! && (slash || v[at - 1] !== "/");
      } else if (char === "[") {
        const end = p.indexOf("]", index + 1); if (end < 0) return false;
        let range = p.slice(index + 1, end), negate = range.startsWith("!") || range.startsWith("^");
        if (negate) range = range.slice(1);
        for (let at = 1; at <= v.length; at++) {
          const value = v[at - 1]!, match = !(!slash && value === "/") && (() => {
            for (let i = 0; i < range.length; i++) {
              if (range[i + 1] === "-" && range[i + 2] !== undefined) { if (value >= range[i]! && value <= range[i + 2]!) return true; i += 2; }
              else if (value === range[i]) return true;
            }
            return false;
          })();
          next[at] = previous[at - 1]! && (negate ? !match : match);
        }
        index = end;
      } else {
        for (let at = 1; at <= v.length; at++) next[at] = previous[at - 1]! && v[at - 1] === char;
      }
      previous = next;
    }
    return previous[v.length]!;
  };
  if (magic.includes("literal")) {
    const compare = (value: string) => icase ? value.toLowerCase() : value;
    const prefix = pattern.endsWith("/") ? pattern : `${pattern}/`;
    return compare(candidate) === compare(pattern) || compare(candidate).startsWith(compare(prefix));
  }
  if (!globMagic) {
    const parts = candidate.split("/");
    for (let end = parts.length; end > 0; end--) if (matchSegment(pattern, parts.slice(0, end).join("/"), true)) return true;
    return false;
  }
  const patternParts = pattern.split("/"), candidateParts = candidate.split("/");
  const matchParts = (parts: string[]): boolean => {
    const matrix = Array.from({ length: patternParts.length + 1 }, () => new Array<boolean>(parts.length + 1).fill(false));
    matrix[0]![0] = true;
    for (let p = 0; p < patternParts.length; p++) {
      const patternPart = patternParts[p]!;
      if (patternPart === "**") {
        for (let at = 0; at <= parts.length; at++) {
          if (matrix[p]![at]) matrix[p + 1]![at] = true;
          if (at > 0 && matrix[p + 1]![at - 1]) matrix[p + 1]![at] = true;
        }
      } else {
        for (let at = 0; at < parts.length; at++) if (matrix[p]![at] && matchSegment(patternPart, parts[at]!, false)) matrix[p + 1]![at + 1] = true;
      }
    }
    return matrix[patternParts.length]![parts.length]!;
  };
  for (let end = candidateParts.length; end > 0; end--) if (matchParts(candidateParts.slice(0, end))) return true;
  return false;
}

function normalizePath(value: string): string { return value.normalize("NFC"); }

function comparePath(a: string, b: string): number {
  const aa = normalizePath(a), bb = normalizePath(b);
  return aa < bb ? -1 : aa > bb ? 1 : 0;
}

function escapeGitGlobLiteral(value: string): string { return value.replace(/[\\*?\[\]]/g, "\\$&"); }

function splitNul(text: string): string[] { return text.split("\0").filter(Boolean); }

function boundedItems(items: SpecsDiagnostic[]): SpecsDiagnostic[] {
  if (items.length <= MAX_REPORT_ITEMS) return items;
  return [...items.slice(0, MAX_REPORT_ITEMS - 1), item("warning", "items-truncated", `report shows ${MAX_REPORT_ITEMS - 1} of ${items.length} findings`, "the diagnostic list exceeded its display bound", "use roots to narrow the scan")];
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : "unknown error"; }

function parseScalar(text: string): string {
  const value = text.trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    const quote = value[0];
    const inner = value.slice(1, -1);
    if (quote === "\"") {
      try { const decoded = JSON.parse(value); return typeof decoded === "string" ? decoded : inner; } catch { return inner; }
    }
    return inner.replaceAll("''", "'");
  }
  const comment = value.search(/\s+#/);
  return (comment >= 0 ? value.slice(0, comment) : value).trim();
}

function splitInlineList(text: string): string[] | undefined {
  const value = text.trim();
  if (!value.startsWith("[") || !value.endsWith("]")) return undefined;
  const body = value.slice(1, -1);
  if (!body.trim()) return [];
  const parts: string[] = [];
  let current = "", quote = "", escaped = false;
  for (const char of body) {
    if (escaped) { current += char; escaped = false; continue; }
    if (quote === "\"" && char === "\\") { current += char; escaped = true; continue; }
    if (quote) { current += char; if (char === quote) quote = ""; continue; }
    if (char === "\"" || char === "'") { quote = char; current += char; continue; }
    if (char === ",") { parts.push(parseScalar(current)); current = ""; continue; }
    current += char;
  }
  if (quote || escaped) return undefined;
  parts.push(parseScalar(current));
  return parts;
}

function parseHeader(text: string, path: string): { fields: Record<string, string | string[]>; bodyOffset: number; closing: boolean; tooLarge: boolean; items: SpecsDiagnostic[] } {
  const items: SpecsDiagnostic[] = [];
  const fields: Record<string, string | string[]> = {};
  const normalized = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const firstEnd = normalized.indexOf("\n");
  const firstLine = (firstEnd < 0 ? normalized : normalized.slice(0, firstEnd)).replace(/\r$/, "");
  if (firstLine !== "---") return { fields, bodyOffset: 0, closing: false, tooLarge: false, items };

  const lines = normalized.split(/\n/);
  let position = (Buffer.byteLength(firstEnd < 0 ? normalized : normalized.slice(0, firstEnd + 1))) + (text.startsWith("\uFEFF") ? 3 : 0);
  let headerBytes = 0;
  let currentList: string | undefined;
  let closing = false;
  let bodyOffset = 0;
  const addList = (key: string, value: string) => {
    if (!Object.hasOwn(fields, key)) fields[key] = [];
    if (!Array.isArray(fields[key])) { items.push(item("error", "invalid-frontmatter", `frontmatter field ${key} must be a list`, "the field uses more than one value shape", "use an inline or block list", { path, field: key })); return; }
    (fields[key] as string[]).push(value);
  };
  for (let index = 1; index < lines.length; index++) {
    const raw = lines[index]!;
    const line = raw.replace(/\r$/, "");
    const lineBytes = Buffer.byteLength(raw) + (index < lines.length - 1 ? 1 : 0);
    if (line === "---" || line === "...") { closing = true; bodyOffset = position + lineBytes; break; }
    headerBytes += lineBytes;
    position += lineBytes;
    if (headerBytes > MAX_FRONTMATTER_BYTES) {
      return { fields, bodyOffset: 0, closing: false, tooLarge: true, items: [...items, item("warning", "frontmatter-truncated", `${path}: frontmatter scan stopped at 8 KiB`, "the frontmatter is larger than the per-file scan cap", "shorten frontmatter to 8 KiB or set specs.roots to narrow discovery", { path })] };
    }
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const listItem = /^\s+-\s*(.*)$/.exec(line);
    if (listItem) {
      if (!currentList) { items.push(item("error", "invalid-frontmatter", `${path}: list item has no field`, "a block-list item appeared outside a list field", "add the item under a supported list key", { path })); continue; }
      addList(currentList, parseScalar(listItem[1]!));
      continue;
    }
    if (/^\s/.test(line)) { currentList = undefined; items.push(item("error", "invalid-frontmatter", `${path}: nested frontmatter is unsupported`, "the frontmatter parser accepts flat scalar and list fields only", "flatten the field or move detail into the Markdown body", { path })); continue; }
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) { currentList = undefined; items.push(item("error", "invalid-frontmatter", `${path}: malformed frontmatter line`, "the line is not a flat key/value field", "use key: value or a flat list", { path })); continue; }
    const key = match[1]!, rawValue = match[2]!.trim();
    currentList = undefined;
    if (Object.hasOwn(fields, key)) { items.push(item("error", "duplicate-field", `${path}: duplicate frontmatter field ${key}`, "the field appears more than once", "keep one value for each field", { path, field: key })); continue; }
    if (LIST_KEYS.has(key)) {
      if (!rawValue) { fields[key] = []; currentList = key; continue; }
      const list = splitInlineList(rawValue);
      if (!list) { items.push(item("error", "invalid-frontmatter", `${path}: ${key} must be a list`, "a list field has a scalar value", "use [item] or a block list", { path, field: key })); continue; }
      fields[key] = list;
    } else {
      if (rawValue.startsWith("[") || rawValue.startsWith("{")) { items.push(item("error", "invalid-frontmatter", `${path}: ${key} must be a scalar`, "nested structures are unsupported", "use a scalar or a supported flat list", { path, field: key })); continue; }
      fields[key] = parseScalar(rawValue);
    }
  }
  return { fields, bodyOffset, closing, tooLarge: false, items };
}

function scanBodyLinks(fd: number, offset: number, fileSize: number): string[] {
  const links = new Set<string>();
  let position = offset, tail = "";
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const decoder = new StringDecoder("utf8");
  const consume = (text: string, final: boolean) => {
    const combined = tail + text;
    const boundary = final ? combined.length : Math.max(0, combined.length - 260);
    for (const match of combined.matchAll(/\[\[([^\]\r\n]{1,256})\]\]/g)) {
      if (match.index! + match[0].length > boundary) continue;
      const id = match[1]!.trim(); if (id) links.add(id);
    }
    tail = final ? "" : combined.slice(Math.max(0, boundary - 260));
  };
  while (position < fileSize) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, fileSize - position), position);
    if (!count) break;
    consume(decoder.write(chunk.subarray(0, count)), false);
    position += count;
  }
  consume(decoder.end(), true);
  return [...links];
}

function ranks(type: string): number | undefined { return RANK[type]; }

function summary(node: SpecNode, includePaths = true): SpecSummary {
  return { id: node.id ?? "", path: node.path, title: node.title ?? "", type: node.type ?? "", status: node.status ?? null, paths: includePaths ? [...node.paths] : [] };
}

function coverSummary(node: SpecNode): SpecsCoverSummary { return { id: node.id ?? "", path: node.path, title: node.title ?? "" }; }

/** Cached, read-only graph and freshness engine shared by the daemon and CLI. */
export class SpecsEngine {
  private readonly root: string;
  private readonly config: SpecsConfig;
  private readonly cache = new Map<string, CachedFile>();
  private readonly pathspecCache = new Map<string, string[]>();

  constructor(root: string, config: SpecsConfig) {
    this.root = realPath(root);
    this.config = parseSpecsConfig(config);
  }

  private git(args: string[], maxBuffer = MAX_GIT_OUTPUT_BYTES): { status: number | null; stdout: string; stderr?: string; error?: { code?: string; message?: string } } {
    const argv = ["-C", this.root, ...GIT_SAFE_OPTIONS, ...args];
    try {
      const result = hubGitSync(argv, { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer });
      return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr, error: result.error ? { code: (result.error as NodeJS.ErrnoException).code, message: result.error.message } : undefined };
    } catch (error) { return { status: null, stdout: "", error: { message: errorText(error) } }; }
  }

  private discoveryPathspecs(): string[] {
    if (!this.config.roots.length) return ["*.md"];
    return this.config.roots.flatMap(root => { const literal = escapeGitGlobLiteral(root); return [`:(glob)${literal}/*.md`, `:(glob)${literal}/**/*.md`]; });
  }

  private readCandidate(path: string): CachedFile | undefined {
    if (!isSafeRepoPath(path) || !path.toLowerCase().endsWith(".md")) return undefined;
    const absolute = resolve(this.root, path);
    const rel = relative(this.root, absolute);
    if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) return undefined;
    let before;
    try {
      const pieces = path.split("/");
      let current = this.root;
      for (let index = 0; index < pieces.length; index++) {
        current = join(current, pieces[index]!);
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || index < pieces.length - 1 && !stat.isDirectory()) return undefined;
        if (index === pieces.length - 1 && !stat.isFile()) return undefined;
      }
      before = lstatSync(absolute);
    } catch { return undefined; }
    const previous = this.cache.get(path);
    if (previous && previous.size === before.size && previous.mtimeMs === before.mtimeMs && previous.dev === before.dev && previous.ino === before.ino) return previous;

    let fd: number | undefined;
    try {
      fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return undefined;
      const prefix = Buffer.alloc(Math.min(opened.size, MAX_FRONTMATTER_BYTES + 16));
      let got = 0;
      while (got < prefix.length) { const count = readSync(fd, prefix, got, prefix.length - got, got); if (!count) break; got += count; }
      const parsed = parseHeader(prefix.subarray(0, got).toString("utf8"), path);
      const candidate = typeof parsed.fields.id === "string" || typeof parsed.fields.type === "string" && TYPES.has(parsed.fields.type);
      let node: SpecNode | undefined;
      const diagnostics = candidate ? [...parsed.items] : [];
      if (candidate) {
        if (!parsed.closing && !parsed.tooLarge) diagnostics.push(item("error", "frontmatter-unterminated", `${path}: spec frontmatter is incomplete`, "the opening delimiter has no closing delimiter", "close the frontmatter delimiter within 8 KiB", { path }));
        const scalar = (key: string): string | undefined => typeof parsed.fields[key] === "string" ? parsed.fields[key] as string : undefined;
        const list = (key: string): string[] => Array.isArray(parsed.fields[key]) ? parsed.fields[key] as string[] : [];
        node = { path, id: scalar("id"), type: scalar("type"), title: scalar("title"), status: scalar("status"), parent: scalar("parent"), dependsOn: list("depends-on"), references: list("references"), implements: list("implements"), supersededBy: scalar("superseded-by"), covers: list("covers"), tags: list("tags"), paths: list("paths"), verifiedAgainst: scalar("verified-against"), bodyLinks: parsed.closing ? scanBodyLinks(fd, parsed.bodyOffset, opened.size) : [], ...(!parsed.closing ? { frontmatterIncomplete: true } : {}) };
      }
      const after = lstatSync(absolute);
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return undefined;
      const cached = { size: before.size, mtimeMs: before.mtimeMs, dev: before.dev, ino: before.ino, node, items: diagnostics, truncated: candidate && parsed.tooLarge };
      this.cache.set(path, cached);
      return cached;
    } catch {
      return undefined;
    } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
  }

  private scan(): ScanResult {
    this.pathspecCache.clear();
    const result = this.git(["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...this.discoveryPathspecs()]);
    if (result.status !== 0) {
      return { files: [], nodes: [], items: [item("error", "discovery-unavailable", "spec discovery is unavailable", result.error?.message ?? result.stderr ?? "git ls-files failed", "check that this is a readable Git worktree", { path: this.root })], truncated: false };
    }
    const discovered = splitNul(result.stdout).sort(comparePath);
    let truncated = discovered.length > MAX_FILES;
    const files = discovered.slice(0, MAX_FILES);
    const nodes: SpecNode[] = [], items: SpecsDiagnostic[] = [];
    const seen = new Set(files);
    for (const old of this.cache.keys()) if (!seen.has(old)) this.cache.delete(old);
    for (const file of files) {
      const cached = this.readCandidate(file);
      if (!cached) continue; // Symlinks, unsafe names and unreadable entries are never followed.
      items.push(...cached.items);
      if (cached.node) nodes.push(cached.node);
      if (cached.truncated) truncated = true;
    }
    if (discovered.length > MAX_FILES) items.push(item("warning", "scan-truncated", `spec scan stopped at ${MAX_FILES} Markdown files`, `the discovery result has more than ${MAX_FILES} paths`, "set specs.roots to the design areas this project uses", { path: this.root }));
    return { files, nodes, items, truncated };
  }

  private pathspecMatches(pathspec: string, trackedOnly: boolean): string[] {
    const key = `${trackedOnly ? "tracked" : "all"}\0${pathspec}`;
    const cached = this.pathspecCache.get(key); if (cached) return cached;
    if (!isSafePathspec(pathspec)) return [];
    const args = trackedOnly ? ["ls-files", "-z", "--", pathspec] : ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", pathspec];
    const result = this.git(args);
    const paths = result.status === 0 ? splitNul(result.stdout).sort(comparePath).slice(0, MAX_TRACKED_PATHS_PER_SCOPE) : [];
    this.pathspecCache.set(key, paths);
    return paths;
  }

  private analyze(scan: ScanResult): { items: SpecsDiagnostic[]; byId: Map<string, SpecNode>; counts: { errors: number; warnings: number } } {
    const items = [...scan.items];
    const byId = new Map<string, SpecNode>();
    const ids = new Map<string, SpecNode[]>();
    for (const node of scan.nodes) {
      if (node.frontmatterIncomplete) continue;
      if (!node.id) items.push(item("error", "required-field", `${node.path}: spec is missing id`, "the frontmatter has a type but no id", "add a unique id to the frontmatter", { path: node.path, field: "id" }));
      if (!node.type) items.push(item("error", "required-field", `${node.path}: spec is missing type`, "the frontmatter has an id but no type", "set type to goal, architecture, module or submodule", { path: node.path, id: node.id, field: "type" }));
      if (!node.title?.trim()) items.push(item("error", "required-field", `${node.path}: spec is missing title`, "the frontmatter has no title", "add a non-empty title", { path: node.path, id: node.id, field: "title" }));
      if (node.id) {
        const group = ids.get(node.id) ?? []; group.push(node); ids.set(node.id, group);
      }
    }
    for (const [id, group] of ids) {
      byId.set(id, group[0]!);
      if (group.length > 1) for (const duplicate of group.slice(1)) items.push(item("error", "duplicate-id", `${duplicate.path}: duplicate spec id ${id}`, `another Markdown file already declares ${id}`, "give each spec a unique id", { path: duplicate.path, id, relatedId: group[0]!.path }));
    }
    let goals = 0;
    const covers = new Map<string, SpecNode[]>();
    for (const node of scan.nodes) {
      if (node.frontmatterIncomplete) continue;
      if (node.type && !TYPES.has(node.type)) items.push(item("error", "unknown-type", `${node.path}: unknown spec type ${node.type}`, "type is outside the fixed spec vocabulary", "use goal, architecture, module or submodule", { path: node.path, id: node.id, field: "type" }));
      if (node.status && !STATUS.has(node.status)) items.push(item("error", "unknown-status", `${node.path}: unknown spec status ${node.status}`, "status is outside the fixed spec vocabulary", "use draft, active or deprecated", { path: node.path, id: node.id, field: "status" }));
      if (node.type === "goal") goals++;
      if (node.type && node.type !== "goal" && !node.parent) items.push(item("warning", "orphan", `${node.path}: ${node.type} spec has no parent`, "non-goal specs form the design tree through parent links", "add a parent link if this spec belongs under another design decision", { path: node.path, id: node.id, field: "parent" }));
      if (node.status === "active" && !node.paths.length) items.push(item("warning", "active-without-paths", `${node.path}: active spec has no paths`, "freshness cannot be calculated without paths", "add one or more repository-relative paths", { path: node.path, id: node.id, field: "paths" }));
      if (node.status === "deprecated" && !node.supersededBy) items.push(item("warning", "deprecated-without-replacement", `${node.path}: deprecated spec has no replacement`, "deprecated specs should point to their current replacement", "add superseded-by or keep the spec active", { path: node.path, id: node.id, field: "superseded-by" }));
      if (node.supersededBy && node.status !== "deprecated") items.push(item("error", "superseded-by-misuse", `${node.path}: superseded-by is only valid on a deprecated spec`, "a non-deprecated spec names a replacement", "set status to deprecated or remove superseded-by", { path: node.path, id: node.id, field: "superseded-by" }));
      if (node.supersededBy && node.id === node.supersededBy) items.push(item("error", "superseded-by-self", `${node.path}: spec cannot supersede itself`, "superseded-by points back to the same id", "point to a different replacement spec", { path: node.path, id: node.id, field: "superseded-by" }));
      for (const token of node.covers) { const group = covers.get(token) ?? []; group.push(node); covers.set(token, group); }
      const links = [node.parent, node.supersededBy, ...node.dependsOn, ...node.references, ...node.implements].filter((value): value is string => !!value);
      for (const target of links) if (!byId.has(target) && !ids.has(target)) items.push(item("error", "dangling-link", `${node.path}: link to unknown spec ${target}`, "a frontmatter or body link does not resolve by id", "add the target spec or correct the linked id", { path: node.path, id: node.id, relatedId: target }));
      for (const target of node.bodyLinks) if (!byId.has(target) && !ids.has(target)) items.push(item("warning", "unknown-body-link", `${node.path}: body link refers to unknown spec ${target}`, "a Markdown wiki-link does not resolve by spec id", "correct the link or add the referenced spec", { path: node.path, id: node.id, relatedId: target }));
      if (node.supersededBy && byId.get(node.supersededBy)?.status === "deprecated") items.push(item("warning", "deprecated-replacement", `${node.path}: replacement ${node.supersededBy} is also deprecated`, "the replacement does not point to a current spec", "update superseded-by to a non-deprecated replacement", { path: node.path, id: node.id, relatedId: node.supersededBy }));
      if (node.paths.length) for (const path of node.paths) {
        if (!isSafePathspec(path)) { items.push(item("error", "invalid-paths", `${node.path}: invalid paths entry ${path}`, "paths must be safe repository-relative Git pathspecs", "remove absolute paths, dot segments and pathspec magic", { path: node.path, id: node.id, field: "paths" })); continue; }
        if (!this.pathspecMatches(path, true).length) items.push(item("error", "invalid-paths", `${node.path}: paths entry matches no tracked file: ${path}`, "the pathspec does not select a tracked repository file", "correct the pathspec or add a matching tracked file", { path: node.path, id: node.id, field: "paths" }));
      }
      if (node.verifiedAgainst && !node.paths.length) this.validateStamp(node.path, node.id, node.verifiedAgainst, items);
    }
    if (goals > 1) items.push(item("warning", "multiple-goals", `found ${goals} goal specs`, "a repository usually has one goal root", "keep one root goal or confirm the additional goal is intentional"));
    for (const [token, group] of covers) if (group.length > 1) for (const duplicate of group.slice(1)) items.push(item("warning", "duplicate-covers", `${duplicate.path}: covers token ${token} is also claimed by ${group[0]!.id}`, "a covers token is claimed by multiple specs", "keep each covers token on one spec", { path: duplicate.path, id: duplicate.id, relatedId: group[0]!.id }));
    this.detectParentCycles(scan.nodes, items);
    for (const node of scan.nodes) if (node.parent) {
      const parent = byId.get(node.parent);
      if (parent && node.type && parent.type && ranks(node.type) !== undefined && ranks(parent.type) !== undefined && ranks(node.type)! <= ranks(parent.type)!) items.push(item("error", "rank", `${node.path}: ${node.type} must be below ${parent.type}`, "a child spec rank must be greater than its parent's rank", "move the spec under a lower-ranked parent or change its type", { path: node.path, id: node.id, relatedId: parent.id }));
    }
    const counts = { errors: items.filter(entry => entry.severity === "error").length, warnings: items.filter(entry => entry.severity === "warning").length };
    return { items, byId, counts };
  }

  private detectParentCycles(nodes: SpecNode[], items: SpecsDiagnostic[]): void {
    const byId = new Map(nodes.filter(node => node.id).map(node => [node.id!, node]));
    const color = new Map<string, 0 | 1 | 2>();
    const reported = new Set<string>();
    const visit = (id: string, stack: string[]) => {
      const state = color.get(id) ?? 0;
      if (state === 2) return;
      if (state === 1) {
        const index = stack.indexOf(id), cycle = (index < 0 ? stack : stack.slice(index)).concat(id);
        const key = [...new Set(cycle)].sort().join("\0");
        if (!reported.has(key)) { reported.add(key); const node = byId.get(id); items.push(item("error", "parent-cycle", `${node?.path ?? id}: parent cycle ${cycle.join(" -> ")}`, "parent links must form an acyclic tree", "break one parent link in the cycle", { path: node?.path, id })); }
        return;
      }
      color.set(id, 1);
      const parent = byId.get(id)?.parent;
      if (parent && byId.has(parent)) visit(parent, [...stack, id]);
      color.set(id, 2);
    };
    for (const id of byId.keys()) visit(id, []);
  }

  list(): SpecsListReport {
    const scan = this.scan(), analysis = this.analyze(scan);
    return { specs: scan.nodes.map(node => summary(node)), errors: analysis.counts.errors, truncated: scan.truncated || analysis.items.length > MAX_REPORT_ITEMS, items: boundedItems(analysis.items) };
  }

  covers(paths: readonly string[]): SpecsCoverReport {
    const scan = this.scan(), analysis = this.analyze(scan);
    const valid = paths.filter(isSafeRepoPath), invalid = paths.filter(path => !isSafeRepoPath(path));
    const items = [...analysis.items, ...invalid.map(path => item("error", "invalid-cover-path", `cannot check unsafe path ${path}`, "covers accepts repository-relative file paths only", "remove absolute paths, dot segments and option-like values", { path }))];
    const requested = [...new Set(valid)];
    const result: SpecsCoverSummary[] = [];
    for (const node of scan.nodes) {
      const matches = node.paths.some(pathspec => {
        const indexed = this.pathspecMatches(pathspec, false);
        return requested.some(path => indexed.includes(path) || pathspecMatchesPath(pathspec, path));
      });
      if (matches) result.push(coverSummary(node));
    }
    return { specs: result, errors: analysis.counts.errors + invalid.length, truncated: scan.truncated || items.length > MAX_REPORT_ITEMS, items: boundedItems(items) };
  }

  check(options: { base?: string; requireFresh?: boolean } = {}): SpecsCheckReport {
    const scan = this.scan(), analysis = this.analyze(scan), items = [...analysis.items];
    const fresh = this.freshness(scan.nodes, items), freshness = fresh.rows;
    if (options.base) this.baseDrift(scan.nodes, options.base, items);
    const errors = items.filter(entry => entry.severity === "error").length;
    const warnings = items.filter(entry => entry.severity === "warning").length;
    return { specCount: scan.nodes.length, errors, warnings, stale: freshness.filter(row => row.state === "stale").length, truncated: scan.truncated || fresh.truncated || items.length > MAX_REPORT_ITEMS, freshness, items: boundedItems(items) };
  }

  private freshness(nodes: SpecNode[], items: SpecsDiagnostic[]): { rows: SpecsFreshness[]; truncated: boolean } {
    const rows: SpecsFreshness[] = [];
    for (const node of nodes) {
      if (!node.paths.length) continue;
      if (!node.verifiedAgainst) { rows.push({ path: node.path, ...(node.id ? { id: node.id } : {}), state: "unverified", commitsSince: null, dirty: null }); continue; }
      const result = this.measureFreshness(node.path, node.id, node.verifiedAgainst, node.paths, items);
      rows.push(result);
    }
    const stampFile = this.config.stamps_file;
    let truncated = false;
    if (stampFile) { const result = this.readStampFile(stampFile, items); rows.push(...result.rows); truncated = result.truncated; }
    return { rows, truncated };
  }

  private validateStamp(path: string, id: string | undefined, stamp: string, items: SpecsDiagnostic[]): "valid" | "nonancestor" | "unknown" {
    if (!/^[0-9a-f]{40}$/.test(stamp)) {
      items.push(item("error", "invalid-verified-against", `${path}: verified-against must be a full lowercase commit SHA`, "the stamp is not a full 40-character SHA", "set verified-against to a reviewed commit SHA", { path, id, field: "verified-against" }));
      return "unknown";
    }
    const commit = this.git(["cat-file", "-e", `${stamp}^{commit}`]);
    if (commit.status !== 0) { items.push(item("error", "invalid-verified-against", `${path}: verified commit does not resolve`, "the stamp is missing or is not a commit", "set verified-against to an existing ancestor commit", { path, id, field: "verified-against" })); return "unknown"; }
    const ancestor = this.git(["merge-base", "--is-ancestor", stamp, "HEAD"]);
    if (ancestor.status !== 0) {
      const nonancestor = ancestor.status === 1;
      items.push(item("error", "nonancestor-stamp", `${path}: verified commit is not an ancestor of HEAD`, nonancestor ? "the stamp belongs to another history" : "Git could not verify stamp ancestry", "stamp from an ancestor commit in this repository", { path, id, field: "verified-against" }));
      return nonancestor ? "nonancestor" : "unknown";
    }
    return "valid";
  }

  private measureFreshness(path: string, id: string | undefined, stamp: string, paths: string[], items: SpecsDiagnostic[]): SpecsFreshness {
    const row: SpecsFreshness = { path, ...(id ? { id } : {}), state: "unknown", commitsSince: null, dirty: null };
    const stampState = this.validateStamp(path, id, stamp, items);
    if (stampState !== "valid") { row.state = stampState; return row; }
    const count = this.git(["rev-list", "--count", `${stamp}..HEAD`, "--", ...paths]);
    const dirty = this.dirtiness(paths);
    if (count.status !== 0 || dirty === undefined) {
      items.push(item("error", "freshness-unavailable", `${path}: cannot compute source freshness`, "Git history or the working tree could not be read safely", "check repository state and retry the specs check", { path, id }));
      return row;
    }
    const commits = Number(count.stdout.trim());
    if (!Number.isSafeInteger(commits) || commits < 0) {
      items.push(item("error", "freshness-unavailable", `${path}: invalid source commit count`, "Git returned a non-numeric revision count", "check repository history and retry the specs check", { path, id }));
      return row;
    }
    row.commitsSince = commits;
    row.dirty = dirty;
    row.state = commits > 0 || dirty ? "stale" : "fresh";
    return row;
  }

  private dirtiness(paths: string[]): boolean | undefined {
    const staged = this.git(["diff-index", "--cached", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--", ...paths]);
    if (staged.status === 1) return true;
    if (staged.status !== 0) return undefined;
    const untracked = this.git(["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths]);
    if (untracked.status !== 0) return undefined;
    if (untracked.stdout) return true;
    const tracked = this.git(["ls-files", "--stage", "-z", "--", ...paths]);
    if (tracked.status !== 0) return undefined;
    const entries = splitNul(tracked.stdout);
    if (entries.length > MAX_TRACKED_PATHS_PER_SCOPE) return undefined;
    try {
      for (const entry of entries) {
        const match = /^([0-7]{6}) ([0-9a-f]{40}) ([0-3])\t([\s\S]+)$/.exec(entry);
        if (!match) return undefined;
        const [, mode, oid, stage, file] = match;
        if (stage !== "0") return true;
        if (!["100644", "100755", "120000"].includes(mode!)) return undefined;
        const absolute = resolve(this.root, file!);
        const rel = relative(this.root, absolute);
        if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) return undefined;
        let info: Stats;
        try { info = this.safeStat(file!, mode === "120000"); } catch (error) { if ((error as { code?: string }).code === "ENOENT" && mode !== "120000") return true; return undefined; }
        let bytes: Buffer;
        if (mode === "120000") { if (!info.isSymbolicLink()) return true; bytes = readlinkSync(absolute, { encoding: "buffer" }); }
        else { if (!info.isFile() || info.isSymbolicLink()) return true; if (info.size > 4 * 1024 * 1024) return undefined; bytes = readFileSync(absolute); }
        const hash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
        if (hash !== oid || mode !== "120000" && !!(info.mode & 0o111) !== (mode === "100755")) return true;
      }
      return false;
    } catch { return undefined; }
  }

  private readStampFile(path: string, items: SpecsDiagnostic[]): { rows: SpecsFreshness[]; truncated: boolean } {
    let info: Stats;
    try { info = this.safeStat(path); }
    catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        items.push(item("error", "stamps-unavailable", `${path}: configured stamps file is missing`, "specs.stamps_file names no readable file", "create a schemaVersion 1 documents file or clear specs.stamps_file", { path }));
        return { rows: [], truncated: false };
      }
      items.push(item("error", "stamps-unavailable", `${path}: stamps file is not a safe regular file`, errorText(error), "use a regular repository file without symlink components or clear specs.stamps_file", { path }));
      return { rows: [], truncated: false };
    }
    if (info.size > MAX_STAMPS_FILE_BYTES) {
      items.push(item("warning", "stamps-truncated", `${path}: stamps file is too large to scan`, `the file exceeds ${MAX_STAMPS_FILE_BYTES} bytes`, "reduce the stamps file or split its document inventory", { path }));
      return { rows: [], truncated: true };
    }
    const absolute = resolve(this.root, path);
    let manifest: unknown;
    try { manifest = JSON.parse(readFileSync(absolute, "utf8")); }
    catch (error) { items.push(item("error", "stamps-invalid", `${path}: stamps file cannot be parsed`, errorText(error), "repair the schemaVersion 1 documents object", { path })); return { rows: [], truncated: false }; }
    if (!isRecord(manifest) || manifest.schemaVersion !== 1 || !isRecord(manifest.documents)) {
      items.push(item("error", "stamps-invalid", `${path}: stamps file schema is invalid`, "expected schemaVersion 1 and a documents object", "repair the stamps file or clear specs.stamps_file", { path })); return { rows: [], truncated: false };
    }
    const rows: SpecsFreshness[] = [];
    for (const [document, entry] of Object.entries(manifest.documents)) {
      if (!isSafeRepoPath(document) || !isRecord(entry) || !Array.isArray(entry.paths) || !entry.paths.length || entry.paths.some(path => typeof path !== "string" || !isSafePathspec(path))) {
        items.push(item("error", "stamps-invalid-entry", `${path}: invalid stamp entry ${document}`, "entry path or covered paths are unsafe or malformed", "use repository-relative document paths and covered Git pathspecs", { path, id: document }));
        continue;
      }
      const missingScope = (entry.paths as string[]).find(scope => !this.pathspecMatches(scope, true).length);
      if (missingScope) {
        items.push(item("error", "stamps-invalid-entry", `${path}: stamp entry ${document} covers no tracked file: ${missingScope}`, "a covered pathspec selects no tracked file", "correct the pathspec or restore a matching tracked file", { path: document, field: "paths" }));
        continue;
      }
      const stamp = entry.verifiedAgainst;
      const itemPath = document;
      if (!this.readableRegularFile(document)) {
        items.push(item("error", "stamped-document-missing", `${document}: stamped document is missing or unreadable`, "the stamp names no safe regular file", "restore the document or remove its stamp entry", { path: document }));
        continue;
      }
      if (typeof stamp !== "string") {
        items.push(item("error", "invalid-verified-against", `${document}: verified commit is missing`, "stamp entry has no verifiedAgainst SHA", "stamp the document at a reviewed commit", { path: document, field: "verifiedAgainst" }));
        rows.push({ path: itemPath, state: "unknown", commitsSince: null, dirty: null });
        continue;
      }
      rows.push(this.measureFreshness(itemPath, undefined, stamp, entry.paths as string[], items));
    }
    return { rows, truncated: false };
  }

  private safeStat(path: string, allowFinalSymlink = false): Stats {
    if (!isSafeRepoPath(path)) throw new Error("unsafe repository-relative path");
    let current = this.root;
    const parts = path.split("/");
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]!);
      const stat = lstatSync(current);
      const final = index === parts.length - 1;
      if (stat.isSymbolicLink() && !(final && allowFinalSymlink) || !final && !stat.isDirectory()) throw new Error("unsafe path component");
      if (final && !stat.isFile() && !(allowFinalSymlink && stat.isSymbolicLink())) throw new Error("not a regular file");
    }
    return lstatSync(current);
  }

  private readableRegularFile(path: string): boolean { try { const stat = this.safeStat(path); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; } }

  private baseDrift(nodes: SpecNode[], base: string, items: SpecsDiagnostic[]): void {
    if (!base || base.length > 200 || base.startsWith("-") || /[\u0000-\u0020\u007f]/.test(base)) {
      items.push(item("error", "invalid-base", "spec base reference is invalid", "the supplied base is not a safe Git ref", "use a branch or commit name without options or whitespace")); return;
    }
    const verifiedBase = this.git(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]);
    if (verifiedBase.status !== 0) { items.push(item("error", "base-unavailable", "cannot compare specs against base", "the requested base does not resolve to a commit", "check the branch or commit name and retry")); return; }
    const diff = this.git(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", `${base}..HEAD`, "--"]);
    if (diff.status !== 0) { items.push(item("error", "base-unavailable", "cannot compare specs against base", diff.stderr ?? "Git could not read the requested base", "check that the base exists and is reachable")); return; }
    const changed = new Set(splitNul(diff.stdout));
    for (const node of nodes) {
      if (!node.id || !node.paths.length || changed.has(node.path)) continue;
      const scoped = this.git(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", `${base}..HEAD`, "--", ...node.paths]);
      if (scoped.status !== 0) continue;
      const touching = splitNul(scoped.stdout).filter(file => file !== node.path);
      if (touching.length) items.push(item("info", "paths-changed-spec-unchanged", `${node.path}: covered paths changed since ${base}, but the spec did not`, `${touching.slice(0, 20).join(", ")}${touching.length > 20 ? ", ..." : ""}`, "review the spec and update it in the same change when the design changed", { path: node.path, id: node.id }));
    }
  }
}
