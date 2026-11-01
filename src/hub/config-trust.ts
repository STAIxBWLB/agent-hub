import { lstatSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
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
  "local.doc_read", // #515: gives the local worker a document reader; a committed config may not hand a model more tools on someone else's machine
  "local.web_fetch", // #515b: lets a model request pages from listed hosts; a committed config may not choose where a model's requests go on someone else's machine
  "terminal.open", // the command a hub-made TUI start runs to open a terminal (#269)
  "tasks.auto_pull", // #785 P1c: lets the hub start work on its own; a committed config may not turn it on for someone else's machine
  "folder_triggers", // #512c: entries make the hub read a folder and propose a task per new file; a committed config may not point the hub at a folder on someone else's machine
  "schedules", // #512: entries make the hub propose tasks on a timer; a committed config may not create work on someone else's machine
  "corpus.paths", // #510: folders the hub reads as evidence; a committed config may not point the hub at a folder on someone else's machine
  "invocation", // #445 C1: what another agent may be offered from this machine's agents (a digest-pinned allowlist); a committed config may not share a person's agents' commands with someone else's peers
] as const;
/** Legacy exported field list stays compatible; new policies use the complete list below. */
export const ALL_MACHINE_LOCAL = [...MACHINE_LOCAL, "rooms", "tasks.queue_backpressure", "context.max_assignment_used", "action_policy", "protect_instruction_files", "qwen_cmd", "jcode_cmd", "jcode_home", "jcode_provider_profile", "adapters", "adapter_modules", "text_projection", "instances", "start.agents"] as const;
/** An empty list of these is a value (`start.agents` empty starts no agent), not "the default", so the empty-value drop below skips them. */
const EMPTY_IS_VALUE: readonly string[] = ["start.agents"];

/** A known repository, including an unreadable marker, must never be mistaken for a plain directory. */
export function configRepositoryPresent(cwd: string): boolean {
  for (let at = cwd; ; at = dirname(at)) {
    try { lstatSync(join(at, ".git")); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true; }
    if (dirname(at) === at) return false;
  }
}

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
  if (name !== "config.local.json") delete file.rooms;
  const localOnly = name !== "config.local.json" && file.action_policy !== undefined;
  if (localOnly) delete file.action_policy;
  const originNotice = localOnly ? "action_policy ignored: only .agenthub/config.local.json may set it" : undefined;
  for (const p of ALL_MACHINE_LOCAL) if (!EMPTY_IS_VALUE.includes(p) && valueAt(file, p) !== undefined && !chooses(valueAt(file, p))) drop(file, p);
  const set = ALL_MACHINE_LOCAL.filter((p) => {
    const v = valueAt(file, p);
    return v !== undefined && JSON.stringify(v) !== JSON.stringify(valueAt(defaults, p));
  });
  if (!set.length) return originNotice;
  const why = configRefusal(cwd, name);
  if (!why) return originNotice;
  for (const p of set) drop(file, p);
  return [originNotice, `${set.join(", ")} in .agenthub/${name} ignored: ${why}`].filter(Boolean).join("; ");
}
