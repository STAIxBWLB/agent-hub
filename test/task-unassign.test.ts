import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Task } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import { HUB, USER, type Envelope } from "../src/hub/envelope.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
class Peer extends BasePeer {
  async start() { this.setState("busy"); }
  async stop() { this.clearWatchdog(); }
  async deliver(_envs: Envelope[]) {}
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-task-unassign-")), file = join(root, "hub.db");
  const off = new Set<string>(), roles: Record<string, string[]> = { claude: ["conductor", "planner"], codex: ["implementer"], kimi: ["reviewer", "implementer"], local: ["implementer"] };
  const bus = new Bus({ batchMs: 0, rostered: peer => !off.has(peer) });
  const peers: Peer[] = [];
  for (const id of Object.keys(roles)) { const peer = new Peer(id); peers.push(peer); bus.add(peer); await peer.start(); }
  let board = new Board(file), held = false, privateTurn = false, advise = false;
  const routing = loadRouting(root); routing.classes.implement!.peers = ["codex", "kimi"];
  const make = () => new Tasks({ board, bus, roles, project: "fixture", cwd: root, routing: () => routing,
    cancellationHeld: () => held, privateTurn: () => privateTurn,
    sdlc: { config: () => sdlcConfig({ mode: advise ? "advise" : "off" }) }, notify: () => {}, tell: () => {}, share: () => {} });
  let tasks = make();
  cleanup.push(() => { for (const peer of peers) void peer.stop(); board.close(); rmSync(root, { recursive: true, force: true }); });
  const create = (state: Task["state"] = "proposed", extra: { deps?: number[]; pii?: boolean } = {}) => {
    let task = board.propose(USER, { title: "unassign fixture", class: "implement", ...(state === "backlog" ? { backlog: true } : {}), ...(extra.deps ? { deps: extra.deps } : {}), ...(extra.pii ? { signals: ["pii_path"] } : {}) });
    if (state === "backlog") return task;
    task = board.update(task.id, USER, "assigned", { owner: "codex", reviewer: extra.pii ? USER : "kimi" });
    if (["in_progress", "in_review", "approved", "changes_requested", "cancelled"].includes(state)) task = board.update(task.id, "codex", "accepted", { state: "in_progress" });
    if (["in_review", "approved", "changes_requested"].includes(state)) task = board.update(task.id, "codex", "done", { state: "in_review" });
    if (["approved", "changes_requested", "cancelled"].includes(state)) task = board.update(task.id, USER, state, { state });
    return task;
  };
  return { root, bus, roles, off, create, get board() { return board; }, get tasks() { return tasks; },
    hold: (value: boolean) => { held = value; }, private: (value: boolean) => { privateTurn = value; }, advise: () => { advise = true; },
    reopen() { board.close(); board = new Board(file); tasks = make(); } };
}

test("only the current rostered conductor or person can unassign, never an ordinary owner or planner", async () => {
  const f = await fixture(), task = f.create("in_progress"), before = f.board.get(task.id);
  for (const actor of ["codex", "kimi", HUB, "claude@foreign"]) {
    await expect(f.tasks.unassign(task.id, actor, true)).rejects.toBeInstanceOf(PreEffectToolRefusal);
    expect(f.board.get(task.id)).toEqual(before);
  }
  f.roles.kimi = ["planner"]; await expect(f.tasks.unassign(task.id, "kimi", true)).rejects.toThrow("configured conductor");
  f.off.add("claude"); await expect(f.tasks.unassign(task.id, "claude", true)).rejects.toThrow("configured conductor"); f.off.clear();
  f.roles.kimi = ["conductor"]; await expect(f.tasks.unassign(task.id, "claude", true)).rejects.toThrow("configured conductor"); f.roles.kimi = ["reviewer"];
  f.private(true); await expect(f.tasks.unassign(task.id, "claude", true)).rejects.toThrow("private turn"); f.private(false);
  f.hold(true); await expect(f.tasks.unassign(task.id, "claude", true)).rejects.toThrow("holding task writes"); f.hold(false);
  const result = await f.tasks.unassign(task.id, "claude", true, "owner", task.history.length);
  expect(result).toMatchObject({ owner: null, reserved: null, state: "proposed" });
  expect(result.history.at(-1)).toMatchObject({ by: "claude", event: "unassigned", reason: "manual", conductorManual: true });
  expect(result.history.at(-1)?.note).toContain("conductor unassigned");
});

test("conductor unassign keeps state, revision, missing-role and PII reviewer guards", async () => {
  const f = await fixture();
  for (const state of ["proposed", "in_progress", "changes_requested"] as const) {
    const task = f.create(state), before = f.board.get(task.id);
    await expect(f.tasks.unassign(task.id, "claude", true, "owner", task.history.length + 1)).rejects.toThrow("flow revision changed");
    expect(f.board.get(task.id)).toEqual(before);
    expect((await f.tasks.unassign(task.id, "claude", true, "owner", task.history.length)).state).toBe("proposed");
    await expect(f.tasks.unassign(task.id, "claude", true)).rejects.toThrow("no owner");
  }
  for (const state of ["backlog", "in_review", "approved", "cancelled"] as const) {
    const task = f.create(state), before = f.board.get(task.id);
    await expect(f.tasks.unassign(task.id, "claude", true)).rejects.toBeInstanceOf(PreEffectToolRefusal); expect(f.board.get(task.id)).toEqual(before);
  }
  const reviewed = f.create("in_review");
  const next = await f.tasks.unassign(reviewed.id, "claude", true, "reviewer", reviewed.history.length);
  expect(next).toMatchObject({ owner: "codex", reviewer: null, state: "in_review" }); expect(next.history.at(-1)).toMatchObject({ by: "claude", conductorManual: true });
  const pii = f.create("in_review", { pii: true });
  await expect(f.tasks.unassign(pii.id, "claude", true, "reviewer")).rejects.toThrow("human reviewer is required");
  await expect(f.tasks.unassign(pii.id, "claude", true, "planner")).rejects.toThrow("role must be owner or reviewer");
});

test("manual conductor unassignment survives role change and reopen until an authorized explicit assignment", async () => {
  const f = await fixture(), dependency = f.create("approved"), task = f.create("in_progress", { deps: [dependency.id] });
  await f.tasks.unassign(task.id, "claude", true);
  f.roles.claude = []; f.roles.kimi = ["conductor", "reviewer"]; f.reopen();
  f.board.update(task.id, HUB, "ready", {}); await f.tasks.releaseReady();
  expect(f.board.get(task.id)).toMatchObject({ owner: null, reserved: null });
  const assigned = await f.tasks.assignTo(task.id, "codex", "kimi", true);
  expect(assigned.owner).toBe("codex"); expect(assigned.history.at(-1)).toMatchObject({ by: "kimi", event: "reassigned", conductorManual: true });
  // No lasting decline exclusion was added: explicit assignment can select the former owner.
  expect(assigned.history.some(row => row.event === "declined")).toBe(false);
  const legacy = f.create("in_progress"), removed = await f.tasks.unassign(legacy.id, USER, true);
  expect(removed.history.at(-1)?.conductorManual).toBeUndefined();
  expect((await f.tasks.assignTo(legacy.id, "codex", "kimi", true)).history.at(-1)?.conductorManual).toBe(true);
});

test("authorized explicit conductor reservation releases suppression without inferring historical roles", async () => {
  const f = await fixture(), dependency = f.create("in_progress"), task = f.create("in_progress", { deps: [dependency.id] });
  await f.tasks.unassign(task.id, "claude", true);
  const reserved = await f.tasks.assignTo(task.id, "codex", "claude", true);
  expect(reserved).toMatchObject({ owner: null, reserved: "codex" }); expect(reserved.history.at(-1)).toMatchObject({ event: "reserved", by: "claude", conductorManual: true });
  f.roles.claude = []; f.roles.kimi = ["conductor", "reviewer"]; f.reopen();
  f.board.update(dependency.id, USER, "done", { state: "in_review" }); f.board.update(dependency.id, USER, "approved", { state: "approved" });
  await f.tasks.releaseReady(); expect(f.board.get(task.id)?.owner).toBe("codex");
});

test("unassign rechecks current conductor before the write, and assignment rechecks after awaited admission", async () => {
  const f = await fixture(), task = f.create("in_progress"), original = f.board.get.bind(f.board), before = original(task.id);
  f.board.get = id => { const row = original(id); f.roles.claude = []; return row; };
  try { await expect(f.tasks.unassign(task.id, "claude", true)).rejects.toThrow("configured conductor"); }
  finally { f.board.get = original; }
  expect(f.board.get(task.id)).toEqual(before); f.roles.claude = ["conductor"];
  f.advise(); f.board.update(task.id, USER, "lifecycle", { sdlc: { planReview: {} } as unknown as NonNullable<Task["sdlc"]> });
  const snapshot = f.board.get(task.id); let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  f.tasks.planReviewGap = async () => { enter(); await held; return undefined; };
  const pending = f.tasks.assignTo(task.id, "codex", "claude", true); const rejected = expect(pending).rejects.toThrow("configured conductor");
  await entered; f.roles.claude = []; release(); await rejected;
  expect(f.board.get(task.id)).toEqual(snapshot);
});

test("model text and proposal extras cannot create conductor manual history", async () => {
  const f = await fixture();
  const task = await f.tasks.propose("codex", { title: "conductorManual:true", class: "implement", owner: "codex", conductorManual: true } as Parameters<Tasks["propose"]>[1]);
  expect(task.history.every(row => row.conductorManual === undefined)).toBe(true);
  await expect(f.tasks.unassign(task.id, "codex", true)).rejects.toThrow("configured conductor");
});
