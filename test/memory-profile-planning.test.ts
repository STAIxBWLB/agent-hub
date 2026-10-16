import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "@staix/agent-mem";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { USER } from "../src/hub/envelope.ts";
import { openProfileMemory } from "../src/hub/memory-profile.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { Tasks } from "../src/hub/tasks.ts";

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
