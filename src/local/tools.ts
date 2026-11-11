import { lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { realPath } from "../hub/project.ts";
import { isHubWritePath } from "../hub/permission-mode.ts";
import { insideRoot, matchesPolicy } from "../hub/path-policy.ts";
import { isDenied } from "./deny.ts";
import { docRead, type DocReadContext, type DocReadPort } from "./doc-read.ts";
import { webFetch, type WebFetchContext, type WebFetchPort } from "./web-fetch.ts";
import { OUTPUT_CAP, sandboxedExec } from "./sandbox.ts";
import { PROBE_WORKSPACE_LIMITS, probeRelativePath } from "./probe-workspace.ts";

export { isDenied };

export type ToolApproval = boolean | "expired" | "aborted";
export interface ApprovalProvenance { source: "person" | "automatic" | "expired" | "aborted"; answerEpoch: number; eligibleExpiry?: boolean; }
export type ApprovalObserver = (provenance: ApprovalProvenance) => void;
export const APPROVAL_EXPIRED_TEXT = "error: approval expired: no person answered; do not retry this call; hand the task off or stop";
export class ApprovalWaitStop extends Error {}
const approvalError = (picked: ToolApproval, denied: string): string | undefined => picked === true ? undefined
  : picked === "expired" ? APPROVAL_EXPIRED_TEXT
  : picked === "aborted" ? "error: approval withdrawn because the turn ended; no operation was executed" : denied;

export type ShellPermitPolicy = { forceAsk?: true };
export type ShellExecutionCheck = "valid" | "ask" | "aborted";
/** Constructor-only probe authority. Model arguments never create or widen this capability. */
export interface ProbeToolRestriction {
  readonly root: string;
  readonly writableRoots: readonly string[];
  current(): void;
  reserveWrite(bytes: number, canonicalPath: string): Promise<void>;
}
export interface ProbeToolResourcePlan {
  readonly scratchBytes: number;
  readonly outputBytes: number;
  readonly target?: string;
  readonly maximumBytes: number;
}
interface ProbeToolPlanState { root: string; target?: string; maximum: number; identity?: string; used: boolean }
const probeToolPlans = new WeakMap<ProbeToolResourcePlan, ProbeToolPlanState>();
function probeTargetIdentity(target: string): string | undefined {
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("probe write target is not a regular private file");
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}
/** Content-free pre-admission plan. A paid conservative reservation is not measured filesystem usage. */
export function planProbeTool(name: string, rawArgs: string, ctx: ToolContext): ProbeToolResourcePlan {
  if (!ctx.probe) throw new Error("probe tool capability unavailable");
  ctx.probe.current();
  const root = realPath(ctx.cwd);
  let target: string | undefined, maximum = 0, identity: string | undefined;
  try {
    if (name === "write" || name === "edit") {
      const value = JSON.parse(rawArgs || "{}");
      target = guardPath(ctx, String(value.path), "write"); identity = probeTargetIdentity(target);
      if (name === "write") maximum = Buffer.byteLength(String(value.content ?? ""), "utf8");
      else {
        const stat = lstatSync(target, { throwIfNoEntry: false });
        if (!stat || !stat.isFile()) throw new Error("probe edit target unavailable");
        maximum = Math.min(PROBE_WORKSPACE_LIMITS.fileBytes, stat.size + Buffer.byteLength(String(value.new ?? ""), "utf8"));
      }
      if (maximum > PROBE_WORKSPACE_LIMITS.fileBytes) throw new Error("probe write exceeds file ceiling");
    }
  } catch { target = undefined; maximum = 0; identity = undefined; }
  const kind = target === undefined ? undefined : relative(root, target).split("/")[0];
  const plan: ProbeToolResourcePlan = Object.freeze({ scratchBytes: kind === "scratch" ? maximum : 0,
    outputBytes: kind === "output" ? maximum : 0, ...(target === undefined ? {} : { target }), maximumBytes: maximum });
  probeToolPlans.set(plan, { root, target, maximum, identity, used: false });
  return plan;
}
/** Verify the already-charged compound tool reservation immediately before its sole filesystem write. */
export function requireProbeToolWrite(plan: ProbeToolResourcePlan, bytes: number, canonicalPath: string, ctx: ToolContext): void {
  ctx.probe?.current();
  const state = probeToolPlans.get(plan);
  if (!ctx.probe || !state || state.used || state.target === undefined || !Number.isSafeInteger(bytes) || bytes < 0
    || bytes > state.maximum || realPath(ctx.cwd) !== state.root || canonicalPath !== state.target
    || guardPath(ctx, relative(state.root, canonicalPath), "write") !== state.target || probeTargetIdentity(canonicalPath) !== state.identity) {
    throw new Error("probe tool reservation or target changed");
  }
  state.used = true;
}
export interface ToolContext {
  probe?: ProbeToolRestriction;
  readOnly?: string[];
  cwd: string;
  /** Extra denylist entries from config: substrings of the project-relative path. */
  deny: string[];
  /** Seatbelt profile for this project, built once per worker (`profile()` in sandbox.ts): it spawns git and must not run per tool call. */
  sandboxProfile: string;
  /** Extra environment for sandboxed commands: the egress proxy's variables when network goes through it (#65). */
  sandboxEnv?: Record<string, string>;
  /** Turn cancellation signal, including the execution-budget wall cap. */
  signal?: AbortSignal;
  /** Only true permits an effect; expiry and abort remain distinct from a person's denial. */
  permit: (title: string, tool?: string, signal?: AbortSignal, canonicalTarget?: string, observe?: ApprovalObserver, originalPath?: string, input?: unknown, policy?: ShellPermitPolicy) => Promise<ToolApproval>;
  /** Host-only synchronous recheck, immediately before a shell process can be spawned. */
  shellExecutionCheck?: (input: unknown) => ShellExecutionCheck;
  /** #515: present only when the project opted in (`local.doc_read`), so `doc_read` exists for this worker and nothing else gets it. `pii`: this turn is a PII task turn. */
  docRead?: DocReadPort & { pii: boolean };
  /** #515b: present only when the project opted in (`local.web_fetch.allow` names a host), so `web_fetch` exists for this worker and nothing else gets it. `pii`: this turn is a PII task turn, for which it is refused. */
  webFetch?: WebFetchPort & { pii: boolean };
  /** Trusted process status, independent of what its stdout says. */
  onProcessExit?: (code: number | null) => void;
  /** Publish a message to other peers mid-turn. Returns a one-line receipt. */
  send: (text: string, to?: string[]) => string;
}

const lexists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Absolute path inside cwd after resolving symlinks, or an Error. `write` also refuses .git and .agenthub. */
export function guardPath(ctx: Pick<ToolContext, "cwd" | "deny" | "readOnly" | "probe">, path: string, mode: "read" | "write"): string {
  if (ctx.probe) {
    ctx.probe.current();
    if (realPath(ctx.probe.root) !== realPath(ctx.cwd)) throw new Error("probe workspace binding changed");
    if (path === "/workspace") path = ".";
    else if (path.startsWith("/workspace/")) path = path.slice("/workspace/".length);
    else if (path.startsWith("/") || /^[a-z]:/i.test(path)) throw new Error("probe path is outside the logical workspace");
    if (!(mode === "read" && path === ".") && !probeRelativePath(path)) throw new Error("probe path is not an admitted relative name");
    const normalized = relative(realPath(ctx.cwd), resolve(realPath(ctx.cwd), path));
    if (!(mode === "read" && !normalized) && !probeRelativePath(normalized)) throw new Error("probe path is outside its relative-name boundary");
    path = normalized || ".";
  }
  const root = realPath(ctx.cwd);
  const abs = resolve(root, path);
  // Resolve symlinks on the deepest part that exists: a link pointing outside must not pass as an inside path.
  // lstat, not exists: a dangling symlink "does not exist" to existsSync, yet a write through it lands at its target.
  let existing = abs;
  while (!lexists(existing)) existing = dirname(existing);
  let realExisting: string;
  try {
    realExisting = realPath(existing);
  } catch {
    throw new Error(`${path} goes through a dangling symlink`);
  }
  const real = join(realExisting, relative(existing, abs));
  const rel = relative(root, real);
  if (rel.startsWith("..") || resolve(root, rel) !== real) throw new Error(`${path} is outside the project directory`);
  // Never trust the resolved name alone (#541): on a hardlinked file Bun's realpath sometimes names another link of the same inode, so the
  // name the caller typed is judged too. A refusal on either name stands; the typed name only ever adds refusals. Only a typed name INSIDE the project is judged
  // (`insideRoot`, #555): a name outside it (`../o/.env`, a link into the project) is no project path for any policy to name, and it was never refused before #541.
  const typed = relative(root, abs), inside = insideRoot(typed);
  if (isDenied(rel, ctx.deny) || inside && isDenied(typed, ctx.deny)) throw new Error(`${path} is on the secrets denylist`);
  if (ctx.probe) {
    const stat = lstatSync(real, { throwIfNoEntry: false });
    if ((stat?.nlink ?? 1) > 1 || stat?.isFile() && stat.size > PROBE_WORKSPACE_LIMITS.fileBytes) throw new Error("probe file identity or byte ceiling is unavailable");
  }
  // Not secret, but writing .git or .agenthub changes what runs outside the worker's control. Names are compared
  // folded: a new `.GIT/config` is `.git/config` to a case-insensitive disk, and git then runs what it names.
  if (mode === "write" && (isHubWritePath(rel) || inside && isHubWritePath(typed))) throw new Error(`${path} is not writable by the local worker`);
  // Identity refusal is stable even when realPath names a protected hardlink alias.
  if (mode === "write" && ctx.readOnly?.length && (lstatSync(real, { throwIfNoEntry: false })?.nlink ?? 1) > 1) throw new Error("hardlinked write target cannot be verified with data.readonly");
  if (mode === "write" && matchesPolicy(root, path, ctx.readOnly ?? [])) throw new Error("target is protected by data.readonly");
  if (ctx.probe && mode === "write") {
    const allowed = ctx.probe.writableRoots.some(approved => {
      const entry = resolve(root, approved), part = relative(root, entry).split("/");
      return part.length > 1 && ["scratch", "output"].includes(part[0]!) && insideRoot(relative(root, entry))
        && insideRoot(relative(entry, real)) && insideRoot(relative(entry, abs));
    });
    if (!allowed || (lstatSync(real, { throwIfNoEntry: false })?.nlink ?? 1) > 1) throw new Error("probe write target is not admitted");
    ctx.probe.current();
  }
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
  fn("bash", "Run a shell command in the project directory, sandboxed: no writes outside the project, no credential reads, no network unless the hub enables it. Follows hub permission policy: proven bounded read-only commands may run automatically in ask-when-needed; other commands ask.", { command: str, timeout_s: { type: "integer", minimum: 1, maximum: 600 } }, ["command"]),
  fn("git", "Run git in the project. status, diff, log, show, ls-files, blame, rev-parse run freely; add, commit, restore, checkout, switch, stash, mv, rm, branch, merge, rebase, cherry-pick, revert, tag need approval; everything else (push, fetch, config, remote ...) is refused. The sandbox does not let you move a branch, tag or HEAD anywhere (commit, branch, tag, stash, switch, merge, rebase and reset fail, submodules included), nor stage with add inside a linked worktree: edit files, and the hub commits and pushes them when you call hub_task_done.", { args: { type: "array", items: str, minItems: 1 } }, ["args"]),
  fn("hub_send", "Send a message to the other agents now, before your turn ends. Conclusions only. Your final answer is shared anyway; use this for something that cannot wait.", { text: str, to: { type: "array", items: str } }, ["text"]),
];

/**
 * #515: offered only to a worker whose project set `local.doc_read` (off by default), never part of TOOL_SCHEMAS. The model names a path and a line window; the converter
 * is the person's `text_projection` entry for the extension, run in the projection sandbox, and the text is bounded and passed through `sanitize()`.
 */
export const DOC_READ_SCHEMA = fn("doc_read", "Read a PDF, DOCX or HWPX document inside the project as plain text, through the converters the project configured. Returns numbered lines, bounded; read again with offset for more. Read-only.", { path: str, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1 } }, ["path"]);
export type { DocReadContext, DocReadPort };

/**
 * #515b: offered only to a worker whose project listed at least one host in `local.web_fetch.allow` (off by default), never part of TOOL_SCHEMAS. The model names a URL and a line
 * window and nothing else: no method, header or body. It is refused for the whole turn of a PII task, and otherwise runs only through the egress proxy, to listed hosts.
 */
export const WEB_FETCH_SCHEMA = fn("web_fetch", "Read one web page as plain text. https only, and only for hosts the project listed in local.web_fetch.allow; refused in a PII task. A plain GET with no headers or body of yours. Returns numbered lines, bounded; read again with offset for more. Never put anything private or from the task into the URL.", { url: str, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1 } }, ["url"]);
export type { WebFetchContext, WebFetchPort };

/** Every path-like argument of a call, for the memory capture filter. */
export function touchedPaths(name: string, args: Record<string, unknown>): string[] {
  if (name === "read" || name === "write" || name === "edit") return [String(args.path ?? "")];
  if (name === "bash") return [String(args.command ?? "")];
  if (name === "git") return (Array.isArray(args.args) ? args.args : []).map(String);
  return [];
}

/** Failure metadata for hub-owned loops; retrieved read text is line-numbered, process status is appended by us. */
export function toolResultFailed(name: string, output: string): boolean {
  if (name === "bash" || name === "git") {
    const exit = output.match(/(?:^|\n)\(exit ([^\n)]+)\)$/u);
    if (exit) return Number(exit[1]) !== 0;
  }
  return output.startsWith("error:");
}

/** Executes one tool call. Never throws: every failure comes back as text for the model to read. */
export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
  if (ctx.probe) {
    try { ctx.probe.current(); } catch { return "error: probe authority is unavailable"; }
    if (!["read", "write", "edit"].includes(name)) return "error: tool is unavailable in the confined probe";
  }
  let a: Record<string, any>;
  try {
    a = JSON.parse(rawArgs || "{}");
  } catch {
    return "error: tool arguments were not valid JSON";
  }
  try {
    if (ctx.signal?.aborted) return "error: turn cancelled before tool execution";
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
        let file = guardPath(ctx, String(a.path), "write");
        const approvedTarget = file;
        const content = String(a.content ?? "");
        const refused = approvalError(await ctx.permit(`write ${a.path} (${content.length} chars):\n${preview(content)}`, "write", ctx.signal, file, undefined, String(a.path), a), "error: the user did not approve this write");
        if (refused) return refused;
        if (ctx.signal?.aborted) return "error: turn cancelled before write";
        file = guardPath(ctx, String(a.path), "write");
        if (file !== approvedTarget) return "error: path target changed during approval; inspect before retrying";
        if (ctx.probe) {
          const bytes = Buffer.byteLength(content, "utf8");
          if (bytes > PROBE_WORKSPACE_LIMITS.fileBytes) return "error: probe file exceeds its admitted ceiling";
          await ctx.probe.reserveWrite(bytes, file);
          ctx.probe.current();
          if (ctx.signal?.aborted || guardPath(ctx, String(a.path), "write") !== approvedTarget) return "error: probe write binding changed";
        }
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
        return `wrote ${a.path}`;
      }
      case "edit": {
        let file = guardPath(ctx, String(a.path), "write");
        const approvedTarget = file;
        let text = readFileSync(file, "utf8");
        let count = text.split(String(a.old)).length - 1;
        if (!a.old || count !== 1) return `error: \`old\` must match exactly once, it matched ${count} times`;
        const refused = approvalError(await ctx.permit(`edit ${a.path}:\n- ${preview(String(a.old), 600)}\n+ ${preview(String(a.new ?? ""), 600)}`, "edit", ctx.signal, file, undefined, String(a.path), a), "error: the user did not approve this edit");
        if (refused) return refused;
        if (ctx.signal?.aborted) return "error: turn cancelled before edit";
        // Approval can outlive another peer's edit or a path change. Apply only the approved fragment to current bytes.
        file = guardPath(ctx, String(a.path), "write");
        if (file !== approvedTarget) return "error: path target changed during approval; inspect before retrying";
        text = readFileSync(file, "utf8");
        count = text.split(String(a.old)).length - 1;
        if (count !== 1) return `error: file changed during approval; \`old\` must match exactly once, it matched ${count} times`;
        const replacement = text.replace(String(a.old), () => String(a.new ?? ""));
        if (ctx.probe) {
          const bytes = Buffer.byteLength(replacement, "utf8");
          if (bytes > PROBE_WORKSPACE_LIMITS.fileBytes) return "error: probe file exceeds its admitted ceiling";
          await ctx.probe.reserveWrite(bytes, file);
          ctx.probe.current();
          if (ctx.signal?.aborted || guardPath(ctx, String(a.path), "write") !== approvedTarget || readFileSync(file, "utf8") !== text) return "error: probe edit binding changed";
        }
        writeFileSync(file, replacement);
        return `edited ${a.path}`;
      }
      case "bash": {
        const command = String(a.command ?? "");
        if (!command.trim()) return "error: empty command";
        // The approver sees the whole command, not a prefix: what is hidden cannot be approved.
        if (command.length > 4000) return "error: command longer than 4000 characters; put it in a script file with write, then run that";
        const input=Object.freeze({...a,command});
        for(let attempt=0;;attempt++) {
          const refused = approvalError(await ctx.permit(`bash: ${command}`, "bash", ctx.signal, undefined, undefined, undefined, input, attempt?{forceAsk:true}:undefined), "error: the user did not approve this command");
          if (refused) return refused;
          if(ctx.signal?.aborted)return "error: turn cancelled before shell execution";
          let check:ShellExecutionCheck="valid";
          try {check=ctx.shellExecutionCheck?.(input)??"valid";}catch{check="ask";}
          if(check==="aborted" || ctx.signal?.aborted)return "error: turn cancelled before shell execution";
          if(check==="valid")break;
          if(attempt)return "error: read-only shell proof remained unstable; no command was executed";
        }
        const res = await sandboxedExec(["/bin/bash", "-c", command], { cwd: ctx.cwd, profile: ctx.sandboxProfile, readOnlyData: !!ctx.readOnly?.length, timeoutMs: (Number(a.timeout_s) || 120) * 1000, ...(ctx.sandboxEnv ? { env: ctx.sandboxEnv } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
        try { ctx.onProcessExit?.(res.code); } catch { /* optional status observer never changes a tool result */ }
        return `${res.output}\n(exit ${res.code})`;
      }
      case "git": {
        const args: string[] = Array.isArray(a.args) ? a.args.map(String) : [];
        const sub = args[0] ?? "";
        if (!GIT_READ.has(sub) && !GIT_WRITE.has(sub)) return `error: git ${sub} is not available to the local worker`;
        const problem = gitArgsProblem(args, ctx.deny);
        if (problem) return `error: git ${sub}: ${problem}`;
        if (GIT_WRITE.has(sub)) {
          const refused = approvalError(await ctx.permit(`git ${args.join(" ")}`, "git", ctx.signal, undefined, undefined, undefined, a), "error: the user did not approve this git command");
          if (refused) return refused;
        }
        // Sandboxed like bash: flags such as --output or an editor cannot write outside the project or reach the network.
        const res = await sandboxedExec(["git", "--no-pager", ...args], { cwd: ctx.cwd, profile: ctx.sandboxProfile, readOnlyData: !!ctx.readOnly?.length, ...(ctx.sandboxEnv ? { env: ctx.sandboxEnv } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
        try { ctx.onProcessExit?.(res.code); } catch { /* optional status observer never changes a tool result */ }
        // #1123: the profile refuses writes to refs, HEAD, packed-refs and a linked worktree's admin dir, so a commit, branch, tag, stash or switch cannot succeed here. Say so, with the next step.
        const refused = res.code !== 0 && /(?:\.git\/(?:refs|HEAD|packed-refs|worktrees)\b|cannot lock ref|index\.lock)[^\n]*(?:Operation not permitted|not permitted)/i.test(res.output);
        return `${res.output}${refused ? "\nnote: the sandbox does not let you move a branch, tag or HEAD, or stage inside a linked worktree (#1123). Leave your edits in the working tree and finish with hub_task_done. For implementation work the hub stages, commits and pushes them for you; for work that changes no files, or a private task, there is nothing for it to commit, so do not try to commit it yourself." : ""}\n(exit ${res.code})`;
      }
      case "doc_read": {
        if (!ctx.docRead) return "error: doc_read is not enabled for this project (local.doc_read in .agenthub/config.local.json)";
        const file = guardPath(ctx, String(a.path), "read");
        return docRead(file, String(a.path), a, ctx.docRead, ctx.cwd);
      }
      case "web_fetch": {
        // The refusal for a PII turn is the first thing this tool does, before the URL is read (see `webFetch`); the opt-in check only says whether the tool exists.
        if (!ctx.webFetch) return "error: web_fetch is not enabled for this project (local.web_fetch.allow in .agenthub/config.local.json)";
        return webFetch(String(a.url ?? ""), a, ctx.webFetch, ctx.signal);
      }
      case "hub_send":
        return a.text ? ctx.send(String(a.text), Array.isArray(a.to) ? a.to.map(String) : undefined) : "error: text is required";
      default:
        return `error: unknown tool ${name}`;
    }
  } catch (e) {
    if (ctx.probe) return "error: confined probe tool operation refused";
    return `error: ${(e as Error).message}`;
  }
}
