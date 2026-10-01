import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Task } from "../src/hub/board.ts";
import { conflictsOf, pathWarnings } from "../src/hub/conflicts.ts";
import { Turns } from "../src/hub/snapshots.ts";

// issue #32: a turn's files against what other owners' open tasks changed before it.
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
const task = (id: number, owner: string): Task => ({ id, owner, title: `t${id}`, detail: "", class: "implement", reviewer: null, state: "in_progress", refs: {}, signals: [], rejections: 0, history: [], created: 0, updated: 0 });

test("a file another owner's open task changed is a conflict; one touched by one agent only is not", () => {
  const open = [task(1, "kimi"), task(2, "codex")];
  const touches = [
    { task: 1, peer: "kimi", path: "src/a.ts", at: 1 },
    { task: 1, peer: "kimi", path: "src/b.ts", at: 1 },
    { task: 2, peer: "codex", path: "src/c.ts", at: 2 },
  ];
  expect(conflictsOf("codex", ["src/a.ts", "src/c.ts", "src/new.ts"], touches, open)).toEqual([{ task: open[0]!, paths: ["src/a.ts"] }]);
  expect(conflictsOf("kimi", ["src/a.ts"], touches, open)).toEqual([]); // its own task
  expect(conflictsOf("codex", ["src/a.ts"], touches, [open[1]!])).toEqual([]); // task 1 is no longer open
  // task 1 changed hands, but only codex ever touched the file: one agent, no conflict
  expect(conflictsOf("codex", ["src/d.ts"], [{ task: 1, peer: "codex", path: "src/d.ts", at: 3 }], open)).toEqual([]);
});

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-checkpath-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  Bun.spawnSync(["git", "-C", root, "init", "-q"]);
  const stateDir = join(root, ".agenthub", "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".agenthub/\n");
  const db = join(stateDir, "hub.db");
  const board = new Board(db);
  const turns = new Turns(db);
  cleanup.push(() => (board.close(), turns.close()));
  return { root, stateDir, db, board, turns };
}

test("check-path names other owners' open tasks that claim or changed a file, never PII ones or the caller's own", () => {
  const { db, board, turns } = project();
  const claimed = board.propose("kimi", { title: "bus", class: "implement", refs: { paths: ["src/hub/"] } });
  board.update(claimed.id, "hub", "assigned", { owner: "kimi" });
  const planned = board.propose("codex", { title: "retry", class: "implement", plan: { paths: ["src/hub/bus.ts"] } });
  board.update(planned.id, "hub", "assigned", { owner: "codex" });
  const secret = board.propose("local", { title: "[pii]", class: "implement", refs: { paths: ["src/hub/bus.ts"] }, signals: ["pii"] });
  board.update(secret.id, "hub", "assigned", { owner: "local" });
  const mine = board.propose("claude", { title: "mine", class: "implement", refs: { paths: ["src/hub/bus.ts"] } });
  board.update(mine.id, "hub", "assigned", { owner: "claude" });
  const other = board.propose("pi", { title: "touched", class: "implement" });
  board.update(other.id, "hub", "assigned", { owner: "pi" });
  turns.touch(other.id, "pi", ["src/hub/bus.ts"]);
  expect(pathWarnings(db, "claude", { project: "src/hub/bus.ts", repo: "src/hub/bus.ts" })).toEqual([
    'task #1 "bus" (owner kimi, proposed) claims it',
    'task #2 "retry" (owner codex, proposed) claims it',
    'task #5 "touched" (owner pi, proposed) changed it',
  ]);
  expect(pathWarnings(db, "claude", { project: "docs/x.md", repo: "docs/x.md" })).toEqual([]);
});

test("the PreToolUse hook prints context for Claude and a line for the user, and stays silent and harmless otherwise", () => {
  const { root, stateDir, board } = project();
  const t = board.propose("kimi", { title: "bus", class: "implement", refs: { paths: ["src/hub/bus.ts"] } });
  board.update(t.id, "hub", "assigned", { owner: "kimi" });
  const hook = (input: string) => {
    const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli/main.js"), "check-path", "--hook"], { cwd: root, env: { ...process.env, AGENTHUB_STATE_DIR: stateDir }, stdin: new TextEncoder().encode(input) });
    return { code: r.exitCode, out: r.stdout.toString() };
  };
  const hit = hook(JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(root, "src/hub/bus.ts") }, cwd: root }));
  expect(hit.code).toBe(0);
  const out = JSON.parse(hit.out);
  expect(out.hookSpecificOutput).toEqual({ hookEventName: "PreToolUse", additionalContext: expect.stringContaining('task #1 "bus" (owner kimi, proposed) claims it') });
  expect(out.hookSpecificOutput.permissionDecision).toBeUndefined(); // the user's permission rules decide, as before
  expect(out.systemMessage).toBe("agent-hub: src/hub/bus.ts belongs to other open work:");
  expect(hook(JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(root, "README.md") } }))).toEqual({ code: 0, out: "" });
  expect(hook("not json")).toEqual({ code: 0, out: "" });
});
