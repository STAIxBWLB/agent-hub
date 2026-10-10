import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { appendBench, armRuns, measures, BENCH_SCHEMA, benchCompare, benchCsv, benchReport, CSV_COLUMNS, MIN_ATTEMPTS, parseSuite, readRuns, runFile, runSummary, sameSuite, type Attempt, type Outcome } from "../src/hub/bench.ts";
import { processSignature } from "../src/pi/process-signature.ts";
import { benchPreflight, defaultIo, metricsOf, runBench, type BenchIo } from "../src/cli/bench.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";

// #251: benchmark suites, runs against the attached peers, reports and arm comparisons.

const dirs: string[] = [];
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (name: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), `ahub-bench-${name}-`))); dirs.push(d); return d; };
const git = (cwd: string, ...args: string[]) => { const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); return r.stdout.toString().trim(); };
function benchRepo(): { root: string; head: string } {
  const root = temp("repo");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "bench@example.invalid"); git(root, "config", "user.name", "bench");
  writeFileSync(join(root, "README.md"), "fixture\n");
  writeFileSync(join(root, ".gitignore"), ".agenthub/\n");
  git(root, "add", "."); git(root, "commit", "-qm", "fixture");
  return { root, head: git(root, "rev-parse", "HEAD") };
}

test("a suite is checked field by field and every refusal names the task and the field", () => {
  const ok = { name: "s", tasks: [{ id: "a", title: "t", ref: "HEAD", verify: "true", timeout_s: 60 }] };
  expect(parseSuite(JSON.stringify(ok)).tasks).toHaveLength(1);
  const bad = (suite: unknown, message: string) => expect(() => parseSuite(JSON.stringify(suite))).toThrow(message);
  bad({ ...ok, extra: 1 }, "suite: unknown field extra");
  bad({ name: "s", tasks: [] }, "suite: tasks must be a non-empty list");
  bad({ name: "s", tasks: [{ ...ok.tasks[0], verify: undefined }] }, "suite task a: verify is required");
  bad({ name: "s", tasks: [{ ...ok.tasks[0], shell: "x" }] }, "suite task a: unknown field shell");
  bad({ name: "s", tasks: [ok.tasks[0], ok.tasks[0]] }, "suite task a: duplicate id");
  bad({ name: "s", tasks: [{ ...ok.tasks[0], timeout_s: 1 }] }, "suite task a: timeout_s must be a number of seconds from 10 to 86400");
  bad({ name: "s", tasks: [{ ...ok.tasks[0], class: "deploy" }] }, "suite task a: class must be one of");
  expect(() => parseSuite("{")).toThrow("suite: not valid JSON");
});

test("a run refuses a project not kept for benchmarks and a dirty tree, and changes nothing", async () => {
  const { root } = benchRepo();
  await expect(benchPreflight(root, false)).rejects.toThrow('set "bench": { "enabled": true }');
  writeFileSync(join(root, "stray.txt"), "x");
  await expect(benchPreflight(root, true)).rejects.toThrow("the work tree has changes");
  expect(readFileSync(join(root, "stray.txt"), "utf8")).toBe("x");
  rmSync(join(root, "stray.txt"));
  expect(await benchPreflight(root, true)).toBe("main");
  // --tasks sets the order, and an id the suite lacks is refused before the hub is reached.
  const suitePath = join(temp("suite-refuse"), "suite.json");
  writeFileSync(suitePath, JSON.stringify({ name: "s", tasks: [{ id: "a", title: "t", ref: "HEAD", verify: "true", timeout_s: 60 }] }));
  const io: BenchIo = { ...defaultIo(root, root), connect: () => { throw new Error("connected"); } };
  await expect(runBench({ cwd: root, stateDir: root, suitePath, arm: "x", repeat: 1, only: ["a", "b"] }, io)).rejects.toThrow("--tasks names b, which the suite does not have");
  // A ref that is not a commit, or that starts like an option, is refused before anything runs.
  await expect(benchPreflight(root, true, ["no-such-ref"])).rejects.toThrow("suite ref no-such-ref is not a commit");
  await expect(benchPreflight(root, true, ["--orphan"])).rejects.toThrow("is not a commit");
});

test("a reset never reaches outside the project or into .agenthub", async () => {
  // A project in a subdirectory of a repository: a checkout and a clean would act on the whole repository.
  const { root } = benchRepo();
  mkdirSync(join(root, "proj"));
  await expect(benchPreflight(join(root, "proj"), true)).rejects.toThrow("must be the root of its git repository");
  // Tracked hub files would be replaced by a checkout.
  const tracked = benchRepo().root;
  mkdirSync(join(tracked, ".agenthub"));
  writeFileSync(join(tracked, ".agenthub", "config.json"), "{}");
  git(tracked, "add", "-f", ".agenthub/config.json"); git(tracked, "commit", "-qm", "track hub config");
  await expect(benchPreflight(tracked, true)).rejects.toThrow("tracks files under .agenthub/");
  // A ref that tracks them would write over the hub's own, even when the current tree does not track them.
  git(tracked, "rm", "-rq", "--cached", ".agenthub"); git(tracked, "commit", "-qm", "untrack");
  const old = git(tracked, "rev-parse", "HEAD~1");
  await expect(benchPreflight(tracked, true)).resolves.toBe("main");
  await expect(benchPreflight(tracked, true, [old])).rejects.toThrow(`suite ref ${old} tracks files under .agenthub/`);
  // A case variant is the same directory on a case-insensitive disk.
  const variant = benchRepo().root;
  git(variant, "commit", "-q", "--allow-empty", "-m", "base");
  const blob = git(variant, "hash-object", "-w", "README.md");
  git(variant, "update-index", "--add", "--cacheinfo", `100644,${blob},.AGENTHUB/config.json`);
  await expect(benchPreflight(variant, true)).rejects.toThrow("tracks files under .agenthub/");
  git(variant, "commit", "-qm", "variant"); const withVariant = git(variant, "rev-parse", "HEAD");
  git(variant, "rm", "-rq", "--cached", ".AGENTHUB"); git(variant, "commit", "-qm", "drop variant");
  await expect(benchPreflight(variant, true, [withVariant])).rejects.toThrow("tracks files under .agenthub/");
  // A ref is pinned to its commit at preflight, so a branch an agent moves later is not what a reset checks out.
  const pinned = new Map<string, string>();
  await benchPreflight(variant, true, ["main"], pinned);
  expect(pinned.get("main")).toBe(git(variant, "rev-parse", "main"));
});

test("a bounded command takes what it started with it, and an interrupt stops it at once", async () => {
  const { root } = benchRepo();
  const io = defaultIo(root, root);
  // A verify that leaves a background writer behind, past its bound: nothing may land in the next attempt's tree.
  const hung = await io.sh("(sleep 2; echo late > orphan.txt) & sleep 30", root, 300);
  expect(hung).toMatchObject({ code: null, timedOut: true, interrupted: false });
  // One that finishes but leaves a child running: the child goes too.
  const left = await io.sh("(sleep 2; echo late > left.txt) & exit 0", root, 10_000);
  expect(left).toMatchObject({ code: 0, timedOut: false });
  let stop = false;
  setTimeout(() => { stop = true; }, 200);
  const cut = await io.sh("sleep 30", root, 60_000, () => stop);
  expect(cut).toMatchObject({ code: null, interrupted: true });
  await Bun.sleep(2500);
  expect(existsSync(join(root, "orphan.txt"))).toBe(false);
  expect(existsSync(join(root, "left.txt"))).toBe(false);
  // A command that cannot start (its directory is gone) is a failure at once, not a crash or a full bound's wait.
  const t0 = Date.now();
  expect(await io.sh("true", join(root, "no-such-dir"), 10_000)).toMatchObject({ code: -1, timedOut: false });
  expect(Date.now() - t0).toBeLessThan(5000);
}, 30_000);

test("a run records pass, fail and timeout with measures, resets the tree between attempts, and bounds a hanging verify", async () => {
  const { root, head } = benchRepo();
  const stateDir = join(root, ".agenthub", "state");
  mkdirSync(stateDir, { recursive: true });
  const home = temp("home");
  const daemon = await startDaemon({ cwd: root, stateDir, projectId: "p-bench", instanceId: "i-bench", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false } } });
  cleanup.push(() => daemon.stop());
  for (const peer of ["worker", "claude"]) { const c = await ControlClient.connect(stateDir, { role: "peer", peer }); cleanup.push(() => c.close()); }
  for (let i = 0; i < 100 && !(daemon.bus.peers.get("worker")?.state === "idle" && daemon.bus.peers.get("claude")?.state === "idle"); i++) await Bun.sleep(10);
  const tools = async (peer: string) => { const c = await ControlClient.connect(stateDir, { role: "tools", peer }); cleanup.push(() => c.close()); return c; };
  const worker = await tools("worker"), reviewer = await tools("claude");
  const SECRET = "SECRET-SUITE-TEXT";
  const suitePath = join(temp("suite"), "suite.json");
  writeFileSync(suitePath, JSON.stringify({ name: "fixture-suite", tasks: [
    { id: "solve", title: `solve ${SECRET}`, detail: `${SECRET} detail`, owner: "worker", ref: head, setup: `echo ${SECRET} > /dev/null`, verify: `test "$(cat out.txt)" = ok # ${SECRET}`, timeout_s: 60 },
    { id: "wrong", title: "wrong answer", owner: "worker", ref: head, verify: 'test "$(cat out.txt)" = ok', timeout_s: 60 },
    { id: "hang", title: "solve but verify hangs", owner: "worker", ref: head, verify: "sleep 30", timeout_s: 60 },
    { id: "stall", title: "stall forever", owner: "worker", ref: head, verify: "true", timeout_s: 30 },
  ] }));
  // The worker solves what its title says; the reviewer approves what reaches review.
  const handled = new Set<number>();
  const work = async () => {
    const board = JSON.parse((await worker.request({ t: "task", op: "hub_task_list", args: {} })).text) as { id: number; title: string; state: string; owner: string | null }[];
    for (const t of board) {
      if (t.owner !== "worker" || handled.has(t.id) || t.title.startsWith("stall")) continue;
      if (t.state === "proposed") await worker.request({ t: "task", op: "hub_task_accept", args: { id: t.id } });
      else if (t.state === "in_progress") {
        handled.add(t.id);
        expect(existsSync(join(root, "out.txt"))).toBe(false); // the tree was reset before this attempt
        writeFileSync(join(root, "out.txt"), t.title.startsWith("wrong") ? "bad" : "ok");
        const done = (await worker.request({ t: "task", op: "hub_task_done", args: { id: t.id, summary: "done" } })).text as string;
        if (done.includes("in_review")) await reviewer.request({ t: "task", op: "hub_review", args: { id: t.id, verdict: "approved" } });
      }
    }
  };
  let clock = Date.parse("2026-10-10T00:00:00Z");
  const lines: string[] = [];
  const io: BenchIo = { ...defaultIo(stateDir, root), connect: () => ControlClient.connect(stateDir, { role: "console" }),
    now: () => clock, sleep: async (ms) => { clock += ms; await work(); }, log: (line) => void lines.push(line) };
  const run = await runBench({ cwd: root, stateDir, suitePath, arm: "fixture-arm", repeat: 1, home, pollMs: 1000, verifyTimeoutMs: 300 }, io);
  const [recorded] = readRuns(home);
  expect(recorded!.header).toMatchObject({ run, suite: "fixture-suite", arm: "fixture-arm", tasks: 4, repeats: 1 });
  expect(recorded!.header.fingerprint.peers.map((p) => p.id)).toEqual(expect.arrayContaining(["claude", "worker"]));
  expect(recorded!.attempts.map((a) => [a.task, a.outcome, a.error ?? null])).toEqual([["solve", "pass", null], ["wrong", "fail", null], ["hang", "fail", "verify timeout"], ["stall", "timeout", null]]);
  expect(recorded!.attempts[0]!.metrics).toMatchObject({ firstPass: true });
  expect(recorded!.attempts[1]!.verifyExit).toBe(1);
  expect(recorded!.end).toMatchObject({ stopped: "timeout" });
  expect(recorded!.state).toBe("stopped");
  expect(lines.join("\n")).toContain("is still open on the board");
  // No suite text, command or output in the store.
  expect(readFileSync(runFile(run, home), "utf8")).not.toContain(SECRET);
  expect(benchCsv(readRuns(home)).split("\n")[0]).toBe(CSV_COLUMNS.join(","));
  // A run that finishes is back on its branch; an interrupted one records the attempt and leaves its task open.
  git(root, "checkout", "-q", "main");
  const finished = await runBench({ cwd: root, stateDir, suitePath, arm: "fixture-arm", repeat: 1, home, pollMs: 1000, only: ["solve"] }, io);
  expect(readRuns(home).find((r) => r.header.run === finished)!.state).toBe("finished");
  expect(git(root, "symbolic-ref", "--short", "HEAD")).toBe("main");
  let polls = 0;
  const interrupted = await runBench({ cwd: root, stateDir, suitePath, arm: "fixture-arm", repeat: 1, home, pollMs: 1000, only: ["stall", "solve"], stopped: () => ++polls > 2 }, io);
  const stopped = readRuns(home).find((r) => r.header.run === interrupted)!;
  expect(stopped.attempts.map((a) => [a.task, a.outcome, a.error])).toEqual([["stall", "error", "interrupted"]]);
  expect(stopped.end).toMatchObject({ stopped: "interrupted" });
});

test("an attempt's measures wait for the turn that approved the task, and belong to the task proposed last", async () => {
  const stateDir = temp("settle");
  const file = join(stateDir, "events.jsonl");
  let t = Date.parse("2026-10-10T00:00:00Z");
  const line = (e: Record<string, unknown>) => appendFileSync(file, JSON.stringify({ v: 1, at: new Date(t += 1000).toISOString(), ...e }) + "\n");
  const taskEvent = (event: string, state: string) => line({ type: "task", id: 1, event, by: "hub", state, owner: "worker", reviewer: null, class: "plan", pii: false });
  // An earlier task #1 (before a reset of the board) with its own cost, then the attempt's task #1.
  taskEvent("proposed", "proposed"); taskEvent("accepted", "in_progress");
  line({ type: "tokens", peer: "worker", n: 999, task: 1, attribution: "single_open" });
  taskEvent("done", "approved");
  taskEvent("proposed", "proposed"); taskEvent("accepted", "in_progress");
  line({ type: "turn_start", peer: "worker", turn: "worker#1.1" });
  line({ type: "tokens", peer: "worker", n: 10, task: 1, attribution: "single_open" });
  taskEvent("done", "approved");
  let sleeps = 0, clock = 0;
  const said: string[] = [];
  const io = { now: () => clock, log: (line: string) => void said.push(line), sleep: async (ms: number) => {
    clock += ms;
    if (++sleeps === 2) { // the approving turn ends only after two polls
      line({ type: "tokens", peer: "worker", n: 5, task: 1, attribution: "single_open" });
      line({ type: "turn_end", peer: "worker", turn: "worker#1.1", ms: 4000, task: 1, attribution: "single_open" });
    }
  } };
  const m = await metricsOf({ stateDir, pollMs: 100, settleMs: 10_000 }, io, "p", 1);
  expect(sleeps).toBeGreaterThanOrEqual(3);
  expect(m).toMatchObject({ tokens: 15, turns: 1, activeMs: 4000 });
  expect(said.join("\n")).toContain("waiting for worker to end the turn that approved task #1");
  // An attempt that was never approved has no measures.
  expect(await metricsOf({ stateDir, pollMs: 1, settleMs: 10 }, io, "p", 7)).toBeNull();
  // A turn from before this task's proposal, an unmatched one whose peer is no longer busy, and an interrupt do not hold the wait.
  const stale = temp("settle-stale");
  const staleFile = join(stale, "events.jsonl");
  const put = (e: Record<string, unknown>) => appendFileSync(staleFile, JSON.stringify({ v: 1, at: new Date(t += 1000).toISOString(), ...e }) + "\n");
  const board = (event: string, state: string) => put({ type: "task", id: 1, event, by: "hub", state, owner: "worker", reviewer: null, class: "plan", pii: false });
  put({ type: "turn_start", peer: "codex", turn: "codex#0.9" }); // left open by an earlier hub run
  board("proposed", "proposed"); board("accepted", "in_progress");
  put({ type: "turn_start", peer: "claude", turn: "claude#1.1" }); // closed by the hub without an end event
  board("done", "approved");
  const count = (busy?: () => Promise<Set<string>>, stopped?: () => boolean) => { let n = 0; return metricsOf({ stateDir: stale, pollMs: 100, settleMs: 60_000, ...(stopped ? { stopped } : {}) },
    { now: () => n * 100, sleep: async () => { n++; }, log: () => {} }, "p", 1, busy).then(() => n); };
  expect(await count(async () => new Set<string>())).toBe(1); // claude is idle now: only the last poll
  expect(await count(async () => new Set(["codex"]))).toBe(1); // codex's old turn is not this task's
  expect(await count(async () => new Set(["claude"]))).toBeGreaterThan(100); // really busy: waits to the cap
  expect(await count(async () => new Set(["claude"]), () => true)).toBe(0); // interrupted: no wait at all
});

const attempt = (run: string, task: string, outcome: Outcome, tokens: number, ms: number): Attempt => ({ schema: BENCH_SCHEMA, kind: "attempt", run, task, repeat: 1, outcome,
  verifyExit: outcome === "pass" ? 0 : 1, hubTask: 1, startedAt: "2026-10-10T00:00:00.000Z", endedAt: "2026-10-10T00:01:00.000Z", ms,
  metrics: { tokens, wallMs: ms, activeMs: ms, reviewRounds: 1, changesRequested: outcome === "pass" ? 0 : 1, checkFailed: 0, firstPass: outcome === "pass", turns: 1, filesChanged: 1, models: [] } });
function fixtureRun(home: string, run: string, arm: string, outcomes: Outcome[], tokens: number) {
  appendBench({ schema: BENCH_SCHEMA, kind: "run", run, suite: "s", suiteHash: "h", arm, fingerprint: { peers: [], routingHash: null, hubVersion: "t" }, version: "t",
    startedAt: `2026-10-10T00:00:0${run.length % 10}.000Z`, tasks: outcomes.length, repeats: 1, order: outcomes.map((_, i) => `t${i}`), runner: { pid: 1, signature: "gone" } }, home);
  outcomes.forEach((o, i) => appendBench(attempt(run, `t${i}`, o, tokens + i, 60_000), home));
  appendBench({ schema: BENCH_SCHEMA, kind: "end", run, endedAt: "2026-10-10T01:00:00.000Z" }, home);
}

test("reports and comparisons give pass rates, tokens and bootstrap intervals, inconclusive below the minimum", () => {
  const home = temp("compare");
  fixtureRun(home, "r-base", "base", ["pass", "pass", "fail", "pass", "pass", "pass"], 1000);
  fixtureRun(home, "r-new", "new", ["pass", "pass", "pass", "pass", "pass", "pass"], 600);
  fixtureRun(home, "r-few", "few", ["pass", "fail"], 500);
  const runs = readRuns(home);
  expect(runs.every((r) => r.state === "finished")).toBe(true);
  const report = benchReport(runs.filter((r) => r.header.arm === "base"));
  expect(report.overall).toMatchObject({ attempts: 6, pass: 5, fail: 1, passRate: 5 / 6, firstPassRate: 5 / 6, tokensMedian: 1002.5 });
  expect(Object.keys(report.tasks)).toEqual(["t0", "t1", "t2", "t3", "t4", "t5"]);
  const group = (arm: string) => ({ arm, runs: runs.filter((r) => r.header.arm === arm) });
  const c = benchCompare([group("base"), group("new"), group("few")]);
  const pass = c.differences.find((d) => d.arm === "new" && d.measure === "passRate")!;
  expect(pass.diff).toBeCloseTo(1 / 6);
  expect(pass.low).toBeLessThanOrEqual(pass.diff!);
  expect(pass.high).toBeGreaterThanOrEqual(pass.diff!);
  expect(pass.inconclusive).toBe(false);
  expect(c.differences.find((d) => d.arm === "new" && d.measure === "tokensMedian")!.diff).toBe(-400);
  expect(c.differences.filter((d) => d.arm === "few").every((d) => d.inconclusive)).toBe(true);
  expect(MIN_ATTEMPTS).toBe(5);
  expect(JSON.stringify(benchCompare([group("base"), group("new")]))).toBe(JSON.stringify(benchCompare([group("base"), group("new")]))); // seeded: the same every time
  // Errors are not counted toward the minimum for pass rate or wall time, and wall time leaves them out.
  fixtureRun(home, "r-err", "err", ["error", "error", "error", "error", "pass"], 1);
  const err = benchCompare([group("base"), group("err")]);
  expect(err.differences.find((d) => d.measure === "passRate")!.inconclusive).toBe(true);
  const quickErrors = [...[1, 2, 3].map((i) => ({ ...attempt("r-q", `e${i}`, "error", 0, 10), metrics: null })), attempt("r-q", "p", "pass", 5, 60_000)];
  expect(measures(quickErrors).wallMsMedian).toBe(60_000);
  // An arm is every run of it that is over: a run a timeout stopped counts with its timeout.
  fixtureRun(home, "r-stop", "stop", ["pass", "timeout"], 1);
  appendBench({ schema: BENCH_SCHEMA, kind: "end", run: "r-stop", endedAt: "2026-10-10T02:00:00.000Z", stopped: "timeout" }, home);
  expect(armRuns(readRuns(home), "stop").map((r) => [r.header.run, r.state])).toEqual([["r-stop", "stopped"]]);
  expect(benchReport(armRuns(readRuns(home), "stop")).overall).toMatchObject({ pass: 1, timeout: 1 });
  // Runs of different suites (or suite versions) are not compared without saying so.
  const other = temp("other-suite");
  fixtureRun(other, "r-x", "x", ["pass"], 1);
  const mixed = [...readRuns(home).filter((r) => r.header.arm === "base"), ...readRuns(other).map((r) => ({ ...r, header: { ...r.header, suiteHash: "other" } }))];
  expect(sameSuite([{ arm: "a", runs: mixed }])).toContain("different suites");
  expect(sameSuite([group("base"), group("new")])).toBeNull();
});

test("a run whose runner died without an end record reads interrupted; the dashboard snapshot carries summaries only", async () => {
  const home = temp("snapshot");
  const dead = Bun.spawnSync(["true"]).pid;
  appendBench({ schema: BENCH_SCHEMA, kind: "run", run: "r-dead", suite: "s", suiteHash: "h", arm: "a", fingerprint: { peers: [], routingHash: null, hubVersion: "t" }, version: "t",
    startedAt: "2026-10-10T00:00:00.000Z", tasks: 2, repeats: 1, order: ["x", "y"], runner: { pid: dead, signature: "dead runner" } }, home);
  expect(readRuns(home)[0]!.state).toBe("interrupted");
  // A live runner's run names the attempt in progress from its order.
  const live = temp("live");
  appendBench({ schema: BENCH_SCHEMA, kind: "run", run: "r-live", suite: "s", suiteHash: "h", arm: "a", fingerprint: { peers: [], routingHash: null, hubVersion: "t" }, version: "t",
    startedAt: "2026-10-10T00:00:00.000Z", tasks: 2, repeats: 2, order: ["x", "y"], runner: { pid: process.pid, signature: processSignature(process.pid) ?? null } }, live);
  for (const t of ["x", "y", "x"]) appendBench(attempt("r-live", t, "pass", 1, 1), live);
  expect(runSummary(readRuns(live)[0]!)).toMatchObject({ state: "running", done: 3, total: 4, current: "y" });
  fixtureRun(home, "r-ok", "a", ["pass", "pass"], 10);
  fixtureRun(home, "r-ok2", "b", ["pass", "fail"], 20);
  const previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = home;
  const stateDir = join(temp("ui"), "state");
  mkdirSync(stateDir);
  try {
    const daemon = await startDaemon({ cwd: process.cwd(), stateDir, projectId: "p-ui", instanceId: "i-ui", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false } } });
    cleanup.push(() => daemon.stop());
    const console_ = await ControlClient.connect(stateDir, { role: "console" });
    cleanup.push(() => console_.close());
    const snap = await console_.request({ t: "ui_snapshot", after: 0 });
    expect(snap.bench.runs.map((r: { run: string }) => r.run).sort()).toEqual(["r-dead", "r-ok", "r-ok2"]);
    expect(Object.keys(snap.bench.runs[0]).sort()).toEqual(["arm", "attempts", "done", "error", "fail", "firstPassRate", "measured", "pass", "passRate", "reworkMean", "run", "scored", "startedAt", "state", "suite", "timeout", "tokensMedian", "total", "wallMsMedian"].sort());
    expect(snap.bench.arms.map((a: { arm: string }) => a.arm).sort()).toEqual(["a", "b"]);
  } finally {
    if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous;
  }
});

test("running a suite is a person's; reading benchmark results is not", () => {
  expect(classifyPeerCommand("bench", ["run", "suite.json", "--arm", "x"])).toBe("console");
  for (const sub of [[], ["list"], ["status"], ["report", "r"], ["compare", "a", "b"], ["export"]]) expect(classifyPeerCommand("bench", sub)).toBe("allowed");
  // --json is accepted anywhere, so it cannot hide the subcommand from the gate.
  expect(classifyPeerCommand("bench", ["--json", "run", "suite.json", "--arm", "x"])).toBe("console");
  expect(classifyPeerCommand("bench", ["--json", "--json", "run"])).toBe("console");
  expect(classifyPeerCommand("bench", ["--json", "list"])).toBe("allowed");
});

test("the dashboard has a Benchmarks section whose bars carry their numbers as text", () => {
  const html = readFileSync(join(import.meta.dir, "../src/ui/index.html"), "utf8");
  expect(html).toContain('<h2 id="bench-title">Benchmarks</h2>');
  expect(html).toContain("function renderBench(bench)");
  expect(html.match(/bar\.setAttribute\('aria-label'/g)!.length).toBeGreaterThanOrEqual(2);
});
