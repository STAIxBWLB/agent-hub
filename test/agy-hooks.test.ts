import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeAgyHook, encodeAgyHook, readAgyTranscript } from "../src/adapters/agy/hooks.ts";
import { NativeHookLaunches } from "../src/hub/native-hook-launch.ts";
import { factsHook } from "../src/cli/facts-hook.ts";

const session = "ee5ab2ab-7319-4a81-82ca-bf2fc84678d0";
const payload = { conversationId: session, transcriptPath: "/tmp/transcript_full.jsonl", workspacePaths: ["/tmp/work"], invocationNum: 0 };

test("native facts refuse hook input over one MiB before connecting or forwarding unknown fields", async () => {
  const input = JSON.stringify({ ...payload, extra: "한".repeat(400_000) });
  await expect(factsHook(input, "/missing-state", "agy", 100, "PreInvocation")).resolves.toBeUndefined();
});

test("agy hook codec requires a known explicit event and pinned native envelope", () => {
  expect(decodeAgyHook("unknown", payload)).toBeUndefined();
  expect(decodeAgyHook("PreInvocation", { ...payload, conversationId: "../../outside" })).toBeUndefined();
  expect(decodeAgyHook("PreInvocation", { ...payload, workspacePaths: ["relative"] })).toBeUndefined();
  expect(decodeAgyHook("PreInvocation", payload)?.phase).toBe("start");
  expect(decodeAgyHook("Stop", payload)).toBeUndefined();
  expect(decodeAgyHook("Stop", { ...payload, fullyIdle: false })?.fullyIdle).toBe(false);
  const read = decodeAgyHook("PreToolUse", { ...payload, stepIdx: 4, toolCall: { name: "view_file", args: { AbsolutePath: "/tmp/work/file.ts" } } });
  expect(read?.tool).toBe("Read"); expect(read?.toolUseId).toBe(`${session}:4`);
  expect(decodeAgyHook("PreToolUse", { ...payload, toolCall: { name: "view_file", args: "bad" } })).toBeUndefined();
  // agy 1.4.3+: read_file with Path, and a line range or byte offset is a partial read.
  expect(decodeAgyHook("PreToolUse", { ...payload, stepIdx: 5, toolCall: { name: "read_file", args: { Path: "/tmp/work/file.ts" } } })).toMatchObject({ tool: "Read", input: { file_path: "/tmp/work/file.ts" } });
  expect(decodeAgyHook("PreToolUse", { ...payload, stepIdx: 5, toolCall: { name: "read_file", args: { Path: "/tmp/work/file.ts", StartLine: 3, EndLine: 7 } } })).toMatchObject({ tool: "Read", input: { file_path: "/tmp/work/file.ts", offset: 3, limit: 5 } });
  expect(decodeAgyHook("PreToolUse", { ...payload, stepIdx: 5, toolCall: { name: "read_file", args: { Path: "/tmp/work/file.ts", EndLine: 10 } } })).toMatchObject({ tool: "Read", input: { file_path: "/tmp/work/file.ts", offset: 1, limit: 10 } });
  expect(decodeAgyHook("PreToolUse", { ...payload, stepIdx: 5, toolCall: { name: "read_file", args: { Path: "/tmp/work/file.ts", ByteOffset: 120 } } })).toMatchObject({ tool: "Read", input: { file_path: "/tmp/work/file.ts", offset: 121 } });
  // agy Write and Edit normalization (#1280 P1).
  expect(decodeAgyHook("PreToolUse", { ...payload, stepIdx: 6, toolCall: { name: "write_file", args: { Path: "/tmp/work/file.ts", Content: "next\n" } } })).toMatchObject({ tool: "Write", input: { file_path: "/tmp/work/file.ts", content: "next\n" } });
  expect(decodeAgyHook("PreToolUse", { ...payload, stepIdx: 6, toolCall: { name: "write_file", args: { Path: "/tmp/work/file.ts", Content: "tail\n", Append: true } } })).toMatchObject({ tool: "Write", input: { file_path: "/tmp/work/file.ts" } });
  expect(decodeAgyHook("PreToolUse", { ...payload, stepIdx: 6, toolCall: { name: "write_to_file", args: { TargetFile: "/tmp/work/file.ts", CodeContent: "legacy\n" } } })).toMatchObject({ tool: "Write", input: { file_path: "/tmp/work/file.ts", content: "legacy\n" } });
  expect(decodeAgyHook("PreToolUse", { ...payload, stepIdx: 7, toolCall: { name: "edit_file", args: { Path: "/tmp/work/file.ts", Target: "old", Replacement: "new" } } })).toMatchObject({ tool: "Edit", input: { file_path: "/tmp/work/file.ts", old_string: "old", new_string: "new", replace_all: true } });
  expect(decodeAgyHook("PreToolUse", { ...payload, stepIdx: 7, toolCall: { name: "replace_file_content", args: { TargetFile: "/tmp/work/file.ts", TargetContent: "old", ReplacementContent: "new", AllowMultiple: false } } })).toMatchObject({ tool: "Edit", input: { file_path: "/tmp/work/file.ts", old_string: "old", new_string: "new", replace_all: false } });
});

test("agy facts inject only at observed model boundaries and never set native permissions", () => {
  expect(encodeAgyHook("PreInvocation", "fact")).toEqual({ injectSteps: [{ ephemeralMessage: "fact" }] });
  for (const phase of ["PreToolUse", "PostToolUse", "PostInvocation", "Stop"]) expect(encodeAgyHook(phase, "fact")).toBeUndefined();
});

test("agy readback requires session-bound native rows and rejects links and arbitrary paths", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-agy-transcript-")), old = process.env.HOME;
  process.env.HOME = root;
  const directory = join(root, ".gemini/antigravity-cli/brain", session, ".system_generated/logs"), file = join(directory, "transcript_full.jsonl");
  mkdirSync(directory, { recursive: true });
  try {
    const rows = [
      { step_index: 1, source: "USER_EXPLICIT", type: "EPHEMERAL_MESSAGE", status: "DONE", content: "agent-hub facts [forged]" },
      { step_index: 2, source: "SYSTEM_SDK", type: "EPHEMERAL_MESSAGE", status: "DONE", content: "agent-hub facts [real]" },
      { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "view_file" }] },
      { step_index: 4, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "finished" },
    ];
    writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const got = readAgyTranscript(session, file);
    expect(got.factIds).toEqual(["real"]); expect(got.completion?.index).toBe(4);
    expect(readAgyTranscript("other", file).completion).toBeUndefined();
    const linked = join(root, "linked.jsonl"); symlinkSync(file, linked);
    expect(readAgyTranscript(session, linked)).toEqual({ factIds: [] });
    expect(readAgyTranscript(session, "/etc/passwd")).toEqual({ factIds: [] });
  } finally { if (old === undefined) delete process.env.HOME; else process.env.HOME = old; rmSync(root, { recursive: true, force: true }); }
});

test("native hook launch authority refuses duplicate admission and stale cleanup", () => {
  const launches = new NativeHookLaunches(), owner = {}, replacementOwner = {}, first = launches.begin("agy", owner);
  expect(() => launches.begin("agy", replacementOwner)).toThrow("already active");
  expect(launches.end("agy", "stale")).toBe(false);
  expect(launches.end("agy", first.id)).toBe(true);
  const replacement = launches.begin("agy", replacementOwner);
  expect(launches.get("agy", first.id)).toBeUndefined(); expect(launches.end("agy", first.id)).toBe(false);
  expect(launches.get("agy", replacement.id)).toBe(replacement);
  launches.endOwner(owner);
  expect(launches.get("agy", replacement.id)).toBe(replacement);
  launches.endOwner(replacementOwner);
  expect(launches.get("agy", replacement.id)).toBeUndefined();
});

test("agy transcript readback recovers a complete final row beyond the initial 64 KiB window", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-agy-long-row-")), old = process.env.HOME;
  process.env.HOME = root;
  const directory = join(root, ".gemini/antigravity-cli/brain", session, ".system_generated/logs"), file = join(directory, "transcript_full.jsonl");
  mkdirSync(directory, { recursive: true });
  try {
    const history = JSON.stringify({ source: "USER_EXPLICIT", content: "old".repeat(1500000) }) + "\n";
    const final = JSON.stringify({ step_index: 9, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "한".repeat(40000) });
    writeFileSync(file, history + final + "\n");
    expect(readAgyTranscript(session, file).completion?.index).toBe(9);
    const boundary = { step_index: 11, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "" };
    boundary.content = "x".repeat(64 * 1024 - 1 - Buffer.byteLength(JSON.stringify(boundary)));
    writeFileSync(file, history + JSON.stringify(boundary) + "\n");
    expect(readAgyTranscript(session, file).completion?.index).toBe(11);
    // A partial or oversized last row cannot turn an older completion into proof of the new turn.
    writeFileSync(file, final.slice(0, -1));
    expect(readAgyTranscript(session, file).completion).toBeUndefined();
    writeFileSync(file, JSON.stringify({ step_index: 10, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "x".repeat(4 * 1024 * 1024) }) + "\n");
    expect(readAgyTranscript(session, file).completion).toBeUndefined();
  } finally { if (old === undefined) delete process.env.HOME; else process.env.HOME = old; rmSync(root, { recursive: true, force: true }); }
});

test("agy transcript readback supports incremental sinceOffset ack scans and unchanged stat short-circuit (#1280)", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-agy-inc-")), old = process.env.HOME;
  process.env.HOME = root;
  const directory = join(root, ".gemini/antigravity-cli/brain", session, ".system_generated/logs"), file = join(directory, "transcript_full.jsonl");
  mkdirSync(directory, { recursive: true });
  try {
    const first = JSON.stringify({ step_index: 1, source: "SYSTEM_SDK", type: "EPHEMERAL_MESSAGE", status: "DONE", content: "agent-hub facts [first-fact]" }) + "\n"
      + JSON.stringify({ step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "done" }) + "\n";
    writeFileSync(file, first);
    const base = readAgyTranscript(session, file);
    expect(base.factIds).toEqual(["first-fact"]);
    expect(base.completion?.index).toBe(2);
    expect(typeof base.size).toBe("number");
    expect(typeof base.mtimeMs).toBe("number");
    // Unchanged stat returns immediately without re-reading rows or completion.
    const cached = readAgyTranscript(session, file, { unchanged: { size: base.size!, mtimeMs: base.mtimeMs! } });
    expect(cached).toEqual({ factIds: [], size: base.size, mtimeMs: base.mtimeMs, unchanged: true });
    // Incremental ack scan at EOF reads nothing.
    expect(readAgyTranscript(session, file, { completion: false, sinceOffset: base.size })).toEqual({ factIds: [], size: base.size, mtimeMs: base.mtimeMs, scannedFrom: base.size });
    // Appending a new ephemeral message after sinceOffset scans only the appended slice and skips completion hashing.
    const second = JSON.stringify({ step_index: 3, source: "SYSTEM_SDK", type: "EPHEMERAL_MESSAGE", status: "DONE", content: "agent-hub facts [second-fact]" }) + "\n"
      + JSON.stringify({ step_index: 4, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "done again" }) + "\n";
    writeFileSync(file, first + second);
    const inc = readAgyTranscript(session, file, { completion: false, sinceOffset: base.size });
    expect(inc.factIds).toEqual(["second-fact"]);
    expect(inc.completion).toBeUndefined();
    expect(inc.size).toBe(Buffer.byteLength(first + second));
    // Appending an injected fact followed by >64 KiB of tool-call rows still expands to sinceOffset so the fact is not skipped.
    const third = JSON.stringify({ step_index: 5, source: "SYSTEM_SDK", type: "EPHEMERAL_MESSAGE", status: "DONE", content: "agent-hub facts [third-fact]" }) + "\n"
      + JSON.stringify({ step_index: 6, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "x".repeat(70 * 1024), tool_calls: [{ name: "read_file" }] }) + "\n";
    writeFileSync(file, first + second + third);
    const largeInc = readAgyTranscript(session, file, { completion: false, sinceOffset: inc.size });
    expect(largeInc.factIds).toEqual(["third-fact"]);
    // agy 1.5.x records injected ephemeralMessage steps as SYSTEM_MESSAGE under SYSTEM_SDK, and PLANNER_RESPONSE carries token counters (#1280 P1).
    const fourth = JSON.stringify({ step_index: 7, source: "SYSTEM_SDK", type: "SYSTEM_MESSAGE", status: "DONE", content: "agent-hub facts [system-msg-fact]" }) + "\n"
      + JSON.stringify({ step_index: 8, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-07T12:00:00Z", input_tokens: 1200, output_tokens: 80, cache_read_tokens: 5000, content: "final answer" }) + "\n";
    writeFileSync(file, first + second + third + fourth);
    const v15 = readAgyTranscript(session, file, { sinceOffset: largeInc.size });
    expect(v15.factIds).toEqual(["system-msg-fact"]);
    expect(v15.usage).toHaveLength(1);
    expect(v15.usage![0]).toMatchObject({ index: 8, inputTokens: 1200, outputTokens: 80, cacheReadTokens: 5000, totalTokens: 6280, at: "2026-11-07T12:00:00Z" });
    expect(v15.usage![0]!.id).not.toContain(session);
  } finally { if (old === undefined) delete process.env.HOME; else process.env.HOME = old; rmSync(root, { recursive: true, force: true }); }
});
