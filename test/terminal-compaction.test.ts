import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Turns } from "../src/hub/snapshots.ts";
import { conflictsOf } from "../src/hub/conflicts.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { ContainerRunner, type CheckRequest, type ContainerCommand, type RunReceipt } from "../src/hub/check-runner.ts";
import { PI_CLOSED_RESULT_CAP, PiToolReceipts, compactPiResult, packPiShellResult } from "../src/pi/tool-receipts.ts";
import { sdlcMetrics, type MetricTask } from "../src/hub/sdlc-metrics.ts";
import { costMetrics } from "../src/hub/cost-governance.ts";
import { releaseMetrics } from "../src/hub/sdlc-release.ts";
import { UsageRollup } from "../src/hub/usage-rollup.ts";

// #1555 AC6: a task that reached approved or cancelled drops its touches rows, its finished check output tails and the staged output file,
// and a closed Pi session's settled receipts shrink. Everything the metrics read stays exactly as it was.
const dirs: string[] = [];
const closers: (() => unknown)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = (prefix: string) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(dir); return dir; };

test("pruneTouches drops the rows of the named tasks and keeps every other task's rows", () => {
  const dir = scratch("ahub-touches-");
  const turns = new Turns(join(dir, "hub.db")); closers.push(() => turns.close());
  turns.touch(1, "kimi", ["a.ts", "b.ts"]); turns.touch(2, "codex", ["c.ts"]); turns.touch(3, "pi", ["d.ts"]);
  expect(turns.pruneTouches([1, 3])).toBe(3);
  expect(turns.touchesFor([1, 2, 3]).map(row => [row.task, row.path])).toEqual([[2, "c.ts"]]);
  expect(turns.pruneTouches([])).toBe(0);
});

test("a startup pass prunes rows of tasks that closed while no hub ran, and only those", () => {
  const dir = scratch("ahub-touches-");
  const turns = new Turns(join(dir, "hub.db")); closers.push(() => turns.close());
  turns.touch(1, "kimi", ["a.ts"]); turns.touch(2, "codex", ["b.ts"]); turns.touch(9, "pi", ["gone.ts"]);
  const closed = new Set([1]);
  expect(turns.pruneClosedTouches(id => closed.has(id))).toBe(1);
  expect(turns.touchesFor([1, 2, 9]).map(row => row.task).sort()).toEqual([2, 9]);
});

test("every reader of touches looks at open tasks only, so a closed task's rows change no answer", () => {
  // The three readers: conflictsOf (daemon detectConflicts), pathWarnings (check-path) and ownerWriteEvidence (an in-progress task). The first and last take open ids;
  // this pins the pure one on the same rows with and without the closed task's, which is what pruning does.
  const open = [{ id: 2, owner: "codex", state: "in_progress" }] as never[];
  const rows = [{ task: 1, peer: "kimi", path: "src/a.ts", at: 1 }, { task: 2, peer: "codex", path: "src/a.ts", at: 2 }];
  expect(conflictsOf("pi", ["src/a.ts"], rows, open)).toEqual(conflictsOf("pi", ["src/a.ts"], rows.filter(row => row.task !== 1), open));
});

async function runnerFixture() {
  const root = await mkdtemp(join(tmpdir(), "ahub-compact-runner-")); dirs.push(root);
  const project = join(root, "project"); await mkdir(project);
  const git = (args: string[]) => { const r = hubGitSync(["-C", project, ...args], { encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  git(["init"]); git(["config", "user.email", "fixture@example.invalid"]); git(["config", "user.name", "Fixture"]);
  await mkdir(join(project, "test")); await writeFile(join(project, "test/example.test.ts"), "test('ok',()=>{});\n"); await writeFile(join(project, "bun.lock"), "lock\n");
  git(["add", "."]); git(["commit", "-m", "fixture"]);
  await mkdir(join(project, "node_modules/.bin"), { recursive: true }); await writeFile(join(project, "node_modules/tool.js"), "tool"); await symlink("../tool.js", join(project, "node_modules/.bin/tool"));
  const command: ContainerCommand = async (args, opts) => {
    if (args[0] === "--version") return { code: 0, stdout: "1.5.0" };
    if (args[0] === "network" && args[1] === "inspect") return { code: 0, stdout: JSON.stringify([{ id: "agenthub-check", configuration: { name: "agenthub-check", mode: "hostOnly" } }]) };
    if (args[0] === "list") return { code: 0, stdout: "[]" };
    if (args[0] === "exec") { opts?.output?.(Buffer.from("fixture passed\n")); return { code: 0, stdout: "" }; }
    return { code: 0, stdout: "" };
  };
  const runner = new ContainerRunner({ projectDir: project, stateDir: join(root, "state"), storageDir: join(root, "storage"), projectKey: "fixture", enabled: true, isDenied: () => false, signature: () => "fixture-signature", command });
  closers.push(() => runner.stopAll());
  const request = (task: number): CheckRequest => ({ task, owner: "pi", generation: 2, updated: 3, ref: "HEAD", check: "test", files: ["test/example.test.ts"] });
  return { root, runner, request };
}

test("a closed task's finished checks lose their output tail and staged output, keep every other receipt field, and other tasks' runs are untouched", async () => {
  const f = await runnerFixture();
  const closing = await f.runner.start(f.request(1)).done, other = await f.runner.start(f.request(2)).done;
  expect(closing.tail).toBe("fixture passed"); expect(other.tail).toBe("fixture passed");
  const output = (run: string) => join(f.root, "storage/fixture", run, "output.log");
  expect(await Bun.file(output(closing.run)).exists()).toBe(true);
  expect(await f.runner.compactTask(1)).toBe(1);
  const after = (await f.runner.result(closing.run))!;
  expect(after.tail).toBe("");
  const { tail: _before, ...beforeRest } = closing as RunReceipt, { tail: _after, ...afterRest } = after;
  expect(afterRest).toEqual(beforeRest); // exit, status, sha, tree, timing, owner and revision are what the verdict reads
  expect(await Bun.file(output(closing.run)).exists()).toBe(false);
  expect((await f.runner.result(other.run))!.tail).toBe("fixture passed");
  expect(await Bun.file(output(other.run)).exists()).toBe(true);
  expect(await f.runner.compactTask(1)).toBe(1); // idempotent: nothing left to remove, the receipt is still found and still valid
  expect(await f.runner.compactTask(99)).toBe(0);
});

test("a run that is still queued or running is never compacted", async () => {
  const f = await runnerFixture();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const root = await mkdtemp(join(tmpdir(), "ahub-compact-hold-")); dirs.push(root);
  const held = new ContainerRunner({ projectDir: join(f.root, "project"), stateDir: join(root, "state"), storageDir: join(root, "storage"), projectKey: "fixture", enabled: true, isDenied: () => false, signature: () => "fixture-signature",
    command: async (args, opts) => {
      if (args[0] === "--version") return { code: 0, stdout: "1.5.0" };
      if (args[0] === "network" && args[1] === "inspect") return { code: 0, stdout: JSON.stringify([{ id: "agenthub-check", configuration: { name: "agenthub-check", mode: "hostOnly" } }]) };
      if (args[0] === "list") return { code: 0, stdout: "[]" };
      if (args[0] === "exec") { opts?.output?.(Buffer.from("partial\n")); await gate; return { code: 0, stdout: "" }; }
      return { code: 0, stdout: "" };
    } });
  closers.push(() => { release(); return held.stopAll(); });
  const handle = held.start(f.request(5));
  for (let i = 0; i < 400 && held.activeRun !== handle.run; i++) await Bun.sleep(10);
  expect(await held.compactTask(5)).toBe(0);
  release(); const done = await handle.done;
  expect(done.tail).toBe("partial");
});

test("a closed Pi session's settled results shrink to the cap with the exit code kept, while the active session's receipts stay intact", async () => {
  const dir = scratch("ahub-pi-compact-"), file = join(dir, "hub.db");
  const ledger = new PiToolReceipts(file); closers.push(() => ledger.close());
  const big = "x".repeat(50_000), shell = packPiShellResult("y".repeat(50_000), 3);
  await ledger.execute("old", "plain", "read", { path: "a" }, async () => big);
  await ledger.execute("old", "shell", "bash", { command: "c" }, async () => shell);
  await ledger.execute("old", "small", "read", { path: "s" }, async () => "tiny");
  const db = new Database(file); closers.push(() => db.close());
  const row = (session: string, call: string) => db.query("SELECT state,result FROM pi_tool_receipts WHERE session=? AND call_id=?").get(session, call) as { state: string; result: string };
  expect(row("old", "plain").result.length).toBe(50_000); // the session that wrote them is the active one: nothing shrinks
  await ledger.execute("current", "keep", "read", { path: "b" }, async () => big); // a new session closes "old"
  expect(row("old", "plain").result.length).toBeLessThanOrEqual(PI_CLOSED_RESULT_CAP + 100);
  expect(row("old", "plain").state).toBe("done");
  expect(JSON.parse(row("old", "shell").result)).toMatchObject({ kind: "user-bash-result", exitCode: 3 });
  expect(row("old", "shell").result.length).toBeLessThanOrEqual(PI_CLOSED_RESULT_CAP + 100);
  expect(row("old", "small").result).toBe("tiny");
  expect(row("current", "keep").result.length).toBe(50_000); // the active session's receipt is intact
  await ledger.execute("newer", "first", "read", { path: "c" }, async () => "ok");
  expect(row("current", "keep").result.length).toBeLessThanOrEqual(PI_CLOSED_RESULT_CAP + 100); // closed in turn
});

test("compactPiResult keeps short text and a shell result's trusted exit code", () => {
  expect(compactPiResult("short")).toBe("short");
  expect(JSON.parse(compactPiResult(packPiShellResult("z".repeat(10_000), null)))).toMatchObject({ kind: "user-bash-result", exitCode: null });
  expect(compactPiResult("q".repeat(5000)).length).toBeLessThanOrEqual(PI_CLOSED_RESULT_CAP + 100);
});

test("sdlcMetrics, costMetrics and the usage roll-up give identical results before and after compaction", async () => {
  // Compaction touches only touches rows, check output tails and closed-session Pi results. None of them is an input to these functions, which read task history, cost
  // records and the event log, so each result is computed from the same inputs before and after a full compaction of a populated fixture.
  const dir = scratch("ahub-compact-equal-"), db = join(dir, "hub.db");
  const board = new Board(db); closers.push(() => board.close());
  const turns = new Turns(db); closers.push(() => turns.close());
  const t1 = board.propose("claude", { title: "one", class: "implement" }); board.update(t1.id, "hub", "assigned", { owner: "pi" });
  board.update(t1.id, "pi", "accepted", { state: "in_progress" }); board.update(t1.id, "pi", "done", { state: "in_review" });
  turns.touch(t1.id, "pi", ["src/a.ts"]);
  board.update(t1.id, "claude", "approved", { state: "approved" });
  const metricTasks = () => board.list().map(task => ({ id: task.id, history: task.history }) as MetricTask);
  const log = join(dir, "events.jsonl");
  appendFileSync(log, [{ type: "task", id: t1.id, state: "approved", class: "implement", event: "approved", by: "pi", owner: "pi" }, { type: "tokens", peer: "pi", n: 100, task: t1.id, attribution: "delivery" }]
    .map((e, i) => JSON.stringify({ v: 1, at: new Date(Date.UTC(2026, 9, 9, 0, 0, i)).toISOString(), ...e })).join("\n") + "\n");
  const rollup = new UsageRollup(db, log); closers.push(() => rollup.close()); rollup.catchUp();
  const cost = [{ repo: "o/r", pr: 1, history: board.get(t1.id)!.history.map(entry => ({ event: entry.event, at: entry.at })) }];
  const prs = [{ repo: "o/r", pr: 1, state: "MERGED" as const, complete: true }];
  const snapshot = () => JSON.stringify({ sdlc: sdlcMetrics(metricTasks()), cost: costMetrics(cost, prs), usage: rollup.dump(), release: releaseMetrics([], board.list()), tasks: board.list() }); // whole task rows: history, sdlc receipts and the spec acceptance carry
  const before = snapshot();
  expect(turns.pruneTouches([t1.id])).toBe(1);
  const f = await runnerFixture(); await f.runner.start(f.request(t1.id)).done; await f.runner.compactTask(t1.id);
  const ledger = new PiToolReceipts(join(dir, "pi.db")); closers.push(() => ledger.close());
  await ledger.execute("a", "c", "read", {}, async () => "r".repeat(10_000)); await ledger.execute("b", "c", "read", {}, async () => "ok");
  expect(snapshot()).toBe(before);
});
