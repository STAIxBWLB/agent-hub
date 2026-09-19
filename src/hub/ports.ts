import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Registry } from "./registry.ts";
import { hubHome } from "./project.ts";

export const BASE_PORT = 4600;
export const STRIDE = 10;
/** Offsets inside a project's stride. */
export const CONTROL = 0;
export const CODEX_APP = 1;
export const CODEX_PROXY = 2;
export const SWITCHYARD = 3;

/** SQLite-backed project allocation; an explicit JSON path retains the legacy utility API under a lock. */
export function allocatePorts(projectDir: string, registry?: string): number {
  if (registry === undefined) {
    const db = new Registry(join(hubHome(), "registry.db"));
    try {
      return db.allocate(projectDir);
    } finally {
      db.close();
    }
  }
  mkdirSync(dirname(registry), { recursive: true });
  const lock = `${registry}.lock`;
  for (let attempt = 0; ; attempt++) {
    try { mkdirSync(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 500) throw new Error(`cannot lock legacy port registry ${registry}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
  let map: Record<string, number> = {};
  if (existsSync(registry)) {
    try {
      map = JSON.parse(readFileSync(registry, "utf8"));
    } catch (error) {
      throw new Error(`cannot read legacy port registry ${registry}: ${(error as Error).message}`);
    }
  }
  if (!map || Array.isArray(map) || typeof map !== "object") throw new Error(`cannot read legacy port registry ${registry}: expected an object`);
  const seen = new Set<number>();
  for (const [root, port] of Object.entries(map)) {
    if (typeof port !== "number" || !Number.isInteger(port) || port < BASE_PORT || port % STRIDE !== 0) throw new Error(`cannot read legacy port registry ${registry}: invalid port for ${root}`);
    if (seen.has(port)) throw new Error(`cannot read legacy port registry ${registry}: conflicting port ${port}`);
    seen.add(port);
  }
  const known = map[projectDir];
  if (known) return known;
  const base = Math.max(BASE_PORT - STRIDE, ...Object.values(map)) + STRIDE;
  map[projectDir] = base;
  const temp = `${registry}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify(map, null, 2)}\n`);
  renameSync(temp, registry);
  return base;
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
