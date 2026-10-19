import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { peerChildEnv, stopOwnedProcess, trackGroup } from "../hub/child-process.ts";
import { HUB, frame } from "../hub/envelope.ts";
import { BasePeer } from "../hub/peers.ts";
import type { Envelope } from "../hub/envelope.ts";

export interface ReviewerPrintUsage { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
export interface ReviewerIsolationReceipt {
  backend: string;
  version: string;
  binary: string;
  profile: string;
  readOnly: true;
  strictMcp: true;
  ephemeral: true;
  evidence: readonly string[];
}
export interface ReviewerPrepareContext {
  peer: string;
  cwd: string;
  sessionId: string;
  mcpConfig: string;
  systemPrompt: string;
  privatePaths: readonly string[];
  command?: readonly string[];
  signal: AbortSignal;
}
export interface ReviewerLaunch {
  command: readonly string[];
  args: readonly string[];
  isolation: ReviewerIsolationReceipt;
  /** Recheck the fixed producer's binary/config binding immediately before the model child is spawned. */
  current?: () => boolean;
  env?: NodeJS.ProcessEnv;
  cleanup?: () => void | Promise<void>;
}
export interface ReviewerBackend {
  id: string;
  prepare(context: ReviewerPrepareContext): Promise<ReviewerLaunch | { unavailable: string }>;
  usage?(event: unknown): ReviewerPrintUsage | undefined;
  failure?(event: unknown): "quota" | undefined;
}
export interface ReviewerFailure {
  task: number;
  head?: string;
  flowRevision?: number;
  cause: "start_failed" | "quota" | "no_verdict";
}

export interface ReviewerPrintOptions {
  cwd: string;
  command?: readonly string[];
  mcpConfig: string;
  systemPrompt: string;
  privatePaths?: readonly string[];
  watchdogMs: number;
  backend: ReviewerBackend;
  facts?(env: Envelope): string | undefined;
  verdictSince(task: number, since: number): boolean;
  onUsage?(usage: ReviewerPrintUsage, task: number): void;
  onUnavailable?(failure: ReviewerFailure, current: () => boolean): void | Promise<void>;
  log?(line: string): void;
}

// ponytail: 256 KiB per NDJSON frame and 4 MiB stdout per review child. Raise only with measured native receipts.
const MAX_REVIEW_FRAME_BYTES = 256 * 1024, MAX_REVIEW_OUTPUT_BYTES = 4 * 1024 * 1024;
class GroupCleanupError extends Error {}
type ReviewTarget = Omit<ReviewerFailure, "cause">;
interface ReviewBatch { targets: (ReviewTarget | undefined)[]; next: number; failures: ReviewerFailure[] }
const reviewTarget = (env: Envelope): ReviewTarget | undefined => {
  const task = reviewTask(env);
  if (task === undefined || env.private) return undefined;
  const revision = Number(env.refs?.reviewRevision);
  return { task, ...(typeof env.refs?.commit === "string" ? { head: env.refs.commit } : {}), ...(Number.isSafeInteger(revision) && revision > 0 ? { flowRevision: revision } : {}) };
};
const remainingFailures = (batch: ReviewBatch, start: number, cause: ReviewerFailure["cause"]): ReviewerFailure[] =>
  batch.targets.slice(start).flatMap(target => target ? [{ ...target, cause }] : []);
const reviewTask = (env: Envelope): number | undefined => {
  if (env.from !== HUB || env.kind !== "review") return undefined;
  const id = Number(env.refs?.task);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
};

export class ReviewerPrintPeer extends BasePeer {
  readonly hubNative = true;
  private generation = 0;
  private child: ChildProcess | undefined;
  private activeDeliveryId: string | undefined;
  private batch: ReviewBatch | undefined;
  private preparation: { abort: AbortController; done: Promise<ReviewerLaunch> } | undefined;
  private receipt: ReviewerIsolationReceipt | undefined;
  get isolationReceipt(): ReviewerIsolationReceipt | undefined { return this.receipt; }
  /** The task whose review the running child was started for (R4: the hub records `fresh` for its verdict). */
  reviewing: number | undefined;
  private reviewSeq = 0;
  /** Identifies the running child's authority over `task`; a replacement child for the same task gets a new token. */
  reviewToken(task: number): number | undefined { return this.reviewing === task ? this.reviewSeq : undefined; }

  constructor(id: string, private readonly opts: ReviewerPrintOptions) { super(id, opts.watchdogMs); }

  recoveryMetadata(): Record<string, unknown> { return { launch: { kind: "reviewer-print", peer: this.id } }; }

  async start(): Promise<void> {
    // A retained child means a review's process group was never confirmed gone: no new review beside it.
    if (this.child) throw new Error(`${this.id}: an earlier review's process group is still running; stop it first`);
    if (this.preparation) throw new Error(`${this.id}: reviewer preparation is still running`);
    this.receipt = undefined;
    const generation = ++this.generation;
    try {
      const launch = await this.prepare(randomUUID());
      try {
        if (generation !== this.generation || launch.current?.() === false) throw new Error("reviewer isolation changed before startup");
        this.receipt = launch.isolation;
      } finally { await launch.cleanup?.(); }
    } catch (error) { if (generation === this.generation) this.setState("offline"); throw error; }
    if (generation === this.generation) this.setState("idle");
  }

  async stop(reason?: string): Promise<void> {
    this.generation++; // fence before the first await: a late exit settles nothing
    this.receipt = undefined;
    this.batch = undefined;
    this.preparation?.abort.abort();
    await this.preparation?.done.catch(() => {});
    this.settle("needs_review", reason ?? "review stopped before settlement");
    if (this.child) this.setState("busy"); // unavailable, not offline, until the group is confirmed gone
    await this.kill(); // throws when the child could not be stopped; its handle is kept and the peer stays busy
    this.setState("offline");
  }

  protected override onWatchdog(): void { this.abortReview("review watchdog timeout"); }

  private abortReview(reason: "review watchdog timeout" | "review output limit exceeded"): void {
    const generation = ++this.generation, batch = this.batch, preparation = this.preparation;
    this.reviewing = undefined;
    this.receipt = undefined;
    this.clearWatchdog();
    preparation?.abort.abort();
    this.settle("needs_review", reason);
    // Revoke first, then confirm both preparation and the model's whole group are gone before fallback.
    void (async () => {
      if (preparation) await preparation.done.catch(() => {});
      if (generation !== this.generation) return;
      await this.kill();
      if (generation !== this.generation) return; // a person's stop owns the hold; never reroute it
      if (batch) await this.reportFailures([...batch.failures, ...remainingFailures(batch, batch.next, "no_verdict")], generation);
      if (generation === this.generation && this.state === "busy") { this.batch = undefined; super.onWatchdog(); }
    })().catch((error: Error) => this.opts.log?.(`[${this.id}] review cleanup failed, staying busy`));
  }

  async deliver(envs: Envelope[], deliveryId?: string): Promise<void> {
    if (this.state !== "idle") {
      if (deliveryId) this.delivery({ id: deliveryId, state: "failed_safe", reason: `${this.id} is ${this.state}` });
      throw new Error(`${this.id} is ${this.state}`);
    }
    const generation = ++this.generation;
    this.activeDeliveryId = deliveryId;
    this.batch = { targets: envs.map(reviewTarget), next: 0, failures: [] };
    this.setState("busy");
    if (deliveryId) this.delivery({ id: deliveryId, state: "accepted" });
    void this.run(envs, generation).catch((error: Error) => {
      if (generation !== this.generation) return;
      this.settle("needs_review", `reviewer failed: ${error.message}`);
      void this.kill().then(() => { if (generation === this.generation) { this.batch = undefined; this.setState("idle"); } }, () => undefined);
    });
  }

  private async run(envs: Envelope[], generation: number): Promise<void> {
    const missing: number[] = [];
    let started = false;
    const batch = this.batch!;
    const reroute = batch.failures;
    let failure: { state: "failed_safe" | "needs_review"; reason: string } | undefined;
    for (const [index, env] of envs.entries()) {
      batch.next = index;
      const task = reviewTask(env);
      if (task === undefined) continue; // a withdrawal or other notice: nothing to review
      if (env.private) { failure = { state: "needs_review", reason: "a private review is the person's, never a cloud reviewer's" }; break; }
      const since = Date.now();
      let result: { code: number | null; quota: boolean };
      try { result = await this.review(env, task, generation); }
      catch (error) {
        if (generation !== this.generation) return;
        if (error instanceof GroupCleanupError) {
          // Unavailable until a stop confirms the group gone: no new review runs beside the survivors.
          this.opts.log?.(`[${this.id}] review of task #${task}: ${error.message}`);
          this.settle("needs_review", `review process group still running: ${error.message}`);
          return;
        }
        // Once an earlier review in this batch ran, the batch had effects: hold it for a person, never requeue it.
        failure = { state: started ? "needs_review" : "failed_safe", reason: `reviewer could not start: ${(error as Error).message}` };
        reroute.push(...remainingFailures(batch, index, "start_failed"));
        batch.next = envs.length;
        break;
      }
      started = true;
      if (generation !== this.generation) return;
      let recorded = false;
      try { recorded = this.opts.verdictSince(task, since); } catch (error) { this.opts.log?.(`[${this.id}] verdict check for task #${task} failed: ${(error as Error).message}`); }
      if (!recorded) {
        missing.push(task);
        const target = batch.targets[index];
        if (target) reroute.push({ ...target, cause: result.quota ? "quota" : "no_verdict" });
        if (result.quota) {
          reroute.push(...remainingFailures(batch, index + 1, "quota"));
          batch.next = envs.length;
          break;
        }
      }
      batch.next = index + 1;
      if (result.code !== 0) this.opts.log?.(`[${this.id}] review of task #${task} exited ${result.code}`);
    }
    if (generation !== this.generation) return;
    this.clearWatchdog(); // the child is gone; keep busy while the host settles the remaining walk
    this.settle(failure?.state ?? (missing.length ? "needs_review" : "completed"), failure?.reason ?? (missing.length ? `no verdict recorded for task ${missing.map(id => `#${id}`).join(", ")}` : undefined));
    await this.reportFailures(reroute, generation);
    if (generation === this.generation) { this.batch = undefined; this.setState("idle"); }
  }

  private async reportFailures(failures: readonly ReviewerFailure[], generation: number): Promise<void> {
    const seen = new Set<string>();
    for (const failed of failures) {
      if (generation !== this.generation) return;
      const identity = JSON.stringify([failed.task, failed.head, failed.flowRevision]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      try { await this.opts.onUnavailable?.(failed, () => generation === this.generation); }
      catch { this.opts.log?.(`[${this.id}] reviewer fallback could not be recorded; inspect the task`); }
    }
  }

  private prepare(sessionId: string): Promise<ReviewerLaunch> {
    const abort = new AbortController();
    const done = (async () => {
      const launch = await this.opts.backend.prepare({ peer: this.id, cwd: this.opts.cwd, sessionId, mcpConfig: this.opts.mcpConfig,
        systemPrompt: this.opts.systemPrompt, privatePaths: this.opts.privatePaths ?? [], command: this.opts.command, signal: abort.signal });
      if ("unavailable" in launch) throw new Error(launch.unavailable);
      const proof = launch.isolation;
      if (abort.signal.aborted || !proof || proof.backend !== this.opts.backend.id || proof.readOnly !== true || proof.strictMcp !== true || proof.ephemeral !== true || !proof.binary || !proof.version || !proof.profile || !proof.evidence.length || !launch.command.length) {
        await launch.cleanup?.();
        throw new Error("reviewer isolation is unavailable or preparation was cancelled");
      }
      return launch;
    })();
    const pending = { abort, done };
    this.preparation = pending;
    void done.finally(() => { if (this.preparation === pending) this.preparation = undefined; }).catch(() => {});
    return done;
  }

  private async review(env: Envelope, task: number, generation: number): Promise<{ code: number | null; quota: boolean }> {
    const launch = await this.prepare(randomUUID());
    try {
    if (generation !== this.generation || launch.current?.() === false) throw new Error("reviewer isolation changed before child spawn");
    this.receipt = launch.isolation;
    const [cmd, ...prefix] = launch.command;
    let quota = false;
    return await new Promise<{ code: number | null; quota: boolean }>((resolve, reject) => {
      const child = spawn(cmd!, [...prefix, ...launch.args], { cwd: this.opts.cwd, detached: true, env: peerChildEnv(this.id, { ...process.env, ...launch.env }), stdio: ["pipe", "pipe", "ignore"] });
      // Owned before any await, so a stop that lands before "spawn" still finds and kills it.
      this.child = child;
      child.once("error", error => { if (this.child === child) this.child = undefined; reject(error); });
      child.stdin!.on("error", () => { /* the child exited before reading its prompt; its exit settles the review */ });
      child.once("spawn", () => {
        trackGroup(child);
        if (generation !== this.generation) { child.stdin!.destroy(); return; } // stopped meanwhile: no prompt
        this.reviewing = task; this.reviewSeq++;
        let facts: string | undefined;
        try { facts = this.opts.facts?.(env); } catch (error) { this.opts.log?.(`[${this.id}] review facts for task #${task} failed: ${(error as Error).message}`); }
        child.stdin!.end(`${frame(env)}${facts ? `\n\n${facts}` : ""}`);
      });
      let buffer = "", outputBytes = 0;
      child.stdout!.on("data", (chunk: Buffer) => {
        if (generation !== this.generation) return;
        outputBytes += chunk.length;
        if (outputBytes > MAX_REVIEW_OUTPUT_BYTES) { this.abortReview("review output limit exceeded"); return; }
        buffer += chunk.toString("utf8");
        for (let i; (i = buffer.indexOf("\n")) >= 0;) {
          const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
          if (Buffer.byteLength(line) > MAX_REVIEW_FRAME_BYTES) { this.abortReview("review output limit exceeded"); return; }
          try {
            const event: unknown = JSON.parse(line);
            const usage = this.opts.backend.usage?.(event);
            if (usage) this.opts.onUsage?.(usage, task);
            if (this.opts.backend.failure?.(event) === "quota") quota = true;
          } catch { /* not a stream-json line */ }
        }
        if (Buffer.byteLength(buffer) > MAX_REVIEW_FRAME_BYTES) { this.abortReview("review output limit exceeded"); return; }
        this.touch();
      });
      child.once("exit", code => {
        if (this.child === child) this.reviewing = undefined; // the verdict authority ends with the leader
        // The review ends when its whole process group is gone (an MCP server or other descendant may outlive the leader).
        stopOwnedProcess(child, { group: true }).then(() => { if (this.child === child) this.child = undefined; resolve({ code, quota }); },
          (error: Error) => reject(new GroupCleanupError(error.message)));
      });
    });
    } finally {
      try { await launch.cleanup?.(); }
      catch { this.opts.log?.(`[${this.id}] reviewer isolation cleanup incomplete`); }
    }
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
