import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { USER, type Envelope } from "../src/hub/envelope.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";

// #531: a capacity-only decline is not a lasting refusal, and a planner pull that finds no owner names the cause.
class Peer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) {}
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
/** codex is the only implementer here, as on #229; claude plans. */
async function rig(piiPattern?: string) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-capacity-decline-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 });
  const capacity: Record<string, number> = { codex: 1, claude: 1 }, routing = loadRouting(dir);
  const notices: string[] = [];
  const tasks = new Tasks({ board, bus, cwd: dir, project: "capacity", notify: (line: string) => notices.push(line), routing: () => ({ ...routing, ...(piiPattern ? { signals: { ...routing.signals, pii_patterns: [piiPattern] }, constraints: { ...routing.constraints, pii: "local_only" as const } } : {}), classes: { ...routing.classes, implement: { ...routing.classes.implement, peers: ["codex"] } } }), roles: { claude: ["planner"] }, wipLimit: (peer: string) => capacity[peer] ?? 1 } as never);
  for (const id of ["codex", "claude"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  return { tasks, board, bus, capacity, notices };
}
/** A task a planner pulled to codex, which codex then holds: the state #229 was in when codex declined it. */
async function pulledToCodex(r: Awaited<ReturnType<typeof rig>>, title = "capacity case") {
  const task = await r.tasks.propose(USER, { title, class: "implement", backlog: true });
  await r.tasks.pullPlanned("claude", { id: task.id, revision: 0, reason: "ready" }); await r.tasks.releaseReady();
  expect(r.board.get(task.id)?.owner).toBe("codex");
  return task;
}

test("a capacity decline excludes the owner only from its own reroute, and a later pull routes the task back to it (D1)", async () => {
  const r = await rig();
  const task = await pulledToCodex(r);
  const back = await r.tasks.decline("codex", task.id, "no capacity now; stage it after the current task", true);
  expect(back.history.findLast(h => h.event === "declined")).toMatchObject({ by: "codex", from: "codex", capacity: true });
  expect(r.board.get(task.id)).toMatchObject({ owner: null }); // that move's own reroute skipped codex, and nobody else can take it
  // The planner returns it to the backlog, reserved for codex (as the planner did on #229); capacity then exists again.
  const returned = await r.tasks.returnUntouchedToBacklog("claude", { id: task.id, revision: back.planningRevision ?? 0, reason: "staged after the current task" });
  await r.tasks.planBacklog("claude", { id: task.id, revision: returned.planningRevision ?? 0, fields: { reserved: "codex" }, reason: "codex asked to stage it" });
  const pulled = await r.tasks.pullPlanned("claude", { id: task.id, revision: r.board.get(task.id)!.planningRevision ?? 0, reason: "capacity exists now" });
  expect(pulled).toMatchObject({ state: "proposed", reserved: "codex" });
  await r.tasks.releaseReady();
  expect(r.board.get(task.id)?.owner).toBe("codex");
});

test("a plain decline stays a lasting refusal, and the refusal names the exclusion and the peer, not WIP (D1, D2)", async () => {
  const r = await rig();
  const task = await pulledToCodex(r);
  const back = await r.tasks.decline("codex", task.id, "not mine");
  expect(back.history.findLast(h => h.event === "declined")?.capacity).toBeUndefined();
  const returned = await r.tasks.returnUntouchedToBacklog("claude", { id: task.id, revision: back.planningRevision ?? 0, reason: "back to the backlog" });
  const refusal = await r.tasks.pullPlanned("claude", { id: task.id, revision: returned.planningRevision ?? 0, reason: "try again" }).then(() => "", (error: Error) => error.message);
  expect(refusal).toContain("declined"); expect(refusal).toContain("codex"); expect(refusal).not.toContain("WIP");
});

test("an older declined row without the capacity field keeps its meaning as a refusal (D1)", async () => {
  const r = await rig();
  const task = await pulledToCodex(r);
  const back = await r.tasks.decline("codex", task.id, "old style");
  const row = r.board.get(back.id)!.history.findLast(h => h.event === "declined")!;
  expect("capacity" in row).toBe(false); // exactly what a pre-0.12.40 row looks like
  const returned = await r.tasks.returnUntouchedToBacklog("claude", { id: task.id, revision: back.planningRevision ?? 0, reason: "back" });
  await expect(r.tasks.pullPlanned("claude", { id: task.id, revision: returned.planningRevision ?? 0, reason: "again" })).rejects.toThrow("declined");
});

test("a WIP-full refusal names the peer and its wip/limit (D2)", async () => {
  const r = await rig();
  const first = await pulledToCodex(r, "first");
  const second = await r.tasks.propose(USER, { title: "second", class: "implement", backlog: true });
  const refusal = await r.tasks.pullPlanned("claude", { id: second.id, revision: 0, reason: "next" }).then(() => "", (error: Error) => error.message);
  expect(first.id).not.toBe(second.id);
  expect(refusal).toContain("codex"); expect(refusal).toContain("WIP full"); expect(refusal).toContain("1/1");
});

test("a held queue and needs_review each get their own refusal text (D2)", async () => {
  const r = await rig();
  const task = await r.tasks.propose(USER, { title: "held case", class: "implement", backlog: true });
  const original = r.bus.queueSummary.bind(r.bus);
  r.bus.queueSummary = ((peer: string) => peer === "codex" ? { ...original(peer), heldBy: "delivery-1" } : original(peer)) as never;
  const held = await r.tasks.pullPlanned("claude", { id: task.id, revision: 0, reason: "ready" }).then(() => "", (error: Error) => error.message);
  expect(held).toContain("codex"); expect(held).toContain("held queue"); expect(held).not.toContain("WIP full");
  r.bus.queueSummary = ((peer: string) => peer === "codex" ? { ...original(peer), needsReview: 2 } : original(peer)) as never;
  const review = await r.tasks.pullPlanned("claude", { id: task.id, revision: 0, reason: "ready" }).then(() => "", (error: Error) => error.message);
  expect(review).toContain("codex"); expect(review).toContain("needs_review"); expect(review).not.toContain("held queue");
});

test("hub_backlog_plan refuses a reservation for a peer that declined the task for good, and allows a capacity decliner (D3)", async () => {
  const r = await rig();
  const plain = await pulledToCodex(r, "plain");
  const back = await r.tasks.decline("codex", plain.id, "not mine");
  const returned = await r.tasks.returnUntouchedToBacklog("claude", { id: plain.id, revision: back.planningRevision ?? 0, reason: "back" });
  const refused = await r.tasks.planBacklog("claude", { id: plain.id, revision: returned.planningRevision ?? 0, fields: { reserved: "codex" }, reason: "reserve codex" }).then(() => "", (error: Error) => error.message);
  expect(refused).toContain("codex"); expect(refused).toContain("excluded"); expect(refused).toContain("ahub task assign");
  const r2 = await rig();
  const soft = await pulledToCodex(r2, "soft");
  const back2 = await r2.tasks.decline("codex", soft.id, "capacity", true);
  const returned2 = await r2.tasks.returnUntouchedToBacklog("claude", { id: soft.id, revision: back2.planningRevision ?? 0, reason: "back" });
  const planned = await r2.tasks.planBacklog("claude", { id: soft.id, revision: returned2.planningRevision ?? 0, fields: { reserved: "codex" }, reason: "reserve codex" });
  expect(planned.reserved).toBe("codex");
});

test("the new refusal texts carry peers and counts only, never task text, and a capacity decline notice shows no PII reason (PII)", async () => {
  const r = await rig();
  await pulledToCodex(r, "first");
  // A task the routing marks private: its title and detail are the markers, and every text this change emits must omit them.
  const secret = await r.tasks.propose(USER, { title: "PRIVATE-TITLE-MARKER", detail: "PRIVATE-DETAIL-MARKER", class: "implement", backlog: true });
  const refusal = await r.tasks.pullPlanned("claude", { id: secret.id, revision: 0, reason: "next" }).then(() => "", (error: Error) => error.message);
  expect(refusal).toContain("WIP full"); expect(refusal).not.toContain("PRIVATE-");
  const plain = await r.tasks.propose(USER, { title: "PRIVATE-TITLE-MARKER-2", class: "implement", backlog: true });
  const exclusion = r.tasks.plannerRefusal(plain);
  expect(exclusion).not.toContain("PRIVATE-"); expect(exclusion).toMatch(/^no peer can take the planner pull: /);
  // A PII task (the project's own pattern matches it): the decline notice never carries the reason, capacity or not.
  const piiRig = await rig("PRIVATE-REASON-PATTERN");
  const pii = await piiRig.tasks.propose(USER, { title: "PRIVATE-REASON-PATTERN case", class: "implement", owner: "codex" });
  piiRig.notices.length = 0;
  await piiRig.tasks.decline("codex", pii.id, "PRIVATE-REASON-PATTERN why", true).catch(() => {});
  expect(JSON.stringify(piiRig.notices)).not.toContain("PRIVATE-REASON-PATTERN");
});

test("route explain, the stall view and assignment agree: a capacity decline is not excluded, a plain one is (D1, assign stays pure)", async () => {
  const soft = await rig();
  const a = await pulledToCodex(soft, "soft");
  const back = await soft.tasks.decline("codex", a.id, "capacity", true);
  expect(soft.tasks.explain(back.id).join("\n")).not.toContain("excluded (declined or replaced)");
  const hard = await rig();
  const b = await pulledToCodex(hard, "hard");
  const gone = await hard.tasks.decline("codex", b.id, "not mine");
  expect(hard.tasks.explain(gone.id).join("\n")).toContain("excluded (declined or replaced)");
  // The stall view reports the lasting exclusion with its own code, never WIP.
  await hard.tasks.releaseReady();
  const stall = hard.tasks.stalled().find(row => row.task === gone.id);
  if (stall) expect(JSON.stringify(stall.cause)).toContain("excluded");
});
