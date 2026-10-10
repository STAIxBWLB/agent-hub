import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { childEnv, stopOwnedProcess, trackGroup } from "../hub/child-process.ts";
import { ControlClient } from "../hub/control-client.ts";
import { readEvents } from "../hub/events.ts";
import { hubGitArgv, hubGitEnv } from "../hub/git.ts";
import { taskRecords } from "../hub/research.ts";
import { appendBench, BENCH_SCHEMA, parseSuite, suiteHash, type Attempt, type AttemptError, type AttemptMetrics, type Fingerprint, type Outcome, type SuiteTask } from "../hub/bench.ts";
import { hubHome, realPath } from "../hub/project.ts";
import { processSignature } from "../pi/process-signature.ts";
import { VERSION } from "../version.ts";

/** What the runner needs from the world, so tests can drive it without a terminal. */
export interface BenchIo {
  /**
   * A shell command in the project, in its own process group, bounded: when the bound passes or `stopped()` turns true
   * the group is stopped, and whatever the command left running in its group is stopped when it exits. Output is never
   * kept. A command that cannot be started reads as a failure (code -1).
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
  const p = Bun.spawn(hubGitArgv(args), { cwd, stdout: "pipe", stderr: "ignore", env: hubGitEnv() });
  const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
  return { code, out: out.trim() };
}

export const defaultIo = (stateDir: string, cwd: string): BenchIo => ({
  sh: async (command, dir, timeoutMs, stopped) => {
    const p = spawn("sh", ["-c", command], { cwd: dir, detached: true, stdio: "ignore", env: childEnv() });
    trackGroup(p);
    let code: number | null | undefined;
    const exited = new Promise<void>((resolve) => {
      p.once("exit", (c) => { code = c; resolve(); });
      p.once("error", () => { code = -1; resolve(); }); // it never started (a missing directory, no shell)
    });
    const end = Date.now() + timeoutMs;
    let timedOut = false, interrupted = false;
    while (code === undefined) {
      if (Date.now() >= end) { timedOut = true; break; }
      if (stopped?.()) { interrupted = true; break; }
      await Promise.race([exited, Bun.sleep(Math.min(200, Math.max(1, end - Date.now())))]);
    }
    // The whole group, also what a finished command left behind in it: nothing may run on into the next attempt's tree.
    await stopOwnedProcess(p, { group: true, killMs: 500 }).catch((error: Error) => {
      // ponytail: only when the stop lists the members the exited leader left (they hold the group id, so it is still
      // ours) is the group killed outright; any other refusal (not provably ours, an unreadable process table) leaves
      // it alone and says so. A leader start-time record at spawn would let stopOwnedProcess sweep it itself.
      if (/still has members \(/.test(error.message)) try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ }
      else console.error(`  bench: a command's process group could not be stopped and may still run in the tree (${error.message})`);
    });
    return { code: timedOut || interrupted ? null : code ?? null, timedOut, interrupted };
  },
  connect: () => ControlClient.connect(stateDir, { role: "console", projectRoot: cwd }),
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
  log: (line) => console.log(line),
});

const TREE = ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude,icase).agenthub"];

/**
 * The preconditions a run checks before it changes anything; each refusal says why. Returns the branch (or commit) to
 * return to. `pinned` receives each suite ref's commit: a reset checks out that commit, never the name, which an
 * agent's own commit could move. `named` receives the full ref name of each one given as a plain branch or tag.
 */
export async function benchPreflight(cwd: string, enabled: boolean, refs: string[] = [], pinned: Map<string, string> = new Map(), named: Map<string, string> = new Map()): Promise<string> {
  if (!enabled) throw new Error('benchmarks are off for this project: set "bench": { "enabled": true } in .agenthub/config.json of a project kept for benchmarks (each attempt resets its work tree)');
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) throw new Error("a benchmark project must be a git repository");
  // A checkout and a clean act on the whole repository: a project in a subdirectory would reset what lies outside it.
  if (realPath(top.out) !== realPath(cwd)) throw new Error(`a benchmark project must be the root of its git repository (${top.out} is), since a reset acts on the whole repository`);
  // The hub's own files must not change under it: a checkout would replace tracked ones, or write them from a ref.
  // Matched without case, since a case-insensitive disk opens `.AGENTHUB/config.json` as `.agenthub/config.json`.
  const tracked = await git(cwd, ["ls-files", "--", ":(icase).agenthub"]);
  if (tracked.code !== 0 || tracked.out) throw new Error("this repository tracks files under .agenthub/, which a reset would replace; in a bench project untrack them (git rm -r --cached .agenthub, then ignore it) and commit");
  for (const ref of refs) {
    const commit = await git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
    if (commit.code !== 0 || !/^[0-9a-f]{40,64}$/.test(commit.out)) throw new Error(`suite ref ${ref} is not a commit in this repository`);
    const names = await git(cwd, ["ls-tree", "--name-only", commit.out]);
    if (names.code !== 0 || names.out.split("\n").some((name) => name.toLowerCase() === ".agenthub")) {
      throw new Error(`suite ref ${ref} tracks files under .agenthub/, which a reset to it would write over the hub's own; use a commit made after .agenthub was untracked, or rebuild the ref without that directory`);
    }
    pinned.set(ref, commit.out);
    // A plain branch or tag name has a full ref name; a hash, `HEAD~1` or `main^{commit}` has none and is not tracked.
    // (A name that is both a branch and a tag has none either; it is pinned to what git resolves it to, the tag.)
    // Tracked only when that name is what was pinned: a branch someone named like a hash is not the hash.
    const full = await git(cwd, ["rev-parse", "--symbolic-full-name", "--verify", "--quiet", "--end-of-options", ref]);
    if (full.code === 0 && full.out.startsWith("refs/") && (await git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${full.out}^{commit}`])).out === commit.out) named.set(ref, full.out);
  }
  const dirty = await git(cwd, TREE);
  if (dirty.code !== 0 || dirty.out) throw new Error("the work tree has changes; commit or remove them first (a run resets the tree between attempts)");
  // The bare branch name, never `--short`: a branch that shares its name with a tag would come back as `heads/<name>`.
  const branch = await git(cwd, ["symbolic-ref", "--quiet", "HEAD"]);
  return branch.code === 0 && branch.out.startsWith("refs/heads/") ? branch.out.slice("refs/heads/".length) : (await git(cwd, ["rev-parse", "HEAD"])).out;
}

/**
 * Reset the tree to `target` (a pinned commit, or the branch to return to) and check that nothing is left; each step
 * that fails says so. A pinned commit is checked out as `<hash>^{commit}` and HEAD is compared with it afterwards, so a
 * branch someone named like the hash cannot stand in for it. `-ff` also removes a nested repository an agent created,
 * and only the root `.agenthub` is kept.
 */
export async function reset(cwd: string, target: string, detach: boolean, log: (line: string) => void): Promise<boolean> {
  // A branch is named before `--`, so a path of the same name cannot be meant; a commit is peeled, so no branch can.
  if ((await git(cwd, ["checkout", "--quiet", "--force", ...(detach ? ["--detach", `${target}^{commit}`] : [target, "--"])])).code !== 0) { log(`  the reset could not check out ${target}`); return false; }
  if (detach && (await git(cwd, ["rev-parse", "HEAD"])).out !== target) { log(`  the reset did not land on ${target}: something else in the repository carries that name`); return false; }
  if (!detach && (await git(cwd, ["symbolic-ref", "--quiet", "HEAD"])).out !== `refs/heads/${target}`) { log(`  the reset did not return to branch ${target}`); return false; }
  if ((await git(cwd, ["clean", "-ffdxq", "-e", "/.agenthub"])).code !== 0) { log("  the reset could not clean the tree"); return false; }
  const left = await git(cwd, TREE);
  if (left.code === 0 && !left.out) return true;
  const paths = left.out.split("\n").filter(Boolean);
  log(`  the reset left ${paths.length || "unreadable"} path${paths.length === 1 ? "" : "s"} behind${paths.length ? `: ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ", ..." : ""}` : ""}`);
  return false;
}

/**
 * The #247 measures of the attempt's task, the one with this id proposed last (an events file may keep an earlier task
 * with the same id). The turn that approved it ends after the approval and its usage arrives later still, so this waits
 * while a turn started since the task's proposal has not ended and its peer is still busy (`busy`, the hub's live
 * view: a turn the hub closed without an end event does not hold the wait), at most `settleMs`, then one poll more.
 * Unapproved tasks have no record, and a wait that was interrupted, could not read the hub, or ran out with the turn
 * still open gives none either: partial measures would read as complete.
 */
export async function metricsOf(opts: Pick<BenchOptions, "stateDir" | "settleMs" | "pollMs" | "stopped">, io: Pick<BenchIo, "now" | "sleep" | "log">, projectId: string, task: number,
    busy: () => Promise<Set<string> | undefined> = async () => undefined): Promise<AttemptMetrics | null> {
  const events = () => readEvents(join(opts.stateDir, "events.jsonl"));
  const last = (all: ReturnType<typeof events>, event: boolean, value: string) =>
    all.flatMap((e) => e.type === "task" && e.id === task && (event ? e.event : e.state) === value ? [e.at] : []).at(-1);
  const until = io.now() + (opts.settleMs ?? 600_000);
  let said = false;
  for (;;) {
    const all = events(), proposed = last(all, true, "proposed"), at = last(all, false, "approved");
    if (!at || !proposed || opts.stopped?.()) break;
    const ended = new Set(all.flatMap((e) => e.type === "turn_end" ? [`${e.peer}\0${e.turn}`] : []));
    const open = new Set(all.flatMap((e) => e.type === "turn_start" && e.at >= proposed && e.at <= at && !ended.has(`${e.peer}\0${e.turn}`) ? [e.peer] : []));
    // `undefined`: no live view was offered, so every open turn is waited for. A view that cannot be read while a
    // turn is open leaves the measures unknown: partial ones would read as complete.
    const working = await busy().then((w) => w, () => null);
    if (working === null && open.size) { io.log(`  the hub's status could not be read while task #${task}'s approving turn was open; its measures are not recorded`); return null; }
    const waiting = [...open].filter((peer) => !working || working.has(peer));
    if (!waiting.length) break;
    if (io.now() >= until) { io.log(`  ${waiting.join(", ")} still had the turn that approved task #${task} open after the wait; its measures are not recorded`); return null; }
    if (!said) { said = true; io.log(`  waiting for ${waiting.join(", ")} to end the turn that approved task #${task}, so its cost is counted`); }
    await io.sleep(opts.pollMs ?? 2000);
  }
  if (opts.stopped?.()) return null; // cut short: partial measures would read as complete
  await io.sleep(opts.pollMs ?? 2000); // the last usage of a turn lands a moment after its end
  if (opts.stopped?.()) return null;
  const all = events();
  const proposed = last(all, true, "proposed");
  const r = taskRecords(all, projectId, { version: VERSION, source: "live" }).find((x) => x.task === task && x.createdAt === proposed);
  return r ? { tokens: r.tokens.total, wallMs: r.wallMs, activeMs: r.activeMs, reviewRounds: r.reviewRounds, changesRequested: r.changesRequested,
    checkFailed: r.checkFailed, firstPass: r.firstPass, turns: r.turns, filesChanged: r.filesChanged, models: r.models } : null;
}

/**
 * #251: run a suite against the peers attached to this project's hub, one attempt at a time. Each attempt resets the
 * tree to the task's pinned commit, runs its setup, proposes the task as the console does, waits until it is approved
 * or its time is up, then runs its verify command in the tree the agents left. Returns the run id.
 * ponytail: a task that times out stops the run, since an agent may still be working in the tree the next attempt
 * would reset; withdrawing an open task (a board state for it) would let the run continue.
 */
export async function runBench(opts: BenchOptions, io: BenchIo): Promise<string> {
  const suiteText = readFileSync(opts.suitePath, "utf8");
  const suite = parseSuite(suiteText);
  // --tasks also sets the order, so a person can randomize it per run (docs/bench.md).
  const tasks = opts.only?.length ? opts.only.map((id) => suite.tasks.find((t) => t.id === id) ?? fail(`--tasks names ${id}, which the suite does not have`)) : suite.tasks;
  const pinned = new Map<string, string>(), named = new Map<string, string>();
  const original = await benchPreflight(opts.cwd, true, [...new Set(tasks.map((t) => t.ref))], pinned, named);
  const onBranch = (await git(opts.cwd, ["symbolic-ref", "--quiet", "HEAD"])).code === 0;
  const hub = await io.connect();
  const run = `${new Date(io.now()).toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 8)}`;
  const home = opts.home ?? hubHome();
  try {
    const answered = await hub.request({ t: "status" }, 5000);
    if (!answered.status) throw new Error(`the hub did not answer its status: ${answered.error ?? "no reply"}`);
    const status = answered.status as { projectId: string; version: string; peers: Record<string, { state: string; requestedModel?: string; permissionMode?: string }> };
    const routing = join(opts.cwd, ".agenthub", "routing.toml");
    const fingerprint: Fingerprint = {
      // ponytail: the hub's status reports a requested model for Pi only and permission modes once #242 lands; the rest
      // are recorded as absent. Reading each peer's launch settings would fill them in.
      // The status lists every peer the hub has known; an arm is the ones attached now.
      peers: Object.entries(status.peers ?? {}).filter(([, p]) => p.state !== "offline")
        .map(([id, p]) => ({ id, ...(p.requestedModel ? { model: p.requestedModel } : {}), ...(p.permissionMode ? { permissionMode: p.permissionMode } : {}) })).sort((a, b) => a.id.localeCompare(b.id)),
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
        const { attempt, open } = await runAttempt(task, pinned.get(task.ref)!, repeat, run, opts, io, hub, status.projectId);
        appendBench(attempt, home);
        io.log(`  ${task.id} #${repeat}: ${attempt.outcome}${attempt.error ? ` (${attempt.error})` : ""}`);
        if (attempt.outcome === "timeout") stopped = "timeout";
        else if (attempt.error === "interrupted") stopped = "interrupted";
        else if (attempt.error === "hub stopped" || attempt.error === "reset failed") stopped = "error";
        if (!stopped) continue;
        if (open) io.log(`  task #${attempt.hubTask} is still open on the board; settle it before the next run`);
        break outer;
      }
    }
    // Back where it started: on its branch, or at its commit. A branch or tag the suite names that moved or went
    // away during the run names different work next time (refs given as a hash or relative to another are not tracked).
    if (!stopped && !(await reset(opts.cwd, original, !onBranch, io.log))) io.log(`  the tree was not returned to ${original}; check it before the next run`);
    for (const [ref, full] of named) {
      const commit = pinned.get(ref)!;
      const now = await git(opts.cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${full}^{commit}`]);
      // `rev-parse --verify --quiet` exits 1 for a name that no longer resolves; anything else is git not answering.
      if (now.code === 1) io.log(`  suite ref ${ref} was deleted during the run; this run used ${commit.slice(0, 12)}`);
      else if (now.code !== 0) io.log(`  suite ref ${ref} could not be checked after the run`);
      else if (now.out !== commit) io.log(`  suite ref ${ref} moved during the run (${commit.slice(0, 12)} to ${now.out.slice(0, 12)}); this run used ${commit.slice(0, 12)}`);
    }
    appendBench({ schema: BENCH_SCHEMA, kind: "end", run, endedAt: new Date(io.now()).toISOString(), ...(stopped ? { stopped } : {}) }, home);
    return run;
  } finally { hub.close(); }
}

/** One attempt, and whether its hub task is still open on the board when it ends. */
async function runAttempt(task: SuiteTask, commit: string, repeat: number, run: string, opts: BenchOptions, io: BenchIo, hub: ControlClient, projectId: string): Promise<{ attempt: Attempt; open: boolean }> {
  const started = io.now();
  // The attempt ends when its outcome is known: the wait for its measures is not part of its time.
  const done = (outcome: Outcome, extra: { error?: AttemptError; verifyExit?: number | null; hubTask?: number | null; metrics?: AttemptMetrics | null; ended?: number; open?: boolean } = {}) => {
    const ended = extra.ended ?? io.now();
    const attempt: Attempt = { schema: BENCH_SCHEMA, kind: "attempt", run, task: task.id, repeat, outcome, ...(extra.error ? { error: extra.error } : {}), verifyExit: extra.verifyExit ?? null,
      hubTask: extra.hubTask ?? null, startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(), ms: ended - started, metrics: extra.metrics ?? null };
    return { attempt, open: extra.open ?? false };
  };
  if (!(await reset(opts.cwd, commit, true, io.log))) return done("error", { error: "reset failed" });
  if (task.setup) {
    const setup = await io.sh(task.setup, opts.cwd, opts.setupTimeoutMs ?? 300_000, opts.stopped);
    if (setup.interrupted) return done("error", { error: "interrupted" });
    if (setup.timedOut) return done("error", { error: "setup timeout" });
    if (setup.code !== 0) return done("error", { error: "setup failed" });
  }
  let id: number;
  try {
    const reply = await hub.request({ t: "task", op: "hub_task_propose", args: { title: task.title, ...(task.detail ? { detail: task.detail } : {}), class: task.class ?? "implement", ...(task.owner ? { owner: task.owner } : {}) } }, 30_000);
    // A request never rejects: a hub that is gone, or silent, answers `ok: false` with one of these.
    if (!reply.ok && /hub connection (is not open|closed)|hub is stopping|no answer from the hub/.test(String(reply.error))) {
      io.log(`  ${task.id}: ${reply.error}; if the hub is still up, check its board for a task it may have created`);
      return done("error", { error: "hub stopped" });
    }
    const match = reply.ok ? /^task #(\d+)/.exec(String(reply.text ?? "")) : null;
    if (!match) { io.log(`  ${task.id}: the hub refused the task: ${reply.error ?? "no task id in its reply"}`); return done("error", { error: "propose refused" }); }
    id = Number(match[1]);
  } catch { return done("error", { error: "hub stopped" }); }
  const deadline = started + task.timeout_s * 1000;
  for (;;) {
    let state: string | undefined;
    try {
      const list = await hub.request({ t: "task", op: "hub_task_list", args: {} }, 15_000);
      if (!list.ok) return done("error", { error: "hub stopped", hubTask: id, open: true });
      state = (JSON.parse(String(list.text)) as { id: number; state: string }[]).find((t) => t.id === id)?.state;
    } catch { return done("error", { error: "hub stopped", hubTask: id, open: true }); }
    if (state === "approved") break;
    if (opts.stopped?.()) return done("error", { error: "interrupted", hubTask: id, open: true });
    if (io.now() >= deadline) return done("timeout", { hubTask: id, open: true });
    await io.sleep(opts.pollMs ?? 2000);
  }
  const verify = await io.sh(task.verify, opts.cwd, opts.verifyTimeoutMs ?? 600_000, opts.stopped);
  const ended = io.now();
  if (verify.interrupted) return done("error", { error: "interrupted", hubTask: id, ended });
  const busy = async () => {
    const reply = await hub.request({ t: "status" }, 5000);
    if (!reply.status) throw new Error("no status");
    const peers = (reply.status as { peers?: Record<string, { state: string }> }).peers ?? {};
    return new Set(Object.entries(peers).flatMap(([peer, p]) => p.state === "busy" || p.state === "paused" ? [peer] : [])); // a paused peer's turn still runs
  };
  const metrics = await metricsOf(opts, io, projectId, id, busy);
  if (verify.timedOut) return done("fail", { error: "verify timeout", hubTask: id, metrics, ended });
  return done(verify.code === 0 ? "pass" : "fail", { verifyExit: verify.code, hubTask: id, metrics, ended });
}
