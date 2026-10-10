import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { appendBench, BENCH_SCHEMA, benchCompare, benchCsv, benchReport, CSV_COLUMNS, MIN_ATTEMPTS, parseSuite, readRuns, runFile, runSummary, type Attempt, type Outcome } from "../src/hub/bench.ts";
import { processSignature } from "../src/pi/process-signature.ts";
import { benchPreflight, defaultIo, runBench, type BenchIo } from "../src/cli/bench.ts";
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
});

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
    expect(Object.keys(snap.bench.runs[0]).sort()).toEqual(["arm", "attempts", "done", "error", "fail", "firstPassRate", "pass", "passRate", "reworkMean", "run", "startedAt", "state", "suite", "timeout", "tokensMedian", "total", "wallMsMedian"].sort());
    expect(snap.bench.arms.map((a: { arm: string }) => a.arm).sort()).toEqual(["a", "b"]);
  } finally {
    if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous;
  }
});

test("running a suite is a person's; reading benchmark results is not", () => {
  expect(classifyPeerCommand("bench", ["run", "suite.json", "--arm", "x"])).toBe("console");
  for (const sub of [[], ["list"], ["status"], ["report", "r"], ["compare", "a", "b"], ["export"]]) expect(classifyPeerCommand("bench", sub)).toBe("allowed");
});

test("the dashboard has a Benchmarks section whose bars carry their numbers as text", () => {
  const html = readFileSync(join(import.meta.dir, "../src/ui/index.html"), "utf8");
  expect(html).toContain('<h2 id="bench-title">Benchmarks</h2>');
  expect(html).toContain("function renderBench(bench)");
  expect(html.match(/bar\.setAttribute\('aria-label'/g)!.length).toBeGreaterThanOrEqual(2);
});
