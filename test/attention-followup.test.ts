import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { HUB_DB_BUSY_TIMEOUT_MS } from "../src/hub/db-timeout.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { needs } from "../src/ui/needs.ts";

test("status task facts read only structural columns without decoding stored payloads", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-status-columns-")), path = join(root, "hub.db");
  const board = new Board(path);
  const raw = new Database(path);
  raw.run(`PRAGMA busy_timeout = ${HUB_DB_BUSY_TIMEOUT_MS}`);
  try {
    const task = board.propose("user", { title: "PRIVATE_TITLE_MARKER", class: "plan" });
    board.update(task.id, "user", "assigned", { owner: "codex", reviewer: "user" });
    const done = board.propose("user", { title: "finished", class: "plan" });
    board.update(done.id, "user", "accepted", { state: "in_progress" });
    board.update(done.id, "user", "done", { state: "approved" });
    // Unrelated historical payload is not valid JSON; a structural read must never decode it.
    raw.run("UPDATE tasks SET history = ?, plan = ?, refs = ? WHERE id = ?", ["INVALID_HISTORY", "INVALID_PLAN", "INVALID_REFS", task.id]);
    expect(board.statusTasks()).toEqual([{ id: task.id, state: "proposed", owner: "codex", reviewer: "user" }]);
  } finally { raw.close(); board.close(); rmSync(root, { recursive: true }); }
});

test("person and hub owners never create offline-agent needs while person review remains actionable", () => {
  const result = needs({ peers: { user: { state: "offline" }, hub: { state: "offline" }, codex: { state: "offline" } },
    tasks: [{ id: 1, state: "in_progress", owner: "user" }, { id: 2, state: "proposed", owner: "hub" },
      { id: 3, state: "in_progress", owner: "codex" }, { id: 4, state: "in_review", owner: "user", reviewer: "user" }],
    facts: [{ kind: "offline", id: 1, peer: "user" }, { kind: "offline", id: 2, peer: "hub" }] }, 1000);
  expect(result).toEqual({ act: 1, watch: 1, state: "review", items: [
    { kind: "review", level: "act", id: 4 }, { kind: "offline", level: "watch", id: 3, peer: "codex" },
  ] });
});

test("real daemon excludes intentionally person-owned work from offline attention", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-person-attention-")), stateDir = join(root, "state"); mkdirSync(stateDir);
  const board = new Board(join(stateDir, "hub.db"));
  const task = board.propose("user", { title: "person-owned fixture", class: "plan" });
  board.update(task.id, "user", "assigned", { owner: "user" });
  board.update(task.id, "user", "accepted", { state: "in_progress" }); board.close();
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false } } });
  const client = await ControlClient.connect(stateDir, { role: "console" });
  try {
    const response = await client.request({ t: "status" });
    expect(response.status.needs).toEqual({ act: 0, watch: 0, state: "sleeping" });
    expect(response.status.attentionItems).toEqual([]);
    expect(JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8")).needs.watch).toBe(0);
    const raw = new Database(join(stateDir, "hub.db"));
    raw.run(`PRAGMA busy_timeout = ${HUB_DB_BUSY_TIMEOUT_MS}`);
    try { raw.run("UPDATE tasks SET history = ?, plan = ? WHERE id = ?", ["INVALID_HISTORY", "INVALID_PLAN", task.id]); }
    finally { raw.close(); }
    // The actual status request must keep using structural facts, even with unreadable unrelated payload.
    expect((await client.request({ t: "status" })).status?.needs).toEqual({ act: 0, watch: 0, state: "sleeping" });
  } finally { client.close(); await daemon.stop(); rmSync(root, { recursive: true }); }
}, 20000);
