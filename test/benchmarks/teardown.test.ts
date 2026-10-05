import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcRow } from "../../src/hub/child-process.ts";
import { processTable } from "../../src/hub/child-process.ts";
import { sessionSettings } from "../../src/cli/launch.ts";
import { actorOf, awaitTurnEnd, benchmarkClaudeSettings, captureActors, captureFixtureRoot, claudeUsageReading, claudeUsageSnapshot, commOf, daemonRoot, endReasonOf, extend, fixtureRootProblem, restoreModes, same, restoreTrust, teardown, turnEnded, withFixtureRoot, type Actor, type Deps } from "../../scripts/benchmarks/teardown.ts";

// issue #113: an arm's teardown proves what it stops by identity (pid and start time), never by a name in argv.
const dirs: string[] = [];
const kills: { pid: number; started: string }[] = [];
const keep = (pid: number) => { const r = processTable()?.find((x) => x.pid === pid); if (r) kills.push(r); };
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  const live = kills.length ? processTable() ?? [] : [];
  for (const k of kills.splice(0)) if (same(live, k)) { try { process.kill(k.pid, "SIGKILL"); } catch { /* gone */ } } // by identity: a reused pid is someone else
});

const DIR = "/private/tmp/ahub-run/fixtures/00-hub-codex-claude";
const T = "Sat Oct  3 08:00:00 2026";
const row = (pid: number, ppid: number, pgid: number, command: string, started = T): ProcRow => ({ pid, ppid, pgid, started, command });
// The arm: its daemon, Codex's launcher and native app-server (whose argv does not name the fixture), a tool command
// Codex runs in a group of its own, and Claude.
const daemon = row(100, 1, 100, `/opt/bun /r/src/cli/main.ts --project ${DIR} daemon`);
const launcher = row(105, 100, 105, "node /opt/codex/bin/codex.js app-server --listen ws://127.0.0.1:4611");
const native = row(106, 105, 105, "/opt/codex/vendor/codex app-server --listen ws://127.0.0.1:4611");
const tool = row(107, 106, 107, "sleep 40");
const claude = row(120, 1, 120, `claude --session-id s-1 --mcp-config ${DIR}/.claude/candidate-mcp.json`);
const runner = row(50, 49, 50, "bun scripts/benchmarks/native.ts");
const actors = (rows: ProcRow[]): Actor[] => [actorOf(rows, 100, "daemon", "hub.pid")!, actorOf(rows, 105, "codex-app-server", "child of the daemon")!, actorOf(rows, 120, "claude", "launch record")!];

/** A process table in memory: signals remove what they reach unless `stubborn`; the clock moves with sleep. */
function world(start: ProcRow[], opts: { stubborn?: number[]; shutdown?: (w: { rows: ProcRow[] }) => string[]; unreadable?: () => boolean; cwds?: Map<number, string> | null; onSignal?: (pid: number, sig: string, w: { rows: ProcRow[] }) => boolean; onRead?: (w: { rows: ProcRow[] }) => void } = {}) {
  const w = { rows: [...start], signals: [] as [number, string][], clock: 0 };
  const deps: Deps = {
    table: () => { if (opts.unreadable?.()) return undefined; const rows = [...w.rows]; opts.onRead?.(w); return rows; },
    cwds: () => (opts.cwds === null ? undefined : opts.cwds ?? new Map()),
    signal: (pid, sig) => {
      w.signals.push([pid, sig]);
      if (opts.onSignal?.(pid, sig, w) || sig === "SIGSTOP") return; // a stopped process is still in the table
      w.rows = w.rows.filter((r) => opts.stubborn?.includes(r.pid) || !(pid < 0 ? r.pgid === -pid : r.pid === pid));
    },
    sleep: async (ms) => void (w.clock += ms),
    now: () => w.clock,
    self: 50,
  };
  const shutdown = async () => opts.shutdown?.(w) ?? [];
  return { w, deps, shutdown };
}
const everything = [runner, daemon, launcher, native, tool, claude];

test("capture records the arm's own processes by what proves them, and nothing else", () => {
  const cwds = new Map([[130, DIR], [140, "/Users/someone"]]);
  const arm = { dir: DIR, hubPid: 100, claudeId: "s-1", self: 50, cwdOf: (pid: number) => cwds.get(pid) };
  const shell = row(130, 1, 130, "/bin/zsh -l");
  const launched = row(131, 130, 131, `/bin/zsh -c claude --session-id 's-1' --mcp-config ${DIR}/.claude/candidate-mcp.json`);
  const elsewhere = row(140, 1, 140, "/bin/zsh -l"); // a terminal elsewhere that runs a launcher with this session id
  const launched2 = row(141, 140, 141, "claude --session-id s-1");
  const prefix = row(150, 1, 150, "claude --session-id s-10"); // another arm's session id that starts with this one's
  const mcp = row(108, 106, 105, "node /opt/mcp/server.js");
  const ahub = row(51, 50, 51, `bun /r/src/cli/main.ts --project ${DIR} kill`); // the runner's own command naming the fixture
  const owners = new Map<string, Actor>();
  captureActors(owners, [...everything, shell, launched, elsewhere, launched2, prefix, mcp, ahub], arm);
  const roles = Object.fromEntries([...owners.values()].map((a) => [a.pid, a.role]));
  expect(roles).toEqual({ 100: "daemon", 105: "codex-app-server", 106: "below", 107: "below", 108: "below", 120: "claude", 130: "claude", 131: "claude", 141: "claude" });
  // A replacement daemon on the same fixture is never adopted once the arm's is recorded, nor a daemon for another fixture.
  const replacement = row(200, 1, 200, `/opt/bun /r/src/cli/main.ts --project ${DIR} daemon`);
  captureActors(owners, [runner, replacement], { ...arm, hubPid: 200 });
  expect([...owners.values()].some((a) => a.pid === 200)).toBe(false);
  const other = new Map<string, Actor>();
  captureActors(other, [runner, row(100, 1, 100, "/opt/bun /r/src/cli/main.ts --project /private/tmp/other daemon"), launcher], arm);
  expect(other.size).toBe(0);
  // What the runner itself runs is never the arm's, even under a recorded process.
  const mine = new Map<string, Actor>();
  captureActors(mine, [runner, row(100, 50, 100, daemon.command)], arm);
  expect(mine.size).toBe(0);
});

test("a normal shutdown that stops every actor and what runs below them is clean, with nothing signalled", async () => {
  const { w, deps, shutdown } = world(everything, { shutdown: (x) => { x.rows = [runner]; return []; } });
  const c = await teardown(actors(everything), DIR, shutdown, deps);
  expect(c.outcome).toBe("clean");
  expect(c.owned.map((a) => [a.pid, a.role])).toEqual([[100, "daemon"], [105, "codex-app-server"], [120, "claude"], [106, "below"], [107, "below"]]);
  expect(w.signals).toEqual([]);
});

test("a lost acknowledgement is followed by a fallback on proven identities only, groups by their leader: clean_with_fallback", async () => {
  // `ahub kill` said nothing and stopped nothing: Codex's tool command, in a group of its own, is found below the native.
  const { w, deps, shutdown } = world(everything, { shutdown: () => ["ahub kill: hub did not acknowledge shutdown"] });
  const c = await teardown(actors(everything), DIR, shutdown, deps);
  expect(c.outcome).toBe("clean_with_fallback");
  expect(c.normal.errors).toEqual(["ahub kill: hub did not acknowledge shutdown"]);
  expect(w.signals).toEqual([[-100, "SIGTERM"], [-105, "SIGTERM"], [-120, "SIGTERM"], [-107, "SIGTERM"]]);
  expect(w.rows).toEqual([runner]);
});

test("a fallback that cannot stop an actor leaves the cleanup incomplete, and says which", async () => {
  const { deps, shutdown } = world(everything, { stubborn: [106] });
  const c = await teardown(actors(everything), DIR, shutdown, deps);
  expect(c.outcome).toBe("incomplete_or_unknown");
  expect(c.remaining.map((a) => a.pid)).toEqual([106]);
  expect(c.reasons).toEqual(["still running: below 106"]);
  expect(c.fallback.filter((f) => f.signal === "SIGKILL").map((f) => f.pid)).toEqual([106]); // its leader is gone: by pid
});

test("a process table that cannot be read proves nothing: the cleanup is unknown, never clean", async () => {
  let reads = 0;
  const { deps, shutdown } = world(everything, { shutdown: (x) => { x.rows = [runner]; return []; }, unreadable: () => ++reads > 1 });
  const c = await teardown(actors(everything), DIR, shutdown, deps);
  expect(c.outcome).toBe("incomplete_or_unknown");
  expect(c.reasons).toEqual(["the process table could not be read after the shutdown: whether the arm stopped is unknown"]);
});

test("a reused pid, a replacement hub on the same fixture and a foreign process are never signalled", async () => {
  // The daemon exited and its pid now belongs to someone else; a new hub instance serves the same fixture; an editor
  // has a fixture file open; the runner's own `ahub kill` names the fixture too.
  const reused = row(100, 1, 100, "/usr/bin/vim notes.txt", "Sat Oct  3 08:05:00 2026");
  const replacement = row(200, 1, 200, `/opt/bun /r/src/cli/main.ts --project ${DIR} daemon`, "Sat Oct  3 08:06:00 2026");
  const editor = row(300, 1, 300, `/usr/bin/vim ${DIR}/src/a.py`);
  const own = row(51, 50, 51, `bun /r/src/cli/main.ts --project ${DIR} kill`);
  const recorded = actors(everything);
  const { w, deps, shutdown } = world([runner, own, reused, launcher, native, replacement, editor], { shutdown: (x) => { x.rows = x.rows.filter((r) => ![105, 106].includes(r.pid)); return []; } });
  const c = await teardown(recorded, DIR, shutdown, deps);
  expect(w.signals).toEqual([]);
  expect(w.rows.map((r) => r.pid)).toEqual([50, 51, 100, 200, 300]);
  expect(c.remaining).toEqual([]); // the recorded daemon and Claude were gone before teardown: pid 100 is someone else now
  expect(c.unresolved.map((u) => u.pid)).toEqual([200, 300]);
  expect(c.outcome).toBe("incomplete_or_unknown");
  expect(daemonRoot(replacement.command)).toBe(DIR);
});

test("against the real process table: a stray group below an actor is stopped by the fallback", async () => {
  // An actor whose child leads a group of its own and outlives a shutdown that did nothing.
  const proc = spawn("sh", ["-c", `trap "" TERM; ${process.execPath} -e 'require("node:child_process").spawn("sleep", ["30"], { detached: true, stdio: "ignore" })' & sleep 0.5; pgrep -P $! sleep; wait`], { stdio: ["ignore", "pipe", "ignore"], detached: true });
  keep(proc.pid!);
  const child = Number(await new Promise<string>((resolve) => proc.stdout!.once("data", (d) => resolve(String(d)))));
  keep(child);
  const a = actorOf(processTable()!, proc.pid!, "codex-app-server", "spawned by the test")!;
  const c = await teardown([a], "/nonexistent-fixture", async () => [], undefined, { settleMs: 300, fallbackMs: 2000 });
  expect({ outcome: c.outcome, reasons: c.reasons }).toEqual({ outcome: "clean_with_fallback", reasons: [] });
  expect(c.owned.some((o) => o.pid === child)).toBe(true);
  const left = processTable()!;
  expect(left.some((r) => r.pid === child || r.pid === proc.pid)).toBe(false);
});

const S = "s-1";
const prompt = { type: "user", sessionId: S, message: { content: "[agent-hub] task #1" } };
const toolUse = { type: "assistant", sessionId: S, message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1" }] } };
const toolResult = { type: "user", sessionId: S, message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } };
const answer = { type: "assistant", sessionId: S, message: { stop_reason: "end_turn", content: [{ type: "text", text: "[FYI] done" }] } };
const ended = { type: "system", subtype: "turn_duration", sessionId: S, durationMs: 4000 };

test("a turn has ended only when the session's turn_duration row follows its last activity", () => {
  expect(turnEnded([prompt, toolUse, toolResult], S)).toBe(false); // tool use only
  expect(turnEnded([prompt, toolUse, toolResult, answer], S)).toBe(false); // a final answer alone is not the end
  expect(turnEnded([prompt, toolUse, toolResult, answer, ended], S)).toBe(true);
  expect(turnEnded([prompt, answer, { ...ended, sessionId: "other" }], S)).toBe(false); // another session's row
  expect(turnEnded([prompt, answer, ended, { type: "attachment", sessionId: S }, prompt], S)).toBe(false); // a new turn began
  expect(turnEnded([], S)).toBe(false);
});

test("the wait for the turn's end: ended when the row arrives, timeout at the bound, interrupted by a stop, unreadable without a file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-teardown-"));
  dirs.push(dir);
  const file = join(dir, "s.jsonl");
  writeFileSync(file, [prompt, toolUse, toolResult].map((r) => JSON.stringify(r)).join("\n") + "\n");
  let clock = 0;
  // The final answer is written while the wait runs.
  const late = { now: () => clock, sleep: async (ms: number) => { clock += ms; if (clock === 750) appendFileSync(file, [answer, ended].map((r) => JSON.stringify(r)).join("\n") + "\n"); } };
  expect(await awaitTurnEnd(file, S, 30_000, () => false, late)).toEqual({ outcome: "ended", ms: 750 });
  writeFileSync(file, JSON.stringify(prompt) + "\n");
  clock = 0;
  const idle = { now: () => clock, sleep: async (ms: number) => void (clock += ms) };
  expect(await awaitTurnEnd(file, S, 30_000, () => false, idle)).toEqual({ outcome: "timeout", ms: 30_000 });
  clock = 0;
  expect((await awaitTurnEnd(file, S, 30_000, () => clock >= 500, idle)).outcome).toBe("interrupted");
  expect((await awaitTurnEnd(join(dir, "missing.jsonl"), S, 30_000, () => false, idle)).outcome).toBe("unreadable");
});

test("restoration: modes come back parents first and failures are named; a trust entry the user changed is kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-teardown-"));
  dirs.push(dir);
  mkdirSync(join(dir, "a"));
  writeFileSync(join(dir, "a", "f"), "x");
  chmodSync(join(dir, "a", "f"), 0);
  chmodSync(join(dir, "a"), 0);
  const failed = restoreModes([[join(dir, "a", "f"), 0o640], [join(dir, "a"), 0o750], [join(dir, "gone"), 0o600]]);
  expect(failed).toEqual([join(dir, "gone")]); // a lost read-lock acknowledgement is reported, not assumed
  expect(statSync(join(dir, "a", "f")).mode & 0o777).toBe(0o640);
  // A locked directory replaced by a link: refused, and nothing below it is reached through the link.
  mkdirSync(join(dir, "outside"));
  writeFileSync(join(dir, "outside", "f"), "x");
  chmodSync(join(dir, "outside", "f"), 0o600);
  symlinkSync(join(dir, "outside"), join(dir, "b"));
  expect(restoreModes([[join(dir, "b", "f"), 0o644], [join(dir, "b"), 0o755]])).toEqual([join(dir, "b"), join(dir, "b", "f")]);
  expect(statSync(join(dir, "outside", "f")).mode & 0o777).toBe(0o600);

  const file = join(dir, "claude.json");
  const fixture = "/private/tmp/f";
  writeFileSync(file, JSON.stringify({ projects: { [fixture]: { hasTrustDialogAccepted: true, other: 1 } } }));
  expect(restoreTrust({ file, previous: undefined, hadProjects: false, mode: 0o600 }, fixture)).toBe("restored");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  writeFileSync(file, JSON.stringify({ projects: { [fixture]: { hasTrustDialogAccepted: false } } })); // the user's change
  expect(restoreTrust({ file, previous: undefined, hadProjects: false, mode: 0o600 }, fixture)).toBe("changed_concurrently");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ projects: { [fixture]: { hasTrustDialogAccepted: false } } });
  expect(restoreTrust({ file: join(dir, "missing.json"), previous: undefined, hadProjects: false, mode: 0o600 }, fixture)).toBe("failed");
  // The runner's own write never landed (it stopped between the lease and the rename): nothing to take back (#115).
  writeFileSync(file, JSON.stringify({ projects: {} }));
  expect(restoreTrust({ file, previous: undefined, hadProjects: true, mode: 0o600 }, fixture, true)).toBe("not_written");
});

test("recovery puts the withheld read modes back only when the runner, every recorded process and anything in the fixture are gone", async () => {
  const { recover } = await import("../../scripts/benchmarks/restore.ts");
  const run = mkdtempSync(join(tmpdir(), "ahub-teardown-"));
  dirs.push(run);
  const fixture = join(run, "fixtures", "00-x");
  mkdirSync(fixture, { recursive: true });
  const input = join(run, "gold.patch"), sibling = join(run, "sibling.json");
  writeFileSync(input, "x");
  writeFileSync(sibling, "{}");
  chmodSync(input, 0);
  chmodSync(sibling, 0);
  const table = processTable()!;
  const me = table.find((r) => r.pid === process.pid)!;
  const gone = { pid: me.pid, started: "Thu Jan  1 00:00:00 1970" }; // the same pid, started another time: not this process
  const trustFile = join(run, "claude.json");
  writeFileSync(trustFile, JSON.stringify({ projects: { [fixture]: { hasTrustDialogAccepted: true, lastCost: 2 } } }));
  const trust = { file: trustFile, project: fixture, previous: undefined, hadProjects: false, mode: 0o600, stage: "written", restored: false };
  const ledger = (runner: object, actors: object[]) => writeFileSync(join(run, "restoration-ledger.json"), JSON.stringify({ runner, protected: { paths: { [input]: 0o600 }, restored: false }, siblings: { [fixture]: { modes: { [sibling]: 0o600 }, restored: false } }, actors: { [fixture]: actors }, trust }));
  mkdirSync(join(run, "recovery", "runs"), { recursive: true });
  mkdirSync(join(run, "recovery", "patches"), { recursive: true });
  writeFileSync(join(run, "recovery", "patches", "00-x.patch"), "diff");
  writeFileSync(join(run, "recovery", "runs", "00-x.json"), JSON.stringify({ cwd: fixture, patchFile: join(run, "recovery", "patches", "00-x.patch"), cleanup: { owned: [], unresolved: [] } }));
  // The runner still runs (here: this test process stands for it), then a recorded actor, then a shell in the fixture.
  ledger({ pid: me.pid, started: me.started }, []);
  expect(recover(run, table, new Map(), -1).blockers).toEqual([`the runner ${me.pid} is still running`]);
  ledger(gone, [{ role: "codex-app-server", pid: me.pid, started: me.started }]);
  expect(recover(run, table, new Map(), -1).blockers).toEqual([`${fixture}: codex-app-server ${me.pid} is still running`]);
  ledger(gone, [{ role: "codex-app-server", ...gone }]);
  expect(recover(run, table, new Map([[me.pid, join(fixture, "src")]]), -1).blockers).toEqual([`${me.pid} works in ${fixture}`]);
  expect(recover(run, table, undefined, -1).blockers).toEqual(["working directories cannot be read"]);
  expect(statSync(input).mode & 0o777).toBe(0);
  // Nothing of it runs: the modes come back, the kept record joins the run's own, and the run says so.
  expect(recover(run, table, new Map(), -1)).toEqual({ restored: true, blockers: [], failed: [] });
  expect([statSync(input).mode & 0o777, statSync(sibling).mode & 0o777]).toEqual([0o600, 0o600]);
  expect(JSON.parse(readFileSync(join(run, "runs", "00-x.json"), "utf8"))).toMatchObject({ recovered: true, patchFile: join(run, "patches", "00-x.patch") });
  expect(readFileSync(join(run, "patches", "00-x.patch"), "utf8")).toBe("diff");
  expect(JSON.parse(readFileSync(join(run, "restoration.json"), "utf8"))).toMatchObject({ restored: true, recovered: true });
  expect(JSON.parse(readFileSync(trustFile, "utf8"))).toEqual({}); // the runner's trust entry taken back too
  expect(recover(run, undefined, undefined, -1).restored).toBe(true); // done once: nothing left to do
});

test("recovery after a runner that died mid trust write removes its temp files and records the write as never landed", async () => {
  const { recover } = await import("../../scripts/benchmarks/restore.ts");
  const { restoreTemp, trustTemp } = await import("../../scripts/benchmarks/teardown.ts");
  const run = mkdtempSync(join(tmpdir(), "ahub-teardown-"));
  dirs.push(run);
  const fixture = join(run, "fixtures", "00-x");
  mkdirSync(fixture, { recursive: true });
  const trustFile = join(run, "claude.json");
  writeFileSync(trustFile, JSON.stringify({ projects: {} })); // the rename never happened
  const runner = { pid: 99_999_999, started: "Thu Jan  1 00:00:00 1970" };
  writeFileSync(trustTemp(trustFile, runner.pid), JSON.stringify({ projects: { [fixture]: { hasTrustDialogAccepted: true } } }));
  writeFileSync(restoreTemp(trustFile, runner.pid), "{}"); // and one from a restore it died in
  writeFileSync(join(run, "restoration-ledger.json"), JSON.stringify({ runner, protected: { paths: {}, restored: true }, siblings: {}, actors: {}, trust: { file: trustFile, project: fixture, previous: undefined, hadProjects: true, mode: 0o600, stage: "pending", restored: false } }));
  expect(recover(run, processTable()!, new Map(), -1)).toEqual({ restored: true, blockers: [], failed: [] });
  expect([existsSync(trustTemp(trustFile, runner.pid)), existsSync(restoreTemp(trustFile, runner.pid))]).toEqual([false, false]);
  expect(JSON.parse(readFileSync(join(run, "restoration-ledger.json"), "utf8")).trust).toMatchObject({ restored: true, stage: "not_written" });
});

test("a write the runner knew never landed, its temp file left: the recovery removes the copy and touches no entry", async () => {
  const { recover } = await import("../../scripts/benchmarks/restore.ts");
  const { trustTemp } = await import("../../scripts/benchmarks/teardown.ts");
  const run = mkdtempSync(join(tmpdir(), "ahub-teardown-"));
  dirs.push(run);
  const fixture = join(run, "fixtures", "00-x");
  mkdirSync(fixture, { recursive: true });
  const trustFile = join(run, "claude.json");
  const theirs = { projects: { [fixture]: { hasTrustDialogAccepted: true, theirs: 1 } } }; // set by someone else meanwhile
  writeFileSync(trustFile, JSON.stringify(theirs));
  const runner = { pid: 99_999_997, started: "Thu Jan  1 00:00:00 1970" };
  writeFileSync(trustTemp(trustFile, runner.pid), "{}");
  writeFileSync(join(run, "restoration-ledger.json"), JSON.stringify({ runner, protected: { paths: {}, restored: true }, siblings: {}, actors: {}, trust: { file: trustFile, project: fixture, previous: undefined, hadProjects: true, mode: 0o600, stage: "not_written", restored: false } }));
  expect(recover(run, processTable()!, new Map(), -1)).toEqual({ restored: true, blockers: [], failed: [] });
  expect(existsSync(trustTemp(trustFile, runner.pid))).toBe(false);
  expect(JSON.parse(readFileSync(trustFile, "utf8"))).toEqual(theirs);
  expect(JSON.parse(readFileSync(join(run, "restoration-ledger.json"), "utf8")).trust).toMatchObject({ restored: true, stage: "not_written" });
});

test("the runner settles its trust lease by one table: a pending write touches no entry, contained or not", async () => {
  const { settleTrust } = await import("../../scripts/benchmarks/teardown.ts");
  const calls: string[] = [];
  const settle = (stage: string, contained: boolean, removed = true, restored = "restored") =>
    settleTrust(stage, contained, () => { calls.push("rm"); return removed; }, () => { calls.push("restore"); return restored; });
  const table = [
    [settle("pending", true), { outcome: "not_written", stage: "not_written", restored: true }],
    [settle("pending", false), { outcome: "not_written", stage: "not_written", restored: true }],
    [settle("pending", true, false), { outcome: "kept: the trust write's temp file could not be removed", stage: "not_written", restored: false }],
    [settle("pending", false, false), { outcome: "kept: the trust write's temp file could not be removed", stage: "not_written", restored: false }],
    [settle("written", false), { outcome: "kept: the cleanup is incomplete or unknown", stage: "written", restored: false }],
    [settle("written", true), { outcome: "restored", stage: "restored", restored: true }],
    [settle("written", true, true, "changed_concurrently"), { outcome: "changed_concurrently", stage: "changed_concurrently", restored: false }],
    [settle("written", true, true, "failed"), { outcome: "failed", stage: "failed", restored: false }],
  ] as const;
  for (const [got, want] of table) expect(got).toEqual(want);
  // A pending write never reaches the restore; only written leases do, and only contained ones.
  expect(calls).toEqual(["rm", "rm", "rm", "rm", "restore", "restore", "restore"]);
});

test("a dead runner's pending write: only the exact entry it would have written is taken back", async () => {
  const { recover } = await import("../../scripts/benchmarks/restore.ts");
  const { trustTemp } = await import("../../scripts/benchmarks/teardown.ts");
  const setup = (entry: object | undefined, temp: boolean) => {
    const run = mkdtempSync(join(tmpdir(), "ahub-teardown-"));
    dirs.push(run);
    const fixture = join(run, "fixtures", "00-x");
    mkdirSync(fixture, { recursive: true });
    const trustFile = join(run, "claude.json");
    writeFileSync(trustFile, JSON.stringify({ projects: entry ? { [fixture]: entry } : {} }));
    const runner = { pid: 99_999_995, started: "Thu Jan  1 00:00:00 1970" };
    if (temp) writeFileSync(trustTemp(trustFile, runner.pid), "{}");
    const written = { hasTrustDialogAccepted: true };
    writeFileSync(join(run, "restoration-ledger.json"), JSON.stringify({ runner, protected: { paths: {}, restored: true }, siblings: {}, actors: {}, trust: { file: trustFile, project: fixture, previous: undefined, written, hadProjects: true, mode: 0o600, stage: "pending", restored: false } }));
    expect(recover(run, processTable()!, new Map(), -1).restored).toBe(true);
    return { entry: JSON.parse(readFileSync(trustFile, "utf8")).projects[fixture], stage: JSON.parse(readFileSync(join(run, "restoration-ledger.json"), "utf8")).trust.stage };
  };
  // It died after the rename: the entry is exactly its write, and goes.
  expect(setup({ hasTrustDialogAccepted: true }, false)).toEqual({ entry: undefined, stage: "restored" });
  // The user trusted the fixture meanwhile (more than the runner writes): theirs.
  expect(setup({ hasTrustDialogAccepted: true, theirs: 1 }, false)).toEqual({ entry: { hasTrustDialogAccepted: true, theirs: 1 }, stage: "not_written" });
  // Its temp file still there: the rename never happened, so even an identical entry is someone else's.
  expect(setup({ hasTrustDialogAccepted: true }, true)).toEqual({ entry: { hasTrustDialogAccepted: true }, stage: "not_written" });
});

test("the recovery's own restore names its temp file by the runner's pid, where a later recovery looks", async () => {
  const { recover } = await import("../../scripts/benchmarks/restore.ts");
  const { restoreTemp } = await import("../../scripts/benchmarks/teardown.ts");
  const run = mkdtempSync(join(tmpdir(), "ahub-teardown-"));
  dirs.push(run);
  const fixture = join(run, "fixtures", "00-x");
  mkdirSync(fixture, { recursive: true });
  const trustFile = join(run, "claude.json");
  writeFileSync(trustFile, JSON.stringify({ projects: { [fixture]: { hasTrustDialogAccepted: true } } }));
  const runner = { pid: 99_999_994, started: "Thu Jan  1 00:00:00 1970" };
  // A name under the recovery's own pid cannot be written: a restore that used it would fail.
  mkdirSync(join(restoreTemp(trustFile, process.pid), "x"), { recursive: true });
  try {
    writeFileSync(join(run, "restoration-ledger.json"), JSON.stringify({ runner, protected: { paths: {}, restored: true }, siblings: {}, actors: {}, trust: { file: trustFile, project: fixture, previous: undefined, written: { hasTrustDialogAccepted: true }, hadProjects: true, mode: 0o600, stage: "written", restored: false } }));
    // As in production, the recovery is this process: neither its pid nor `self` may name the temp file.
    expect(recover(run, processTable()!, new Map(), process.pid)).toEqual({ restored: true, blockers: [], failed: [] });
    expect(JSON.parse(readFileSync(trustFile, "utf8"))).toEqual({ projects: {} });
  } finally { rmSync(restoreTemp(trustFile, process.pid), { recursive: true, force: true }); }
});

// issue #120: the state on disk says "not restored" while anything is locked, and a stale `restored: true` is not trusted.
test("what a ledger holds unrestored, and whether a run directory may be used again", async () => {
  const { reuseProblem, unrestored } = await import("../../scripts/benchmarks/teardown.ts");
  const done = { protected: { paths: { "/x": 420 }, restored: true }, siblings: { a: { modes: {}, restored: true } }, trust: { stage: "restored", restored: true } };
  expect(unrestored(undefined)).toEqual([]);
  expect(unrestored({})).toEqual([]);
  expect(unrestored(done)).toEqual([]);
  expect(unrestored({ ...done, protected: { paths: { "/x": 420 }, restored: false } })).toEqual(["protected inputs"]);
  expect(unrestored({ ...done, protected: { paths: {}, restored: false } })).toEqual([]); // nothing was locked
  expect(unrestored({ ...done, siblings: { a: { restored: true }, b: { restored: false } } })).toEqual(["sibling read locks of 1 arm(s)"]);
  expect(unrestored({ ...done, trust: { stage: "pending", restored: false } })).toEqual(["the Claude trust entry"]);
  expect(unrestored({ ...done, trust: { stage: "changed_concurrently", restored: false } })).toEqual([]); // the user's
  expect(unrestored({ ...done, trust: { stage: "not_written", restored: true } })).toEqual([]); // never written, temp gone
  expect(unrestored({ ...done, trust: { stage: "not_written", restored: false } })).toEqual(["the trust write's temp file (a copy of ~/.claude.json)"]);
  const text = (o: unknown) => JSON.stringify(o);
  expect(reuseProblem(undefined, undefined)).toBeUndefined(); // a fresh directory
  expect(reuseProblem(text({ restored: true }), text(done))).toBeUndefined(); // an earlier invocation ended restored
  expect(reuseProblem(text({ restored: true }), undefined)).toBeUndefined();
  expect(reuseProblem(text({ restored: false, runner: { pid: 1 } }), text(done))).toContain("not restored");
  expect(reuseProblem("{cut", undefined)).toContain("not restored");
  expect(reuseProblem(text({ restored: true }), "{cut")).toContain("cannot be read");
  expect(reuseProblem(text({ restored: true }), text({ ...done, protected: { paths: { "/x": 420 }, restored: false } }))).toContain("unrestored: protected inputs");
  // A ledger from before 0.12.5 (no runner) under restored: true owes its locks, not its trust entry, as the recovery says.
  const legacy = { protected: { paths: { "/x": 420 }, restored: true }, siblings: {}, trust: { stage: "written", restored: false } };
  expect(reuseProblem(text({ restored: true }), text(legacy))).toBeUndefined();
  expect(reuseProblem(text({ restored: true }), text({ ...legacy, protected: { paths: { "/x": 420 }, restored: false } }))).toContain("unrestored: protected inputs");
  expect(reuseProblem(undefined, text(legacy))).toContain("the Claude trust entry"); // no restored: true to trust
  expect(reuseProblem(undefined, text({ ...done, siblings: { b: { restored: false } } }))).toContain("sibling read locks");
});

test("a stale restored: true over a ledger that still holds locks is not trusted: the recovery restores them", async () => {
  const { recover } = await import("../../scripts/benchmarks/restore.ts");
  const run = mkdtempSync(join(tmpdir(), "ahub-teardown-"));
  dirs.push(run);
  const input = join(run, "input.txt");
  writeFileSync(input, "x");
  chmodSync(input, 0); // a re-run locked it and was killed before its outcome
  const runner = { pid: 99_999_993, started: "Thu Jan  1 00:00:00 1970" };
  writeFileSync(join(run, "restoration.json"), JSON.stringify({ restored: true, paths: 1 })); // the earlier invocation's
  writeFileSync(join(run, "restoration-ledger.json"), JSON.stringify({ runner, protected: { paths: { [input]: 0o644 }, restored: false }, siblings: {}, actors: {}, trust: undefined }));
  expect(recover(run, processTable()!, new Map(), process.pid)).toEqual({ restored: true, blockers: [], failed: [] });
  expect(statSync(input).mode & 0o777).toBe(0o644);
  expect(JSON.parse(readFileSync(join(run, "restoration.json"), "utf8"))).toMatchObject({ restored: true, recovered: true });
});

test("a ledger from before 0.12.5 (no runner identity) under restored: true keeps its trust entry as then, and still owes its locks", async () => {
  const { recover } = await import("../../scripts/benchmarks/restore.ts");
  const run = mkdtempSync(join(tmpdir(), "ahub-teardown-"));
  dirs.push(run);
  const fixture = join(run, "fixtures", "00-x");
  mkdirSync(fixture, { recursive: true });
  const trustFile = join(run, "claude.json");
  const theirs = { projects: { [fixture]: { hasTrustDialogAccepted: true, mine: "user" } } };
  writeFileSync(trustFile, JSON.stringify(theirs));
  // 0.12.3 and 0.12.4 wrote restored: true and left a concurrently changed entry at `written`, unrecorded.
  writeFileSync(join(run, "restoration.json"), JSON.stringify({ restored: true, paths: 1 }));
  writeFileSync(join(run, "restoration-ledger.json"), JSON.stringify({ protected: { paths: {}, restored: true }, siblings: {}, actors: {}, trust: { file: trustFile, project: fixture, previous: undefined, written: { hasTrustDialogAccepted: true }, hadProjects: true, mode: 0o600, stage: "written", restored: false } }));
  expect(recover(run, processTable()!, new Map(), -1, true)).toEqual({ restored: true, blockers: [], failed: [] });
  expect(JSON.parse(readFileSync(trustFile, "utf8"))).toEqual(theirs);
  // Its locks are still owed: a re-run that died there left the inputs at 000, and the recovery restores them, trust aside.
  const input = join(run, "input.txt");
  writeFileSync(input, "x");
  chmodSync(input, 0);
  const ledger = JSON.parse(readFileSync(join(run, "restoration-ledger.json"), "utf8"));
  writeFileSync(join(run, "restoration-ledger.json"), JSON.stringify({ ...ledger, protected: { paths: { [input]: 0o644 }, restored: false } }));
  expect(recover(run, processTable()!, new Map(), -1, true)).toEqual({ restored: true, blockers: [], failed: [] });
  expect(statSync(input).mode & 0o777).toBe(0o644);
  expect(JSON.parse(readFileSync(trustFile, "utf8"))).toEqual(theirs);
  // A 0.12.7 runner accepted the directory, wrote its marker and died before a ledger of its own: still the old ledger.
  writeFileSync(join(run, "restoration.json"), JSON.stringify({ restored: false, runner: { pid: 99_999_990, started: "Thu Jan  1 00:00:00 1970" } }));
  expect(recover(run, processTable()!, new Map(), -1)).toEqual({ restored: true, blockers: [], failed: [] });
  expect(JSON.parse(readFileSync(trustFile, "utf8"))).toEqual(theirs);
});

test("a runner the process table missed, read before the files, is checked again right before anything is restored", async () => {
  const { recover } = await import("../../scripts/benchmarks/restore.ts");
  const me = processTable()!.find((r) => r.pid === process.pid)!;
  const run = mkdtempSync(join(tmpdir(), "ahub-teardown-"));
  dirs.push(run);
  const input = join(run, "input.txt");
  writeFileSync(input, "x");
  chmodSync(input, 0);
  writeFileSync(join(run, "restoration.json"), JSON.stringify({ restored: false, runner: { pid: me.pid, started: me.started } }));
  writeFileSync(join(run, "restoration-ledger.json"), JSON.stringify({ runner: { pid: me.pid, started: me.started }, protected: { paths: { [input]: 0o644 }, restored: false }, siblings: {}, actors: {} }));
  // The first table predates the runner; the files name it, and it runs.
  const before = processTable()!.filter((r) => r.pid !== process.pid);
  const result = recover(run, before, new Map(), -1);
  expect(result.restored).toBe(false);
  expect(result.blockers).toEqual([`the runner ${me.pid} is still running`]);
  expect(statSync(input).mode & 0o777).toBe(0); // nothing restored under a running runner
});

test("the runner restoration.json names holds the recovery while it runs; dead, with no ledger, there is nothing to restore", async () => {
  const { recover } = await import("../../scripts/benchmarks/restore.ts");
  const me = processTable()!.find((r) => r.pid === process.pid)!;
  const marker = (runner: { pid: number; started: string }) => JSON.stringify({ restored: false, reason: "the runner is running, or died before writing its outcome", runner });
  const live = mkdtempSync(join(tmpdir(), "ahub-teardown-"));
  dirs.push(live);
  writeFileSync(join(live, "restoration.json"), marker({ pid: me.pid, started: me.started }));
  const held = recover(live, processTable()!, new Map(), -1);
  expect(held.restored).toBe(false);
  expect(held.blockers).toContain(`the runner ${me.pid} is still running`);
  const dead = mkdtempSync(join(tmpdir(), "ahub-teardown-"));
  dirs.push(dead);
  writeFileSync(join(dead, "restoration.json"), marker({ pid: 99_999_992, started: "Thu Jan  1 00:00:00 1970" }));
  expect(recover(dead, processTable()!, new Map(), -1)).toEqual({ restored: true, blockers: [], failed: [] });
  expect(existsSync(join(dead, "restoration-ledger.json"))).toBe(false); // no ledger made up
  expect(JSON.parse(readFileSync(join(dead, "restoration.json"), "utf8")).restored).toBe(true);
  // Neither file: no runner got as far as its marker, so there is nothing to recover, and nothing is written.
  const untouched = mkdtempSync(join(tmpdir(), "ahub-teardown-"));
  dirs.push(untouched);
  expect(recover(untouched, processTable()!, new Map(), -1)).toEqual({ restored: true, blockers: [], failed: [] });
  expect(existsSync(join(untouched, "restoration.json"))).toBe(false);
});

test("an entry the user changed meanwhile (changed_concurrently) is theirs: the recovery leaves it", async () => {
  const { recover } = await import("../../scripts/benchmarks/restore.ts");
  const run = mkdtempSync(join(tmpdir(), "ahub-teardown-"));
  dirs.push(run);
  const fixture = join(run, "fixtures", "00-x");
  mkdirSync(fixture, { recursive: true });
  const trustFile = join(run, "claude.json");
  const theirs = { projects: { [fixture]: { hasTrustDialogAccepted: true, theirs: 1 } } };
  writeFileSync(trustFile, JSON.stringify(theirs));
  const runner = { pid: 99_999_996, started: "Thu Jan  1 00:00:00 1970" };
  writeFileSync(join(run, "restoration-ledger.json"), JSON.stringify({ runner, protected: { paths: {}, restored: true }, siblings: {}, actors: {}, trust: { file: trustFile, project: fixture, previous: undefined, hadProjects: true, mode: 0o600, stage: "changed_concurrently", restored: false } }));
  expect(recover(run, processTable()!, new Map(), -1)).toEqual({ restored: true, blockers: [], failed: [] });
  expect(JSON.parse(readFileSync(trustFile, "utf8"))).toEqual(theirs);
});

test("a temp file the recovery cannot remove keeps the trust entry open until a later recovery removes it", async () => {
  const { recover } = await import("../../scripts/benchmarks/restore.ts");
  const { restoreTemp } = await import("../../scripts/benchmarks/teardown.ts");
  const run = mkdtempSync(join(tmpdir(), "ahub-teardown-"));
  dirs.push(run);
  const fixture = join(run, "fixtures", "00-x");
  mkdirSync(fixture, { recursive: true });
  const trustFile = join(run, "claude.json");
  writeFileSync(trustFile, JSON.stringify({ projects: { [fixture]: { hasTrustDialogAccepted: true } } }));
  const runner = { pid: 99_999_998, started: "Thu Jan  1 00:00:00 1970" };
  const stuck = restoreTemp(trustFile, runner.pid);
  mkdirSync(join(stuck, "x"), { recursive: true }); // a removal that fails: a non-empty directory
  writeFileSync(join(run, "restoration-ledger.json"), JSON.stringify({ runner, protected: { paths: {}, restored: true }, siblings: {}, actors: {}, trust: { file: trustFile, project: fixture, previous: undefined, hadProjects: true, mode: 0o600, stage: "written", restored: false } }));
  expect(recover(run, processTable()!, new Map(), -1)).toEqual({ restored: false, blockers: [], failed: [stuck] });
  expect(JSON.parse(readFileSync(join(run, "restoration-ledger.json"), "utf8")).trust.restored).toBe(false);
  rmSync(stuck, { recursive: true });
  expect(recover(run, processTable()!, new Map(), -1)).toEqual({ restored: true, blockers: [], failed: [] });
  expect(JSON.parse(readFileSync(trustFile, "utf8"))).toEqual({ projects: {} });
});

test("a first read that fails keeps every recorded actor: the fallback still acts on them, and the cleanup is unknown", async () => {
  // A Ctrl-C can kill the first `ps`: what ran below the actors then is unknown, the actors themselves are not.
  let reads = 0;
  const { w, deps, shutdown } = world(everything, { unreadable: () => ++reads === 1, shutdown: () => ["ahub kill: hub did not acknowledge shutdown"] });
  const c = await teardown(actors(everything), DIR, shutdown, deps);
  expect(c.owned.slice(0, 3).map((a) => a.pid)).toEqual([100, 105, 120]);
  expect(c.fallback.length).toBeGreaterThan(0);
  expect(w.rows).toEqual([runner]);
  expect(c.outcome).toBe("incomplete_or_unknown");
  expect(c.reasons).toEqual(["the process table could not be read before the shutdown: what ran below the recorded actors is unknown"]);
});

test("a background job in a recorded group is the arm's while that group is known; one that left it, or a visitor in the fixture, is left alone and keeps the cleanup open", async () => {
  // The tool shell 107 was recorded and has exited; its `sh -c serve` 109 was recorded too and still runs, so group 107
  // is still that group and its unrecorded job 108 is the arm's. 110 left for a session of its own: no proof, only its
  // working directory in the fixture. 400 is someone's shell sitting in the fixture.
  const keeper = row(109, 1, 107, "sh -c serve");
  const job = row(108, 1, 107, "python server.py");
  const escaped = row(110, 1, 110, "python worker.py");
  const visitor = row(400, 1, 400, "-zsh");
  const below = (r: ProcRow) => ({ role: "below" as const, pid: r.pid, started: r.started, pgid: r.pgid, via: "below codex-app-server 105" });
  const recorded = [...actors(everything), below(row(107, 106, 107, "sh -c tool")), below(keeper)];
  const { w, deps, shutdown } = world([runner, daemon, launcher, native, claude, keeper, job, escaped, visitor], { cwds: new Map([[108, DIR], [110, DIR], [400, `${DIR}/src`]]), shutdown: (x) => { x.rows = x.rows.filter((r) => ![100, 105, 106, 120].includes(r.pid)); return []; } });
  // The executable's name for 110 (as `ps -o ucomm` gives it); 400's could not be read: then none is recorded, never a guess.
  const c = await teardown(recorded, DIR, shutdown, { ...deps, comm: (pid, started) => (pid === 110 && started === T ? "python3" : undefined) });
  expect(c.owned.find((a) => a.pid === 108)?.via).toBe("group of below 107");
  expect(w.signals).toEqual([[109, "SIGTERM"], [108, "SIGTERM"]]); // by pid: their leader is gone
  expect(c.unresolved).toEqual([{ pid: 110, started: T, program: "python3", cwd: DIR }, { pid: 400, started: T, cwd: `${DIR}/src` }]);
  expect(w.rows.map((r) => r.pid)).toEqual([50, 110, 400]);
  expect(c.outcome).toBe("incomplete_or_unknown");
});

test("working directories that cannot be read leave the cleanup unknown", async () => {
  const { deps, shutdown } = world(everything, { cwds: null, shutdown: (x) => { x.rows = [runner]; return []; } });
  const c = await teardown(actors(everything), DIR, shutdown, deps);
  expect(c.reasons).toEqual(["working directories could not be read: whether anything else runs in the fixture is unknown"]);
});

test("what an actor starts while the fallback waits is recorded before its parent exits, then frozen and killed", async () => {
  // At SIGTERM Codex's native starts a helper in a session of its own, outside the fixture, and exits after the next
  // read: by the SIGKILL round nothing links the helper to the arm, unless the wait recorded it.
  let exiting = false;
  const onSignal = (pid: number, sig: string, x: { rows: ProcRow[] }) => {
    if (pid !== -105 || sig !== "SIGTERM") return false;
    x.rows = x.rows.filter((r) => r.pid !== 105).concat(row(130, 106, 130, "helper --serve"));
    exiting = true;
    return true;
  };
  const onRead = (x: { rows: ProcRow[] }) => { if (exiting) { x.rows = x.rows.filter((r) => r.pid !== 106).map((r) => (r.pid === 130 ? { ...r, ppid: 1 } : r)); exiting = false; } };
  const { w, deps, shutdown } = world([runner, launcher, native], { onSignal, onRead, shutdown: () => ["ahub kill: hub did not acknowledge shutdown"] });
  const c = await teardown([actorOf([launcher], 105, "codex-app-server", "child of the daemon")!], DIR, shutdown, deps);
  expect(c.owned.find((a) => a.pid === 130)?.via).toBe("below below 106");
  expect(w.rows).toEqual([runner]);
  expect(c.fallback.map((f) => [f.pid, f.signal])).toEqual([[105, "SIGTERM"], [130, "SIGSTOP"], [130, "SIGKILL"]]);
  expect(c.outcome).toBe("clean_with_fallback");
});

test("a process recorded in its parent's group that has since left it is signalled by the group it is in now", async () => {
  // Recorded between its fork and its setsid: its row now leads a group of its own, which the launcher's signal misses.
  const moved = row(107, 106, 107, "tool --serve");
  const recorded = [actorOf([launcher], 105, "codex-app-server", "child of the daemon")!, { role: "below" as const, pid: 107, started: T, pgid: 105, via: "below codex-app-server 105" }];
  const { w, deps, shutdown } = world([runner, launcher, native, moved], { shutdown: () => ["ahub kill: hub did not acknowledge shutdown"] });
  const c = await teardown(recorded, DIR, shutdown, deps);
  expect(w.signals).toEqual([[-105, "SIGTERM"], [-107, "SIGTERM"]]);
  expect(c.outcome).toBe("clean_with_fallback");
});

test("what the fallback's first read after the freeze shows for the first time is frozen before anything is killed", async () => {
  // The tool command survives SIGTERM, and starts a process in a group of its own just as the STOPs go out.
  const { w, deps, shutdown } = world(everything, {
    stubborn: [107],
    onSignal: (pid, sig, w) => { if (pid === -107 && sig === "SIGSTOP" && !w.rows.some((r) => r.pid === 108)) w.rows.push(row(108, 107, 108, "git commit")); return false; },
  });
  await teardown(actors(everything), DIR, shutdown, deps, { settleMs: 500, fallbackMs: 1000 });
  const late = w.signals.filter(([pid]) => pid === -108).map(([, sig]) => sig);
  expect(late.slice(0, 2)).toEqual(["SIGSTOP", "SIGKILL"]);
});

test("when the read after the freeze fails, only what the STOP reached is killed: a process the STOP missed may be gone, its pid reused", async () => {
  const { w, deps, shutdown } = world(everything, {
    stubborn: [107, 120],
    unreadable: () => w.signals.some(([, sig]) => sig === "SIGSTOP"),
    onSignal: (pid, sig) => { if (pid === -107 && sig === "SIGSTOP") throw new Error("ESRCH"); return false; },
  });
  const c = await teardown(actors(everything), DIR, shutdown, deps, { settleMs: 500, fallbackMs: 1000 });
  expect(w.signals).toContainEqual([-120, "SIGKILL"]);
  expect(w.signals).not.toContainEqual([-107, "SIGKILL"]);
  expect(c.outcome).toBe("incomplete_or_unknown");
});

test("a process frozen in a later round is killed by the last read that showed it when the next read fails, never continued", async () => {
  const { w, deps, shutdown } = world(everything, {
    stubborn: [107],
    unreadable: () => w.signals.some(([pid, sig]) => pid === -108 && sig === "SIGSTOP"),
    onSignal: (pid, sig, w) => { if (pid === -107 && sig === "SIGSTOP" && !w.rows.some((r) => r.pid === 108)) w.rows.push(row(108, 107, 108, "git commit")); return false; },
  });
  await teardown(actors(everything), DIR, shutdown, deps, { settleMs: 500, fallbackMs: 1000 });
  expect(w.signals.filter(([pid]) => pid === -108).map(([, sig]) => sig)).toEqual(["SIGSTOP", "SIGKILL"]);
});

test("a process that leads a group of its own after it was recorded has that group followed, by the table as it is now", () => {
  // 107 was recorded in its launcher's group 105, then led group 107; 108 joined it with no parent link to 107.
  const owned = new Map<string, Actor>([["107@" + T, { role: "below", pid: 107, started: T, pgid: 105, via: "below codex-app-server 105" }]]);
  extend(owned, [runner, row(107, 105, 107, "node tool.js"), row(108, 1, 107, "sleep 600")]);
  expect([...owned.values()].map((a) => [a.pid, a.pgid])).toEqual([[107, 107], [108, 107]]);
});

test("an unresolved process is recorded by the name of its executable, never by a title it set itself, and only while it is the same process", async () => {
  // A process that puts arguments into its own title, as Node's process.title or perl's $0 do.
  const titled = spawn("perl", ["-e", '$0 = "node /Users/Jane Doe/secret/server.js --token abc"; print "ready\\n"; $| = 1; sleep 30'], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await new Promise((resolve) => titled.stdout!.once("data", resolve));
    const row = processTable()!.find((r) => r.pid === titled.pid)!;
    if (process.platform === "darwin") expect(commOf(titled.pid!, row.started)).toBe("perl"); // the runner's platform; Linux lets perl set its name
    expect(commOf(titled.pid!, "Thu Jan  1 00:00:00 1970")).toBeUndefined(); // the pid, started another time: someone else
  } finally {
    titled.kill("SIGKILL");
  }
});

test("a record's end reason: quota and budget ends stay themselves; a flag makes any other end but an interruption an infrastructure error", () => {
  expect(["completed", "delivery-unsettled", "wall-timeout", "interrupted", "needs-review", "provider-quota", "budget-paused", "infrastructure-error", "peer-failure"].map((d) => endReasonOf(d, [])))
    .toEqual(["completed", "delivery-unsettled", "timeout", "interrupted", "interrupted", "provider-quota", "budget-paused", "infrastructure-error", "peer-failure"]);
  // #160: a terminal peer failure keeps its own class; a flag beside it still makes it an infrastructure error.
  expect(["completed", "wall-timeout", "needs-review", "interrupted", "provider-quota", "peer-failure"].map((d) => endReasonOf(d, ["tree-changed-after-active-time"])))
    .toEqual(["infrastructure-error", "infrastructure-error", "infrastructure-error", "interrupted", "provider-quota", "infrastructure-error"]);
});

test("a prepared fixture root replaced after preparation is rejected read-only (#119)", () => {
  const base = mkdtempSync(join(tmpdir(), "ahub-fixture-root-"));
  dirs.push(base);
  const fixture = join(base, "fixtures", "00-solo-codex");
  const outside = join(base, "outside");
  mkdirSync(fixture, { recursive: true });
  mkdirSync(join(outside, "sub"), { recursive: true });
  writeFileSync(join(outside, "sub", "same-baseline.txt"), "baseline");
  const outsideMode = statSync(outside).mode;
  // the unchanged prepared root is accepted
  expect(fixtureRootProblem(fixture)).toBeUndefined();
  // replaced by a symlink to an equivalent outside tree: rejected, and the target stays untouched
  rmSync(fixture, { recursive: true });
  symlinkSync(outside, fixture);
  expect(fixtureRootProblem(fixture)).toBe("a symlink, not the prepared directory");
  expect(readFileSync(join(outside, "sub", "same-baseline.txt"), "utf8")).toBe("baseline");
  expect(statSync(outside).mode).toBe(outsideMode);
  // a root that is not a directory, and a root that is gone
  rmSync(fixture);
  writeFileSync(fixture, "x");
  expect(fixtureRootProblem(fixture)).toBe("not a directory");
  rmSync(fixture);
  expect(fixtureRootProblem(fixture)).toBe("missing");
});

test("fixture setup rechecks captured identity after async work, before any mutation (#119)", async () => {
  const base = mkdtempSync(join(tmpdir(), "ahub-fixture-identity-"));
  dirs.push(base);
  for (const replacement of ["symlink", "directory"]) {
    const fixture = join(base, replacement);
    const outside = join(base, `${replacement}-outside`);
    mkdirSync(fixture);
    mkdirSync(outside);
    writeFileSync(join(fixture, "AGENTS.md"), "baseline");
    writeFileSync(join(outside, "AGENTS.md"), "baseline");
    const outsideMode = statSync(outside).mode;
    const identity = captureFixtureRoot(fixture);
    // Keep the original inode alive so replacement cannot accidentally reuse it.
    await Promise.resolve().then(() => {
      renameSync(fixture, join(base, `${replacement}-original`));
      if (replacement === "symlink") symlinkSync(outside, fixture);
      else {
        mkdirSync(fixture);
        writeFileSync(join(fixture, "AGENTS.md"), "baseline");
      }
    });
    let invoked = false;
    expect(() => withFixtureRoot(fixture, identity, () => {
      invoked = true;
      writeFileSync(join(fixture, "AGENTS.md"), "setup");
    })).toThrow("prepared fixture root was replaced after preparation");
    expect(invoked).toBe(false);
    expect(readFileSync(join(fixture, "AGENTS.md"), "utf8")).toBe("baseline");
    expect(readFileSync(join(outside, "AGENTS.md"), "utf8")).toBe("baseline");
    expect(statSync(outside).mode).toBe(outsideMode);
  }
});

test("unchanged captured fixture permits the synchronous setup mutation (#119)", () => {
  const fixture = mkdtempSync(join(tmpdir(), "ahub-fixture-unchanged-"));
  dirs.push(fixture);
  const identity = captureFixtureRoot(fixture);
  withFixtureRoot(fixture, identity, () => writeFileSync(join(fixture, "AGENTS.md"), "setup"));
  expect(readFileSync(join(fixture, "AGENTS.md"), "utf8")).toBe("setup");
});

// #134: Claude quota readings from the status-line tee's file.
const usageState = (content: string) => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-claude-usage-"));
  dirs.push(dir);
  writeFileSync(join(dir, "claude-usage.json"), content);
  return dir;
};
const isKnown = (r: ReturnType<typeof claudeUsageReading>): r is Extract<typeof r, { rate_limits: any }> => "rate_limits" in r;
const isUnknown = (r: ReturnType<typeof claudeUsageReading>): r is Extract<typeof r, { status: "unknown" }> => "status" in r && r.status === "unknown";
const FUTURE_S = Math.floor(Date.now() / 1000) + 3600; // 1 h from now, epoch seconds
const FUTURE_MS = Date.now() + 3_600_000; // 1 h from now, epoch millis
const PAST_S = Math.floor(Date.now() / 1000) - 60; // 60 s ago, epoch seconds

test("claudeUsageReading: valid windows (epoch seconds) return at and rate_limits (#134)", () => {
  const dir = usageState(JSON.stringify({ at: 12345, rate_limits: { five_hour: { used_percentage: 10, resets_at: FUTURE_S }, seven_day: { used_percentage: 20, resets_at: FUTURE_S } } }));
  const r = claudeUsageReading(dir);
  expect(isKnown(r)).toBe(true);
  if (!isKnown(r)) throw new Error("expected a known quota reading");
  expect(r.at).toBe(12345);
  expect(r.rate_limits.five_hour?.used_percentage).toBe(10);
  expect(r.rate_limits.seven_day?.used_percentage).toBe(20);
  expect(r.stale).toBeUndefined();
});

test("claudeUsageReading: valid windows (epoch millis) return at and rate_limits (#134)", () => {
  const dir = usageState(JSON.stringify({ at: 12345, rate_limits: { five_hour: { used_percentage: 10, resets_at: FUTURE_MS } } }));
  const r = claudeUsageReading(dir);
  expect(isKnown(r)).toBe(true);
  if (!isKnown(r)) throw new Error("expected a known quota reading");
  expect(r.rate_limits.five_hour?.used_percentage).toBe(10);
  expect(r.stale).toBeUndefined();
});

test("claudeUsageReading: missing file returns explicit unknown (#134)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-claude-usage-"));
  dirs.push(dir);
  const r = claudeUsageReading(dir);
  expect(isUnknown(r)).toBe(true);
  if (!isUnknown(r)) throw new Error("expected an unknown quota reading");
  expect(r.why).toBe("missing");
});

test("claudeUsageReading: malformed file returns explicit unknown (#134)", () => {
  const dir = usageState("not json");
  const r = claudeUsageReading(dir);
  expect(isUnknown(r)).toBe(true);
  if (!isUnknown(r)) throw new Error("expected an unknown quota reading");
  expect(r.why).toContain("unreadable");
});

test("claudeUsageReading: no rate_limits returns unknown with at preserved (#134)", () => {
  const dir = usageState(JSON.stringify({ at: 999 }));
  const r = claudeUsageReading(dir);
  expect(isUnknown(r)).toBe(true);
  if (!isUnknown(r)) throw new Error("expected an unknown quota reading");
  expect(r.why).toBe("no rate_limits");
  expect(r.at).toBe(999);
});

test("claudeUsageReading: all windows expired returns unknown with at and stale (#134)", () => {
  const dir = usageState(JSON.stringify({ at: 111, rate_limits: { five_hour: { used_percentage: 50, resets_at: PAST_S }, seven_day: { used_percentage: 60, resets_at: PAST_S } } }));
  const r = claudeUsageReading(dir);
  expect(isUnknown(r)).toBe(true);
  if (!isUnknown(r)) throw new Error("expected an unknown quota reading");
  expect(r.why).toBe("all windows expired");
  expect(r.at).toBe(111);
  expect(r.stale).toBe(true);
});

test("claudeUsageReading: single window expired returns unknown (#134)", () => {
  const dir = usageState(JSON.stringify({ at: 222, rate_limits: { five_hour: { used_percentage: 50, resets_at: PAST_S } } }));
  const r = claudeUsageReading(dir);
  expect(isUnknown(r)).toBe(true);
  if (!isUnknown(r)) throw new Error("expected an unknown quota reading");
  expect(r.why).toBe("all windows expired");
  expect(r.at).toBe(222);
  expect(r.stale).toBe(true);
});

test("claudeUsageReading: mixed live and stale windows returns known with stale marker (#134)", () => {
  const dir = usageState(JSON.stringify({ at: 333, rate_limits: { five_hour: { used_percentage: 10, resets_at: FUTURE_S }, seven_day: { used_percentage: 20, resets_at: PAST_S } } }));
  const r = claudeUsageReading(dir);
  expect(isKnown(r)).toBe(true);
  if (!isKnown(r)) throw new Error("expected a known quota reading");
  expect(r.at).toBe(333);
  expect(r.stale).toBe(true);
  expect(r.rate_limits.five_hour?.stale).toBeUndefined();
  expect(r.rate_limits.seven_day?.stale).toBe(true);
});

test("claudeUsageReading: absent resets_at marks window stale, never trusted fresh (#134)", () => {
  const dir = usageState(JSON.stringify({ at: 444, rate_limits: { five_hour: { used_percentage: 10 } } }));
  const r = claudeUsageReading(dir);
  // single window with no valid reset -> all present windows stale -> unknown
  expect(isUnknown(r)).toBe(true);
  if (!isUnknown(r)) throw new Error("expected an unknown quota reading");
  expect(r.stale).toBe(true);
});

test("claudeUsageReading: non-numeric used_percentage gives no usable windows (#134)", () => {
  const dir = usageState(JSON.stringify({ at: 555, rate_limits: { five_hour: { used_percentage: "ten", resets_at: FUTURE_S } } }));
  const r = claudeUsageReading(dir);
  expect(isUnknown(r)).toBe(true);
  if (!isUnknown(r)) throw new Error("expected an unknown quota reading");
  expect(r.why).toBe("no usable windows");
});

test("claudeUsageReading: malformed reset objects fail open (#134)", () => {
  const dir = usageState(JSON.stringify({ at: 666, rate_limits: { five_hour: { used_percentage: 10, resets_at: { valueOf: null, toString: null } } } }));
  const r = claudeUsageReading(dir);
  expect(isUnknown(r)).toBe(true);
  if (!isUnknown(r)) throw new Error("expected an unknown quota reading");
  expect(r.at).toBe(666);
  expect(r.stale).toBe(true);
});

test("claudeUsageReading: refuses symlinks and oversized quota files (#134)", () => {
  const dir = usageState("{}");
  const file = join(dir, "claude-usage.json"), target = join(dir, "target.json");
  writeFileSync(target, "outside sentinel");
  rmSync(file);
  symlinkSync(target, file);
  const linked = claudeUsageReading(dir);
  expect(isUnknown(linked)).toBe(true);
  expect(readFileSync(target, "utf8")).toBe("outside sentinel");
  rmSync(file);
  writeFileSync(file, "x".repeat(256 * 1024 + 1));
  const oversized = claudeUsageReading(dir);
  expect(isUnknown(oversized)).toBe(true);
  if (!isUnknown(oversized)) throw new Error("expected an unknown quota reading");
  expect(oversized.why).toStartWith("large:");
});

test("claudeUsageReading: FIFO cannot block the subsequent cleanup (#134)", async () => {
  const dir = usageState("{}");
  const file = join(dir, "claude-usage.json");
  rmSync(file);
  const fifo = Bun.spawn(["mkfifo", file], { stdout: "ignore", stderr: "pipe" });
  expect(await fifo.exited).toBe(0);
  const helper = join(import.meta.dir, "../../scripts/benchmarks/teardown.ts");
  const program = `import { claudeUsageReading } from ${JSON.stringify(helper)}; const r = claudeUsageReading(process.argv[1]); console.log(JSON.stringify({ reading: r, cleanupReached: true }));`;
  const reader = Bun.spawn([process.execPath, "-e", program, dir], { stdout: "pipe", stderr: "pipe" });
  const deadline = setTimeout(() => reader.kill("SIGKILL"), 2000);
  try {
    expect(await reader.exited).toBe(0);
    const result = JSON.parse(await new Response(reader.stdout).text());
    expect(result.reading.status).toBe("unknown");
    expect(result.reading.why).toStartWith("not a regular file:");
    expect(result.cleanupReached).toBe(true);
  } finally {
    clearTimeout(deadline);
  }
}, 5000);

test("benchmark settings produce real pre/post files and keep facts hooks treatment-specific (#134)", async () => {
  for (const turnFree of [false, true]) {
    const state = usageState("{}");
    const quotaState = join(state, "benchmark-usage");
    const tee = { stateDir: quotaState, script: join(import.meta.dir, "../../src/cli/statusline-tee.ts") };
    const session = JSON.parse(sessionSettings(tee, { stateDir: state, script: join(import.meta.dir, "../../src/cli/facts-hook.ts") }));
    const settings = benchmarkClaudeSettings(session, turnFree, { allow: ["Read"] }, { enabled: true });
    expect(settings.disableAllHooks).toBe(false);
    expect(settings.hooks).toEqual(turnFree ? session.hooks : {});
    const line = settings.statusLine as { type: string; command: string };
    expect(line.type).toBe("command");
    const invoke = async (used: number) => {
      const producer = Bun.spawn(["/bin/sh", "-c", line.command], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      producer.stdin.write(JSON.stringify({ session_id: "sample-quota-session", rate_limits: { five_hour: { used_percentage: used, resets_at: FUTURE_S } } }));
      producer.stdin.end();
      expect(await producer.exited).toBe(0);
      await new Response(producer.stdout).text();
    };
    await invoke(12);
    const pre = claudeUsageReading(quotaState);
    if (!isKnown(pre)) throw new Error("producer did not create a usable pre reading");
    expect(pre.rate_limits.five_hour.used_percentage).toBe(12);
    expect(pre.at).toBe(JSON.parse(readFileSync(join(quotaState, "claude-usage.json"), "utf8")).at);
    await invoke(20);
    const post = claudeUsageReading(quotaState);
    if (!isKnown(post)) throw new Error("producer did not create a usable post reading");
    expect(post.rate_limits.five_hour.used_percentage).toBe(20);
    expect(post.at).toBeGreaterThanOrEqual(pre.at);
    expect(post.at).toBe(JSON.parse(readFileSync(join(quotaState, "claude-usage.json"), "utf8")).at);
    expect(readFileSync(join(state, "claude-usage.json"), "utf8")).toBe("{}");
    expect(existsSync(join(state, "claude-session.json"))).toBe(false);
    expect(existsSync(join(quotaState, "claude-session.json"))).toBe(true);
  }
}, 5000);

test("quota snapshot waits for a delayed write after the boundary (#134)", async () => {
  const boundary = Date.now();
  const state = usageState(JSON.stringify({ at: boundary - 1000, rate_limits: { five_hour: { used_percentage: 10, resets_at: FUTURE_S } } }));
  const producer = setTimeout(() => writeFileSync(join(state, "claude-usage.json"), JSON.stringify({ at: Date.now(), rate_limits: { five_hour: { used_percentage: 20, resets_at: FUTURE_S } } })), 60);
  try {
    const reading = await claudeUsageSnapshot(state, boundary, 300);
    if (!isKnown(reading)) throw new Error("missing delayed quota write");
    expect(reading.at).toBeGreaterThanOrEqual(boundary);
    expect(reading.rate_limits.five_hour.used_percentage).toBe(20);
  } finally { clearTimeout(producer); }
});

test("quota snapshot never counts cached data for a timeout or unsettled final turn (#134)", async () => {
  const at = Date.now();
  const state = usageState(JSON.stringify({ at, rate_limits: { five_hour: { used_percentage: 10, resets_at: FUTURE_S } } }));
  const unsettled = await claudeUsageSnapshot(state, undefined);
  expect(isUnknown(unsettled)).toBe(true);
  expect("rate_limits" in unsettled).toBe(false);
  const expiredWait = await claudeUsageSnapshot(state, at + 1, 30);
  if (!isUnknown(expiredWait)) throw new Error("cached quota was trusted as fresh");
  expect(expiredWait.at).toBe(at);
  expect(expiredWait.why).toContain("no fresh quota write");
  const interrupted = await claudeUsageSnapshot(state, at, 30, () => true);
  if (!isUnknown(interrupted)) throw new Error("interrupted quota wait was trusted");
  expect(interrupted.why).toContain("interrupted");
});
