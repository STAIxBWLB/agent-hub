import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TEMPLATES = join(import.meta.dir, "..", "..", "templates");
const BEGIN = "<!-- AGENT_HUB:BEGIN (managed by `hub init`, edits inside are overwritten) -->";
const END = "<!-- AGENT_HUB:END -->";

/** Insert or replace the managed block. Idempotent: text outside the markers is never touched. */
export function upsertBlock(existing: string, block: string): string {
  const managed = `${BEGIN}\n${block.trim()}\n${END}`;
  const start = existing.indexOf("<!-- AGENT_HUB:BEGIN");
  const end = existing.indexOf(END, Math.max(start, 0));
  if (start !== -1 && end > start) return existing.slice(0, start) + managed + existing.slice(end + END.length);
  return `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${managed}\n`;
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

  for (const [file, template] of [["CLAUDE.md", "CLAUDE.block.md"], ["AGENTS.md", "AGENTS.block.md"]] as const) {
    const path = join(cwd, file);
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    write(path, upsertBlock(existing, readFileSync(join(TEMPLATES, template), "utf8")));
  }

  const ignore = join(cwd, ".gitignore");
  const lines = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  if (!lines.split("\n").includes(".agenthub/state/")) write(ignore, `${lines}${lines && !lines.endsWith("\n") ? "\n" : ""}.agenthub/state/\n`);
  return changed;
}
