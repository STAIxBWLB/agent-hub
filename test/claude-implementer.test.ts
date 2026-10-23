import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ClaudeImplementerPeer, type ClaudeImplementerOptions } from "../src/adapters/claude-implementer.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { realPath } from "../src/hub/project.ts";
import { stopOwnedProcess } from "../src/hub/child-process.ts";
import type { DeliveryReceipt } from "../src/hub/peers.ts";
const fake = resolve(import.meta.dir, "fakes/fake-claude-implementer.ts"), cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(check: () => boolean): Promise<void> { for (let i = 0; i < 300 && !check(); i++) await Bun.sleep(3); expect(check()).toBe(true); }
function rig(mode = "success", extra: Partial<ClaudeImplementerOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-claude-impl-")), log = join(dir, "calls.jsonl"), receipts: DeliveryReceipt[] = [], usage: unknown[] = [];
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const peer = new ClaudeImplementerPeer("claude-worker", { cwd: dir, stateDir: dir, projectRoot: dir, instanceId: "fixture-instance", server: join(dir, "server.js"), factsHook: join(dir, "hook.ts"), systemPrompt: "fixture role", watchdogMs: 5000,
    command: [process.execPath, fake, log, mode], admit: () => true, chatTask: () => undefined, prove: async () => () => true, onUsage: (row, task) => usage.push({ row, task }), ...extra });
  peer.onDelivery = receipt => { receipts.push(receipt); };
  cleanup.push(() => peer.stop());
  return { dir, log, peer, receipts, usage, calls: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [] };
}
const message = (task?: number) => newEnvelope("hub", "fixture only", { kind: "task", to: ["claude-worker"], ...(task ? { refs: { task: String(task) } } : {}) });
const arg = (args: string[], name: string) => args[args.indexOf(name) + 1];

test("headless Claude first task starts its own UUID, resumes only that task, and keeps unscoped chat ephemeral", async () => {
  const r = rig(); await r.peer.start();
  for (const task of [1, 1, 2, undefined]) { await r.peer.deliver([message(task)], String(task)); await until(() => r.peer.state === "idle"); }
  const calls = r.calls(); expect(calls).toHaveLength(4);
  const first = arg(calls[0].args, "--session-id");
  expect(arg(calls[1].args, "--resume")).toBe(first);
  expect(arg(calls[2].args, "--session-id")).not.toBe(first);
  expect(calls[3].args).toContain("--no-session-persistence");
  for (const call of calls) {
    expect(call.args).not.toContain("--continue"); expect(call.args).not.toContain("--fork-session");
    expect(arg(call.args, "--permission-mode")).toBe("default");
    expect(arg(call.args, "--permission-prompt-tool")).toBe("mcp__agent-hub__hub_permission_request");
    expect(call.peer).toBe("claude-worker"); expect(call.cwd).toBe(realPath(r.dir));
  }
  expect(r.receipts.filter(row => row.state === "completed")).toHaveLength(4);
});

test("only positive exact transcript absence creates a fresh UUID; unknown and read errors retain it", async () => {
  let evidence: boolean | "unknown" | "throw" = "unknown";
  const r = rig("success", { transcriptPersisted: () => { if (evidence === "throw") throw new Error("unreadable"); return evidence; } });
  await r.peer.start();
  for (const next of ["unknown", "throw", false] as const) { evidence = next; await r.peer.deliver([message(1)]); await until(() => r.peer.state === "idle"); }
  const calls = r.calls(), first = arg(calls[0].args, "--session-id");
  expect(arg(calls[1].args, "--resume")).toBe(first);
  expect(arg(calls[2].args, "--session-id")).not.toBe(first);
});

test("unique host-owned chat task resumes its session; private delivery refuses before spawn", async () => {
  const r = rig("success", { chatTask: () => 5 }); await r.peer.start();
  await expect(r.peer.deliver([{ ...message(5), private: true }])).rejects.toThrow("private"); expect(r.calls()).toHaveLength(0);
  await r.peer.deliver([message()]); await until(() => r.peer.state === "idle");
  await r.peer.deliver([message()]); await until(() => r.peer.state === "idle");
  const calls = r.calls(); expect(arg(calls[1].args, "--resume")).toBe(arg(calls[0].args, "--session-id"));
  expect(calls[0].args).not.toContain("--no-session-persistence");
});

test("result usage is emitted once; an error result fails the delivery", async () => {
  for (const mode of ["duplicate", "error"]) {
    const r = rig(mode); await r.peer.start(); await r.peer.deliver([message(9)], mode); await until(() => r.peer.state === "idle");
    expect(r.usage).toEqual([{ row: { input_tokens: 7, output_tokens: 3 }, task: 9 }]);
    expect(r.receipts.at(-1)?.state).toBe(mode === "error" ? "needs_review" : "completed");
  }
});

test("a spawn error without a PID is failed_safe and idle, with no stale authority", async () => {
  const r = rig("success", { command: ["/does-not-exist/claude"] }); await r.peer.start();
  await r.peer.deliver([message(1)], "absent"); await until(() => r.receipts.at(-1)?.state === "failed_safe");
  expect(r.peer.state).toBe("idle"); expect(r.peer.sessionGeneration).toBeUndefined();
});

test("session publication errors fence stdin, revoke current-child authority and clean up safely", async () => {
  const r = rig(); await r.peer.start();
  (r.peer as unknown as { sessions: { markStarted(): boolean } }).sessions.markStarted = () => { throw new Error("fixture durable write failed"); };
  await r.peer.deliver([message(1)], "session-write"); await until(() => r.peer.state === "idle");
  expect(r.calls().every(call => call.prompt === "")).toBe(true); expect(r.peer.sessionGeneration).toBeUndefined(); expect(r.receipts.at(-1)?.state).toBe("needs_review");
});

test("stop revokes the child token synchronously and confirms owned descendants gone before offline", async () => {
  const r = rig("hang"); await r.peer.start(); await r.peer.deliver([message(1)], "stopped"); await until(() => existsSync(r.log + ".descendant"));
  const call = r.calls()[0], launch = r.peer.ownedTools(call.launchId)!;
  expect(launch).toBeDefined(); expect(launch.task).toBe(1);
  const stopping = r.peer.stop(); expect(r.peer.ownedTools(call.launchId)).toBeUndefined(); expect(launch.signal.aborted).toBe(true);
  await stopping; expect(r.peer.state).toBe("offline"); expect(r.receipts.at(-1)?.state).toBe("needs_review");
  const descendant = Number(readFileSync(r.log + ".descendant", "utf8"));
  expect(() => process.kill(descendant, 0)).toThrow();
});

test("watchdog ends the turn with cleanup, keeps the task session and returns idle", async () => {
  const r = rig("hang", { watchdogMs: 120 }); await r.peer.start(); await r.peer.deliver([message(1)], "watchdog");
  await until(() => r.peer.state === "idle"); expect(r.receipts.at(-1)?.state).toBe("needs_review"); expect(r.peer.sessionGeneration).toBeUndefined();
});

test("cleanup failure retains busy handle and refuses restart until a verified retry succeeds", async () => {
  let first = true;
  const r = rig("success", { stopChild: async child => { if (first) { first = false; throw new Error("fixture cleanup incomplete"); } await stopOwnedProcess(child, { group: true }); } });
  await r.peer.start(); await r.peer.deliver([message(1)], "cleanup"); await until(() => r.receipts.at(-1)?.state === "needs_review");
  expect(r.peer.state).toBe("busy"); expect(r.peer.sessionGeneration).toBeUndefined(); await expect(r.peer.start()).rejects.toThrow("cleanup");
  await r.peer.stop(); expect(r.peer.state).toBe("offline");
});

test("host permission mode supports ask variants and refuses never-ask", async () => {
  const r = rig(); expect(r.peer.permissionModeState).toBe("ask"); await r.peer.setPermissionMode("ask-when-needed"); expect(r.peer.permissionModeState).toBe("ask-when-needed");
  await expect(r.peer.setPermissionMode("never-ask")).rejects.toThrow("never-ask"); expect(r.peer.permissionModeState).toBe("ask-when-needed");
});

test("expired startup proof refuses before spawn and never publishes idle", async () => {
  const r = rig("success", { prove: async () => { throw new Error("permission capability unproven"); } });
  await expect(r.peer.start()).rejects.toThrow("unproven"); expect(r.peer.state).toBe("offline"); expect(r.calls()).toHaveLength(0);
});

test("leader exit revokes current-child tools before group cleanup finishes", async () => {
  let release!: () => void, cleaning = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const r = rig("success", { stopChild: async child => { cleaning = true; await gate; await stopOwnedProcess(child, { group: true }); } });
  cleanup.push(() => { release(); });
  await r.peer.start(); await r.peer.deliver([message(1)], "leader-exit");
  await until(() => cleaning);
  expect(r.peer.state).toBe("busy"); expect(r.peer.ownedTools(r.calls()[0].launchId)).toBeUndefined(); expect(r.peer.sessionGeneration).toBeUndefined();
  release(); await until(() => r.peer.state === "idle");
});

test("admission changed before spawn never receives framed prompt or child authority", async () => {
  let checks = 0;
  const r = rig("success", { admit: () => ++checks < 3 });
  await r.peer.start(); await r.peer.deliver([message(1)], "admission-drift"); await until(() => r.peer.state === "idle");
  expect(r.calls().every(call => call.prompt === "")).toBe(true); expect(r.peer.sessionGeneration).toBeUndefined(); expect(r.receipts.at(-1)?.state).toBe("needs_review");
});
