import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";

test("only the person can roll approved private work out of an active train without screening or exposing its reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-train-private-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 });
  let screens = 0;
  try {
    const routing = loadRouting(dir);
    const tasks = new Tasks({ board, bus, cwd: dir, project: "train", roles: { claude: ["planner"] }, notify: () => {},
      routing: () => ({ ...routing, signals: { ...routing.signals, pii_screen: "local" }, constraints: { ...routing.constraints, pii: "local_only" } }),
      piiScreen: async () => { screens++; return { label: "clear", ms: 0 }; } });
    const release = board.newRelease("private-scope", "Train", 1);
    const active = board.updateRelease(release.id, { state: "active", train: { history: [] } }, 0);
    const task = board.propose(USER, { title: "private patient", class: "implement", signals: ["pii_path"] });
    board.update(task.id, USER, "accepted", { state: "in_progress", owner: "local", reserved: "local" });
    board.update(task.id, USER, "approved", { state: "approved" });
    const before = board.plan(task.id, USER, { release: active.id }, 0);
    expect(() => tasks.releaseReport(USER, active.id)).toThrow("private");
    const input = { id: task.id, revision: 1, release: null, reason: "patient 900101-1234567 rollover" };
    await expect(tasks.assignRelease("claude", input)).rejects.toThrow("person");
    expect(board.get(task.id)).toEqual(before);
    const moved = await tasks.assignRelease(USER, input);
    expect(moved).toMatchObject({ state: "approved", owner: "local", reserved: "local", planningRevision: 2 });
    expect(moved.release).toBeUndefined();
    expect(moved.history.at(-1)).toMatchObject({ note: input.reason, withheld: true });
    expect(screens).toBe(0);
    expect(JSON.stringify(tasks.publicView(moved, true))).not.toContain(input.reason);
    const declassified = board.update(task.id, USER, "declassified", { signals: [] });
    expect(JSON.stringify(tasks.publicView(declassified, true))).not.toContain(input.reason);
    expect(tasks.releaseReport(USER, active.id).readiness.tasks).toEqual([]);
  } finally { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); }
});
