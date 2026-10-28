import { randomUUID } from "node:crypto";
import { initShadow, repoOf } from "../hub/snapshots.ts";
import { PROFILE_NAMES, profileName, projectProfile, resolveProfile, mergeProfileOverrides, type ProfileName } from "../hub/profiles.ts";
import { loadPacks, packOverrides, type DomainPack } from "../hub/packs.ts";
import { JCODE_MCP_FILE } from "./jcode-mcp.ts";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { Stats } from "node:fs";
import { realPath } from "../hub/project.ts";
import { hubGitArgv, hubGitEnv, hubGitSync } from "../hub/git.ts";
import { KIMI_MCP_FILE } from "./kimi-mcp.ts";
import { AGY_PLUGIN_FILES } from "./agy-mcp.ts";

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

export interface InitChange {
  action: "create" | "modify" | "delete";
  path: string;
  reason: string;
  managedBlock?: "insert" | "replace" | "remove";
}
/** Content is internal to apply, never included in a public preview. */
interface PlannedWrite extends InitChange { next?: string; shadow?: true; directory?: true; executable?: true; moveFrom?: string; expected?: { dev: number; ino: number }; }
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
function changes(cwd: string, requestedName?: string, shadow = false, releaseGuard = false): PlannedWrite[] {
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
      const layer = JSON.parse(readFileSync(path, "utf8"));
      if (layer.profile !== undefined) activeProfile = profileName(layer.profile);
      resolveProfile(activeProfile, layer.profile_overrides);
      overrides = mergeProfileOverrides(overrides, layer.profile_overrides);
    }
  }
  if (requested !== undefined && activeProfile !== undefined && requested !== activeProfile) throw new Error("init profile differs from existing config; edit the project profile explicitly before refreshing instructions");
  // A pack's overrides are applied once: the same pack again writes identical bytes (`write` skips it), and anything else already in profile_overrides is the project's to edit explicitly.
  if (pack) {
    const wanted = packOverrides(pack);
    if (overrides !== undefined && JSON.stringify(overrides) !== JSON.stringify(wanted)) throw new Error(`project already has profile_overrides that differ from pack ${pack.name}; edit them explicitly before applying a pack`);
    overrides = wanted;
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
  if (pack && existsSync(configPath)) {
    const current = JSON.parse(readFileSync(configPath, "utf8"));
    write(configPath, JSON.stringify({ ...current, profile_overrides: overrides }, null, 2) + "\n", packReason(pack, "add to the project's profile_overrides"));
  }
  const agents = join(cwd, "AGENTS.md");
  const existing = existsSync(agents) ? readFileSync(agents, "utf8") : "";
  const instructions = upsertBlock(existing, overrides && Object.hasOwn(overrides as object, "agents") ? profile.agents : profile.agents || readFileSync(join(TEMPLATES, "AGENTS.block.md"), "utf8"));
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
  for (const entry of [".agenthub/state/", ".agenthub/config.local.json", ".agenthub/routing.local.toml", ...(shadow ? [".agenthub/shadow.git/"] : [])]) {
    if (!lines.split("\n").includes(entry)) lines = `${lines}${lines && !lines.endsWith("\n") ? "\n" : ""}${entry}\n`;
  }
  if (existsSync(join(cwd, KIMI_MCP_FILE)) && hubGitSync(["ls-files", "--error-unmatch", "--", KIMI_MCP_FILE], { cwd, encoding: "utf8", timeout: 3000 }).status !== 0 && !lines.split("\n").includes(KIMI_MCP_FILE)) lines = `${lines}${lines && !lines.endsWith("\n") ? "\n" : ""}${KIMI_MCP_FILE}\n`;
  const agyPlugin = ".agents/plugins/agent-hub/";
  if (existsSync(join(cwd, agyPlugin))) {
    const tracked = new Set(hubGitSync(["ls-files", "--", agyPlugin], { cwd, encoding: "utf8", timeout: 3000 }).stdout.trim().split("\n").filter(Boolean));
    const entries = tracked.size ? AGY_PLUGIN_FILES.filter(file => !tracked.has(file)) : [agyPlugin];
    for (const entry of entries) if (!lines.split("\n").includes(entry)) lines = `${lines}${lines && !lines.endsWith("\n") ? "\n" : ""}${entry}\n`;
  }
  if (existsSync(join(cwd, JCODE_MCP_FILE)) && hubGitSync(["ls-files", "--error-unmatch", "--", JCODE_MCP_FILE], { cwd, encoding: "utf8", timeout: 3000 }).status !== 0 && !lines.split("\n").includes(JCODE_MCP_FILE)) lines = `${lines}${lines && !lines.endsWith("\n") ? "\n" : ""}${JCODE_MCP_FILE}\n`;
  write(ignore, lines, "ignore runtime state and machine-local configuration");
  return [...hooks, ...changed];
}
/** What a pack adds, by id only: the preview names the criteria and checks, never their text. */
const packReason = (pack: DomainPack, how: string) =>
  `${how} pack ${pack.name} (profile ${pack.profile}): rubric ${pack.rubric.map(item => item.id).join(", ")}; checks ${pack.checks.map(check => check.id).join(", ") || "none"}; expects roles ${pack.roles.join(", ") || "none"} from the catalog`;
/** Read-only metadata, deliberately omitting project/user file contents. `profile` is a shipped profile name or a project pack name. */
export function planInit(cwd: string, profile?: string, shadow = false, releaseGuard = false): InitChange[] {
  return changes(cwd, profile, shadow, releaseGuard).map(({ next, shadow: _shadow, directory, executable, moveFrom, expected, ...change }) => change);
}
/** Returns the paths it changed, applying the same plan as the preview. */
export function init(cwd: string, profile?: string, shadow = false, releaseGuard = false): string[] {
  const plan = changes(cwd, profile, shadow, releaseGuard);
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
    else writeFileSync(change.path, change.next!);
  }
  return plan.map(change => change.path);
}
