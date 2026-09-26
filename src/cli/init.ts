import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
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

/** Returns the paths it changed. */
export function init(cwd: string): string[] {
  const changed: string[] = [];
  const write = (path: string, next: string) => {
    if (existsSync(path) && readFileSync(path, "utf8") === next) return;
    writeFileSync(path, next);
    changed.push(path);
  };

  mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  const config = join(cwd, ".agenthub", "config.json");
  if (!existsSync(config)) write(config, readFileSync(join(TEMPLATES, "config.json"), "utf8"));

  const routing = join(cwd, ".agenthub", "routing.toml");
  if (!existsSync(routing)) write(routing, readFileSync(join(TEMPLATES, "routing.toml"), "utf8"));

  const agents = join(cwd, "AGENTS.md");
  write(agents, upsertBlock(existsSync(agents) ? readFileSync(agents, "utf8") : "", readFileSync(join(TEMPLATES, "AGENTS.block.md"), "utf8")));

  // Any CLAUDE.md, even an empty one, stops Claude Code from loading AGENTS.md: take back the block older versions wrote there.
  // A CLAUDE.md that is AGENTS.md (a symlink) holds the block just written and is left alone.
  const claude = join(cwd, "CLAUDE.md");
  const legacy = existsSync(claude) && realpathSync(claude) !== realpathSync(agents) ? readFileSync(claude, "utf8") : "";
  const rest = removeBlock(legacy);
  if (rest !== legacy) {
    if (rest) write(claude, rest);
    else {
      unlinkSync(claude);
      changed.push(claude);
    }
  }

  const ignore = join(cwd, ".gitignore");
  const lines = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  if (!lines.split("\n").includes(".agenthub/state/")) write(ignore, `${lines}${lines && !lines.endsWith("\n") ? "\n" : ""}.agenthub/state/\n`);
  return changed;
}
