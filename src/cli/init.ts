import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
interface PlannedWrite extends InitChange { next?: string; }
function changes(cwd: string): PlannedWrite[] {
  const changed: PlannedWrite[] = [];
  const write = (path: string, next: string, reason: string, managedBlock?: InitChange["managedBlock"]) => {
    const exists = existsSync(path);
    if (exists && readFileSync(path, "utf8") === next) return;
    changed.push({ action: exists ? "modify" : "create", path, next, reason, ...(managedBlock ? { managedBlock } : {}) });
  };
  for (const name of ["config.json", "routing.toml"]) {
    const path = join(cwd, ".agenthub", name);
    if (!existsSync(path)) write(path, readFileSync(join(TEMPLATES, name), "utf8"), "create missing project defaults");
  }
  const agents = join(cwd, "AGENTS.md");
  const existing = existsSync(agents) ? readFileSync(agents, "utf8") : "";
  write(agents, upsertBlock(existing, readFileSync(join(TEMPLATES, "AGENTS.block.md"), "utf8")), "refresh hub instructions; preserve surrounding text", existing.includes("<!-- AGENT_HUB:BEGIN") ? "replace" : "insert");
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
  for (const entry of [".agenthub/state/", ".agenthub/config.local.json", ".agenthub/routing.local.toml"]) {
    if (!lines.split("\n").includes(entry)) lines = `${lines}${lines && !lines.endsWith("\n") ? "\n" : ""}${entry}\n`;
  }
  write(ignore, lines, "ignore runtime state and machine-local configuration");
  return changed;
}
/** Read-only metadata, deliberately omitting project/user file contents. */
export function planInit(cwd: string): InitChange[] {
  return changes(cwd).map(({ next, ...change }) => change);
}
/** Returns the paths it changed, applying the same plan as the preview. */
export function init(cwd: string): string[] {
  const plan = changes(cwd);
  mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  for (const change of plan) {
    if (change.action === "delete") unlinkSync(change.path);
    else writeFileSync(change.path, change.next!);
  }
  return plan.map(change => change.path);
}
