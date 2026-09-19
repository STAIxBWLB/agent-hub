import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { hasSegment, isDenied } from "./deny.ts";
import { OUTPUT_CAP, sandboxedExec } from "./sandbox.ts";

export { isDenied };

export interface ToolContext {
  cwd: string;
  /** Extra denylist entries from config: substrings of the project-relative path. */
  deny: string[];
  /** Seatbelt profile for this project, built once per worker (`profile()` in sandbox.ts): it spawns git and must not run per tool call. */
  sandboxProfile: string;
  /** Ask the console. Resolves false on deny or timeout. */
  permit: (title: string) => Promise<boolean>;
  /** Publish a message to other peers mid-turn. Returns a one-line receipt. */
  send: (text: string, to?: string[]) => string;
}

/** Not secret, but writing them changes what runs outside the worker's control. */
const WRITE_DENY_SEGMENTS = [".git", ".agenthub"];

const lexists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Absolute path inside cwd after resolving symlinks, or an Error. `write` also refuses .git and .agenthub. */
export function guardPath(ctx: Pick<ToolContext, "cwd" | "deny">, path: string, mode: "read" | "write"): string {
  const root = realpathSync(ctx.cwd);
  const abs = resolve(root, path);
  // Resolve symlinks on the deepest part that exists: a link pointing outside must not pass as an inside path.
  // lstat, not exists: a dangling symlink "does not exist" to existsSync, yet a write through it lands at its target.
  let existing = abs;
  while (!lexists(existing)) existing = dirname(existing);
  let realExisting: string;
  try {
    realExisting = realpathSync(existing);
  } catch {
    throw new Error(`${path} goes through a dangling symlink`);
  }
  const real = join(realExisting, relative(existing, abs));
  const rel = relative(root, real);
  if (rel.startsWith("..") || resolve(root, rel) !== real) throw new Error(`${path} is outside the project directory`);
  if (isDenied(rel, ctx.deny)) throw new Error(`${path} is on the secrets denylist`);
  if (mode === "write" && WRITE_DENY_SEGMENTS.some((s) => hasSegment(rel, s))) throw new Error(`${path} is not writable by the local worker`);
  return real;
}

/** Shown to the person approving: enough of the content to know what they approve. */
const preview = (text: string, n = 1500) => (text.length > n ? `${text.slice(0, n)}\n... (${text.length - n} more chars)` : text);

/**
 * git takes paths and revisions that never pass through guardPath: `diff --no-index /dev/null ~/.cargo/credentials.toml`,
 * `show HEAD:.env`. Every argument is checked: nothing absolute, nothing with `..`, nothing on the denylist.
 */
function gitArgsProblem(args: string[], deny: string[]): string | undefined {
  for (const arg of args.slice(1)) {
    if (arg === "--no-index" || arg.startsWith("--output") || arg.startsWith("--ext-diff") || arg.startsWith("--textconv")) return `${arg} is not available`;
    const path = arg.includes(":") ? arg.slice(arg.indexOf(":") + 1) : arg.replace(/^--[a-z-]+=/, "");
    if (path.startsWith("/") || path.startsWith("~") || path.split("/").includes("..")) return `${arg} points outside the project`;
    if (isDenied(path, deny)) return `${arg} is on the secrets denylist`;
  }
  return undefined;
}

const GIT_READ = new Set(["status", "diff", "log", "show", "ls-files", "blame", "rev-parse"]);
const GIT_WRITE = new Set(["add", "commit", "restore", "checkout", "switch", "stash", "mv", "rm", "branch", "merge", "rebase", "cherry-pick", "revert", "tag"]);

const str = { type: "string" } as const;
const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
});

export const TOOL_SCHEMAS = [
  fn("read", "Read a text file inside the project. Returns numbered lines.", { path: str, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1 } }, ["path"]),
  fn("write", "Create or overwrite a file inside the project. Needs the user's approval.", { path: str, content: str }, ["path", "content"]),
  fn("edit", "Replace one exact, unique occurrence of `old` with `new` in a file. Needs the user's approval.", { path: str, old: str, new: str }, ["path", "old", "new"]),
  fn("bash", "Run a shell command in the project directory, sandboxed: no writes outside the project, no credential reads, no network unless the hub enables it. Needs the user's approval.", { command: str, timeout_s: { type: "integer", minimum: 1, maximum: 600 } }, ["command"]),
  fn("git", "Run git in the project. status, diff, log, show, ls-files, blame, rev-parse run freely; add, commit, restore, checkout, switch, stash, mv, rm, branch, merge, rebase, cherry-pick, revert, tag need approval; everything else (push, fetch, config, remote ...) is refused.", { args: { type: "array", items: str, minItems: 1 } }, ["args"]),
  fn("hub_send", "Send a message to the other agents now, before your turn ends. Conclusions only. Your final answer is shared anyway; use this for something that cannot wait.", { text: str, to: { type: "array", items: str } }, ["text"]),
];

/** Every path-like argument of a call, for the memory capture filter. */
export function touchedPaths(name: string, args: Record<string, unknown>): string[] {
  if (name === "read" || name === "write" || name === "edit") return [String(args.path ?? "")];
  if (name === "bash") return [String(args.command ?? "")];
  if (name === "git") return (Array.isArray(args.args) ? args.args : []).map(String);
  return [];
}

/** Executes one tool call. Never throws: every failure comes back as text for the model to read. */
export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
  let a: Record<string, any>;
  try {
    a = JSON.parse(rawArgs || "{}");
  } catch {
    return "error: tool arguments were not valid JSON";
  }
  try {
    switch (name) {
      case "read": {
        const file = guardPath(ctx, String(a.path), "read");
        if (statSync(file).size > 5_000_000) return "error: file is larger than 5 MB; use bash (head, grep, sed -n) to look at parts of it";
        const lines = readFileSync(file, "utf8").split("\n");
        const from = Math.max(1, Number(a.offset) || 1);
        const out = lines.slice(from - 1, from - 1 + (Number(a.limit) || 2000)).map((l, i) => `${from + i}\t${l}`).join("\n");
        return out.length > OUTPUT_CAP ? `${out.slice(0, OUTPUT_CAP)}\n(truncated: read again with offset/limit)` : out;
      }
      case "write": {
        const file = guardPath(ctx, String(a.path), "write");
        const content = String(a.content ?? "");
        if (!(await ctx.permit(`write ${a.path} (${content.length} chars):\n${preview(content)}`))) return "error: the user did not approve this write";
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
        return `wrote ${a.path}`;
      }
      case "edit": {
        const file = guardPath(ctx, String(a.path), "write");
        const text = readFileSync(file, "utf8");
        const count = text.split(String(a.old)).length - 1;
        if (!a.old || count !== 1) return `error: \`old\` must match exactly once, it matched ${count} times`;
        if (!(await ctx.permit(`edit ${a.path}:\n- ${preview(String(a.old), 600)}\n+ ${preview(String(a.new ?? ""), 600)}`))) return "error: the user did not approve this edit";
        writeFileSync(file, text.replace(String(a.old), () => String(a.new ?? "")));
        return `edited ${a.path}`;
      }
      case "bash": {
        const command = String(a.command ?? "");
        if (!command.trim()) return "error: empty command";
        // The approver sees the whole command, not a prefix: what is hidden cannot be approved.
        if (command.length > 4000) return "error: command longer than 4000 characters; put it in a script file with write, then run that";
        if (!(await ctx.permit(`bash: ${command}`))) return "error: the user did not approve this command";
        const res = await sandboxedExec(["/bin/bash", "-c", command], { cwd: ctx.cwd, profile: ctx.sandboxProfile, timeoutMs: (Number(a.timeout_s) || 120) * 1000 });
        return `${res.output}\n(exit ${res.code})`;
      }
      case "git": {
        const args: string[] = Array.isArray(a.args) ? a.args.map(String) : [];
        const sub = args[0] ?? "";
        if (!GIT_READ.has(sub) && !GIT_WRITE.has(sub)) return `error: git ${sub} is not available to the local worker`;
        const problem = gitArgsProblem(args, ctx.deny);
        if (problem) return `error: git ${sub}: ${problem}`;
        if (GIT_WRITE.has(sub) && !(await ctx.permit(`git ${args.join(" ")}`))) return "error: the user did not approve this git command";
        // Sandboxed like bash: flags such as --output or an editor cannot write outside the project or reach the network.
        const res = await sandboxedExec(["git", "--no-pager", ...args], { cwd: ctx.cwd, profile: ctx.sandboxProfile });
        return `${res.output}\n(exit ${res.code})`;
      }
      case "hub_send":
        return a.text ? ctx.send(String(a.text), Array.isArray(a.to) ? a.to.map(String) : undefined) : "error: text is required";
      default:
        return `error: unknown tool ${name}`;
    }
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}
