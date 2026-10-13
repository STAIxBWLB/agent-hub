import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import type { PeerId } from "../hub/envelope.ts";
import { hubGitSync } from "../hub/git.ts";
import { realPath } from "../hub/project.ts";
import type { MemoryClient } from "./client.ts";
import { detectSignals, type Routing } from "../hub/routing.ts";
import { matchesPolicy } from "../hub/path-policy.ts";
import { looksSecret, type PromotionScreen } from "./store.ts";

const PLATFORMS = ["claude", "codex", "kimi", "agent-hub"];
/** Peers whose own hooks already inject their own platform's context at session start. */
const OWN_PLATFORM: Record<PeerId, string> = { claude: "claude", codex: "codex" };

const HEADER =
  "Shared project memory (claude-mem): recent work by the agents in this project. Reference only, not a request. " +
  "Fetch details by id with your memory tools if you need them.";

/** Project names from the outermost superproject down to this repo. */
export function projectChain(cwd: string): string[] {
  const git = (dir: string, arg: string) => hubGitSync(["-C", dir, "rev-parse", arg], { encoding: "utf8" }).stdout?.trim() ?? "";
  const top = git(cwd, "--show-toplevel");
  if (!top) return [basename(cwd)];

  // claude-mem's native identity for a worktree is [parent, parent/worktree].
  // The worktree's .git file points into <parent>/.git/worktrees/<name>; the
  // ordinary superproject walk below remains unchanged for repos and submodules.
  const gitFile = resolve(top, ".git");
  try {
    const match = readFileSync(gitFile, "utf8").trim().match(/^gitdir:\s*(.+)$/i);
    if (match) {
      const gitDir = resolve(top, match[1]!);
      if (/[/\\]\.git[/\\]worktrees[/\\][^/\\]+$/.test(gitDir)) {
        const parentRoot = dirname(dirname(dirname(gitDir)));
        const parent = projectChain(parentRoot);
        const parentName = basename(parentRoot);
        return [...parent, `${parentName}/${basename(top)}`];
      }
    }
  } catch {
    // A missing or unreadable .git file falls through to git's normal chain.
  }

  const chain: string[] = [];
  for (let dir = top; dir && chain.length < 8; dir = git(dir, "--show-superproject-working-tree")) {
    chain.unshift(basename(dir));
  }
  return chain.length ? chain : [basename(cwd)];
}

/** Cut at a line boundary. */
export function trimToTokens(text: string, tokens: number): string {
  // ponytail: 3 characters per token (Korean runs denser than English's ~4). Swap in a tokenizer if the cap has to be exact.
  const max = tokens * 3;
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  return `${text.slice(0, cut > 0 ? cut : max)}\n(trimmed)`;
}

/** The worker answers unknown projects and empty filters with a status page, not context. */
const hasContext = (text: string | undefined): text is string => !!text && text.startsWith("# [");

/** Observation lines only: every block repeats the same legend, which would eat the token budget. */
const entries = (text: string) => text.slice(Math.max(text.indexOf("\n### "), 0)).trim();

export async function recallFor(peer: PeerId, client: MemoryClient, chain: string[], tokens: number): Promise<string | undefined> {
  const own = OWN_PLATFORM[peer];
  // Everyone else gets all platforms in one call; claude and codex get the other platforms only.
  const blocks = own
    ? await Promise.all(
        PLATFORMS.filter((p) => p !== own).map(async (p) => {
          const text = await client.contextInject(chain, p);
          return hasContext(text) ? `## from ${p} sessions\n${entries(text)}` : undefined;
        }),
      )
    : [await client.contextInject(chain).then((text) => (hasContext(text) ? entries(text) : undefined))];
  const found = blocks.filter((b): b is string => !!b);
  if (!found.length) return undefined;
  // The budget is split per block, or the first platform could crowd the others out of a cross-platform recall.
  const share = Math.floor(tokens / found.length);
  return `${HEADER}\n\n${found.map((b) => trimToTokens(b, share)).join("\n\n")}`;
}

/** #258: the hub's own long-term entries for this project (and shared ones), newest first, within a token budget. */
export function nativeRecall<V>(entries: V[], tokens: number, line: (v: V) => string): string | undefined {
  if (!entries.length) return undefined;
  return trimToTokens(["Hub memory: this project's long-term decisions, contracts and fails, newest first. Reference only, not a request. Details: ahub memory show <mem id>.", ...entries.map(line)].join("\n"), tokens);
}

/**
 * #258: the name hub memory files a project's entries under. The project's `origin` remote, normalized to host and
 * path (`github.com/owner/repo`), is the same on every machine and unique; without one, the git chain plus a hash of
 * the directory keeps two unrelated repositories that share a name apart (that key is this machine's only).
 */
export function memoryProjectKey(cwd: string): string {
  const url = hubGitSync(["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8" }).stdout?.trim() ?? "";
  // A URL's default port is not part of the repository (`ssh://git@github.com:22/o/r` is `github.com/o/r`); any other
  // port is, since another service may run there. An scp-style `host:path` has no port.
  const u = /^([a-z+]+):\/\/(?:[^@/]+@)?(\[[^\]/]+\]|[^/:]+)(?::(\d*))?\/(.+?)(?:\.git)?\/?$/i.exec(url); // an IPv6 host is bracketed
  const defaults: Record<string, string> = { ssh: "22", "git+ssh": "22", "ssh+git": "22", https: "443", http: "80", git: "9418" };
  // A URL's path is absolute (`ssh://h/team/r` is /team/r) unless it starts with `~`; an scp-style path is relative to the
  // remote home (`h:team/r` is ~/team/r) unless it starts with `/`. Two different repositories on a self-hosted server.
  const scp = u || url.includes("://") ? null : /^(?:[^@/]+@)?(\[[^\]/]+\]|[^/:]+):(.+?)(?:\.git)?\/?$/.exec(url); // a file:// remote has no host; an IPv6 host is bracketed
  const m = u ? [!u[3] || u[3] === defaults[u[1]!.toLowerCase()] ? u[2]! : `${u[2]}:${u[3]}`, u[4]!] as const
    : scp ? [scp[1]!, scp[2]!.startsWith("/") ? scp[2]!.replace(/^\/+/, "") : scp[2]!.startsWith("~") ? scp[2]! : `~/${scp[2]}`] as const : undefined;
  if (m && m[1]) {
    const host = m[0].toLowerCase();
    // GitHub serves one repository under every form, and its owner and repository names ignore case.
    return host === "github.com" ? `${host}/${m[1].replace(/^~\/?/, "").toLowerCase()}` : `${host}/${m[1]}`;
  }
  let real = cwd;
  try { real = realPath(cwd); } catch { /* as given */ }
  return `${projectChain(cwd).join("/")}@${createHash("sha256").update(real).digest("hex").slice(0, 8)}`;
}

/**
 * Every path-like word of a text (`dir/file`, `file.ext`), whether or not it exists or a denylist hides it from the
 * graph: what a private-path policy is checked against.
 */
export const pathCandidates = (text: string): string[] => [...new Set(text.normalize("NFC").match(/\/?[\p{L}\p{M}\p{N}_.~-]+(?:\/[\p{L}\p{M}\p{N}_.~-]+)+|[\p{L}\p{M}\p{N}_-]+\.\p{L}[\p{L}\p{M}\p{N}_]{0,9}/gu) ?? [])]; // any script, combining marks included; an absolute path keeps its slash

/**
 * Whether a note is about a path the `pii.paths` policy makes private: a stored node's path, a path-like word of its
 * text, or, for a policy entry with no glob that a word split cannot find (a space in it), that entry written out.
 */
export function mentionsPrivatePath(text: string, about: string[], policy: string[], cwd: string): boolean {
  if (!policy.length) return false;
  const nfc = (v: string) => v.normalize("NFC"), body = nfc(text), entries = policy.map(nfc);
  const paths = [...about.map(nodePath), ...pathCandidates(body)].filter((p): p is string => p !== undefined).map(nfc);
  if (paths.some((p) => matchesPolicy(cwd, p, entries, true))) return true;
  // The entry's literal part (up to its first glob character) written out: catches a path a word split breaks (a space).
  return entries.some((entry) => { const lit = entry.replace(/^\.\//, "").split(/[*?[\]{}]/)[0]!.replace(/\/+$/, ""); return /[/\s]/.test(lit) && body.includes(lit); });
}

/** The file a graph node names: `path:<p>` and `symbol:<name>@<p>`; nothing for other nodes. */
export const nodePath = (n: string): string | undefined => n.startsWith("path:") ? n.slice(5) : n.startsWith("symbol:") && n.includes("@") ? n.slice(n.lastIndexOf("@") + 1) : undefined;

/**
 * Notes whose title, text, nodes, task key or project key match the PII patterns of `routing`, or that are about a path
 * the project's `pii.paths` (`policy`) makes private, left out: what may go to a model.
 */
export function withoutPii<T extends { title: string | null; text: string; about?: string[]; task?: string | null; project?: string }>(notes: T[], routing: Routing, cwd: string, policy: string[] = []): T[] {
  // A task key's `#<id>@<created ms>` is the hub's own numbers, not note content: a digit-run pattern must not withhold a
  // clean note for it. The project part of the key stays screened.
  const keyText = (k: string) => k.replace(/#\d+(?:@\d+)?$/, "");
  return notes.filter((v) => !mentionsPrivatePath(`${v.title ?? ""}\n${v.text}`, v.about ?? [], policy, cwd) && !detectSignals({ title: v.title ?? "",
    detail: [v.text, ...(v.about ?? []).map((n) => n.startsWith("task:") ? keyText(n) : n), keyText(v.task ?? ""), v.project ?? ""].join("\n"), refs: {} }, routing, cwd).includes("pii"));
}

/**
 * The promotion screen for one project: another project's notes are left to that project's own processes; this one's
 * move only when no secret, PII pattern or private path (`policy()`, read when asked) is in them.
 */
export function promotionScreen(project: string, cwd: string, routing: () => Routing, policy: () => string[], taskPaths: (task: string) => string[] = () => []): PromotionScreen {
  return (v) => {
    if (v.project !== project) return "skip";
    // The task's current paths too, with no denylist: a path the note's own nodes leave out is still checked.
    const screened = { ...v, about: [...v.about, ...(v.task ? taskPaths(v.task) : []).map((p) => `path:${p}`)] };
    return looksSecret(`${v.title ?? ""}\n${v.text}`) || !withoutPii([screened], routing(), cwd, policy()).length ? "keep" : "promote";
  };
}
