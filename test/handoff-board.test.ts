import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { HUB } from "../src/hub/envelope.ts";
import { realPath } from "../src/hub/project.ts";

// #604 (agent-hub#1030): the two additive handoff tables on a real Board. The daemon-level behaviour is in handoff-daemon.test.ts.
const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); });
function fixture() {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-handoff-board-"))), file = join(dir, "hub.db");
  let board = new Board(file); clean.push(() => { board.close(); rmSync(dir, { recursive: true, force: true }); });
  return { file, get board() { return board; }, restart() { board.close(); board = new Board(file); } };
}

test("a fresh board has no handoff state, and a row in either table is reported by the recovery guard's reader", () => {
  const f = fixture();
  expect(f.board.hasHandoffState()).toBe(false);
  expect(f.board.handoffIntegrity()).toMatchObject({ origins: 0, outbound: 0 });
  const task = f.board.propose(HUB, { title: "from elsewhere", class: "implement" });
  f.board.setHandoffOrigin(task.id, { projectId: "p_other", peer: "claude", originTask: 4 });
  expect(f.board.hasHandoffState()).toBe(true);
  const a = f.board.handoffIntegrity();
  expect(a).toMatchObject({ origins: 1, outbound: 0 });
  f.board.setHandoffOrigin(task.id, { projectId: "p_changed", peer: "codex" });                    // an origin is recorded once and never rewritten
  expect(f.board.handoffOrigin(task.id)).toMatchObject({ projectId: "p_other", peer: "claude", originTask: 4 });
  expect(f.board.handoffIntegrity().digest).toBe(a.digest);
  f.restart();
  expect(f.board.handoffOrigin(task.id)).toMatchObject({ projectId: "p_other", peer: "claude", originTask: 4 });   // survives a restart
});

test("the outbound table keeps one row per target task, updates its state and keeps the last PR and head a later event omits", () => {
  const f = fixture();
  f.board.recordHandoffOutbound({ remoteProject: "p_b", remoteTask: 7, originPeer: "claude", localTask: 2, title: "Raise the pin", state: "proposed" });
  expect(f.board.handoffOutboundFor("p_b", 7)).toMatchObject({ state: "proposed", pr: null, head: null, localTask: 2 });
  const head = "a".repeat(40);
  f.board.recordHandoffOutbound({ remoteProject: "p_b", remoteTask: 7, originPeer: "claude", title: "ignored on update", state: "in_review", pr: 12, head });
  f.board.recordHandoffOutbound({ remoteProject: "p_b", remoteTask: 7, originPeer: "claude", title: "ignored on update", state: "approved" });   // no PR or head: keeps the earlier ones
  expect(f.board.handoffOutboundFor("p_b", 7)).toMatchObject({ state: "approved", pr: 12, head, title: "Raise the pin", localTask: 2 });
  expect(f.board.handoffOutbound()).toHaveLength(1);
  f.board.recordHandoffOutbound({ remoteProject: "p_c", remoteTask: 7, originPeer: "codex", title: "same task id, another project", state: "proposed" });
  expect(f.board.handoffOutbound()).toHaveLength(2);                                                // the key is the project and the task together
  const before = f.board.handoffIntegrity();
  f.restart();
  expect(f.board.handoffIntegrity()).toEqual(before);
  expect(f.board.handoffOutboundFor("p_b", 9)).toBeUndefined();
});

// #731 (agent-hub#1203): the key is unique per origin project, the proposal and origin row are one transaction, and a row from before keeps its integrity digest.
test("proposeHandoff writes the task and its origin together; the same key replays to the same task and a different origin project may reuse a key", () => {
  const f = fixture();
  const key = "6f1c2c0e-8b1a-4c3e-9d3a-1b2c3d4e5f60";
  const made = f.board.proposeHandoff(HUB, { title: "from elsewhere", class: "implement" }, { projectId: "p_a", peer: "claude", originTask: 4, key, digest: "d1" });
  expect(made.replayed).toBe(false);
  expect(f.board.handoffOrigin(made.task.id)).toMatchObject({ projectId: "p_a", peer: "claude", originTask: 4 });
  expect(f.board.handoffOriginByKey("p_a", key)).toEqual({ taskId: made.task.id, digest: "d1" });
  const again = f.board.proposeHandoff(HUB, { title: "from elsewhere", class: "implement" }, { projectId: "p_a", peer: "claude", originTask: 4, key, digest: "d1" });
  expect(again).toMatchObject({ replayed: true, task: { id: made.task.id } });
  expect(f.board.list()).toHaveLength(1);                                                        // no second task
  const other = f.board.proposeHandoff(HUB, { title: "another project", class: "implement" }, { projectId: "p_z", peer: "claude", key, digest: "d2" });
  expect(other.replayed).toBe(false); expect(f.board.list()).toHaveLength(2);                    // the key is unique per origin project
  f.restart();
  expect(f.board.handoffOriginByKey("p_a", key)).toEqual({ taskId: made.task.id, digest: "d1" });   // survives a restart
});

test("a failure after the proposal inside proposeHandoff leaves no task behind (one transaction)", () => {
  const f = fixture();
  const key = "0b8f3f3e-2d52-4f7e-8f55-5a7a0f2d9c11";
  f.board.proposeHandoff(HUB, { title: "first", class: "implement" }, { projectId: "p_a", peer: "claude", key });
  const db = (f.board as any).db;
  const before = f.board.list().length;
  // the origin insert fails after the proposal insert succeeded: the proposal must roll back with it
  db.run("CREATE TRIGGER fail_origin BEFORE INSERT ON task_handoff_origin BEGIN SELECT RAISE(ABORT, 'origin write failed'); END");
  expect(() => f.board.proposeHandoff(HUB, { title: "second", class: "implement" }, { projectId: "p_a", peer: "claude", key: "11111111-1111-4111-8111-111111111111" })).toThrow("origin write failed");
  expect(f.board.list()).toHaveLength(before);                                                     // the proposal rolled back with it
});

test("a row from before handoff keys keeps its integrity digest, and a keyed row changes it", () => {
  const f = fixture();
  const task = f.board.propose(HUB, { title: "old", class: "implement" });
  f.board.setHandoffOrigin(task.id, { projectId: "p_other", peer: "claude", originTask: 4 });
  const before = f.board.handoffIntegrity().digest;
  const db = (f.board as any).db;
  expect(db.query("SELECT handoff_key FROM task_handoff_origin").get()).toEqual({ handoff_key: null });
  f.restart();
  expect(f.board.handoffIntegrity().digest).toBe(before);                                          // migrating the columns again changes nothing
  f.board.proposeHandoff(HUB, { title: "keyed", class: "implement" }, { projectId: "p_a", peer: "claude", key: "6f1c2c0e-8b1a-4c3e-9d3a-1b2c3d4e5f60", digest: "d" });
  expect(f.board.handoffIntegrity().digest).not.toBe(before);
});
