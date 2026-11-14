import { randomUUID } from "node:crypto";
import { initShadow, repoOf } from "../hub/snapshots.ts";
import { PROFILE_NAMES, profileName, projectProfile, resolveProfile, mergeProfileOverrides, type ProfileName } from "../hub/profiles.ts";
import { canonicalJson, loadPacks, packOverrides, type DomainPack } from "../hub/packs.ts";
import { JCODE_MCP_FILE } from "./jcode-mcp.ts";
import { closeSync, constants, fstatSync, openSync, readSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, readFileSync, statSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { Stats } from "node:fs";
import { realPath } from "../hub/project.ts";
import { hubGitArgv, hubGitEnv, hubGitSync } from "../hub/git.ts";
import { KIMI_MCP_FILE } from "./kimi-mcp.ts";
import { AGY_PLUGIN_FILES } from "./agy-mcp.ts";
import { DEFAULT_CONFIG, loadConfig } from "../hub/daemon.ts";
import { ALL_MACHINE_LOCAL } from "../hub/config-trust.ts";
import { requiredChecksFor } from "../hub/sdlc-merge.ts";
import { githubOriginRepository } from "../hub/task-repository.ts";
import { loadSdlc, sdlcConfig } from "../hub/sdlc.ts";
import { VERSION } from "../version.ts";
import { roleSummaryLines } from "./init-roles.ts";
import { planInitSettings, TRACK_CONFIG, type InitSettingFile, type InitSettingRow, type InitSettingsRequest } from "./init-settings.ts";

const TEMPLATES = join(import.meta.dir, "..", "..", "templates");
const BEGIN = "<!-- AGENT_HUB:BEGIN (managed by `ahub init`, edits inside are overwritten) -->";
const END = "<!-- AGENT_HUB:END -->";

/** Insert or replace the managed block. Idempotent: text outside the markers is never touched. */
export function upsertBlock(existing: string, block: string): string {
  const managed = `${BEGIN}\n${block.trim()}\n${END}`;
  const start = existing.indexOf("<!-- AGENT_HUB:BEGIN");
  const end = existing.indexOf(END, Math.max(start, 0));
  if (start !== -1 && end > start) return existing.slice(0, start) + managed + existing.slice(end + END.length);
  return `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${managed}\n`;
}

/** Drop the managed block and the blank lines around it. Text without a complete block is returned as is. */
export function removeBlock(existing: string): string {
  const start = existing.indexOf("<!-- AGENT_HUB:BEGIN");
  const end = existing.indexOf(END, Math.max(start, 0));
  if (start === -1 || end <= start) return existing;
  const rest = [existing.slice(0, start).trimEnd(), existing.slice(end + END.length).trim()].filter(Boolean).join("\n\n");
  return rest && `${rest}\n`;
}

/** #1411: the files a repository either commits (the team shares roles and defaults) or keeps per checkout. */
const SHARED_CONFIG = ["config.json", "routing.toml", "sdlc.toml"] as const;
/** #1411: the managed block's role sentence, one per choice. The tracked one is the template's own text. */
export const ROLES_TRACKED = "`.agenthub/config.json` `roles` says who plans, implements, verifies and reviews.";
export const ROLES_UNTRACKED = "Roles are held by this checkout's hub, not by a file in the repository: `ahub roles` prints who plans, implements, verifies, reviews and conducts; your own roles are in your session instructions.";

/**
 * #1411: git's own verdict on whether its ignore rules (the repository's, `.git/info/exclude` and the person's global file) ignore `path`, tracked or not: the rule as
 * `source:line:pattern`, `null` when no rule ignores it, `undefined` when git cannot say (no repository). `-v` also reports a `!` rule that re-includes the path, with
 * exit 0, so the pattern decides.
 */
export function ignoreRule(cwd: string, path: string): string | null | undefined {
  const r = hubGitSync(["check-ignore", "-v", "-z", "--no-index", "--stdin"], { cwd, encoding: "utf8", timeout: 3000, input: `${path}\0` });
  if (r.status === 1) return null;
  if (r.status !== 0) return undefined;
  const [source, line, pattern] = r.stdout.split("\0");
  return pattern === undefined || pattern.startsWith("!") ? null : `${source}:${line}:${pattern}`;
}
const SHARED_IGNORE_BEGIN = "# agent-hub shared config (managed by ahub init)";
const SHARED_IGNORE_END = "# end agent-hub shared config";
/** Remove only the complete block init owns, preserving every other project rule. */
function withoutSharedIgnoreBlock(text: string): string {
  const lines = text.split("\n"), start = lines.indexOf(SHARED_IGNORE_BEGIN), end = lines.indexOf(SHARED_IGNORE_END, start);
  if (start < 0 || end < start) return text;
  lines.splice(start, end - start + 1);
  return lines.join("\n");
}
/** Git evaluates planned project rules in a disposable worktree; the real index/config are never written. */
function verifySharedIgnores(cwd: string, text: string, tracked: readonly string[]): void {
  const git = hubGitSync(["rev-parse", "--absolute-git-dir", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 3000 });
  if (git.status !== 0) throw new Error("--track-config: git could not locate the repository for ignore verification; run git status and retry ahub init; nothing was written");
  const [gitDir, root] = git.stdout.trim().split("\n");
  if (!gitDir || !root || realPath(root) !== realPath(cwd)) throw new Error("--track-config: ignore preview requires the project repository root; run ahub init from git rev-parse --show-toplevel; nothing was written");
  const excludes = hubGitSync(["config", "--path", "--get", "core.excludesFile"], { cwd, encoding: "utf8", timeout: 3000 });
  if (excludes.status !== 0 && excludes.status !== 1) throw new Error("--track-config: git could not read the excludes-file setting; run git config --get core.excludesFile and retry ahub init; nothing was written");
  const excludeArgs = excludes.status === 0 ? ["-c", `core.excludesFile=${resolve(cwd, excludes.stdout.trim())}`] : [];
  let scratch: string | undefined;
  try {
    scratch = mkdtempSync(join(tmpdir(), "ahub-init-ignore-"));
    scratch = realPath(scratch);
    writeFileSync(join(scratch, ".gitignore"), text);
    mkdirSync(join(scratch, ".agenthub"));
    const nested = join(cwd, ".agenthub", ".gitignore");
    if (existsSync(nested)) writeFileSync(join(scratch, ".agenthub", ".gitignore"), readFileSync(nested, "utf8"));
    const protectedPaths = [".agenthub/state/", ".agenthub/config.local.json", ".agenthub/routing.local.toml", ...SHARED_CONFIG.filter(name => !tracked.includes(name)).map(name => `.agenthub/${name}`)];
    for (const path of [...tracked.map(name => `.agenthub/${name}`), ...protectedPaths]) {
      const verdict = hubGitSync([...excludeArgs, `--git-dir=${gitDir}`, `--work-tree=${scratch}`, "check-ignore", "-v", "-z", "--no-index", "--stdin"], { cwd: scratch, encoding: "utf8", timeout: 3000, input: `${path}\0` });
      if (verdict.status !== 0 && verdict.status !== 1) throw new Error("git could not evaluate the planned ignore rules; run git status and retry ahub init");
      const [source, line, pattern] = verdict.stdout.split("\0");
      const ignored = verdict.status === 0 && pattern !== undefined && !pattern.startsWith("!");
      if (tracked.includes(path.slice(".agenthub/".length)) ? ignored : !ignored)
        throw new Error(`${path} ${ignored ? `is ignored by ${source}:${line}:${pattern}` : "would be exposed by the planned rules"}; change the project ignore rule and retry ahub init`);
    }
  } catch (error) {
    // File/read errors may contain private paths; only git verdicts above expose the existing rule location.
    if (error instanceof Error && (error.message.startsWith(".agenthub/") || error.message.startsWith("git could not"))) throw new Error(`--track-config: ${error.message}; nothing was written`);
    throw new Error("--track-config: could not prepare the disposable ignore preview; check temporary-directory and project ignore-file permissions, then retry ahub init; nothing was written");
  } finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}
/** #1411 (owner comment): `hub_routes` keys that name this machine's endpoints; routing.local.toml cannot hold them yet, so a routing.toml that sets one stays untracked. */
function routingMachineKeys(cwd: string): string[] {
  const path = join(cwd, ".agenthub", "routing.toml");
  if (!existsSync(path)) return [];
  let routes: unknown;
  try { routes = (Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>).hub_routes; } catch { return []; } // the routing loader reports a bad file itself
  if (!routes || typeof routes !== "object") return [];
  return Object.entries(routes as Record<string, unknown>).filter(([, route]) => route && typeof route === "object" && Object.hasOwn(route, "adec_endpoint")).map(([id]) => `hub_routes."${id}".adec_endpoint`);
}
/** #1411: machine-local fields a committed config.json would set; the loader ignores them there, so they belong in config.local.json. */
function personalValues(cwd: string): string[] {
  const path = join(cwd, ".agenthub", "config.json");
  if (!existsSync(path)) return [];
  let file: unknown;
  try { file = JSON.parse(readFileSync(path, "utf8")); } catch { return []; }
  const at = (doc: unknown, key: string) => key.split(".").reduce<unknown>((node, part) => node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined, doc);
  const empty = (value: unknown) => value === undefined || value === null || value === "" || Array.isArray(value) && !value.length;
  return ALL_MACHINE_LOCAL.filter(key => !empty(at(file, key)) && JSON.stringify(at(file, key)) !== JSON.stringify(at(DEFAULT_CONFIG, key)));
}
/** #1411: whether the block should say the config is tracked. A choice wins; without one an existing block keeps its sentence (AC2), and a new block follows what git says today. */
function rolesTracked(cwd: string, existing: string, settings: InitSettingsRequest | undefined): boolean {
  const choice = settings?.values[TRACK_CONFIG];
  if (typeof choice === "boolean") return choice;
  if (existing.includes(ROLES_UNTRACKED)) return false;
  if (existing.includes("<!-- AGENT_HUB:BEGIN")) return true;
  return !ignoreRule(cwd, ".agenthub/config.json");
}

/**
 * #1411 T2: doctor's `shared config` row. Whether `.agenthub/config.json` is committed agrees with the managed block's role sentence: `ok` true for both deliberate
 * states, `undefined` (a warning) for a mismatch or a git state it cannot read, with the command that fixes it; `null` when there is no block sentence or no config to compare.
 */
export function sharedConfigRow(cwd: string): { ok: true | undefined; detail: string } | null {
  const agents = join(cwd, "AGENTS.md"), file = ".agenthub/config.json";
  if (!existsSync(agents) || !existsSync(join(cwd, file))) return null;
  const block = readFileSync(agents, "utf8");
  const saysTracked = block.includes(ROLES_TRACKED), saysUntracked = block.includes(ROLES_UNTRACKED);
  if (saysTracked === saysUntracked) return null; // no managed sentence (an older block): the hub instructions row says to refresh it
  const listed = hubGitSync(["ls-files", "--error-unmatch", "--", file], { cwd, encoding: "utf8", timeout: 3000 }).status;
  const rule = ignoreRule(cwd, file);
  if (listed !== 0 && listed !== 1 || rule === undefined) return { ok: undefined, detail: `git could not say whether ${file} is committed; check with: cd ${cwd} && git ls-files ${file}` };
  const committed = listed === 0, toUntracked = `cd ${cwd} && ahub init --no-track-config --yes`;
  if (saysUntracked) return committed
    ? { ok: undefined, detail: `the AGENTS block says roles are per checkout, but ${file} is committed; share it: cd ${cwd} && ahub init --track-config --yes; or stop tracking it: cd ${cwd} && git rm --cached ${file}, then commit` }
    : { ok: true, detail: "untracked (by choice): each checkout holds its own roles; ahub roles prints them" };
  if (!committed) return { ok: undefined, detail: rule
    ? `the AGENTS block points at ${file}, which ${rule} ignores; keep it per checkout: ${toUntracked}; or remove that rule and commit the file`
    : `the AGENTS block points at ${file}, which is not committed; commit it: cd ${cwd} && git add ${file} && git commit; or keep it per checkout: ${toUntracked}` };
  return rule
    ? { ok: undefined, detail: `${file} is committed but ${rule} ignores it, so a re-added copy is skipped; remove that rule, or stop tracking it: ${toUntracked} && git rm --cached ${file}` }
    : { ok: true, detail: `tracked: ${file} is committed and the AGENTS block points at it` };
}

export interface InitChange {
  action: "create" | "modify" | "delete";
  path: string;
  reason: string;
  managedBlock?: "insert" | "replace" | "remove";
}
/** Content is internal to apply, never included in a public preview. */
interface PlannedWrite extends InitChange { privateFile?: true; next?: string; shadow?: true; directory?: true; executable?: true; moveFrom?: string; expected?: { dev: number; ino: number }; }
const RELEASE_BEGIN = "<!-- AGENT_HUB_RELEASE_GUARD:BEGIN (managed by `ahub init --release-guard`) -->";
const RELEASE_END = "<!-- AGENT_HUB_RELEASE_GUARD:END -->";
const HOOK_MARKER = "# agent-hub managed release pre-push guard";
const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";

function releaseBlock(existing: string): string {
  const block = `${RELEASE_BEGIN}\n${readFileSync(join(TEMPLATES, "release-guard.block.md"), "utf8").trim()}\n${RELEASE_END}`;
  const start = existing.indexOf("<!-- AGENT_HUB_RELEASE_GUARD:BEGIN"), end = existing.indexOf(RELEASE_END, Math.max(start, 0));
  if (start >= 0 && end > start) return existing.slice(0, start) + block + existing.slice(end + RELEASE_END.length);
  if (start >= 0 || existing.includes(RELEASE_END)) throw new Error("release guard instruction markers are incomplete");
  return `${existing.trimEnd()}\n\n${block}\n`;
}
const SPECS_BEGIN = "<!-- AGENT_HUB_SPECS:BEGIN (managed by `ahub init`, edits inside are overwritten; `ahub init --no-specs` removes it) -->";
const SPECS_END = "<!-- AGENT_HUB_SPECS:END -->";
/**
 * #1064 T3: the design-specs instruction block, placed the way the release guard's is. On: insert it (at the end of the file) or replace it in place. Off: drop it and the blank
 * lines around it, and nothing else. Text outside the markers is never touched, and incomplete markers are refused (nothing is guessed about where a half block ends).
 */
export function specsBlock(existing: string, enabled: boolean): string {
  const start = existing.indexOf("<!-- AGENT_HUB_SPECS:BEGIN"), end = existing.indexOf(SPECS_END, Math.max(start, 0));
  if (start >= 0 !== end > start || start < 0 && existing.includes(SPECS_END)) throw new Error("the AGENT_HUB_SPECS markers in AGENTS.md are incomplete; fix or remove the half block in your editor, then run ahub init again; nothing was written");
  if (!enabled) {
    if (start < 0) return existing;
    // Take out the block, the line break that ends its closing marker and one separating blank line, and nothing else: whitespace belonging to the text around it
    // (an indented code block right after the block, trailing spaces, the end of the file) is left byte for byte. With nothing before the block, the blank lines after it go instead.
    let before = existing.slice(0, start), after = existing.slice(end + SPECS_END.length);
    if (before === "") after = after.replace(/^(?:[ \t]*\r?\n)+/, "");
    else { after = after.replace(/^\r?\n/, ""); if (/\r?\n\r?\n$/.test(before)) before = before.replace(/\r?\n$/, ""); }
    const rest = before + after;
    return rest.trim() === "" ? "" : rest;
  }
  const block = `${SPECS_BEGIN}\n${readFileSync(join(TEMPLATES, "specs.block.md"), "utf8").trim()}\n${SPECS_END}`;
  if (start >= 0) return existing.slice(0, start) + block + existing.slice(end + SPECS_END.length);
  return `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${block}\n`;
}
/** Whether the specs feature is on for what init is about to leave behind: the flag when given, else the project's own layers (config.local.json over config.json), else the shipped default (on). */
function specsEnabled(cwd: string, settings: InitSettingsRequest | undefined): boolean {
  const asked = settings?.values["specs.enabled"];
  if (typeof asked === "boolean") return asked;
  let enabled = true;
  for (const name of ["config.json", "config.local.json"]) {
    const path = join(cwd, ".agenthub", name);
    if (!existsSync(path)) continue;
    try { const value = (JSON.parse(readFileSync(path, "utf8")) as { specs?: { enabled?: unknown } }).specs?.enabled; if (typeof value === "boolean") enabled = value; } catch { /* an unreadable layer is refused elsewhere, with its own message */ }
  }
  return enabled;
}
function regularHook(file: string): Stats | undefined {
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new Error("release guard hook must be an unlinked regular file");
  return info;
}
function releaseHookPlan(cwd: string): PlannedWrite[] {
  for (const scope of [["--local"], ["--global"], []]) {
    // Read the actual hooksPath without the hardened override masking it. All
    // other portable Git hardening stays; `git config --get` executes no hook.
    const argv = hubGitArgv(["config", ...scope, "--get", "core.hooksPath"]);
    const override = argv.indexOf("core.hooksPath=/dev/null");
    if (override < 1 || argv[override - 1] !== "-c") throw new Error("release guard Git hardening unavailable");
    argv.splice(override - 1, 2);
    const configured = spawnSync(argv[0]!, argv.slice(1), { cwd, env: hubGitEnv(process.env, { repositoryIsolation: true }), encoding: "utf8", timeout: 3000, maxBuffer: 16 * 1024 });
    if (configured.status !== 1) throw new Error(configured.status === 0 ? "release guard refuses custom core.hooksPath; no files changed" : "release guard cannot verify core.hooksPath");
  }
  const common = hubGitSync(["rev-parse", "--git-common-dir"], { cwd, env: hubGitEnv(process.env, { repositoryIsolation: true }), encoding: "utf8", timeout: 3000 });
  if (common.status !== 0 || !common.stdout.trim()) throw new Error("release guard requires a Git repository");
  const raw = isAbsolute(common.stdout.trim()) ? common.stdout.trim() : resolve(cwd, common.stdout.trim());
  const own = lstatSync(raw);
  if (!own.isDirectory() || own.isSymbolicLink()) throw new Error("release guard Git directory must not be a link");
  const commonDir = realPath(raw), hooks = join(commonDir, "hooks");
  const parent = lstatSync(hooks, { throwIfNoEntry: false });
  if (parent && (!parent.isDirectory() || parent.isSymbolicLink())) throw new Error("release guard hooks directory must not be a link");
  const hook = join(hooks, "pre-push"), backup = join(hooks, "pre-push.agent-hub-original");
  const original = regularHook(hook), saved = regularHook(backup);
  const current = original ? readFileSync(hook, "utf8") : "";
  const managed = current.startsWith(`#!/bin/sh\n${HOOK_MARKER}\n`);
  if (!managed && saved) throw new Error("release guard backup is occupied; no files changed");
  const wrapper = `#!/bin/sh
${HOOK_MARKER}
guard_input=$(umask 077; mktemp "\${TMPDIR:-/tmp}/ahub-release-guard.XXXXXX") || exit 1
trap 'rm -f "$guard_input"' 0
trap 'exit 1' 1 2 15
${shellQuote(process.execPath)} ${shellQuote(join(import.meta.dir, "main.ts"))} sdlc release-guard-hook "$1" "$2" >"$guard_input" || exit "$?"
if [ -x ${shellQuote(backup)} ]; then
  ${shellQuote(backup)} "$@" <"$guard_input"
else
  exit 0
fi
`;
  const plan: PlannedWrite[] = [];
  if (!parent) plan.push({ action: "create", path: hooks, reason: "create default Git hooks directory", directory: true });
  if (original && !managed) plan.push({ action: "create", path: backup, reason: "preserve original pre-push hook inode and mode", moveFrom: hook, expected: { dev: original.dev, ino: original.ino } });
  if (current !== wrapper || original && !(original.mode & 0o111)) plan.push({ action: original ? "modify" : "create", path: hook, reason: "install release authorization pre-push guard", next: wrapper, executable: true });
  return plan;
}
/** `--profile` takes a shipped profile or a project pack (#513a): a pack selects its base profile and brings its rubric and example checks as `profile_overrides`. */
function selection(cwd: string, requested: string | undefined): { profile?: ProfileName; pack?: DomainPack } {
  if (requested === undefined) return {};
  if ((PROFILE_NAMES as readonly string[]).includes(requested)) return { profile: requested as ProfileName };
  const loaded = loadPacks(cwd), pack = loaded.packs.get(requested);
  if (pack) return { profile: pack.profile, pack };
  const bad = loaded.errors.filter(error => error.id === requested || error.id === "project").map(error => `${error.id}: ${error.reason}`);
  throw new Error(`unknown profile or pack "${requested.slice(0, 48)}"; profiles: ${PROFILE_NAMES.join(", ")}; packs in .agenthub/roles: ${[...loaded.packs.keys()].join(", ") || "none"}${bad.length ? `; not loaded: ${bad.join("; ")}` : ""}`);
}
function changes(cwd: string, requestedName?: string, shadow = false, releaseGuard = false, settings?: InitSettingsRequest): { writes: PlannedWrite[]; settingRows: InitSettingRow[] } {
  const { profile: requested, pack } = selection(cwd, requestedName);
  const originalAgents = existsSync(join(cwd, "AGENTS.md")) ? readFileSync(join(cwd, "AGENTS.md"), "utf8") : "";
  const guarded = releaseGuard || originalAgents.includes("<!-- AGENT_HUB_RELEASE_GUARD:BEGIN");
  const hooks = guarded ? releaseHookPlan(cwd) : [];
  const repository = shadow ? repoOf(cwd) : undefined;
  if (shadow && repository && !repository.shadow) throw new Error("project already has a Git work tree; shadow mode is for non-git folders");
  if (shadow) {
    const parent = lstatSync(join(cwd, ".agenthub"), { throwIfNoEntry: false });
    if (parent && (!parent.isDirectory() || parent.isSymbolicLink())) throw new Error(".agenthub must be a project directory, not a link");
    const own = lstatSync(join(cwd, ".agenthub/shadow.git"), { throwIfNoEntry: false });
    if (own && !repository?.shadow) throw new Error("existing shadow metadata is invalid; nothing was replaced");
    const ignore = lstatSync(join(cwd, ".agenthub/ignore"), { throwIfNoEntry: false });
    if (ignore && (!ignore.isFile() || ignore.isSymbolicLink() || ignore.nlink !== 1)) throw new Error("shadow ignore must be a regular project file, not a link");
  }
  const configPath = join(cwd, ".agenthub", "config.json");
  const existingProfile = existsSync(configPath) ? profileName(JSON.parse(readFileSync(configPath, "utf8")).profile) : undefined;
  let overrides: unknown, activeProfile = existingProfile;
  for (const name of ["config.json", "config.local.json"]) {
    const path = join(cwd, ".agenthub", name);
    if (existsSync(path)) {
      let layer: Record<string, unknown>;
      try { layer = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error(`.agenthub/${name} is not valid JSON; fix it in your editor, then run ahub init again; nothing was written`); }
      if (layer.profile !== undefined) activeProfile = profileName(layer.profile);
      resolveProfile(activeProfile, layer.profile_overrides);
      overrides = mergeProfileOverrides(overrides, layer.profile_overrides);
    }
  }
  if (requested !== undefined && activeProfile !== undefined && requested !== activeProfile) throw new Error("init profile differs from existing config; edit the project profile explicitly before refreshing instructions");
  // A pack's overrides are applied once. Existing `profile_overrides` that hold the same data (compared with sorted keys, so the order the file was written in does not matter) mean the pack is already applied and the
  // file is left as it is; anything else already there is the project's to edit explicitly.
  let packApplied = false;
  if (pack) {
    const wanted = packOverrides(pack);
    if (overrides !== undefined && canonicalJson(overrides) !== canonicalJson(wanted)) throw new Error(`project already has profile_overrides that differ from pack ${pack.name}; edit them explicitly before applying a pack`);
    if (overrides !== undefined) packApplied = true; else overrides = wanted;
  }
  const profile = resolveProfile(requested ?? activeProfile, overrides);
  const changed: PlannedWrite[] = [];
  if (shadow && !repository?.shadow) changed.push({ action: "create", path: join(cwd, ".agenthub/shadow.git"), reason: "create opt-in shadow Git metadata without .git", shadow: true });
  const write = (path: string, next: string, reason: string, managedBlock?: InitChange["managedBlock"]) => {
    const exists = existsSync(path);
    if (exists && readFileSync(path, "utf8") === next) return;
    changed.push({ action: exists ? "modify" : "create", path, next, reason, ...(managedBlock ? { managedBlock } : {}) });
  };
  if (shadow && !existsSync(join(cwd, ".agenthub/ignore"))) write(join(cwd, ".agenthub/ignore"), "# Paths excluded from shadow snapshots and facts\ndata/raw/\n", "create editable large/raw data ignore policy");
  for (const name of ["config.json", "routing.toml"]) {
    const path = join(cwd, ".agenthub", name);
    if (!existsSync(path)) {
      const template = readFileSync(join(TEMPLATES, name), "utf8");
      const withProfile = name === "config.json" && profile.name !== "dev", withPack = name === "config.json" && !!pack;
      const next = withProfile || withPack ? JSON.stringify({ ...JSON.parse(template), ...(withProfile ? { profile: profile.name } : {}), ...(withPack ? { profile_overrides: overrides } : {}) }, null, 2) + "\n" : template;
      write(path, next, pack && name === "config.json" ? packReason(pack, "create project defaults with") : "create missing project defaults");
    }
  }
  if (pack && !packApplied && existsSync(configPath)) {
    const current = JSON.parse(readFileSync(configPath, "utf8"));
    write(configPath, JSON.stringify({ ...current, profile_overrides: overrides }, null, 2) + "\n", packReason(pack, "add to the project's profile_overrides"));
  }
  const agents = join(cwd, "AGENTS.md");
  const existing = existsSync(agents) ? readFileSync(agents, "utf8") : "";
  // #1399: one source for the block. A shipped profile's `agents` is only its addition, appended to the template; a project's own `profile_overrides.agents` still replaces the whole block.
  const shipped = readFileSync(join(TEMPLATES, "AGENTS.block.md"), "utf8");
  const template = rolesTracked(cwd, existing, settings) ? shipped : shipped.replace(ROLES_TRACKED, ROLES_UNTRACKED);
  const hubBlock = upsertBlock(existing, overrides && Object.hasOwn(overrides as object, "agents") ? profile.agents : profile.agents ? `${template.trim()}\n\n${profile.agents}` : template);
  const instructions = specsBlock(hubBlock, specsEnabled(cwd, settings)); // #1064 T3: a project that turned specs off keeps no block
  write(agents, guarded ? releaseBlock(instructions) : instructions, "refresh hub instructions; preserve surrounding text", existing.includes("<!-- AGENT_HUB:BEGIN") ? "replace" : "insert");
  const claude = join(cwd, "CLAUDE.md");
  const own = lstatSync(claude, { throwIfNoEntry: false });
  // The write preserves an existing inode, including AGENTS.md -> CLAUDE.md and hard links.
  const target = existsSync(agents) ? statSync(agents) : undefined;
  const legacy = own?.isFile() && !(target && own.dev === target.dev && own.ino === target.ino) ? readFileSync(claude, "utf8") : "";
  const rest = removeBlock(legacy);
  if (rest !== legacy) {
    if (rest) write(claude, rest, "remove legacy hub instructions; preserve surrounding text", "remove");
    else changed.push({ action: "delete", path: claude, reason: "remove legacy-only instructions", managedBlock: "remove" });
  }
  const ignore = join(cwd, ".gitignore");
  let lines = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  // #1411 AC6: git decides whether a path is already ignored (a broader rule, .git/info/exclude, the person's global file); the line check covers no repository and lines added in this run.
  const add = (entry: string) => {
    if (lines.split("\n").includes(entry) || ignoreRule(cwd, entry)) return;
    lines = `${lines}${lines && !lines.endsWith("\n") ? "\n" : ""}${entry}\n`;
  };
  for (const entry of [".agenthub/state/", ".agenthub/config.local.json", ".agenthub/routing.local.toml", ...(shadow ? [".agenthub/shadow.git/"] : [])]) add(entry);
  if (existsSync(join(cwd, KIMI_MCP_FILE)) && hubGitSync(["ls-files", "--error-unmatch", "--", KIMI_MCP_FILE], { cwd, encoding: "utf8", timeout: 3000 }).status !== 0) add(KIMI_MCP_FILE);
  const agyPlugin = ".agents/plugins/agent-hub/";
  if (existsSync(join(cwd, agyPlugin))) {
    const tracked = new Set(hubGitSync(["ls-files", "--", agyPlugin], { cwd, encoding: "utf8", timeout: 3000 }).stdout.trim().split("\n").filter(Boolean));
    for (const entry of tracked.size ? AGY_PLUGIN_FILES.filter(file => !tracked.has(file)) : [agyPlugin]) add(entry);
  }
  if (existsSync(join(cwd, JCODE_MCP_FILE)) && hubGitSync(["ls-files", "--error-unmatch", "--", JCODE_MCP_FILE], { cwd, encoding: "utf8", timeout: 3000 }).status !== 0) add(JCODE_MCP_FILE);
  // #1496: append owned re-inclusions instead of changing project or outside ignore rules.
  const track = settings?.values[TRACK_CONFIG];
  let ignoreReason = track === false ? "ignore runtime state, machine-local configuration and the per-checkout hub config" : "ignore runtime state and machine-local configuration";
  if (track === true) {
    const tracked = SHARED_CONFIG.filter(name => !(name === "routing.toml" && routingMachineKeys(cwd).length));
    const rules = tracked.map(name => ignoreRule(cwd, `.agenthub/${name}`));
    if (rules.some(Boolean) || lines.includes(SHARED_IGNORE_BEGIN)) {
      lines = withoutSharedIgnoreBlock(lines);
      const entries = ["!/.agenthub/", "/.agenthub/*", ...tracked.map(name => `!/.agenthub/${name}`)];
      lines = `${lines}${lines && !lines.endsWith("\n") ? "\n" : ""}${SHARED_IGNORE_BEGIN}\n${entries.join("\n")}\n${SHARED_IGNORE_END}\n`;
      const ruleClass = rules.some(rule => rule?.includes("/info/exclude:")) ? "repository info/exclude"
        : rules.some(rule => rule && !rule.startsWith(".gitignore:") && !rule.startsWith(".agenthub/")) ? "global excludes" : "project ignore";
      ignoreReason = `re-include shared config over ${ruleClass} rules in project .gitignore: ${entries.join(", ")}`;
    } else if (routingMachineKeys(cwd).length) add(".agenthub/routing.toml");
    if (rules.every(rule => rule !== undefined)) verifySharedIgnores(cwd, lines, tracked);
  } else if (track === false) {
    const owned = lines.includes(SHARED_IGNORE_BEGIN);
    lines = withoutSharedIgnoreBlock(lines);
    for (const name of SHARED_CONFIG) {
      const entry = `.agenthub/${name}`;
      // Existing owned negations must not suppress a new ignore line before the block is removed.
      if (owned && !lines.split("\n").includes(entry)) lines += `${lines && !lines.endsWith("\n") ? "\n" : ""}${entry}\n`;
      else add(entry);
    }
    if (owned) verifySharedIgnores(cwd, lines, []);
  }
  if (lines || existsSync(ignore)) write(ignore, lines, ignoreReason);
  // #1065 T1: the settings table. config.json is the text it will have after the template and pack writes above; the rest is what is on disk.
  let settingRows: InitSettingRow[] = [];
  if (settings && (Object.keys(settings.values).length)) {
    const planned = (path: string) => changed.find(row => row.path === path && row.next !== undefined)?.next;
    const read = (path: string): string | null => existsSync(path) ? readFileSync(path, "utf8") : null;
    const files: Record<InitSettingFile, string> = { "config.json": join(cwd, ".agenthub", "config.json"), "config.local.json": join(cwd, ".agenthub", "config.local.json"), "sdlc.toml": join(cwd, ".agenthub", "sdlc.toml") };
    const texts = Object.fromEntries((Object.keys(files) as InitSettingFile[]).map(name => [name, planned(files[name]) ?? read(files[name])])) as Record<InitSettingFile, string | null>;
    const result = planInitSettings(settings, texts);
    settingRows = result.rows;
    for (const name of Object.keys(result.next) as InitSettingFile[]) {
      const path = files[name], text = result.next[name]!;
      const row = changed.find(entry => entry.path === path);
      const reason = `set ${result.rows.filter(entry => entry.file === name).map(entry => entry.key).join(", ")} from the init settings`;
      if (row) { row.next = text; row.reason = `${row.reason}; ${reason}`; }
      else changed.push({ action: existsSync(path) ? "modify" : "create", path, next: text, reason, ...(name === "config.local.json" ? { privateFile: true as const } : {}) });
    }
  }
  return { writes: [...hooks, ...changed], settingRows };
}
/**
 * #1065: the files init is about to write for the settings flags are checked by the loaders the daemon uses, before anything is written. A refusal
 * names the loader's reason and writes nothing. Only the settings files are judged, so an unrelated project that already has a warning is not blocked.
 */
function checkCandidate(cwd: string, plan: readonly PlannedWrite[]): void {
  const at = (name: string) => plan.find(row => row.path === join(cwd, ".agenthub", name) && row.next !== undefined)?.next;
  const config = at("config.json"), local = at("config.local.json"), sdlc = at("sdlc.toml");
  if (config === undefined && local === undefined && sdlc === undefined) return;
  const layer = (name: "config.json" | "config.local.json", text: string | undefined) => {
    const raw = text ?? (existsSync(join(cwd, ".agenthub", name)) ? readFileSync(join(cwd, ".agenthub", name), "utf8") : undefined);
    return raw === undefined ? [] : [{ name, raw: JSON.parse(raw) as Record<string, unknown> }];
  };
  if (config !== undefined || local !== undefined) {
    try { loadConfig(cwd, [...layer("config.json", config), ...layer("config.local.json", local)] as never); }
    catch (error) { throw new Error(`the resulting .agenthub config does not pass the hub's config check: ${(error as Error).message}; fix that key in your editor, then run ahub init again; nothing was written`); }
  }
  if (sdlc !== undefined) {
    try {
      const lifecycle = sdlcConfig(Bun.TOML.parse(sdlc), VERSION);
      if (lifecycle.mode === "enforce" && !requiredChecksFor(lifecycle, githubOriginRepository(cwd)).length) throw new Error("enforce needs required CI checks; pass --required-checks <a,b,...>");
    }
    catch (error) { throw new Error(`the resulting .agenthub/sdlc.toml does not pass the hub's check: ${(error as Error).message}; fix it in your editor, then run ahub init again; nothing was written`); }
  }
}
/**
 * The plan row for the machine autonomy preset a new project inherits after the writes (`inheritMachineAutonomy`, run by `ahub init` once the files exist): `--dry-run` and the guided prompt's
 * confirmation both take it from here, so the plan a person approves cannot omit it. `undefined` when nothing is inherited (the machine default is off, or the person chose `--autonomy off`).
 */
export function autonomyInheritanceChange(cwd: string, machineEnabled: boolean, autonomy: "inherit" | "off" | undefined): InitChange | undefined {
  if (!machineEnabled || autonomy === "off") return undefined;
  return { action: existsSync(join(cwd, ".agenthub/config.local.json")) ? "modify" : "create", path: join(cwd, ".agenthub/config.local.json"), reason: "inherit the trusted machine autonomy preset; consent is checked at daemon startup" };
}
/** What a pack adds, by id only: the preview names the criteria and checks, never their text. */
const packReason = (pack: DomainPack, how: string) =>
  `${how} pack ${pack.name} (profile ${pack.profile}): rubric ${pack.rubric.map(item => item.id).join(", ")}; checks ${pack.checks.map(check => check.id).join(", ") || "none"}; expects roles ${pack.roles.join(", ") || "none"} from the catalog`;
/** Read-only metadata, deliberately omitting project/user file contents. `profile` is a shipped profile name or a project pack name. */
export function planInit(cwd: string, profile?: string, shadow = false, releaseGuard = false, settings?: InitSettingsRequest): InitChange[] {
  return changes(cwd, profile, shadow, releaseGuard, settings).writes.map(({ next, shadow: _shadow, directory, executable, moveFrom, expected, privateFile, ...change }) => change);
}
/** #1065 T1: what the settings flags change, key by key (`ahub init --dry-run --json` shows it as `settings`). Read-only. */
export function initSettingRows(cwd: string, profile?: string, shadow = false, releaseGuard = false, settings?: InitSettingsRequest): InitSettingRow[] {
  return changes(cwd, profile, shadow, releaseGuard, settings).settingRows;
}
/** A pre-existing local project choice wins; missing or unreadable machine defaults are off. Validation still runs before any write. */
export function initResearchDefault(cwd: string, machineValue: boolean | undefined): boolean {
  const local = join(cwd, ".agenthub", "config.local.json");
  try {
    if (existsSync(local)) {
      const value = JSON.parse(readFileSync(local, "utf8"))?.research?.enabled;
      if (typeof value === "boolean") return value;
    }
  } catch { /* the init candidate validation reports malformed local files before writes */ }
  return machineValue === true;
}
/** Add only a new project's effective on default to the normal plan. Off is the shipped default; explicit flags always win. Never writes machine defaults. */
export function withInitResearch(cwd: string, request: InitSettingsRequest, machineValue: boolean | undefined): InitSettingsRequest {
  if (existsSync(join(cwd, ".agenthub", "config.json")) || Object.hasOwn(request.values, "research.enabled") || !initResearchDefault(cwd, machineValue)) return request;
  return { ...request, values: { ...request.values, "research.enabled": true } };
}
/** Read only the bounded frontmatter prefix; a GSD archive is evidence, never an init input to execute or rewrite. */
function gsdPlanningState(cwd: string): boolean {
  let fd: number | undefined;
  try {
    if (!lstatSync(join(cwd, ".planning")).isDirectory()) return false;
    fd = openSync(join(cwd, ".planning", "STATE.md"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return false;
    const prefix = Buffer.alloc(4096), size = readSync(fd, prefix, 0, prefix.length, 0);
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(prefix.toString("utf8", 0, size));
    return !!header && /^gsd_state_version:[ \t]*["']?[0-9]+(?:\.[0-9]+)*["']?[ \t]*(?:#.*)?$/m.test(header[1]!);
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}
/** Prepare person guidance before writes; the CLI prints it only after successful apply. Creates no lifecycle evidence or acceptance. */
export function initNextSteps(cwd: string, settings?: InitSettingsRequest): string[] {
  const track = settings?.values[TRACK_CONFIG];
  const mode = settings?.values["sdlc.mode"] ?? loadSdlc(cwd, VERSION).mode;
  const lines = ["Next steps:"];
  // An ignore line does not untrack a file git already has: name the command that does.
  const committed = (names: readonly string[]) => names.map(name => `.agenthub/${name}`).filter(path => hubGitSync(["ls-files", "--error-unmatch", "--", path], { cwd, encoding: "utf8", timeout: 3000 }).status === 0);
  const untrack = (paths: string[]) => { if (paths.length) lines.push(`- ${paths.join(", ")} ${paths.length === 1 ? "is" : "are"} still committed: run git rm --cached ${paths.join(" ")} and commit, or git keeps tracking ${paths.length === 1 ? "it" : "them"}.`); };
  const agentsPath = join(cwd, "AGENTS.md");
  // The words follow the block's role sentence, so the next steps never contradict it (a project with neither flag whose config git ignores gets the untracked sentence).
  if (track === false || track === undefined && !rolesTracked(cwd, existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "", settings)) {
    lines.push("- Review and commit AGENTS.md. .agenthub/config.json, routing.toml and sdlc.toml stay untracked: each checkout and each machine holds its own roles.");
    untrack(committed(SHARED_CONFIG));
  } else if (track === true) {
    // #1411: the files to commit, and what must not go in with them.
    const ignorePlan = planInit(cwd, undefined, false, false, settings).find(change => change.path === join(cwd, ".gitignore") && change.reason.startsWith("re-include"));
    if (ignorePlan) lines.push(`- ${ignorePlan.reason}.`);
    const endpoints = routingMachineKeys(cwd);
    const files = SHARED_CONFIG.filter(name => !(name === "routing.toml" && endpoints.length) && (name !== "sdlc.toml" || existsSync(join(cwd, ".agenthub", name)) || mode !== "off"));
    lines.push(`- Review and commit AGENTS.md and ${files.map(name => `.agenthub/${name}`).join(", ")}; keep config.local.json untracked.`);
    if (endpoints.length) { lines.push(`- .agenthub/routing.toml stays untracked: ${endpoints.join(", ")} names this machine's endpoint, and routing.local.toml cannot hold it yet.`); untrack(committed(["routing.toml"])); }
    const personal = personalValues(cwd);
    if (personal.length) lines.push(`- Before the first commit, move ${personal.join(", ")} from .agenthub/config.json to .agenthub/config.local.json: they are this machine's values, and the hub ignores them in a committed config.json.`);
  } else lines.push("- Review and commit AGENTS.md, .agenthub/config.json and other shared init changes; keep config.local.json untracked.");
  lines.push(
    "- Your own settings go in .agenthub/config.local.json; it wins over config.json key by key.",
    "- Start with ahub up or ahub claude; sessions started otherwise miss hub pushes.",
  );
  // #1408 T2: what each role choice means, for a choice that changed nothing too (AC5: `none` and `person` are described, not only accepted).
  lines.push(...roleSummaryLines(settings?.values ?? {}));
  if (mode !== "off") lines.push(
    `- SDLC ${mode}: accept the planner-recorded spec with ahub sdlc accept <task> --issue <n>.`,
    "- When a plan departure needs your consent: ahub sdlc accept-departure <task> <head> <reason...>.",
    "- After hub_task_done on the open PR, reviewer approval and green exact-head CI, use guarded merge: ahub sdlc merge <task>.",
  );
  if (["advise", "enforce"].includes(String(settings?.values["sdlc.mode"])) && gsdPlanningState(cwd))
    lines.push("- GSD planning state found: see docs/sdlc.md#moving-from-gsd before migrating; archive .planning/ and retain its evidence.");
  return lines;
}
/** Returns the paths it changed, applying the same plan as the preview. */
export function init(cwd: string, profile?: string, shadow = false, releaseGuard = false, settings?: InitSettingsRequest): string[] {
  const plan = changes(cwd, profile, shadow, releaseGuard, settings).writes;
  checkCandidate(cwd, plan);
  // Recheck hook parents and rename identities before any project write.
  for (const change of plan.filter(change => change.executable || change.moveFrom)) {
    const parent = lstatSync(dirname(change.path), { throwIfNoEntry: false });
    if (parent && (!parent.isDirectory() || parent.isSymbolicLink())) throw new Error("release guard hook parent changed before installation");
    if (change.moveFrom) {
      const source = regularHook(change.moveFrom);
      if (!source || source.dev !== change.expected?.dev || source.ino !== change.expected.ino || lstatSync(change.path, { throwIfNoEntry: false })) throw new Error("release guard hook changed before installation");
    } else regularHook(change.path);
  }
  mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  for (const change of plan) {
    if (change.shadow) initShadow(cwd);
    else if (change.directory) mkdirSync(change.path);
    else if (change.moveFrom) continue; // Applied atomically with its prepared wrapper below.
    else if (change.action === "delete") unlinkSync(change.path);
    else if (change.executable) {
      const parent = lstatSync(dirname(change.path));
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("release guard hook parent changed before installation");
      const current = regularHook(change.path), move = plan.find(row => row.moveFrom === change.path);
      const temporary = join(dirname(change.path), `.pre-push.${randomUUID()}.tmp`);
      let moved = false;
      try {
        // Prepare bytes before disturbing any existing gate. Refreshing our own
        // managed hook is one atomic rename, so a failed write leaves it intact.
        writeFileSync(temporary, change.next!, { mode: 0o755, flag: "wx" });
        if (move) {
          if (!current || current.dev !== move.expected?.dev || current.ino !== move.expected.ino || lstatSync(move.path, { throwIfNoEntry: false })) throw new Error("release guard hook changed before installation");
          renameSync(change.path, move.path); moved = true;
        }
        renameSync(temporary, change.path);
      } catch (error) {
        if (moved && !lstatSync(change.path, { throwIfNoEntry: false })) renameSync(move!.path, change.path);
        throw error;
      } finally { if (lstatSync(temporary, { throwIfNoEntry: false })) unlinkSync(temporary); }
    }
    else if (change.privateFile) { const tmp = `${change.path}.${process.pid}.tmp`; try { writeFileSync(tmp, change.next!, { mode: 0o600, flag: "wx" }); renameSync(tmp, change.path); } catch (error) { try { unlinkSync(tmp); } catch { /* nothing was written */ } throw error; } }
    else writeFileSync(change.path, change.next!);
  }
  return plan.map(change => change.path);
}
