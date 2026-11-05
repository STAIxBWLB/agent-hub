import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { Board } from "../src/hub/board.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { hubGitSync } from "../src/hub/git.ts";
import type { SdlcGh } from "../src/hub/sdlc.ts";
import { PrObservations, REFRESH_MAX_PRS, readPrChangeTime, refreshPrStates, refreshTargets } from "../src/hub/worktree-prs.ts";
import { partition, prFromTask, type WorktreeFact } from "../src/hub/worktree-shelf.ts";
import { createProvider } from "../src/ui/plugin.ts";
import { runInNewContext } from "node:vm";
import { gitProject } from "./fakes/git-project.ts";
import type { Lifecycle, ProjectRecord } from "../src/hub/manager.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";

// #1057 PR 3: the panel's refresh action, the cached snapshot view, the plugin's actions and alert, and the settings rows.
const DAY = 86_400_000;
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const SHA = "a".repeat(40);
const prJson = (state: "OPEN" | "MERGED" | "CLOSED", extra: Record<string, unknown> = {}) => JSON.stringify({ headRefOid: SHA, state, statusCheckRollup: [], files: [], changedFiles: 0, reviewDecision: "", reviewRequests: [], ...extra });
/** A fake `gh` for PRs: the full readback (`readSdlcPr`) and the narrow `mergedAt,closedAt` read, answered from one description. `table` maps a PR number to its state and time. */
const fakePrs = (table: Record<string, { state: "OPEN" | "MERGED" | "CLOSED"; at?: string }>): SdlcGh => async (args) => {
  if (args[0] === "api") return { code: 1, stdout: "" };                       // the thread query: unknown, never required here
  const entry = table[args[2] ?? ""];
  if (!entry) return { code: 1, stdout: "" };
  if (args[args.indexOf("--json") + 1] === "mergedAt,closedAt") return { code: 0, stdout: JSON.stringify(entry.state === "MERGED" ? { mergedAt: entry.at ?? null, closedAt: null } : entry.state === "CLOSED" ? { mergedAt: null, closedAt: entry.at ?? null } : { mergedAt: null, closedAt: null }) };
  return { code: 0, stdout: prJson(entry.state) };
};
const fact = (over: Partial<WorktreeFact> = {}): WorktreeFact => ({ path: "/p/.worktrees/a", branch: "task/1", head: SHA, locked: false, prunable: false, main: false, instance: false, lastActiveAt: 1000, activityKnown: true, task: { id: 1, state: "approved", pr: 7, repo: "o/r" }, pr: { state: "unknown" }, ...over });

// The change-time read: a second, narrow read that only a refresh makes, so the shared readback is untouched.
test("readPrChangeTime reads only mergedAt/closedAt, takes the merge time for a merged PR and the close time for a closed one, and is undefined for anything malformed", async () => {
  const calls: string[][] = [];
  const reply = (body: unknown, code = 0): SdlcGh => async args => { calls.push(args); return { code, stdout: typeof body === "string" ? body : JSON.stringify(body) }; };
  expect(await readPrChangeTime("o/r", 7, "merged", reply({ mergedAt: "2026-10-01T00:00:00Z", closedAt: "2026-10-01T00:00:01Z" }))).toBe(Date.parse("2026-10-01T00:00:00Z"));
  expect(await readPrChangeTime("o/r", 7, "closed", reply({ mergedAt: null, closedAt: "2026-10-02T00:00:00Z" }))).toBe(Date.parse("2026-10-02T00:00:00Z"));
  expect(calls[0]).toEqual(["pr", "view", "7", "--repo", "o/r", "--json", "mergedAt,closedAt"]);
  for (const bad of [{}, { mergedAt: null }, { mergedAt: "not a date" }, { mergedAt: 5 }, { mergedAt: "x".repeat(100) }, "not json", null]) expect(await readPrChangeTime("o/r", 7, "merged", reply(bad as never)), JSON.stringify(bad)).toBeUndefined();
  expect(await readPrChangeTime("o/r", 7, "merged", reply({ mergedAt: "2026-10-01T00:00:00Z" }, 1))).toBeUndefined();
  const before = calls.length;
  for (const [repo, pr] of [["-x/y", 1], ["a b/c", 1], ["o/r", 0], ["o/r", 1.5], ["../etc", 1]] as const) expect(await readPrChangeTime(repo, pr, "merged", reply({ mergedAt: "2026-10-01T00:00:00Z" })), `${repo}#${pr}`).toBeUndefined();
  expect(calls.length).toBe(before);                                              // a hostile repository or number never reaches gh
});

test("the shared readback is untouched: readSdlcPr's argv names neither mergedAt nor closedAt, so the guarded merge's cost-query count is unaffected", () => {
  const src = readFileSync(join(import.meta.dir, "../src/hub/sdlc.ts"), "utf8");
  const start = src.indexOf("export async function readSdlcPr("), end = src.indexOf("export async function readSdlcPrHead(");
  expect(src.slice(start, end)).not.toMatch(/mergedAt|closedAt/);
});

// The pure refresh logic.
test("refreshTargets asks only about bound tasks with a repository and PR that are not already merged, oldest activity first, once per PR, capped", () => {
  const rows = [
    fact({ path: "/p/.worktrees/new", lastActiveAt: 9000, task: { id: 3, state: "approved", pr: 9, repo: "o/r" } }),
    fact({ path: "/p/.worktrees/old", lastActiveAt: 100, task: { id: 2, state: "approved", pr: 8, repo: "o/r" } }),
    fact({ path: "/p/.worktrees/dup", lastActiveAt: 200, task: { id: 4, state: "approved", pr: 8, repo: "o/r" } }),
    fact({ path: "/p/.worktrees/merged", pr: { state: "merged", changedAt: 5 }, task: { id: 5, state: "approved", pr: 10, repo: "o/r" } }),
    fact({ path: "/p/.worktrees/nopr", task: { id: 6, state: "in_progress" } }),
    fact({ path: "/p/.worktrees/norepo", task: { id: 7, state: "in_progress", pr: 11 } }),
    fact({ path: "/p", main: true }), fact({ path: "/p/.worktrees/inst", instance: true }),
    fact({ path: "/p/.worktrees/free", task: undefined }),
  ];
  expect(refreshTargets(rows)).toEqual([{ repo: "o/r", pr: 8 }, { repo: "o/r", pr: 9 }]);
  const many = Array.from({ length: 20 }, (_, i) => fact({ path: `/p/.worktrees/w${i}`, lastActiveAt: i, task: { id: i + 1, state: "approved", pr: 100 + i, repo: "o/r" } }));
  expect(refreshTargets(many)).toHaveLength(REFRESH_MAX_PRS);
});

test("refreshPrStates reads each PR through readSdlcPr's fixed read-only argv, stores the result and counts a failure without keeping a guess", async () => {
  const calls: string[][] = [];
  const inner = fakePrs({ "8": { state: "MERGED", at: "2026-10-01T00:00:00Z" }, "9": { state: "OPEN" }, "10": { state: "CLOSED", at: "2026-10-03T00:00:00Z" } });   // 11: gh failed
  const gh: SdlcGh = async (args, ...rest) => { calls.push(args); return inner(args, ...rest); };
  const store = new PrObservations();
  const result = await refreshPrStates([{ repo: "o/r", pr: 8 }, { repo: "o/r", pr: 9 }, { repo: "o/r", pr: 10 }, { repo: "o/r", pr: 11 }], gh, store);
  expect(result).toEqual({ read: 3, failed: 1, skipped: 0 });
  expect(store.observer("o/r", 8)).toEqual({ state: "merged", changedAt: Date.parse("2026-10-01T00:00:00Z") });
  expect(store.observer("o/r", 9)).toEqual({ state: "open" });
  expect(store.observer("o/r", 10)).toEqual({ state: "closed", changedAt: Date.parse("2026-10-03T00:00:00Z") });
  expect(store.observer("o/r", 11)).toBeUndefined();                             // a failed read keeps no guess
  // the narrow time read is made only for a PR found merged or closed, never for an open one
  expect(calls.filter(args => args.includes("mergedAt,closedAt")).map(args => args[2]).sort()).toEqual(["10", "8"]);
  // every argv is a read: `pr view` or `api graphql`, never a write
  for (const args of calls) { expect(["pr", "api"]).toContain(args[0] ?? ""); if (args[0] === "pr") expect(args.slice(0, 2)).toEqual(["pr", "view"]); expect(args.filter(word => !word.startsWith("--json") && !/^[A-Za-z]+(,[A-Za-z]+)+$/.test(word) && !word.startsWith("query=")).join(" ")).not.toMatch(/\b(merge|close|edit|comment|review|delete)\b|--method|-X/); }
});

test("a merged PR whose change time cannot be read is stored as merged with no time, so it stays unknown to the partition and never settles a worktree", async () => {
  const gh: SdlcGh = async (args) => args.includes("mergedAt,closedAt") ? { code: 1, stdout: "" } : fakePrs({ "7": { state: "MERGED" } })(args);
  const store = new PrObservations();
  expect(await refreshPrStates([{ repo: "o/r", pr: 7 }], gh, store)).toEqual({ read: 1, failed: 0, skipped: 0 });
  expect(store.observer("o/r", 7)).toEqual({ state: "merged" });
  const pr = prFromTask({ state: "approved", history: [], sdlc: { stage: "build", repo: "o/r", pr: 7 } }, store.observer);
  expect(partition([fact({ lastActiveAt: 1, pr })], [], 100 * DAY, 0).settled).toEqual([]);   // rule 3 needs a change time
});

test("refreshPrStates stops at its total budget, counts the rest as skipped, and bounds each call by what is left", async () => {
  let clock = 0; const timeouts: number[] = [];
  const gh: SdlcGh = async (args, timeoutMs) => { if (args[0] === "pr") timeouts.push(timeoutMs ?? -1); clock += 400; return { code: 0, stdout: prJson("OPEN") }; };
  const targets = Array.from({ length: 6 }, (_, i) => ({ repo: "o/r", pr: i + 1 }));
  const result = await refreshPrStates(targets, gh, new PrObservations(), { now: () => clock, totalMs: 1000, callMs: 500 });
  expect(result.read + result.failed + result.skipped).toBe(6);
  expect(result.skipped).toBeGreaterThan(0);
  expect(Math.max(...timeouts)).toBeLessThanOrEqual(500);
  expect(clock).toBeLessThanOrEqual(1000 + 400 * 2);                              // never runs far past the budget
});

test("a stored observation settles a worktree through the existing rules: merged with no newer work settles, merged with newer work stays live, open never settles", () => {
  const at = 5 * DAY;
  const withPr = (state: "open" | "merged" | "closed", changedAt?: number) => prFromTask({ state: "approved", history: [], sdlc: { stage: "build", repo: "o/r", pr: 7 } }, () => ({ state, ...(changedAt !== undefined ? { changedAt } : {}) }));
  expect(withPr("merged", at)).toEqual({ state: "merged", changedAt: at });
  expect(partition([fact({ lastActiveAt: at - 1, pr: withPr("merged", at) })], [], 100 * DAY, 0).settled).toMatchObject([{ reason: "merged" }]);
  expect(partition([fact({ lastActiveAt: at + 1, pr: withPr("merged", at) })], [], 100 * DAY, 0).settled).toEqual([]);
  expect(partition([fact({ lastActiveAt: 1, pr: withPr("open") })], [], 100 * DAY, 0).settled).toEqual([]);
  // with no observer, or none for this PR, it stays unknown
  expect(prFromTask({ state: "approved", history: [], sdlc: { stage: "build", repo: "o/r", pr: 7 } })).toEqual({ state: "unknown" });
  expect(prFromTask({ state: "approved", history: [], sdlc: { stage: "build", repo: "o/r", pr: 7 } }, () => undefined)).toEqual({ state: "unknown" });
});

// A real repository, as in worktree-shelf.test.ts.
const git = (cwd: string, ...args: string[]) => {
  const run = hubGitSync(["-C", cwd, "-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", timeout: 20_000 });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return String(run.stdout).trim();
};
const commitAt = (cwd: string, unix: number, message: string) => {
  writeFileSync(join(cwd, `${message}.txt`), message); git(cwd, "add", ".");
  const run = hubGitSync(["-C", cwd, "-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { encoding: "utf8", timeout: 20_000, env: { ...process.env, GIT_AUTHOR_DATE: `${unix} +0000`, GIT_COMMITTER_DATE: `${unix} +0000` } });
  if (run.status !== 0) throw new Error(run.stderr);
};

async function rig(opts: { gh?: SdlcGh; seed?: (board: Board) => void; config?: Record<string, unknown> } = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-shelf3-"))), stateDir = join(cwd, ".agenthub-state");
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  gitProject(cwd);
  const now = Math.floor(Date.now() / 1000);
  for (const [name, age] of [["merged", 30 * 86400], ["quiet", 20 * 86400], ["active", 60]] as const) {
    git(cwd, "branch", `task/${name}`); git(cwd, "worktree", "add", "-q", join(cwd, ".worktrees", name), `task/${name}`);
    commitAt(join(cwd, ".worktrees", name), now - age, `${name}-work`);
  }
  for (const name of ["merged", "quiet"]) { const index = join(cwd, ".git", "worktrees", name, "index"); if (existsSync(index)) utimesSync(index, now - 30 * 86400, now - 30 * 86400); }
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(cwd, ".agenthub"), { recursive: true }); writeFileSync(join(cwd, ".agenthub", "config.json"), "{}");   // a settings write needs the project's config file
  if (opts.seed) { const board = new Board(join(stateDir, "hub.db")); opts.seed(board); board.close(); }
  const ghCalls: string[][] = [];
  const gh: SdlcGh = async (args, timeout, cwd2, bound) => { ghCalls.push(args); return opts.gh ? opts.gh(args, timeout, cwd2, bound) : { code: 1, stdout: "" }; };
  const daemon = await startDaemon({ cwd, stateDir, projectId: "shelf3", instanceId: crypto.randomUUID(), controlPort: 0, codexAppPort: 0, codexProxyPort: 0, worktreeShelfGh: gh,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, ...(opts.config ?? {}) } });
  cleanup.push(() => daemon.stop());
  const person = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => person.close());
  const tools = await ControlClient.connect(stateDir, { role: "tools", peer: "claude" }); cleanup.push(() => tools.close());
  const instanceId = (JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8")) as { instanceId: string }).instanceId;
  return { cwd, stateDir, daemon, person, tools, ghCalls, instanceId, overrides: () => { const b = new Board(join(stateDir, "hub.db")); try { return b.worktreeOverrides(); } finally { b.close(); } } };
}
const names = (rows: { path: string }[]) => rows.map(r => r.path).sort();
// A merged-by-GitHub PR for the open task on task/quiet, which the board does not know is merged.
// Its own work is 25 days old (backdated the way an old task is), so a PR merged 19 days ago is newer than the work and settles it.
const seedOpenPr = (board: Board) => {
  const task = board.propose("claude", { title: "quiet work", class: "implement", refs: { branch: "task/quiet" } });
  board.update(task.id, "hub", "pr", { sdlc: { stage: "build", repo: "o/r", pr: 7 } } as never);
  const old = Date.now() - 25 * DAY;
  (board as any).db.query("UPDATE tasks SET created = ?, updated = ?, history = ? WHERE id = ?").run(old, old, JSON.stringify([{ at: old, by: "claude", event: "proposed" }, { at: old + 1, by: "hub", event: "pr" }]), task.id);
};
const ghMerged: SdlcGh = fakePrs({ "7": { state: "MERGED", at: new Date(Date.now() - 19 * DAY).toISOString() } });

// AC5.
test("AC5: reading the shelf (a worktrees read, a dashboard snapshot, an agent's preview) makes no GitHub call, and the explicit refresh makes only read-only ones", async () => {
  const f = await rig({ seed: seedOpenPr, gh: ghMerged });
  await f.person.request({ t: "worktrees" });
  await f.tools.request({ t: "worktrees" });
  for (let i = 0; i < 3; i++) await f.person.request({ t: "ui_snapshot", after: 0, view: "agents" });
  await Bun.sleep(300);                                                           // the cached view warms in the background
  await f.person.request({ t: "ui_snapshot", after: 0, view: "agents" });
  expect(f.ghCalls).toEqual([]);                                                  // none, over every read surface
  const out = await f.person.request({ t: "worktrees_refresh_prs" });
  expect(out.ok).toBe(true);
  expect(out.refreshed).toEqual({ read: 1, failed: 0, skipped: 0 });
  expect(f.ghCalls.length).toBeGreaterThan(0);
  for (const args of f.ghCalls) { expect(["pr", "api"]).toContain(args[0] ?? ""); if (args[0] === "pr") expect(args.slice(0, 2)).toEqual(["pr", "view"]); expect(args.filter(word => !word.startsWith("query=") && !/^[A-Za-z]+(,[A-Za-z]+)+$/.test(word)).join(" ")).not.toMatch(/\b(merge|close|edit|comment|delete)\b|--method|-X/); }
  // after the refresh the merged PR is known: the quiet worktree's own commit is older than the merge, so it settles as merged, not as quiet
  expect(Object.fromEntries(out.settled.map((r: { path: string; reason: string }) => [r.path, r.reason]))).toEqual({ ".worktrees/merged": "quiet", ".worktrees/quiet": "merged" });
  const before = f.ghCalls.length;
  await f.person.request({ t: "worktrees" });
  await f.person.request({ t: "ui_snapshot", after: 0, view: "agents" });
  expect(f.ghCalls.length).toBe(before);                                          // reading again after a refresh still calls nothing, and keeps the stored states
});

test("a merged PR with work newer than its merge stays live after the refresh", async () => {
  const f = await rig({ seed: seedOpenPr, gh: fakePrs({ "7": { state: "MERGED", at: new Date(Date.now() - 40 * DAY).toISOString() } }) });
  const out = await f.person.request({ t: "worktrees_refresh_prs" });
  expect(out.ok).toBe(true);
  // merged 40 days ago, the quiet worktree's last commit is 20 days ago: newer work, so the merge does not settle it (the quiet rule does, at 7 days)
  expect(Object.fromEntries(out.settled.map((r: { path: string; reason: string }) => [r.path, r.reason]))[".worktrees/quiet"]).toBe("quiet");
  const strict = await rig({ seed: seedOpenPr, config: { worktrees: { quiet_days: 0, alert_over: 10 } }, gh: fakePrs({ "7": { state: "MERGED", at: new Date(Date.now() - 40 * DAY).toISOString() } }) });
  const out2 = await strict.person.request({ t: "worktrees_refresh_prs" });
  expect(names(out2.live)).toContain(".worktrees/quiet");                         // with quiet_days 0 only the merge could settle it, and the newer work stops that
});

test("a failed gh read keeps the row's old state, reports the failure, and a second refresh while one runs is refused", async () => {
  let release: () => void = () => {}; const held = new Promise<void>(resolve => { release = resolve; });
  const f = await rig({ seed: seedOpenPr, gh: async (args) => { await held; return args[0] === "api" ? { code: 1, stdout: "" } : { code: 1, stdout: "" }; } });
  const first = f.person.request({ t: "worktrees_refresh_prs" }, 20_000);
  await Bun.sleep(100);
  const second = await f.person.request({ t: "worktrees_refresh_prs" });
  expect(second.ok).toBe(false); expect(String(second.error)).toContain("already running");
  release();
  const out = await first;
  expect(out.ok).toBe(true); expect(out.refreshed).toEqual({ read: 0, failed: 1, skipped: 0 });
  expect(out.prsReadAt).toBeUndefined();                                          // nothing was read, so no read time is claimed
  expect(Object.fromEntries(out.settled.map((r: { path: string; reason: string }) => [r.path, r.reason]))[".worktrees/quiet"]).toBe("quiet");
});

// Authority.
test("only the person's console can refresh PR states or change an override: an agent's tools connection is refused and nothing is written or called", async () => {
  const f = await rig({ seed: seedOpenPr, gh: ghMerged });
  for (const request of [{ t: "worktrees_refresh_prs" }, { t: "worktree_override_set", path: ".worktrees/active", value: "settled" }, { t: "worktree_override_clear", path: ".worktrees/active" }]) {
    const out = await f.tools.request(request as never);
    expect(out.ok, request.t).toBe(false);
  }
  expect(f.overrides()).toEqual([]); expect(f.ghCalls).toEqual([]);
});

test("a dashboard action moves a worktree by the project-relative name the panel shows, and an ambiguous or unknown name refuses", async () => {
  const f = await rig();
  const ui = (action: Record<string, unknown>) => f.person.request({ t: "ui_action", action, instanceId: f.instanceId } as never);
  const parked = await ui({ action: "worktree_override_set", path: ".worktrees/active", value: "settled" });
  expect(parked.ok).toBe(true);
  expect(f.overrides()).toHaveLength(1);
  const shelf = await f.person.request({ t: "worktrees" });
  expect(Object.fromEntries(shelf.settled.map((r: { path: string; reason: string }) => [r.path, r.reason]))[".worktrees/active"]).toBe("parked");
  expect((await ui({ action: "worktree_override_clear", path: ".worktrees/active" })).ok).toBe(true);
  expect(f.overrides()).toEqual([]);
  expect((await ui({ action: "worktree_override_set", path: "../../etc", value: "settled" })).ok).toBe(false);
  expect((await ui({ action: "worktree_override_set", path: ".worktrees/active", value: "banana" })).ok).toBe(false);
  expect((await ui({ action: "worktree_override_set", path: ".", value: "settled" })).ok).toBe(false);   // the main checkout is never shelved
});

// The snapshot view.
test("the agents snapshot carries a cached worktrees view that never waits for git, and no other view carries it", async () => {
  const f = await rig();
  const first = await f.person.request({ t: "ui_snapshot", after: 0, view: "agents" });
  expect(first.worktrees).toBeDefined();                                          // pending or ready, never absent for the agents view
  await Bun.sleep(400);
  const second = await f.person.request({ t: "ui_snapshot", after: 0, view: "agents" });
  expect(Object.keys(second.worktrees)).toEqual(expect.arrayContaining(["live", "settled", "complete", "quietDays", "alertOver"]));
  expect(JSON.stringify(second.worktrees)).not.toContain(f.cwd);
  expect((await f.person.request({ t: "ui_snapshot", after: 0, view: "board" })).worktrees).toBeUndefined();
});

// Settings.
test("worktrees.quiet_days and worktrees.alert_over are editable settings, applied live: changing quiet_days re-derives the shelf with no restart", async () => {
  const f = await rig();
  const before = await f.person.request({ t: "worktrees" });
  expect(names(before.settled)).toEqual([".worktrees/merged", ".worktrees/quiet"]);
  const set = await f.person.request({ t: "settings_set", key: "worktrees.quiet_days", value: 0 } as never);
  expect(set.ok).toBe(true);
  const after = await f.person.request({ t: "worktrees" });
  expect(after.quietDays).toBe(0);
  expect(after.settled).toEqual([]);                                              // 0 = never settle by quiet time (no merged PR is recorded here)
  expect((await f.person.request({ t: "settings_set", key: "worktrees.alert_over", value: 3 } as never)).ok).toBe(true);
  expect((await f.person.request({ t: "worktrees" })).alertOver).toBe(3);
  for (const bad of [-1, 3651, 1.5, "7"]) expect((await f.person.request({ t: "settings_set", key: "worktrees.quiet_days", value: bad } as never)).ok, String(bad)).toBe(false);
});

// The plugin: actions and the inbox alert.
function pluginFixture(shelf: Record<string, unknown> | undefined) {
  const home = mkdtempSync(join(tmpdir(), "ahub-acon-wt-")); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const project: ProjectRecord = { id: "p1", root: "/tmp/acon-wt", stateDir: join(home, "state"), basePort: 4700, instanceId: "i1", pid: 42 };
  const registry = { get: (id: string) => id === project.id ? project : undefined, list: () => [project], close() {} } as any;
  const lifecycle: Lifecycle = { inspectProject: async () => ({ state: "running", status: { instanceId: "i1", peers: {} } }), startProject: async () => ({}), stopProject: async () => {} };
  const actions: Record<string, unknown>[] = [];
  const hub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response("no", { status: 400 }); }, websocket: { message(ws, data) {
    const m = JSON.parse(String(data));
    if (m.t === "hello") return void ws.send(JSON.stringify({ rid: m.rid, t: "welcome", cwd: project.root, projectId: project.id, instanceId: "i1" }));
    if (m.t === "ui_snapshot") return void ws.send(JSON.stringify({ rid: m.rid, ok: true, cursor: 1, peers: {}, permissions: [], tasks: [], events: [], ...(shelf ? { worktrees: shelf } : {}) }));
    if (m.t === "ui_action") { actions.push(m.action); return void ws.send(JSON.stringify({ rid: m.rid, ok: true })); }
  } } });
  cleanup.push(() => hub.stop(true));
  mkdirSync(project.stateDir, { recursive: true });
  writeFileSync(join(project.stateDir, "status.json"), JSON.stringify({ pid: process.pid, controlPort: hub.port, protocol: PROTOCOL, cwd: project.root, projectId: project.id, instanceId: "i1" }));
  writeFileSync(join(project.stateDir, "control-token"), "scripted-token");
  return { provider: createProvider({ home, registry, lifecycle }), actions };
}
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `.worktrees/secret-branch-${i}`, branch: `private/branch-${i}`, reason: "quiet", task: 900 + i, lastActiveAt: 1 }));

test("the inbox raises one worktrees alert only above alert_over, with counts and no path, branch or task, and alert_over 0 never raises it", async () => {
  const at = async (shelf: Record<string, unknown> | undefined) => (await pluginFixture(shelf).provider.snapshot({ after: 0, panel: "inbox" })).items as any[];
  expect((await at({ live: [], settled: rows(10), alertOver: 10 })).filter(i => i.kind === "worktrees")).toEqual([]);   // at the threshold: no alert
  const items = (await at({ live: [], settled: rows(11), alertOver: 10 })).filter(i => i.kind === "worktrees");
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ group: "alert", id: "worktrees:p1", title: "11 settled worktrees", verbs: [{ id: "open" }], link: { panel: "agents", params: { project: "p1" } } });
  expect(JSON.stringify(items[0])).not.toMatch(/secret-branch|private\/branch|90\d/);
  expect((await at({ live: [], settled: rows(50), alertOver: 0 })).filter(i => i.kind === "worktrees")).toEqual([]);
  expect((await at(undefined)).filter(i => i.kind === "worktrees")).toEqual([]);                                       // an older hub with no shelf
  expect((await at({ unavailable: true })).filter(i => i.kind === "worktrees")).toEqual([]);
});

test("the plugin forwards the three worktree actions, asks first for Park and the GitHub refresh, and offers no removal action", async () => {
  const { provider, actions } = pluginFixture(undefined);
  const base = { projectId: "p1", instanceId: "i1" };
  for (const action of [{ action: "worktree_override_set", path: ".worktrees/a", value: "settled" }, { action: "worktrees_refresh_prs" }]) {
    const first = await provider.action({ ...base, ...action });
    expect(first).toMatchObject({ ok: false, needsConfirm: true });
    const confirmed = await provider.action({ ...base, ...action, confirmed: true, fingerprint: (first as any).fingerprint });
    expect(confirmed.ok).toBe(true);
  }
  expect((await provider.action({ ...base, action: "worktree_override_clear", path: ".worktrees/a" })).ok).toBe(true);
  expect(actions.map(a => a.action)).toEqual(["worktree_override_set", "worktrees_refresh_prs", "worktree_override_clear"]);
  for (const bad of ["worktree_remove", "worktrees_tidy", "worktree_delete"]) expect((await provider.action({ ...base, action: bad })).ok, bad).toBe(false);
});

// The page and docs.
test("the page's Worktrees section is in the Agents view, draws removal as a command to copy and never as a button, and a panel refresh posts no refresh action", () => {
  const html = readFileSync(join(import.meta.dir, "../src/ui/index.html"), "utf8");
  expect(html).toContain('id="worktrees-section" aria-labelledby="worktrees-title" data-view="agents"');
  const start = html.indexOf("function renderWorktrees(shelf)"), end = html.indexOf("function renderBench(bench)");
  const body = html.slice(start, end);
  expect(body).toContain("ahub worktrees tidy");
  expect(body).not.toMatch(/worktree_remove|tidy'?,\s*\{|--confirm/);
  // the only places that post the GitHub refresh are the button the person presses: it is never in the render path's snapshot call
  expect(html.match(/worktrees_refresh_prs/g)).toHaveLength(1);
  expect(html.slice(html.indexOf("function render(snapshot"), html.indexOf("function render(snapshot") + 200)).not.toContain("worktrees_refresh_prs");
});

// AC4/AC5, module boundary: the shelf's real logic now lives in `worktreeShelf` (and the snapshot's `worktreesView`), outside the control case that worktree-shelf.test.ts greps.
test("the daemon's shelf function removes nothing, spawns nothing and reaches GitHub only through the one refresh call", () => {
  const src = readFileSync(join(import.meta.dir, "../src/hub/daemon.ts"), "utf8");
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const start = src.indexOf("async function worktreeShelf("), end = src.indexOf("async function uiMemorySnapshot(", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const body = code(src.slice(start, end));
  for (const word of ["spawn", "exec(", "execFile", "rmSync", "unlinkSync", "worktree remove", "branch -d", "hubGitSync", "readSdlcPr", ".kill("]) expect(body, word).not.toContain(word);
  // GitHub is reached in exactly one place, inside the `refresh` branch, through the host's runner
  expect(body.match(/sdlcGh/g)).toHaveLength(1);
  expect(body.match(/refreshPrStates\(/g)).toHaveLength(1);
  expect(body.indexOf("refreshPrStates(")).toBeGreaterThan(body.indexOf("if (refresh) {"));
  // the snapshot view only calls the shelf function with the read request, never the refresh
  const view = code(src.slice(src.indexOf("function worktreesView("), src.indexOf("async function uiMemorySnapshot(")));
  expect(view).toContain('worktreeShelf({ t: "worktrees" })'); expect(view).not.toContain("refresh");
  // the shelf modules: the PR refresh module is the only one that names a GitHub reader, and the shelf module imports neither it nor the sdlc module
  const shelf = readFileSync(join(import.meta.dir, "../src/hub/worktree-shelf.ts"), "utf8");
  expect(shelf).not.toMatch(/from "\.\/(sdlc|worktree-prs)\.ts"/);
});

// The page's own renderer, run for real against a minimal DOM (the first browser pass found `NaNd` here: `rel` takes epoch milliseconds, and this code had passed it an ISO string).
test("the page's renderWorktrees draws real relative times, never NaN, and its buttons post exactly the Park/Pin/Unset/refresh actions", () => {
  const html = readFileSync(join(import.meta.dir, "../src/ui/index.html"), "utf8");
  const from = (name: string) => { const i = html.indexOf(name); return html.slice(i, html.indexOf("\n", i)); };
  const start = html.indexOf("function renderWorktrees(shelf)"), end = html.indexOf("function renderBench(bench)");
  class Node { tag = ""; children: Node[] = []; attrs: Record<string, string> = {}; dataset: Record<string, string> = {}; textContent = ""; className = ""; title = ""; type = ""; disabled = false; listeners: (() => void)[] = [];
    append(...kids: (Node | string)[]) { for (const kid of kids) { if (typeof kid === "string") { const t = new Node(); t.textContent = kid; this.children.push(t); } else this.children.push(kid); } }
    replaceChildren() { this.children = []; } addEventListener(_: string, fn: () => void) { this.listeners.push(fn); } setAttribute(k: string, v: string) { this.attrs[k] = v; }
    get all(): Node[] { return [this, ...this.children.flatMap(c => c.all)]; } get text(): string { return this.textContent + this.children.map(c => c.text).join(" "); } }
  const posted: Record<string, unknown>[] = [], targets: Record<string, Node> = { "worktrees-count": new Node(), worktrees: new Node() };
  const api = runInNewContext(`const $ = (id) => targets[id]; const el = (tag, text, cls) => { const node = new Node(); node.tag = tag; if (text !== undefined) node.textContent = String(text); if (cls) node.className = cls; return node; };
    const badge = (text, cls = '') => el('span', text, 'badge' + (cls ? ' ' + cls : '')); const signatures = new Map();
    const button = (text, payload) => { const node = el('button', text); node.payload = payload; return node; };
    ${from("const time = (value)")} ${html.slice(html.indexOf("const rel = (value) => {"), html.indexOf("const badge = (text"))} ${from("function empty(")}
    function update(id, data, render) { const target = $(id); target.replaceChildren(); render(target); }
    ${html.slice(start, end)}; ({ renderWorktrees })`, { Node, targets, console, Date });
  const now = Date.now();
  api.renderWorktrees({ live: [{ path: ".", branch: "main", fixed: true, lastActiveAt: now - 90_000 }, { path: ".worktrees/a", branch: "task/a", lastActiveAt: now - 3 * 3_600_000, task: 4, taskState: "in_progress", pr: 9 }],
    settled: [{ path: ".worktrees/b", branch: "task/b", reason: "parked", lastActiveAt: 0 }, { path: ".worktrees/c", branch: "task/c", reason: "merged", lastActiveAt: now - 9 * 86_400_000, private: true, taskState: "private" }],
    complete: true, quietDays: 7, alertOver: 10, prsReadAt: now - 120_000 });
  const section = targets.worktrees!, text = section.text;
  expect(text).not.toMatch(/NaN|Invalid Date|undefined/);
  expect(text).toMatch(/active 1m ago/); expect(text).toMatch(/active 3h ago/); expect(text).toContain("activity unknown"); expect(text).toMatch(/PR states read\s+2m ago/); expect(text).toContain("PR merged");
  expect(targets["worktrees-count"]!.textContent).toBe("2 live, 2 settled");
  expect(text).toContain("#4 in_progress");                                          // an ordinary row names its task; the private row after it shows no id
  expect(text.slice(text.indexOf(".worktrees/c"))).not.toMatch(/#\d/);
  const posted2 = section.all.filter(n => n.tag === "button").map(n => ({ label: n.textContent, ...(n as any).payload }));
  expect(posted2.map(b => b.label)).toEqual(["Park", "Pin", "Unset", "Pin", "Refresh PR states"]);   // the main checkout offers no Park
  expect(text).toContain("never shelved");
  expect(posted2.filter(b => b.action === "worktree_override_set").map(b => `${b.path}:${b.value}`)).toEqual([".worktrees/a:settled", ".worktrees/b:active", ".worktrees/c:active"]);
  expect(posted2.find(b => b.label === "Unset")).toMatchObject({ action: "worktree_override_clear", path: ".worktrees/b" });
  expect(posted2.at(-1)).toMatchObject({ action: "worktrees_refresh_prs" });
  void posted;
  // states that are not a list: pending, unavailable and an older hub with no shelf
  for (const [shelf, expected] of [[{ pending: true }, "Reading worktrees"], [{ unavailable: true }, "unavailable"], [undefined, "current snapshot"]] as const) { api.renderWorktrees(shelf); expect(targets.worktrees!.text).toContain(expected); }
  expect(targets["worktrees-count"]!.textContent).toBe("");
});

// The plugin's inbox alert against a REAL daemon: the provider connects to the daemon's own state dir, so the snapshot shape the alert reads is the one the daemon really emits.
test("the plugin's inbox alert reads a real daemon's snapshot: it appears once the settled count is above alert_over, with the real count and no path, and goes away at the threshold", async () => {
  const f = await rig({ config: { worktrees: { quiet_days: 7, alert_over: 1 } } });   // two settled worktrees (merged, quiet) against a threshold of 1
  const home = mkdtempSync(join(tmpdir(), "ahub-acon-real-")); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const project: ProjectRecord = { id: "shelf3", root: f.cwd, stateDir: f.stateDir, basePort: 4700, instanceId: f.instanceId, pid: process.pid };
  const registry = { get: (id: string) => id === project.id ? project : undefined, list: () => [project], close() {} } as any;
  const lifecycle: Lifecycle = { inspectProject: async () => ({ state: "running", status: { instanceId: f.instanceId, peers: {} } }), startProject: async () => ({}), stopProject: async () => {} };
  // #727: this test changes the daemon's settings out of band (not through the provider), so it asks for no inbox cache: what it checks is the alert's snapshot shape, not caching.
  const provider = createProvider({ home, registry, lifecycle, inboxFreshMs: 0, inboxStaleMs: 0 });
  const items = async () => ((await provider.snapshot({ after: 0, panel: "inbox" })).items as any[]).filter(i => i.kind === "worktrees");
  // the first snapshot only warms the daemon's cache; the alert follows on the next poll, as the panel's 2 s poll would see it
  await items(); await Bun.sleep(500);
  const raised = await items();
  expect(raised).toHaveLength(1);
  expect(raised[0]).toMatchObject({ group: "alert", id: "worktrees:shelf3", title: "2 settled worktrees", verbs: [{ id: "open" }], link: { panel: "agents", params: { project: "shelf3" } } });
  expect(JSON.stringify(raised)).not.toContain(f.cwd); expect(JSON.stringify(raised)).not.toMatch(/\.worktrees|task\//);
  // raise the threshold through the real settings path: the alert goes away with no restart (the cache is at most 30 s old, so ask the shelf to refresh it first)
  expect((await f.person.request({ t: "settings_set", key: "worktrees.alert_over", value: 2 } as never)).ok).toBe(true);
  await f.person.request({ t: "worktrees" });                                       // a read re-fills the cache with the new threshold
  const after = await items();
  expect(after).toEqual([]);
});
