import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { MILESTONE_HISTORY_LIMIT, milestoneHistory } from "../src/hub/roadmap.ts";
import { exactForm, instructedExecution, type InstructedExecution } from "../src/hub/instructed-exact.ts";
import { intentForm, intentRefusal, literalInstructionIds } from "../src/hub/instructed-intent.ts";

// #1622 family 4 (hub task 1081): an instructed milestone verdict carries the same three provenance keys task history does.
const RECEIPT = "3004bef3-8884-4e54-bbf2-c5c760a52090";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function rig() {
  const root = mkdtempSync(join(tmpdir(), "ahub-roadmap-instructed-")); roots.push(root);
  const board = new Board(join(root, "hub.db")), bus = new Bus({ batchMs: 0 });
  const tasks = new Tasks({ cwd: root, board, bus, project: "project", routing: () => loadRouting(root), notify: () => {} });
  return { root, board, tasks, file: join(root, "hub.db") };
}
const binding = (over: Partial<InstructedExecution> = {}): InstructedExecution => ({ peer: "claude", receipt: RECEIPT, active: true, current: () => {}, ...over });
const created = (board: Board, state: "active" | "proposed" = "active") => board.newMilestone({ title: "Goal", outcome: "Outcome", state }, "user", 1000);

test("the history parser accepts exactly the three task-history keys together, only on a state entry naming the state field", () => {
  const ok = { at: 1, by: "user", event: "state" as const, fields: ["state"], instructed: true as const, instructedPeer: "claude", instructionReceipt: RECEIPT };
  expect(milestoneHistory([ok])[0]).toEqual(ok);
  const bad: Record<string, unknown>[] = [
    { ...ok, event: "edited" }, { ...ok, fields: ["title"] }, { ...ok, fields: undefined }, { ...ok, fields: ["state", "title"] },
    { ...ok, instructed: false }, { ...ok, instructed: "true" }, { ...ok, instructedPeer: undefined }, { ...ok, instructionReceipt: undefined },
    { ...ok, instructedPeer: "Claude" }, { ...ok, instructedPeer: "x".repeat(65) }, { ...ok, instructionReceipt: "not-a-uuid" }, { ...ok, extra: 1 },
  ];
  for (const row of bad) expect(() => milestoneHistory([row])).toThrow();
  const legacy = { at: 1, by: "user", event: "state" as const, fields: ["state"] };
  expect(milestoneHistory([legacy])[0]).toEqual(legacy); // an old-format row still parses
});

test("an instructed done or dropped verdict writes the provenance; ordinary and non-final writes never do", () => {
  const { board, tasks } = rig();
  const done = created(board), dropped = created(board), plain = created(board), planned = created(board, "proposed");
  instructedExecution.run(binding(), () => {
    tasks.milestoneState("user", done.id, "done"); tasks.milestoneState("user", dropped.id, "dropped"); tasks.milestoneState("user", planned.id, "planned");
  });
  tasks.milestoneState("user", plain.id, "done"); // the person's own terminal run
  const last = (id: number) => board.milestone(id)!.history.at(-1)!;
  expect(last(done.id)).toMatchObject({ by: "user", event: "state", fields: ["state"], instructed: true, instructedPeer: "claude", instructionReceipt: RECEIPT });
  expect(last(dropped.id)).toMatchObject({ instructed: true, instructedPeer: "claude", instructionReceipt: RECEIPT });
  expect(last(planned.id)).not.toHaveProperty("instructed"); // a non-final state stays person-only and unmarked
  expect(last(plain.id)).not.toHaveProperty("instructed");
  expect(JSON.stringify(board.milestone(done.id)!.history)).not.toMatch(/prompt|transcript|session/);
});

test("the board refuses provenance on any write that is not a done or dropped state change", () => {
  const { board } = rig(), m = created(board);
  const forged = { at: 2000, by: "user", event: "state" as const, fields: ["state"], instructed: true as const, instructedPeer: "claude", instructionReceipt: RECEIPT };
  expect(() => board.updateMilestone(m.id, { state: "planned" }, m.revision, forged)).toThrow(/done or dropped/);
  expect(() => board.updateMilestone(m.id, { title: "T" }, m.revision, { ...forged, event: "edited" })).toThrow();
  expect(board.milestone(m.id)).toEqual(m);
  expect(board.updateMilestone(m.id, { state: "done" }, m.revision, forged).history.at(-1)).toMatchObject({ instructed: true });
});

test("a revoked or stale instruction leaves the milestone and its history unchanged", () => {
  const { board } = rig(), m = created(board);
  const before = board.milestone(m.id);
  expect(() => instructedExecution.run(binding({ current: () => { throw new Error("instruction authority revoked"); } }), () => { binding().current(); throw new Error("instruction authority revoked"); })).toThrow(/revoked/);
  expect(board.milestone(m.id)).toEqual(before);
  // A stale revision (another writer changed it first) refuses and writes nothing.
  board.updateMilestone(m.id, { title: "Moved" }, m.revision, { at: 3000, by: "user", event: "edited", fields: ["title"] });
  expect(() => board.updateMilestone(m.id, { state: "done" }, m.revision, { at: 3001, by: "user", event: "state", fields: ["state"], instructed: true, instructedPeer: "claude", instructionReceipt: RECEIPT })).toThrow(/revision changed/);
  expect(board.milestone(m.id)!.state).toBe("active");
  expect(board.milestone(m.id)!.history.some(entry => entry.instructed)).toBe(false);
});

test("the last of the 256 history slots stays available to an instructed settlement", () => {
  const { board, tasks } = rig(), m = created(board);
  let revision = 0;
  for (let n = 0; n < MILESTONE_HISTORY_LIMIT - 2; n++) revision = board.updateMilestone(m.id, { order: n % 2 }, revision, { at: 2000 + n, by: "user", event: "ordered" }).revision;
  expect(board.milestone(m.id)!.history).toHaveLength(MILESTONE_HISTORY_LIMIT - 1);
  expect(() => board.updateMilestone(m.id, { order: 5 }, revision, { at: 9000, by: "user", event: "ordered" })).toThrow(/reserves its last slot/);
  instructedExecution.run(binding(), () => tasks.milestoneState("user", m.id, "done"));
  const row = board.milestone(m.id)!;
  expect(row.state).toBe("done"); expect(row.history).toHaveLength(MILESTONE_HISTORY_LIMIT);
  expect(row.history.at(-1)).toMatchObject({ instructed: true, instructionReceipt: RECEIPT });
});

test("intent form admits only roadmap state done or dropped for one literal positive id", () => {
  expect(intentForm(["roadmap", "state", "12", "done"])).toEqual({ argv: ["roadmap", "state", "12", "done"], verdictIds: ["12"] });
  expect(intentForm(["roadmap", "state", "12", "dropped"])).toEqual({ argv: ["roadmap", "state", "12", "dropped"], verdictIds: ["12"] });
  for (const args of [["roadmap", "state", "12", "active"], ["roadmap", "state", "12", "planned"], ["roadmap", "state", "12", "proposed"], ["roadmap", "state", "0", "done"], ["roadmap", "state", "-1", "done"],
    ["roadmap", "state", "1.5", "done"], ["roadmap", "state", "012", "done"], ["roadmap", "state", "12"], ["roadmap", "state", "12", "done", "extra"], ["roadmap", "state", "12", "done", "--json"],
    ["roadmap", "state", "done", "12"], ["roadmap", "edit", "12"], ["roadmap", "state", "12", "done", "--as-user"], ["roadmap", "--json", "state", "12", "done"]]) expect(intentForm(args)).toBeUndefined();
  expect(intentRefusal(["roadmap", "state", "12", "active"])).toContain("done or dropped");
  // The literal-id rule the daemon applies to verdictIds.
  expect(literalInstructionIds("mark milestone 12 as done", ["12"])).toBe(true);
  expect(literalInstructionIds("mark milestone as done", ["12"])).toBe(false);
  expect(literalInstructionIds("mark milestone 123 as done", ["12"])).toBe(false);
  expect(literalInstructionIds("mark milestone v12 as done", ["12"])).toBe(false);
});

test("exact mode admits the same form with the person's typed operands executed once, and nothing wider", () => {
  expect(exactForm(["roadmap", "state", "12", "done"])).toEqual({ argv: ["roadmap", "state", "12", "done"] });
  expect(exactForm(["roadmap", "state", "12", "dropped"])).toEqual({ argv: ["roadmap", "state", "12", "dropped"] });
  for (const args of [["roadmap", "state", "12", "active"], ["roadmap", "state", "12"], ["roadmap", "state", "0", "done"], ["roadmap", "state", "12", "done", "x"], ["roadmap", "edit", "12"], ["roadmap", "state", "12", "done", "--as-user"], ["roadmap", "state", "12", "done", "--project", "/x"]]) expect(exactForm(args)).toBeUndefined();
});

test("recovery floor: roadmap_instructed is advertised, retained only while an instructed entry exists, and old rows still read", () => {
  expect(DAEMON_FEATURES).toContain("roadmap_instructed");
  const { board, tasks, file } = rig(), a = created(board), b = created(board);
  expect(board.hasInstructedMilestoneHistory()).toBe(false); // none yet: a target without the feature is accepted
  tasks.milestoneState("user", a.id, "done"); // the person's own run
  expect(board.hasInstructedMilestoneHistory()).toBe(false);
  instructedExecution.run(binding(), () => tasks.milestoneState("user", b.id, "dropped"));
  expect(board.hasInstructedMilestoneHistory()).toBe(true); // retained: a target without the feature is refused
  board.close();
  const reopened = new Board(file);
  try {
    expect(reopened.hasInstructedMilestoneHistory()).toBe(true);
    expect(reopened.milestone(a.id)!.history.at(-1)).not.toHaveProperty("instructed"); // the old-format row still parses
    expect(reopened.milestone(b.id)!.history.at(-1)).toMatchObject({ instructed: true });
    expect(reopened.roadmapIntegrity().milestones).toBe(2);
  } finally { reopened.close(); }
  const raw = new Database(file); // a daemon that predates the field throws on this row: that is why the floor exists
  try { expect(String((raw.query("SELECT history FROM milestones WHERE id=?").get(b.id) as { history: string }).history)).toContain("\"instructionReceipt\""); } finally { raw.close(); }
});
