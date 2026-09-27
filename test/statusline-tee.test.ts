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
