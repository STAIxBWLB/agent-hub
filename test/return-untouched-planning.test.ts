import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Task } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { loadRouting, type PeerCapabilities } from "../src/hub/routing.ts";

// #1154: returning untouched work can clear its reservation before the freed slot triggers auto-pull.
class Quiet extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver() {}
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

async function fixture(autoPull = true) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-return-planning-"));
  const board = new Board(join(cwd, "hub.db")), offRoster = new Set<string>(), bus = new Bus({ batchMs: 0, rostered: peer => !offRoster.has(peer) });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const roles = { claude: ["planner"], codex: ["implementer"], kimi: ["implementer"] };
  for (const id of Object.keys(roles)) { const peer = new Quiet(id); bus.add(peer); await peer.start(); }
  const screen: { run?: () => void | Promise<void> } = {}, capabilities: Record<string, PeerCapabilities> = {};
  const deps: TasksDeps = { cwd, board, bus, project: "fixture", roles, capabilities: () => capabilities,
    routing: () => { const routing = loadRouting(cwd); return screen.run ? { ...routing, signals: { ...routing.signals, pii_screen: "local" as const } } : routing; },
    piiScreen: async () => { await screen.run?.(); return { label: "clear" as const, ms: 0 }; },
    autoPull: () => autoPull, notify: () => {} };
  // Declared capability facts keep the initial owner eligible; tests may revoke the new reservation's capability later.
  for (const id of Object.keys(roles)) capabilities[id] = { tests: true, spec: true, network: true, worktree: true };
  const tasks = new Tasks(deps);
  const staged = board.propose("claude", { title: "Wait for the person's live receipt", class: "implement", backlog: true, planner: "claude", reserved: "codex" });
  const offered = await tasks.pullPlanned("claude", { id: staged.id, revision: staged.planningRevision ?? 0, reason: "offer the reserved receipt" });
  const accepted = tasks.accept("codex", offered.id);
  expect(accepted).toMatchObject({ state: "in_progress", owner: "codex", reserved: "codex" });
  expect(tasks.wip("codex")).toBe(1);
  return { board, tasks, accepted, roles, capabilities, screen, deps, offRoster };
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

test("#1154 the return publishes one saved state with reservation revision and previous value already present", async () => {
  const r = await fixture(false), observations: Task[] = [], before = r.board.get(r.accepted.id)!;
  r.board.onChange = (task, entry) => { if (task.id === before.id) observations.push(structuredClone(r.board.get(task.id)!)); };
  const saved = await r.tasks.returnUntouchedToBacklog("claude", { id: before.id, revision: before.planningRevision!, reason: "park atomically", fields: { reserved: null } });
  expect(observations).toHaveLength(1);
  expect(observations[0]).toEqual(saved);
  expect(saved).toMatchObject({ state: "backlog", owner: null, reviewer: null, reserved: null, planningRevision: before.planningRevision! + 1 });
  expect(saved.history).toHaveLength(before.history.length + 1);
  expect(saved.history.at(-1)).toMatchObject({ by: "claude", event: "backlog returned untouched", planning: { revision: before.planningRevision! + 1, fields: ["reserved"], previous: { reserved: "codex" } } });
  await expect(r.tasks.planBacklog("claude", { id: before.id, revision: before.planningRevision!, reason: "stale plan", fields: { reserved: "kimi" } })).rejects.toThrow("planning revision changed");
  expect(r.board.get(saved.id)).toEqual(saved);
});

test("#1154 omitted fields leave the planning revision and history metadata unchanged", async () => {
  const r = await fixture(false), before = r.board.get(r.accepted.id)!;
  const saved = await r.tasks.returnUntouchedToBacklog("claude", { id: before.id, revision: before.planningRevision!, reason: "return only" });
  expect(saved.planningRevision).toBe(before.planningRevision);
  expect(saved.reserved).toBe(before.reserved);
  expect(saved.history.at(-1)).not.toHaveProperty("planning");
});

test("#1154 clearing this reservation lets the next eligible card take the freed slot", async () => {
  const r = await fixture();
  const next = r.board.propose("claude", { title: "Independent ready card", class: "implement", backlog: true, planner: "claude", reserved: "codex" });
  await r.tasks.returnUntouchedToBacklog("claude", { id: r.accepted.id, revision: r.accepted.planningRevision!, reason: "park this card", fields: { reserved: null } });
  await drained(r.tasks);
  expect(r.board.get(r.accepted.id)).toMatchObject({ state: "backlog", reserved: null, owner: null });
  expect(r.board.get(next.id)).toMatchObject({ state: "proposed", owner: "codex", reserved: "codex" });
  expect(r.tasks.wip("codex")).toBe(1);
});

test("#1154 normalized reservations set by the person remain protected on later planner edits", async () => {
  const r = await fixture(false), before = r.board.get(r.accepted.id)!;
  const saved = await r.tasks.returnUntouchedToBacklog("user", { id: before.id, revision: before.planningRevision!, reason: "reserve for a different owner", fields: { reserved: " KIMI " } });
  expect(saved.reserved).toBe("kimi");
  expect(saved.history.at(-1)).toMatchObject({ by: "user", planning: { fields: ["reserved"], previous: { reserved: "codex" } } });
  await expect(r.tasks.planBacklog("claude", { id: saved.id, revision: saved.planningRevision!, reason: "override person", fields: { reserved: null } })).rejects.toThrow("a person's reservation is retained");
  expect(r.board.get(saved.id)).toEqual(saved);
});

for (const fields of [null, [], "reserved", { reserved: 1 }, { reserved: undefined }, { reserved: "user" }, { reserved: "hub" }, { rank: 1 }, { deps: [] }, { pinned: false }, { unknown: true }]) {
  test(`#1154 malformed or unsupported return fields refuse without a state or history write: ${JSON.stringify(fields)}`, async () => {
    const r = await fixture(false), before = r.board.get(r.accepted.id);
    await expect(r.tasks.returnUntouchedToBacklog("claude", { id: r.accepted.id, revision: r.accepted.planningRevision!, reason: "invalid planning input", fields })).rejects.toThrow();
    expect(r.board.get(r.accepted.id)).toEqual(before);
    expect(r.tasks.autoPullsPending()).toBe(0);
  });
}

test("#1154 stale return revisions cannot clear a reservation or release the owner slot", async () => {
  const r = await fixture(), before = r.board.get(r.accepted.id)!;
  await expect(r.tasks.returnUntouchedToBacklog("claude", { id: before.id, revision: before.planningRevision! - 1, reason: "stale return", fields: { reserved: null } })).rejects.toThrow("planning revision changed");
  expect(r.board.get(before.id)).toEqual(before);
  expect(r.tasks.wip("codex")).toBe(1);
  expect(r.tasks.autoPullsPending()).toBe(0);
});

for (const timing of ["before", "during screen"] as const) for (const guard of ["person", "roster", "capability", "planner"] as const) {
  test(`#1154 return reservation guards hold ${timing}: ${guard}`, async () => {
    const r = await fixture(false);
    const revoke = () => {
      if (guard === "person") r.board.update(r.accepted.id, "user", "reserved", { reserved: "codex" });
      if (guard === "roster") r.offRoster.add("kimi");
      if (guard === "capability") r.capabilities.kimi = { tests: false, spec: false };
      if (guard === "planner") r.roles.claude = [];
    };
    let expected: Task;
    if (timing === "before") { revoke(); expected = r.board.get(r.accepted.id)!; }
    else { expected = r.board.get(r.accepted.id)!; r.screen.run = () => { revoke(); expected = r.board.get(r.accepted.id)!; }; }
    const message = guard === "person" ? "a person's reservation is retained" : guard === "roster" ? "off roster" : guard === "capability" ? "cannot assign kimi" : "planner";
    await expect(r.tasks.returnUntouchedToBacklog("claude", { id: r.accepted.id, revision: r.accepted.planningRevision!, reason: "screened return", fields: { reserved: "kimi" } })).rejects.toThrow(message);
    expect(r.board.get(r.accepted.id)).toEqual(expected);
    expect(r.tasks.wip("codex")).toBe(1);
    expect(r.tasks.autoPullsPending()).toBe(0);
  });
}

test("#1154 unsupported and excluded reservation targets refuse before return", async () => {
  const r = await fixture(false);
  let before = r.board.get(r.accepted.id)!;
  await expect(r.tasks.returnUntouchedToBacklog("claude", { id: before.id, revision: before.planningRevision!, reason: "unknown owner", fields: { reserved: "unknown-peer" } })).rejects.toThrow("supported or configured peer");
  expect(r.board.get(before.id)).toEqual(before);
  r.board.update(before.id, "kimi", "declined", {}, "permanent refusal");
  before = r.board.get(before.id)!;
  await expect(r.tasks.returnUntouchedToBacklog("claude", { id: before.id, revision: before.planningRevision!, reason: "excluded owner", fields: { reserved: "kimi" } })).rejects.toThrow("excluded from this task");
  expect(r.board.get(before.id)).toEqual(before);
});

test("#1154 a planning revision changed during screening refuses the return before its write", async () => {
  const r = await fixture(false);
  let expected = r.board.get(r.accepted.id)!;
  r.screen.run = () => { expected = r.board.plan(r.accepted.id, "user", { reserved: "kimi" }, r.accepted.planningRevision!, "person changed the plan"); };
  await expect(r.tasks.returnUntouchedToBacklog("claude", { id: r.accepted.id, revision: r.accepted.planningRevision!, reason: "screening races planning", fields: { reserved: null } })).rejects.toThrow("planning revision changed");
  expect(r.board.get(r.accepted.id)).toEqual(expected);
  expect(r.tasks.autoPullsPending()).toBe(0);
});

for (const guard of ["pinned", "frozen", "shipped", "branch"] as const) {
  test(`#1154 explicit reservation fields preserve the untouched-return ${guard} guard`, async () => {
    const r = await fixture(false);
    if (guard === "pinned") r.board.plan(r.accepted.id, "user", { pinned: true }, r.accepted.planningRevision!, "person pinned it");
    else if (guard === "branch") r.board.update(r.accepted.id, "codex", "branch recorded", { refs: { branch: "feat/started-work" } });
    else {
      const release = r.board.newRelease("fixture train", "goal", 1);
      r.board.plan(r.accepted.id, "user", { release: release.id }, r.accepted.planningRevision!, "release scope");
      for (const state of ["active", "frozen", ...(guard === "shipped" ? ["shipped" as const] : [])] as const) r.board.updateRelease(release.id, { state }, r.board.release(release.id)!.revision);
    }
    const before = r.board.get(r.accepted.id)!;
    await expect(r.tasks.returnUntouchedToBacklog("claude", { id: before.id, revision: before.planningRevision!, reason: "cannot bypass existing guards", fields: { reserved: null } })).rejects.toThrow(guard === "pinned" ? "pinned work" : guard === "branch" ? "execution evidence" : "settled or frozen");
    expect(r.board.get(before.id)).toEqual(before);
    expect(r.tasks.autoPullsPending()).toBe(0);
  });
}

test("#1154 Board keeps the narrow untouched-return predicate and stale flow fence with reservation metadata", async () => {
  const r = await fixture(false), before = r.board.get(r.accepted.id)!;
  const patch = { state: "backlog" as const, owner: null, reviewer: null, reserved: null };
  expect(() => r.board.update(before.id, "claude", "backlog returned untouched", patch, "missing flow fence")).toThrow();
  expect(() => r.board.update(before.id, "claude", "backlog returned untouched", patch, "stale flow fence", {}, before.history.length - 1)).toThrow("flow revision changed");
  expect(() => r.board.update(before.id, "claude", "backlog returned untouched", patch, "", {}, before.history.length)).toThrow();
  expect(() => r.board.update(before.id, "claude", "backlog returned", patch, "wrong event", {}, before.history.length)).toThrow();
  expect(r.board.get(before.id)).toEqual(before);
});
