import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { childEnv, stopOwnedProcess } from "../hub/child-process.ts";
import { ControlClient } from "../hub/control-client.ts";
import { readEvents } from "../hub/events.ts";
import { taskRecords } from "../hub/research.ts";
import { appendBench, BENCH_SCHEMA, parseSuite, suiteHash, type Attempt, type AttemptError, type AttemptMetrics, type Fingerprint, type Outcome, type SuiteTask } from "../hub/bench.ts";
import { hubHome, realPath } from "../hub/project.ts";
import { processSignature } from "../pi/process-signature.ts";
import { VERSION } from "../version.ts";

/** What the runner needs from the world, so tests can drive it without a terminal. */
export interface BenchIo {
  /**
   * A shell command in the project, in its own process group, bounded: when the bound passes or `stopped()` turns true
   * the whole group is stopped, and whatever the command left running is stopped when it exits. Output is never kept.
   */
  sh(command: string, cwd: string, timeoutMs: number, stopped?: () => boolean): Promise<{ code: number | null; timedOut: boolean; interrupted: boolean }>;
  connect(): Promise<ControlClient>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}
export interface BenchOptions { cwd: string; stateDir: string; suitePath: string; arm: string; repeat: number; only?: string[]; home?: string; pollMs?: number; verifyTimeoutMs?: number; setupTimeoutMs?: number; settleMs?: number; stopped?: () => boolean }

const fail = (message: string): never => { throw new Error(message); };

/** Commands git runs without a shell; the arguments are ours, never suite text. */
async function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
  return { code, out: out.trim() };
}

export const defaultIo = (stateDir: string, cwd: string): BenchIo => ({
  sh: async (command, dir, timeoutMs, stopped) => {
    const p = spawn("sh", ["-c", command], { cwd: dir, detached: true, stdio: "ignore", env: childEnv() });
    let code: number | null | undefined;
    const exited = new Promise<void>((resolve) => p.once("exit", (c) => { code = c; resolve(); }));
    const end = Date.now() + timeoutMs;
    let timedOut = false, interrupted = false;
    while (code === undefined) {
      if (Date.now() >= end) { timedOut = true; break; }
      if (stopped?.()) { interrupted = true; break; }
      await Promise.race([exited, Bun.sleep(Math.min(200, Math.max(1, end - Date.now())))]);
    }
    // The whole group, also what a finished command left behind: nothing may run on into the next attempt's tree.
    await stopOwnedProcess(p, { group: true, killMs: 500 }).catch(() => {
      // Members still hold the group id, so it cannot belong to anyone else yet.
      try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ }
    });
    return { code: timedOut || interrupted ? null : code ?? null, timedOut, interrupted };
  },
  connect: () => ControlClient.connect(stateDir, { role: "console", projectRoot: cwd }),
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
  log: (line) => console.log(line),
});

/** The preconditions a run checks before it changes anything; each refusal says why. */
export async function benchPreflight(cwd: string, enabled: boolean, refs: string[] = []): Promise<string> {
  if (!enabled) throw new Error('benchmarks are off for this project: set "bench": { "enabled": true } in .agenthub/config.json of a project kept for benchmarks (each attempt resets its work tree)');
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) throw new Error("a benchmark project must be a git repository");
  // A checkout and a clean act on the whole repository: a project in a subdirectory would reset what lies outside it.
  if (realPath(top.out) !== realPath(cwd)) throw new Error(`a benchmark project must be the root of its git repository (${top.out} is), since a reset acts on the whole repository`);
  // The hub's own files must not change under it: a checkout would replace tracked ones, or write them from a ref.
  if ((await git(cwd, ["ls-files", "--", ".agenthub"])).out) throw new Error("this repository tracks files under .agenthub/, which a reset would replace; in a bench project untrack them (git rm -r --cached .agenthub, then ignore it) and commit");
  for (const ref of refs) {
    const commit = await git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
    if (commit.code !== 0) throw new Error(`suite ref ${ref} is not a commit in this repository`);
    if ((await git(cwd, ["ls-tree", "-r", "--name-only", commit.out, "--", ".agenthub"])).out) throw new Error(`suite ref ${ref} tracks files under .agenthub/, which a reset to it would write over the hub's own; use a ref without them`);
  }
  const dirty = await git(cwd, ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).agenthub"]);
  if (dirty.code !== 0 || dirty.out) throw new Error("the work tree has changes; commit or remove them first (a run resets the tree between attempts)");
  const branch = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return branch.code === 0 && branch.out ? branch.out : (await git(cwd, ["rev-parse", "HEAD"])).out;
}

/** Reset the tree to `ref` and prove it clean: a nested repository or a modified submodule survives a plain clean. */
async function reset(cwd: string, ref: string, detach = true): Promise<boolean> {
  if ((await git(cwd, ["checkout", "--quiet", "--force", ...(detach ? ["--detach"] : []), "--end-of-options", ref])).code !== 0) return false;
  if ((await git(cwd, ["clean", "-fdxq", "-e", ".agenthub"])).code !== 0) return false;
  const left = await git(cwd, ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).agenthub"]);
  return left.code === 0 && !left.out;
}

/**
 * The #247 measures of the attempt's task, the one with this id proposed last (an events file may keep an earlier task
 * with the same id). The turn that approved it ends after the approval and its usage arrives later still, so this waits
 * until every turn started by then has ended, at most `settleMs`, then one poll more. Unapproved tasks have no record.
 */
export async function metricsOf(opts: Pick<BenchOptions, "stateDir" | "settleMs" | "pollMs">, io: Pick<BenchIo, "now" | "sleep">, projectId: string, task: number): Promise<AttemptMetrics | null> {
  const events = () => readEvents(join(opts.stateDir, "events.jsonl"));
  const approvedAt = (all: ReturnType<typeof events>) => all.filter((e) => e.type === "task" && e.id === task && e.state === "approved").at(-1)?.at;
  const until = io.now() + (opts.settleMs ?? 600_000);
  for (;;) {
    const all = events(), at = approvedAt(all);
    if (!at) break;
    const ended = new Set(all.flatMap((e) => e.type === "turn_end" ? [`${e.peer}\0${e.turn}`] : []));
    const open = all.some((e) => e.type === "turn_start" && e.at <= at && !ended.has(`${e.peer}\0${e.turn}`));
    if (!open || io.now() >= until) break;
    await io.sleep(opts.pollMs ?? 2000);
  }
  await io.sleep(opts.pollMs ?? 2000); // the last usage of a turn lands a moment after its end
  const all = events();
  const proposed = all.filter((e) => e.type === "task" && e.id === task && e.event === "proposed").at(-1)?.at;
  const r = taskRecords(all, projectId, { version: VERSION, source: "live" }).find((x) => x.task === task && x.createdAt === proposed);
  return r ? { tokens: r.tokens.total, wallMs: r.wallMs, activeMs: r.activeMs, reviewRounds: r.reviewRounds, changesRequested: r.changesRequested,
    checkFailed: r.checkFailed, firstPass: r.firstPass, turns: r.turns, filesChanged: r.filesChanged, models: r.models } : null;
}

/**
 * #251: run a suite against the peers attached to this project's hub, one attempt at a time. Each attempt resets the
 * tree to the task's ref, runs its setup, proposes the task as the console does, waits until it is approved or its
 * time is up, then runs its verify command in the tree the agents left. Returns the run id.
 * ponytail: a task that times out stops the run, since an agent may still be working in the tree the next attempt
 * would reset; withdrawing an open task (a board state for it) would let the run continue.
 */
export async function runBench(opts: BenchOptions, io: BenchIo): Promise<string> {
  const suiteText = readFileSync(opts.suitePath, "utf8");
  const suite = parseSuite(suiteText);
  // --tasks also sets the order, so a person can randomize it per run (docs/bench.md).
  const tasks = opts.only?.length ? opts.only.map((id) => suite.tasks.find((t) => t.id === id) ?? fail(`--tasks names ${id}, which the suite does not have`)) : suite.tasks;
  const original = await benchPreflight(opts.cwd, true, [...new Set(tasks.map((t) => t.ref))]);
  const hub = await io.connect();
  const run = `${new Date(io.now()).toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 8)}`;
  const home = opts.home ?? hubHome();
  try {
    const status = (await hub.request({ t: "status" }, 5000)).status as { projectId: string; version: string; peers: Record<string, { state: string; requestedModel?: string; permissionMode?: string }> };
    const routing = join(opts.cwd, ".agenthub", "routing.toml");
    const fingerprint: Fingerprint = {
      // ponytail: the hub's status reports a requested model for Pi only and permission modes once #242 lands; the rest
      // are recorded as absent. Reading each peer's launch settings would fill them in.
      peers: Object.entries(status.peers ?? {}).map(([id, p]) => ({ id, ...(p.requestedModel ? { model: p.requestedModel } : {}), ...(p.permissionMode ? { permissionMode: p.permissionMode } : {}) })).sort((a, b) => a.id.localeCompare(b.id)),
      routingHash: existsSync(routing) ? createHash("sha256").update(readFileSync(routing)).digest("hex") : null,
      hubVersion: status.version,
    };
    appendBench({ schema: BENCH_SCHEMA, kind: "run", run, suite: suite.name, suiteHash: suiteHash(suiteText), arm: opts.arm, fingerprint, version: VERSION,
      startedAt: new Date(io.now()).toISOString(), tasks: tasks.length, repeats: opts.repeat, order: tasks.map((t) => t.id), runner: { pid: process.pid, signature: processSignature(process.pid) ?? null } }, home);
    io.log(`bench run ${run}: ${suite.name} [${opts.arm}], ${tasks.length} task${tasks.length === 1 ? "" : "s"} x ${opts.repeat}`);
    let stopped: "timeout" | "interrupted" | "error" | undefined;
    outer: for (let repeat = 1; repeat <= opts.repeat; repeat++) {
      for (const task of tasks) {
        if (opts.stopped?.()) { stopped = "interrupted"; break outer; }
        const attempt = await runAttempt(task, repeat, run, opts, io, hub, status.projectId);
        appendBench(attempt, home);
        io.log(`  ${task.id} #${repeat}: ${attempt.outcome}${attempt.error ? ` (${attempt.error})` : ""}`);
        const open = () => { if (attempt.hubTask !== null) io.log(`  task #${attempt.hubTask} is still open on the board; settle it before the next run`); };
        if (attempt.outcome === "timeout") { stopped = "timeout"; open(); break outer; }
        if (attempt.error === "interrupted") { stopped = "interrupted"; open(); break outer; }
        if (attempt.error === "hub stopped" || attempt.error === "reset failed") { stopped = "error"; open(); break outer; }
      }
    }
    if (!stopped) await reset(opts.cwd, original, false); // back on the branch it started on
    appendBench({ schema: BENCH_SCHEMA, kind: "end", run, endedAt: new Date(io.now()).toISOString(), ...(stopped ? { stopped } : {}) }, home);
    return run;
  } finally { hub.close(); }
}

async function runAttempt(task: SuiteTask, repeat: number, run: string, opts: BenchOptions, io: BenchIo, hub: ControlClient, projectId: string): Promise<Attempt> {
  const started = io.now();
  const done = (outcome: Outcome, extra: { error?: AttemptError; verifyExit?: number | null; hubTask?: number | null; metrics?: AttemptMetrics | null } = {}): Attempt => ({
    schema: BENCH_SCHEMA, kind: "attempt", run, task: task.id, repeat, outcome, ...(extra.error ? { error: extra.error } : {}), verifyExit: extra.verifyExit ?? null,
    hubTask: extra.hubTask ?? null, startedAt: new Date(started).toISOString(), endedAt: new Date(io.now()).toISOString(), ms: io.now() - started, metrics: extra.metrics ?? null });
  if (!(await reset(opts.cwd, task.ref))) return done("error", { error: "reset failed" });
  if (task.setup) {
    const setup = await io.sh(task.setup, opts.cwd, opts.setupTimeoutMs ?? 300_000, opts.stopped);
    if (setup.interrupted) return done("error", { error: "interrupted" });
    if (setup.timedOut) return done("error", { error: "setup timeout" });
    if (setup.code !== 0) return done("error", { error: "setup failed" });
  }
  let id: number;
  try {
    const reply = await hub.request({ t: "task", op: "hub_task_propose", args: { title: task.title, ...(task.detail ? { detail: task.detail } : {}), class: task.class ?? "implement", ...(task.owner ? { owner: task.owner } : {}) } }, 30_000);
    const match = reply.ok ? /^task #(\d+)/.exec(String(reply.text ?? "")) : null;
    if (!match) { io.log(`  ${task.id}: the hub refused the task: ${reply.error ?? "no task id in its reply"}`); return done("error", { error: "propose refused" }); }
    id = Number(match[1]);
  } catch { return done("error", { error: "hub stopped" }); }
  const deadline = started + task.timeout_s * 1000;
  for (;;) {
    let state: string | undefined;
    try {
      const list = await hub.request({ t: "task", op: "hub_task_list", args: {} }, 15_000);
      if (!list.ok) return done("error", { error: "hub stopped", hubTask: id });
      state = (JSON.parse(String(list.text)) as { id: number; state: string }[]).find((t) => t.id === id)?.state;
    } catch { return done("error", { error: "hub stopped", hubTask: id }); }
    if (state === "approved") break;
    if (opts.stopped?.()) return done("error", { error: "interrupted", hubTask: id });
    if (io.now() >= deadline) return done("timeout", { hubTask: id });
    await io.sleep(opts.pollMs ?? 2000);
  }
  const verify = await io.sh(task.verify, opts.cwd, opts.verifyTimeoutMs ?? 600_000, opts.stopped);
  if (verify.interrupted) return done("error", { error: "interrupted", hubTask: id });
  const metrics = await metricsOf(opts, io, projectId, id);
  if (verify.timedOut) return done("fail", { error: "verify timeout", hubTask: id, metrics });
  return done(verify.code === 0 ? "pass" : "fail", { verifyExit: verify.code, hubTask: id, metrics });
}
