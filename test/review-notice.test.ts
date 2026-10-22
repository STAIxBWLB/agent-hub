import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";

// #711 change 5 (task #380): the notice for a task whose reviewer is the person names the console path as well as the CLI form. Authority is untouched.
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function rig() {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-review-notice-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  cleanup.push(() => { board.close(); rmSync(cwd, { recursive: true, force: true }); });
  class Peer extends BasePeer { async start() { this.setState("idle"); } async stop() { this.setState("offline"); } async deliver() { return; } }
  for (const id of ["codex", "claude"]) { const peer = new Peer(id, 60000); bus.add(peer); await peer.start(); cleanup.push(() => peer.stop()); }
  cleanup.push(() => bus.closeJournal());
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", notify: line => { notices.push(line); }, routing: () => loadRouting(cwd) });
  const add = (reviewer: string, title = "fixture task") => {
    const task = board.propose("user", { title, class: "implement" });
    return board.update(task.id, "codex", "accepted", { state: "in_progress", owner: "codex", reviewer });
  };
  return { tasks, board, notices, add };
}

test("a task done with the person as reviewer is announced with the console path and the CLI form (#711 change 5)", async () => {
  const f = await rig(), task = f.add("user");
  const done = await f.tasks.done("codex", task.id, "all done");
  expect(done.state).toBe("in_review");
  const line = f.notices.find(n => n.includes(`#${task.id}`) && n.includes("done by codex"));
  expect(line, JSON.stringify(f.notices)).toBeDefined();
  expect(line).toContain(`review it in the ahub console (Tasks, select #${task.id}, press r)`);
  expect(line).toContain(`or with ahub review ${task.id} approved|changes_requested [note]`);
  expect(line).not.toContain("ahub task show");                                              // the old wording is gone
});

test("a task reviewed by an agent does not get the console wording, and a private task shows [pii] in it (#711 change 5)", async () => {
  const f = await rig(), agent = f.add("claude");
  await f.tasks.done("codex", agent.id, "done");
  expect(f.notices.some(n => n.includes("press r"))).toBe(false);                            // only the person's own review names the console
  const secret = f.board.propose("user", { title: "SECRET-TITLE-711", class: "implement", signals: ["pii_path"] });
  f.board.update(secret.id, "codex", "accepted", { state: "in_progress", owner: "codex", reviewer: "user" });
  await f.tasks.done("codex", secret.id, "done");
  const line = f.notices.find(n => n.includes(`#${secret.id}`) && n.includes("press r"));
  expect(line, JSON.stringify(f.notices)).toBeDefined();
  expect(line).toContain("[pii]"); expect(line).not.toContain("SECRET-TITLE-711");           // the public title, never the private one
});
