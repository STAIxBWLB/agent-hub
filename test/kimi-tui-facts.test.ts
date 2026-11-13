import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeKimiTuiHook, readKimiTuiTranscript } from "../src/adapters/kimi-tui-facts.ts";

const session = "session_12345678-1234-1234-1234-123456789abc";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ahub-kimi-tui-facts-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, "sessions", "wd_fixture", session), main = join(directory, "agents", "main");
  mkdirSync(main, { recursive: true });
  const index = join(home, "session_index.jsonl");
  writeFileSync(index, `${JSON.stringify({ sessionId: session, sessionDir: directory })}\n`);
  return { home, directory, main, index, wire: join(main, "wire.jsonl") };
}
function turn(turnId: number, origin = "user") {
  return { type: "turn.prompt", agentId: "main", turnId, promptId: `msg-${turnId}`, origin: { kind: origin }, input: [{ type: "text", text: "PRIVATE-PROMPT" }] };
}
function end(turnId: number, reason: string) {
  return [
    { type: "turn.ended", agentId: "main", turnId, reason, error: { message: "PRIVATE-ERROR" } },
    ...(reason === "cancelled" ? [{ type: "prompt.aborted", agentId: "main", promptId: `msg-${turnId}` }] : [{ type: "prompt.completed", agentId: "main", promptId: `msg-${turnId}`, reason }]),
  ];
}
function writeWire(file: string, rows: unknown[]) { writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`); }
function task(main: string, id: string, status: string, endedAt: number | null) {
  mkdirSync(join(main, "tasks"), { recursive: true });
  writeFileSync(join(main, "tasks", `${id}.json`), JSON.stringify({ taskId: id, status, endedAt, command: "PRIVATE-COMMAND" }));
}

test("Kimi hook input carries only candidate identity, never prompt or task text", () => {
  const old = process.env.KIMI_CODE_HOME; process.env.KIMI_CODE_HOME = "/fixture/kimi-home";
  cleanup.push(() => { if (old === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = old; });
  const base = { session_id: session, client_type: "kimi_code_cli", cwd: "/fixture/project" };
  expect(decodeKimiTuiHook("TurnStarted", { ...base, hook_event_name: "TurnStarted", turn_id: 4, origin_kind: "user", prompt: "PRIVATE-PROMPT" })).toMatchObject({
    event: "TurnStarted", phase: "start", sessionId: session, transcriptPath: "/fixture/kimi-home/session_index.jsonl", workspacePaths: ["/fixture/project"], input: {},
  });
  expect(decodeKimiTuiHook("TaskStarted", { ...base, hook_event_name: "TaskStarted", task_id: "bash-1", description: "PRIVATE-COMMAND" })?.input).toEqual({});
  for (const [event, payload] of [["TurnStarted", { ...base, hook_event_name: "TurnStarted", turn_id: -1 }], ["Stop", { ...base, hook_event_name: "Stop", cwd: "relative" }], ["Interrupt", { ...base, hook_event_name: "Interrupt", turn_id: 1, client_type: "other" }]] as const) {
    expect(decodeKimiTuiHook(event, payload)).toBeUndefined();
  }
});

test("a candidate turn has no completion until its correlated final rows arrive, and active background work is counted", () => {
  const f = fixture();
  writeWire(f.wire, [turn(1)]);
  expect(readKimiTuiTranscript(session, f.index)).toMatchObject({ started: { index: 1, origin: "user" }, background: 0 });
  expect(readKimiTuiTranscript(session, f.index).completion).toBeUndefined();
  writeWire(f.wire, [turn(1), ...end(1, "completed")]);
  expect(readKimiTuiTranscript(session, f.index).completion).toMatchObject({ index: 1, reason: "completed" });
  task(f.main, "bash-1", "running", null);
  expect(readKimiTuiTranscript(session, f.index).background).toBe(1);
  task(f.main, "bash-1", "completed", 20);
  expect(readKimiTuiTranscript(session, f.index).background).toBe(0);
  task(f.main, "bash-2", "mystery", null);
  expect(readKimiTuiTranscript(session, f.index).background).toBeUndefined();
  expect(readKimiTuiTranscript(session, f.index)).toMatchObject({ completion: { index: 1, reason: "completed" }, started: { origin: "user" } });
});

test("final reason, prompt correlation, replay and task-origin facts stay closed", () => {
  const f = fixture();
  writeWire(f.wire, [turn(1, "task"), ...end(1, "failed")]);
  const failed = readKimiTuiTranscript(session, f.index);
  expect(failed.started).toMatchObject({ index: 1, origin: "task" });
  expect(failed.completion).toMatchObject({ index: 1, reason: "failed" });
  writeWire(f.wire, [turn(1), ...end(1, "cancelled")]);
  expect(readKimiTuiTranscript(session, f.index).completion).toMatchObject({ index: 1, reason: "cancelled" });
  writeWire(f.wire, [turn(1), ...end(1, "completed"), turn(2)]);
  expect(readKimiTuiTranscript(session, f.index)).toMatchObject({ started: { index: 2 }, completion: { index: 1 } });
  writeWire(f.wire, [turn(1), { ...turn(2), promptId: undefined }, { type: "turn.ended", turnId: 2, reason: "completed" }]);
  expect(readKimiTuiTranscript(session, f.index).completion).toMatchObject({ index: 2, reason: "completed" });
  writeWire(f.wire, [turn(1), { type: "turn.ended", turnId: 1, reason: "completed" }, { type: "prompt.completed", turnId: 1, promptId: "other", reason: "completed" }]);
  expect(readKimiTuiTranscript(session, f.index).completion).toBeUndefined();
  expect(JSON.stringify(readKimiTuiTranscript(session, f.index))).not.toContain("PRIVATE");
});

test("readback refuses another session, a partial final row, a linked wire and a linked task file", () => {
  const f = fixture();
  writeWire(f.wire, [turn(1), ...end(1, "completed")]);
  expect(readKimiTuiTranscript("session_other", f.index)).toEqual({ factIds: [] });
  expect(readKimiTuiTranscript(session, join(f.home, "missing.jsonl"))).toEqual({ factIds: [] });
  writeFileSync(f.wire, JSON.stringify(turn(1)));
  expect(readKimiTuiTranscript(session, f.index)).toEqual({ factIds: [] });
  writeWire(f.wire, [turn(1), ...end(1, "completed")]);
  const linked = join(f.home, "linked.jsonl");
  symlinkSync(f.wire, linked);
  expect(readKimiTuiTranscript(session, linked)).toEqual({ factIds: [] });
  task(f.main, "bash-1", "running", null);
  const outside = join(f.home, "outside.json");
  writeFileSync(outside, JSON.stringify({ taskId: "bash-1", status: "completed", endedAt: 1 }));
  rmSync(join(f.main, "tasks", "bash-1.json"));
  symlinkSync(outside, join(f.main, "tasks", "bash-1.json"));
  expect(readKimiTuiTranscript(session, f.index).background).toBeUndefined();
});
