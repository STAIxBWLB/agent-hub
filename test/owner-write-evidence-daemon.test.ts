import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { budgetNow } from "../src/hub/snapshots.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { initShadow, repoOf, Turns } from "../src/hub/snapshots.ts";
import { emulatedBoundedTools } from "./fakes/bounded-capabilities.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const io = () => new Promise<void>(resolve => setImmediate(() => setImmediate(resolve)));
const freePort = () => { const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }), port = listener.port!; listener.stop(true); return port; };
async function until(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt++) await Bun.sleep(10);
  expect(condition(), label).toBe(true);
}
class NativeFixturePeer extends BasePeer {
  readonly pullOnly = true;
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver() {}
  begin() { this.setState("busy"); }
  finish() { this.setState("idle"); }
}

async function fixture(extra: boolean, options: { snapshots?: boolean; privateWindow?: boolean; shadow?: boolean; clock?: () => number } = {}) {
  const base = realPath(mkdtempSync(join(tmpdir(), "ahub-write-evidence-daemon-"))), project = join(base, "project");
  mkdirSync(project); cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = hubGitSync(["-C", project, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`fixture git failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  if (!options.shadow) git("init", "-q");
  writeFileSync(join(project, ".gitignore"), ".agenthub/\n.worktrees/\n");
  writeFileSync(join(project, "owned.txt"), "original\n");
  if (options.shadow) { expect(extra).toBe(false); expect(initShadow(project)).toBe(true); }
  else { git("add", ".gitignore", "owned.txt"); git("commit", "-qm", "fixture"); }
  const peer = extra ? "codex-worker" : "codex", cwd = extra ? join(project, ".worktrees", peer) : project;
  if (extra) git("worktree", "add", "-b", "owner-write-evidence", cwd, "HEAD");
  mkdirSync(join(project, ".agenthub"), { recursive: true });
  const instances = extra ? { [peer]: { kind: "codex", roles: ["implementer"], start_mode: "headless" as const, worktree: cwd } } : {};
  writeFileSync(join(project, ".agenthub/config.local.json"), JSON.stringify({ instances }));
  if (options.privateWindow) {
    const routing = readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8")
      .replace(/^pii_patterns = .*$/m, 'pii_patterns = ["PRIVATE-WINDOW"]')
      .replace(/^pi_backend = "mlx".*$/gm, "");
    writeFileSync(join(project, ".agenthub/routing.toml"), routing);
  }
  const binary = join(base, "fake-codex"), stateDir = join(project, ".agenthub/state");
  writeFileSync(binary, `#!${process.execPath}\nawait import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "fakes/codex-bin.ts")).href)});\n`, { mode: 0o700 });
  const daemon = await startDaemon({ cwd: project, stateDir, boundedTools: emulatedBoundedTools(), controlPort: 0,
    // #661: the snapshot budget reads a clock the test holds, so a slow runner cannot spend the 250 ms; a test of the exhausted case
    // passes a clock that jumps past it.
    snapshotClock: options.clock ?? (() => 0),
    codexAppPort: freePort(), codexProxyPort: freePort(),
    config: { ...DEFAULT_CONFIG, instances, codex_bin: binary, batch_ms: 0,
      roles: { ...DEFAULT_CONFIG.roles, ...(extra ? { [peer]: ["implementer"] } : {}) },
      snapshots: { enabled: options.snapshots ?? true, keep: 20 }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false, no_writes_turns: 2 },
      tasks: { ...DEFAULT_CONFIG.tasks, wip_limits: { codex: 20, [peer]: 20 } },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [] }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
    },
  });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console", projectRoot: project }); cleanup.push(() => console_.close());
  const reviewer = new NativeFixturePeer("claude"); daemon.bus.add(reviewer); await reviewer.start();
  let native: NativeFixturePeer | undefined, tui: WebSocket | undefined, requestId = 10;
  const messages: any[] = [];
  if (extra) {
    const started = await console_.request({ t: "start", peer }); expect(started).toMatchObject({ ok: true });
    expect(typeof started.proxyUrl).toBe("string");
    tui = new WebSocket(started.proxyUrl); cleanup.push(() => tui!.close());
    tui.onmessage = event => messages.push(JSON.parse(String(event.data))); tui.onerror = () => {};
    await until(() => tui!.readyState === WebSocket.OPEN, "fake native TUI socket opened");
    tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "owner-write-evidence-fixture" } } }));
    await until(() => messages.some(message => message.id === 1), "fake native initialize reply consumed");
    tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
    await until(() => messages.some(message => message.id === 2 && message.result?.thread?.id) && daemon.bus.stateOf(peer) === "idle", "actual extra native thread adopted");
  } else {
    native = new NativeFixturePeer(peer); daemon.bus.add(native); await native.start();
  }
  const tools = await ControlClient.connect(stateDir, { role: "tools", peer, projectRoot: project }); cleanup.push(() => tools.close());
  const turns = new Turns(join(stateDir, "hub.db"), true); cleanup.push(() => turns.close());
  const reviews: { task?: string; body: string }[] = [];
  daemon.bus.tap(event => { if (event.t === "envelope" && event.env.kind === "review") reviews.push({ task: event.env.refs?.task, body: event.env.body }); });
  const call = (client: ControlClient, op: string, args: Record<string, unknown>) => client.request({ t: "task", op, args });
  const make = async (refs: Record<string, unknown> = { paths: ["owned.txt"] }) => {
    const proposed = await call(console_, "hub_task_propose", { title: "implement the owned file change", class: "implement", owner: peer, refs });
    expect(proposed.ok).toBe(true);
    const id = Number(/task #(\d+):/.exec(proposed.text)?.[1]); expect(Number.isSafeInteger(id)).toBe(true);
    if (extra) await until(() => daemon.bus.stateOf(peer) === "idle" && daemon.bus.queued(peer) === 0 && !daemon.bus.hasInFlight(peer), "native owner task offer settled");
    const shown = JSON.parse((await call(console_, "task_show", { id })).text); expect(shown.owner).toBe(peer);
    await io();
    const accepted = await call(console_, "hub_task_accept", { id }); expect(accepted.ok).toBe(true); expect(accepted.text).toContain("in_progress");
    await io();
    if (extra) daemon.bus.pause(peer); // Hold future hub prompts; the real native adapter remains the execution owner.
    return id;
  };
  const done = async (id: number) => {
    await io();
    const reply = await call(console_, "hub_task_done", { id, summary: "completed and verified the requested work" });
    expect(reply.ok).toBe(true);
    const shown = await call(console_, "task_show", { id }); expect(shown.ok).toBe(true);
    return JSON.parse(shown.text);
  };
  const runTurn = async (during?: () => Promise<void> | void, text = "no file changes") => {
    await io();
    const previous = turns.latest(peer)?.id;
    if (extra) {
      const id = ++requestId;
      tui!.send(JSON.stringify({ id, method: "turn/start", params: { threadId: "th1", input: [{ type: "text", text }] } }));
      await until(() => messages.some(message => message.id === id && message.result?.turn?.id), "native turn accepted");
      await during?.();
      await until(() => turns.latest(peer)?.id !== previous && turns.latest(peer)?.ended != null && daemon.bus.peers.get(peer)?.state === "idle", "native turn completed with capture");
    } else {
      native!.begin(); await io(); await during?.(); native!.finish();
    }
    await io();
    const ended = turns.latest(peer)!;
    expect(ended.ended).not.toBeNull(); expect(ended.start_tree).not.toBeNull(); expect(ended.end_tree).not.toBeNull();
    return ended;
  };
  const stalls = async (id: number) => ((await console_.request({ t: "status" })).status.taskStalls ?? []).filter((stall: any) => stall.task === id && stall.cause.kind === "no-writes");
  return { project, cwd, peer, daemon, console_, tools, turns, reviews, native, git, call, make, done, runTurn, stalls };
}

const NO_WRITES = "no writes recorded since acceptance";
for (const canonicalDirty of [false, true]) test(`#498 extra owner done without writes is flagged${canonicalDirty ? " even while the canonical checkout is dirty" : ""}`, async () => {
  const f = await fixture(true), id = await f.make();
  if (canonicalDirty) writeFileSync(join(f.project, "owned.txt"), "unrelated canonical work\n");
  expect(readFileSync(join(f.cwd, "owned.txt"), "utf8")).toBe("original\n");
  const done = await f.done(id);
  expect(done.state).toBe("in_review");
  expect(done.history.findLast((entry: any) => entry.event === "done")?.noWrites).toBe(true);
  expect(f.reviews.filter(review => review.task === String(id)).map(review => review.body)).toEqual([expect.stringContaining(NO_WRITES)]);
}, 20_000);

test("#498 dirty work in the extra owner's real execution root exempts done without a completed-turn touch", async () => {
  const f = await fixture(true), id = await f.make();
  writeFileSync(join(f.cwd, "owned.txt"), "native work after acceptance\n");
  expect(readFileSync(join(f.project, "owned.txt"), "utf8")).toBe("original\n");
  expect(f.turns.touchesFor([id])).toEqual([]);
  const done = await f.done(id);
  expect(done.history.findLast((entry: any) => entry.event === "done")?.noWrites).toBeUndefined();
  expect(f.reviews.filter(review => review.task === String(id))).toHaveLength(1);
  expect(f.reviews.filter(review => review.task === String(id))[0]!.body).not.toContain(NO_WRITES);
}, 20_000);

test("#498 completed native extra-owner writes retain their exemption after the file returns to acceptance baseline", async () => {
  const f = await fixture(true), id = await f.make();
  // The fake's edit waits for this gate, so it can never land before the hub recorded the turn's start tree (#634).
  const gate = join(f.project, "..", "edit-gate"), before = f.turns.latest(f.peer)?.id;
  const turn = await f.runTurn(async () => {
    await until(() => { const latest = f.turns.latest(f.peer); return latest?.id !== before && latest?.start_tree != null; }, "native turn start tree recorded");
    writeFileSync(gate, "go");
  }, `EDIT:${join(f.cwd, "owned.txt")} GATE:${gate}`);
  expect(f.turns.workspace(turn.id)).toBe(f.cwd);
  expect(turn.changed).toContain("owned.txt");
  expect(f.turns.touchesFor([id])).toContainEqual(expect.objectContaining({ peer: f.peer, path: "owned.txt" }));
  writeFileSync(join(f.cwd, "owned.txt"), "original\n");
  const done = await f.done(id);
  expect(done.history.findLast((entry: any) => entry.event === "done")?.noWrites).toBeUndefined();
  expect(f.reviews.filter(review => review.task === String(id))[0]?.body).not.toContain(NO_WRITES);
}, 20_000);

test("#498 native completion records empty-turn stalls and file changes clear the streak with the time sweep disabled", async () => {
  const f = await fixture(false), id = await f.make();
  await f.runTurn(); expect(await f.stalls(id)).toEqual([]);
  await f.runTurn(); expect(await f.stalls(id)).toEqual([expect.objectContaining({ cause: expect.objectContaining({ kind: "no-writes", peer: f.peer, turns: 2 }) })]);
  await f.runTurn(() => { writeFileSync(join(f.cwd, "owned.txt"), "a real file change\n"); });
  expect(await f.stalls(id)).toEqual([]);
  await f.runTurn(); expect(await f.stalls(id)).toEqual([]);
  await f.runTurn(); expect(await f.stalls(id)).toHaveLength(1);
}, 20_000);

// #661: a turn whose snapshot budget ran out records "unknown", and unknown resets the no-writes streak. That is the documented rule (#576:
// never a stale baseline). It made the test above depend on runner speed: with the real clock the empty turns after a write could tip over
// on a slow runner. The test now holds the budget clock, so both halves are deterministic.
test("#661 an exhausted snapshot budget makes an empty turn unknown, which resets the streak instead of counting it", async () => {
  let t = 0;
  const f = await fixture(false, { clock: () => (t += 1000) }), id = await f.make(); // every read is a second later: the 250 ms is gone at once
  for (let turn = 0; turn < 4; turn++) {
    await io(); f.native!.begin(); await io(); f.native!.finish(); await io();
    expect(await f.stalls(id), "turn " + (turn + 1)).toEqual([]);
  }
}, 20_000);

test("#661 the same empty turns raise the stall when the budget clock does not move", async () => {
  const f = await fixture(false), id = await f.make();
  await f.runTurn(); expect(await f.stalls(id)).toEqual([]);
  await f.runTurn(); expect(await f.stalls(id)).toEqual([expect.objectContaining({ cause: expect.objectContaining({ kind: "no-writes", turns: 2 }) })]);
}, 20_000);

test("#661 the budget clock is a host-only seam: production reads performance.now, the share stays 250 ms, no config key reaches it", () => {
  const daemon = readFileSync(new URL("../src/hub/daemon.ts", import.meta.url), "utf8");
  expect(daemon).toMatch(/snapshotClock\?: \(\) => number;/);
  expect(daemon).toContain("const requested = opts.snapshotBurstMs ?? 250;"); // the whole statement: "?? 2500" would contain the shorter text
  expect(daemon).toContain("Math.min(250, requested)"); // the clamp that keeps the share at 250 ms
  expect(daemon).toContain("(now ? now() : performance.now()) + ms"); // unset means the real clock
  expect(daemon.match(/snapshotClock/g)).toHaveLength(2); // the declaration and the one read that builds the budget
  expect(daemon).not.toMatch(/config\.[a-z_.]*snapshotClock|config\.snapshots\.(clock|budget)/); // no configuration key chooses it
  // Every deadline comparison goes through budgetNow: a stray performance.now() would mix the real clock with an injected deadline. The
  // incoming-HEAD-move loop in the turn end is the one reader no test here reaches with a clock, so this is a pin, not a behaviour test.
  const snapshots = readFileSync(new URL("../src/hub/snapshots.ts", import.meta.url), "utf8");
  for (const [name, source] of [["daemon.ts", daemon], ["snapshots.ts", snapshots]] as const) expect(source, name).not.toMatch(/performance\.now\(\)\s*(>=|<=|>|<)\s*[\w.]*deadline|deadline\s*(>=|<=|>|<)\s*performance\.now\(\)|deadline\s*-\s*performance\.now\(\)/);
  expect(budgetNow({ deadline: 5 })).toBeGreaterThan(0); // no clock: the real one
  expect(budgetNow({ deadline: 5, now: () => 42 })).toBe(42);
});

test("#498 successful task-tool effects reset a native no-write streak while task-list reads do not", async () => {
  const f = await fixture(false), id = await f.make();
  await f.runTurn();
  await f.runTurn(async () => {
    const proposed = await f.call(f.tools, "hub_task_propose", { title: "follow-up triage", class: "triage", backlog: true });
    expect(proposed.ok).toBe(true);
  });
  expect(await f.stalls(id)).toEqual([]);
  const readOnly = async () => { expect((await f.call(f.tools, "hub_task_list", {})).ok).toBe(true); };
  await f.runTurn(readOnly); expect(await f.stalls(id)).toEqual([]);
  await f.runTurn(readOnly); expect(await f.stalls(id)).toHaveLength(1);
}, 20_000);


test("#498 disabled snapshots keep completed native no-write turns unknown instead of flagging a streak", async () => {
  const f = await fixture(false, { snapshots: false }), id = await f.make();
  expect(f.native).toBeDefined();
  for (let turn = 0; turn < 4; turn++) {
    await io(); f.native!.begin(); await io(); f.native!.finish(); await io();
    expect(await f.stalls(id)).toEqual([]);
  }
}, 20_000);

test("#498 disabled snapshots keep done evidence unknown rather than adding a no-write review warning", async () => {
  const f = await fixture(false, { snapshots: false }), id = await f.make();
  const done = await f.done(id);
  expect(done.state).toBe("in_review");
  expect(done.history.findLast((entry: any) => entry.event === "done")?.noWrites).toBeUndefined();
  const reviews = f.reviews.filter(review => review.task === String(id));
  expect(reviews).toHaveLength(1);
  expect(reviews[0]!.body).not.toContain(NO_WRITES);
}, 20_000);

test("#498 an unrelated open private task makes done snapshot evidence unknown without leaking its title", async () => {
  const f = await fixture(false, { privateWindow: true }), id = await f.make();
  const proposed = await f.call(f.console_, "hub_task_propose", { title: "PRIVATE-WINDOW", class: "triage", backlog: true });
  expect(proposed.ok).toBe(true);
  const privateId = Number(/task #(\d+):/.exec(proposed.text)?.[1]);
  expect(Number.isSafeInteger(privateId)).toBe(true);
  const privateRow = JSON.parse((await f.call(f.console_, "task_show", { id: privateId })).text);
  expect(privateRow.state).toBe("backlog"); expect(privateRow.signals).toContain("pii");
  const done = await f.done(id);
  expect(done.state).toBe("in_review");
  expect(done.history.findLast((entry: any) => entry.event === "done")?.noWrites).toBeUndefined();
  const reviews = f.reviews.filter(review => review.task === String(id));
  expect(reviews).toHaveLength(1);
  expect(reviews[0]!.body).not.toContain(NO_WRITES);
  expect(reviews[0]!.body).not.toContain("PRIVATE-WINDOW");
}, 20_000);


test("#498 canonical owner progress in an ignored linked worktree does not become a no-write stall", async () => {
  const f = await fixture(false), linked = join(f.project, ".worktrees", "canonical-owner-work");
  f.git("worktree", "add", "-b", "canonical-owner-work", linked, "HEAD");
  const id = await f.make();
  const first = await f.runTurn(() => { writeFileSync(join(linked, "owned.txt"), "first linked-worktree edit\n"); });
  expect(first.changed).toEqual([]); // The canonical snapshot cannot see this ignored execution work.
  expect(await f.stalls(id)).toEqual([]);
  const dirty = await f.runTurn(() => { writeFileSync(join(linked, "owned.txt"), "uncommitted second turn\n"); });
  expect(dirty.changed).toEqual([]); expect(await f.stalls(id)).toEqual([]);
  const second = await f.runTurn(() => {
    writeFileSync(join(linked, "owned.txt"), "second linked-worktree edit\n");
    f.git("-C", linked, "add", "owned.txt");
    f.git("-C", linked, "commit", "-qm", "linked owner implementation");
  });
  expect(second.changed).toEqual([]);
  expect(readFileSync(join(f.project, "owned.txt"), "utf8")).toBe("original\n");
  expect(f.git("-C", linked, "status", "--porcelain")).toBe("");
  expect(await f.stalls(id)).toEqual([]);
}, 20_000);

test("#498 commit-only progress on a non-current shared branch is not a no-write streak", async () => {
  const f = await fixture(false);
  f.git("branch", "non-current-progress");
  const canonicalHead = f.git("rev-parse", "HEAD"), tree = f.git("rev-parse", "HEAD^{tree}");
  const id = await f.make();
  for (let turn = 0; turn < 2; turn++) {
    const previous = f.git("rev-parse", "refs/heads/non-current-progress");
    const completed = await f.runTurn(() => {
      const next = f.git("commit-tree", tree, "-p", previous, "-m", `commit-only owner progress ${turn}`);
      f.git("update-ref", "refs/heads/non-current-progress", next, previous);
    });
    expect(completed.changed).toEqual([]);
    expect(f.git("rev-parse", "HEAD")).toBe(canonicalHead);
    expect(f.git("rev-parse", "refs/heads/non-current-progress")).not.toBe(previous);
    expect(await f.stalls(id)).toEqual([]);
  }
}, 20_000);

for (const evidence of ["branch", "linked-worktree path"] as const) test(`#498 a canonical owner's recorded ${evidence} keeps an empty capture unknown`, async () => {
  const f = await fixture(false), linked = join(f.project, ".worktrees", "recorded-owner-work");
  f.git("worktree", "add", "-b", "recorded-owner-work", linked, "HEAD");
  const refs = evidence === "branch" ? { paths: ["owned.txt"], branch: "recorded-owner-work" } : { paths: [join(linked, "owned.txt")] };
  const id = await f.make(refs);
  const shown = JSON.parse((await f.call(f.console_, "task_show", { id })).text);
  expect(shown.refs).toMatchObject(refs);
  for (let turn = 0; turn < 2; turn++) {
    expect((await f.runTurn()).changed).toEqual([]);
    expect(await f.stalls(id)).toEqual([]);
  }
}, 20_000);

test("#498 actual recorded SDLC head evidence prevents both empty-turn and done-without-refs advisories", async () => {
  const f = await fixture(false), id = await f.make(), localHead = f.git("rev-parse", "HEAD");
  const recorded = await f.call(f.tools, "hub_sdlc_record", { id, receipt: { localHead, localResult: "passed" } });
  expect(recorded.ok).toBe(true);
  const row = JSON.parse((await f.call(f.console_, "task_show", { id })).text);
  expect(row.sdlc).toMatchObject({ localHead, localResult: "passed" });
  expect(row.refs.branch).toBeUndefined(); expect(row.refs.commit).toBeUndefined();
  await f.runTurn(); await f.runTurn();
  expect(await f.stalls(id)).toEqual([]);
  const done = await f.done(id);
  expect(done.state).toBe("in_review");
  expect(done.history.findLast((entry: any) => entry.event === "done")?.noWrites).toBeUndefined();
  const reviews = f.reviews.filter(review => review.task === String(id));
  expect(reviews).toHaveLength(1); expect(reviews[0]!.body).not.toContain(NO_WRITES);
}, 20_000);

for (const restore of [false, true]) test(`#498 a real touch survives reacceptance${restore ? " and restoration to the first acceptance baseline" : " without a later diff"}`, async () => {
  const f = await fixture(false), id = await f.make();
  const written = await f.runTurn(() => { writeFileSync(join(f.cwd, "owned.txt"), "real accepted-owner edit\n"); });
  expect(written.changed).toContain("owned.txt");
  const touches = f.turns.touchesFor([id]);
  expect(touches).toContainEqual(expect.objectContaining({ task: id, peer: f.peer, path: "owned.txt" }));
  await io();
  const accepted = await f.call(f.console_, "hub_task_accept", { id, plan: { paths: ["owned.txt"], symbols: ["retained owner edit"] } });
  expect(accepted.ok).toBe(true);
  const row = JSON.parse((await f.call(f.console_, "task_show", { id })).text);
  expect(row.history.filter((entry: any) => entry.event === "accepted")).toHaveLength(2);
  if (restore) writeFileSync(join(f.cwd, "owned.txt"), "original\n");
  expect(f.turns.touchesFor([id])).toEqual(touches);
  const done = await f.done(id);
  expect(done.history.findLast((entry: any) => entry.event === "done")?.noWrites).toBeUndefined();
  const reviews = f.reviews.filter(review => review.task === String(id));
  expect(reviews).toHaveLength(1); expect(reviews[0]!.body).not.toContain(NO_WRITES);
}, 20_000);


test("#498 an unrecorded detached worktree outside the ignored directory keeps canonical negative evidence unknown", async () => {
  const f = await fixture(false), linked = join(f.project, "..", "detached-progress");
  f.git("worktree", "add", "--detach", linked, "HEAD");
  const id = await f.make();
  for (let turn = 0; turn < 2; turn++) {
    const completed = await f.runTurn(() => { writeFileSync(join(linked, "owned.txt"), `uncommitted detached edit ${turn}\n`); });
    expect(completed.changed).toEqual([]);
    expect(await f.stalls(id)).toEqual([]);
  }
}, 20_000);


test("#498 follow-up: ignored linked-worktree implementation does not receive a done-without-writes advisory", async () => {
  const f = await fixture(false), linked = join(f.project, ".worktrees", "done-owner-work");
  f.git("worktree", "add", "-b", "done-owner-work", linked, "HEAD");
  const id = await f.make();
  const completed = await f.runTurn(() => {
    writeFileSync(join(linked, "owned.txt"), "implemented only in linked worktree\n");
    f.git("-C", linked, "add", "owned.txt"); f.git("-C", linked, "commit", "-qm", "owner linked implementation");
  });
  expect(completed.changed).toEqual([]);
  expect(readFileSync(join(f.project, "owned.txt"), "utf8")).toBe("original\n");
  const done = await f.done(id);
  expect(done.state).toBe("in_review");
  expect(done.refs.branch).toBeUndefined(); expect(done.refs.commit).toBeUndefined(); expect(done.sdlc).toBeUndefined();
  expect(done.history.findLast((entry: any) => entry.event === "done")?.noWrites).toBeUndefined();
  const reviews = f.reviews.filter(review => review.task === String(id));
  expect(reviews).toHaveLength(1); expect(reviews[0]!.body).not.toContain(NO_WRITES);
}, 20_000);

test("#498 follow-up: initialized shadow projects can prove two consecutive empty owner turns", async () => {
  const f = await fixture(false, { shadow: true }), id = await f.make();
  expect(existsSync(join(f.project, ".git"))).toBe(false);
  expect(repoOf(f.project)?.shadow).toBe(true);
  expect((await f.runTurn()).changed).toEqual([]); expect(await f.stalls(id)).toEqual([]);
  expect((await f.runTurn()).changed).toEqual([]);
  expect(await f.stalls(id)).toEqual([expect.objectContaining({ cause: expect.objectContaining({ kind: "no-writes", peer: f.peer, turns: 2 }) })]);
}, 20_000);

test("#498 follow-up: refs/remotes-only progress resets no-write detection with canonical HEAD and files unchanged", async () => {
  const f = await fixture(false), ref = "refs/remotes/fixture/progress";
  f.git("update-ref", ref, "HEAD");
  const canonicalHead = f.git("rev-parse", "HEAD"), tree = f.git("rev-parse", "HEAD^{tree}"), id = await f.make();
  for (let turn = 0; turn < 2; turn++) {
    const previous = f.git("rev-parse", ref);
    const completed = await f.runTurn(() => {
      const next = f.git("commit-tree", tree, "-p", previous, "-m", `remote-only progress ${turn}`);
      f.git("update-ref", ref, next, previous);
    });
    expect(completed.changed).toEqual([]);
    expect(f.git("rev-parse", "HEAD")).toBe(canonicalHead);
    expect(f.git("rev-parse", ref)).not.toBe(previous);
    expect(readFileSync(join(f.project, "owned.txt"), "utf8")).toBe("original\n");
    expect(await f.stalls(id)).toEqual([]);
  }
}, 20_000);

for (const hint of ["branch", "worktree path"] as const) test(`#498 follow-up: recorded ${hint} prevents negative evidence without an actual .worktrees directory`, async () => {
  const f = await fixture(false), absentWorktree = join(f.project, ".worktrees", "planned-owner-work", "owned.txt");
  expect(existsSync(join(f.project, ".worktrees"))).toBe(false);
  if (hint === "branch") f.git("branch", "planned-owner-work");
  const refs = hint === "branch" ? { paths: ["owned.txt"], branch: "planned-owner-work" } : { paths: [absentWorktree] };
  const id = await f.make(refs);
  expect(existsSync(join(f.project, ".worktrees"))).toBe(false);
  for (let turn = 0; turn < 2; turn++) {
    expect((await f.runTurn()).changed).toEqual([]);
    expect(await f.stalls(id)).toEqual([]);
  }
  const done = await f.done(id);
  expect(done.history.findLast((entry: any) => entry.event === "done")?.noWrites).toBeUndefined();
  const reviews = f.reviews.filter(review => review.task === String(id));
  expect(reviews).toHaveLength(1); expect(reviews[0]!.body).not.toContain(NO_WRITES);
}, 20_000);

test("#498 follow-up: detached canonical same-tree commit movement is progress without a shared branch change", async () => {
  const f = await fixture(false); f.git("switch", "--detach", "HEAD");
  const tree = f.git("rev-parse", "HEAD^{tree}"), branches = f.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");
  const id = await f.make();
  for (let turn = 0; turn < 2; turn++) {
    const before = f.git("rev-parse", "HEAD");
    const completed = await f.runTurn(() => { f.git("commit", "--allow-empty", "-qm", `detached owner progress ${turn}`); });
    expect(completed.changed).toEqual([]);
    expect(f.git("rev-parse", "HEAD")).not.toBe(before);
    expect(f.git("rev-parse", "HEAD^{tree}")).toBe(tree);
    expect(f.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/")).toBe(branches);
    expect(await f.stalls(id)).toEqual([]);
  }
}, 20_000);
