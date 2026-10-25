import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewerPrintPeer, reviewerNoVerdictLine, type ReviewerFailure, type ReviewerNoVerdict } from "../src/adapters/reviewer-print.ts";
import { codexReviewerBackend } from "../src/adapters/codex-review-isolation.ts";
import { HUB, newEnvelope } from "../src/hub/envelope.ts";
import type { DeliveryReceipt } from "../src/hub/peers.ts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const until = async (condition: () => boolean) => { for (let index = 0; index < 200 && !condition(); index++) await Bun.sleep(5); expect(condition()).toBe(true); };
const request = () => newEnvelope(HUB, "synthetic review", { kind: "review", to: ["fixture-review"], refs: { task: "1", commit: "a".repeat(40), reviewRevision: "7" } });
function fixture(frames: unknown[] = [], fallback: (failure: ReviewerFailure, current: () => boolean) => Promise<boolean | void> = async () => false, trace?: (value: ReviewerNoVerdict) => void) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-no-verdict-")), receipts: DeliveryReceipt[] = [], logs: string[] = [];
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const peer = new ReviewerPrintPeer("fixture-review", { cwd, mcpConfig: "{}", systemPrompt: "fixture", watchdogMs: 5000,
    backend: { id: "fixture", prepare: async () => ({ command: [process.execPath, "-e", `await new Response(Bun.stdin.stream()).text(); for (const frame of ${JSON.stringify(frames)}) console.log(JSON.stringify(frame));`], args: [],
      isolation: { backend: "fixture", version: "fixture", binary: process.execPath, profile: "fixture", readOnly: true, strictMcp: true, ephemeral: true, evidence: ["fixture only"] } }),
      toolTrace: event => { const value = codexReviewerBackend.toolTrace?.(event); if (value) peer.reviewing = undefined; return value; } },
    verdictSince: () => false, onUnavailable: fallback, ...(trace ? { onNoVerdict: trace } : {}), log: line => logs.push(line) });
  cleanup.push(() => peer.stop()); peer.onDelivery = value => receipts.push(value);
  return { peer, receipts, logs };
}

test("a no-verdict exit logs one fixed diagnostic and completes only after the confirmed reoffer", async () => {
  let entered = false, confirmed = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); cleanup.push(() => release());
  const f = fixture([], async (_failure, current) => { entered = true; expect(current()).toBe(true); await held; confirmed = true; return true; });
  await f.peer.start(); await f.peer.deliver([request()], "confirmed");
  await until(() => entered);
  expect(f.receipts.map(value => value.state)).toEqual(["accepted"]);
  release(); await until(() => f.peer.state === "idle");
  expect(confirmed).toBe(true); expect(f.receipts.map(value => value.state)).toEqual(["accepted", "completed"]);
  expect(f.logs.filter(line => line.includes("no verdict"))).toEqual(["[fixture-review] review of task #1: no verdict exit=0; no hub_review call"]);
});

for (const mode of ["false", "throw"] as const) test(`unconfirmed ${mode} fallback keeps a no-verdict delivery held`, async () => {
  const f = fixture([], async () => { if (mode === "throw") throw new Error("PRIVATE_FALLBACK_BODY"); return false; });
  await f.peer.start(); await f.peer.deliver([request()], "unconfirmed"); await until(() => f.peer.state === "idle");
  expect(f.receipts.map(value => value.state)).toEqual(["accepted", "needs_review"]);
  expect(f.logs.join("\n")).not.toContain("PRIVATE_FALLBACK_BODY");
});

test("structured native MCP errors survive revoked leader authority as metadata without retaining arguments or prose", async () => {
  const frames = [{ type: "item.completed", item: { type: "agent_message", text: "PRIVATE_MODEL_PROSE" } },
    { type: "item.completed", item: { type: "mcp_tool_call", server: "agent-hub", tool: "hub_review", arguments: { note: "PRIVATE_ARGUMENT_BODY" }, error: { message: "approval refused before host" }, status: "failed" } }];
  const observations: ReviewerNoVerdict[] = [], f = fixture(frames, async () => false, value => observations.push(value));
  await f.peer.start(); await f.peer.deliver([request()]); await until(() => f.peer.state === "idle");
  expect(observations).toEqual([{ task: 1, head: "a".repeat(40), flowRevision: 7, exitCode: 0, reviewCalled: true, lastTool: "hub_review", refusal: "approval refused before host" }]);
  expect(JSON.stringify(observations)).not.toContain("PRIVATE_ARGUMENT_BODY"); expect(JSON.stringify(observations)).not.toContain("PRIVATE_MODEL_PROSE");
});

test("native MCP tracing accepts only the pinned structured hub tool fields", () => {
  // Pinned upstream shape: openai/codex rust-v0.164.0 sdk/typescript/src/items.ts McpToolCallItem.
  const item = { type: "mcp_tool_call", server: "agent-hub", tool: "hub_task_show", error: { message: "task read refused" } };
  expect(codexReviewerBackend.toolTrace?.({ type: "item.completed", item })).toEqual({ tool: "hub_task_show", refusal: "task read refused" });
  for (const value of [null, {}, { type: "item.completed", item: { ...item, server: "other" } }, { type: "item.completed", item: { ...item, tool: "hub_task_accept" } }, { type: "item.completed", item: { type: "agent_message", text: "not diagnostic" } }]) expect(codexReviewerBackend.toolTrace?.(value)).toBeUndefined();
  expect(() => codexReviewerBackend.toolTrace?.({ type: "item.completed", item: { ...item, error: undefined, result: { isError: true, content: {} } } })).not.toThrow();
});

test("no-verdict formatting is one bounded line and removes control characters", () => {
  const raw = String.fromCharCode(27) + "[31mrefused\n" + String.fromCharCode(7) + "한글 ".repeat(500);
  const line = reviewerNoVerdictLine("fixture-review", { task: 1, exitCode: 2, reviewCalled: true, lastTool: "hub_review", refusal: raw }, raw);
  expect(Array.from(line).length).toBeLessThan(400); expect(line).not.toContain("\n"); expect(line).not.toContain(String.fromCharCode(27)); expect(line).not.toContain(String.fromCharCode(7));
});
