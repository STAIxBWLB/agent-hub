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
