import { initShadow, repoOf } from "../hub/snapshots.ts";
import { profileName, projectProfile, resolveProfile, mergeProfileOverrides, type ProfileName } from "../hub/profiles.ts";
import { JCODE_MCP_FILE } from "./jcode-mcp.ts";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hubGitSync } from "../hub/git.ts";
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
interface PlannedWrite extends InitChange { next?: string; shadow?: true; }
function changes(cwd: string, requested?: ProfileName, shadow = false): PlannedWrite[] {
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
      const next = name === "config.json" && profile.name !== "dev" ? JSON.stringify({ ...JSON.parse(template), profile: profile.name }, null, 2) + "\n" : template;
      write(path, next, "create missing project defaults");
    }
  }
  const agents = join(cwd, "AGENTS.md");
  const existing = existsSync(agents) ? readFileSync(agents, "utf8") : "";
  write(agents, upsertBlock(existing, overrides && Object.hasOwn(overrides as object, "agents") ? profile.agents : profile.agents || readFileSync(join(TEMPLATES, "AGENTS.block.md"), "utf8")), "refresh hub instructions; preserve surrounding text", existing.includes("<!-- AGENT_HUB:BEGIN") ? "replace" : "insert");
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
  return changed;
}
/** Read-only metadata, deliberately omitting project/user file contents. */
export function planInit(cwd: string, profile?: ProfileName, shadow = false): InitChange[] {
  return changes(cwd, profile, shadow).map(({ next, shadow: _shadow, ...change }) => change);
}
/** Returns the paths it changed, applying the same plan as the preview. */
export function init(cwd: string, profile?: ProfileName, shadow = false): string[] {
  const plan = changes(cwd, profile, shadow);
  mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  for (const change of plan) {
    if (change.shadow) initShadow(cwd);
    else if (change.action === "delete") unlinkSync(change.path);
    else writeFileSync(change.path, change.next!);
  }
  return plan.map(change => change.path);
}
