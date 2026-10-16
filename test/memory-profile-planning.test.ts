import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "@staix/agent-mem";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { USER } from "../src/hub/envelope.ts";
import { openProfileMemory } from "../src/hub/memory-profile.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";

test("split undo refuses stale memory evidence before refreshing the old profile or mutating the board", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-profile-planning-"));
  const board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 });
  const opened = openProfileMemory({ home: join(dir, "home") });
  try {
    const tasks = new Tasks({ board, bus, cwd: dir, project: "split", routing: () => loadRouting(dir), notify: () => {},
      memoryCheck: () => opened.binding.assertCurrent(), store: { store: opened.store, project: "split", repo: "owner/repo" } });
    const parent = await tasks.propose(USER, { title: "synthetic split", class: "implement", backlog: true });
    await tasks.splitBacklog(USER, { id: parent.id, revision: 0, parts: [{ title: "first" }, { title: "second" }], reason: "synthetic parts" });
    const before = board.list();
    await migrate({ memoryDir: opened.store.dir, generation: "a".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
    let refreshes = 0;
    const original = opened.store.refresh.bind(opened.store);
    opened.store.refresh = () => { refreshes++; original(); };
    await expect(tasks.undoPlanning(USER, parent.id, 1)).rejects.toThrow("current memory link evidence");
    expect(refreshes).toBe(0);
    expect(board.list()).toEqual(before);
  } finally {
    opened.store.close(); bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true });
  }
});

for (const operation of ["propose", "link"] as const) {
  test(`stale profile goal ${operation} is a pre-effect refusal before goal lookup or board mutation`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ahub-profile-goal-"));
    const board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 });
    const opened = openProfileMemory({ home: join(dir, "home") });
    try {
      const project = "synthetic/profile-goal", notices: string[] = [];
      const goal = opened.store.goal({ project, scope: "project", title: "synthetic long-term goal", milestones: [], dependsOn: [], actor: "person" });
      const existing = board.propose(USER, { title: "existing synthetic task", class: "implement" });
      const tasks = new Tasks({ board, bus, cwd: dir, project, routing: () => loadRouting(dir), notify: line => notices.push(line),
        memoryCheck: () => opened.binding.assertCurrent(), store: { store: opened.store, project, repo: "synthetic/profile-goal" } });
      const before = board.list(), queued = bus.snapshot(false).queues;
      let lookups = 0, links = 0;
      const goalOf = opened.store.goalOf.bind(opened.store), goalLink = opened.store.goalLink.bind(opened.store);
      opened.store.goalOf = (...args) => { lookups++; return goalOf(...args); };
      opened.store.goalLink = (...args) => { links++; return goalLink(...args); };
      writeFileSync(join(opened.store.dir, "profile.json"), JSON.stringify({ schema: "agent-mem.profile/v1", kind: "generation", generation: "f".repeat(32) }));
      let failure: unknown;
      try {
        if (operation === "propose") await tasks.propose(USER, { title: "must not create a task", class: "implement", goal, backlog: true });
        else tasks.linkGoal(USER, existing.id, goal);
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(PreEffectToolRefusal);
      expect(lookups).toBe(0); expect(links).toBe(0);
      expect(board.list()).toEqual(before);
      expect(bus.snapshot(false).queues).toEqual(queued);
      expect(notices).toEqual([]);
    } finally {
      opened.store.close(); bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true });
    }
  });
}
