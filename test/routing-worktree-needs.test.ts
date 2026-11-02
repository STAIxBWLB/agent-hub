import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { assign, loadRouting, type PeerCapabilities } from "../src/hub/routing.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";

class Peer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) {}
}

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

const REASON = "git worktree add runs outside the sandbox; this peer cannot create the task worktree (#270)";
const task = (signals: string[] = []) => ({ class: "implement" as const, signals: signals as any });
const caps = (pi: Partial<PeerCapabilities>): Record<string, PeerCapabilities> => ({ pi: { tests: true, spec: true, ...pi }, codex: { tests: true, spec: true, network: true, worktree: true } });

test("a task that needs a worktree is never routed to a sandboxed peer, and the trace says why (#1081 AC1 as amended)", () => {
  const routing = loadRouting(mkdtempSync(join(tmpdir(), "agenthub-worktree-")));
  const states = { pi: "idle", codex: "idle" } as any;
  const sandboxed = caps({ worktree: false, worktreeReason: REASON });
  for (const nomination of [{}, { namedOwner: "pi" }, { candidates: ["pi"] }]) {
    const result = assign({ ...task(["needs_worktree"]), reserved: "pi" }, states, routing, { capabilities: sandboxed, ...nomination });
    expect(result.owner).not.toBe("pi");
    expect(result.refusals?.find(row => row.peer === "pi" && row.role === "owner")).toMatchObject({ code: "worktree" });
    expect(result.trace.join("\n")).toContain("no worktree: git worktree add runs outside the sandbox");
  }
  expect(assign(task(["needs_worktree"]), states, routing, { capabilities: sandboxed }).owner).toBe("codex");
});

test("work that does not declare a worktree need, and a peer whose capability is unknown, are not refused (#1081)", () => {
  const routing = loadRouting(mkdtempSync(join(tmpdir(), "agenthub-worktree-")));
  const states = { pi: "idle", codex: "idle" } as any;
  expect(assign({ ...task(), reserved: "pi" }, states, routing, { capabilities: caps({ worktree: false }), namedOwner: "pi" }).owner).toBe("pi");
  expect(assign({ ...task(["needs_worktree"]), reserved: "pi" }, states, routing, { capabilities: caps({}), namedOwner: "pi" }).owner).toBe("pi");
  expect(assign({ ...task(["needs_worktree"]), reserved: "pi" }, states, routing, { capabilities: caps({ worktree: true }), namedOwner: "pi" }).owner).toBe("pi");
});

test("a network need and a worktree need are independent: each refuses on its own capability (#1081)", () => {
  const routing = loadRouting(mkdtempSync(join(tmpdir(), "agenthub-worktree-")));
  const states = { pi: "idle", codex: "idle" } as any;
  const onlyNetwork = caps({ network: true, worktree: false, worktreeReason: REASON });
  expect(assign({ ...task(["needs_network"]), reserved: "pi" }, states, routing, { capabilities: onlyNetwork, namedOwner: "pi" }).owner).toBe("pi");
  expect(assign({ ...task(["needs_worktree"]), reserved: "pi" }, states, routing, { capabilities: onlyNetwork, namedOwner: "pi" }).owner).not.toBe("pi");
  const both = assign({ ...task(["needs_network", "needs_worktree"]), reserved: "pi" }, states, routing, { capabilities: caps({ network: false, networkReason: "n", worktree: false, worktreeReason: REASON }), namedOwner: "pi" });
  expect(both.owner).not.toBe("pi");
});

async function rig(worktree: boolean) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-needs-worktree-"));
  mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  writeFileSync(join(cwd, ".agenthub", "routing.toml"), "[local]\nfixed_model=\"m\"\n[classes.implement]\npeers=[\"pi\",\"codex\"]\n");
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  cleanup.push(() => { bus.closeJournal(); board.close(); });
  for (const id of ["pi", "codex"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const live = { value: worktree };
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", roles: { claude: ["planner"] }, routing: () => loadRouting(cwd), notify: () => {}, wipLimit: () => 5,
    sdlc: { config: () => sdlcConfig({ mode: "off" }) },
    capabilities: () => ({ pi: { tests: true, spec: true, network: true, worktree: live.value, ...(live.value ? {} : { worktreeReason: REASON }) }, codex: { tests: true, spec: true, network: true, worktree: true } }) });
  return { cwd, board, tasks, live };
}

test("hub_task_propose records needs_worktree as a signal, and a non-boolean is refused with the next step (#1081)", async () => {
  const { board, tasks } = await rig(true);
  const made = await tasks.propose("user", { title: "raise the agent-mem pin", class: "implement", needs_worktree: true });
  expect(board.get(made.id)!.signals).toContain("needs_worktree");
  const plain = await tasks.propose("user", { title: "rename a helper", class: "implement" });
  expect(board.get(plain.id)!.signals).not.toContain("needs_worktree");
  let failure: unknown;
  try { await tasks.propose("user", { title: "x", class: "implement", needs_worktree: "yes" as unknown as boolean }); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(PreEffectToolRefusal);
  expect((failure as Error).message).toContain("true or false");
  expect(board.list().length).toBe(2);
});

test("an explicit assignment and a reservation of worktree work to a sandboxed peer are refused before any write (#1081)", async () => {
  const { board, tasks } = await rig(false);
  const made = await tasks.propose("user", { title: "raise the pin", class: "implement", needs_worktree: true });
  const before = JSON.stringify(board.get(made.id));
  let failure: unknown;
  try { await tasks.assignTo(made.id, "pi"); } catch (error) { failure = error; }
  expect(failure).toBeDefined();
  expect((failure as Error).message).toContain("no worktree");
  expect(JSON.stringify(board.get(made.id))).toBe(before);
  const blocker = board.propose("user", { title: "must land first", class: "implement" });
  let reserved: unknown;
  try { await tasks.propose("user", { title: "raise the pin again", class: "implement", owner: "pi", after: [blocker.id], needs_worktree: true }); } catch (error) { reserved = error; }
  expect(reserved).toBeDefined();
  expect((reserved as Error).message).toContain("no worktree");
  expect(board.list().length).toBe(2); // the first task and the blocker; the refused reservation left nothing behind
});

test("accept of worktree work by a sandboxed peer is refused before any write, names the cause, and leaves no branch ref behind (#1081 AC1, #621, #565)", async () => {
  const { cwd, board, tasks, live } = await rig(true);
  const git = (args: string[]): string => { const result = hubGitSync(args, { cwd, encoding: "utf8", timeout: 5000 }); expect(result.status, String(result.stderr)).toBe(0); return String(result.stdout); };
  git(["init", "-q", "-b", "main"]);
  git(["-c", "user.name=f", "-c", "user.email=f@f", "commit", "-q", "--allow-empty", "-m", "base"]);
  const refs = () => git(["for-each-ref", "--format=%(refname)"]);
  const row = board.propose("user", { title: "raise the pin", class: "implement", signals: ["needs_worktree"] });
  board.update(row.id, "user", "assigned", { owner: "pi" });
  live.value = false; // the offer was made while Pi could create one; it cannot now
  const beforeRefs = refs(), beforeTask = JSON.stringify(board.get(row.id));
  let failure: unknown;
  try { tasks.accept("pi", row.id); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(PreEffectToolRefusal);
  const text = (failure as Error).message;
  expect(text).toContain("needs its own git worktree");
  expect(text).toContain("git worktree add runs outside the sandbox");
  expect(text).toContain("no branch ref is left behind");
  expect(text).toContain("decline it");
  expect(JSON.stringify(board.get(row.id))).toBe(beforeTask);
  expect(refs()).toBe(beforeRefs); // the hub created no branch, so none can be left behind
  live.value = true;
  expect(() => tasks.accept("pi", row.id)).not.toThrow();
  expect(board.get(row.id)).toMatchObject({ state: "in_progress", owner: "pi" });
});

test("the console user accepting on a sandboxed owner's behalf is held to the owner's capability (#1081)", async () => {
  const { board, tasks } = await rig(false); // pi cannot create a worktree
  const row = board.propose("user", { title: "console accept worktree work", class: "implement", signals: ["needs_worktree"] });
  board.update(row.id, "user", "assigned", { owner: "pi" });
  const before = JSON.stringify(board.get(row.id));
  let failure: unknown;
  try { tasks.accept("user", row.id); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(PreEffectToolRefusal);
  expect((failure as Error).message).toContain("pi cannot create one");
  expect(JSON.stringify(board.get(row.id))).toBe(before);
  // the same console acceptance of ordinary work still goes through
  const plain = board.propose("user", { title: "console accept ordinary work", class: "implement" });
  board.update(plain.id, "user", "assigned", { owner: "pi" });
  expect(() => tasks.accept("user", plain.id)).not.toThrow();
});

test("the console user accepting network work for a network-less owner is refused too (#1081)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-console-network-"));
  mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  writeFileSync(join(cwd, ".agenthub", "routing.toml"), "[local]\nfixed_model=\"m\"\n[classes.implement]\npeers=[\"pi\",\"codex\"]\n");
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  cleanup.push(() => { bus.closeJournal(); board.close(); });
  for (const id of ["pi", "codex"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", roles: { claude: ["planner"] }, routing: () => loadRouting(cwd), notify: () => {}, wipLimit: () => 5,
    sdlc: { config: () => sdlcConfig({ mode: "off" }) },
    capabilities: () => ({ pi: { tests: true, spec: true, network: false, networkReason: "local.bash_network is off", worktree: true }, codex: { tests: true, spec: true, network: true, worktree: true } }) });
  const row = board.propose("user", { title: "console accept network work", class: "implement", signals: ["needs_network"] });
  board.update(row.id, "user", "assigned", { owner: "pi" });
  const before = JSON.stringify(board.get(row.id));
  let failure: unknown;
  try { tasks.accept("user", row.id); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(PreEffectToolRefusal);
  expect((failure as Error).message).toContain("pi has none");
  expect(JSON.stringify(board.get(row.id))).toBe(before);
});

test("accept of ordinary work is unaffected by a sandboxed peer (#1081)", async () => {
  const { board, tasks } = await rig(false);
  const row = board.propose("user", { title: "rename a helper", class: "implement" });
  board.update(row.id, "user", "assigned", { owner: "pi" });
  expect(() => tasks.accept("pi", row.id)).not.toThrow();
  expect(board.get(row.id)!.state).toBe("in_progress");
});

test("route explain for a worktree task names the sandboxed peer and why, and #1115 for the way out (#1081 AC1)", async () => {
  const { board, tasks } = await rig(false);
  const made = await tasks.propose("user", { title: "raise the pin", class: "implement", needs_worktree: true });
  const text = tasks.publicExplain(made.id).join("\n");
  expect(text).toContain("signals: needs_worktree");
  expect(text).toContain("pi: skipped, no worktree: git worktree add runs outside the sandbox");
  expect(board.get(made.id)!.owner).not.toBe("pi");
  const plain = await tasks.propose("user", { title: "rename a helper", class: "implement" });
  expect(tasks.publicExplain(plain.id).join("\n")).not.toContain("no worktree");
});
