import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// issue #64: the hub learns the transcript path from the status line payload so it can
// tell a zero-turn session (file not yet created) from one that must be preserved.
test("the status line tee records the transcript path Claude reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-statusline-"));
  const input = JSON.stringify({
    session_id: "s-1",
    transcript_path: "/tmp/transcripts/s-1.jsonl",
    rate_limits: { five_hour: { used_percentage: 12, resets_at: 0 }, seven_day: { used_percentage: 3, resets_at: 0 } },
  });
  const res = spawnSync(process.execPath, [join(import.meta.dir, "../src/cli/statusline-tee.ts")], {
    input, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, AGENTHUB_STATE_DIR: dir, AGENTHUB_INSTANCE_ID: "i-tee" },
  });
  expect(res.status).toBe(0);
  const recorded = JSON.parse(readFileSync(join(dir, "claude-session.json"), "utf8"));
  expect(recorded.sessionId).toBe("s-1");
  expect(recorded.transcriptPath).toBe("/tmp/transcripts/s-1.jsonl");
  expect(recorded.instanceId).toBe("i-tee");
});

test("tee records bound context without quota fields and preserves the original stdin", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-context-tee-"));
  const input = JSON.stringify({ session_id: "s-context", context_window: { used_percentage: 90, context_window_size: 200_000, current_usage: { input_tokens: 180_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, arbitrary: "private text" }, arbitrary: "do not store me" });
  const res = spawnSync(process.execPath, [join(import.meta.dir, "../src/cli/statusline-tee.ts")], { input, encoding: "utf8", timeout: 10_000, env: { ...process.env, AGENTHUB_STATE_DIR: dir, AGENTHUB_INSTANCE_ID: "i-context", AGENTHUB_LAUNCH_ID: "l-context", AGENTHUB_STATUSLINE_CMD: "cat" } });
  expect(res.status).toBe(0); expect(res.stdout).toBe(input);
  const recorded = JSON.parse(readFileSync(join(dir, "claude-context.json"), "utf8"));
  expect(recorded.sessionId).toBe("s-context"); expect(recorded.instanceId).toBe("i-context"); expect(recorded.launchId).toBe("l-context");
  expect(recorded.context.used_percentage).toBe(90); expect(JSON.stringify(recorded)).not.toContain("private text"); expect(JSON.stringify(recorded)).not.toContain("do not store me");
});


test("tee persists numeric telemetry only, even for malformed native context payloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-invalid-context-tee-"));
  for (const current_usage of ["CONTEXT-PRIVATE-CANARY", ["CONTEXT-PRIVATE-CANARY"], { input_tokens: "CONTEXT-PRIVATE-CANARY", cache_creation_input_tokens: {}, cache_read_input_tokens: 0 }]) {
    const input = JSON.stringify({ session_id: "s-malformed", context_window: { used_percentage: "CONTEXT-PRIVATE-CANARY", context_window_size: { text: "CONTEXT-PRIVATE-CANARY" }, current_usage } });
    const res = spawnSync(process.execPath, [join(import.meta.dir, "../src/cli/statusline-tee.ts")], { input, encoding: "utf8", timeout: 10_000, env: { ...process.env, AGENTHUB_STATE_DIR: dir, AGENTHUB_STATUSLINE_CMD: "cat" } });
    expect(res.status).toBe(0); expect(res.stdout).toBe(input);
    const payload = readFileSync(join(dir, "claude-context.json"), "utf8"); expect(payload).not.toContain("CONTEXT-PRIVATE-CANARY");
    expect(JSON.parse(payload).context.used_percentage).toBeNull();
  }
});
