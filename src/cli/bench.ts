import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient } from "../hub/control-client.ts";
import { readEvents } from "../hub/events.ts";
import { taskRecords } from "../hub/research.ts";
import { appendBench, BENCH_SCHEMA, parseSuite, suiteHash, type Attempt, type AttemptError, type AttemptMetrics, type Fingerprint, type Outcome, type SuiteTask } from "../hub/bench.ts";
import { hubHome } from "../hub/project.ts";
import { processSignature } from "../pi/process-signature.ts";
import { VERSION } from "../version.ts";

/** What the runner needs from the world, so tests can drive it without a terminal. */
export interface BenchIo {
  /** A shell command in the project, bounded; `timedOut` when the bound killed it. Output is never kept. */
  sh(command: string, cwd: string, timeoutMs: number): Promise<{ code: number | null; timedOut: boolean }>;
  connect(): Promise<ControlClient>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}
export interface BenchOptions { cwd: string; stateDir: string; suitePath: string; arm: string; repeat: number; only?: string[]; home?: string; pollMs?: number; verifyTimeoutMs?: number; setupTimeoutMs?: number; stopped?: () => boolean }

const fail = (message: string): never => { throw new Error(message); };

/** Commands git runs without a shell; the arguments are ours, never suite text. */
async function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
  return { code, out: out.trim() };
}

export const defaultIo = (stateDir: string, cwd: string): BenchIo => ({
  sh: async (command, dir, timeoutMs) => {
    const p = Bun.spawn(["sh", "-c", command], { cwd: dir, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, timeoutMs);
    const code = await p.exited;
    clearTimeout(timer);
    return { code: timedOut ? null : code, timedOut };
  },
  connect: () => ControlClient.connect(stateDir, { role: "console", projectRoot: cwd }),
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
  log: (line) => console.log(line),
});

/** The preconditions a run checks before it changes anything; each refusal says why. */
export async function benchPreflight(cwd: string, enabled: boolean): Promise<string> {
  if (!enabled) throw new Error('benchmarks are off for this project: set "bench": { "enabled": true } in .agenthub/config.json of a project kept for benchmarks (each attempt resets its work tree)');
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) throw new Error("a benchmark project must be a git repository");
  const dirty = await git(cwd, ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).agenthub"]);
  if (dirty.code !== 0 || dirty.out) throw new Error("the work tree has changes; commit or remove them first (a run resets the tree between attempts)");
  const branch = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return branch.code === 0 && branch.out ? branch.out : (await git(cwd, ["rev-parse", "HEAD"])).out;
}

async function reset(cwd: string, ref: string, detach = true): Promise<boolean> {
  if ((await git(cwd, ["checkout", "--quiet", "--force", ...(detach ? ["--detach"] : []), ref])).code !== 0) return false;
  return (await git(cwd, ["clean", "-fdxq", "-e", ".agenthub"])).code === 0;
}

const metricsOf = (stateDir: string, projectId: string, task: number): AttemptMetrics | null => {
  const r = taskRecords(readEvents(join(stateDir, "events.jsonl")), projectId, { version: VERSION, source: "live" }).filter((x) => x.task === task).at(-1);
  return r ? { tokens: r.tokens.total, wallMs: r.wallMs, activeMs: r.activeMs, reviewRounds: r.reviewRounds, changesRequested: r.changesRequested,
    checkFailed: r.checkFailed, firstPass: r.firstPass, turns: r.turns, filesChanged: r.filesChanged, models: r.models } : null;
};

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
  const original = await benchPreflight(opts.cwd, true);
  const hub = await io.connect();
  const run = `${new Date(io.now()).toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 8)}`;
  const home = opts.home ?? hubHome();
  try {
    const status = (await hub.request({ t: "status" }, 5000)).status as { projectId: string; version: string; peers: Record<string, { state: string; requestedModel?: string; permissionMode?: string }> };
    const routing = join(opts.cwd, ".agenthub", "routing.toml");
    const fingerprint: Fingerprint = {
      peers: Object.entries(status.peers ?? {}).map(([id, p]) => ({ id, state: p.state, ...(p.requestedModel ? { model: p.requestedModel } : {}), ...(p.permissionMode ? { permissionMode: p.permissionMode } : {}) })).sort((a, b) => a.id.localeCompare(b.id)),
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
        if (attempt.outcome === "timeout") { stopped = "timeout"; io.log(`  task #${attempt.hubTask} is still open on the board; settle it before the next run`); break outer; }
        if (attempt.error === "interrupted") { stopped = "interrupted"; io.log(`  task #${attempt.hubTask} is still open on the board; settle it before the next run`); break outer; }
        if (attempt.error === "hub stopped" || attempt.error === "reset failed") { stopped = "error"; break outer; }
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
    const setup = await io.sh(task.setup, opts.cwd, opts.setupTimeoutMs ?? 300_000);
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
    if (opts.stopped?.()) return done("error", { error: "interrupted", hubTask: id, metrics: metricsOf(opts.stateDir, projectId, id) });
    if (io.now() >= deadline) return done("timeout", { hubTask: id, metrics: metricsOf(opts.stateDir, projectId, id) });
    await io.sleep(opts.pollMs ?? 2000);
  }
  const verify = await io.sh(task.verify, opts.cwd, opts.verifyTimeoutMs ?? 600_000);
  const metrics = metricsOf(opts.stateDir, projectId, id);
  if (verify.timedOut) return done("fail", { error: "verify timeout", hubTask: id, metrics });
  return done(verify.code === 0 ? "pass" : "fail", { verifyExit: verify.code, hubTask: id, metrics });
}
