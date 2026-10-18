import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { childEnv, peerChildEnv, stopOwnedProcess, trackGroup } from "../hub/child-process.ts";
import { hubGitSync } from "../hub/git.ts";
import { HUB, frame, type Envelope } from "../hub/envelope.ts";
import { BasePeer } from "../hub/peers.ts";

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
  const git = (args: string[]) => hubGitSync(["-C", cwd, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--relative", ...args], { encoding: "utf8", env: childEnv(process.env), maxBuffer: 16 * 1024 * 1024, timeout: 15_000 });
  const unavailable = `Diff of ${commit} unavailable here; read the changed files with Read and Grep.`;
  // Paths first: a private file (both sides of a rename, since renames are split) never reaches the diff.
  const names = git(["--name-only", "-z", `HEAD...${commit}`, "--"]);
  if (names.status !== 0 || typeof names.stdout !== "string") return unavailable;
  const changed = names.stdout.split("\0").filter(Boolean);
  const shown = changed.filter(path => !policy.privatePath(path));
  const hidden = changed.length - shown.length;
  const note = hidden ? `\n[${hidden} changed file(s) withheld by the project's privacy policy]` : "";
  if (!shown.length) return `Diff of ${commit}: no changed file can be shown.${note}`;
  const r = git(["--stat", "--patch", `HEAD...${commit}`, "--", ...shown.map(path => `:(literal)${path}`)]);
  if (r.status !== 0 || typeof r.stdout !== "string") return unavailable;
  if (!policy.nameable(r.stdout)) return `Diff of ${commit} withheld: it matches a private-data pattern. Read the changed files with Read and Grep.${note}`;
  const bytes = Buffer.from(r.stdout, "utf8");
  const body = bytes.length > DIFF_CAP ? `${bytes.subarray(0, DIFF_CAP).toString("utf8")}\n[diff cut at ${DIFF_CAP} of ${bytes.length} bytes; read the rest with Read and Grep]` : r.stdout;
  return `Diff of ${commit} against its merge base with the checkout's HEAD:\n${body}${note}`;
}

const reviewTask = (env: Envelope): number | undefined => {
  if (env.from !== HUB || env.kind !== "review") return undefined;
  const id = Number(env.refs?.task);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
};

/**
 * #223 R3: a hub-native Claude reviewer. Idle with no process; each hub review request runs one `claude -p` child in a
 * new session (never resumed), so no verdict sees an earlier round or builder chat. Its final text is not published:
 * the verdict is the child's own `hub_review` call.
 */
export class ClaudePrintPeer extends BasePeer {
  readonly hubNative = true;
  private generation = 0;
  private child: ChildProcess | undefined;
  private activeDeliveryId: string | undefined;
  /** The task whose review the running child was started for (R4: the hub records `fresh` for its verdict). */
  reviewing: number | undefined;

  constructor(id: string, private readonly opts: ClaudePrintOptions) { super(id, opts.watchdogMs); }

  recoveryMetadata(): Record<string, unknown> { return { launch: { kind: "claude-print", peer: this.id } }; }

  async start(): Promise<void> { this.setState("idle"); }

  async stop(reason?: string): Promise<void> {
    this.generation++; // fence before the first await: a late exit settles nothing
    this.settle("needs_review", reason ?? "review stopped before settlement");
    this.setState("offline");
    await this.kill(); // throws when the child could not be stopped; its handle is kept
  }

  protected override onWatchdog(): void {
    this.generation++;
    this.settle("needs_review", "review watchdog timeout");
    // Busy until the old child is gone: a new review never runs beside it.
    void this.kill().then(() => { if (this.state === "busy") super.onWatchdog(); }, (error: Error) => this.opts.log?.(`[${this.id}] watchdog stop failed, staying busy: ${error.message}`));
  }

  async deliver(envs: Envelope[], deliveryId?: string): Promise<void> {
    if (this.state !== "idle") {
      if (deliveryId) this.delivery({ id: deliveryId, state: "failed_safe", reason: `${this.id} is ${this.state}` });
      throw new Error(`${this.id} is ${this.state}`);
    }
    const generation = ++this.generation;
    this.activeDeliveryId = deliveryId;
    this.setState("busy");
    if (deliveryId) this.delivery({ id: deliveryId, state: "accepted" });
    void this.run(envs, generation).catch((error: Error) => {
      if (generation !== this.generation) return;
      this.settle("needs_review", `claude reviewer failed: ${error.message}`);
      void this.kill().then(() => this.setState("idle"), () => undefined);
    });
  }

  private async run(envs: Envelope[], generation: number): Promise<void> {
    const missing: number[] = [];
    let started = false;
    let failure: { state: "failed_safe" | "needs_review"; reason: string } | undefined;
    for (const env of envs) {
      const task = reviewTask(env);
      if (task === undefined) continue; // a withdrawal or other notice: nothing to review
      if (env.private) { failure = { state: "needs_review", reason: "a private review is the person's, never a cloud reviewer's" }; break; }
      const since = Date.now();
      let code: number | null;
      try { code = await this.review(env, task, generation); }
      // Once an earlier review in this batch ran, the batch had effects: hold it for a person, never requeue it.
      catch (error) { failure = { state: started ? "needs_review" : "failed_safe", reason: `claude reviewer could not start: ${(error as Error).message}` }; break; }
      started = true;
      if (generation !== this.generation) return;
      let recorded = false;
      try { recorded = this.opts.verdictSince(task, since); } catch (error) { this.opts.log?.(`[${this.id}] verdict check for task #${task} failed: ${(error as Error).message}`); }
      if (!recorded) missing.push(task);
      if (code !== 0) this.opts.log?.(`[${this.id}] review of task #${task} exited ${code}`);
    }
    if (generation !== this.generation) return;
    this.settle(failure?.state ?? (missing.length ? "needs_review" : "completed"), failure?.reason ?? (missing.length ? `no verdict recorded for task ${missing.map(id => `#${id}`).join(", ")}` : undefined));
    this.setState("idle");
  }

  private review(env: Envelope, task: number, generation: number): Promise<number | null> {
    const [cmd = "claude", ...prefix] = this.opts.command ?? ["claude"];
    const args = [...prefix, ...claudePrintArgs(randomUUID(), this.opts.mcpConfig, this.opts.systemPrompt, this.opts.privatePaths)];
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: this.opts.cwd, detached: true, env: peerChildEnv(this.id), stdio: ["pipe", "pipe", "ignore"] });
      // Owned before any await, so a stop that lands before "spawn" still finds and kills it.
      this.child = child;
      child.once("error", error => { if (this.child === child) this.child = undefined; reject(error); });
      child.stdin!.on("error", () => { /* the child exited before reading its prompt; its exit settles the review */ });
      child.once("spawn", () => {
        trackGroup(child);
        if (generation !== this.generation) { child.stdin!.destroy(); return; } // stopped meanwhile: no prompt
        this.reviewing = task;
        let facts: string | undefined;
        try { facts = this.opts.facts?.(env); } catch (error) { this.opts.log?.(`[${this.id}] review facts for task #${task} failed: ${(error as Error).message}`); }
        child.stdin!.end(`${frame(env)}${facts ? `\n\n${facts}` : ""}`);
      });
      let buffer = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        if (generation !== this.generation) return;
        this.touch();
        buffer += chunk.toString("utf8");
        for (let i; (i = buffer.indexOf("\n")) >= 0;) {
          const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
          try {
            const event = JSON.parse(line) as { type?: string; usage?: ClaudePrintUsage };
            if (event.type === "result" && event.usage) this.opts.onUsage?.(event.usage, task);
          } catch { /* not a stream-json line */ }
        }
      });
      child.once("exit", code => {
        if (this.child === child) { this.child = undefined; this.reviewing = undefined; }
        resolve(code);
      });
    });
  }

  private settle(state: "completed" | "failed_safe" | "needs_review", reason?: string): void {
    const id = this.activeDeliveryId;
    this.activeDeliveryId = undefined;
    if (id) this.delivery({ id, state, ...(reason ? { reason } : {}) });
  }

  /** Revokes the verdict authority at once, then stops the child; on failure the handle is kept and the error thrown. */
  private async kill(): Promise<void> {
    this.reviewing = undefined;
    const child = this.child;
    if (!child) return;
    await stopOwnedProcess(child, { group: true });
    if (this.child === child) this.child = undefined;
  }
}
