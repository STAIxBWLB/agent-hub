import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const BASE_PORT = 4600;
export const STRIDE = 10;
/** Offsets inside a project's stride. */
export const CONTROL = 0;
export const CODEX_APP = 1;
export const CODEX_PROXY = 2;
export const SWITCHYARD = 3;

/** One stride of loopback ports per project directory, remembered in ~/.agenthub/ports.json. */
export function allocatePorts(projectDir: string, registry = join(homedir(), ".agenthub", "ports.json")): number {
  let map: Record<string, number> = {};
  try {
    map = JSON.parse(readFileSync(registry, "utf8"));
  } catch {
    // first use
  }
  const known = map[projectDir];
  if (known) return known;
  const base = Math.max(BASE_PORT - STRIDE, ...Object.values(map)) + STRIDE;
  map[projectDir] = base;
  mkdirSync(dirname(registry), { recursive: true });
  // ponytail: no file lock; two first-time `ahub up` in different projects at the same instant could collide.
  writeFileSync(registry, `${JSON.stringify(map, null, 2)}\n`);
  return base;
}
