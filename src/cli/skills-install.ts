/**
 * Hub skills for the agent hosts other than Claude Code (#1622).
 *
 * The Claude plugin carries the skills itself; every other host reads its own user skill directory, so `ahub setup`
 * writes one tree per skill there. Each tree carries an `.ahub-skill.json` marker and is replaced only while it still
 * holds exactly the digest the hub wrote. A tree the person edited, a tree another tool installed and a link are
 * reported and left alone; `ahub setup --undo` removes only the hub's own unmodified trees. Other skills in the same
 * host directory are never read, written or reported.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { hostSkillDir, SKILL_HOSTS, type SkillHost } from "../adapters/definitions/native-cli-skills.ts";
import { realPath } from "../hub/project.ts";
import { VERSION } from "../version.ts";

export { hostSkillDir, SKILL_HOSTS, type SkillHost };

export const SKILL_MARKER = ".ahub-skill.json";
export const SKILL_TOOL = "agent-hub";

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_FILES = 256;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TREE_BYTES = 8 * 1024 * 1024;

export class SkillsInstallError extends Error {}

interface TreeFile { path: string; bytes: Buffer }
interface Tree { files: TreeFile[]; digest: string }
interface Marker { tool: string; version: string; sha256: string }
interface SourceSkill { name: string; tree: Tree }

export type SkillAction =
  | "install" | "replace" | "unchanged"          // a run that writes
  | "modified" | "foreign" | "linked" | "failed"  // a tree the hub does not own or cannot read
  | "absent" | "missing"                          // no host on this machine, or no tree where the host is installed
  | "remove" | "removed";                         // the undo path

export interface SkillEntry {
  host: SkillHost;
  /** The skill directory name; empty for a host-level entry (no host, no directory). */
  skill: string;
  dir: string;
  action: SkillAction;
  detail: string;
}

export type SkillState = "installed" | "stale" | "modified" | "foreign" | "linked" | "missing" | "absent" | "failed";
export interface SkillHostState {
  host: SkillHost;
  /** The host's skills directory (the parent of the installed trees). */
  dir: string;
  state: SkillState;
  detail: string;
}

export interface SkillPaths {
  home?: string;
  env?: NodeJS.ProcessEnv;
}

function digest(files: TreeFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(createHash("sha256").update(file.bytes).digest("hex"));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function lstat(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); } catch { return undefined; }
}

/** Read one skill tree: regular files only, no link followed, bounded count and size. */
function readTree(dir: string): Tree {
  let root: ReturnType<typeof lstatSync>;
  try { root = lstatSync(dir); } catch (error) {
    throw new SkillsInstallError(`cannot read ${dir}: ${(error as Error).message}`);
  }
  if (root.isSymbolicLink()) throw new SkillsInstallError(`refused a link: ${dir}`);
  if (!root.isDirectory()) throw new SkillsInstallError(`not a directory: ${dir}`);
  const files: TreeFile[] = [];
  let total = 0;
  const walk = (abs: string, rel: string): void => {
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) throw new SkillsInstallError(`refused a link: ${abs}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        if (name === SKILL_MARKER) continue;
        walk(join(abs, name), rel ? `${rel}/${name}` : name);
      }
      return;
    }
    if (!stat.isFile()) throw new SkillsInstallError(`not a regular file: ${abs}`);
    if (stat.size > MAX_FILE_BYTES) throw new SkillsInstallError(`file too large (limit ${MAX_FILE_BYTES} bytes): ${abs}`);
    if (files.length >= MAX_FILES) throw new SkillsInstallError(`too many files under ${dir} (limit ${MAX_FILES})`);
    total += stat.size;
    if (total > MAX_TREE_BYTES) throw new SkillsInstallError(`tree too large under ${dir} (limit ${MAX_TREE_BYTES} bytes)`);
    files.push({ path: rel, bytes: readFileSync(abs) });
  };
  walk(dir, "");
  return { files, digest: digest(files) };
}

function readSource(source: string): SourceSkill[] {
  const root = lstat(source);
  if (!root) throw new SkillsInstallError(`cannot read the hub skill source ${source}`);
  if (root.isSymbolicLink() || !root.isDirectory()) throw new SkillsInstallError(`the hub skill source is not a directory: ${source}`);
  const skills: SourceSkill[] = [];
  for (const name of readdirSync(source).sort()) {
    if (name.startsWith(".")) continue;
    const abs = join(source, name);
    const stat = lstat(abs);
    if (!stat) throw new SkillsInstallError(`cannot read ${abs}`);
    if (stat.isSymbolicLink()) throw new SkillsInstallError(`refused a link in the hub skill source: ${abs}`);
    if (!stat.isDirectory()) continue;
    if (!SKILL_NAME.test(name)) throw new SkillsInstallError(`not a usable skill name: ${name}`);
    skills.push({ name, tree: readTree(abs) });
  }
  if (!skills.length) throw new SkillsInstallError(`no skills under ${source}`);
  return skills;
}

function readMarker(dir: string): Marker | "missing" | "foreign" {
  let text: string;
  try { text = readFileSync(join(dir, SKILL_MARKER), "utf8"); } catch { return "missing"; }
  try {
    const value = JSON.parse(text) as Partial<Marker>;
    if (value.tool === SKILL_TOOL && typeof value.version === "string" && typeof value.sha256 === "string") {
      return { tool: value.tool, version: value.version, sha256: value.sha256 };
    }
  } catch { /* a malformed marker is not the hub's */ }
  return "foreign";
}

/**
 * Resolve the host's config home and skill directory without following a link in the skill trees. A symlinked config
 * home is the host's own choice and is resolved with `realPath`; a symlinked skills directory is refused.
 */
function locate(host: SkillHost, paths: SkillPaths): { dir: string } | { action: "absent" | "failed" | "linked" | "foreign"; dir: string; detail: string } {
  const lexical = hostSkillDir(host, paths.home ?? homedir(), paths.env ?? process.env);
  const configHome = dirname(lexical);
  const config = lstat(configHome);
  if (!config) return { action: "absent", dir: lexical, detail: `host not installed: no ${configHome}` };
  if (!config.isSymbolicLink() && !config.isDirectory()) return { action: "failed", dir: lexical, detail: `${configHome} is not a directory` };
  let resolved: string;
  try { resolved = realPath(configHome); } catch (error) { return { action: "failed", dir: lexical, detail: `${configHome}: ${(error as Error).message}` }; }
  // The config home link is the host's own choice and has been resolved above; a linked skills directory is not.
  const dir = join(resolved, "skills");
  const stat = lstat(dir);
  if (stat?.isSymbolicLink()) return { action: "linked", dir, detail: "the skills directory is a link; left untouched" };
  if (stat && !stat.isDirectory()) return { action: "foreign", dir, detail: "the skills path is not a directory; left untouched" };
  return { dir };
}

/** What one skill tree would become, without writing anything. */
function inspectSkill(host: SkillHost, skill: SourceSkill, base: string): SkillEntry {
  const dir = join(base, skill.name);
  const entry = (action: SkillAction, detail: string): SkillEntry => ({ host, skill: skill.name, dir, action, detail });
  const stat = lstat(dir);
  if (!stat) return entry("install", "not installed");
  if (stat.isSymbolicLink()) return entry("linked", "the skill directory is a link; left untouched");
  if (!stat.isDirectory()) return entry("foreign", "not a directory; left untouched");
  const marker = readMarker(dir);
  if (marker === "missing") return entry("foreign", `no ${SKILL_MARKER}; left untouched`);
  if (marker === "foreign") return entry("foreign", `${SKILL_MARKER} is not the hub's; left untouched`);
  let installed: Tree;
  try { installed = readTree(dir); } catch (error) { return entry("failed", (error as Error).message); }
  if (installed.digest !== marker.sha256) return entry("modified", "edited since the hub wrote it; left untouched");
  if (marker.version !== VERSION) return entry("replace", `stale ${marker.version} -> ${VERSION}`);
  if (installed.digest !== skill.tree.digest) return entry("replace", "the hub's files changed at the same version");
  return entry("unchanged", VERSION);
}

/** Plan the install for every host, from a source tree in this package. Throws when the source is unreadable. */
export function skillInstallPlan(source: string, paths: SkillPaths = {}): SkillEntry[] {
  const skills = readSource(source);
  const plan: SkillEntry[] = [];
  for (const host of SKILL_HOSTS) {
    const found = locate(host, paths);
    if ("action" in found) { plan.push({ host, skill: "", dir: found.dir, action: found.action, detail: found.detail }); continue; }
    for (const skill of skills) plan.push(inspectSkill(host, skill, found.dir));
  }
  return plan;
}

/** Plan the undo: only a tree the hub wrote and nobody edited is marked for removal. Other skills are not listed. */
export function skillUndoPlan(paths: SkillPaths = {}): SkillEntry[] {
  const plan: SkillEntry[] = [];
  for (const host of SKILL_HOSTS) {
    const found = locate(host, paths);
    if ("action" in found) { plan.push({ host, skill: "", dir: found.dir, action: found.action, detail: found.detail }); continue; }
    const stat = lstat(found.dir);
    if (!stat) { plan.push({ host, skill: "", dir: found.dir, action: "absent", detail: "not installed" }); continue; }
    if (stat.isSymbolicLink()) { plan.push({ host, skill: "", dir: found.dir, action: "linked", detail: "the skill directory is a link; left untouched" }); continue; }
    if (!stat.isDirectory()) { plan.push({ host, skill: "", dir: found.dir, action: "foreign", detail: "not a directory; left untouched" }); continue; }
    let names: string[];
    try { names = readdirSync(found.dir).sort(); } catch (error) { plan.push({ host, skill: "", dir: found.dir, action: "failed", detail: (error as Error).message }); continue; }
    let seen = 0;
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const dir = join(found.dir, name);
      const child = lstat(dir);
      if (!child || child.isSymbolicLink() || !child.isDirectory()) continue;
      const marker = readMarker(dir);
      if (marker === "missing" || marker === "foreign") continue; // another tool's skill is not the hub's
      seen += 1;
      let installed: Tree;
      try { installed = readTree(dir); } catch (error) { plan.push({ host, skill: name, dir, action: "failed", detail: (error as Error).message }); continue; }
      if (installed.digest !== marker.sha256) { plan.push({ host, skill: name, dir, action: "modified", detail: "edited since the hub wrote it; left untouched" }); continue; }
      plan.push({ host, skill: name, dir, action: "remove", detail: `the hub's ${marker.version} tree` });
    }
    if (!seen) plan.push({ host, skill: "", dir: found.dir, action: "absent", detail: "no hub skill tree" });
  }
  return plan;
}

/** Write one tree beside its target and rename it into place; the marker lands with the files, never before them. */
function writeTree(target: string, tree: Tree): void {
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o755 });
  const temp = `${target}.ahub-tmp-${process.pid}-${randomUUID()}`;
  let previous: string | undefined;
  try {
    mkdirSync(temp, { mode: 0o755 });
    for (const file of tree.files) {
      const dest = join(temp, ...file.path.split("/"));
      mkdirSync(dirname(dest), { recursive: true, mode: 0o755 });
      writeFileSync(dest, file.bytes, { flag: "wx", mode: 0o644 });
    }
    const marker = JSON.stringify({ tool: SKILL_TOOL, version: VERSION, sha256: tree.digest }, null, 2) + "\n";
    writeFileSync(join(temp, SKILL_MARKER), marker, { flag: "wx", mode: 0o644 });
    if (lstat(target)) {
      previous = `${target}.ahub-old-${process.pid}-${randomUUID()}`;
      renameSync(target, previous);
    }
    try { renameSync(temp, target); }
    catch (error) {
      if (previous) {
        try { renameSync(previous, target); } catch { /* the old tree keeps its temporary name and is named in the error */ }
      }
      throw error;
    }
    if (previous) rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

/** True when the directory a tree lives in became a link after the plan; writing through it would land outside. */
function hostDirLinked(dir: string): boolean {
  return lstat(dirname(dir))?.isSymbolicLink() ?? false;
}

/** Apply the entries that write. A host that cannot be written is reported, never thrown, so other hosts still install. */
export function applySkillPlan(source: string, plan: SkillEntry[]): SkillEntry[] {
  const skills = new Map(readSource(source).map(skill => [skill.name, skill]));
  return plan.map(entry => {
    if (entry.action !== "install" && entry.action !== "replace") return entry;
    const skill = skills.get(entry.skill);
    if (!skill) return { ...entry, action: "failed", detail: `no source for ${entry.skill}` };
    // The plan was made before the question; a tree or a skills directory that changed while it was open is kept.
    if (hostDirLinked(entry.dir)) return { ...entry, action: "linked", detail: "the skills directory became a link; left untouched" };
    const fresh = inspectSkill(entry.host, skill, dirname(entry.dir));
    if (fresh.action === "unchanged") return fresh;
    if (fresh.action !== "install" && fresh.action !== "replace") {
      return { ...fresh, detail: `${fresh.detail} (changed since the plan; left untouched)` };
    }
    try { writeTree(entry.dir, skill.tree); return { ...entry, detail: entry.action === "replace" ? entry.detail : VERSION }; }
    catch (error) { return { ...entry, action: "failed", detail: (error as Error).message }; }
  });
}

/** Apply the undo. The marker and digest are checked again here, so a tree edited after the plan is not removed. */
export function applySkillUndo(plan: SkillEntry[]): SkillEntry[] {
  return plan.map(entry => {
    if (entry.action !== "remove") return entry;
    if (hostDirLinked(entry.dir)) return { ...entry, action: "linked", detail: "the skills directory became a link; left untouched" };
    const stat = lstat(entry.dir);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return { ...entry, action: "foreign", detail: "changed since the plan; left untouched" };
    const marker = readMarker(entry.dir);
    if (marker === "missing" || marker === "foreign") return { ...entry, action: "foreign", detail: "changed since the plan; left untouched" };
    let installed: Tree;
    try { installed = readTree(entry.dir); } catch (error) { return { ...entry, action: "failed", detail: (error as Error).message }; }
    if (installed.digest !== marker.sha256) return { ...entry, action: "modified", detail: "edited since the plan; left untouched" };
    try { rmSync(entry.dir, { recursive: true, force: false }); return { ...entry, action: "removed", detail: entry.detail }; }
    catch (error) { return { ...entry, action: "failed", detail: (error as Error).message }; }
  });
}

function skillState(dir: string): { state: SkillState; detail: string } {
  const stat = lstat(dir);
  if (!stat) return { state: "missing", detail: "not installed" };
  if (stat.isSymbolicLink()) return { state: "linked", detail: "the skill directory is a link" };
  if (!stat.isDirectory()) return { state: "foreign", detail: "not a directory" };
  const marker = readMarker(dir);
  if (marker === "missing") return { state: "foreign", detail: `no ${SKILL_MARKER}` };
  if (marker === "foreign") return { state: "foreign", detail: `${SKILL_MARKER} is not the hub's` };
  let installed: Tree;
  try { installed = readTree(dir); } catch (error) { return { state: "failed", detail: (error as Error).message }; }
  if (installed.digest !== marker.sha256) return { state: "modified", detail: "edited since the hub wrote it" };
  if (marker.version !== VERSION) return { state: "stale", detail: `${marker.version} -> ${VERSION}` };
  return { state: "installed", detail: VERSION };
}

const STATE_ORDER: readonly SkillState[] = ["failed", "linked", "foreign", "modified", "stale", "missing", "installed"];

/**
 * What the doctor reads: one state per host, without writing anything. `expected` names the skills this package ships,
 * so a tree the hub wrote and no longer ships is not read as a missing skill.
 */
export function skillHostStates(paths: SkillPaths, expected: readonly string[]): SkillHostState[] {
  return SKILL_HOSTS.map(host => {
    const found = locate(host, paths);
    if ("action" in found) return { host, dir: found.dir, state: found.action, detail: found.detail };
    const stat = lstat(found.dir);
    if (!stat) return { host, dir: found.dir, state: "missing", detail: "not installed" };
    if (stat.isSymbolicLink()) return { host, dir: found.dir, state: "linked", detail: "the skills directory is a link" };
    if (!stat.isDirectory()) return { host, dir: found.dir, state: "foreign", detail: "not a directory" };
    const problems = [...expected].map(name => ({ name, ...skillState(join(found.dir, name)) })).filter(item => item.state !== "installed");
    const state = STATE_ORDER.find(candidate => problems.some(problem => problem.state === candidate)) ?? "installed";
    return {
      host, dir: found.dir, state,
      detail: problems.length ? problems.map(problem => `${problem.name} ${problem.state}`).join(", ") : `${expected.length} installed`,
    };
  });
}

/** One doctor row for every selected host. `undefined` is a warning: a tree the hub will not touch is not a failure. */
export function skillStateRow(states: SkillHostState[]): { ok: boolean | undefined; detail: string } {
  const selected = states.filter(state => state.state !== "absent");
  if (!selected.length) return { ok: true, detail: "no other agent host installed on this machine" };
  const needsSetup = selected.some(state => state.state === "missing" || state.state === "stale" || state.state === "failed");
  const warning = selected.some(state => state.state === "modified" || state.state === "foreign" || state.state === "linked");
  return {
    ok: needsSetup ? false : warning ? undefined : true,
    detail: selected.map(state => `${state.host} ${state.state}`).join("; "),
  };
}

export interface SkillInstallOptions extends SkillPaths {
  /** The package's skill directory. Required for an install, unused by `undo`. */
  source?: string;
  undo?: boolean;
  yes: boolean;
  ask?: (prompt: string) => Promise<string | null>;
  print: (line: string) => void;
}

function hostEntries(plan: SkillEntry[], host: SkillHost): SkillEntry[] {
  return plan.filter(entry => entry.host === host);
}

function absentLine(entry: SkillEntry): string {
  if (entry.action === "absent") return `${entry.host} not installed (${entry.detail})`;
  if (entry.action === "linked") return `${entry.host} link; left untouched (${entry.dir})`;
  if (entry.action === "foreign") return `${entry.host} foreign tree; left untouched (${entry.dir})`;
  return `${entry.host} cannot be read: ${entry.detail}`;
}

function skillNames(entries: SkillEntry[], actions: readonly SkillAction[]): string {
  const names = entries.filter(entry => entry.skill && actions.includes(entry.action)).map(entry => entry.skill);
  return names.length ? ` (${names.join(", ")} left untouched)` : "";
}

function hostSummary(entries: SkillEntry[], done: boolean, undo: boolean): string {
  const count = (action: SkillAction) => entries.filter(entry => entry.action === action).length;
  const parts: string[] = [];
  const push = (n: number, text: string) => { if (n) parts.push(text); };
  if (undo) {
    push(count("remove"), `${count("remove")} would remove`);
    push(count("removed"), `${count("removed")} removed`);
  } else if (done) {
    push(count("install"), `${count("install")} installed`);
    push(count("replace"), `${count("replace")} replaced`);
  } else {
    push(count("install"), `${count("install")} would install`);
    push(count("replace"), `${count("replace")} would replace`);
  }
  push(count("unchanged"), `${count("unchanged")} up to date`);
  push(count("modified"), `${count("modified")} modified`);
  push(count("foreign"), `${count("foreign")} foreign`);
  push(count("linked"), `${count("linked")} linked`);
  push(count("failed"), `${count("failed")} unreadable`);
  return parts.join(", ") || "nothing to do";
}

function printHosts(plan: SkillEntry[], options: SkillInstallOptions, done: boolean, undo: boolean): void {
  for (const host of SKILL_HOSTS) {
    const entries = hostEntries(plan, host);
    const hostLevel = entries.find(entry => !entry.skill);
    if (hostLevel) { options.print(`hub skills: ${absentLine(hostLevel)}`); continue; }
    const left = skillNames(entries, ["modified", "foreign", "linked"]);
    options.print(`hub skills: ${host} ${hostSummary(entries, done, undo)}${left}`);
  }
}

async function confirm(options: SkillInstallOptions, prompt: string): Promise<boolean> {
  if (options.yes) return true;
  if (!options.ask) return false;
  const answer = await options.ask(prompt);
  return typeof answer === "string" && /^y(es)?$/i.test(answer.trim());
}

function tally(entries: SkillEntry[], action: SkillAction): number {
  return entries.filter(entry => entry.action === action).length;
}

function finishLine(entries: SkillEntry[]): string {
  const installed = tally(entries, "install"), replaced = tally(entries, "replace"), removed = tally(entries, "removed"), failed = tally(entries, "failed");
  const changed = installed + replaced + removed;
  return `hub skills: ${installed} installed, ${replaced} replaced, ${removed} removed, ${failed} failed, ${entries.length - changed - failed} left`;
}

/**
 * `ahub setup`'s skill step: print what would happen, ask once (unless `--yes`), then write or remove. Everything the
 * hub does not own is reported and left alone. Never throws for a missing source: setup reports it and keeps going.
 */
export async function installHubSkills(options: SkillInstallOptions): Promise<void> {
  if (options.undo) {
    const plan = skillUndoPlan(options);
    printHosts(plan, options, false, true);
    const removable = plan.filter(entry => entry.action === "remove");
    if (!removable.length) { options.print("hub skills: nothing to remove"); return; }
    if (!(await confirm(options, `Remove ${removable.length} hub skill ${removable.length === 1 ? "tree" : "trees"}? [y/N] `))) {
      options.print("hub skills: nothing removed; rerun with --yes");
      return;
    }
    const done = applySkillUndo(plan);
    printHosts(done, options, true, true);
    options.print(finishLine(done));
    return;
  }
  if (!options.source) throw new SkillsInstallError("the hub skill source directory is missing");
  let plan: SkillEntry[];
  try { plan = skillInstallPlan(options.source, options); }
  catch (error) {
    options.print(`hub skills: skipped (${(error as Error).message})`);
    return;
  }
  printHosts(plan, options, false, false);
  const writable = plan.filter(entry => entry.action === "install" || entry.action === "replace");
  if (!writable.length) { options.print("hub skills: up to date; nothing written"); return; }
  const hosts = [...new Set(writable.map(entry => entry.host))];
  if (!(await confirm(options, `Install hub skills for ${hosts.join(", ")}? [y/N] `))) {
    options.print("hub skills: nothing written; rerun with --yes");
    return;
  }
  let done: SkillEntry[];
  try { done = applySkillPlan(options.source, plan); }
  catch (error) {
    options.print(`hub skills: write failed (${(error as Error).message})`);
    return;
  }
  printHosts(done, options, true, false);
  options.print(finishLine(done));
}
