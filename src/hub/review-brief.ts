import type { CodeFactResult, CodeSymbol } from "./code-facts.ts";
import { childEnv } from "./child-process.ts";
import { hubGitSync } from "./git.ts";

/**
 * #520: the review brief ahub builds itself, in place of `ocr delegate preview` and `rule`. Every reviewer gets the same
 * one: the changed files of the head against its merge base with the checkout's HEAD, the files left out and why, the
 * review rules that apply to each file, and the files the plain name list shows that the brief does not. Only git is
 * read, bounded; nothing here touches the board.
 */
export interface BriefFile { path: string; status: string; oldPath?: string; insertions?: number; deletions?: number }
export interface BriefExcluded { path: string; status: string; oldPath?: string; reason: string }
export interface ReviewBrief {
  symbols?: { state: "known" | "unknown"; complete?: boolean; files: {path:string; symbols:CodeSymbol[]}[]; planned: string[]; unplanned: string[]; unseen: string[] };
  head: string;
  /** The default branch the head is compared with: origin/HEAD, origin/main or origin/master. */
  base: string;
  mergeBase: string;
  reviewable: BriefFile[];
  excluded: BriefExcluded[];
  /** Changes left out by the privacy policy, both sides of a move included; counted, never named. */
  withheld: number;
  /** Rule files by name (REVIEW.md, then `ahub-review-rules` attribute values) with their text at the merge base. */
  rules: { source: string; text: string }[];
  /** Configured rule files the brief could not load, with why: the reviewer reads them in the repository. */
  rulesMissing: { source: string; reason: string }[];
  /** Reviewable paths grouped by the rule sources that apply to them. */
  ruleGroups: { sources: string[]; paths: string[] }[];
  /** Paths in the plain name list of the range that the brief does not list: read them directly. */
  unlisted: string[];
}
export interface BriefPolicy { privatePath(path: string): boolean; nameable(text: string): boolean }

const MAX_FILES = 500, RULE_BYTES = 32_000, MAX_RULE_FILES = 8;
const LOCKFILES = new Set(["bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "uv.lock", "go.sum", "composer.lock", "Gemfile.lock"]);
const HEX = /^[0-9a-f]{7,40}$/i;

/** Every diff of the brief reads attributes from the trusted tree, never the checkout (a head's `* -diff` cannot mark its own files binary). */
const attrFrom = (source?: string) => source ? [`--attr-source=${source}`] : [];
const git = (cwd: string, args: string[]) => hubGitSync(["-C", cwd, ...args], { encoding: "utf8", env: childEnv(process.env), maxBuffer: 16 * 1024 * 1024, timeout: 15_000 });

/**
 * The changes of `HEAD...head` as groups: one path, or both sides of a rename or copy. A caller that must not show a
 * private file withholds a whole group when any side is private, so content never shows up under a public name.
 * ponytail: git's 50% similarity decides what counts as a move.
 */
export function changedPathGroups(cwd: string, head: string, base = "HEAD", attrSource?: string): { status: string; paths: string[] }[] | undefined {
  const r = git(cwd, [...attrFrom(attrSource), "diff", "--no-ext-diff", "--no-textconv", "--relative", "-M", "-C", "--find-copies-harder", "--name-status", "-z", `${base}...${head}`, "--"]);
  if (r.status !== 0 || typeof r.stdout !== "string") return undefined;
  const fields = r.stdout.split("\0"), groups: { status: string; paths: string[] }[] = [];
  for (let i = 0; i < fields.length - 1;) {
    const status = fields[i++]!, sides = /^[RC]/.test(status) ? 2 : 1;
    groups.push({ status, paths: fields.slice(i, i + sides) }); i += sides;
  }
  return groups;
}

export function buildReviewBrief(cwd: string, head: unknown, policy: BriefPolicy): ReviewBrief | { unavailable: string } {
  if (typeof head !== "string" || !HEX.test(head)) return { unavailable: "the task names no commit" };
  const full = git(cwd, ["rev-parse", "--verify", "-q", `${head}^{commit}`]);
  if (full.status !== 0 || typeof full.stdout !== "string") return { unavailable: `commit ${head} is not in this checkout` };
  const commit = full.stdout.trim();
  // A reliable base only: the remote's default branch. The checkout's HEAD may be the head itself (an empty inventory)
  // or another session's branch.
  const from = ["origin/HEAD", "origin/main", "origin/master"].find(ref => git(cwd, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]).status === 0);
  if (!from) return { unavailable: "no default branch (origin/HEAD, origin/main or origin/master) to compare with" };
  const base = git(cwd, ["merge-base", from, commit]);
  if (base.status !== 0 || typeof base.stdout !== "string") return { unavailable: `commit ${head} shares no history with ${from}` };
  const mergeBase = base.stdout.trim();
  const groups = changedPathGroups(cwd, commit, from, mergeBase);
  if (!groups) return { unavailable: `the changes of ${head} could not be read` };
  if (!groups.length) return { unavailable: `commit ${head} has no changes against ${from}` };
  const shown = groups.filter(g => !g.paths.some(path => policy.privatePath(path) || !policy.nameable(path)));
  if (shown.length > MAX_FILES) return { unavailable: `${shown.length} changed files, over the brief's ${MAX_FILES}` };
  const withheld = groups.length - shown.length;
  const counts = numstat(cwd, commit, from, mergeBase);
  // Attributes and rules come from the merge base: a change cannot lift its own review obligations (a head that marks
  // everything generated, or edits REVIEW.md, is still reviewed under the rules it is merging into).
  // Both sides of a move: renaming a reviewed file to a generated or unscoped name must not shed its obligations.
  const attrs = attributes(cwd, mergeBase, [...new Set(shown.flatMap(g => g.paths))]);
  if (!counts || !attrs) return { unavailable: `the file details of ${head} could not be read` };
  const reviewable: BriefFile[] = [], excluded: BriefExcluded[] = [];
  for (const g of shown) {
    const path = g.paths.at(-1)!, count = counts.get(path);
    const sides = { status: g.status[0]!, ...(g.paths.length === 2 ? { oldPath: g.paths[0]! } : {}) };
    // Excluded only when every side is: a move keeps the source's obligation.
    const sideReason = (p: string) => attrs.get(p)?.generated ? "generated (linguist-generated)" : LOCKFILES.has(p.split("/").at(-1)!) ? "lockfile" : undefined;
    const reasons = g.paths.map(sideReason);
    const reason = count?.binary ? "binary" : reasons.every(Boolean) ? reasons.at(-1) : undefined;
    if (reason) { excluded.push({ path, ...sides, reason }); continue; }
    reviewable.push({ path, ...sides, ...(count && !count.binary ? { insertions: count.insertions, deletions: count.deletions } : {}) });
  }
  const ruleText = new Map<string, string>(), rulesMissing = new Map<string, string>();
  const readRule = (source: string): boolean => {
    if (ruleText.has(source)) return true;
    if (rulesMissing.has(source)) return false;
    // A private or non-nameable rule path is not named either: it is left out silently.
    if (policy.privatePath(source) || !policy.nameable(source)) return false;
    if (ruleText.size >= MAX_RULE_FILES) { rulesMissing.set(source, `over the brief's ${MAX_RULE_FILES} rule files`); return false; }
    const r = git(cwd, ["show", `${mergeBase}:${source}`]);
    if (r.status !== 0 || typeof r.stdout !== "string") { rulesMissing.set(source, "not found at the merge base"); return false; }
    // Screened whole, before any cut: a rule file that matches a private-data pattern is named but not shown.
    if (!policy.nameable(r.stdout)) { ruleText.set(source, "(withheld: it matches a private-data pattern; read it in the repository)"); return true; }
    const bytes = Buffer.from(r.stdout, "utf8");
    ruleText.set(source, bytes.length > RULE_BYTES ? `${bytes.subarray(0, RULE_BYTES).toString("utf8")}\n[cut at ${RULE_BYTES} bytes]` : r.stdout);
    return true;
  };
  const root = readRule("REVIEW.md");
  const byKey = new Map<string, { sources: string[]; paths: string[] }>();
  for (const file of reviewable) {
    // The rules of every side apply, so a move out of a scoped directory keeps its rule file.
    const scoped = [...new Set([file.oldPath, file.path].flatMap(p => { const r = p ? attrs.get(p)?.rules : undefined; return r ? [r] : []; }))];
    const sources = [...(root ? ["REVIEW.md"] : []), ...scoped.filter(readRule)];
    const key = sources.join("\0");
    (byKey.get(key) ?? byKey.set(key, { sources, paths: [] }).get(key)!).paths.push(file.path);
  }
  // Cross-check with the plain name list (no rename detection), as OCR's list is checked against the PR's.
  const plain = git(cwd, [...attrFrom(mergeBase), "diff", "--relative", "--no-renames", "--name-only", "-z", `${from}...${commit}`, "--"]);
  if (plain.status !== 0 || typeof plain.stdout !== "string") return { unavailable: `the name list of ${head} could not be read` };
  const listed = new Set(shown.flatMap(g => g.paths)), hidden = new Set(groups.filter(g => !shown.includes(g)).flatMap(g => g.paths));
  const unlisted = plain.stdout.split("\0").filter(path => path && !listed.has(path) && !hidden.has(path));
  return { head: commit, base: from, mergeBase, reviewable, excluded, withheld, rules: [...ruleText].map(([source, text]) => ({ source, text })), rulesMissing: [...rulesMissing].map(([source, reason]) => ({ source, reason })), ruleGroups: [...byKey.values()], unlisted };
}

function numstat(cwd: string, head: string, base: string, attrSource: string): Map<string, { insertions: number; deletions: number; binary: boolean }> | undefined {
  const out = new Map<string, { insertions: number; deletions: number; binary: boolean }>();
  const r = git(cwd, [...attrFrom(attrSource), "diff", "--no-ext-diff", "--no-textconv", "--relative", "-M", "-C", "--find-copies-harder", "--numstat", "-z", `${base}...${head}`, "--"]);
  if (r.status !== 0 || typeof r.stdout !== "string") return undefined;
  // -z: "ins\tdel\tpath\0", or for a move "ins\tdel\t\0old\0new\0"; a binary file has "-" counts.
  const fields = r.stdout.split("\0");
  for (let i = 0; i < fields.length - 1;) {
    const [ins = "", del = "", path = ""] = fields[i++]!.split("\t");
    const target = path || (i++, fields[i++] ?? "");
    out.set(target, { insertions: Number(ins) || 0, deletions: Number(del) || 0, binary: ins === "-" });
  }
  return out;
}

function attributes(cwd: string, source: string, paths: string[]): Map<string, { generated?: boolean; rules?: string }> | undefined {
  const out = new Map<string, { generated?: boolean; rules?: string }>();
  if (!paths.length) return out;
  const r = hubGitSync(["-C", cwd, "check-attr", "-z", "--stdin", `--source=${source}`, "linguist-generated", "ahub-review-rules"], { input: paths.join("\0") + "\0", encoding: "utf8", env: childEnv(process.env), maxBuffer: 4 * 1024 * 1024, timeout: 15_000 });
  if (r.status !== 0 || typeof r.stdout !== "string") return undefined;
  const f = r.stdout.split("\0");
  for (let i = 0; i + 2 < f.length; i += 3) {
    const [path, attr, value] = [f[i]!, f[i + 1]!, f[i + 2]!], entry = out.get(path) ?? {};
    if (attr === "linguist-generated" && (value === "set" || value === "true")) entry.generated = true;
    if (attr === "ahub-review-rules" && value !== "unspecified" && value !== "unset" && value !== "set" && !value.startsWith("/") && !value.split("/").includes("..")) entry.rules = value;
    out.set(path, entry);
  }
  return out;
}

import { symbolsOverlap } from "./symbol-normalizer.ts";

/** One plan name against one changed name: a qualified pair must be equal, otherwise the last segments are. Shared with the console's task detail (#684 2b). */
export const planSymbolMatches = (left: string, right: string): boolean => symbolsOverlap(left, right);
/** Project derived names through the host metadata screen before comparing or rendering them. */
export function withCodeSymbols(brief:ReviewBrief,result:CodeFactResult<CodeSymbol[]>,plan:readonly string[]|undefined,publicMetadataText:(text:string)=>boolean):ReviewBrief {
  const unknown={...brief,symbols:{state:"unknown" as const,files:[],planned:[],unplanned:[],unseen:[]}};
  if(result.state!=="known")return unknown;
  try {
    const paths=new Set(brief.reviewable.map(file=>file.path));
    const changed=result.value.filter(s=>!s.ambiguous && paths.has(s.path) && publicMetadataText(s.path) && publicMetadataText(s.name) && publicMetadataText(s.kind));
    const planned=(plan??[]).filter(name=>publicMetadataText(name));
    const matches=planSymbolMatches;
    const names=[...new Set(changed.map(s=>s.name))];
    return {...brief,symbols:{state:"known",complete:changed.length===result.value.length && brief.withheld===0,files:[...paths].map(path=>({path,symbols:changed.filter(s=>s.path===path)})),
      planned:names.filter(name=>planned.some(p=>matches(p,name))),unplanned:names.filter(name=>!planned.some(p=>matches(p,name))),unseen:planned.filter(p=>!names.some(name=>matches(p,name)))}};
  } catch { return unknown; }
}

function renderCodeSymbols(brief:ReviewBrief):string[] {
  const symbols=brief.symbols;
  if(!symbols)return [];
  if(symbols.state === "unknown")return ["Changed symbols: unknown (optional code facts unavailable)."];
  const lines=[
    "Changed symbols (advisory; change: unknown):",
    ...symbols.files.flatMap(file=>file.symbols.length ? file.symbols.map(symbol=>`- ${file.path}: ${symbol.name} (${symbol.kind}, lines ${symbol.line}${symbol.endLine === undefined ? "..unknown" : `..${symbol.endLine}`}; change: unknown)`) : [`- ${file.path}: no changed symbol observed`]),
    `Changed and planned: ${symbols.planned.join(", ") || "none observed"}`,
    `Changed, not planned: ${symbols.unplanned.join(", ") || "none observed"}`,
    `Planned, not seen as changed: ${symbols.unseen.join(", ") || "none observed"}`,
    "Ceiling: ripwire 0.6.7 does not report deleted symbols; these lists never establish plan conformance.",
  ];
  return Buffer.byteLength(lines.join("\n"))<=16000 ? lines : ["Changed symbols: unknown (advice exceeds 16000 bytes)."];
}

/** The brief as review text: what every reviewer reads and how it accounts for its coverage. */
export function renderReviewBrief(brief: ReviewBrief): string {
  const file = (f: BriefFile) => `- ${f.oldPath ? `${f.oldPath} -> ` : ""}${f.path} (${f.status}${f.insertions !== undefined ? `, +${f.insertions} -${f.deletions}` : ""})`;
  return [
    `Review brief: head ${brief.head} against ${brief.base} (merge base ${brief.mergeBase.slice(0, 12)}); ${brief.reviewable.length} reviewable, ${brief.excluded.length} excluded${brief.withheld ? `, ${brief.withheld} withheld by the privacy policy` : ""}.`,
    ...(brief.reviewable.length ? ["Reviewable:", ...brief.reviewable.map(file)] : ["Reviewable: none (record why in the note)."]),
    ...(brief.excluded.length ? ["Excluded (still read their diff when it matters):", ...brief.excluded.map(e => `- ${e.oldPath ? `${e.oldPath} -> ` : ""}${e.path} (${e.status}): ${e.reason}`)] : []),
    ...renderCodeSymbols(brief),
    ...(brief.unlisted.length ? ["Not in the brief's list, read directly:", ...brief.unlisted.map(path => `- ${path}`)] : []),
    ...brief.ruleGroups.filter(g => g.sources.length).map(g => `Rules ${g.sources.join(" + ")} apply to: ${brief.ruleGroups.length === 1 ? "every reviewable file" : g.paths.join(", ")}`),
    ...(brief.rulesMissing.length ? ["Configured rules not loaded (read them in the repository):", ...brief.rulesMissing.map(m => `- ${m.source}: ${m.reason}`)] : []),
    ...brief.rules.map(r => `--- ${r.source} ---\n${r.text.trimEnd()}`),
    `Coverage: pass hub_review coverage {reviewed: [paths], skipped: [{path, reason}]} naming every reviewable path above.`,
  ].join("\n");
}

/** The reviewable paths a verdict's coverage does not account for: reviewed, or skipped with a reason. */
export function coverageGap(brief: ReviewBrief, coverage: unknown): string[] {
  const c = coverage && typeof coverage === "object" && !Array.isArray(coverage) ? coverage as { reviewed?: unknown; skipped?: unknown } : {};
  const accounted = new Set<string>([
    ...(Array.isArray(c.reviewed) ? c.reviewed.filter((p): p is string => typeof p === "string") : []),
    ...(Array.isArray(c.skipped) ? c.skipped.flatMap(s => s && typeof s === "object" && typeof (s as { path?: unknown }).path === "string" && typeof (s as { reason?: unknown }).reason === "string" && (s as { reason: string }).reason.trim() ? [(s as { path: string }).path] : []) : []),
  ]);
  return brief.reviewable.map(f => f.path).filter(path => !accounted.has(path));
}
