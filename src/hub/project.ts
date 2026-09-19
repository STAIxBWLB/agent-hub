import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const canonical = (path: string): string => {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonical(parent), basename(absolute));
  }
};

export function canonicalPath(path: string): string {
  return canonical(path);
}

function gitRoot(dir: string): string | undefined {
  const result = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const root = result.stdout.trim();
  return root ? canonical(root) : undefined;
}

function hasConfig(dir: string): boolean {
  return existsSync(join(dir, ".agenthub", "config.json"));
}

/** Resolve the project root without crossing the nearest Git working-tree boundary. */
export function projectRoot(cwd: string): string {
  const input = isAbsolute(cwd) ? cwd : resolve(cwd);
  let dir: string;
  try {
    dir = canonical(input);
    if (!lstatSync(dir).isDirectory()) throw new Error(`${cwd} is not a directory`);
  } catch (error) {
    throw new Error(`cannot resolve project directory ${cwd}: ${(error as Error).message}`);
  }

  const boundary = gitRoot(dir);
  const stop = boundary ?? parseRoot(dir);
  for (let current = dir; ; current = dirname(current)) {
    if (hasConfig(current)) return canonical(current);
    if (current === stop || current === dirname(current)) break;
  }
  return boundary ?? dir;
}

function parseRoot(dir: string): string {
  let current = dir;
  while (dirname(current) !== current) current = dirname(current);
  return current;
}

function stateMarker(stateDir: string): string | undefined {
  for (const file of [join(stateDir, "project.json"), join(stateDir, "status.json")]) {
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as { root?: string; cwd?: string };
      const root = value.root ?? value.cwd;
      if (typeof root === "string") return canonical(root);
    } catch {
      // A missing or incomplete marker is not a valid proof of ownership.
    }
  }
  return undefined;
}

export interface ProjectContext {
  root: string;
  stateDir: string;
}

/** Resolve a project and accept an inherited state directory only with an ownership proof. */
export function projectContext(cwd: string, env: NodeJS.ProcessEnv = process.env): ProjectContext {
  const root = projectRoot(cwd);
  const override = env.AGENTHUB_STATE_DIR?.trim();
  if (!override) return { root, stateDir: canonical(join(root, ".agenthub", "state")) };

  const declared = env.AGENTHUB_PROJECT_DIR?.trim();
  const stateDir = canonical(override);
  const recorded = stateMarker(stateDir);
  if (recorded === root) return { root, stateDir };
  // A marker for another project is authoritative; an inherited mismatch must not
  // redirect this cwd. The explicit pair is only for a freshly initialized state.
  if (!recorded && declared && canonical(declared) === root) return { root, stateDir };
  return { root, stateDir: canonical(join(root, ".agenthub", "state")) };
}

export function hubHome(env: NodeJS.ProcessEnv = process.env): string {
  return canonical(env.AGENTHUB_HOME?.trim() || join(homedir(), ".agenthub"));
}
