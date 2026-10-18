import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { packageDigest } from "../src/cli/recovery-package.ts";
import { makeRecoveryDriver, instanceRecoverySourceRefusal, inspectRecovery } from "../src/cli/upgrade-runtime.ts";
import { abortRecovery, createOperation, disposeRecovery, planFingerprint, runRecovery, type Inspection, type RecoveryDriver, type RecoveryOperation, type UpgradePlan } from "../src/cli/upgrade.ts";
import { recordedPeerGuidance, stopAndArchiveSummary } from "../src/cli/recovery-guidance.ts";
import { readOperation, recoveryLock, writeOperation } from "../src/hub/recovery-store.ts";
import { shellQuote, type TerminalBinding } from "../src/cli/terminal-recovery.ts";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ahub-instance-finalize-")), root = join(home, "package"), projectRoot = join(home, "project");
  for (const dir of ["src/cli", "src/hub", "plugins/agent-hub/.claude-plugin", "templates", ".claude-plugin"]) mkdirSync(join(root, dir), { recursive: true });
  mkdirSync(join(projectRoot, ".agenthub"), { recursive: true });
  expect(hubGitSync(["-C", projectRoot, "init", "-q"], { encoding: "utf8" }).status).toBe(0);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@staix/agent-hub", version: "0.0.0" }));
  writeFileSync(join(root, "plugins/agent-hub/.claude-plugin/plugin.json"), JSON.stringify({ version: "0.0.0" }));
  writeFileSync(join(root, "src/cli/main.js"), ""); writeFileSync(join(root, "src/hub/control-client.ts"), "export const PROTOCOL = 16;\n");
  const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind: "restart", version: "0.0.0", sourceRoot: root, sourceDigest: packageDigest(root), blockers: [], projects: [{
    project: { id: "project", root: projectRoot, stateDir: join(projectRoot, "state"), instanceId: "source", pid: null, basePort: 4600 },
    source: { state: "running", instanceId: "source", version: "0.0.0", peers: [], blockers: [] }, terminals: [], blockers: [],
  }] };
  const op = createOperation({ ...body, fingerprint: planFingerprint(body) }, root, home);
  const file = join(projectRoot, ".agenthub/config.local.json");
  const declare = () => writeFileSync(file, JSON.stringify({ instances: { "codex-2": { kind: "codex", roles: ["reviewer"] } } }));
  const calls: string[] = []; let stopped = false;
  let inspect: () => Inspection = () => ({ state: "running", instanceId: "target", version: "0.0.0", peers: [], blockers: [], recovery: { operationId: op.id, phase: "restored", ready: true } });
  const native = makeRecoveryDriver(async () => { calls.push("unexpected feature probe"); throw new Error("past-commit operation must not probe compatibility"); });
  const driver: RecoveryDriver = { ...native,
    inspect: async () => stopped ? { state: "stopped", peers: [], blockers: [] } : inspect(),
    prepare: async () => { calls.push("prepare"); }, commit: async () => { calls.push("commit"); },
    abort: async () => { calls.push("abort"); }, closeTerminals: async () => { calls.push("close"); },
    start: async () => { calls.push("start"); }, restore: async (_p, _progress, _op, group) => { calls.push(`restore ${group}`); },
    installPlugin: async () => { calls.push("plugin"); }, installGlobal: async () => { calls.push("global"); },
    refreshManager: async () => { calls.push("manager"); }, verify: async () => { calls.push("verify"); }, release: async () => { calls.push("release"); },
    stopAndArchive: async () => { stopped = true; calls.push("stop-and-archive"); }, now: () => 1000, sleep: async () => {},
  };
  const retained = () => {
    const launch = { packageEntrypoint: "/saved/main.js", argv: [], env: {}, command: "recorded only" };
    const binding: TerminalBinding = { peer: "codex-2", projectRoot, sessionId: "saved-thread", handle: "saved-pane", incarnationId: "saved-incarnation", worktreeId: "saved-worktree", launch, launchMetadata: launch };
    op.projects[0]!.reattachments = { "codex-2": { state: "ready", at: 1, cause: "detached after restore", binding } };
    op.blockedReattachment = { projectId: "project", peer: "codex-2" };
  };
  return { home, root, projectRoot, file, op, driver, calls, declare, retained, inspectAs(value: Inspection) { inspect = () => value; }, save() { writeOperation(op.id, op, home); }, close() { rmSync(home, { recursive: true, force: true }); } };
}

for (const features of [[], ["task_cancel"]]) test(`B4 committed cached ${features.length ? "task_cancel" : "empty"} features survive a later instance declaration through actual stage and resume`, async () => {
  const f = fixture();
  try {
    Object.assign(f.op, { targetRoot: f.root, targetDigest: packageDigest(f.root), targetFeatures: features });
    Object.assign(f.op.projects[0]!, { phase: "peers-restored", commitSent: true, instanceId: "target" });
    f.declare(); f.save();
    expect(await f.driver.stage(f.op)).toMatchObject({ root: f.root, digest: f.op.targetDigest, targetFeatures: features });
    const finished = await runRecovery(f.op.id, f.driver, f.home);
    expect(finished.phase).toBe("completed"); expect(finished.targetFeatures).toEqual(features);
    expect(f.calls).not.toContain("unexpected feature probe"); expect(f.calls).not.toContain("prepare"); expect(f.calls).not.toContain("commit"); expect(f.calls).not.toContain("close");
    expect(f.calls).toContain("release"); expect(recoveryLock(f.home)).toBeUndefined();
  } finally { f.close(); }
});

for (const mutation of ["revoked", "malformed"] as const) for (const action of ["abort", "dispose"] as const) test(`owned recovery ${action} remains available with ${mutation} mutable instance declarations`, async () => {
  const f = fixture();
  try {
    f.declare(); f.retained(); f.op.phase = "blocked";
    if (action === "abort") {
      f.op.projects[0]!.phase = "prepared";
      f.inspectAs({ state: "running", instanceId: "source", version: "0.0.0", peers: [], blockers: [], recovery: { operationId: f.op.id, phase: "prepared", ready: true } });
    } else Object.assign(f.op.projects[0]!, { phase: "peers-restored", commitSent: true, instanceId: "target" });
    f.save(); writeFileSync(f.file, mutation === "revoked" ? "{}" : "{malformed local configuration");
    if (action === "abort") await abortRecovery(f.op.id, f.driver, f.home);
    else expect((await disposeRecovery(f.op.id, { stop: true }, "person requested cleanup", f.driver, f.home)).phase).toBe("cancelled");
    expect(readOperation<RecoveryOperation>(f.op.id, f.home).phase).toBe("cancelled");
    expect(f.calls).toContain(action === "abort" ? "abort" : "stop-and-archive"); expect(recoveryLock(f.home)).toBeUndefined();
  } finally { f.close(); }
});

test("malformed one-project declarations yield bounded unavailable guidance while another project's guidance remains usable", () => {
  const bad = fixture(), good = fixture();
  try {
    bad.declare(); bad.retained(); writeFileSync(bad.file, "{malformed");
    expect(() => recordedPeerGuidance(bad.op.plan.projects[0]!, bad.op.projects[0]!)).not.toThrow();
    const rows = recordedPeerGuidance(bad.op.plan.projects[0]!, bad.op.projects[0]!);
    expect(rows.length).toBeGreaterThan(0); expect(rows.length).toBeLessThanOrEqual(67);
    expect(rows.every(row => !row.command && row.note.includes("unavailable"))).toBe(true);
    good.declare(); good.retained();
    expect(recordedPeerGuidance(good.op.plan.projects[0]!, good.op.projects[0]!).find(row => row.peer === "codex-2")?.command).toContain(["--as", "codex-2"].map(shellQuote).join(" "));
    good.op.plan.projects[0]!.project.id = "good-project"; good.op.projects[0]!.id = "good-project";
    const operation = { ...bad.op, projects: [...bad.op.projects, ...good.op.projects], plan: { ...bad.op.plan, projects: [...bad.op.plan.projects, ...good.op.plan.projects] } };
    expect(stopAndArchiveSummary(operation).join("\n")).toContain(["ahub", "--project", good.projectRoot, "codex", "--as", "codex-2"].map(shellQuote).join(" "));
  } finally { bad.close(); good.close(); }
});

test("old source can upgrade before it actually owns a declared instance, but a declared live peer still requires feature support", () => {
  const f = fixture();
  const classify = instanceRecoverySourceRefusal as (root: string, features: unknown, observed?: unknown) => string | undefined;
  try {
    f.declare();
    expect(classify(f.projectRoot, [], { codex: { state: "idle" } })).toBeUndefined();
    expect(classify(f.projectRoot, [], { "codex-2": { state: "idle" } })).toContain("source lacks peer_instances");
    expect(classify(f.projectRoot, [], { "codex-not-declared": { state: "idle" } })).toBeUndefined();
    expect(classify(f.projectRoot, undefined)).toContain("source lacks peer_instances");
  } finally { f.close(); }
});


test("cleanup runtime inspection keeps authenticated owner evidence available despite malformed local declarations", async () => {
  const f = fixture(), project = f.op.plan.projects[0]!.project;
  mkdirSync(project.stateDir, { recursive: true });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response("no websocket"); },
    websocket: { message(ws, raw) {
      const request = JSON.parse(String(raw));
      if (request.t === "hello") ws.send(JSON.stringify({ rid: request.rid, t: "welcome", ok: true, projectId: project.id, instanceId: "source", cwd: project.root, protocol: PROTOCOL }));
      else if (request.t === "status") ws.send(JSON.stringify({ rid: request.rid, t: "status", ok: true, status: { projectId: project.id, instanceId: "source", cwd: project.root, version: "0.0.0", protocol: PROTOCOL, features: ["task_cancel"], peers: { codex: { id: "codex", state: "idle" } } } }));
      else ws.send(JSON.stringify({ rid: request.rid, t: "recovery", ok: true, recovery: { operationId: f.op.id, phase: "prepared", ready: true, peers: {} } }));
    } },
  });
  writeFileSync(join(project.stateDir, "control-token"), "fixture-token");
  writeFileSync(join(project.stateDir, "status.json"), JSON.stringify({ controlPort: server.port, protocol: PROTOCOL, projectId: project.id, instanceId: "source", cwd: project.root }));
  try {
    f.declare(); writeFileSync(f.file, "{malformed");
    const inspect = inspectRecovery as (candidate: typeof project, features?: readonly string[], purpose?: "cleanup") => Promise<Inspection>;
    expect(await inspect(project, undefined, "cleanup")).toMatchObject({ state: "running", instanceId: "source", recovery: { operationId: f.op.id, phase: "prepared" } });
    await expect(inspectRecovery(project)).rejects.toThrow();
  } finally { server.stop(true); f.close(); }
});
