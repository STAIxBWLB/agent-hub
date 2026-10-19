import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";

test("configuring an already active legacy release enforces one open train without an explicit state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-train-legacy-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 });
  try {
    const tasks = new Tasks({ board, bus, cwd: dir, project: "train", routing: () => loadRouting(dir), roles: { claude: ["planner"] }, notify: () => {} });
    const first = await tasks.newRelease(USER, { name: "first", goal: "Legacy", order: 1 });
    const second = await tasks.newRelease(USER, { name: "second", goal: "Legacy", order: 2 });
    // An off-mode or upgraded store can contain multiple active legacy rows.
    const active = board.updateRelease(first.id, { state: "active" }, 0);
    const other = board.updateRelease(second.id, { state: "active" }, 0);
    for (const release of [active, other]) {
      const error = await tasks.configureRelease("claude", { id: release.id, revision: release.revision }).catch(error => error);
      expect(error).toBeInstanceOf(PreEffectToolRefusal);
      expect(error.message).toContain("one open");
      expect(board.release(release.id)).toEqual(release);
    }
    board.updateRelease(other.id, { state: "dropped" }, other.revision);
    expect(await tasks.configureRelease("claude", { id: active.id, revision: active.revision })).toMatchObject({ state: "active", train: { history: [expect.objectContaining({ event: "configured" })] } });
  } finally { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); }
});
