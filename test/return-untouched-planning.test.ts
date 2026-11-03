import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";

// #1154: returning untouched work can clear its reservation before the freed slot triggers auto-pull.
class Quiet extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver() {}
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-return-planning-"));
  const board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const roles = { claude: ["planner"], codex: ["implementer"] };
  for (const id of Object.keys(roles)) { const peer = new Quiet(id); bus.add(peer); await peer.start(); }
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", roles, routing: () => loadRouting(cwd), autoPull: () => true, notify: () => {} });
  const staged = board.propose("claude", { title: "Wait for the person's live receipt", class: "implement", backlog: true, planner: "claude", reserved: "codex" });
  const offered = await tasks.pullPlanned("claude", { id: staged.id, revision: staged.planningRevision ?? 0, reason: "offer the reserved receipt" });
  const accepted = tasks.accept("codex", offered.id);
  expect(accepted).toMatchObject({ state: "in_progress", owner: "codex", reserved: "codex" });
  expect(tasks.wip("codex")).toBe(1);
  return { board, tasks, accepted };
}

/** The actual serialized auto-pull chain is the barrier; elapsed time is not completion evidence. */
async function drained(tasks: Tasks) {
  await (tasks as unknown as { autoPulls: Promise<void> }).autoPulls;
  expect(tasks.autoPullsPending()).toBe(0);
}

test("#1154 returning an untouched accepted card with reserved null prevents its immediate auto-repull", async () => {
  const r = await fixture();
  // A variable keeps this red test type-correct before Tasks learns the optional field.
  const input = { id: r.accepted.id, revision: r.accepted.planningRevision ?? 0, reason: "park until the person is present", fields: { reserved: null } };
  await r.tasks.returnUntouchedToBacklog("claude", input);
  await drained(r.tasks);
  const saved = r.board.get(r.accepted.id)!;
  expect(saved).toMatchObject({ state: "backlog", reserved: null, owner: null, reviewer: null });
  expect(saved.history.filter(entry => entry.event === "backlog pulled")).toHaveLength(1);
  expect(r.tasks.wip("codex")).toBe(0);
});

test("#1154 omitting return fields preserves the reservation and existing immediate auto-repull behavior", async () => {
  const r = await fixture();
  await r.tasks.returnUntouchedToBacklog("claude", { id: r.accepted.id, revision: r.accepted.planningRevision ?? 0, reason: "return without changing the plan" });
  await drained(r.tasks);
  const saved = r.board.get(r.accepted.id)!;
  expect(saved).toMatchObject({ state: "proposed", reserved: "codex", owner: "codex" });
  expect(saved.history.filter(entry => entry.event === "backlog pulled")).toHaveLength(2);
  expect(saved.history.findLast(entry => entry.event === "backlog pulled")).toMatchObject({ by: "hub", note: expect.stringContaining("auto_pull: capacity released for codex") });
  expect(r.tasks.wip("codex")).toBe(1);
});
