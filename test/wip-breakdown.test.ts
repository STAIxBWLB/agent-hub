import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { renderStatus } from "../src/cli/output.ts";
import { cells, initialConsoleState, paint, panelRows, reduceConsole, renderConsoleLines } from "../src/cli/console-state.ts";

// agent-hub#784 AC3 (task #456): the planner WIP breakdown is a read-only view of what `plannerWip` counts. Admission keeps reading `plannerWip`.
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function rig(limits: Record<string, number> = { codex: 3, kimi: 2 }) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-wip-breakdown-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 });
  const tasks = new Tasks({ board, bus, cwd: dir, project: "wip", routing: () => loadRouting(dir), roles: { claude: ["planner"] }, wipLimit: peer => limits[peer] ?? 1, notify: () => {} });
  cleanups.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  return { board, tasks };
}
/** An owned task moved to `state`, through the board's own writes. */
function owned(board: Board, owner: string, state: "in_progress" | "in_review" | "changes_requested" | "approved" | "cancelled") {
  const task = board.propose(USER, { title: `${owner} ${state}`, class: "implement" });
  board.update(task.id, USER, "accepted", { owner, reviewer: USER, state: "in_progress" });
  if (state === "in_progress") return task.id;
  board.update(task.id, USER, "done", { state: "in_review" });
  if (state !== "in_review") board.update(task.id, USER, state, { state });
  return task.id;
}

test("the breakdown counts active, review-wait and reserved per peer, and they add up to plannerWip", () => {
  const { board, tasks } = rig();
  owned(board, "codex", "in_progress"); owned(board, "codex", "changes_requested"); owned(board, "codex", "in_review"); owned(board, "kimi", "in_review");
  owned(board, "codex", "approved"); owned(board, "codex", "cancelled");                       // closed work is in no count
  const pulled = board.propose(USER, { title: "pulled", class: "implement", backlog: true });
  board.pullPlanned(pulled.id, "claude", "kimi", 0, "ready");                                  // proposed, unowned, reserved by a planner pull
  const reservedOnly = board.propose(USER, { title: "reserved by a person", class: "implement" });
  board.update(reservedOnly.id, USER, "reserved", { reserved: "codex" });                       // a person's reservation is not WIP
  const view = tasks.wipBreakdown(["codex", "kimi", "claude"]);
  expect(view.codex).toEqual({ wip: 3, active: 2, reviewWait: 1, reserved: 0, wipLimit: 3 });
  expect(view.kimi).toEqual({ wip: 2, active: 0, reviewWait: 1, reserved: 1, wipLimit: 2 });
  expect(view.claude).toEqual({ wip: 0, active: 0, reviewWait: 0, reserved: 0, wipLimit: 1 });
  for (const peer of ["codex", "kimi", "claude"]) expect(view[peer]!.wip).toBe(tasks.wip(peer));  // the same number admission reads
});

test("admission is unchanged: a full peer is still refused at its limit, whatever the split, and review-wait still counts against it", async () => {
  const { board, tasks } = rig({ codex: 1 });
  owned(board, "codex", "in_review");
  expect(tasks.wipBreakdown(["codex"]).codex).toMatchObject({ wip: 1, active: 0, reviewWait: 1, wipLimit: 1 });
  const next = await tasks.propose(USER, { title: "next", class: "implement", backlog: true });
  await expect(tasks.pullPlanned("claude", { id: next.id, revision: 0, reason: "ready" })).rejects.toThrow("WIP capacity");   // review-wait holds the slot, as before
  expect(board.plannerWip("codex")).toBe(1);
});

test("one grouped query serves every peer: the breakdown does not grow with the number of peers", () => {
  const { board } = rig();
  for (let i = 0; i < 6; i++) owned(board, `peer${i}`, i % 2 ? "in_review" : "in_progress");
  const sql: string[] = [];
  const db = (board as unknown as { db: { query: (text: string) => unknown } }).db, original = db.query.bind(db);
  db.query = (text: string) => { sql.push(text); return original(text); };
  const grouped = board.plannerWipBreakdown();
  db.query = original;
  expect(sql).toHaveLength(1); expect(Object.keys(grouped)).toHaveLength(6);
  expect(grouped.peer1).toEqual({ active: 0, reviewWait: 1, reserved: 0 });
});

test("ahub status prints the split beside the count, and an older hub's plain count still prints", () => {
  const text = renderStatus({ peers: { codex: { state: "idle" } }, taskWip: { codex: { wip: 3, wipLimit: 3, active: 2, reviewWait: 1, reserved: 0 } } }, 160, 0).map(line => paint(line, false)).join("\n");
  expect(text).toMatch(/codex planner WIP\s+3\/3 \(active 2, review-wait 1, reserved 0\)/);
  const old = renderStatus({ peers: { codex: { state: "idle" } }, taskWip: { codex: { wip: 1, wipLimit: 2 } } }, 160, 0).map(line => paint(line, false)).join("\n");
  expect(old).toMatch(/codex planner WIP\s+1\/2/); expect(old).not.toContain("review-wait");
});

test("the console Peers tab keeps its count cell and opens the split in the peer detail", () => {
  const s = initialConsoleState(true);
  s.peers = { codex: { state: "idle" } };
  s.taskWip = { codex: { wip: 3, wipLimit: 3, active: 2, reviewWait: 1, reserved: 0 } };
  expect(cells(s, panelRows(s)[0], false, 0).find(cell => cell.text === "3/3")?.tone).toBe("attention");   // the cell is unchanged: count and attention
  s.mode = "panels";
  const lines = renderConsoleLines(s, 160, 30, 0).map(line => line.map(cell => cell.text).join("")).join("\n");
  expect(lines).toContain("3/3");
  // The detail names each part.
  const opened = reduceConsole(s, "\r", 0).state;
  const detail = renderConsoleLines(opened, 160, 30, 0).map(line => line.map(cell => cell.text).join("")).join("\n");
  expect(detail).toContain("planner WIP"); expect(detail).toContain("3 of 3: active 2, review-wait 1, reserved 0");
  // An older hub sends no split: the detail adds no line.
  const old = initialConsoleState(true); old.peers = { codex: { state: "idle" } }; old.taskWip = { codex: { wip: 1, wipLimit: 2 } }; old.mode = "panels";
  expect(renderConsoleLines(reduceConsole(old, "\r", 0).state, 160, 30, 0).map(line => line.map(cell => cell.text).join("")).join("\n")).not.toContain("planner WIP");
});

test("the dashboard WIP line shows the split and falls back to the plain count", async () => {
  const html = await Bun.file(join(import.meta.dir, "../src/ui/index.html")).text();
  expect(html).toContain("data?.wipBreakdown");
  expect(html).toContain("' (active '+split.active+', review-wait '+split.reviewWait+', reserved '+split.reserved+')'");
  expect(html).toContain("'WIP '+wip+(Number.isSafeInteger(data?.wipLimit) ? '/'+data.wipLimit : '')+splitText+' / permission '");
});

test("the daemon status and the dashboard snapshot carry the same split, and a reserved planner pull shows as reserved", async () => {
  const { mkdirSync } = await import("node:fs");
  const { DEFAULT_CONFIG, startDaemon } = await import("../src/hub/daemon.ts");
  const { ControlClient } = await import("../src/hub/control-client.ts");
  const root = mkdtempSync(join(tmpdir(), "ahub-wip-daemon-")), stateDir = join(root, ".agenthub/state");
  mkdirSync(stateDir, { recursive: true });
  const board = new Board(join(stateDir, "hub.db")), pulled = board.propose(USER, { title: "PRIVATE_RESERVED_TITLE", class: "implement", backlog: true });
  board.pullPlanned(pulled.id, "claude", "codex", 0, "ready");
  const review = board.propose(USER, { title: "waiting", class: "implement" });
  board.update(review.id, USER, "accepted", { owner: "codex", reviewer: USER, state: "in_progress" }); board.update(review.id, USER, "done", { state: "in_review" });
  board.close();
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, tasks: { ...DEFAULT_CONFIG.tasks, wip_limits: { codex: 3 } } } });
  const client = await ControlClient.connect(stateDir, { role: "console" });
  try {
    const status = (await client.request({ t: "status" })).status;
    expect(status.taskWip.codex).toEqual({ wip: 2, active: 0, reviewWait: 1, reserved: 1, wipLimit: 3 });
    const snapshot = await client.request({ t: "ui_snapshot" });
    expect(snapshot.boardLegend.find((row: { peer: string }) => row.peer === "codex")).toMatchObject({ wip: 2, wipLimit: 3, wipBreakdown: { active: 0, reviewWait: 1, reserved: 1 } });
    expect(JSON.stringify(status.taskWip)).not.toContain("PRIVATE_RESERVED_TITLE");           // counts only, never a title
  } finally { client.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true }); }
}, 20000);
