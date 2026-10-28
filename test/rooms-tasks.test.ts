import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { USER, type Envelope } from "../src/hub/envelope.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { assign, isRemotePeerId, parseRouting, plannerWalk } from "../src/hub/routing.ts";

const remote = "codex@hub-remote";
const roots: string[] = [], resources: { board: Board; bus: Bus; tasks: Tasks }[] = [];
afterEach(() => {
  for (const resource of resources.splice(0)) { resource.tasks.stopCiWatchers(); resource.bus.closeJournal(); resource.board.close(); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
class LocalPeer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) {}
}
class FakeRemotePeer extends LocalPeer { readonly remoteRoom = "fixture-room"; }
async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-rooms-tasks-")); roots.push(cwd);
  const board = new Board(join(cwd, "board.db")), bus = new Bus({ batchMs: 0, deliveryHeld: () => true });
  for (const peer of [new LocalPeer("codex"), new LocalPeer("claude"), new FakeRemotePeer(remote)]) { bus.add(peer); await peer.start(); }
  const roles: Record<string, string[]> = { [remote]: ["planner", "reviewer", "implementer", "conductor"] };
  const routing = parseRouting('[local]\nfixed_model="fixture"\n[classes.implement]\npeers=["codex"]\n[classes.review]\npeers=["claude"]\n');
  let authorities = 0;
  const tasks = new Tasks({ board, bus, cwd, project: "rooms-fixture", routing: () => routing, roles, notify: () => {}, requestAuthority: () => { authorities++; return () => undefined; } });
  resources.push({ board, bus, tasks });
  return { board, bus, tasks, roles, get authorities() { return authorities; } };
}

test("remote namespace cannot acquire local owner, reviewer or planner authority from routing data", () => {
  for (const peer of [remote, "user@hub-remote", "@", "invalid@@label"]) expect(isRemotePeerId(peer)).toBe(true);
  for (const peer of ["codex", "user", "hub", undefined]) expect(isRemotePeerId(peer)).toBe(false);
  const routing = parseRouting(`[local]\nfixed_model="fixture"\n[classes.implement]\npeers=["${remote}"]\n[classes.review]\npeers=["${remote}"]\n`);
  const task = { id: 1, class: "implement" as const, signals: [] as string[] };
  const states = { [remote]: "idle", codex: "idle", claude: "idle" } as const;
  const assigned = assign(task, states, routing, { roles: { [remote]: ["reviewer", "planner"] }, planners: [remote], keptPlanner: remote });
  expect(assigned.owner).toBeUndefined(); expect(assigned.reviewer).toBeUndefined(); expect(assigned.planner).toBeUndefined();
  expect(assigned.refusals).toContainEqual({ peer: remote, role: "owner", code: "policy", reason: "remote peers cannot hold local roles" });
  expect(assigned.refusals).toContainEqual({ peer: remote, role: "reviewer", code: "policy", reason: "remote peers cannot hold local roles" });
  let capabilityReads = 0;
  const denied = assign(task, states, routing, { candidates: [remote], namedOwner: remote, namedReviewer: remote,
    adapterCatalog: { definitionOf: () => { capabilityReads++; throw new Error("remote must be refused before adapter capability lookup"); } } as any });
  expect(denied.owner).toBeUndefined(); expect(denied.reviewer).toBeUndefined(); expect(capabilityReads).toBe(0);
  expect(plannerWalk({ planners: [remote, "claude"], named: remote, seed: 0, pii: false, blocked: () => undefined }).planner).toBeUndefined();
  expect(plannerWalk({ planners: [remote, "claude"], kept: remote, seed: 0, pii: false, blocked: () => undefined })).toMatchObject({ planner: "claude", reason: "rotation" });
  expect(plannerWalk({ planners: [remote], kept: remote, named: remote, seed: 0, pii: false, blocked: () => undefined }).planner).toBeUndefined();
  const instance = assign(task, states, routing, { instances: { [remote]: { kind: "claude" } }, roles: { [remote]: ["implementer", "reviewer", "planner"] }, ownerIsolation: { [remote]: true }, candidates: [remote], namedOwner: remote, namedReviewer: remote, planners: [remote], namedPlanner: remote });
  expect(instance.owner).toBeUndefined(); expect(instance.reviewer).toBeUndefined(); expect(instance.planner).toBeUndefined();
});

test("remote actors cannot propose or claim work and remote targets are refused before the first board write", async () => {
  const f = await fixture(), revision = f.board.statusRevision();
  for (const by of [remote, "user@hub-remote", "invalid@@label"]) {
    await expect(f.tasks.propose(by, { title: "private task title must not reach a remote actor", class: "implement" })).rejects.toThrow("remote peers have no local task authority");
    await expect(f.tasks.propose(by, { title: "claim", class: "implement", owner: by })).rejects.toThrow("remote peers have no local task authority");
  }
  await expect(f.tasks.propose(USER, { title: "remote target", class: "implement", owner: remote })).rejects.toThrow("remote peers have no local task authority");
  await expect(f.tasks.propose(USER, { title: "remote backlog target", class: "implement", owner: remote, backlog: true })).rejects.toThrow("remote peers have no local task authority");
  expect(f.board.list()).toHaveLength(0); expect(f.board.statusRevision()).toBe(revision);
  expect(f.bus.queued(remote)).toBe(0);
});

test("even legacy remote owner and reviewer rows grant no Tasks mutation authority", async () => {
  const f = await fixture();
  // Fixture-owned legacy rows simulate state predating this boundary; production ownership changes remain Tasks-only.
  const proposed = f.board.propose(USER, { title: "legacy proposed", class: "implement" });
  const owner = f.board.update(proposed.id, USER, "assigned", { owner: remote });
  const running = f.board.propose(USER, { title: "legacy running", class: "implement" });
  f.board.update(running.id, USER, "accepted", { owner: remote, state: "in_progress" });
  const review = f.board.propose(USER, { title: "legacy review", class: "implement" });
  f.board.update(review.id, USER, "done", { owner: "codex", reviewer: remote, state: "in_review" });
  const backlog = f.board.propose(USER, { title: "legacy planner", class: "implement", backlog: true, planner: remote });
  const before = f.board.list(), revision = f.board.statusRevision(), authorityCalls = f.authorities;
  const operations: (() => unknown | Promise<unknown>)[] = [
    () => f.tasks.accept(remote, owner.id),
    () => f.tasks.acceptReviewed(remote, owner.id),
    () => f.tasks.done(remote, running.id, "result"),
    () => f.tasks.review(remote, review.id, "approved", "verdict"),
    () => f.tasks.decline(remote, owner.id, "decline"),
    () => f.tasks.escalate(remote, running.id),
    () => f.tasks.assignTo(owner.id, "codex", remote),
    () => f.tasks.assignTo(owner.id, "claude", remote, true, "reviewer"),
    () => f.tasks.planBacklog(remote, { id: backlog.id, revision: 0, fields: { rank: 1 }, reason: "plan" }),
    () => f.tasks.recordPlanReview(remote, backlog.id, { revision: 0, reason: "plan reviewed" }),
    () => f.tasks.pullPlanned(remote, { id: backlog.id, revision: 0, reason: "pull" }),
    () => f.tasks.recordSdlc(remote, running.id, { stage: "build" }),
    () => f.tasks.recordLifecycle(remote, running.id, { stage: "build" }),
    () => f.tasks.backlogList(remote),
    () => f.tasks.groomingDigest(remote),
    () => f.tasks.sdlcMetrics(remote),
    () => f.tasks.remember(remote, { text: "no remote memory authority" }),
  ];
  for (const run of operations) {
    await expect(async () => await run()).rejects.toThrow("remote peers have no local task authority");
    expect(f.board.statusRevision()).toBe(revision); expect(f.board.list()).toEqual(before);
  }
  expect(f.tasks.isConfiguredPlanner(remote)).toBe(false);
  expect(f.tasks.taskPlanner({ planner: remote })).not.toContain(remote);
  expect(f.authorities).toBe(authorityCalls); expect(f.bus.queued(remote)).toBe(0);
});

test("a person cannot name a remote owner, reviewer or planner, even when remote roles are configured", async () => {
  const f = await fixture(), task = f.board.propose(USER, { title: "local task", class: "implement" }), revision = f.board.statusRevision();
  for (const role of ["owner", "reviewer", "planner"] as const) {
    await expect(f.tasks.assignTo(task.id, remote, USER, true, role)).rejects.toThrow("remote peers have no local task authority");
    expect(f.board.statusRevision()).toBe(revision);
  }
  expect(f.board.get(task.id)).toEqual(task);
  const backlog = f.board.propose(USER, { title: "reserved target", class: "implement", backlog: true }), before = f.board.statusRevision();
  await expect(f.tasks.planBacklog(USER, { id: backlog.id, revision: 0, fields: { reserved: remote }, reason: "remote reservation" })).rejects.toThrow("remote peers have no local task authority");
  expect(f.board.statusRevision()).toBe(before);
  const local = await f.tasks.propose(USER, { title: "ordinary local assignment", class: "implement" });
  expect(local.owner).toBe("codex"); expect(local.reviewer).toBe("claude"); expect(local.planner).not.toBe(remote);
});
