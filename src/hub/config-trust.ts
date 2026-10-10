import { statSync } from "node:fs";
import { join } from "node:path";
import { childEnv } from "./child-process.ts";
import { hubGitSync } from "./git.ts";

/**
 * Fields of the project config that choose what the hub runs, which files it sends as credentials, where task text
 * goes, or how far the local worker's sandbox reaches (issue #17). Only a file git confirms nobody committed may set
 * them; a cloned repository would otherwise choose them for the owner's machine.
 */
export const MACHINE_LOCAL = [
  "kimi_cmd",
  "permission_modes",
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
  "local.network_allow", // the hosts the egress proxy opens (#65)
  "terminal.open", // the command a hub-made TUI start runs to open a terminal (#269)
] as const;

/**
 * Why `.agenthub/<name>` must not set machine-local fields, or undefined when git confirms nobody committed it.
 * Unknown is not untracked: no repository, no git, or a git error all refuse. The directory itself counts too (a
 * committed symlink or submodule at `.agenthub`). A tracked file is matched by identity, not by name: macOS opens
 * spellings git keeps apart (letter case, and folds such as "ſ" for "s").
 */
export function configRefusal(cwd: string, name: string): string | undefined {
  const tracked = configTracked(cwd, name);
  return tracked === undefined ? `git could not confirm that .agenthub/${name} is untracked` : tracked ? `.agenthub/${name} is committed to git` : undefined;
}

/** Whether git tracks `.agenthub/<name>` (or `.agenthub` itself); undefined when git cannot say. */
export function configTracked(cwd: string, name: string): boolean | undefined {
  const r = hubGitSync(["-C", cwd, "ls-files", "-s", "-z", "--", ":(icase).agenthub"], { encoding: "utf8", env: childEnv(process.env) });
  if (r.status !== 0) return undefined;
  let opened: { dev: number; ino: number } | undefined;
  try {
    opened = statSync(join(cwd, ".agenthub", name));
  } catch {
    // not there: only the directory entry can still matter
  }
  return r.stdout.split("\0").filter(Boolean).some((row) => {
    const path = row.slice(row.indexOf("\t") + 1);
    if (path.toLowerCase() === ".agenthub") return true;
    // A file that is not there has no identity to match: the index entry of this exact name is the one a write would
    // change. Another spelling is another file where the disk keeps them apart.
    // ponytail: on a disk that folds names, an entry tracked under another spelling and deleted from the work tree is
    // not seen here; probe the disk's folding and compare folded names if that case ever matters.
    if (!opened) return path === `.agenthub/${name}`;
    try {
      const s = statSync(join(cwd, path));
      return !!opened && s.dev === opened.dev && s.ino === opened.ino;
    } catch {
      return false;
    }
  });
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
