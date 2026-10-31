import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

/** Where `ahub setup` registers the acon plugin (#935): acon reads $AGENTHUB_HOME/console/plugins/<tool>.json. */
export function aconManifestPath(home: string): string {
  return join(home, "console", "plugins", "ahub.json");
}

/**
 * Write the acon registration for this package's plugin module with its sha256, so acon refuses a module that changed
 * after setup. The directory is created 0700; the file is replaced atomically. Returns what was written, or why not.
 */
export function registerAconPlugin(home: string, module: string): { path: string; changed: boolean } | { error: string } {
  if (!existsSync(module)) return { error: `acon plugin module ${module} is missing` };
  const dir = join(home, "console", "plugins");
  for (const part of [join(home, "console"), dir]) {
    if (!existsSync(part)) mkdirSync(part, { mode: 0o700 });
    if (!lstatSync(part).isDirectory()) return { error: `${part} is not a directory` };
    chmodSync(part, 0o700);
  }
  const path = aconManifestPath(home);
  const body = `${JSON.stringify({ api: 1, tool: "ahub", module, sha256: createHash("sha256").update(readFileSync(module)).digest("hex") })}\n`;
  if (existsSync(path) && readFileSync(path, "utf8") === body) return { path, changed: false };
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, body, { mode: 0o600 });
  renameSync(temp, path);
  return { path, changed: true };
}
