import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Task, type TaskClass, type TaskRefs } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { USER, type Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { DEFAULT_TASK_SWEEP } from "../src/hub/task-sweep.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { validateRawConfig, configApply } from "../src/hub/config-apply.ts";
import { settingDef } from "../src/hub/settings.ts";

class Peer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() {}
  async deliver(_envelopes: Envelope[]) {}
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const NO_WRITES = "no writes recorded since acceptance";

async function fixture(options: { limit?: number; evidence?: boolean; absentEvidence?: boolean; costs?: boolean; onAccept?: (task: Task) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ahub-owner-writes-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const board = new Board(join(root, "hub.db"));
  cleanup.push(() => board.close());
  const bus = new Bus({ batchMs: 0 });
  for (const id of ["codex", "kimi", "claude", "local"]) {
    const peer = new Peer(id); bus.add(peer); await peer.start();
  }
  const told: { peer: string; line: string }[] = [], notices: string[] = [], envelopes: Envelope[] = [];
  const observations: { task: number; owner: string | null; since: number }[] = [];
  const deps: TasksDeps = {
    ownerAccepted: options.onAccept,
    board, bus, cwd: root, project: "owner-write-evidence", repository: "org/repo", routing: () => loadRouting(root),
    ...(options.costs ? { sdlc: { config: () => sdlcConfig(undefined), gh: async () => ({ code: 1, stdout: "" }) } } : {}),
    roles: { claude: ["planner", "reviewer"], codex: ["implementer"], kimi: ["implementer"] },
    wipLimit: () => 20, notify: line => notices.push(line), tell: (peer, line) => told.push({ peer, line }),
    // D1 is independent of the disabled time-based sweep.
    sweep: { ...DEFAULT_TASK_SWEEP, enabled: false, ...(options.limit === undefined ? {} : { no_writes_turns: options.limit }) },
    ...(options.absentEvidence ? {} : { ownerWrites: (task: Task, since: number) => {
      observations.push({ task: task.id, owner: task.owner, since }); return options.evidence;
    } }),
  };
  bus.tap(event => { if (event.t === "envelope") envelopes.push(event.env); });
  const tasks = new Tasks(deps);
  const make = async (cls: TaskClass = "implement", owner = "codex", title = "implement the requested feature") => {
    const offered = await tasks.propose(USER, { title, class: cls, owner });
    expect(offered.owner).toBe(owner);
    return tasks.accept(owner, offered.id);
  };
  const plannerNotices = () => told.filter(row => row.peer === "claude");
  const reviews = (id: number) => envelopes.filter(env => env.kind === "review" && env.refs?.task === String(id));
  const clear = () => { told.length = 0; notices.length = 0; envelopes.length = 0; };
  return { root, board, bus, tasks, make, plannerNotices, reviews, clear, told, notices, envelopes, observations };
}

for (const cls of ["implement", "bulk_edit"] as const) test(`#498 two proven-empty ${cls} owner turns notify the planner once with task and count`, async () => {
  const f = await fixture(); const task = await f.make(cls); f.clear();
  const bindings = f.tasks.ownerTurnTasks("codex");
  expect(bindings).toHaveLength(1);
  expect(bindings[0]?.id).toBe(task.id);
  expect(Number.isSafeInteger(bindings[0]?.acceptance)).toBe(true);
  f.tasks.recordOwnerTurn("codex", bindings, false, false);
  expect(f.plannerNotices()).toEqual([]);
  f.tasks.recordOwnerTurn("codex", bindings, false, false);
  expect(f.plannerNotices()).toHaveLength(1);
  expect(f.plannerNotices()[0]!.line).toContain(`#${task.id}`);
  expect(f.plannerNotices()[0]!.line).toMatch(/\b2\b/);
  for (let i = 0; i < 5; i++) f.tasks.recordOwnerTurn("codex", bindings, false, false);
  expect(f.plannerNotices()).toHaveLength(1);
  expect(f.board.stalls()).toContainEqual(expect.objectContaining({ task: task.id, cause: expect.objectContaining({ kind: "no-writes", peer: "codex" }) }));
});

for (const [name, changed, effect] of [["file change", true, false], ["tool effect", false, true], ["unknown capture", undefined, false]] as const) test(`#498 ${name} resets rather than advances the consecutive empty-turn streak`, async () => {
  const f = await fixture(); await f.make(); f.clear();
  const bindings = f.tasks.ownerTurnTasks("codex");
  f.tasks.recordOwnerTurn("codex", bindings, false, false);
  f.tasks.recordOwnerTurn("codex", bindings, changed, effect);
  f.tasks.recordOwnerTurn("codex", bindings, false, false);
  expect(f.plannerNotices()).toEqual([]);
  f.tasks.recordOwnerTurn("codex", bindings, false, false);
  expect(f.plannerNotices()).toHaveLength(1);
});

test("#498 zero disables no-write turn notifications independently of the time sweep", async () => {
  const f = await fixture({ limit: 0 }); await f.make(); f.clear();
  const bindings = f.tasks.ownerTurnTasks("codex");
  for (let i = 0; i < 6; i++) f.tasks.recordOwnerTurn("codex", bindings, false, false);
  expect(f.plannerNotices()).toEqual([]);
  expect(f.board.stalls()).toEqual([]);
});

for (const cls of ["review", "triage", "summarize", "plan", "test"] as const) test(`#498 ${cls} is never classified as a silent writer or done-without-writes`, async () => {
  const f = await fixture({ evidence: false }); const task = await f.make(cls); f.clear();
  expect(f.tasks.ownerTurnTasks("codex")).toEqual([]);
  for (let i = 0; i < 4; i++) f.tasks.recordOwnerTurn("codex", [], false, false);
  const done = await f.tasks.done("codex", task.id, "read-only result and verification");
  expect(f.plannerNotices()).toEqual([]);
  expect(done.history.findLast(entry => entry.event === "done")?.noWrites).toBeUndefined();
  expect(f.reviews(task.id).some(env => env.body.includes(NO_WRITES))).toBe(false);
  expect(f.observations).toEqual([]);
});

test("#498 no-write planner notification for a PII task carries only the public stub", async () => {
  const f = await fixture();
  const secret = "patient 900101-1234567 needs follow-up";
  const task = await f.make("implement", "local", secret); f.clear();
  const bindings = f.tasks.ownerTurnTasks("local");
  expect(bindings.map(binding => binding.id)).toContain(task.id);
  f.tasks.recordOwnerTurn("local", bindings, false, false);
  f.tasks.recordOwnerTurn("local", bindings, false, false);
  expect(f.plannerNotices()).toHaveLength(1);
  expect(f.plannerNotices()[0]!.line).toContain(`#${task.id} [pii]`);
  const emitted = JSON.stringify({ told: f.told, notices: f.notices, envelopes: f.envelopes, stalls: f.board.stalls() });
  expect(emitted).not.toContain(secret);
  expect(emitted).not.toContain("900101");
});

test("#498 stale bindings cannot count a former owner or a repeated owner's older acceptance", async () => {
  const f = await fixture(); const task = await f.make();
  const old = f.tasks.ownerTurnTasks("codex");
  await f.tasks.assignTo(task.id, "kimi", USER);
  f.tasks.accept("kimi", task.id);
  f.clear();
  for (let i = 0; i < 3; i++) f.tasks.recordOwnerTurn("codex", old, false, false);
  expect(f.plannerNotices()).toEqual([]);
  await f.tasks.assignTo(task.id, "codex", USER);
  f.tasks.accept("codex", task.id);
  const current = f.tasks.ownerTurnTasks("codex"); f.clear();
  expect(current[0]?.acceptance).not.toBe(old[0]?.acceptance);
  for (let i = 0; i < 3; i++) f.tasks.recordOwnerTurn("codex", old, false, false);
  expect(f.plannerNotices()).toEqual([]);
  f.tasks.recordOwnerTurn("codex", current, false, false);
  expect(f.plannerNotices()).toEqual([]);
  f.tasks.recordOwnerTurn("codex", current, false, false);
  expect(f.plannerNotices()).toHaveLength(1);
});

for (const cls of ["implement", "bulk_edit"] as const) test(`#498 ${cls} done with positive no-write evidence stays advisory and reaches its reviewer`, async () => {
  const f = await fixture({ evidence: false }); const task = await f.make(cls);
  await f.tasks.assignTo(task.id, "claude", USER, false, "reviewer"); f.clear();
  const done = await f.tasks.done("codex", task.id, "completed elsewhere without refs");
  expect(done.state).toBe("in_review");
  expect(done.history.findLast(entry => entry.event === "done")?.noWrites).toBe(true);
  expect(f.reviews(task.id)).toHaveLength(1);
  expect(f.reviews(task.id)[0]!.body.split("\n")).toContain(NO_WRITES);
  const accepted = done.history.findLast(entry => entry.event === "accepted" && entry.by === "codex")!;
  expect(f.observations).toContainEqual({ task: task.id, owner: "codex", since: accepted.at });
});

for (const [name, options, refs] of [
  ["write/touch evidence", { evidence: true }, {}],
  ["unknown evidence", {}, {}],
  ["absent host evidence", { absentEvidence: true }, {}],
  ["branch ref", { evidence: false }, { branch: "feature/implemented-elsewhere" }],
  ["commit ref", { evidence: false }, { commit: "0123456789abcdef0123456789abcdef01234567" }],
] as const) test(`#498 ${name} prevents a false done-without-writes advisory`, async () => {
  const f = await fixture(options); const task = await f.make();
  await f.tasks.assignTo(task.id, "claude", USER, false, "reviewer"); f.clear();
  const done = await f.tasks.done("codex", task.id, "completed and checked", refs as TaskRefs);
  expect(done.state).toBe("in_review");
  expect(done.history.findLast(entry => entry.event === "done")?.noWrites).toBeUndefined();
  expect(f.reviews(task.id)).toHaveLength(1);
  expect(f.reviews(task.id)[0]!.body).not.toContain(NO_WRITES);
});

test("#498 done evidence is bound to the latest owner's acceptance, not a previous owner's epoch", async () => {
  const f = await fixture({ evidence: false }); const task = await f.make();
  await f.tasks.assignTo(task.id, "kimi", USER); f.tasks.accept("kimi", task.id);
  await f.tasks.assignTo(task.id, "claude", USER, false, "reviewer");
  const done = await f.tasks.done("kimi", task.id, "current owner result");
  const accepted = done.history.findLast(entry => entry.event === "accepted" && entry.by === "kimi")!;
  expect(f.observations).toContainEqual({ task: task.id, owner: "kimi", since: accepted.at });
  expect(f.observations.some(observation => observation.owner === "codex")).toBe(false);
});

test("#498 structured no-write stalls feed grooming and scoped cost metrics", async () => {
  const f = await fixture({ evidence: false, costs: true }), task = await f.make();
  f.board.update(task.id, USER, "artifacts", { sdlc: { repo: "org/repo", pr: 1, stage: "build" } });
  const bindings = f.tasks.ownerTurnTasks("codex");
  f.tasks.recordOwnerTurn("codex", bindings, false, false); f.tasks.recordOwnerTurn("codex", bindings, false, false);
  const digest = await f.tasks.groomingDigest(USER);
  expect(digest.items).toContainEqual(expect.objectContaining({ task: task.id, kind: "blocked", code: "no-writes" }));
  expect((await f.tasks.costReport(USER, "org/repo")).stalls).toEqual({ noWrites: 1, doneWithoutWrites: 0 });
  await f.tasks.done("codex", task.id, "completed without local writes");
  expect((await f.tasks.costReport(USER, "org/repo")).stalls).toEqual({ noWrites: 0, doneWithoutWrites: 1 });
});

test("#498 no-write threshold is an integer live setting using the shared reload schema", () => {
  const def = settingDef("task_sweep.no_writes_turns");
  expect(def).toMatchObject({ type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER, risk: "raises", applies: "live" });
  expect(() => validateRawConfig({ task_sweep: { no_writes_turns: 0 } })).not.toThrow();
  expect(() => validateRawConfig({ task_sweep: { no_writes_turns: 1.5 } })).toThrow();
  expect(configApply("task_sweep.no_writes_turns").applies).toBe("live");
});

test("#498 grooming drops a persisted no-write cause from a previous acceptance", async () => {
  const f = await fixture(); const task = await f.make();
  const bindings = f.tasks.ownerTurnTasks("codex");
  f.tasks.recordOwnerTurn("codex", bindings, false, false);
  f.tasks.recordOwnerTurn("codex", bindings, false, false);
  expect((await f.tasks.groomingDigest(USER)).items).toContainEqual(expect.objectContaining({ task: task.id, code: "no-writes" }));
  f.tasks.accept("codex", task.id, { paths: ["new-scope.ts"] });
  expect(f.tasks.stalled().filter(stall => stall.task === task.id)).toEqual([]);
  expect((await f.tasks.groomingDigest(USER)).items).not.toContainEqual(expect.objectContaining({ task: task.id, code: "no-writes" }));
});


test("#498 baseline capture belongs to explicit accept and self-claim, never an implicit done", async () => {
  const captures: number[] = [];
  const f = await fixture({ onAccept: task => { captures.push(task.id); } });
  const accepted = await f.make();
  const claimed = await f.tasks.propose("codex", { title: "self-claimed implementation", class: "implement", owner: "codex" });
  expect(claimed.state).toBe("in_progress");
  const offered = await f.tasks.propose(USER, { title: "implementation finished without a prior accept", class: "implement", owner: "codex" });
  await f.tasks.done("codex", offered.id, "completed without a separate accept");
  expect(captures).toEqual([accepted.id, claimed.id]);
});

test("#498 a failed host baseline capture cannot fail a saved acceptance", async () => {
  const f = await fixture({ onAccept: () => { throw new Error("capture unavailable"); } });
  expect((await f.make()).state).toBe("in_progress");
});
