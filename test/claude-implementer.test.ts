import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ClaudeImplementerPeer, type ClaudeImplementerOptions } from "../src/adapters/claude-implementer.ts";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { realPath } from "../src/hub/project.ts";
import { stopOwnedProcess } from "../src/hub/child-process.ts";
import { completeJsonLines } from "./fakes/jsonl.ts";
import type { DeliveryReceipt } from "../src/hub/peers.ts";
const fake = resolve(import.meta.dir, "fakes/fake-claude-implementer.ts"), cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(check: () => boolean): Promise<void> { for (let i = 0; i < 300 && !check(); i++) await Bun.sleep(3); expect(check()).toBe(true); }
function rig(mode = "success", extra: Partial<ClaudeImplementerOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-claude-impl-")), log = join(dir, "calls.jsonl"), receipts: DeliveryReceipt[] = [], usage: unknown[] = [];
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const command = [process.execPath, fake, log, mode];
  const peer = new ClaudeImplementerPeer("claude-worker", { cwd: dir, stateDir: dir, projectRoot: dir, instanceId: "fixture-instance", server: join(dir, "server.js"), factsHook: join(dir, "hook.ts"), systemPrompt: "fixture role", watchdogMs: 5000,
    command, admit: () => true, chatTask: () => undefined, prove: async () => () => true, onUsage: (row, task) => usage.push({ row, task }), ...extra });
  peer.onDelivery = receipt => { receipts.push(receipt); };
  cleanup.push(() => peer.stop());
  return { dir, log, command, peer, receipts, usage, calls: () => (existsSync(log) ? completeJsonLines(readFileSync(log, "utf8")) : []) as any[] };
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

test("native session publication errors revoke authority before result usage and retain an unstarted UUID", async () => {
  const r = rig(); await r.peer.start();
  const sessions = (r.peer as unknown as { sessions: { markStarted(task: number, id: string): boolean; session(task: number): { resume: boolean } } }).sessions;
  sessions.markStarted = () => { throw new Error("fixture durable write failed"); };
  await r.peer.deliver([message(1)], "session-write"); await until(() => r.peer.state === "idle");
  expect(r.calls()).toHaveLength(1); expect(r.calls()[0].prompt).toContain("fixture only");
  expect(sessions.session(1).resume).toBe(false); expect(r.usage).toEqual([]);
  expect(r.peer.sessionGeneration).toBeUndefined(); expect(r.receipts.at(-1)?.state).toBe("needs_review");
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
  expect(r.calls().every(call => call.prompt === "")).toBe(true); expect(r.peer.sessionGeneration).toBeUndefined(); expect(r.receipts.at(-1)?.state).toBe("failed_safe");
});


test("production proof pins the actual turn executable when an earlier PATH entry appears", async () => {
  const r = rig("success", { command: ["claude"], prove: undefined }), oldPath = process.env.PATH, oldHome = process.env.HOME, oldConfig = process.env.CLAUDE_CONFIG_DIR;
  const authKey = (key: string) => /^(ANTHROPIC_|CLAUDE_CODE_|AWS_|GOOGLE_|GCLOUD_|AZURE_|CLOUDSDK_)/.test(key);
  const auth = new Map(Object.keys(process.env).filter(authKey).map(key => [key, process.env[key]] as const));
  for (const key of auth.keys()) delete process.env[key];
  const early = join(r.dir, "earlier-bin"), late = join(r.dir, "verified-bin"), marker = join(r.dir, "binary-used"), proofMarker = join(r.dir, "fake-version-proof");
  mkdirSync(early); mkdirSync(late); mkdirSync(join(r.dir, "isolated-home"));
  writeFileSync(join(late, "claude"), `#!/bin/sh\nif [ "$1" = '--version' ]; then printf verified > '${proofMarker}'; printf '2.1.309 (Claude Code)\\n'; exit 0; fi\n/bin/cat >/dev/null\nprintf verified >> '${marker}'\nprintf '{"type":"result","subtype":"success","usage":{"input_tokens":1,"output_tokens":1}}\\n'\n`, { mode: 0o700 });
  process.env.PATH = `${early}:${late}:${oldPath ?? ""}`; process.env.HOME = join(r.dir, "isolated-home"); process.env.CLAUDE_CONFIG_DIR = join(r.dir, "isolated-home", ".claude");
  try {
    expect(Object.keys(process.env).some(authKey)).toBe(false);
    await r.peer.start();
    expect(readFileSync(proofMarker, "utf8")).toBe("verified");
    expect((r.peer as unknown as { command: string[] }).command[0]).toBe(realPath(join(late, "claude")));
    // PATH itself does not change: installing another executable earlier must not bypass proof.
    writeFileSync(join(early, "claude"), `#!/bin/sh\nprintf unproved >> '${marker}'\nexit 1\n`, { mode: 0o700 });
    await r.peer.deliver([message(41)], "pinned-binary"); await until(() => r.peer.state === "idle");
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("verified");
    expect(r.receipts.at(-1)?.state).toBe("completed");
  } finally { await r.peer.stop(); if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldConfig; for (const [key, value] of auth) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

for (const watchdog of [false, true]) test(`a queued durable delivery starts at the cleanup-complete idle boundary (${watchdog ? "watchdog" : "natural"})`, async () => {
  let release!: () => void, cleaning = false, first = true;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const r = rig(watchdog ? "hang" : "success", { watchdogMs: watchdog ? 500 : 5000,
    stopChild: async child => { if (!watchdog && first) { first = false; cleaning = true; await gate; } await stopOwnedProcess(child, { group: true }); } });
  const journal = new DeliveryJournal({ file: join(r.dir, "bus.db"), projectRoot: r.dir, projectId: "implementer", instanceId: "fixture" });
  const bus = new Bus({ journal, batchMax: 1, batchMs: 0, retryMs: 1 });
  cleanup.push(async () => { release(); await r.peer.stop(); bus.closeJournal(); });
  bus.add(r.peer);
  if (watchdog) {
    const state = r.peer.onState!;
    r.peer.onState = next => {
      if (next === "idle") {
        const held = journal.list(r.peer.id).find(row => row.state === "needs_review");
        if (held) bus.resolveDelivery(held.id, held.revision, "discard", "fixture person acknowledged completed cleanup", "user");
      }
      state(next);
    };
  }
  await r.peer.start(); bus.publish(message(51));
  await until(() => watchdog ? r.calls().length === 1 : cleaning);
  if (watchdog) r.command[3] = "success"; // Same test executable, next turn succeeds.
  bus.publish(message(52));
  if (!watchdog) release();
  await until(() => journal.list(r.peer.id).some(row => row.originals.some(env => env.refs?.task === "52") && ["completed", "needs_review"].includes(row.state)));
  const deliveries = journal.list(r.peer.id);
  expect(deliveries.map(row => row.state)).toEqual(watchdog ? ["discarded", "completed"] : ["completed", "completed"]);
  expect(r.calls()).toHaveLength(2);
});

test("a person stop upgrades an ongoing watchdog cleanup to offline", async () => {
  let release!: () => void, cleaning = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const r = rig("hang", { watchdogMs: 100, stopChild: async child => { cleaning = true; await gate; await stopOwnedProcess(child, { group: true }); } });
  cleanup.push(() => { release(); });
  await r.peer.start(); await r.peer.deliver([message(61)], "watchdog-person-stop");
  await until(() => cleaning);
  expect(r.peer.state).toBe("busy"); expect(r.peer.sessionGeneration).toBeUndefined();
  const stopped = r.peer.stop();
  release(); await stopped;
  expect(r.peer.state).toBe("offline");
  expect(r.receipts.at(-1)?.state).toBe("needs_review");
});


test("a child that fails before naming its session retries with session-id, never resume", async () => {
  const r = rig("before-session"); await r.peer.start();
  await r.peer.deliver([message(61)], "before-session"); await until(() => r.peer.state === "idle");
  expect(r.receipts.at(-1)?.state).toBe("needs_review");
  r.command[3] = "success";
  await r.peer.deliver([message(61)], "retry"); await until(() => r.peer.state === "idle");
  const calls = r.calls(); expect(calls).toHaveLength(2);
  expect(calls[1].args).not.toContain("--resume");
  expect(arg(calls[1].args, "--session-id")).toBe(arg(calls[0].args, "--session-id"));
  await r.peer.deliver([message(61)], "verified-retry"); await until(() => r.peer.state === "idle");
  expect(arg(r.calls()[2].args, "--resume")).toBe(arg(calls[0].args, "--session-id"));
});

test("a durable digest drops an approved notice and foreign refs while delivering its admissible message", async () => {
  const r = rig("success", { admit: env => env.refs?.task === "62" });
  const journal = new DeliveryJournal({ file: join(r.dir, "mixed-bus.db"), projectRoot: r.dir, projectId: "implementer", instanceId: "fixture" });
  const bus = new Bus({ journal, batchMax: 3, batchMs: 60000, retryMs: 1 });
  cleanup.push(async () => { await r.peer.stop(); bus.closeJournal(); });
  bus.add(r.peer); await r.peer.start();
  bus.publish({ ...message(60), body: "approved notice must not reach native" });
  bus.publish({ ...message(63), body: "foreign task must not reach native" });
  bus.publish(message(62));
  await until(() => journal.list(r.peer.id).some(row => row.state === "completed" || row.state === "needs_review"));
  expect(journal.list(r.peer.id).map(row => row.state)).toEqual(["completed"]);
  expect(r.calls()).toHaveLength(1); expect(r.calls()[0].prompt).toContain("fixture only");
  expect(r.calls()[0].prompt).not.toContain("approved notice"); expect(r.calls()[0].prompt).not.toContain("foreign task");
});

test("an entirely inadmissible batch settles failed_safe without a native child", async () => {
  const r = rig("success", { admit: () => false }); await r.peer.start();
  await r.peer.deliver([message(60)], "notice-only"); await until(() => r.peer.state === "idle");
  expect(r.receipts.map(row => row.state)).toEqual(["accepted", "failed_safe"]); expect(r.calls()).toHaveLength(0);
});

test("completeJsonLines reads only whole lines: an empty file and a half-written last line parse", () => {
  expect(completeJsonLines("")).toEqual([]);
  expect(completeJsonLines('{"a":1}\n{"b"')).toEqual([{ a: 1 }]);
  expect(completeJsonLines('{"a":1}\n')).toEqual([{ a: 1 }]);
});
