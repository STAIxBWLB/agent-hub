import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { hubGitSync } from "./git.ts";

import { canonicalPath as canonical } from "@staix/agent-mem/platform";
export { canonicalPath, realPath } from "@staix/agent-mem/platform";

function gitRoot(dir: string): string | undefined {
  const result = hubGitSync(["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
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
  const inherited = inheritedStateDir(root, env);
  return { root, stateDir: inherited ?? canonical(join(root, ".agenthub", "state")) };
}

/**
 * The ownership proof for an inherited state directory, on its own so the channel plugin applies the same rule as the CLI (#604 PR B, item 10). The directory is accepted only when the root
 * recorded in it equals `root`, or when it records none (a freshly initialized state) and the inherited `AGENTHUB_PROJECT_DIR` names `root`. A marker for another project is authoritative:
 * an inherited pair from the main checkout must not pull a process started in a linked worktree into the main repository's hub.
 */
export function inheritedStateDir(root: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.AGENTHUB_STATE_DIR?.trim();
  if (!override) return undefined;
  const declared = env.AGENTHUB_PROJECT_DIR?.trim();
  const stateDir = canonical(override);
  const recorded = stateMarker(stateDir);
  if (recorded === root) return stateDir;
  if (!recorded && declared && canonical(declared) === root) return stateDir;
  return undefined;
}

export function hubHome(env: NodeJS.ProcessEnv = process.env): string {
  return canonical(env.AGENTHUB_HOME?.trim() || join(homedir(), ".agenthub"));
}
