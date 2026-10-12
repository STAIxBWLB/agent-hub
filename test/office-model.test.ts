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
  const rooms = new Map(model.rooms.map((room) => [room.id, room]));
  expect(rooms.get("todo")!.count).toBe(2);
  expect(rooms.get("todo")!.cards.map((card) => [card.id, card.waiting])).toEqual([[2, false], [3, true]]);
  expect(rooms.get("todo")!.cards[1]!.name).toContain("waiting on dependencies");
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
  expect(many.desks[0]!.cards).toHaveLength(3);
  expect(many.desks[0]!.extraCards).toBe(2);
  // A work card whose owner has no desk waits in the Work floor room instead.
  const orphan = officeModel({ status: { peers: {} }, tasks: [{ id: 9, title: "ownerless", class: "implement", state: "in_progress" }] }, null, { cols: 1 });
  expect(orphan.rooms.find((room) => room.id === "work")!.cards.map((card) => card.id)).toEqual([9]);
  expect(orphan.placed[9]).toBe("room:work");
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
  const model = officeModel(dirty, null, { cols: 4 });
  expect(JSON.stringify(model)).not.toContain(MARKER);
  const again = officeModel(dirty, model, { cols: 4 });
  expect(JSON.stringify(again)).not.toContain(MARKER);
  // The PII stub is carried as the public title, nothing more.
  expect(model.desks[0]!.cards[0]!.name).toContain("[pii]");
});

test("cols reflows rooms: left to right when wide, stacked when narrow", () => {
  const wide = officeModel(fixture(), null, { cols: 4 });
  // Six desks take two rows, so the rooms row starts below the desk grid.
  expect(wide.rooms.map((room) => [room.x, room.y])).toEqual([[0, 31], [24, 31], [48, 31], [72, 31]]);
  expect(wide.width).toBe(94);
  const narrow = officeModel(fixture(), null, { cols: 1 });
  const ys = narrow.rooms.map((room) => room.y);
  expect(new Set(narrow.rooms.map((room) => room.x)).size).toBe(1);
  expect(ys).toEqual([...ys].sort((a, b) => a - b));
  expect(narrow.width).toBe(46); // the four desk columns are wider than one room
  // The model is deterministic: same inputs, same scene.
  expect(officeModel(fixture(), null, { cols: 4 })).toEqual(wide);
});
