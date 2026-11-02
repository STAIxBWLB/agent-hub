import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { USER } from "../src/hub/envelope.ts";

test("peer task signal projection stays current without decoding history or losing malformed privacy state", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-board-peer-signals-")), file = join(dir, "hub.db");
  const board = new Board(file), raw = new Database(file);
  try {
    const ownerTask = board.propose(USER, { title: "synthetic owner signal row", class: "implement" });
    board.update(ownerTask.id, "codex", "accepted", { owner: "codex", reviewer: "claude", state: "in_progress" });
    const reviewerTask = board.propose(USER, { title: "synthetic reviewer signal row", class: "implement", signals: ["pii_path"] });
    board.update(reviewerTask.id, "claude", "accepted", { owner: "claude", reviewer: "codex", state: "in_progress" });
    board.update(reviewerTask.id, "claude", "done", { state: "in_review" });
    const closedTask = board.propose(USER, { title: "synthetic closed signal row", class: "implement", signals: ["pii_path"] });
    board.update(closedTask.id, "codex", "accepted", { owner: "codex", reviewer: "claude", state: "in_progress" });
    board.update(closedTask.id, "codex", "done", { state: "in_review" });
    board.update(closedTask.id, USER, "approved", { state: "approved" });
    const malformedSignals = board.propose(USER, { title: "synthetic malformed signals row", class: "implement" });
    board.update(malformedSignals.id, "codex", "accepted", { owner: "codex", reviewer: "user", state: "in_progress" });

    const revision = board.statusRevision();
    const initial = board.peerTaskSignals("codex");
    expect(initial.filter(row => row.state === "in_progress" && row.signals.length === 0)).toHaveLength(2);
    expect(initial).toContainEqual({ state: "in_review", signals: ["pii_path"] });
    expect(initial).toContainEqual({ state: "approved", signals: ["pii_path"] });
    expect(board.statusRevision()).toBe(revision);
    expect(board.peerTaskSignals("nobody")).toEqual([]);

    board.update(reviewerTask.id, USER, "review requested", { state: "changes_requested" });
    board.update(reviewerTask.id, "claude", "redo accepted", { state: "in_progress", signals: [] });
    expect(board.peerTaskSignals("codex").filter(row => row.state === "in_progress" && row.signals.length === 0)).toHaveLength(3);
    expect(board.peerTaskSignals("codex")).toContainEqual({ state: "approved", signals: ["pii_path"] });
    expect(board.peerTaskSignals("claude")).toContainEqual({ state: "in_progress", signals: [] });

    board.update(ownerTask.id, USER, "owner and reviewer changed", { owner: "claude", reviewer: "codex", signals: ["pii_path"] });
    expect(board.peerTaskSignals("claude")).toContainEqual({ state: "in_progress", signals: ["pii_path"] });
    expect(board.peerTaskSignals("codex")).toContainEqual({ state: "in_progress", signals: ["pii_path"] });

    // If this projection accidentally selects or parses history, it fails; history is not a privacy input here.
    raw.query("UPDATE tasks SET history=? WHERE id=?").run("{malformed history", ownerTask.id);
    expect(board.peerTaskSignals("codex")).toContainEqual({ state: "in_progress", signals: ["pii_path"] });

    raw.query("UPDATE tasks SET signals=? WHERE id=?").run("{malformed signals", malformedSignals.id);
    expect(() => board.peerTaskSignals("codex")).toThrow();
  } finally {
    raw.close(); board.close(); rmSync(dir, { recursive: true, force: true });
  }
});
