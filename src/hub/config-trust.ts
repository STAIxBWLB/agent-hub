import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { childEnv } from "./child-process.ts";

/**
 * Fields of the project config that choose what the hub runs, which files it sends as credentials, where task text
 * goes, or how far the local worker's sandbox reaches (issue #17). Only a file git confirms nobody committed may set
 * them; a cloned repository would otherwise choose them for the owner's machine.
 */
export const MACHINE_LOCAL = [
  "kimi_cmd",
  "codex_bin",
  "pi.cmd",
  "checks",
  "mlx.bin",
  "mlx.runtimeDir",
  "mlx.modelPath", // the legacy runtime runs code a model directory names (mlx-lm's model_file)
  "omniroute.urls",
  "omniroute.access_hosts",
  "omniroute.api_key_file",
  "omniroute.cf_client_id_file",
  "omniroute.cf_client_secret_file",
  "memory.worker_url",
  "local.read_allow",
  "local.bash_network",
] as const;

/**
 * Why `.agenthub/<name>` must not set machine-local fields, or undefined when git confirms nobody committed it.
 * Unknown is not untracked: no repository, no git, or a git error all refuse. The directory itself counts too (a
 * committed symlink or submodule at `.agenthub`). A tracked file is matched by identity, not by name: macOS opens
 * spellings git keeps apart (letter case, and folds such as "ſ" for "s").
 */
export function configRefusal(cwd: string, name: string): string | undefined {
  const r = spawnSync("git", ["-C", cwd, "ls-files", "-s", "-z", "--", ":(icase).agenthub"], { encoding: "utf8", env: childEnv(process.env) });
  if (r.status !== 0) return `git could not confirm that .agenthub/${name} is untracked`;
  let opened: { dev: number; ino: number } | undefined;
  try {
    opened = statSync(join(cwd, ".agenthub", name));
  } catch {
    // not there: only the directory entry can still matter
  }
  const tracked = r.stdout.split("\0").filter(Boolean).some((row) => {
    const path = row.slice(row.indexOf("\t") + 1);
    if (path.toLowerCase() === ".agenthub") return true;
    try {
      const s = statSync(join(cwd, path));
      return !!opened && s.dev === opened.dev && s.ino === opened.ino;
    } catch {
      return false;
    }
  });
  return tracked ? `.agenthub/${name} is committed to git` : undefined;
}

const valueAt = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);
/** An empty value chooses nothing (the template writes `""` for the key files), so it is never reported. */
const chooses = (v: unknown) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

const drop = (file: Record<string, unknown>, path: string) => {
  const [head, key] = path.split(".") as [string, string?];
  const block = file[head];
  if (!key) delete file[head];
  else if (block && typeof block === "object") delete (block as Record<string, unknown>)[key];
};

/**
 * Drops the machine-local fields `file` sets to anything but the default unless git vouches for it, and says which
 * went and why. An empty value always goes, trusted or not: it means the default, never "here" (an empty runtimeDir
 * once resolved to the project root). A committed copy of the template sets them to defaults and asks git nothing.
 */
export function stripUntrusted(file: Record<string, unknown>, defaults: object, cwd: string, name: string): string | undefined {
  for (const p of MACHINE_LOCAL) if (valueAt(file, p) !== undefined && !chooses(valueAt(file, p))) drop(file, p);
  const set = MACHINE_LOCAL.filter((p) => {
    const v = valueAt(file, p);
    return v !== undefined && JSON.stringify(v) !== JSON.stringify(valueAt(defaults, p));
  });
  if (!set.length) return undefined;
  const why = configRefusal(cwd, name);
  if (!why) return undefined;
  for (const p of set) drop(file, p);
  return `${set.join(", ")} in .agenthub/${name} ignored: ${why}`;
}
