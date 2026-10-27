import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";

test("#345 task public holder reasons survive history truncation and follow escalation without parsing notes", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-holder-view-")), board = new Board(join(root, "hub.db")), bus = new Bus({ batchMs: 0 });
  const tasks = new Tasks({ cwd: root, project: "fixture", board, bus, routing: () => loadRouting(root), notify: () => {} });
  try {
    const proposed = board.propose("user", { title: "ordinary", class: "implement", planner: "codex-plan", plannerReason: "rotation" });
    board.update(proposed.id, "user", "assigned", { owner: "old-owner", reviewer: "old-reviewer" }, "agent prose is not a choice", { reason: "manual", reviewerReason: "rotation" });
    board.update(proposed.id, "hub", "escalated", { owner: "new-owner", reviewer: "new-reviewer", planner: "codex-plan" }, "named old-reviewer forever", { reason: "rejections", reviewerReason: "same-family fallback", plannerReason: "kept" });
    for (let i = 0; i < 7; i++) board.update(proposed.id, "user", "note", {}, `bounded note ${i}`);
    const view = tasks.publicView(board.get(proposed.id)!);
    expect(view).toMatchObject({ planner: "codex-plan", plannerReason: "kept", owner: "new-owner", ownerReason: "rejections", reviewer: "new-reviewer", reviewerReason: "same-family fallback" });
    expect(view.history).toHaveLength(5);
    expect(JSON.stringify(view.history)).not.toContain("escalated");
    expect(view.ownerReason).not.toBe("named");
    const legacy = board.propose("user", { title: "legacy", class: "implement" });
    expect(tasks.publicView({ ...legacy, planner: null, history: [] })).not.toHaveProperty("plannerReason");
  } finally { board.close(); bus.closeJournal(); rmSync(root, { recursive: true, force: true }); }
});
