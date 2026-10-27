import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/hub/bus.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { readRestartSnapshot, writeRestartSnapshot, type RestartSnapshot } from "../src/hub/restart.ts";
import type { ExternalInstanceBinding } from "../src/hub/external-instance.ts";
import { instanceRecoverySourceRefusal, instanceRecoveryTargetRefusal, makeRecoveryDriver } from "../src/cli/upgrade-runtime.ts";
import { createOperation, planFingerprint, runRecovery, type RecoveryDriver, type RecoveryOperation, type UpgradePlan } from "../src/cli/upgrade.ts";
import { packageDigest } from "../src/cli/recovery-package.ts";
import { writeOperation } from "../src/hub/recovery-store.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";

const FEATURES = ["external_adapter_modules", "peer_instances", "external_adapter_instances"];
function fixture() {
  const home = realPath(mkdtempSync(join(tmpdir(), "ahub-module-instance-upgrade-")));
  const root = join(home, "project"), stateDir = join(root, ".agenthub", "state"), packageRoot = join(home, "package");
  mkdirSync(stateDir, { recursive: true });
  expect(hubGitSync(["-C", root, "init", "-q"], { encoding: "utf8" }).status).toBe(0);
  const tripwire = join(home, "module-evaluated");
  const source = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(tripwire)}, "unexpected module evaluation"); throw new Error("no CLI module evaluation");`;
  writeFileSync(join(root, "module.js"), source);
  const sha256 = createHash("sha256").update(source).digest("hex");
  const declaration = { kind: "widget", roles: ["reviewer"], start_mode: "headless", worktree: ".worktrees/widget-review" };
  const local = join(root, ".agenthub", "config.local.json");
  const declare = (extra: Record<string, unknown> = {}) => writeFileSync(local, JSON.stringify({ adapter_modules: [{ path: "module.js", sha256 }], instances: { "widget-review": declaration }, ...extra }));
  declare();
  const binding: ExternalInstanceBinding = { schema: 1, projectRoot: root, instance: "widget-review", kind: "widget", modulePath: "module.js", sha256, api: 1,
    capabilityDigest: "a".repeat(64), policyDigest: "b".repeat(64), executionCwd: join(root, ".worktrees", "widget-review") };
  const peers = { "widget-review": { id: "widget-review", state: "offline", externalInstance: binding } };
  for (const dir of ["src/cli", "src/hub", "plugins/agent-hub/.claude-plugin", "templates", ".claude-plugin"]) mkdirSync(join(packageRoot, dir), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@staix/agent-hub", version: "0.0.0" }));
  writeFileSync(join(packageRoot, "plugins/agent-hub/.claude-plugin/plugin.json"), JSON.stringify({ version: "0.0.0" }));
  writeFileSync(join(packageRoot, "src/cli/main.js"), "throw new Error('no native startup');");
  writeFileSync(join(packageRoot, "src/hub/control-client.ts"), `export const PROTOCOL = ${PROTOCOL};`);
  return { home, root, stateDir, local, packageRoot, binding, peers, tripwire, declare, close: () => rmSync(home, { recursive: true, force: true }) };
}

test("#754 source feature floor includes offline/unknown external instance declarations without importing modules", () => {
  const f = fixture();
  try {
    for (const features of [undefined, [], ["external_adapter_modules", "peer_instances"], ["external_adapter_instances"], [...FEATURES, null]]) {
      for (const peers of [undefined, {}, f.peers, { "widget-review": { state: "unknown" } }]) {
        expect(instanceRecoverySourceRefusal(f.root, features, peers)).toContain("source lacks external_adapter_instances");
      }
    }
    expect(instanceRecoverySourceRefusal(f.root, FEATURES, f.peers)).toBeUndefined();
    expect(instanceRecoverySourceRefusal(f.root, FEATURES, {})).toContain("binding unavailable");
    expect(existsSync(f.tripwire)).toBe(false);
  } finally { f.close(); }
});

test("#754 source bindings cannot be replaced by display metadata, another pin/project/id or unknown state", () => {
  const f = fixture();
  try {
    for (const changed of [{}, { kind: "widget", displayName: "Widget" }, { ...f.binding, sha256: "c".repeat(64) }, { ...f.binding, projectRoot: f.home }, { ...f.binding, instance: "widget-other" }, { ...f.binding, modulePath: "other.js" }, { ...f.binding, schema: 2 }]) {
      expect(instanceRecoverySourceRefusal(f.root, FEATURES, { "widget-review": { state: "offline", externalInstance: changed } })).toContain("binding unavailable");
    }
    expect(instanceRecoverySourceRefusal(f.root, FEATURES, { "widget-review": { state: "unknown", externalInstance: f.binding } })).toContain("binding unavailable");
    expect(existsSync(f.tripwire)).toBe(false);
  } finally { f.close(); }
});

test("#754 target floor survives retained offline identity and keeps existing builtin-only offline compatibility", () => {
  const f = fixture();
  try {
    expect(instanceRecoveryTargetRefusal(f.root, FEATURES, Object.values(f.peers))).toBeUndefined();
    for (const features of [undefined, [], ["external_adapter_modules", "peer_instances"], ["external_adapter_instances"]]) expect(instanceRecoveryTargetRefusal(f.root, features)).toContain("target lacks external_adapter_instances");
    writeFileSync(f.local, "{}");
    expect(instanceRecoveryTargetRefusal(f.root, [], Object.values(f.peers))).toContain("target lacks external_adapter_instances");
    f.declare({ adapter_modules: [], instances: { "codex-other": { kind: "codex", roles: ["reviewer"] } } });
    expect(instanceRecoverySourceRefusal(f.root, [], { codex: { state: "idle" } })).toBeUndefined();
    expect(instanceRecoveryTargetRefusal(f.root, [])).toBeUndefined();
    expect(existsSync(f.tripwire)).toBe(false);
  } finally { f.close(); }
});

for (const cached of [false, true]) test(`#754 ${cached ? "reused" : "fresh"} target refuses the combined feature floor before prepare/stop/commit/start`, async () => {
  const f = fixture(), calls: string[] = [];
  try {
    const project = { id: "module-project", root: f.root, stateDir: f.stateDir, basePort: 0, instanceId: "source", pid: null };
    const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind: "restart", version: "0.0.0", sourceRoot: f.packageRoot, sourceDigest: packageDigest(f.packageRoot), blockers: [], projects: [{
      project, source: { state: "running", instanceId: "source", version: "0.0.0", protocol: PROTOCOL, peers: Object.values(f.peers), blockers: [] }, terminals: [], blockers: [],
    }] };
    const op = createOperation({ ...body, fingerprint: planFingerprint(body) }, f.packageRoot, f.home);
    if (cached) {
      Object.assign(op, { targetRoot: f.packageRoot, targetDigest: packageDigest(f.packageRoot), targetFeatures: ["external_adapter_modules", "peer_instances"] });
      writeOperation(op.id, op, f.home); // runRecovery reads the retained receipt, not this in-memory object.
    }
    const native = makeRecoveryDriver(async () => { calls.push("target feature probe"); return { code: 0, stdout: JSON.stringify({ protocol: PROTOCOL, features: ["external_adapter_modules", "peer_instances"] }), stderr: "" }; });
    const driver: RecoveryDriver = { ...native, inspect: async () => body.projects[0]!.source,
      prepare: async () => { calls.push("prepare"); }, commit: async () => { calls.push("commit"); },
      closeTerminals: async () => { calls.push("close"); }, start: async () => { calls.push("start"); },
      restore: async () => { calls.push("restore"); }, sleep: async () => {} };
    const result: RecoveryOperation = await runRecovery(op.id, driver, f.home);
    expect(result.phase).toBe("blocked"); expect(result.error).toContain("target lacks external_adapter_instances");
    expect(calls).toEqual(cached ? [] : ["target feature probe"]);
    expect(existsSync(f.tripwire)).toBe(false);
  } finally { f.close(); }
});

test("#754 restart snapshots retain only validated stopped external bindings and never authorize automatic resume", () => {
  const f = fixture();
  try {
    const snapshot: RestartSnapshot = { schemaVersion: 1, projectRoot: f.root, projectId: "module-project", sourceInstanceId: "source", operationId: "operation", committedAt: 1,
      bus: new Bus({ batchMs: 0 }).snapshot(), manualPaused: [], peers: [{ id: "widget-review", state: "offline", queueIds: [], sessionId: "native-recorded", externalInstance: f.binding }] };
    const read = () => readRestartSnapshot(f.stateDir, { projectRoot: f.root, projectId: "module-project", operationId: "operation" });
    writeRestartSnapshot(f.stateDir, snapshot);
    expect(read()?.peers[0]).toEqual(snapshot.peers[0]);
    for (const mutation of [{ ...f.binding, schema: 2 }, { ...f.binding, projectRoot: f.home }, { ...f.binding, instance: "widget-other" }, null]) {
      writeRestartSnapshot(f.stateDir, { ...snapshot, peers: [{ ...snapshot.peers[0]!, externalInstance: mutation as unknown as ExternalInstanceBinding }] });
      expect(read()).toBeUndefined();
    }
    writeRestartSnapshot(f.stateDir, { ...snapshot, peers: [{ ...snapshot.peers[0]!, state: "idle" }] });
    expect(read()).toBeUndefined();
    const integrity = { queues: {}, manualPaused: [], boardDigest: "board", budgetDigest: "budget", externalBindingsDigest: "c".repeat(64) };
    writeRestartSnapshot(f.stateDir, { ...snapshot, integrity });
    expect(read()?.integrity?.externalBindingsDigest).toBe(integrity.externalBindingsDigest);
    writeRestartSnapshot(f.stateDir, { ...snapshot, integrity: { ...integrity, externalBindingsDigest: "not-a-binding-digest" } });
    expect(read()).toBeUndefined();
  } finally { f.close(); }
});
