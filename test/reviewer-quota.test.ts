import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewerPrintPeer, type ReviewerBackend, type ReviewerFailure, type ReviewerPrintOptions } from "../src/adapters/reviewer-print.ts";
import { HUB, newEnvelope } from "../src/hub/envelope.ts";
import type { DeliveryReceipt } from "../src/hub/peers.ts";
import { claudeReviewerQuota, codexReviewerQuota, kimiReviewerQuotaOnExit, CODEX_EXEC_QUOTA_PREFIX, nativeReviewerQuota } from "../src/adapters/definitions/native-quota.ts";
import { KimiUsage } from "../src/hub/kimi-usage.ts";
import { readKimiReviewerUsage, kimiReviewerBackend } from "../src/adapters/kimi-review.ts";
import { OwnedPrintChild } from "../src/adapters/claude-print-child.ts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const until = async (ready: () => boolean) => { for (let i = 0; i < 400 && !ready(); i++) await Bun.sleep(5); expect(ready()).toBe(true); };
const request = (task: number) => newEnvelope(HUB, "Read the synthetic review", { kind: "review", to: ["quota-fixture"], refs: { task: String(task), commit: "a".repeat(40), reviewRevision: "7" } });
async function deadlineFixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-review-cap-")), marker = join(root, "child.pid"), callbacks: { run: () => void; ms: number }[] = [], cleared: unknown[] = [];
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const privateRoots: string[] = [], failures: ReviewerFailure[] = [], receipts: DeliveryReceipt[] = [];
  const control = { maxMinutes: 20, frames: 0, aliveAtFallback: false };
  const backend: ReviewerBackend = { id: "fixture", prepare: async () => {
    const own = mkdtempSync(join(root, "private-")); privateRoots.push(own); mkdirSync(join(own, "home"));
    return { command: [process.execPath, "-e", `await new Response(Bun.stdin.stream()).text();await Bun.write(${JSON.stringify(marker)},String(process.pid));for(let i=0;i<3;i++)process.stdout.write('{"type":"fixture_activity"}\\n');setInterval(()=>process.stdout.write('{"type":"fixture_activity"}\\n'),50);`], args: [], cwd: root,
      envMode: "replace" as const, env: { HOME: join(own, "home"), PATH: "/usr/bin:/bin", TMPDIR: own },
      isolation: { backend: "fixture", version: "fixture", binary: process.execPath, profile: "owned fake child only", readOnly: true as const, strictMcp: true, ephemeral: true, evidence: ["synthetic backend, no native/account/model proof"] },
      cleanup: () => rmSync(own, { recursive: true, force: true }) };
  }, usage: () => { control.frames++; return undefined; } };
  const options: ReviewerPrintOptions = { cwd: root, mcpConfig: "{}", systemPrompt: "fixture", watchdogMs: 10_000, backend,
    verdictSince: () => false, bindingCurrent: () => true, maxMinutes: () => control.maxMinutes,
    reviewTimer: { set: (run, ms) => { const entry = { run, ms }; callbacks.push(entry); return entry; }, clear: handle => { cleared.push(handle); } },
    onUnavailable: failure => {
      const pid = Number(readFileSync(marker, "utf8"));
      try { process.kill(pid, 0); control.aliveAtFallback = true; } catch { /* Owned group has been confirmed stopped. */ }
      failures.push(failure); return true;
    } };
  const peer = new ReviewerPrintPeer("quota-fixture", options); cleanup.push(() => peer.stop("fixture teardown")); peer.onDelivery = receipt => receipts.push(receipt);
  await peer.start();
  return { peer, marker, privateRoots, callbacks, cleared, failures, receipts, control };
}

test("per-review wall cap is not extended by native activity and reroutes typed timeout only after owned cleanup", async () => {
  const f = await deadlineFixture(); await f.peer.deliver([request(1)], "review-cap");
  await until(() => f.callbacks.length === 1 && f.control.frames >= 3 && existsSync(f.marker));
  expect(f.callbacks[0]!.ms).toBe(20 * 60_000);
  f.control.maxMinutes = 1;
  const token = f.peer.reviewToken(1); expect(token).toBeDefined(); expect(f.callbacks).toHaveLength(1);
  f.callbacks[0]!.run();
  expect(f.peer.reviewToken(1)).toBeUndefined();
  await until(() => f.failures.length === 1 && f.peer.state === "idle");
  expect(f.failures[0]).toEqual({ task: 1, head: "a".repeat(40), flowRevision: 7, cause: "no_verdict", reason: "review time cap" });
  expect(f.control.aliveAtFallback).toBe(false); expect(f.privateRoots.every(root => !existsSync(root))).toBe(true);
  expect(f.receipts.some(receipt => receipt.state === "needs_review" && receipt.failureCause === "timeout")).toBe(true);
  expect(f.cleared).toContain(f.callbacks[0]);
});

test("a stale per-review deadline cannot stop a replacement review or a caller-stopped generation", async () => {
  const f = await deadlineFixture(); await f.peer.deliver([request(2)], "first-cap");
  await until(() => f.callbacks.length === 1 && existsSync(f.marker)); f.callbacks[0]!.run();
  await until(() => f.peer.state === "idle");
  f.control.maxMinutes = 1; await f.peer.deliver([request(3)], "second-cap");
  await until(() => f.callbacks.length === 2 && f.peer.reviewToken(3) !== undefined);
  expect(f.callbacks[1]!.ms).toBe(60_000);
  const token = f.peer.reviewToken(3); f.callbacks[0]!.run();
  expect(f.peer.reviewToken(3)).toBe(token); expect(f.failures).toHaveLength(1);
  await f.peer.stop("explicit fixture stop"); const count = f.receipts.length;
  f.callbacks[1]!.run(); expect(f.peer.state).toBe("offline"); expect(f.receipts).toHaveLength(count); expect(f.failures).toHaveLength(1);
  expect(f.cleared).toContain(f.callbacks[1]);
});

test("Claude native rate-limit metadata maps only rejection and copies safe window/reset fields", () => {
  const value = { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 2_000_000_000, hasCredits: true, accountId: "PRIVATE_ACCOUNT_CANARY" } };
  expect(claudeReviewerQuota(value)).toEqual({ id: "week", used: 1, windowMins: 10_080, source: "Claude reviewer quota", resetsAt: 2_000_000_000_000 });
  expect(claudeReviewerQuota({ type: "assistant", error: "rate_limit" })).toEqual({ id: "5h", used: 1, windowMins: 300, source: "Claude reviewer quota" });
  expect(claudeReviewerQuota({ ...value, rate_limit_info: { ...value.rate_limit_info, status: "allowed_warning" } })).toBeUndefined();
  expect(claudeReviewerQuota({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resets_at: 2_000_000_000, rate_limit_type: "seven_day" } })?.resetsAt).toBeUndefined();
  expect(JSON.stringify(claudeReviewerQuota(value))).not.toContain("PRIVATE_ACCOUNT_CANARY");
});

test("Codex0.166 native error/turn.failed envelope recognizes pinned refusal copy without invented app-server reset fields", () => {
  const message = CODEX_EXEC_QUOTA_PREFIX + " Try again later.";
  for (const frame of [{ type: "error", message }, { type: "turn.failed", error: { message } }]) {
    const result = codexReviewerQuota({ ...frame, resetsAt: 2_000_000_000, codexErrorInfo: "usageLimitExceeded" });
    expect(result).toEqual({ id: "5h", used: 1, windowMins: 300, source: "Codex reviewer quota" });
  }
  expect(codexReviewerQuota({ type: "error", message: "Your workspace is out of credits. Add credits to continue." })?.used).toBe(1);
  for (const frame of [{ type: "assistant", message }, { type: "item.completed", item: { type: "agent_message", text: message } },
    { type: "item.completed", item: { type: "mcp_tool_call", error: { message } } }, { type: "error", error: { message } }, { type: "error", message: "quoted: " + message },
    { type: "turn.failed", error: { message: "authentication required" }, content: message }]) expect(codexReviewerQuota(frame)).toBeUndefined();
  for (const frame of [{ type: "assistant", message: { content: [{ type: "text", text: JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }) }] } },
    { type: "result", errors: ["rate_limit"], result: "rate limit exceeded" }, { type: "tool_result", error: "rate_limit" }]) expect(claudeReviewerQuota(frame)).toBeUndefined();
});

const kimiLine = "error: failed to run prompt: provider.auth_error: 403 You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends.\n";
test("Kimi2.2 observed diagnostic exception requires owned complete stderr plus nonzero exit, with reset always unknown", () => {
  const result = kimiReviewerQuotaOnExit({ exitCode: 1, stderr: { status: "complete", text: kimiLine } });
  expect(result).toEqual({ id: "5h", used: 1, windowMins: 300, source: "Kimi reviewer quota" });
  expect(result).not.toHaveProperty("resetsAt");
  for (const observation of [{ exitCode: 0, stderr: { status: "complete" as const, text: kimiLine } }, { exitCode: null, stderr: { status: "complete" as const, text: kimiLine } },
    { exitCode: 1, stderr: { status: "unknown" as const } }, { exitCode: 1, stderr: { status: "complete" as const, text: kimiLine.trimEnd() } },
    { exitCode: 1, stderr: { status: "complete" as const, text: " " + kimiLine } }, { exitCode: 1, stderr: { status: "complete" as const, text: "error: usage limit\n" } }])
    expect(kimiReviewerQuotaOnExit(observation)).toBeUndefined();
  expect(kimiReviewerBackend.failure?.({ type: "error", message: kimiLine })).toBeUndefined();
});

test("own-stderr capture is opt-in, bounded, unavailable before settlement or after generation loss, and never a JSON frame", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-review-stderr-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  for (const mode of ["normal", "overflow", "default"] as const) {
    let current = true, frames = 0;
    const text = mode === "overflow" ? "x".repeat(64 * 1024 + 1) + "\n" + kimiLine : kimiLine;
    const child = new OwnedPrintChild({ peer: "stderr-fixture", command: [process.execPath, "-e", `await new Response(Bun.stdin.stream()).text();process.stderr.end(${JSON.stringify(text)},()=>process.exit(1));`], args: [], cwd: root,
      envMode: "replace", env: { HOME: root, PATH: "/usr/bin:/bin" }, input: "fixture", current: () => current, onFrame: () => { frames++; }, ...(mode === "default" ? {} : { captureStderr: true as const }) });
    cleanup.push(() => child.stop());
    expect(child.stderrAfterSettlement()).toEqual({ status: "unknown" });
    expect(await child.done).toBe(1); expect(frames).toBe(0);
    if (mode === "normal") {
      expect(child.stderrAfterSettlement()).toEqual({ status: "complete", text: kimiLine });
      current = false; expect(child.stderrAfterSettlement()).toEqual({ status: "unknown" });
    } else expect(child.stderrAfterSettlement()).toEqual({ status: "unknown" });
  }
  expect(nativeReviewerQuota({ id: "5h", used: 1, windowMins: 300, source: "Kimi reviewer quota", accountId: "PRIVATE_ACCOUNT_CANARY" })).not.toHaveProperty("accountId");
});


test("owned Kimi profile usage is discovered by native index and read before deletion, never by observer UUID", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-review-usage-")), directory = join(root, "sessions", "wd_fake", "session_fixture"), wire = join(directory, "agents", "main", "wire.jsonl");
  cleanup.push(() => rmSync(root, { recursive: true, force: true })); mkdirSync(join(directory, "agents", "main"), { recursive: true });
  const now = Date.now();
  writeFileSync(join(root, "session_index.jsonl"), JSON.stringify({ sessionId: "session_fixture", sessionDir: directory }) + "\n");
  writeFileSync(wire, JSON.stringify({ type: "metadata", protocol_version: "1.5", created_at: 1 }) + "\n" + JSON.stringify({ type: "usage.record", agentId: "main", model: "kimi-code/k3", usage: { inputOther: 7, output: 3, inputCacheRead: 100, inputCacheCreation: 2 }, usageScope: "turn", time: now }) + "\n");
  const rows = readKimiReviewerUsage(root, now - 100); expect(rows).toHaveLength(1); expect(rows![0]).toMatchObject({ inputOther: 7, output: 3, inputCacheRead: 100, inputCacheCreation: 2 });
  expect(rows![0]!.id).toMatch(/^[a-f0-9]{32}$/);
  appendFileSync(wire, '{"type":"usage.record"'); expect(readKimiReviewerUsage(root, now - 100)).toBeUndefined();
});

test("owned accounting start invalidates cached count, unmatched/unknown never expires from a host cap, and usage attributes once", () => {
  let now = Date.now(), reports = 0, forgotten = 0, records = 0;
  const usage = new KimiUsage({ home: "/unused-synthetic", now: () => now, ceiling: () => 100, session: () => undefined,
    record: (_peer, _row, counted, attributed) => { records++; expect(counted).toBe(12); expect(attributed.attribution).toEqual({ task: 7, attribution: "delivery" }); },
    report: () => { reports++; }, forget: () => { forgotten++; }, notice: () => {} });
  cleanup.push(() => usage.stop());
  const attempt = "a".repeat(32), row = { id: "b".repeat(32), at: now, inputOther: 7, inputCacheCreation: 2, inputCacheRead: 100, output: 3 };
  usage.reviewerAccounting("kimi-review", attempt, "started"); expect(forgotten).toBe(1);
  expect(usage.observeReviewer("kimi-review", row, { attribution: { task: 7, attribution: "delivery" } })).toBe(true);
  expect(usage.observeReviewer("kimi-review", row, { attribution: { task: 7, attribution: "delivery" } })).toBe(false);
  expect(records).toBe(1); expect(reports).toBe(0);
  usage.reviewerAccounting("kimi-review", attempt, "unknown"); now += 10 * 3_600_000; usage.reset();
  expect(usage.status().state).toBe("unreadable");
  usage.reviewerAccounting("kimi-review", attempt, "complete"); expect(usage.status().state).toBe("counting"); expect(reports).toBe(1);
});

test("owned usage child requires intent ACK before spawn, terminal ACK precedes profile deletion", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-review-accounting-")), marker = join(root, "spawned");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const order: string[] = []; let allow = false, deleted = 0;
  const backend: ReviewerBackend = { id: "fixture", prepare: async () => ({
    command: [process.execPath, "-e", `await new Response(Bun.stdin.stream()).text();await Bun.write(${JSON.stringify(marker)},"owned fake");`], args: [], cwd: root,
    envMode: "replace", env: { HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin" },
    isolation: { backend: "fixture", version: "fixture", binary: process.execPath, profile: "fake", readOnly: true, strictMcp: true, ephemeral: true, evidence: ["fake child"] },
    readUsage: () => { order.push("read-after-settlement"); return true; }, cleanup: () => { order.push("delete"); deleted++; },
  }) };
  const peer = new ReviewerPrintPeer("quota-fixture", { cwd: root, backend, mcpConfig: "{}", systemPrompt: "fixture", watchdogMs: 10_000, verdictSince: () => false,
    usageIntent: attempt => { expect(attempt).toMatch(/^[a-f0-9]{32}$/); order.push("intent"); return allow; },
    usageSettled: (_attempt, outcome) => { expect(existsSync(marker)).toBe(true); expect(outcome).toBe("complete"); order.push("terminal"); return true; },
    onUnavailable: () => true }); cleanup.push(() => peer.stop("fixture teardown"));
  await peer.start(); order.length = 0; deleted = 0;
  await peer.deliver([request(1)], "no-intent"); await until(() => peer.state === "idle");
  expect(existsSync(marker)).toBe(false); expect(order).toEqual(["intent", "delete"]);
  allow = true; order.length = 0;
  await peer.deliver([request(2)], "acked-intent"); await until(() => peer.state === "idle" && existsSync(marker));
  expect(order).toEqual(["intent", "read-after-settlement", "terminal", "delete"]); expect(deleted).toBe(2);
});

for (const cleanupFailure of [false, true]) test(`proven quota is retained before ${cleanupFailure ? "owned cleanup failure" : "explicit stop"}, independently of task reroute`, async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-immediate-quota-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const { Budget, DEFAULT_BUDGET } = await import("../src/hub/budget.ts");
  const { stopOwnedProcess } = await import("../src/hub/child-process.ts");
  let paused = 0, observations = 0, reroutes = 0, settled = 0, failStop = cleanupFailure, cleanupRefused = false;
  const budget = new Budget(join(root, "hub.db"), DEFAULT_BUDGET, { account: id => id === "codex-review" ? "codex" : id,
    pause: () => { paused++; }, resume: () => {}, requestCheckpoint: async () => undefined, platformContext: async () => undefined,
    attached: () => true, canHandOff: () => false, handoff: async () => [], resumed: () => {}, notify: () => {} }); cleanup.push(() => budget.close());
  const frame = JSON.stringify({ type: "error", message: CODEX_EXEC_QUOTA_PREFIX });
  const backend: ReviewerBackend = { id: "fixture", failure: codexReviewerQuota, prepare: async () => ({
    command: [process.execPath, "-e", `await new Response(Bun.stdin.stream()).text();console.log(${JSON.stringify(frame)});console.log(${JSON.stringify(frame)});${cleanupFailure ? "process.exitCode=1;" : "setInterval(()=>{},1000);"}`], args: [], cwd: root,
    envMode: "replace", env: { HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin" },
    isolation: { backend: "fixture", version: "fixture", binary: process.execPath, profile: "fake", readOnly: true, strictMcp: true, ephemeral: true, evidence: ["fake child"] },
    stop: async child => { await stopOwnedProcess(child, { group: true }); if (failStop) { failStop = false; cleanupRefused = true; throw new Error("synthetic cleanup refusal"); } },
  }) };
  const peer = new ReviewerPrintPeer("quota-fixture", { cwd: root, backend, mcpConfig: "{}", systemPrompt: "fixture", watchdogMs: 10_000, verdictSince: () => false,
    onQuota: (reading, attempt, current) => { expect(current()).toBe(true); expect(attempt).toMatch(/^[a-f0-9]{32}$/); observations++; budget.report("codex-review", [reading], true); return true; },
    quotaSettled: () => { settled++; }, onUnavailable: () => { reroutes++; return true; } }); cleanup.push(() => peer.stop("fixture teardown"));
  await peer.start(); await peer.deliver([request(1)], "immediate-quota"); await until(() => observations === 1 && budget.record("codex") !== undefined);
  expect(paused).toBe(1); expect(reroutes).toBe(0); expect(budget.record("codex")?.reason).toContain("Codex reviewer quota");
  if (cleanupFailure) { await until(() => cleanupRefused); expect(peer.state).toBe("busy"); expect(settled).toBe(0); }
  await peer.stop("person stopped observed quota"); expect(budget.record("codex")).toBeDefined(); expect(observations).toBe(1); expect(reroutes).toBe(0); expect(settled).toBe(1);
});
