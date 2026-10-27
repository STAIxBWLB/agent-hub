import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Task } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { type Envelope, USER } from "../src/hub/envelope.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";

// #785 P1c: opt-in `tasks.auto_pull`. A freed planner slot pulls the one top backlog card explicitly reserved for that peer, through pullPlanned.
class Quiet extends BasePeer {
  received: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[]) { this.received.push(...envs); }
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const until = async (condition: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!condition() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5)); return condition(); };
const settle = () => new Promise(resolve => setTimeout(resolve, 80));

async function rig(autoPull: boolean | (() => boolean) = true) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-auto-pull-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  const roles: Record<string, string[]> = { claude: ["planner"], pi: ["planner"], codex: ["implementer"], kimi: ["implementer"] };
  const flag = { on: typeof autoPull === "function" ? autoPull : () => autoPull };
  const tasks = new Tasks({ cwd, board, bus, roles, project: "fixture", routing: () => loadRouting(cwd), notify: line => notices.push(line), autoPull: () => flag.on() });
  const peers = new Map<string, Quiet>();
  for (const id of Object.keys(roles)) { const peer = new Quiet(id); peers.set(id, peer); bus.add(peer); await peer.start(); }
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const card = (fields: Partial<Task> & { reserved?: string } = {}) => {
    const made = board.propose(USER, { title: "PRIVATE_TASK_TITLE", detail: "PRIVATE_TASK_DETAIL", class: "implement", backlog: true,
      planner: fields.planner ?? "claude", deps: fields.deps, reserved: fields.reserved, signals: fields.signals });
    const { priority, rank, pinned, release } = fields;
    const patch = Object.fromEntries(Object.entries({ priority, rank, pinned, release }).filter(([, value]) => value !== undefined));
    return Object.keys(patch).length ? board.plan(made.id, USER, patch, 0) : made;
  };
  /** A task codex is in review on: approving it frees codex's only planner slot. */
  const inReview = () => {
    let task = card();
    task = board.update(task.id, USER, "backlog pulled", { state: "proposed", owner: "codex", reviewer: USER });
    task = board.update(task.id, "codex", "accepted", { state: "in_progress" });
    return board.update(task.id, "codex", "done", { state: "in_review" });
  };
  const release = async () => { const task = inReview(); await tasks.review(USER, task.id, "approved"); return task; };
  return { cwd, board, bus, tasks, flag, peers, notices, card, inReview, release };
}
const pulled = (task: Task | undefined) => !!task && task.state !== "backlog";
const pullEntry = (task: Task) => task.history.find(entry => entry.event === "backlog pulled");

test("on: a freed slot pulls the top card reserved for that peer, as the hub for the planner of record, with the reason recorded", async () => {
  const r = await rig(true);
  const lower = r.card({ reserved: "codex", priority: 3 }), top = r.card({ reserved: "codex", priority: 1 });
  await r.release();
  expect(await until(() => pulled(r.board.get(top.id)))).toBe(true);
  const after = r.board.get(top.id)!;
  expect(after.owner).toBe("codex"); expect(after.state).toBe("proposed");
  expect(pullEntry(after)).toMatchObject({ by: "hub", planner: "claude", event: "backlog pulled", note: expect.stringContaining("auto_pull: capacity released for codex; hub acted for planner claude") });
  expect(r.board.get(lower.id)!.state).toBe("backlog"); // one card per release: the second waits for the next freed slot
  expect(r.tasks.wip("codex")).toBe(1); // the pull took the slot it was freed for, so nothing else can follow
});

test("off (the default): the same release pulls nothing and still sends the notice", async () => {
  for (const setting of [false, undefined] as const) {
    const r = await rig(setting === undefined ? () => false : setting);
    const reserved = r.card({ reserved: "codex", priority: 1 });
    await r.release(); await settle();
    expect(r.board.get(reserved.id)!.state).toBe("backlog");
    expect(r.peers.get("claude")!.received.some(env => env.body.includes(`capacity_released: codex WIP 0; reserved ready #${reserved.id}`))).toBe(true);
  }
});

test("a live reload applies to the next release: off, then on", async () => {
  let on = false;
  const r = await rig(() => on);
  const reserved = r.card({ reserved: "codex", priority: 1 });
  await r.release(); await settle();
  expect(r.board.get(reserved.id)!.state).toBe("backlog");
  on = true; await r.release();
  expect(await until(() => pulled(r.board.get(reserved.id)))).toBe(true);
});

test("only an explicitly reserved card: an unreserved card, and one reserved for another peer, are never pulled", async () => {
  const r = await rig(true);
  const unreserved = r.card({ priority: 0 }), other = r.card({ reserved: "kimi", priority: 0 });
  await r.release(); await settle();
  expect(r.board.get(unreserved.id)!.state).toBe("backlog");
  expect(r.board.get(other.id)!.state).toBe("backlog");
});

test("never auto-pulled: PII, pinned, dependency-blocked and a frozen release; the next eligible card is the one pulled", async () => {
  const r = await rig(true);
  const frozen = r.board.newRelease("train", "goal", 1);
  for (const state of ["active", "frozen"] as const) r.board.updateRelease(frozen.id, { state }, r.board.release(frozen.id)!.revision);
  const pii = r.card({ reserved: "codex", priority: 0, signals: ["pii_path"] });
  const pinned = r.card({ reserved: "codex", priority: 0, pinned: true });
  const blocked = r.card({ reserved: "codex", priority: 0, deps: [9999] });
  const frozenCard = r.card({ reserved: "codex", priority: 0, release: frozen.id });
  const eligible = r.card({ reserved: "codex", priority: 3 });
  await r.release();
  expect(await until(() => pulled(r.board.get(eligible.id)))).toBe(true);
  for (const excluded of [pii, pinned, blocked, frozenCard]) expect([excluded.id, r.board.get(excluded.id)!.state, r.board.get(excluded.id)!.owner ?? null]).toEqual([excluded.id, "backlog", null]);
});

test("when only an excluded card is reserved, nothing is pulled and nothing throws", async () => {
  const r = await rig(true);
  const pii = r.card({ reserved: "codex", priority: 0, signals: ["pii_path"] }), pinned = r.card({ reserved: "codex", priority: 0, pinned: true });
  await r.release(); await settle();
  expect([r.board.get(pii.id)!.state, r.board.get(pinned.id)!.state]).toEqual(["backlog", "backlog"]);
});

test("the planner of record is the card's own: a card bound to pi is pulled for pi, and one whose planner left the role is pulled for the remaining holder, never for the departed one", async () => {
  const r = await rig(true);
  const bound = r.card({ reserved: "codex", priority: 1, planner: "pi" });
  await r.release();
  expect(await until(() => pulled(r.board.get(bound.id)))).toBe(true);
  expect(pullEntry(r.board.get(bound.id)!)).toMatchObject({ by: "hub", planner: "pi", note: expect.stringContaining("hub acted for planner pi") });

  const gone = await rig(true); // a fresh hub: the first pull above took codex's only slot
  const left = gone.card({ reserved: "codex", priority: 1, planner: "pi" });
  delete (gone.tasks as unknown as { d: { roles: Record<string, string[]> } }).d.roles.pi;
  await gone.release();
  expect(await until(() => pulled(gone.board.get(left.id)))).toBe(true);
  const entry = pullEntry(gone.board.get(left.id)!)!;
  expect(entry.by).toBe("hub");
  expect(entry.note).toContain("hub acted for planner claude");
  expect(entry.note).not.toContain("planner pi");
});

test("a card whose WIP is full is not pulled: the existing planner WIP check refuses it, and a notice says why", async () => {
  const r = await rig(true);
  const busy = r.inReview(); void busy; // codex stays at WIP 1 after the release below
  const reserved = r.card({ reserved: "codex", priority: 1 });
  await r.release(); await settle();
  expect(r.tasks.wip("codex")).toBeGreaterThanOrEqual(1);
  expect(r.board.get(reserved.id)!.state).toBe("backlog");
  expect(r.notices.join("\n")).toContain("auto_pull for codex refused");
  expect(r.notices.join("\n")).not.toContain("PRIVATE_TASK_DETAIL");
});

test("two releases at once pull two different cards, never the same one twice", async () => {
  const r = await rig(true);
  const a = r.card({ reserved: "codex", priority: 1 }), b = r.card({ reserved: "kimi", priority: 1 });
  const kimiTask = (() => { let t = r.card(); t = r.board.update(t.id, USER, "backlog pulled", { state: "proposed", owner: "kimi", reviewer: USER }); t = r.board.update(t.id, "kimi", "accepted", { state: "in_progress" }); return r.board.update(t.id, "kimi", "done", { state: "in_review" }); })();
  const codexTask = r.inReview();
  await Promise.all([r.tasks.review(USER, codexTask.id, "approved"), r.tasks.review(USER, kimiTask.id, "approved")]);
  expect(await until(() => pulled(r.board.get(a.id)) && pulled(r.board.get(b.id)))).toBe(true);
  expect([r.board.get(a.id)!.owner, r.board.get(b.id)!.owner]).toEqual(["codex", "kimi"]);
  expect(r.board.get(a.id)!.history.filter(entry => entry.event === "backlog pulled")).toHaveLength(1);
});

test("a held or recovering hub pulls nothing", async () => {
  const r = await rig(true);
  (r.tasks as unknown as { d: { sweepHeld?: () => boolean } }).d.sweepHeld = () => true;
  const reserved = r.card({ reserved: "codex", priority: 1 });
  await r.release(); await settle();
  expect(r.board.get(reserved.id)!.state).toBe("backlog");
});

test("hub-only: a peer cannot ask pullPlanned to act on a planner's behalf, and a planner's own pull still records the planner", async () => {
  const r = await rig(true);
  const reserved = r.card({ reserved: "codex", priority: 1 });
  const revision = r.board.get(reserved.id)!.planningRevision ?? 0;
  await expect(r.tasks.pullPlanned("codex", { id: reserved.id, revision, reason: "x" }, { onBehalfOf: "claude" })).rejects.toThrow("only the hub pulls on a planner's behalf");
  await expect(r.tasks.pullPlanned("kimi", { id: reserved.id, revision, reason: "x" })).rejects.toThrow("planning requires");
  const own = await r.tasks.pullPlanned("claude", { id: reserved.id, revision, reason: "planner pull" });
  expect(pullEntry(own)?.by).toBe("claude");
});
