import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { HUB, newEnvelope, USER, type Envelope } from "../src/hub/envelope.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { parseRouting } from "../src/hub/routing.ts";
import { sdlcConfig, type SdlcGh } from "../src/hub/sdlc.ts";
import type { QueueBackpressurePolicy } from "../src/hub/queue-backpressure.ts";

class QueuePeer extends BasePeer {
  constructor(id: string, readonly pullOnly = false) { super(id); }
  delivered: Envelope[] = [];
  async start() { this.setState("idle"); }
  busy() { this.setState("busy"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[]) { this.delivered.push(...envs); }
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture(options: { roles?: Record<string, string[]>; onlyOwner?: boolean; wip?: number; tracking?: boolean; pullOnly?: boolean; hold?: boolean; journal?: boolean; gh?: SdlcGh; requiredChecks?: readonly string[]; ciWatch?: { deadlineMs: number; pollMs: number } } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-task-pressure-"));
  let board = new Board(join(cwd, "hub.db"));
  const control: { policy: QueueBackpressurePolicy; now?: number; tracking: boolean; hold: boolean; lifecycle: "off" | "advise" } = { policy: { max_queued: 0, max_oldest_s: 0 }, tracking: options.tracking ?? true, hold: options.hold ?? true, lifecycle: "off" };
  // A lifecycle hold retains queued traffic without changing the peers' otherwise eligible idle states.
  const journal = options.journal ? new DeliveryJournal({ file: join(cwd, "delivery.db"), projectRoot: cwd, projectId: "pressure", instanceId: "pressure-run" }) : undefined;
  const bus = new Bus({ batchMs: 0, queueCap: 1000, deliveryHeld: () => control.hold, trackQueuePressure: () => control.tracking, ...(journal ? { journal } : {}) });
  const peers: Record<string, QueuePeer> = {};
  for (const id of ["codex", "kimi", "claude"]) { const peer = new QueuePeer(id, options.pullOnly); peers[id] = peer; bus.add(peer); await peer.start(); }
  const routing = parseRouting(`[local]\nfixed_model="fixture"\n[classes.implement]\npeers=${options.onlyOwner ? '["codex"]' : '["codex","kimi"]'}\n[classes.review]\npeers=["claude"]\n`);
  const roles = options.roles ?? {}, notices: string[] = [];
  const makeTasks = () => new Tasks({ board, bus, routing: () => routing, cwd, project: "pressure", roles, wipLimit: () => options.wip ?? 10,
    queueBackpressure: () => control.policy, now: () => control.now ?? Date.now(), notify: text => notices.push(text), ...(options.ciWatch ? { ciWatch: options.ciWatch } : {}),
    sdlc: { config: () => ({ ...sdlcConfig(undefined), mode: control.lifecycle, requiredChecks: [...(options.requiredChecks ?? [])] }), ...(options.gh ? { gh: options.gh } : {}) } });
  let tasks = makeTasks();
  cleanup.push(() => { tasks.stopQueuePressureRechecks(); tasks.stopCiWatchers(); bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const enqueue = (peer: string, count: number) => {
    const ids: string[] = [];
    for (let n = 0; n < count; n++) { const env = newEnvelope(USER, `ordinary queued item ${n}`, { to: [peer], kind: "chat", priority: "status" }); bus.publish(env); ids.push(env.id); }
    return ids;
  };
  const wire = () => { bus.onQueues = () => tasks.scheduleQueuePressureRecheck(); };
  const restart = (beforeOpen?: () => void) => {
    tasks.stopQueuePressureRechecks(); tasks.stopCiWatchers(); board.close(); beforeOpen?.();
    board = new Board(join(cwd, "hub.db")); tasks = makeTasks(); wire(); tasks.scheduleQueuePressureRecheck();
  };
  return { cwd, get board() { return board; }, bus, get tasks() { return tasks; }, peers, roles, control, notices, enqueue, wire, restart };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function bounded<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("queue pressure test barrier timed out")), 5000);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

test("real assignment and route explain share queue-count refusal without disturbing existing traffic", async () => {
  const f = await fixture(); f.control.policy = { max_queued: 2, max_oldest_s: 0 };
  const existing = f.enqueue("codex", 3);
  const row = await f.tasks.propose(HUB, { title: "new work", class: "implement" });
  expect(row.owner).toBe("kimi");
  expect(f.tasks.explain(row.id)).toContain("  owner candidate codex: skipped, queue backpressure: queued 3 exceeds max 2");
  expect(f.tasks.explain(row.id)).toContain("owner: kimi");
  expect(f.bus.queueIds("codex")).toEqual(existing);
  expect(f.tasks.queuePressureStatus(["codex"])?.peers.codex).toMatchObject({ queued: 3, blocked: true, code: "queue-count" });
  expect(f.bus.withdraw(existing[0]!)).toBe(true);
  expect(f.bus.queueIds("codex")).toEqual(existing.slice(1));
  expect(f.tasks.queuePressureStatus(["codex"])?.peers.codex).toMatchObject({ queued: 2, blocked: false });
});

test("age metadata and unknown age hold the same real automatic offers and explain the refusal", async () => {
  const aged = await fixture(); aged.control.policy = { max_queued: 0, max_oldest_s: 60 }; aged.enqueue("codex", 1); aged.control.now = Date.now() + 61_000;
  const row = await aged.tasks.propose(HUB, { title: "aged queue", class: "implement" });
  expect(row.owner).toBe("kimi");
  const status = aged.tasks.queuePressureStatus(["codex"])!;
  expect(status.peers.codex?.code).toBe("queue-age");
  expect(status.peers.codex?.oldestAgeMs).toBeGreaterThan(60_000);
  expect(aged.tasks.explain(row.id).some(line => line.includes("queue backpressure: oldest queued age"))).toBe(true);

  const unknown = await fixture({ tracking: false, onlyOwner: true }); unknown.enqueue("codex", 1); unknown.control.policy = { max_queued: 0, max_oldest_s: 60 }; unknown.control.tracking = true;
  const held = await unknown.tasks.propose(HUB, { title: "legacy queue", class: "implement", owner: "codex" });
  expect(held.owner).toBeNull();
  expect(unknown.tasks.queuePressureStatus(["codex"])?.peers.codex).toEqual({ queued: 1, oldestQueuedAt: null, oldestAgeMs: null, blocked: true, code: "queue-age-unknown", reason: "queue backpressure: oldest queued age unknown" });
  expect(unknown.tasks.stalled().find(stall => stall.task === held.id)?.cause.refusals).toContainEqual({ peer: "codex", code: "queue-age-unknown" });
  expect(unknown.tasks.explain(held.id).join("\n")).toContain("oldest queued age unknown");
});

test("disabled policy preserves assignment and explanation and performs no pressure metadata reads", async () => {
  const f = await fixture(); f.enqueue("codex", 3);
  let reads = 0; const read = f.bus.assignmentQueue.bind(f.bus);
  f.bus.assignmentQueue = peer => { reads++; return read(peer); };
  const first = f.tasks.explain({ title: "same draft", class: "implement" });
  expect(f.tasks.queuePressureStatus(["codex"])).toBeUndefined();
  f.control.policy = { max_queued: 0, max_oldest_s: 0 };
  expect(f.tasks.explain({ title: "same draft", class: "implement" })).toEqual(first);
  expect((await f.tasks.propose(HUB, { title: "still takes work", class: "implement" })).owner).toBe("codex");
  expect(reads).toBe(0);
});

test("pressure status and routing read pending metadata without touching delivery history bodies", async () => {
  const f = await fixture(); f.control.policy = { max_queued: 1, max_oldest_s: 60 }; f.enqueue("codex", 2);
  const before = f.bus.queueIds("codex");
  f.bus.queueList = () => { throw new Error("delivery history must not be read here"); };
  expect(f.tasks.queuePressureStatus(["codex"])?.peers.codex?.queued).toBe(2);
  expect(f.tasks.explain({ title: "metadata only", class: "implement" })).toContain("owner: kimi");
  expect(f.bus.queueIds("codex")).toEqual(before);
});

test("a person or current single conductor can explicitly assign an owner without waiving reviewer pressure", async () => {
  for (const by of [USER, "claude"]) {
    const f = await fixture({ roles: { claude: ["conductor", "reviewer"] } });
    f.control.policy = { max_queued: 1, max_oldest_s: 0 }; f.enqueue("codex", 2); f.enqueue("claude", 2);
    const row = f.board.propose(USER, { title: "explicit owner", class: "implement" });
    const assigned = await f.tasks.assignTo(row.id, "codex", by);
    expect(assigned).toMatchObject({ owner: "codex", reviewer: USER });
    expect(f.bus.queued("codex")).toBe(3); // Explicit assignment still uses the ordinary queue.
    const auto = await f.tasks.propose("claude", { title: "automatic flow from conductor", class: "implement", owner: "codex" });
    expect(auto.owner).toBeNull();
    f.bus.pause("codex");
    const paused = f.board.propose(USER, { title: "paused target", class: "implement" });
    await expect(f.tasks.assignTo(paused.id, "codex", by)).rejects.toThrow("paused");
    expect(f.board.get(paused.id)?.owner).toBeNull();
  }
});

test("manual reviewer assignment overrides only that role and keeps an explicit current-task binding", async () => {
  const f = await fixture({ roles: { claude: ["conductor", "reviewer"] } });
  const row = await f.tasks.propose(USER, { title: "review me", class: "implement" });
  f.control.policy = { max_queued: 1, max_oldest_s: 0 }; f.enqueue("claude", 2);
  const assigned = await f.tasks.assignTo(row.id, "claude", "claude", false, "reviewer");
  expect(assigned.reviewer).toBe("claude");
  f.tasks.accept("codex", row.id);
  const done = await f.tasks.done("codex", row.id, "finished existing work");
  expect(done).toMatchObject({ state: "in_review", reviewer: "claude" });
  expect(f.bus.queued("claude")).toBe(3); // The known role's review request is not dropped or rerouted.
});

test("an existing owner can accept and complete while backlogged, but a new automatic review offer is held", async () => {
  const f = await fixture();
  const row = await f.tasks.propose(USER, { title: "already offered", class: "implement" });
  f.control.policy = { max_queued: 1, max_oldest_s: 0 }; f.enqueue("codex", 2); const reviewerTraffic = f.enqueue("claude", 2);
  expect(f.tasks.accept("codex", row.id).state).toBe("in_progress");
  const completed = await f.tasks.done("codex", row.id, "done despite old queue");
  expect(completed).toMatchObject({ state: "in_review", owner: "codex", reviewer: USER });
  expect(completed.history.findLast(entry => entry.event === "done")?.reviewBlocked).toBe(true);
  expect(f.bus.queueIds("claude")).toEqual(reviewerTraffic);
  expect((await f.tasks.review(USER, row.id, "approved", "person verdict")).state).toBe("approved");
});

test("unowned planner reservations keep WIP separate from pressure and automatic pulls never borrow a conductor override", async () => {
  const f = await fixture({ roles: { claude: ["planner", "conductor"] }, onlyOwner: true, wip: 4 });
  f.control.policy = { max_queued: 1, max_oldest_s: 0 };
  const first = await f.tasks.propose(USER, { title: "unowned reservation", class: "implement", backlog: true });
  const pulled = await f.tasks.pullPlanned("claude", { id: first.id, revision: 0, reason: "plan ready" });
  expect(pulled).toMatchObject({ owner: null, reserved: "codex", state: "proposed" });
  expect(f.tasks.wip("codex")).toBe(1); expect(f.bus.queued("codex")).toBe(0);
  f.enqueue("codex", 2);
  expect(f.tasks.queuePressureStatus(["codex"])?.peers.codex?.queued).toBe(2);
  const reserved = await f.tasks.propose(USER, { title: "reserved auto pull", class: "implement", backlog: true, owner: "codex" });
  expect(f.tasks.explain(reserved.id).join("\n")).toContain("queue backpressure: queued 2 exceeds max 1");
  await expect(f.tasks.pullPlanned(HUB, { id: reserved.id, revision: 0, reason: "capacity release" }, { onBehalfOf: "claude" })).rejects.toThrow("queue backpressure");
  expect(f.board.get(reserved.id)?.state).toBe("backlog"); expect(f.tasks.wip("codex")).toBe(1);
  expect((await f.tasks.pullPlanned(USER, { id: reserved.id, revision: 0, reason: "person explicitly wants this reservation" })).owner).toBe("codex");
});

test("a conductor queue override is revoked after awaited admission and before the owner write", async () => {
  const f = await fixture({ roles: { claude: ["conductor"] } });
  f.control.policy = { max_queued: 1, max_oldest_s: 0 }; f.enqueue("codex", 2);
  const row = f.board.propose(USER, { title: "admission race", class: "implement" });
  const receipt = f.board.update(row.id, USER, "lifecycle", { sdlc: { stage: "build", planReview: { planner: "claude", planningRevision: 0, recordedAt: Date.now() } } });
  f.control.lifecycle = "advise";
  const entered = deferred(), release = deferred();
  f.tasks.planReviewGap = async () => { entered.resolve(); await release.promise; return undefined; };
  const pending = f.tasks.assignTo(row.id, "codex", "claude", true).then(value => ({ value }), error => ({ error }));
  try { await bounded(entered.promise); f.roles.claude = []; } finally { release.resolve(); }
  const result = await bounded(pending);
  expect("error" in result && result.error instanceof Error ? result.error.message : "not refused").toContain("current configured conductor");
  expect(f.board.get(row.id)).toEqual(receipt);
});


test("only the current conductor, not an ordinary planner, bypasses pressure on a reserved explicit pull", async () => {
  for (const conductor of [false, true]) {
    const f = await fixture({ roles: { claude: conductor ? ["planner", "conductor"] : ["planner"] }, onlyOwner: true });
    f.control.policy = { max_queued: 1, max_oldest_s: 0 }; f.enqueue("codex", 2);
    const row = await f.tasks.propose(USER, { title: "explicit reserved pull", class: "implement", backlog: true, owner: "codex" });
    const pending = f.tasks.pullPlanned("claude", { id: row.id, revision: 0, reason: "named reservation" });
    if (conductor) expect((await pending).owner).toBe("codex");
    else { await expect(pending).rejects.toThrow("queue backpressure"); expect(f.board.get(row.id)?.state).toBe("backlog"); }
  }
});


async function settled(tasks: Tasks): Promise<void> {
  const deadline = performance.now() + 5000;
  while (tasks.queuePressureRechecksPending() && performance.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve));
  expect(tasks.queuePressureRechecksPending()).toBe(0);
}
async function owned(f: Awaited<ReturnType<typeof fixture>>, id: number, owner: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while (f.board.get(id)?.owner !== owner && performance.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve));
  expect(f.board.get(id)?.owner).toBe(owner);
  await settled(f.tasks);
}

test("a pull-only peer draining its queue without a state change reoffers only the queue-held automatic proposal", async () => {
  const f = await fixture({ onlyOwner: true, pullOnly: true, hold: false }); f.wire();
  f.control.policy = { max_queued: 1, max_oldest_s: 0 }; f.enqueue("codex", 2);
  const legacy = f.board.propose(USER, { title: "unrelated old unowned work", class: "implement" });
  const manual = f.board.propose(USER, { title: "person will unassign", class: "implement" });
  await f.tasks.assignTo(manual.id, "codex", USER); await f.tasks.unassign(manual.id, USER);
  const held = await f.tasks.propose(HUB, { title: "automatic queue hold", class: "implement" });
  expect(held.owner).toBeNull(); await settled(f.tasks);
  expect(f.board.queuePressureStallPage().rows.map(row => row.task)).toContain(held.id);
  await f.tasks.releaseReady(); // The legacy release pass must not erase this origin marker.
  expect(f.board.queuePressureStallPage().rows.map(row => row.task)).toContain(held.id);
  const before = f.bus.stateOf("codex");
  expect(f.bus.pull("codex")?.length).toBeGreaterThan(0);
  expect(f.bus.stateOf("codex")).toBe(before);
  await settled(f.tasks);
  expect(f.board.get(held.id)?.owner).toBe("codex");
  expect(f.board.get(legacy.id)?.owner).toBeNull(); expect(f.board.get(manual.id)?.owner).toBeNull();
  expect(f.board.get(held.id)?.history.filter(entry => entry.event === "assigned")).toHaveLength(1);
});

test("withdrawal rechecks queue age only after the persisted old-unknown row is gone", async () => {
  const f = await fixture({ onlyOwner: true, pullOnly: true, hold: false, journal: true, tracking: false });
  const old = f.enqueue("codex", 1)[0]!; f.control.policy = { max_queued: 0, max_oldest_s: 60 }; f.control.tracking = true;
  f.enqueue("codex", 1);
  const held = await f.tasks.propose(HUB, { title: "wait for known age", class: "implement" });
  expect(held.owner).toBeNull(); await settled(f.tasks);
  const immediate: (number | null | undefined)[] = [];
  f.bus.onQueues = () => { immediate.push(f.bus.assignmentQueue("codex").oldestQueuedAt); f.tasks.scheduleQueuePressureRecheck(); };
  expect(f.bus.withdraw(old)).toBe(true);
  expect(immediate).toContain(undefined); // Callback is before the journal checkpoint.
  await owned(f, held.id, "codex");
  expect(f.tasks.queuePressureStatus(["codex"])?.peers.codex?.blocked).toBe(false);
});

test("turning pressure off releases known automatic holds but leaves unrelated legacy unowned rows alone", async () => {
  const f = await fixture({ onlyOwner: true, pullOnly: true, hold: false }); f.wire();
  f.control.policy = { max_queued: 1, max_oldest_s: 0 }; const ids = f.enqueue("codex", 2);
  const legacy = f.board.propose(USER, { title: "legacy remains unowned", class: "implement" });
  const held = await f.tasks.propose(HUB, { title: "known policy hold", class: "implement" }); await settled(f.tasks);
  expect(held.owner).toBeNull();
  f.control.policy = { max_queued: 0, max_oldest_s: 0 }; f.tasks.scheduleQueuePressureRecheck();
  await owned(f, held.id, "codex");
  expect(f.bus.queueIds("codex").slice(0, ids.length)).toEqual(ids);
  expect(f.board.get(legacy.id)?.owner).toBeNull(); expect(f.tasks.queuePressureStatus(["codex"])).toBeUndefined();
});

test("an automatic queue-held review is offered once when pressure clears, without changing an ordinary human review", async () => {
  const f = await fixture({ pullOnly: true, hold: false }); f.wire();
  const row = await f.tasks.propose(HUB, { title: "automatic review wait", class: "implement" }); f.tasks.accept("codex", row.id);
  f.control.policy = { max_queued: 1, max_oldest_s: 0 }; f.enqueue("claude", 2);
  const held = await f.tasks.done("codex", row.id, "ready", { commit: "a".repeat(40) });
  expect(held).toMatchObject({ state: "in_review", reviewer: USER });
  expect(held.history.at(-1)?.queueReviewHeld).toBe(true); expect(held.history.at(-1)?.queueReviewBinding).toMatch(/^[0-9a-f]{64}$/);
  await settled(f.tasks);
  // Fixture-only legacy human fallback has no queue-origin role metadata.
  const legacy = f.board.propose(USER, { title: "person review remains", class: "implement" });
  f.board.update(legacy.id, USER, "assigned", { owner: "codex", reviewer: USER });
  f.board.update(legacy.id, "codex", "accepted", { state: "in_progress" });
  f.board.update(legacy.id, "codex", "done", { state: "in_review" }, "manual fixture", { reviewBlocked: true });
  f.bus.pull("claude");
  const deadline = performance.now() + 5000;
  while (f.board.get(row.id)?.reviewer !== "claude" && performance.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve));
  expect(f.board.get(row.id)?.reviewer).toBe("claude"); await settled(f.tasks);
  expect(f.board.get(row.id)?.history.at(-1)?.reviewerFailure).toBeUndefined();
  expect(f.board.get(row.id)?.history.filter(entry => entry.event === "reviewer changed")).toHaveLength(1);
  expect(f.board.get(legacy.id)?.reviewer).toBe(USER);
});

test("a manual review role change or artifact relink invalidates a prior queue-held review marker", async () => {
  for (const change of ["manual", "head", "repo", "pr"]) {
    const f = await fixture({ pullOnly: true, hold: false }); f.wire();
    const row = await f.tasks.propose(HUB, { title: "bound review wait", class: "implement" }); f.tasks.accept("codex", row.id);
    f.control.policy = { max_queued: 1, max_oldest_s: 0 }; f.enqueue("claude", 2);
    await f.tasks.done("codex", row.id, "ready", { commit: "b".repeat(40) }); await settled(f.tasks);
    if (change === "manual") await f.tasks.unassign(row.id, USER, false, "reviewer");
    else if (change === "head") f.board.update(row.id, USER, "lifecycle", { refs: { commit: "c".repeat(40) } });
    else if (change === "repo") f.board.update(row.id, USER, "lifecycle", { refs: { repo: "other/project" } });
    else f.board.update(row.id, USER, "lifecycle", { sdlc: { stage: "review", repo: "fixture/project", pr: 12 } });
    f.bus.pull("claude"); f.tasks.scheduleQueuePressureRecheck(); await settled(f.tasks);
    expect(f.board.get(row.id)?.reviewer).toBe(change === "manual" ? null : USER);
    expect(f.bus.queued("claude")).toBe(0);
  }
});

test("queue origin markers survive a reopened board and are resumed by the bootstrap pass", async () => {
  const f = await fixture({ onlyOwner: true, pullOnly: true, hold: false }); f.wire();
  f.control.policy = { max_queued: 1, max_oldest_s: 0 }; f.enqueue("codex", 2);
  const held = await f.tasks.propose(HUB, { title: "durable automatic hold", class: "implement" }); await settled(f.tasks);
  expect(held.owner).toBeNull();
  f.tasks.stopQueuePressureRechecks(); f.bus.onQueues = undefined; f.bus.pull("codex");
  f.restart();
  await owned(f, held.id, "codex");
  expect(f.board.queuePressureStallPage().rows).toEqual([]);
});


test("turning pressure off before completion releases an automatic reviewer preselection hold", async () => {
  const f = await fixture({ pullOnly: true, hold: false }); f.wire();
  f.control.policy = { max_queued: 1, max_oldest_s: 0 }; f.enqueue("claude", 2);
  const row = await f.tasks.propose(HUB, { title: "preselected review hold", class: "implement" });
  expect(row.reviewer).toBe(USER); expect(row.history.findLast(entry => entry.event === "assigned")?.queueReviewHeld).toBe(true);
  f.control.policy = { max_queued: 0, max_oldest_s: 0 }; f.tasks.scheduleQueuePressureRecheck();
  f.tasks.accept("codex", row.id);
  const completed = await f.tasks.done("codex", row.id, "new bound completion", { commit: "d".repeat(40) });
  expect(completed).toMatchObject({ state: "in_review", reviewer: "claude" });
  expect(completed.history.findLast(entry => entry.event === "done")?.queueReviewHeld).toBeUndefined();
});


test("queue retry indexes ignore malformed and row-mismatched legacy stall payloads", async () => {
  const f = await fixture({ onlyOwner: true, pullOnly: true, hold: false }); f.wire();
  f.control.policy = { max_queued: 1, max_oldest_s: 0 }; f.enqueue("codex", 2);
  const held = await f.tasks.propose(HUB, { title: "real queue-origin hold", class: "implement" }); await settled(f.tasks);
  const legacy = f.board.propose(USER, { title: "unrelated legacy proposal", class: "implement" });
  f.restart(() => {
    // Fixture-only corruption predating the new partial index, not a production repair path.
    const raw = new Database(join(f.cwd, "hub.db"));
    try {
      raw.run("DROP INDEX IF EXISTS task_stalls_queue_pressure");
      const cause = { kind: "no-eligible-peer", code: "queue-count" };
      const payload = JSON.stringify({ task: legacy.id, cause, signature: JSON.stringify(cause), replanRevision: 0, at: Date.now() });
      raw.query("INSERT INTO task_stalls(task,payload) VALUES(?,?)").run(999, payload);
      raw.query("INSERT INTO task_stalls(task,payload) VALUES(?,?)").run(1000, "{");
    } finally { raw.close(); }
  });
  await settled(f.tasks);
  expect(f.board.queuePressureStallPage().rows.map(row => row.task)).toEqual([held.id]);
  const first = f.board.queuePressureStallPage(0, 1), skipped = f.board.queuePressureStallPage(first.afterTask, 1);
  expect(skipped.rows).toEqual([]); expect(skipped.afterTask).toBe(999);
  f.bus.pull("codex"); await owned(f, held.id, "codex");
  expect(f.board.get(legacy.id)?.owner).toBeNull();
});


test("a queue-held review moving to its new reviewer keeps the pending CI notification alive", async () => {
  const head = "e".repeat(40), names = ["check (ubuntu-latest)", "check (macos-latest)", "seeded guards"];
  const state = { conclusion: "IN_PROGRESS" };
  const pendingRead = deferred(), releaseRead = deferred(), readFinished = deferred();
  const checks = () => names.map(name => ({ name, status: state.conclusion === "IN_PROGRESS" ? "IN_PROGRESS" : "COMPLETED", conclusion: state.conclusion === "IN_PROGRESS" ? "" : state.conclusion }));
  const gh: SdlcGh = async args => {
    if (args[0] === "pr" && args.includes("headRefOid,state,statusCheckRollup")) {
      pendingRead.resolve();
      // Hold a real watcher read while queue admission assigns the reviewer.
      await releaseRead.promise;
      const reply = { code: 0, stdout: JSON.stringify({ headRefOid: head, state: "OPEN", statusCheckRollup: checks() }) };
      readFinished.resolve(); return reply;
    }
    if (args[0] === "pr") return { code: 0, stdout: JSON.stringify({ headRefOid: head, state: "OPEN", statusCheckRollup: checks(), reviewRequests: [], files: [], changedFiles: 0 }) };
    return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: head, state: "OPEN",
      commits: { nodes: [{ commit: { oid: head, tree: { oid: "f".repeat(40) }, statusCheckRollup: { contexts: { nodes: checks(), pageInfo: { hasNextPage: false } } } } }] },
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) };
  };
  const f = await fixture({ onlyOwner: true, pullOnly: true, hold: false, gh, requiredChecks: names, ciWatch: { deadlineMs: 5000, pollMs: 10 } }); f.wire();
  const row = f.board.propose(USER, { title: "pending CI and reviewer pressure", class: "implement" });
  f.board.update(row.id, USER, "accepted", { owner: "codex", reviewer: "claude", state: "in_progress", refs: { commit: head }, sdlc: { stage: "build", repo: "fixture/project", issue: 1, pr: 1, head, localHead: head, localResult: "passed" } });
  f.control.policy = { max_queued: 1, max_oldest_s: 0 }; f.control.lifecycle = "advise"; f.enqueue("claude", 2);
  const notices: Envelope[] = [], reviews: Envelope[] = [];
  f.bus.tap(event => {
    if (event.t !== "envelope" || event.env.from !== HUB || event.env.refs?.task !== String(row.id)) return;
    if (event.env.body.startsWith("ci_completed:")) notices.push(event.env);
    if (event.env.kind === "review") reviews.push(event.env);
  });
  try {
    const done = await f.tasks.done("codex", row.id, "ready while CI runs");
    expect(done).toMatchObject({ state: "in_review", reviewer: USER });
    expect(done.history.at(-1)?.queueReviewHeld).toBe(true);
    await bounded(pendingRead.promise); await settled(f.tasks);
    expect(notices).toEqual([]);
    f.bus.pull("claude");
    const deadline = performance.now() + 5000;
    while (f.board.get(row.id)?.reviewer !== "claude" && performance.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.board.get(row.id)?.reviewer).toBe("claude"); await settled(f.tasks);
    expect(reviews).toHaveLength(1); expect(notices).toEqual([]);
    state.conclusion = "SUCCESS"; releaseRead.resolve();
    await bounded(readFinished.promise);
    // Consume the completed fake-GitHub response and all its promise continuations.
    await new Promise<void>(resolve => setImmediate(resolve));
    const marker = `ci_completed: #${row.id} head ${head.slice(0, 12)} passed`;
    expect(notices).toHaveLength(2);
    expect(notices.flatMap(env => env.to ?? []).sort()).toEqual(["claude", "codex"]);
    expect(notices.every(env => env.body.startsWith(marker) && env.priority === "status")).toBe(true);
    expect(f.bus.pull("codex")?.some(env => env.body.includes(marker))).toBe(true);
    expect(f.bus.pull("claude")?.some(env => env.body.includes(marker))).toBe(true);
    expect(reviews).toHaveLength(1); // Advise-mode CI completion does not duplicate its already offered review.
  } finally { releaseRead.resolve(); }
});


test("legacy ready diagnostics still record and clear stalls while pressure is disabled", async () => {
  const f = await fixture({ onlyOwner: true });
  f.bus.pause("codex");
  const legacy = f.board.propose(USER, { title: "diagnostic legacy work", class: "implement" });
  const before = f.notices.length;
  await f.tasks.releaseReady(); await f.tasks.releaseReady();
  expect(f.tasks.stalled().find(stall => stall.task === legacy.id)?.cause.refusals).toContainEqual({ peer: "codex", code: "paused" });
  expect(f.notices.slice(before).filter(line => line.startsWith(`Task #${legacy.id} stalled:`))).toHaveLength(1);
  expect(f.board.get(legacy.id)?.owner).toBeNull();
  f.bus.resume("codex"); await f.tasks.releaseReady();
  expect(f.tasks.stalled()).toEqual([]);
  expect(f.board.get(legacy.id)?.owner).toBeNull();
});

test("diagnostic-only legacy queue stalls do not become automatic proposal retry origins", async () => {
  const f = await fixture({ onlyOwner: true, pullOnly: true, hold: false }); f.wire();
  f.control.policy = { max_queued: 1, max_oldest_s: 0 }; f.enqueue("codex", 2);
  const legacy = f.board.propose(USER, { title: "never offered legacy row", class: "implement" });
  await f.tasks.releaseReady();
  expect(f.tasks.stalled().find(stall => stall.task === legacy.id)?.cause.refusals).toContainEqual({ peer: "codex", code: "queue-count" });
  expect(f.board.queuePressureStallPage().rows).toEqual([]);
  f.bus.pull("codex"); await settled(f.tasks); await f.tasks.releaseReady();
  expect(f.board.get(legacy.id)?.owner).toBeNull();
});

test("a declined automatic offer retains its queue origin across replanning and resumes after drain", async () => {
  const f = await fixture({ pullOnly: true, hold: false }); f.wire();
  const row = await f.tasks.propose(USER, { title: "decline under pressure", class: "implement" });
  expect(row.owner).toBe("codex");
  f.control.policy = { max_queued: 1, max_oldest_s: 0 }; f.enqueue("kimi", 2);
  const back = await f.tasks.decline("codex", row.id, "cannot implement");
  expect(back.owner).toBeNull(); await settled(f.tasks);
  expect(f.board.queuePressureStallPage().rows.map(row => row.task)).toContain(back.id);
  f.board.plan(back.id, USER, { priority: 2 }, back.planningRevision ?? 0);
  await f.tasks.releaseReady(); await settled(f.tasks);
  expect(f.board.queuePressureStallPage().rows.find(row => row.task === back.id)?.replanRevision).toBe(1);
  f.bus.pull("kimi"); await owned(f, back.id, "kimi");
  expect(f.board.get(back.id)?.history.filter(row => row.event === "assigned" || row.event === "reassigned")).toHaveLength(2);
});

test("a budget-cleared automatic offer resumes after its replacement queue drains", async () => {
  const f = await fixture({ pullOnly: true, hold: false }); f.wire();
  const row = await f.tasks.propose(USER, { title: "budget reroute", class: "implement" });
  f.tasks.accept("codex", row.id); f.bus.pause("codex");
  f.control.policy = { max_queued: 1, max_oldest_s: 0 }; f.enqueue("kimi", 2);
  await f.tasks.reassignForPause("codex", undefined); await settled(f.tasks);
  expect(f.board.get(row.id)?.owner).toBeNull();
  expect(f.board.queuePressureStallPage().rows.map(row => row.task)).toContain(row.id);
  f.bus.pull("kimi"); await owned(f, row.id, "kimi");
});

test("self claims bypass only owner queue admission and named proposals resume only to their target", async () => {
  const f = await fixture({ pullOnly: true, hold: false }); f.wire();
  f.control.policy = { max_queued: 1, max_oldest_s: 0 }; f.enqueue("codex", 2); f.enqueue("claude", 2);
  const before = f.bus.queueIds("codex");
  const claim = await f.tasks.propose("codex", { title: "own work", class: "implement", owner: "codex" });
  expect(claim.owner).toBe("codex"); expect(claim.reviewer).toBe(USER);
  expect(f.bus.queueIds("codex")).toEqual(before);
  const named = await f.tasks.propose(HUB, { title: "named offer", class: "implement", owner: "codex" });
  expect(named.owner).toBeNull(); await settled(f.tasks);
  expect(f.board.queuePressureStallPage().rows.find(row => row.task === named.id)?.cause.peer).toBe("codex");
  expect(f.board.get(named.id)?.owner).toBeNull(); // An idle alternative never replaces the named target.
  f.bus.pull("codex"); await owned(f, named.id, "codex");
});

test("enabled pressure preserves a continuing reviewer below thresholds despite a busier state", async () => {
  const f = await fixture({ roles: { kimi: ["reviewer"] } });
  const row = await f.tasks.propose(USER, { title: "continuing reviewer", class: "implement" });
  expect(row.reviewer).toBe("claude"); f.tasks.accept("codex", row.id);
  const first = await f.tasks.done("codex", row.id, "first pass");
  await f.tasks.review("claude", first.id, "changes_requested", "one correction");
  f.peers.claude!.busy(); f.control.policy = { max_queued: 100, max_oldest_s: 0 };
  const second = await f.tasks.done("codex", row.id, "delta complete");
  expect(second.reviewer).toBe("claude");
});

test("a person's ready reservation stays held rather than rerouting under queue pressure", async () => {
  const f = await fixture({ pullOnly: true, hold: false }); f.wire();
  const dep = f.board.propose(USER, { title: "dependency", class: "implement" });
  const row = await f.tasks.propose(USER, { title: "waiting reservation", class: "implement", after: [dep.id] });
  await f.tasks.assignTo(row.id, "codex", USER);
  f.control.policy = { max_queued: 1, max_oldest_s: 0 }; f.enqueue("codex", 2);
  f.board.update(dep.id, USER, "approved", { state: "approved" });
  await f.tasks.releaseReady(); await settled(f.tasks);
  expect(f.board.get(row.id)).toMatchObject({ owner: null, reserved: "codex" });
  expect(f.tasks.explain(row.id).join("\n")).toContain("reservation retained");
  f.bus.pull("codex"); await owned(f, row.id, "codex");
});
