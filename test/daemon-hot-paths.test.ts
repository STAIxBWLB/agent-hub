import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDaemon, DEFAULT_CONFIG, type DaemonOptions } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { readEvents } from "../src/hub/events.ts";
import { mainCheckoutBranch } from "../src/hub/main-checkout.ts";
import { headTree, repoOf, snapshot, SnapshotBudgetExceeded, Turns } from "../src/hub/snapshots.ts";
import { emulatedBoundedTools } from "./fakes/bounded-capabilities.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
class FakePeer extends BasePeer {
  readonly pullOnly = true;
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver() {}
  begin() { this.setState("busy"); }
  finish() { this.setState("idle"); }
}
async function fixture(tasks = 1, slow = false, linked = false) {
  let root = realpathSync(mkdtempSync(join(tmpdir(), "ahub-hot-path-")));
  const container = root;
  cleanup.push(() => rmSync(container, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", root, "-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", ...args]);
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  git("init", "-q");
  writeFileSync(join(root, "shared.txt"), "base\n");
  git("add", "."); git("commit", "-qm", "base");
  if (linked) {
    const worktree = join(root, "linked");
    git("worktree", "add", "-qb", "linked", worktree);
    root = worktree;
  }
  const stateDir = join(root, ".agenthub/state");
  let checkoutReads = 0;
  let snapshotStarted: (() => void) | undefined;
  const options: DaemonOptions = {
    cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    boundedTools: emulatedBoundedTools(),
    checkoutBranch: (...args) => { checkoutReads++; return slow ? undefined : mainCheckoutBranch(...args); },
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [] }, snapshots: { enabled: true, keep: 20 }, batch_ms: 0,
      tasks: { ...DEFAULT_CONFIG.tasks, wip_limits: { kimi: 20, codex: 20 } } },
    // #661: every fixture but the slow one holds the budget clock; the slow one is the test of the real budget (#576), so it keeps performance.now.
    ...(slow ? {} : { snapshotClock: () => 0 }),
    // Host-only seam: a genuinely slow snapshot, without spawning a real provider or altering global functions.
    ...(slow ? { snapshotBurstMs: 500, snapshot: (...args: Parameters<typeof snapshot>) => {
      snapshotStarted?.();
      const budget = args[1];
      const wait = budget ? Math.max(0, Math.min(350, budget.deadline - performance.now())) : 350;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
      return snapshot(...args); // The real runner refuses evidence after its deadline, including after this fake delay.
    } } : {}),
  };
  const daemon = await startDaemon(options);
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" });
  cleanup.push(() => client.close());
  const peers = [new FakePeer("kimi"), new FakePeer("codex")];
  for (const peer of peers) { daemon.bus.add(peer); await peer.start(); }
  for (const peer of peers) for (let i = 0; i < tasks; i++) {
    const r = await client.request({ t: "task", op: "hub_task_propose", args: { title: `fixture ${peer.id} ${i}`, class: "implement", owner: peer.id } });
    expect(r.ok).toBe(true);
  }
  const rows = JSON.parse((await client.request({ t: "task", op: "hub_task_list", args: {} })).text);
  expect(rows.filter((row: { owner: unknown }) => row.owner)).toHaveLength(tasks * 2);
  const notices: string[] = [];
  daemon.bus.tap(e => { if (e.t === "envelope" && e.env.body.startsWith("Concurrent edit:")) notices.push(e.env.body); });
  const events = () => readEvents(join(stateDir, "events.jsonl"));
  return { root, git, daemon, client, peers, notices, events, probes: () => checkoutReads, onSnapshot: (fn: () => void) => { snapshotStarted = fn; } };
}

for (const move of ["fast-forward", "checkout", "worktree-merge"] as const) test(`#576 ${move} under two open turns is not a peer edit`, async () => {
  const f = await fixture(1, false, move === "worktree-merge");
  const base = f.git("rev-parse", "HEAD");
  f.git("switch", "-qc", "incoming");
  writeFileSync(join(f.root, "shared.txt"), "committed elsewhere\n");
  f.git("commit", "-qam", "incoming");
  const incoming = f.git("rev-parse", "HEAD");
  f.git("switch", "-qc", "before", base);
  for (const peer of f.peers) peer.begin();
  if (move !== "checkout") f.git("merge", "--ff-only", "incoming");
  else f.git("checkout", "-q", incoming);
  for (const peer of f.peers) { await new Promise<void>(resolve => setImmediate(resolve)); peer.finish(); }
  expect(f.events().filter(e => e.type === "conflict")).toEqual([]);
  expect(f.notices).toEqual([]);
  expect(f.events().filter(e => e.type === "turn_end").map(e => e.files)).toEqual([0, 0]);
});

test("#576 real concurrent edits publish linearly in tasks, not one notice per task pair", async () => {
  const f = await fixture(6);
  // #617: this tests notice fan-out, not the cumulative snapshot budget. Keep both turns open, but let each
  // capture use a new I/O turn's budget; four slower captures in one burst can correctly leave evidence unknown.
  for (const peer of f.peers) { peer.begin(); await new Promise<void>(resolve => setImmediate(resolve)); }
  const turns = f.events().filter(e => e.type === "turn_start").map(e => e.turn);
  expect(turns).toHaveLength(2);
  writeFileSync(join(f.root, "shared.txt"), "a real working-tree edit\n");
  for (const peer of f.peers) { peer.finish(); await new Promise<void>(resolve => setImmediate(resolve)); }
  const published = () => f.events().some(e => e.type === "conflict" && e.concurrent && e.paths.includes("shared.txt") && turns.every(id => e.turns?.includes(id)))
    && f.notices.some(body => body.includes("shared.txt") && turns.every(id => body.includes(id)));
  for (let attempt = 0; attempt < 100 && !published(); attempt++) await Bun.sleep(20);
  expect(published()).toBe(true); // Assert after the final attempt too; unrelated history cannot satisfy this wait.
  expect(f.events().filter(e => e.type === "conflict").length).toBeGreaterThan(0);
  expect(f.notices.length).toBeLessThanOrEqual(12);
  expect(f.notices.length).toBeGreaterThan(0);
  expect(f.notices.join("\n")).toContain("shared.txt");
}, 20_000);

// #531: the daemon makes no wall-clock promise for status; it is answered on the next event-loop turns while the burst keeps working.
// The proof is ordering (answered before the producer finished its waves), which a starved runner cannot change. The old 1 s elapsed bound
// measured the runner (idle 0.52 s, 17 of 20 failures with 64 CPU spinners on 4 cores), so the request timeout is only a hang guard.
test("#576 status answers within its timeout while a longer slow-snapshot burst is still running", async () => {
  const f = await fixture(8, true);
  let reply: ReturnType<ControlClient["request"]> | undefined;
  f.onSnapshot(() => {
    if (reply) return;
    reply = f.client.request({ t: "status" }, 10_000);
    void reply.catch(() => {}); // Attach immediately: the producer deliberately keeps working until we can await it.
  });
  let completed = false, completedWaves = 0;
  const burstStarted = performance.now();
  const producer = (async () => {
    for (let wave = 0; wave < 5; wave++) {
      for (const peer of f.peers) peer.begin();
      writeFileSync(join(f.root, "shared.txt"), `working-tree edit ${wave}\n`);
      for (const peer of f.peers) peer.finish();
      completedWaves++;
      // Cross a socket poll phase before replenishing work; a microtask yield alone cannot service the WS.
      await new Promise<void>(resolve => setImmediate(() => setImmediate(resolve)));
    }
    completed = true;
  })();
  try {
    expect(reply).toBeDefined(); // The request was issued inside the first in-flight slow snapshot.
    expect((await reply!).status).toBeDefined();
    expect(completed).toBe(false);
    expect(completedWaves).toBeLessThan(5);
  } finally { await producer; }
  expect(completed).toBe(true);
  expect(performance.now() - burstStarted).toBeGreaterThan(1_000);
}, 15_000);

test("#576 status Git advisory probes are bounded once per synchronous burst", async () => {
  const f = await fixture(4);
  await Bun.sleep(0);
  const before = f.probes();
  for (const peer of f.peers) peer.begin();
  writeFileSync(join(f.root, "shared.txt"), "changed in a real turn\n");
  for (const peer of f.peers) peer.finish();
  expect(f.probes() - before).toBeLessThanOrEqual(1);
  const first = f.probes();
  await Bun.sleep(0);
  await f.client.request({ t: "status" });
  expect(f.probes()).toBeGreaterThan(first); // no stale advisory cache across control turns
});

for (const linked of [false, true]) for (const amend of [false, true]) test(`#576 a peer's own ${amend ? "amend" : "commit"} stays attributed${linked ? " in a linked worktree" : ""}`, async () => {
  const f = await fixture(1, false, linked);
  f.peers[0]!.begin();
  writeFileSync(join(f.root, "own.txt"), "peer edit to commit\n");
  f.git("add", "own.txt");
  if (amend) f.git("commit", "--amend", "-qm", "peer amend");
  else f.git("commit", "-qm", "peer commit");
  await new Promise<void>(resolve => setImmediate(resolve));
  f.peers[0]!.finish();
  expect(f.events().filter(e => e.type === "turn_end").map(e => e.files)).toEqual([1]);
  const turns = new Turns(join(f.root, ".agenthub/state/hub.db"), true);
  try {
    expect(turns.list("kimi")[0]?.changed).toEqual(["own.txt"]);
    expect(turns.touchesFor([1]).map(touch => touch.path)).toContain("own.txt");
  } finally { turns.close(); }
});

test("#576 HEAD movement keeps independent working-tree edits attributable", async () => {
  const f = await fixture();
  const base = f.git("rev-parse", "HEAD");
  f.git("switch", "-qc", "incoming");
  writeFileSync(join(f.root, "shared.txt"), "committed elsewhere\n");
  f.git("commit", "-qam", "incoming change");
  f.git("switch", "-qc", "before", base);
  f.peers[0]!.begin();
  f.git("merge", "--ff-only", "incoming");
  writeFileSync(join(f.root, "own.txt"), "peer-only\n");
  await new Promise<void>(resolve => setImmediate(resolve));
  f.peers[0]!.finish();
  expect(f.events().filter(e => e.type === "turn_end").map(e => e.files)).toEqual([1]);
  expect(f.events().filter(e => e.type === "conflict")).toEqual([]);
});

test("#576 an unavailable committed HEAD delta leaves attribution and undo unknown", async () => {
  const f = await fixture();
  const oldHead = f.git("rev-parse", "HEAD^{tree}");
  const base = f.git("rev-parse", "HEAD");
  f.git("switch", "-qc", "incoming");
  writeFileSync(join(f.root, "shared.txt"), "committed elsewhere\n");
  f.git("commit", "-qam", "incoming change");
  f.git("switch", "-qc", "before", base);
  writeFileSync(join(f.root, "untracked.txt"), "keeps the turn snapshot distinct from HEAD\n");
  f.peers[0]!.begin();
  f.git("merge", "--ff-only", "incoming");
  // Only this fixture's old committed root tree is unavailable; the two workspace snapshots still exist.
  rmSync(join(f.git("rev-parse", "--absolute-git-dir"), "objects", oldHead.slice(0, 2), oldHead.slice(2)));
  f.peers[0]!.finish();
  const ended = f.events().find(e => e.type === "turn_end");
  expect(ended).toBeDefined();
  expect(ended).not.toHaveProperty("files");
  expect(f.events().filter(e => e.type === "conflict")).toEqual([]);
  const turns = new Turns(join(f.root, ".agenthub/state/hub.db"), true);
  try { expect(turns.list("kimi")[0]).toMatchObject({ end_tree: null, changed: [] }); } finally { turns.close(); }
});

test("#576 a long turn gets one change-set notice across multiple completed overlapping turns", async () => {
  const f = await fixture();
  const ours: string[] = [];
  f.daemon.bus.tap(e => { if (e.t === "envelope" && e.env.to?.includes("kimi") && e.env.body.startsWith("Concurrent edit:")) ours.push(e.env.body); });
  f.peers[0]!.begin();
  for (let n = 0; n < 3; n++) {
    if (n) expect((await f.client.request({ t: "task", op: "hub_task_propose", args: { title: `next overlapping task ${n}`, class: "implement", owner: "codex" } })).ok).toBe(true);
    f.peers[1]!.begin();
    writeFileSync(join(f.root, "shared.txt"), `overlapping edit ${n}\n`);
    f.peers[1]!.finish();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  f.peers[0]!.finish();
  expect(ours).toHaveLength(1);
  expect(f.notices.length).toBeLessThanOrEqual(4);
  expect(f.events().filter(e => e.type === "conflict").length).toBeGreaterThan(0);
});

test("#576 a blocked Git child is cut off by the shared snapshot deadline", async () => {
  const f = await fixture();
  const repo = repoOf(f.root)!;
  const bin = join(f.root, "fake-bin"); mkdirSync(bin);
  writeFileSync(join(bin, "git"), "#!/bin/sh\nexec /bin/sleep 5\n", { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const started = performance.now();
    expect(() => headTree(repo, { deadline: started + 80 })).toThrow(SnapshotBudgetExceeded);
    expect(performance.now() - started).toBeLessThan(1_000);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  }
});

for (const move of ["checkout-m", "merge-autostash"] as const) test(`#576 ${move} never excludes a carried uncommitted peer edit`, async () => {
  const f = await fixture();
  const base = Array.from({ length: 20 }, (_, i) => `line ${i}\n`);
  writeFileSync(join(f.root, "shared.txt"), base.join(""));
  f.git("commit", "-qam", "prepare separate lines");
  const start = f.git("rev-parse", "HEAD");
  f.git("switch", "-qc", "upstream");
  const incoming = [...base]; incoming[1] = "upstream line\n";
  writeFileSync(join(f.root, "shared.txt"), incoming.join(""));
  writeFileSync(join(f.root, "upstream.txt"), "upstream-only\n");
  f.git("add", "shared.txt", "upstream.txt"); f.git("commit", "-qm", "upstream changes");
  expect(f.git("ls-files", "--", ".agenthub/state")).toBe("");
  f.git("switch", "-qc", "before", start);
  f.peers[0]!.begin();
  const own = [...base]; own[18] = "own dirty line\n";
  writeFileSync(join(f.root, "shared.txt"), own.join(""));
  if (move === "checkout-m") f.git("checkout", "-m", "upstream");
  else f.git("merge", "--ff-only", "--autostash", "upstream");
  await new Promise<void>(resolve => setImmediate(resolve));
  f.peers[0]!.finish();
  const turns = new Turns(join(f.root, ".agenthub/state/hub.db"), true);
  try {
    expect(turns.list("kimi")[0]).toMatchObject({ changed: ["shared.txt"] });
    expect(turns.list("kimi")[0]?.end_tree).not.toBeNull();
    expect(turns.touchesFor([1]).map(touch => touch.path)).toContain("shared.txt");
  } finally { turns.close(); }
  expect(f.events().filter(e => e.type === "turn_end").map(e => e.files)).toEqual([1]);
});

for (const autostash of [false, true]) test(`#576 pull --rebase${autostash ? " --autostash" : ""} never attributes the advanced upstream or drops a dirty peer edit`, async () => {
  const f = await fixture();
  const start = f.git("rev-parse", "HEAD");
  f.git("switch", "-qc", "upstream");
  writeFileSync(join(f.root, "upstream.txt"), "incoming-only\n");
  f.git("add", "upstream.txt"); f.git("commit", "-qm", "upstream");
  f.git("switch", "-qc", "before", start);
  writeFileSync(join(f.root, "own.txt"), "pre-turn own commit\n");
  f.git("add", "own.txt"); f.git("commit", "-qm", "own commit before turn");
  f.peers[0]!.begin();
  if (autostash) writeFileSync(join(f.root, "own.txt"), "own edit during turn\n");
  f.git("pull", "-q", "--rebase", ...(autostash ? ["--autostash"] : []), ".", "upstream");
  await new Promise<void>(resolve => setImmediate(resolve));
  f.peers[0]!.finish();
  const turns = new Turns(join(f.root, ".agenthub/state/hub.db"), true);
  try {
    const turn = turns.list("kimi")[0]!;
    expect(turn.changed).not.toContain("upstream.txt");
    if (turn.end_tree === null) expect(turn.changed).toEqual([]);
    else if (autostash) expect(turn.changed).toContain("own.txt");
  } finally { turns.close(); }
});
