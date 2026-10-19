import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeAgyHook, encodeAgyHook, readAgyTranscript } from "../src/adapters/agy/hooks.ts";
import { NativeHookLaunches } from "../src/hub/native-hook-launch.ts";

const session = "ee5ab2ab-7319-4a81-82ca-bf2fc84678d0";
const payload = { conversationId: session, transcriptPath: "/tmp/transcript_full.jsonl", workspacePaths: ["/tmp/work"], invocationNum: 0 };

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
  const launches = new NativeHookLaunches(), first = launches.begin("agy");
  expect(() => launches.begin("agy")).toThrow("already active");
  expect(launches.end("agy", "stale")).toBe(false);
  expect(launches.end("agy", first.id)).toBe(true);
  const replacement = launches.begin("agy");
  expect(launches.get("agy", first.id)).toBeUndefined(); expect(launches.end("agy", first.id)).toBe(false);
  expect(launches.get("agy", replacement.id)).toBe(replacement);
});
