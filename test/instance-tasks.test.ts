import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { USER, type Envelope, type PeerState } from "../src/hub/envelope.ts";
import { parseRouting } from "../src/hub/routing.ts";
import type { InstancesConfig } from "../src/hub/instances.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";

class Peer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) {}
  set(state: PeerState) { this.setState(state); }
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const instances: InstancesConfig = { "codex-a": { kind: "codex" }, "codex-b": { kind: "codex" }, "kimi-a": { kind: "kimi" } };
async function fixture(ids = ["codex-a", "codex-b", "kimi-a"], reviewers = ["codex", "kimi"]) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-instance-tasks-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const board = new Board(join(dir, "hub.db")); cleanup.push(() => board.close());
  const bus = new Bus({ batchMs: 0 }); cleanup.push(() => bus.closeJournal());
  const peers = Object.fromEntries(ids.map(id => [id, new Peer(id)]));
  for (const peer of Object.values(peers)) { await peer.start(); bus.add(peer); }
  cleanup.push(() => { for (const peer of Object.values(peers)) peer.set("offline"); });
  const routing = parseRouting(`[local]\nfixed_model="fixture"\n[classes.implement]\npeers=["codex"]\n[classes.review]\npeers=${JSON.stringify(reviewers)}\n`);
  // These fake native owners represent host-verified isolated runtimes; declaration text is not the proof.
  const roles = { "codex-a": ["implementer"], "codex-b": ["implementer"], "kimi-a": ["reviewer"] };
  const deps: TasksDeps & { instances: () => InstancesConfig } = { board, bus, cwd: dir, project: "fixture", routing: () => routing, instances: () => instances, roles,
    ownerIsolation: () => Object.fromEntries(ids.map(peer => [peer, true])), notify: () => {} };
  const tasks = new Tasks(deps);
  return { board, bus, peers, tasks };
}

test("I2 Tasks automatic assignment and explain share declared kind expansion and actual board WIP", async () => {
  const f = await fixture();
  const first = await f.tasks.propose(USER, { title: "First isolated change", class: "implement", owner: "codex-a" });
  f.tasks.accept("codex-a", first.id);
  expect(f.tasks.wip("codex-a")).toBe(1);
  const explain = f.tasks.explain({ title: "Second isolated change", class: "implement" });
  expect(explain).toContain("owner: codex-b");
  const next = await f.tasks.propose(USER, { title: "Second isolated change", class: "implement" });
  expect(next.owner).toBe("codex-b");
  expect(next.reviewer).toBe("kimi-a");
  expect(next.history.findLast(row => row.event === "assigned")?.note).not.toContain("sameFamilyFallback");
});

test("I2 Tasks records a same-family fallback in assignment history only when no other family can review", async () => {
  const f = await fixture(["codex-a", "codex-b"], ["codex"]);
  const task = await f.tasks.propose(USER, { title: "Shared family fallback", class: "implement", owner: "codex-a" });
  expect(task).toMatchObject({ owner: "codex-a", reviewer: "codex-b" });
  expect(task.history.findLast(row => row.event === "assigned")?.note).toContain("sameFamilyFallback=true");
  expect(f.tasks.explain(task.id).join("\n")).toContain("same-family fallback");
});

test("I2 Tasks refuses a manual same-family reviewer when an eligible busy other family exists", async () => {
  const f = await fixture(); f.peers["kimi-a"]!.set("busy");
  const task = await f.tasks.propose(USER, { title: "Independent reviewer", class: "implement", owner: "codex-a" });
  expect(task.reviewer).toBe("kimi-a");
  const before = f.board.get(task.id)!.history;
  await expect(f.tasks.assignTo(task.id, "codex-b", USER, true, "reviewer")).rejects.toThrow("same family");
  expect(f.board.get(task.id)!.history).toEqual(before);
  expect(f.board.get(task.id)!.reviewer).toBe("kimi-a");
});

test("I2 Tasks roster relay preview and saved move expand kinds without moving back to the old instance", async () => {
  const f = await fixture();
  const task = await f.tasks.propose(USER, { title: "Move one declared owner", class: "implement", owner: "codex-a" });
  expect(f.tasks.rosterPreview("codex-a")).toContainEqual(expect.objectContaining({ id: task.id, role: "owner", to: "codex-b" }));
  await f.tasks.reassignForRoster("codex-a");
  expect(f.board.get(task.id)!.owner).toBe("codex-b");
});
