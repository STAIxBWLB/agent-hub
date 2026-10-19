import { childEnv } from "../hub/child-process.ts";
import { hubGitSync } from "../hub/git.ts";
import { changedPathGroups } from "../hub/review-brief.ts";
import { type Envelope } from "../hub/envelope.ts";
import { ReviewerPrintPeer, type ReviewerBackend, type ReviewerPrintOptions } from "./reviewer-print.ts";

export interface ClaudePrintUsage { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }

export interface ClaudePrintOptions {
  cwd: string;
  /** The native argv prefix; `claude` from PATH by default. */
  command?: readonly string[];
  /** The agent-hub MCP server in tools mode for this instance, as `--mcp-config` JSON. */
  mcpConfig: string;
  systemPrompt: string;
  /** pii.paths and local.deny entries, passed to Claude as Read deny rules. */
  privatePaths?: readonly string[];
  watchdogMs: number;
  /** Facts the hub adds to one review request (a bounded diff of its head); never the builder's narrative. */
  facts?(env: Envelope): string | undefined;
  /** Whether this peer recorded a verdict on the task since `since` (ms). */
  verdictSince(task: number, since: number): boolean;
  onUsage?(usage: ClaudePrintUsage, task: number): void;
  onUnavailable?: ReviewerPrintOptions["onUnavailable"];
  log?(line: string): void;
}

/** The flags that make each review a new, unpersisted session with read-only tools and only the verdict tools. */
export function claudePrintArgs(sessionId: string, mcpConfig: string, systemPrompt: string, privatePaths: readonly string[] = []): string[] {
  return ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--session-id", sessionId,
    "--strict-mcp-config", "--mcp-config", mcpConfig, "--setting-sources", "",
    "--tools", "Read,Grep,Glob", "--allowedTools", "mcp__agent-hub__hub_review", "mcp__agent-hub__hub_task_show", "Read", "Grep", "Glob",
    ...(privatePaths.length ? ["--disallowedTools", ...readDenyRules(privatePaths)] : []),
    "--permission-mode", "dontAsk", "--append-system-prompt", systemPrompt];
}

/**
 * Claude's own Read deny rules for the project's private paths (pii.paths, local.deny).
 * ponytail: Claude evaluates these, not the hub's path policy (no symlink or case-alias resolution); the hub's own
 * guarantee is that it never puts private content into the prompt. Run reviews of private-path work on-prem.
 */
export function readDenyRules(paths: readonly string[]): string[] {
  return paths.flatMap(entry => {
    const rule = entry.startsWith("/") ? `/${entry}` : `./${entry.replace(/^\.\//, "")}`;
    return /[*?]/.test(entry) ? [`Read(${rule})`] : [`Read(${rule})`, `Read(${rule.replace(/\/$/, "")}/**)`];
  });
}

const DIFF_CAP = 100_000;
/**
 * The review's head against its merge base with the project checkout's HEAD, bounded. Only a hex commit id is used.
 * ponytail: a fixed byte cap; the reviewer reads the rest of the files with Read/Grep, add a per-file summary if reviews
 * of large changes miss things.
 */
export function reviewDiff(cwd: string, commit: unknown, policy: { privatePath(path: string): boolean; nameable(text: string): boolean }): string | undefined {
  if (typeof commit !== "string" || !/^[0-9a-f]{7,40}$/i.test(commit)) return undefined;
  const git = (args: string[]) => hubGitSync(["-C", cwd, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--relative", ...args], { encoding: "utf8", env: childEnv(process.env), maxBuffer: 16 * 1024 * 1024, timeout: 15_000 });
  const unavailable = `Diff of ${commit} unavailable here; read the changed files with Read and Grep.`;
  // Paths first, as groups (both sides of a move or copy): a group is withheld whole when any side is private.
  const groups = changedPathGroups(cwd, commit);
  if (!groups) return unavailable;
  const changed = groups.map(g => g.paths);
  const shownGroups = changed.filter(group => !group.some(path => policy.privatePath(path)));
  const shown = shownGroups.flat();
  const hidden = changed.length - shownGroups.length;
  const note = hidden ? `\n[${hidden} changed file(s) withheld by the project's privacy policy]` : "";
  if (!shown.length) return `Diff of ${commit}: no changed file can be shown.${note}`;
  const r = git(["-M", "--stat", "--patch", `HEAD...${commit}`, "--", ...shown.map(path => `:(literal)${path}`)]);
  if (r.status !== 0 || typeof r.stdout !== "string") return unavailable;
  if (!policy.nameable(r.stdout)) return `Diff of ${commit} withheld: it matches a private-data pattern. Read the changed files with Read and Grep.${note}`;
  const bytes = Buffer.from(r.stdout, "utf8");
  const body = bytes.length > DIFF_CAP ? `${bytes.subarray(0, DIFF_CAP).toString("utf8")}\n[diff cut at ${DIFF_CAP} of ${bytes.length} bytes; read the rest with Read and Grep]` : r.stdout;
  return `Diff of ${commit} against its merge base with the checkout's HEAD:\n${body}${note}`;
}

export const claudeReviewerBackend: ReviewerBackend = {
  id: "claude",
  prepare: async context => ({ command: context.command ?? ["claude"],
    args: claudePrintArgs(context.sessionId, context.mcpConfig, context.systemPrompt, context.privatePaths),
    isolation: { backend: "claude", version: "existing-223-contract", binary: (context.command ?? ["claude"])[0]!, profile: "strict-mcp-read-grep-glob",
      readOnly: true, strictMcp: true, ephemeral: true, evidence: ["#223 fixed native allowlist, strict MCP config and unpersisted session"] } }),
  usage: event => {
    const row = event as { type?: string; usage?: ClaudePrintUsage } | null;
    return row?.type === "result" ? row.usage : undefined;
  },
};

/** Compatibility wrapper for the released Claude transport and its existing tests. */
export class ClaudePrintPeer extends ReviewerPrintPeer {
  constructor(id: string, options: ClaudePrintOptions) { super(id, { ...options, backend: claudeReviewerBackend }); }
  override recoveryMetadata(): Record<string, unknown> { return { launch: { kind: "claude-print", peer: this.id } }; }
}
