import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { MILESTONE_HISTORY_LIMIT, milestoneLinkRef, parseMilestoneInput, parseMilestonePatch, type MilestoneLinkKind } from "../src/hub/roadmap.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-roadmap-board-")), file = join(dir, "hub.db");
  let board = new Board(file);
  cleanup.push(() => { board.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get board() { return board; }, file, reopen() { board = new Board(file); return board; } };
}
const create = (board: Board, title = "Milestone") => board.newMilestone({ title, outcome: "Working outcome" }, "user", 1000);
const edit = (at = 2000) => ({ at, by: "user", event: "edited" as const });

test("additive roadmap migration preserves existing task and release data across reopen", () => {
  const fixture = rig(), task = fixture.board.propose("user", { title: "Existing task", class: "implement" });
  const release = fixture.board.newRelease("old", "Existing train", 2);
  fixture.board.close();
  const old = new Database(fixture.file);
  old.run("DROP TABLE milestone_links"); old.run("DROP TABLE milestones"); old.close();
  const board = fixture.reopen();
  expect(board.get(task.id)?.title).toBe("Existing task");
  expect(board.release(release.id)?.goal).toBe("Existing train");
  expect(board.milestones()).toEqual([]);
  const milestone = create(board);
  expect(milestone).toMatchObject({ state: "proposed", horizon: "later", order: 0, revision: 0, parent: null, target: null });
  board.close(); fixture.reopen();
  expect(fixture.board.milestone(milestone.id)).toEqual(milestone);
});

test("revision CAS rejects stale metadata and link writes without changing stored data", () => {
  const { board } = rig(), first = create(board);
  const changed = board.updateMilestone(first.id, { title: "Changed", target: "2028-02-29", state: "planned", horizon: "now", order: 3 }, 0, edit());
  expect(changed.revision).toBe(1);
  expect(changed.history.at(-1)).toEqual(edit());
  expect(() => board.updateMilestone(first.id, { title: "Lost update" }, 0, edit())).toThrow("revision changed");
  expect(() => board.linkMilestone(first.id, "task", "1", "user", 0)).toThrow("revision changed");
  expect(board.milestone(first.id)).toEqual(changed);
  expect(board.milestoneLinks(first.id)).toEqual([]);
});

test("all link kinds canonicalize, link once, unlink once and retain metadata-only history", () => {
  const { board } = rig(); let milestone = create(board);
  const links: [MilestoneLinkKind, string][] = [["spec", "architecture:hub"], ["issue", "Example/Project#42"], ["task", "2"], ["release", "3"]];
  for (const [kind, ref] of links) {
    milestone = board.linkMilestone(milestone.id, kind, ref, "planner", milestone.revision, 2000);
    expect(board.linkMilestone(milestone.id, kind, ref, "user", milestone.revision, 3000)).toEqual(milestone);
  }
  expect(board.milestoneLinks()).toHaveLength(4);
  expect(board.milestoneLinks(milestone.id).find(link => link.kind === "issue")).toEqual({ milestone: milestone.id, kind: "issue", ref: "example/project#42", by: "planner", at: 2000 });
  expect(milestone.history).toHaveLength(5);
  expect(milestone.history.slice(1).every(event => Object.keys(event).sort().join(",") === "at,by,event,kind")).toBe(true);
  for (const [kind, ref] of links) {
    milestone = board.unlinkMilestone(milestone.id, kind, ref, "user", milestone.revision, 4000);
    expect(board.unlinkMilestone(milestone.id, kind, ref, "user", milestone.revision, 5000)).toEqual(milestone);
  }
  expect(board.milestoneLinks()).toEqual([]);
  expect(milestone.revision).toBe(8);
});

test("one-level parents refuse self, missing parent, cycles and subtree moves atomically", () => {
  const { board } = rig(), parent = create(board, "Parent"), other = create(board, "Other");
  const child = board.newMilestone({ title: "Child", outcome: "Child outcome", parent: parent.id }, "user", 1000);
  expect(() => board.newMilestone({ title: "Grandchild", outcome: "Wrong depth", parent: child.id }, "user", 1000)).toThrow("top level");
  expect(() => board.updateMilestone(child.id, { parent: child.id }, child.revision, edit())).toThrow("itself");
  expect(() => board.updateMilestone(parent.id, { parent: child.id }, parent.revision, edit())).toThrow("top level");
  expect(() => board.updateMilestone(parent.id, { parent: other.id }, parent.revision, edit())).toThrow("one level");
  expect(() => board.updateMilestone(child.id, { parent: 9999 }, child.revision, edit())).toThrow("top level");
  expect(board.milestones()).toEqual([parent, other, child]);
  const moved = board.updateMilestone(child.id, { parent: other.id }, child.revision, edit());
  expect(moved.parent).toBe(other.id);
  expect(board.updateMilestone(parent.id, { parent: other.id }, parent.revision, edit()).parent).toBe(other.id);
});

test("history ceiling refuses a link and metadata edit together with their side effects", () => {
  const { board } = rig(); let milestone = create(board);
  for (let index = 1; index < MILESTONE_HISTORY_LIMIT - 1; index++) milestone = board.updateMilestone(milestone.id, { order: index }, milestone.revision, { at: 1000 + index, by: "user", event: "ordered", fields: ["order"] });
  milestone = board.updateMilestone(milestone.id, { state: "done" }, milestone.revision, { at: 2000, by: "user", event: "state", fields: ["state"] });
  expect(milestone.history).toHaveLength(MILESTONE_HISTORY_LIMIT);
  expect(() => board.linkMilestone(milestone.id, "task", "1", "user", milestone.revision)).toThrow("history");
  expect(() => board.updateMilestone(milestone.id, { title: "Too late" }, milestone.revision, edit())).toThrow("history");
  expect(board.milestone(milestone.id)).toEqual(milestone);
  expect(board.milestoneLinks()).toEqual([]);
});

test("closed parsers refuse invalid dates, enums, identities and unknown fields", () => {
  expect(() => parseMilestoneInput({ title: "M", outcome: "O", target: "2026-02-29" })).toThrow("date");
  expect(() => parseMilestonePatch({ unknown: true })).toThrow("unknown");
  expect(() => parseMilestonePatch({ state: "shipped" })).toThrow("state");
  expect(() => parseMilestonePatch({ horizon: "soon" })).toThrow("horizon");
  expect(() => milestoneLinkRef("issue", "#42")).toThrow("owner/repo");
  expect(() => milestoneLinkRef("task", "01")).toThrow("integer");
  expect(() => milestoneLinkRef("task", "9007199254740992")).toThrow("integer");
  expect(() => milestoneLinkRef("spec", "../spec\nforged")).toThrow();
});
