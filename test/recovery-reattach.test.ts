import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as recovery from "../src/cli/upgrade.ts";
import { PACKAGE_ROOT } from "../src/cli/upgrade-runtime.ts";
import { acquireRecoveryLock, claimRunner, readOperation, recoveryLock, recoveryRunner, releaseRecoveryLock, writeOperation } from "../src/hub/recovery-store.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { VERSION } from "../src/version.ts";
import type { TerminalBinding } from "../src/cli/terminal-recovery.ts";
import type { RecoveryDriver, RecoveryOperation, UpgradePlan } from "../src/cli/upgrade.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
type Reattach = (id: string, peer: string, driver: RecoveryDriver, home?: string) => Promise<RecoveryOperation>;
const reattach = (...args: Parameters<Reattach>) => {
  const action = (recovery as unknown as { reattachRecovery?: Reattach }).reattachRecovery;
  expect(typeof action, "person reattach must use its own claimed operation path").toBe("function");
  return action!(...args);
};
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ahub-463-reattach-")); homes.push(home);
  const launch = { packageEntrypoint: "/recorded/main.js", command: "fixture, never executed", argv: [], env: {} };
  const binding = (id: string, peer: "pi" | "codex"): TerminalBinding => ({ peer, handle: `term-${id}-${peer}`, incarnationId: `inc-${id}-${peer}`, worktreeId: `wt-${id}`,
    projectRoot: join(home, id), sessionId: `recorded-${id}-${peer}`, ...(peer === "pi" ? { sessionFile: join(home, id, "pi.jsonl"), backend: "dgx", model: "dgx/coding" } : {}), launch, launchMetadata: launch });
  const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind: "upgrade", version: VERSION, sourceRoot: PACKAGE_ROOT, sourceDigest: "fixture-source",
    projects: ["alpha", "beta"].map(id => ({ project: { id, root: join(home, id), stateDir: join(home, id, "state"), basePort: 4600, instanceId: `source-${id}`, pid: null },
      source: { state: "running", instanceId: `source-${id}`, version: VERSION, protocol: PROTOCOL, peers: [
        { id: "pi", state: "idle", sessionId: `recorded-${id}-pi`, sessionFile: join(home, id, "pi.jsonl"), args: { mode: "tui", backend: "dgx", model: "dgx/coding" } },
        { id: "codex", state: "idle", threadId: `recorded-${id}-codex` },
      ], blockers: [] }, terminals: [binding(id, "pi"), binding(id, "codex")], blockers: [] })), blockers: [] };
  const plan = { ...body, fingerprint: recovery.planFingerprint(body) };
  const op = recovery.createOperation(plan, PACKAGE_ROOT, home);
  Object.assign(op, { phase: "blocked", step: "restore-claude:alpha", targetRoot: PACKAGE_ROOT, targetDigest: "fixture-target", targetFeatures: ["task_cancel"], pluginInstalled: true,
    error: "pi: detached after restore", blockedReattachment: { projectId: "alpha", peer: "pi" } });
  for (const progress of op.projects) Object.assign(progress, { phase: "peers-restored", instanceId: `target-${progress.id}`, terminals: {
    "restored:pi": { state: "done", binding: binding(progress.id, "pi") }, "restored:codex": { state: "done", binding: binding(progress.id, "codex") },
  } });
  const alpha = op.projects[0]!;
  Object.assign(alpha, { phase: "started", reattachments: { pi: { state: "ready", at: 1, cause: "detached after restore", binding: binding("alpha", "pi") } } });
  alpha.terminals["restored:pi"] = { state: "failed" };
  writeOperation(op.id, op, home);
  const effects: string[] = [];
  let clock = 10;
  const driver: RecoveryDriver = {
    stage: async () => { effects.push("stage"); return { root: PACKAGE_ROOT, digest: "fixture-target" }; },
    inspect: async project => ({ state: "running", instanceId: `target-${project.id}`, version: VERSION, protocol: PROTOCOL,
      recovery: { operationId: op.id, phase: "restored", ready: false }, peers: [], blockers: [] }),
    prepare: async () => { effects.push("prepare"); }, abort: async () => { effects.push("abort"); }, commit: async () => { effects.push("commit"); },
    closeTerminals: async () => { effects.push("close"); }, start: async () => { effects.push("start"); },
    restore: async (planned, progress, operation, group, save, onlyPeer) => {
      effects.push(`restore:${planned.project.id}:${group}:${onlyPeer}`);
      expect(recoveryLock(home)).toBe(op.id); expect(recoveryRunner(op.id, home)).toBe(process.pid);
      expect(operation.id).toBe(op.id); expect(onlyPeer).toBe("pi");
      const marker = (progress as any).reattachments.pi;
      expect(marker).toMatchObject({ state: "ready", cause: "detached after restore", binding: binding("alpha", "pi") });
      marker.state = "attempted"; save();
      progress.terminals["restored:pi"] = { state: "done", binding: { ...marker.binding, handle: "term-alpha-pi-repaired", incarnationId: "inc-alpha-pi-repaired" } };
      save();
    },
    installPlugin: async () => { effects.push("plugin"); }, installGlobal: async () => { effects.push("global"); },
    verify: async () => { effects.push("verify"); }, release: async () => { effects.push("release"); },
    stopAndArchive: async () => { effects.push("archive"); }, refreshManager: async () => { effects.push("manager"); },
    now: () => clock, sleep: async ms => { clock += ms; },
  };
  return { home, op, alpha, binding, driver, effects };
}

test("#463 person reattach holds claims and restores only the selected peer, leaving global completion to resume", async () => {
  const f = fixture(), beforeBeta = structuredClone(f.op.projects[1]), beforeCodex = structuredClone(f.alpha.terminals["restored:codex"]);
  const result = await reattach(f.op.id, "pi", f.driver, f.home);
  expect(f.effects).toEqual(["restore:alpha:native:pi"]);
  expect(result.phase).toBe("blocked");
  expect(result.error).toMatch(/resume/i);
  expect(result.pluginInstalled).toBe(true); expect(result.globalInstalled).toBeUndefined();
  expect(result.projects[1]).toEqual(beforeBeta);
  expect(result.projects[0]!.terminals["restored:codex"]).toEqual(beforeCodex);
  expect(result.projects[0]!.terminals["restored:pi"]).toMatchObject({ state: "done", binding: {
    handle: "term-alpha-pi-repaired", sessionId: "recorded-alpha-pi", sessionFile: f.binding("alpha", "pi").sessionFile, backend: "dgx", model: "dgx/coding",
  } });
  expect(readOperation<RecoveryOperation>(f.op.id, f.home).projects).toEqual(result.projects);
  expect(recoveryLock(f.home)).toBe(f.op.id);
  expect(recoveryRunner(f.op.id, f.home)).toBeUndefined();
});

for (const condition of ["completed", "cancelled", "running", "no-blocked-peer", "different-peer", "missing-ready-marker"] as const) test(`#463 person reattach refuses ${condition} before any recovery effect`, async () => {
  const f = fixture();
  if (["completed", "cancelled", "running"].includes(condition)) f.op.phase = condition as "completed" | "cancelled" | "running";
  if (condition === "no-blocked-peer") delete (f.op as any).blockedReattachment;
  if (condition === "missing-ready-marker") delete (f.alpha as any).reattachments;
  writeOperation(f.op.id, f.op, f.home);
  const before = readOperation<RecoveryOperation>(f.op.id, f.home);
  await expect(reattach(f.op.id, condition === "different-peer" ? "codex" : "pi", f.driver, f.home)).rejects.toThrow();
  expect(f.effects).toEqual([]);
  expect(readOperation<RecoveryOperation>(f.op.id, f.home)).toEqual(before);
  expect(recoveryRunner(f.op.id, f.home)).toBeUndefined();
});

test("#463 reattach never races a claimed runner or another operation's machine lock", async () => {
  const f = fixture(), release = claimRunner(f.op.id, f.home);
  try { await expect(reattach(f.op.id, "pi", f.driver, f.home)).rejects.toThrow(); expect(f.effects).toEqual([]); }
  finally { release(); }
  releaseRecoveryLock(f.op.id, f.home);
  const other = crypto.randomUUID(); acquireRecoveryLock(other, f.home);
  await expect(reattach(f.op.id, "pi", f.driver, f.home)).rejects.toThrow();
  expect(f.effects).toEqual([]); expect(recoveryLock(f.home)).toBe(other);
});

test("#463 reattach is classified as a person command, never an agent read or native launch", () => {
  expect(classifyPeerCommand("recovery", ["reattach", crypto.randomUUID(), "pi"])).toBe("console");
});

test("#463 status advertises reattach only for the eligible blocked project and peer", () => {
  const f = fixture();
  const commands = () => recovery.publicOperation(f.op).projects.flatMap(project => project.recordedSessions ?? []).filter(row => row.reattachCommand);
  expect(commands().map(row => row.peer)).toEqual(["pi"]);
  for (const phase of ["completed", "cancelled", "running"] as const) { f.op.phase = phase; expect(commands()).toEqual([]); }
  f.op.phase = "blocked"; delete f.op.blockedReattachment;
  expect(commands()).toEqual([]);
});
