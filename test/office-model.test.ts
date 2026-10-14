import { expect, test } from "bun:test";
import { officeModel, type OfficeSnapshotInput } from "../src/ui/office-model.ts";
import { taskProgress } from "../src/ui/task-progress.ts";

function fixture(): OfficeSnapshotInput {
  return {
    status: {
      peers: {
        claude: { state: "idle", queued: 0, permissionMode: "plan" },
        codex: { state: "busy", queued: 2, queuedImportant: 1 },
        kimi: { state: "paused", paused: "quota exhausted", queued: 0 },
        pi: { state: "offline", attached: false, queued: 1, needsReview: 2, heldBy: "claude" },
        local: { state: "busy", queued: 0 },
        qwen: { state: "idle", queued: 0 },
      },
    },
    tasks: [
      { id: 1, title: "scaffold", class: "implement", state: "approved", owner: "codex", deps: [] },
      { id: 2, title: "ready task", class: "test", state: "proposed", deps: [1] },
      { id: 3, title: "waiting task", class: "plan", state: "proposed", deps: [4] },
      { id: 4, title: "build feature", class: "implement", state: "in_progress", owner: "codex", deps: [] },
      { id: 5, title: "review me", class: "review", state: "in_review", owner: "codex", reviewer: "claude", deps: [] },
      { id: 6, title: "fix review", class: "implement", state: "changes_requested", owner: "local", reviewer: "claude", deps: [] },
      { id: 7, title: "second wind", class: "test", state: "in_progress", owner: "local", deps: [] },
      { id: 8, title: "strange", class: "triage", state: "archived", deps: [] },
    ],
    permissions: [
      { peer: "local" },
      { peer: "local" },
      { peer: "kimi" },
    ],
    budget: {
      kimi: { windows: [], paused: { reason: "5h quota", resetsAt: 1_800_000 } },
      codex: { windows: [], paused: null },
    },
  };
}

test("officeModel maps a snapshot to desks, conditions, rooms, cards and counts", () => {
  const model = officeModel(fixture(), null, { cols: 4 });
  // Fixed peer order: claude, codex, kimi, pi, local, then others by id.
  expect(model.desks.map((desk) => [desk.id, desk.slot])).toEqual([["claude", 0], ["codex", 1], ["kimi", 2], ["pi", 3], ["local", 4], ["qwen", 5]]);
  const byId = new Map(model.desks.map((desk) => [desk.id, desk]));
  expect(byId.get("claude")!.condition).toBe("idle");
  expect(byId.get("codex")!.condition).toBe("busy");
  expect(byId.get("codex")!.bubble).toBe("#4 implement");
  expect(byId.get("codex")!.name).toBe("codex: busy on task #4 implement");
  expect(byId.get("codex")!.tray).toEqual({ queued: 2, important: 1, heldBy: "", needsReview: 0 });
  expect(byId.get("kimi")!.condition).toBe("paused");
  expect(byId.get("kimi")!.breakNote).toBe("quota exhausted");
  expect(byId.get("kimi")!.breakResetsAt).toBe(1_800_000);
  expect(byId.get("kimi")!.approvals).toBe(1);
  expect(byId.get("kimi")!.name).toBe("kimi: paused: quota exhausted, 1 approval waiting");
  expect(byId.get("pi")!.condition).toBe("offline");
  expect(byId.get("pi")!.dimmed).toBe(true);
  expect(byId.get("pi")!.attached).toBe(false);
  expect(byId.get("pi")!.name).toContain("disconnected, work retained");
  expect(byId.get("pi")!.tray).toEqual({ queued: 1, important: 0, heldBy: "claude", needsReview: 2 });
  // Two approvals outrank busy as the primary condition; the raised hand count stays visible.
  expect(byId.get("local")!.condition).toBe("waiting");
  expect(byId.get("local")!.approvals).toBe(2);
  expect(byId.get("local")!.name).toBe("local: waiting on approval (2)");
  expect(byId.get("claude")!.mode).toBe("plan");
  expect(byId.get("codex")!.mode).toBe("");
  // Work floor: in_progress and changes_requested cards sit at the owner's desk, rework marked.
  expect(byId.get("codex")!.cards.map((card) => card.id)).toEqual([4]);
  expect(byId.get("local")!.cards.map((card) => [card.id, card.rework])).toEqual([[6, true], [7, false]]);
  expect(byId.get("codex")!.cards[0]!.name).toBe("#4 implement: build feature (in progress)");
  expect(byId.get("codex")!.cards[0]!.label).toBe("#4 build feature");
  const rooms = new Map(model.rooms.map((room) => [room.id, room]));
  expect(rooms.get("todo")!.count).toBe(2);
  expect(rooms.get("todo")!.cards.map((card) => [card.id, card.waiting])).toEqual([[2, false], [3, true]]);
  expect(rooms.get("todo")!.cards[1]!.name).toContain("waiting on dependencies");
  expect(rooms.get("todo")!.cards[1]!.label).toBe("#3 waiting task");
  expect(model.rooms.map((room) => room.label)).toEqual(["To do", "Work floor", "Review", "Done"]);
  expect(rooms.get("work")!.count).toBe(3);
  expect(rooms.get("work")!.cards).toEqual([]); // every work card found its owner's desk
  expect(rooms.get("review")!.count).toBe(1);
  expect(rooms.get("review")!.cards[0]!.name).toContain("codex reviewed by claude");
  expect(rooms.get("done")!.count).toBe(1);
  expect(rooms.get("done")!.cards).toEqual([]);
  expect(rooms.get("done")!.overflow).toBe(0);
  expect(model.counts).toEqual({ proposed: 1, waiting: 1, in_progress: 2, in_review: 1, changes_requested: 1, approved: 1, unknown: 1 });
  expect(model.counts).toEqual(taskProgress(fixture().tasks as never).counts);
  // Room counts are the taskProgress counts grouped by column.
  expect(rooms.get("todo")!.count).toBe(model.counts.proposed + model.counts.waiting);
  expect(rooms.get("work")!.count).toBe(model.counts.in_progress + model.counts.changes_requested);
  expect(rooms.get("review")!.count).toBe(model.counts.in_review);
  expect(rooms.get("done")!.count).toBe(model.counts.approved);
  // Tasks in an unknown state are counted but placed nowhere.
  expect(model.placed[8]).toBe("counted:unknown");
  expect(model.placed[4]).toBe("desk:codex");
  expect(model.placed[1]).toBe("shelf:done");
  expect(model.extraPeers).toBe(0);
  expect(model.transitions).toEqual({ desksAdded: [], desksRemoved: [], cardsMoved: [] });
});

test("room counts equal taskProgress counts across randomized boards", () => {
  const states = ["proposed", "in_progress", "in_review", "changes_requested", "approved", "mystery"];
  let seed = 264;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let run = 0; run < 20; run++) {
    const tasks = Array.from({ length: Math.floor(rand() * 30) }, (_, id) => ({
      id, title: `t${id}`, class: "implement", state: states[Math.floor(rand() * states.length)]!,
      owner: "codex", deps: rand() < 0.3 ? [Math.floor(rand() * 30)] : [],
    }));
    const model = officeModel({ status: { peers: { codex: { state: "busy" } } }, tasks }, null, { cols: 4 });
    expect(model.counts).toEqual(taskProgress(tasks).counts);
  }
});

test("a peer keeps its slot when others come and go", () => {
  const at = (ids: string[]) => ({ status: { peers: Object.fromEntries(ids.map((id) => [id, { state: "idle" }])) }, tasks: [] });
  const first = officeModel(at(["claude", "codex", "kimi"]), null, { cols: 1 });
  expect(first.slots).toEqual({ claude: 0, codex: 1, kimi: 2 });
  const gone = officeModel(at(["claude", "kimi"]), first, { cols: 1 });
  expect(gone.slots.kimi).toBe(2);
  expect(gone.desks.map((desk) => [desk.id, desk.slot])).toEqual([["claude", 0], ["kimi", 2]]);
  // A newcomer does not steal the remembered slot; the returning peer reclaims it.
  const joined = officeModel(at(["claude", "kimi", "qwen"]), gone, { cols: 1 });
  expect(joined.slots.qwen).toBe(3);
  const back = officeModel(at(["claude", "codex", "kimi", "qwen"]), joined, { cols: 1 });
  expect(back.slots.codex).toBe(1);
  expect(back.desks.map((desk) => desk.id)).toEqual(["claude", "codex", "kimi", "qwen"]);
});

test("two snapshots produce the expected transitions and no replay on the first", () => {
  const before = fixture();
  const first = officeModel(before, null, { cols: 4 });
  expect(first.transitions).toEqual({ desksAdded: [], desksRemoved: [], cardsMoved: [] });
  const after = fixture();
  after.tasks = after.tasks!.map((task) => task.id === 2 ? { ...task, state: "in_progress", owner: "codex" } : task);
  after.status!.peers = { ...after.status!.peers, claude: undefined as never, deepseek: { state: "idle" } };
  delete (after.status!.peers as Record<string, unknown>).claude;
  const second = officeModel(after, first, { cols: 4 });
  expect(second.transitions.cardsMoved).toEqual([{ id: 2, from: "room:todo", to: "desk:codex" }]);
  expect(second.transitions.desksAdded).toEqual(["deepseek"]);
  expect(second.transitions.desksRemoved).toEqual(["claude"]);
  // An unchanged snapshot moves nothing.
  const again = officeModel(after, second, { cols: 4 });
  expect(again.transitions).toEqual({ desksAdded: [], desksRemoved: [], cardsMoved: [] });
});

test("the busy bubble appears only when the peer has exactly one in_progress task", () => {
  const snap = (tasks: OfficeSnapshotInput["tasks"]): OfficeSnapshotInput => ({ status: { peers: { codex: { state: "busy" } } }, tasks });
  const two = officeModel(snap([
    { id: 1, title: "a", class: "implement", state: "in_progress", owner: "codex" },
    { id: 2, title: "b", class: "test", state: "in_progress", owner: "codex" },
  ]), null, { cols: 1 });
  expect(two.desks[0]!.bubble).toBe("");
  expect(two.desks[0]!.name).toBe("codex: busy");
  expect(two.desks[0]!.extraCards).toBe(0);
  const none = officeModel(snap([{ id: 1, title: "a", class: "implement", state: "in_review", owner: "codex" }]), null, { cols: 1 });
  expect(none.desks[0]!.bubble).toBe("");
  const many = officeModel(snap(Array.from({ length: 5 }, (_, i) => ({ id: i + 1, title: `t${i}`, class: "implement", state: "in_progress", owner: "codex" }))), null, { cols: 1 });
  expect(many.desks[0]!.cards).toHaveLength(2);
  expect(many.desks[0]!.extraCards).toBe(3);
  // A work card whose owner has no desk waits in the Work floor room instead.
  const orphan = officeModel({ status: { peers: {} }, tasks: [{ id: 9, title: "ownerless", class: "implement", state: "in_progress" }] }, null, { cols: 1 });
  expect(orphan.rooms.find((room) => room.id === "work")!.cards.map((card) => card.id)).toEqual([9]);
  expect(orphan.placed[9]).toBe("room:work");
});

test("desk trays keep all three readable cards inside the desk with padding and six pixel gaps", () => {
  const tasks = Array.from({ length: 3 }, (_, index) => ({ id: index + 1, title: `Desk task ${index + 1}`, class: "implement", state: "in_progress", owner: "codex" }));
  const snapshot = { status: { peers: { codex: { state: "busy" } } }, tasks };
  const model = officeModel(snapshot, null, { cols: 4, now: 1000 });
  const desk = model.desks[0]!;
  expect(desk).toMatchObject({ slot: 0, x: 0, y: 3, w: 10, h: 20, extraCards: 0 });
  expect(desk.cards.map((card) => card.id)).toEqual([1, 2, 3]);
  for (const [index, card] of desk.cards.entries()) {
    expect(card.x - desk.x).toBeCloseTo(0.8);
    expect(desk.x + desk.w - card.x - card.w).toBeCloseTo(0.8);
    expect(card.h * 12).toBe(24);
    expect(card.h * 12).toBeGreaterThanOrEqual(20);
    expect(card.y).toBe(desk.y + 8.5 + index * 2.5);
    expect(desk.y + desk.h - card.y - card.h).toBeGreaterThanOrEqual(0.8);
    expect(model.placed[card.id]).toBe("desk:codex");
    if (index) expect((card.y - desk.cards[index - 1]!.y - card.h) * 12).toBe(6);
  }
  const overfull = officeModel({ ...snapshot, tasks: [...tasks, { ...tasks[0]!, id: 4 }] }, model, { cols: 4, now: 1100 }).desks[0]!;
  expect(overfull.cards.map((card) => card.id)).toEqual([1, 2]);
  expect(overfull.extraCards).toBe(2);
});

test("caps: 8 cards per room then an overflow count, 12 desks then +N peers", () => {
  const snap: OfficeSnapshotInput = {
    status: { peers: Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`peer-${String(i).padStart(2, "0")}`, { state: "idle" }])) },
    tasks: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, title: `task ${i}`, class: "implement", state: "proposed" })),
  };
  const model = officeModel(snap, null, { cols: 4 });
  const todo = model.rooms.find((room) => room.id === "todo")!;
  expect(todo.count).toBe(10);
  expect(todo.cards).toHaveLength(8);
  expect(todo.overflow).toBe(2);
  expect(todo.filterState).toBe("proposed");
  expect(model.desks).toHaveLength(12);
  expect(model.extraPeers).toBe(2);
});

test("every peer condition has a distinct glyph and a label", () => {
  const snap = (state: string, extra: Record<string, unknown> = {}, permissions: { peer: string }[] = []): OfficeSnapshotInput =>
    ({ status: { peers: { codex: { state, ...extra } } }, tasks: [], permissions });
  const seen = new Map<string, { glyph: string; label: string }>();
  for (const [snapshot, condition] of [
    [snap("idle"), "idle"],
    [snap("busy"), "busy"],
    [snap("offline"), "offline"],
    [snap("paused"), "paused"],
    [snap("busy", {}, [{ peer: "codex" }]), "waiting"],
  ] as const) {
    const desk = officeModel(snapshot, null, { cols: 1 }).desks[0]!;
    expect(desk.condition).toBe(condition);
    expect(desk.glyph).toBeTruthy();
    expect(desk.label).toBeTruthy();
    seen.set(condition, { glyph: desk.glyph, label: desk.label });
  }
  expect(new Set([...seen.values()].map((entry) => entry.glyph)).size).toBe(5);
  expect(new Set([...seen.values()].map((entry) => entry.label)).size).toBe(5);
});

test("MARKER: no body, detail, approval title or PII text enters the serialized model", () => {
  const MARKER = "XYZZY-MARKER-264";
  const dirty = {
    status: { peers: { codex: { state: "busy", queued: 1 }, pi: { state: "idle" } } },
    tasks: [
      { id: 1, title: "[pii]", detail: `${MARKER} private detail`, class: "implement", state: "in_progress", owner: "codex", deps: [] },
      { id: 2, title: "public title", detail: `${MARKER} other detail`, class: "test", state: "proposed", deps: [] },
    ],
    permissions: [{ id: "p1", peer: "codex", title: `${MARKER} approval title`, options: [] }],
    events: [{ seq: 1, event: { env: { from: "codex", to: ["pi"], kind: "chat", body: `${MARKER} envelope body` } } }],
    budget: { codex: { windows: [], paused: null } },
  } as unknown as OfficeSnapshotInput;
  expect(JSON.stringify(dirty)).toContain(MARKER); // the fixture itself carries the marker
  const model = officeModel(dirty, null, { cols: 4, now: 1000 });
  expect(JSON.stringify(model)).not.toContain(MARKER);
  const again = officeModel(dirty, model, { cols: 4, now: 2000 });
  expect(JSON.stringify(again)).not.toContain(MARKER);
  // A fresh envelope row with a marker body draws an arc that carries no marker either.
  const flowing = officeModel({
    ...dirty,
    events: [{ seq: 9, event: { t: "envelope", env: { from: "codex", to: ["pi"], kind: "chat", priority: "status", ts: 1500, body: `${MARKER} new body`, refs: { task: "1" } } } }],
  }, model, { cols: 4, now: 3000 });
  expect(flowing.arcs).toHaveLength(1);
  expect(JSON.stringify(flowing)).not.toContain(MARKER);
  // Phase 3: markers in turn-adjacent data, check output and conflict reasons never reach the model.
  const phased = officeModel({
    ...dirty,
    status: { peers: { codex: { state: "busy", turn: { since: 1, task: 1, attribution: "delivery", note: MARKER } }, pi: { state: "idle" } } },
    tasks: (dirty.tasks as unknown as Record<string, unknown>[]).map((task) => ({ ...task, checking: true, checkOutput: MARKER })),
    links: [{ kind: "conflict", tasks: [1, 2], peers: ["codex", "pi"], reason: MARKER, paths: [MARKER] }],
  } as unknown as OfficeSnapshotInput, model, { cols: 4, now: 4000 });
  expect(phased.links).toEqual([{ kind: "conflict", tasks: [1, 2], peers: ["codex", "pi"] }]);
  expect(phased.desks[0]!.bubble).toBe("#1 implement");
  expect(JSON.stringify(phased)).not.toContain(MARKER);
  // The PII stub is carried as the public title, nothing more.
  expect(model.desks[0]!.cards[0]!.name).toContain("[pii]");
  expect(model.desks[0]!.cards[0]!.label).toBe("#1 [pii]");
  expect(model.rooms[0]!.cards[0]!.label).toBe("#2 public title");
});

test("room cards fit one padded column at the fixed pixel scale, with space for overflow", () => {
  const tasks = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, title: `Readable public title ${index + 1}`, class: "implement", state: "proposed" }));
  const model = officeModel({ status: { peers: {} }, tasks }, null, { cols: 1, now: 1000 });
  const room = model.rooms[0]!;
  expect(room).toMatchObject({ x: 0, y: 0, w: 22, h: 29, count: 12, overflow: 4 });
  expect(room.cards.map((card) => card.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  for (const [index, card] of room.cards.entries()) {
    expect(card.x).toBe(room.x + 1); // 12 px inner padding
    expect(card.w).toBe(20);
    expect(card.h * 12).toBeCloseTo(28);
    expect(card.y).toBeCloseTo(room.y + 3.4 + index * (34 / 12));
    expect(card.x + card.w).toBe(room.x + room.w - 1);
    expect(card.label).toBe(`#${card.id} Readable public title ${card.id}`);
    expect(model.placed[card.id]).toBe("room:todo");
    if (index) expect((card.y - room.cards[index - 1]!.y - card.h) * 12).toBeCloseTo(6);
  }
  const last = room.cards.at(-1)!;
  expect(room.y + room.h - last.y - last.h).toBeGreaterThan(3); // overflow line plus bottom padding
  expect(model.rooms.map((entry) => entry.y)).toEqual([0, 30, 60, 90]);
  expect(model.height).toBe(119);
  for (const [index, entry] of model.rooms.entries()) {
    if (index) expect(entry.y - model.rooms[index - 1]!.y - entry.h).toBe(1);
  }
  const empty = officeModel({ status: { peers: {} }, tasks: [] }, null, { cols: 1, now: 1000 });
  expect(empty.rooms.every((entry) => entry.count === 0 && entry.cards.length === 0 && entry.overflow === 0)).toBe(true);
});

test("cols reflows rooms: left to right when wide, stacked when narrow", () => {
  const wide = officeModel(fixture(), null, { cols: 4, now: 1000 });
  // Six desks take two rows, so the rooms row starts below the desk grid.
  expect(wide.rooms.map((room) => [room.x, room.y])).toEqual([[0, 47], [23, 47], [46, 47], [69, 47]]);
  expect(wide.width).toBe(91);
  const twoColumns = officeModel(fixture(), null, { cols: 2, now: 1000 });
  expect(twoColumns.rooms.map((room) => [room.x, room.y])).toEqual([[0, 47], [23, 47], [0, 77], [23, 77]]);
  expect(twoColumns.rooms[1]!.x - twoColumns.rooms[0]!.x - twoColumns.rooms[0]!.w).toBe(1);
  expect(twoColumns.rooms[2]!.y - twoColumns.rooms[0]!.y - twoColumns.rooms[0]!.h).toBe(1);
  expect(twoColumns.width).toBe(46); // desks extend one unit past the room grid
  expect(twoColumns.height).toBe(106);
  const narrow = officeModel(fixture(), null, { cols: 1, now: 1000 });
  const ys = narrow.rooms.map((room) => room.y);
  expect(new Set(narrow.rooms.map((room) => room.x)).size).toBe(1);
  expect(ys).toEqual([...ys].sort((a, b) => a - b));
  expect(narrow.width).toBe(46); // the four desk columns are wider than one room
  // The model is deterministic: same inputs, same scene.
  expect(officeModel(fixture(), null, { cols: 4, now: 1000 })).toEqual(wide);
});

const envelope = (seq: number, over: Record<string, unknown> = {}) => ({
  seq, event: { t: "envelope", env: { from: "codex", to: ["claude"], kind: "chat", priority: "status", ts: 10_000, ...over } },
});

test("message arcs come from envelope rows: from, to, kind, priority, task ref and dropped only", () => {
  const first = officeModel(fixture(), null, { cols: 4, now: 10_000 });
  expect(first.arcs).toEqual([]);
  const snap = { ...fixture(), events: [
    envelope(1, { refs: { task: "4" }, priority: "important" }),
    envelope(2, { from: "user", to: undefined }),
    envelope(3, { from: "hub", to: ["kimi", "pi"], kind: "task", ts: 10_500 }),
    { seq: 4, event: { t: "envelope", dropped: "fyi", env: { from: "kimi", to: ["pi"], kind: "chat", priority: "fyi", ts: 10_600 } } },
  ] };
  const model = officeModel(snap, first, { cols: 4, now: 11_000 });
  expect(model.arcs.map((arc) => [arc.seq, arc.from, arc.to, arc.kind, arc.priority, arc.task, arc.dropped])).toEqual([
    [1, "codex", ["claude"], "chat", "important", "4", ""],
    [2, "user", [], "chat", "status", "", ""],
    [3, "hub", ["kimi", "pi"], "task", "status", "", ""],
    [4, "kimi", ["pi"], "chat", "fyi", "", "fyi"],
  ]);
  expect(model.arcs[0]!.until).toBe(20_000); // env ts + 10 s fade horizon
  expect(model.arcs[2]!.until).toBe(20_500);
  expect(model.lastSeq).toBe(4);
  expect(model.eventTime).toBe(10_600);
  // Re-rendering the same snapshot is idempotent: seqs are consumed once, and an
  // unchanged snapshot at a later wall time yields an identical model (no DOM write).
  expect(officeModel(snap, model, { cols: 4, now: 99_000 })).toEqual(model);
});

test("no replay: the first snapshot after load or a project switch consumes events without drawing them", () => {
  const snap = { ...fixture(), events: [
    envelope(1), envelope(2, { ts: 9_000 }),
    { seq: 3, event: { t: "overflow", peer: "kimi", env: { from: "claude", to: ["kimi"], kind: "chat", ts: 9_100 } } },
    { seq: 4, event: { t: "state", peer: "claude", state: "busy" } },
  ] };
  const model = officeModel(snap, null, { cols: 4, now: 10_000 });
  expect(model.arcs).toEqual([]);
  expect(model.alerts).toEqual([]);
  expect(model.latched).toEqual({});
  expect(model.settle).toBe(true);
  expect(model.lastSeq).toBe(4);
  expect(model.eventTime).toBe(10_000); // the newest envelope ts wins, regardless of row order
  // Only rows after that are drawn.
  const next = officeModel({ ...fixture(), events: [envelope(5, { ts: 10_200 })] }, model, { cols: 4, now: 11_000 });
  expect(next.arcs.map((arc) => arc.seq)).toEqual([5]);
});

test("delivery warning marks come from overflow, undeliverable, stale and quiet rows", () => {
  const first = officeModel(fixture(), null, { cols: 4, now: 10_000 });
  const model = officeModel({ ...fixture(), events: [
    { seq: 1, event: { t: "overflow", peer: "kimi", env: { from: "claude", to: ["kimi"], kind: "chat", ts: 10_000 } } },
    { seq: 2, event: { t: "undeliverable", peer: "pi", reason: "marker-free", env: { from: "claude", to: ["pi"], kind: "chat", ts: 10_000 } } },
    { seq: 3, event: { t: "stale", peer: "pi", reason: "marker-free", env: { from: "claude", to: ["pi"], kind: "chat", ts: 10_000 } } },
    { seq: 4, event: { t: "quiet", peers: ["codex", "qwen"], reason: "marker-free", env: { from: "claude", to: ["codex"], kind: "chat", ts: 10_000 } } },
    { seq: 5, event: { t: "off_roster", peers: ["kimi"], env: { from: "claude", to: ["kimi"], kind: "chat", ts: 10_000 } } },
  ] }, first, { cols: 4, now: 12_000 });
  expect(model.alerts.map((alert) => [alert.peer, alert.kind])).toEqual([
    ["kimi", "overflow"], ["pi", "undeliverable"], ["pi", "stale"], ["codex", "quiet"], ["qwen", "quiet"],
  ]);
  for (const alert of model.alerts) expect(alert.until).toBe(22_000);
  expect(JSON.stringify(model.alerts)).not.toContain("marker-free"); // reasons never enter
});

test("the busy latch keeps a short turn visible for a few seconds, once per state row", () => {
  const first = officeModel(fixture(), null, { cols: 4, now: 10_000 });
  const snap = { ...fixture(), events: [{ seq: 1, event: { t: "state", peer: "qwen", state: "busy" } }] };
  const model = officeModel(snap, first, { cols: 4, now: 10_400 });
  expect(model.latched.qwen).toEqual({ seq: 1, until: 13_400 });
  // qwen is idle in the status, so the latch is what keeps the turn visible; a busy peer needs none.
  expect(model.desks.find((desk) => desk.id === "qwen")!.condition).toBe("idle");
  const again = officeModel(snap, model, { cols: 4, now: 12_000 });
  expect(again.latched.qwen).toEqual({ seq: 1, until: 13_400 }); // same row, same latch
  expect(again).toEqual(model);
});

test("arcs expire on the snapshot's own envelope clock and purge on a later changed render", () => {
  const first = officeModel(fixture(), null, { cols: 4, now: 10_000 });
  const second = officeModel({ ...fixture(), events: [envelope(1, { ts: 10_000 })] }, first, { cols: 4, now: 10_100 });
  expect(second.arcs).toHaveLength(1); // until 20_000
  // New envelopes arrive before expiry: the old arc is still within its 10 s.
  const third = officeModel({ ...fixture(), events: [envelope(2, { ts: 19_999 })] }, second, { cols: 4, now: 20_000 });
  expect(third.arcs.map((arc) => arc.seq)).toEqual([1, 2]);
  // The snapshot clock passes the expiry: the arc purges with that changed render.
  const fourth = officeModel({ ...fixture(), events: [envelope(3, { ts: 20_001 })] }, third, { cols: 4, now: 20_100 });
  expect(fourth.arcs.map((arc) => arc.seq)).toEqual([2, 3]);
});

test("the settle rule: gap over 3 s or more than 6 transitions jumps to final positions", () => {
  const base = officeModel(fixture(), null, { cols: 4, now: 10_000 });
  expect(base.settle).toBe(true); // first snapshot
  const oneMove = fixture();
  oneMove.tasks = oneMove.tasks!.map((task) => task.id === 2 ? { ...task, state: "in_progress", owner: "codex" } : task);
  expect(officeModel(oneMove, base, { cols: 4, now: 10_800 }).settle).toBe(false); // 1 move, 0.8 s gap
  expect(officeModel(oneMove, base, { cols: 4, now: 13_001 }).settle).toBe(true); // gap over 3 s
  const storm = fixture();
  storm.tasks = storm.tasks!.map((task) =>
    task.id === 2 || task.id === 3 ? { ...task, state: "in_progress", owner: "codex" }
    : task.id === 4 ? { ...task, owner: "claude" }
    : task.id === 5 ? { ...task, state: "approved" }
    : task.id === 6 ? { ...task, owner: "kimi" }
    : task.id === 7 ? { ...task, state: "proposed", owner: "" } : task);
  storm.status!.peers = Object.fromEntries(Object.entries(storm.status!.peers!).filter(([id]) => id !== "qwen"));
  const stormy = officeModel(storm, base, { cols: 4, now: 10_500 });
  expect(stormy.transitions.cardsMoved.length + stormy.transitions.desksRemoved.length).toBe(7);
  expect(stormy.settle).toBe(true);
  // The settle flag itself is stable: carrying it must not churn an unchanged snapshot.
  const after = officeModel(storm, stormy, { cols: 4, now: 11_000 });
  expect(after.settle).toBe(true);
  expect(officeModel(storm, after, { cols: 4, now: 12_000 })).toEqual(after);
});

test("phase 3: the open turn names the exact task bubble; without it the heuristic applies", () => {
  const snap: OfficeSnapshotInput = {
    status: {
      peers: {
        codex: { state: "busy", turn: { since: 9000, task: 5, attribution: "delivery" } },
        kimi: { state: "busy", turn: { since: 9000, attribution: "unattributed" } },
        claude: { state: "busy" },
      },
    },
    tasks: [
      { id: 4, title: "one", class: "implement", state: "in_progress", owner: "codex" },
      { id: 5, title: "two", class: "review", state: "in_progress", owner: "codex" },
      { id: 6, title: "three", class: "test", state: "in_review", owner: "kimi", reviewer: "claude" },
      { id: 7, title: "four", class: "plan", state: "in_progress", owner: "claude" },
    ],
  };
  const desks = new Map(officeModel(snap, null, { cols: 4, now: 10_000 }).desks.map((desk) => [desk.id, desk]));
  // codex has two in_progress tasks, so the heuristic would say nothing; the turn names task 5 exactly.
  expect(desks.get("codex")!.bubble).toBe("#5 review");
  expect(desks.get("codex")!.name).toBe("codex: busy on task #5 review");
  // An unattributed turn carries no task: the heuristic finds kimi has no in_progress task, so no bubble.
  expect(desks.get("kimi")!.bubble).toBe("");
  // No turn field (an older daemon): the single in_progress task heuristic still applies.
  expect(desks.get("claude")!.bubble).toBe("#7 plan");
  // A turn task that is no longer on the board still bubbles by id, with a plain label.
  const gone = officeModel({ status: { peers: { codex: { state: "busy", turn: { since: 1, task: 99, attribution: "delivery" } } } }, tasks: [] }, null, { cols: 1, now: 100 });
  expect(gone.desks[0]!.bubble).toBe("#99 task");
});

test("phase 3: a paused peer with an open turn is finishing a turn", () => {
  const model = officeModel({
    status: {
      peers: {
        kimi: { state: "paused", paused: "quota exhausted", turn: { since: 9000, task: 4, attribution: "delivery" } },
        codex: { state: "busy", turn: { since: 9000, task: 4, attribution: "delivery" } },
      },
    },
    tasks: [{ id: 4, title: "work", class: "implement", state: "in_progress", owner: "codex" }],
  }, null, { cols: 4, now: 10_000 });
  const kimi = model.desks.find((desk) => desk.id === "kimi")!;
  expect(kimi.condition).toBe("paused");
  expect(kimi.finishing).toBe(true);
  expect(kimi.name).toBe("kimi: paused: quota exhausted, finishing a turn");
  expect(model.desks.find((desk) => desk.id === "codex")!.finishing).toBe(false);
  // Without a turn a paused peer is just on a break.
  const plain = officeModel({ status: { peers: { kimi: { state: "paused" } } }, tasks: [] }, null, { cols: 1, now: 100 });
  expect(plain.desks[0]!.finishing).toBe(false);
});

test("phase 3: a checking task keeps its place and is marked, and links pass through as ids only", () => {
  const model = officeModel({
    status: { peers: { codex: { state: "busy" }, kimi: { state: "busy" } } },
    tasks: [
      { id: 4, title: "build", class: "implement", state: "in_progress", owner: "codex", checking: true },
      { id: 5, title: "other", class: "implement", state: "in_progress", owner: "kimi" },
    ],
    links: [
      { kind: "overlap", tasks: [4, 5], peers: ["codex", "kimi"], paths: ["secret-path"], note: "marker text" },
      { kind: "conflict", tasks: [5, 4], peers: ["kimi", "codex"], reason: "marker text" },
      { kind: "cohort", tasks: [4, 5], peers: ["codex", "kimi"] },
      { kind: "mystery", tasks: [4, 5], peers: ["codex"] },
      { kind: "overlap", tasks: ["4"], peers: [] },
      "junk",
    ] as OfficeSnapshotInput["links"],
  }, null, { cols: 4, now: 10_000 });
  const card = model.desks.find((desk) => desk.id === "codex")!.cards[0]!;
  expect(card.checking).toBe(true);
  expect(card.name).toContain("check running");
  expect(model.placed[4]).toBe("desk:codex"); // rooms follow states only: checking never moves the card
  expect(model.links).toEqual([
    { kind: "overlap", tasks: [4, 5], peers: ["codex", "kimi"] },
    { kind: "conflict", tasks: [5, 4], peers: ["kimi", "codex"] },
    { kind: "cohort", tasks: [4, 5], peers: ["codex", "kimi"] },
  ]);
  expect(JSON.stringify(model.links)).not.toContain("secret-path");
  expect(JSON.stringify(model.links)).not.toContain("marker text");
});

test("phase 3 fields are optional both ways: an older daemon's snapshot models as before", () => {
  const model = officeModel(fixture(), null, { cols: 4, now: 1000 });
  expect(model.links).toEqual([]);
  for (const desk of model.desks) expect(desk.finishing).toBe(false);
  for (const desk of model.desks) for (const card of desk.cards) expect(card.checking).toBe(false);
});

test("sticky desk bounds and work overflow remain correct after peers leave (#264 merge)", () => {
  const first = officeModel({ status: { peers: Object.fromEntries(["claude", "codex", "kimi", "pi", "local"].map(id => [id, { state: "idle" }])) }, tasks: [] }, null, { cols: 1, now: 1000 });
  const sparse = officeModel({ status: { peers: { local: { state: "idle" } } }, tasks: Array.from({ length: 10 }, (_, i) => ({ id: i+1, class: "implement", state: "changes_requested", title: "rework" })) }, first, { cols: 1, now: 1100 });
  const desk = sparse.desks[0]!;
  expect(sparse.width).toBeGreaterThanOrEqual(desk.x+desk.w);
  expect(sparse.rooms[0]!.y).toBeGreaterThan(desk.y+desk.h);
  expect(sparse.rooms.find(room => room.id === "work")).toMatchObject({ filterState: "work", overflow: 2 });
});

test("explicit unattributed turns suppress bubbles while legacy snapshots retain fallback (#264 merge)", () => {
  const tasks = [{ id: 1, state: "in_progress", class: "implement", title: "work", owner: "codex" }];
  const model = (peer: object) => officeModel({ status: { peers: { codex: { state: "busy", ...peer } } }, tasks }, null, { cols: 1, now: 1000 });
  expect(model({}).desks[0]!.bubble).toBe("#1 implement");
  expect(model({ turn: { since: 1, attribution: "unattributed" } }).desks[0]!.bubble).toBe("");
  expect(model({ turn: { since: 1, attribution: "pii" } }).desks[0]!.bubble).toBe("");
});

test("conflict and cohort warnings survive a large overlap cap without reordering small snapshots (#264 merge)", () => {
  const links = [...Array.from({ length: 28 }, (_, i) => ({ kind: "overlap", tasks: [i+1, i+2], peers: ["codex", "claude"] })), { kind: "conflict", tasks: [1,2], peers: ["codex", "claude"] }, { kind: "cohort", tasks: [1,2], peers: ["codex", "claude"] }];
  const model = officeModel({ status: { peers: {} }, tasks: [], links }, null, { cols: 1, now: 1000 });
  expect(model.links).toHaveLength(24);
  expect(model.links.some(link => link.kind === "conflict")).toBe(true);
  expect(model.links.some(link => link.kind === "cohort")).toBe(true);
});


test("a sparse rightmost sticky desk remains inside a narrow office view (#264 merge)", () => {
  const first = officeModel({status:{peers:Object.fromEntries(["claude","codex","kimi","pi","local"].map(id=>[id,{state:"idle"}]))},tasks:[]},null,{cols:1,now:1000});
  const sparse = officeModel({status:{peers:{pi:{state:"idle"}}},tasks:[]},first,{cols:1,now:1100});
  const desk=sparse.desks[0]!;expect(sparse.width).toBeGreaterThanOrEqual(desk.x+desk.w);
});


test("office recognizes staged backlog and matches the shared progress counts (#264 merge)", () => {
  const tasks=[{id:1,title:"staged",class:"implement",state:"backlog",deps:[99]},{id:2,title:"work",class:"implement",state:"proposed",deps:[]}];
  const model=officeModel({status:{peers:{}},tasks},null,{cols:1,now:1000});
  expect(model.counts).toEqual(taskProgress(tasks).counts);
  expect(model.counts.backlog).toBe(1);expect(model.counts.unknown).toBeUndefined();
  expect(model.placed[1]).toBe("counted:backlog");
  expect(model.rooms.flatMap(room=>room.cards).some(card=>card.id===1)).toBe(false);
});
