import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeTranscriptCompletion, readClaudeTranscriptUsage } from "../src/hub/usage.ts";

test("Claude transcript usage collapses streamed message records and exposes no transcript identity or text", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-transcript-"));
  const file = join(dir, "session-secret.jsonl");
  writeFileSync(file, [
    JSON.stringify({ type: "assistant", timestamp: "2026-10-02T00:00:01Z", message: { id: "msg-secret", stop_reason: null, usage: { input_tokens: 99, output_tokens: 1 }, content: [{ text: "private prompt" }] } }),
    JSON.stringify({ type: "assistant", sessionId: "other-session", timestamp: "2026-10-02T00:00:03Z", message: { id: "wrong-session", stop_reason: "end_turn", usage: { input_tokens: 1000 } } }),
    JSON.stringify({ type: "assistant", sessionId: "session-secret", timestamp: "2026-10-02T00:00:02Z", message: { id: "msg-secret", stop_reason: "end_turn", model: "vendor/claude-5", usage: { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 21, cache_creation_input_tokens: 5 }, content: [{ text: "private answer" }] } }),
    "{truncated",
  ].join("\n"));
  try {
    const records = readClaudeTranscriptUsage("session-secret", file);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ at: "2026-10-02T00:00:02.000Z", servedModel: "vendor/claude-5", usage: { inputTokens: 8, outputTokens: 3, cacheReadTokens: 21, cacheWriteTokens: 5 } });
    expect(JSON.stringify(records)).not.toContain("session-secret");
    expect(JSON.stringify(records)).not.toContain("msg-secret");
    expect(JSON.stringify(records)).not.toContain("private");
    expect(readClaudeTranscriptUsage("session-secret", file)[0]!.id).toBe(records[0]!.id);
    const pathlessSession = join(dir, "session-without-row-identity.jsonl");
    writeFileSync(pathlessSession, JSON.stringify({ type: "assistant", timestamp: "2026-10-02T00:00:02Z", message: { id: "msg-secret", stop_reason: "end_turn", usage: { input_tokens: 8 } } }));
    expect(readClaudeTranscriptUsage("session-resumed", pathlessSession)[0]!.id).not.toBe(records[0]!.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude transcript source fails open for missing files and malformed or uncompleted records", () => {
  expect(readClaudeTranscriptUsage("s", "/missing/no-session.jsonl")).toEqual([]);
  const dir = mkdtempSync(join(tmpdir(), "agenthub-transcript-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, JSON.stringify({ type: "assistant", message: { id: "partial", stop_reason: null, usage: { input_tokens: 2 } } }));
  try { expect(readClaudeTranscriptUsage("s", file)).toEqual([]); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Claude transcript source reports completed messages whose provider omitted usage as unknown", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-transcript-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, JSON.stringify({ type: "assistant", timestamp: "2026-10-02T00:00:00Z", message: { id: "m1", stop_reason: "end_turn", model: "claude-opus" } }));
  try {
    const records = readClaudeTranscriptUsage("s", file);
    expect(records).toHaveLength(1);
    expect(records[0]!.servedModel).toBe("claude-opus");
    expect(records[0]).not.toHaveProperty("usage");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Claude native transcript stop_sequence records and documented successful stop reasons are retained", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-transcript-"));
  const file = join(dir, "session.jsonl");
  const reasons = ["stop_sequence", "stop_sequence", "stop_sequence", "stop_sequence", "pause_turn", "refusal", "model_context_window_exceeded", "compaction"];
  writeFileSync(file, reasons.map((stop_reason, i) => JSON.stringify({ type: "assistant", message: { id: `m${i}`, stop_reason, model: "claude-opus", usage: { input_tokens: 10 + i, output_tokens: 2 } } })).join("\n"));
  try {
    const records = readClaudeTranscriptUsage("s", file);
    expect(records).toHaveLength(8);
    expect(records.slice(0, 4).reduce((sum, record) => sum + (record.usage?.inputTokens ?? 0), 0)).toBe(46);
    expect(records.slice(0, 4).every((record) => record.usage?.outputTokens === 2)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unknown non-null stop reasons count as unknown usage and oversized transcripts signal unavailable coverage", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-transcript-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, JSON.stringify({ type: "assistant", message: { id: "future", stop_reason: "future_reason", usage: { input_tokens: 50 } } }));
  try {
    const unknown = readClaudeTranscriptUsage("s", file);
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).not.toHaveProperty("usage");
    writeFileSync(file, "");
    truncateSync(file, 32 * 1024 * 1024 + 1);
    const unavailable = readClaudeTranscriptUsage("s", file);
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]).not.toHaveProperty("usage");
    expect(unavailable[0]!.id).toBe(readClaudeTranscriptUsage("s", file)[0]!.id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn completion reads the transcript tail at any size: the 32 MiB usage cap no longer hides it (#517)", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-transcript-tail-"));
  const file = join(dir, "s.jsonl");
  const row = (id: string, stop: string, at: string) => JSON.stringify({ type: "assistant", sessionId: "s", timestamp: at, message: { id, stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } } });
  try {
    writeFileSync(file, [row("old-turn", "end_turn", "2026-10-02T00:00:01Z"), "x".repeat(33 * 1024 * 1024), row("new-turn", "end_turn", "2026-10-02T00:00:03Z"), row("later-tool", "tool_use", "2026-10-02T00:00:04Z"), "{partial"].join("\n"));
    expect(readClaudeTranscriptUsage("s", file)).toHaveLength(1); // the usage reader keeps its cap: one opaque coverage record
    expect(readClaudeTranscriptUsage("s", file)[0]!.completedTurn).toBeUndefined();
    const done = readClaudeTranscriptCompletion("s", file)!;
    expect(done).toMatchObject({ completedTurn: true, at: "2026-10-02T00:00:03.000Z" });
    // Same opaque id as the whole-file reader gives the same message, so baseline comparisons hold.
    const small = join(dir, "small.jsonl"); writeFileSync(small, row("new-turn", "end_turn", "2026-10-02T00:00:03Z"));
    expect(done.id).toBe(readClaudeTranscriptUsage("s", small)[0]!.id);
    // A cut inside a row drops that partial line instead of misreading it.
    const two = join(dir, "two.jsonl"), b = row("b-turn", "end_turn", "2026-10-02T00:00:06Z");
    writeFileSync(two, [row("a-turn", "end_turn", "2026-10-02T00:00:05Z"), b].join("\n"));
    expect(readClaudeTranscriptCompletion("s", two, b.length + 10)?.at).toBe("2026-10-02T00:00:06.000Z");
    expect(readClaudeTranscriptCompletion("s", two, b.length - 10)).toBeUndefined();
    expect(readClaudeTranscriptCompletion("s", join(dir, "missing.jsonl"))).toBeUndefined();
    // A cut tail without any newline is one partial line: never parsed, even when its suffix is valid JSON.
    const corrupt = join(dir, "corrupt.jsonl"), last = row("suffix-turn", "end_turn", "2026-10-02T00:00:07Z");
    writeFileSync(corrupt, "garbage-prefix" + last);
    expect(readClaudeTranscriptUsage("s", corrupt).some(r => r.completedTurn)).toBe(false);
    expect(readClaudeTranscriptCompletion("s", corrupt, last.length)).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
