import { expect, test } from "bun:test";
import { renderStatus } from "../src/cli/output.ts";

test("human status shows the bound generation and nonzero malformed count without hiding an unavailable binding", () => {
  const rows = renderStatus({ peers: {}, memoryProfile: { profile: "generation", generation: "a".repeat(32), agentMemVersion: "0.3.0", state: "unavailable", skippedRows: 3, error: "memory profile unavailable; restart the hub" } });
  const text = rows.map(row => row.map(span => span.text).join("")).join("\n");
  expect(text).toContain("generation aaaaaaaa");
  expect(text).toContain("agent-mem 0.3.0");
  expect(text).toContain("malformed legacy rows skipped: 3");
  expect(text).toContain("restart the hub");
});

test("human shared-v1 status omits a zero malformed count and older status remains renderable", () => {
  const plain = (value: Parameters<typeof renderStatus>[0]) => renderStatus(value).map(row => row.map(span => span.text).join("")).join("\n");
  const text = plain({ peers: {}, memoryProfile: { profile: "shared-v1", state: "ready", skippedRows: 0, agentMemVersion: "0.3.0" } });
  expect(text).toContain("shared-v1"); expect(text).not.toContain("malformed");
  expect(plain({ peers: {} })).toContain("agent-hub");
});

test("human memory status reports automatic sync state without leaking error details", () => {
  const canary = "private-memory-entry-id-DO-NOT-SHOW";
  const text = renderStatus({ peers: {}, memoryProfile: { profile: "shared-v1", state: "ready", skippedRows: 0, agentMemVersion: "0.20.1",
    sync: { state: "failed", at: Date.parse("2026-11-05T00:00:00Z"), cause: "declined", declinedCount: 4, nextStep: canary } } })
    .map(row => row.map(span => span.text).join(" ")).join("\n");
  expect(text).toContain("memory sync");
  expect(text).toContain("automatic");
  expect(text).toContain("failed (declined, 4 declined)");
  expect(text).toContain("ahub memory declined");
  expect(text).not.toContain(canary);
});
