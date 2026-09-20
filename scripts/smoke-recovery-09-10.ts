#!/usr/bin/env bun
/**
 * Disposable 0.6.4 (protocol 9) -> working tree (protocol 10) recovery smoke.
 *
 * This intentionally uses a real published 0.6.4 subprocess and an isolated
 * AGENTHUB_HOME. It never touches the user's registry, manager, projects, or
 * running daemon. The old daemon is stopped before the target is started and
 * every recovery assertion is read back from the target control socket.
 */
import { realpathSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { ControlClient, PROTOCOL } from "../src/hub/control-client.ts";
import { packageDigest, stageRelease } from "../src/cli/recovery-package.ts";
import { PACKAGE_ROOT } from "../src/cli/upgrade-runtime.ts";

const OLD_VERSION = "0.6.4";
const OLD_INTEGRITY = "sha512-IRSWqC9rRGwsoJtJuXzQLUbdRfad24NTTN0AxuyAp5KrV1v/7O+ETUEmNBvO4wKVIMbISqW93C3Z546pxDgTWQ==";
const timeoutMs = 45_000;

type Result = { code: number; stdout: string; stderr: string };

function run(args: string[], env: NodeJS.ProcessEnv, cwd: string, limit = timeoutMs): Promise<Result> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`timed out: ${args.join(" ")}`)); }, limit);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolveResult({ code: code ?? 1, stdout, stderr }); });
  });
}

async function waitForControl(stateDir: string, projectRoot: string, protocol: number, env: NodeJS.ProcessEnv): Promise<ControlClient> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await ControlClient.connect(stateDir, { role: "console", projectRoot }, 1_000, protocol); }
    catch { await Bun.sleep(100); }
  }
  throw new Error(`control socket did not become ready: ${stateDir}`);
}

async function stopOwnedDaemon(): Promise<void> {
  for (const protocol of [10, 9]) {
    try {
      const client = await ControlClient.connect(stateDir, { role: "console", projectRoot: project }, 1_000, protocol);
      const status = await client.request({ t: "status" }, 2_000);
      const instanceId = status.status?.instanceId;
      if (status.status?.cwd !== project || typeof instanceId !== "string") { client.close(); continue; }
      const stopped = await client.request({ t: "kill", instanceId }, 5_000);
      client.close();
      assert(stopped.ok === true, `owned daemon refused authenticated shutdown: ${JSON.stringify(stopped)}`);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          const current = JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8"));
          if (current.instanceId !== instanceId) return;
        } catch { return; }
        await Bun.sleep(100);
      }
      throw new Error(`owned daemon ${instanceId} did not remove its status after authenticated shutdown`);
    } catch (error) {
      if (error instanceof Error && /refused authenticated shutdown|did not remove/.test(error.message)) throw error;
    }
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-recovery-09-10-")));
const home = join(root, "home");
const project = join(root, "project");
const stateDir = join(project, ".agenthub", "state");
const baseEnv: NodeJS.ProcessEnv = {
  ...process.env,
  AGENTHUB_HOME: home,
  AGENTHUB_PROJECT_DIR: project,
  AGENTHUB_STATE_DIR: stateDir,
  AGENTHUB_UNATTENDED: "0",
};
let oldRoot = "";
let sourceClient: ControlClient | undefined;

async function main(): Promise<void> {
  if (PROTOCOL !== 10) throw new Error(`working tree target must speak protocol 10, got ${PROTOCOL}`);
  if (!existsSync(join(PACKAGE_ROOT, "package.json"))) throw new Error("working tree package is unavailable");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(project, ".agenthub"), { recursive: true });
  writeFileSync(join(root, "README.md"), "disposable recovery fixture\n");
  await Bun.write(join(project, ".agenthub", "config.json"), JSON.stringify({ version: 1,
    memory: { enabled: false }, inference: { enabled: false }, omniroute: { urls: [] }, pi: { enabled: false } }));
  const staged = await stageRelease(OLD_VERSION, OLD_INTEGRITY, undefined, home);
  oldRoot = staged.root;
  const oldProtocol = await run([oldRoot + "/src/cli/main.js", "--version"], baseEnv, project);
  assert(oldProtocol.code === 0 && oldProtocol.stdout.trim() === OLD_VERSION, `published source identity failed: ${oldProtocol.stderr}`);

  const started = await run([join(oldRoot, "src/cli/main.js"), "--project", project, "up"], baseEnv, project);
  assert(started.code === 0, `source failed to start: ${started.stderr}`);
  const source = await waitForControl(stateDir, project, 9, baseEnv);
  sourceClient = source;
  let sourceState: any;
  let sourceTasksDigest = "";
  let sourceQueueIds: string[] = [];
  let sourceManualPaused: string[] = [];
  try {
    // Register an explicitly offline peer so its queue and manual pause are
    // exercised without starting a real native account or model process.
    const claude = await ControlClient.connect(stateDir, { role: "peer", peer: "claude", projectRoot: project }, 5_000, 9);
    claude.close();
    const status = await source.request({ t: "status" });
    sourceState = status.status;
    assert(sourceState?.protocol === 9, `source did not report protocol 9: ${JSON.stringify(sourceState)}`);
    const paused = await source.request({ t: "pause", peer: "claude" });
    assert(paused.ok === true, `could not establish manual pause: ${JSON.stringify(paused)}`);
    const sent = await source.request({ t: "send", body: "[STATUS] disposable recovery queue marker", to: ["claude"] });
    assert(sent.ok === true, `could not queue marker: ${JSON.stringify(sent)}`);
    const task = await run([join(oldRoot, "src/cli/main.js"), "--project", project, "task", "propose", "test", "protocol 9 recovery task", "--detail", "disposable"], baseEnv, project);
    assert(task.code === 0, `could not create source task: ${task.stderr}`);
    const sourceSnapshot = await source.request({ t: "ui_snapshot", after: 0 });
    assert(sourceSnapshot.ok === true, `source snapshot readback failed: ${JSON.stringify(sourceSnapshot)}`);
    sourceTasksDigest = digest((sourceSnapshot.tasks ?? []).map((task: any) => ({ id: task.id, state: task.state, owner: task.owner })).sort((a: any, b: any) => a.id - b.id));
    const sourceRecovery = await source.request({ t: "recovery", op: "inspect", expectedInstanceId: sourceState.instanceId });
    sourceQueueIds = [...new Set<string>((sourceRecovery.recovery?.integrity?.current?.queues?.claude ?? []).map(String))].sort();
    sourceManualPaused = [...new Set<string>((sourceRecovery.recovery?.integrity?.current?.manualPaused ?? []).map(String))].sort();
    assert(sourceQueueIds.length > 0 && sourceManualPaused.includes("claude"), `source integrity did not expose queue/pause state: ${JSON.stringify(sourceRecovery)}`);
    source.close();
    sourceClient = undefined;
  } catch (error) { source.close(); sourceClient = undefined; throw error; }

  const operation = await run([join(PACKAGE_ROOT, "src/cli/main.js"), "--project", project, "restart", "--yes"], baseEnv, project);
  assert(operation.code === 0, `target coordinator did not schedule: ${operation.stderr}`);
  const operationId = /recovery status ([0-9a-f-]+)/i.exec(operation.stdout)?.[1];
  assert(operationId, `coordinator did not print operation ID: ${operation.stdout}`);

  const deadline = Date.now() + 180_000;
  let recovery: any;
  while (Date.now() < deadline) {
    const status = await run([join(PACKAGE_ROOT, "src/cli/main.js"), "recovery", "status", operationId], baseEnv, project);
    if (status.code === 0) {
      try { recovery = JSON.parse(status.stdout); } catch { /* operation still being written */ }
      if (recovery?.phase === "completed" || recovery?.phase === "blocked") break;
    }
    await Bun.sleep(250);
  }
  assert(recovery?.phase === "completed", `recovery did not complete: ${JSON.stringify(recovery)}`);
  const target = await waitForControl(stateDir, project, 10, baseEnv);
  try {
    const targetStatus = await target.request({ t: "status" });
    assert(targetStatus.status?.protocol === 10, `target did not report protocol 10: ${JSON.stringify(targetStatus.status)}`);
    assert(targetStatus.status?.instanceId !== sourceState.instanceId, "target reused the source instance identity");
    const queue = await target.request({ t: "queue", op: "list", peer: "claude" });
    const targetQueueIds = [...new Set((queue.deliveries ?? []).flatMap((row: any) => row.envelopeIds ?? []).map(String))].sort();
    assert(queue.ok === true && JSON.stringify(targetQueueIds) === JSON.stringify(sourceQueueIds), `queue IDs changed across recovery: ${JSON.stringify({ sourceQueueIds, targetQueueIds, queue })}`);
    const preserved = await target.request({ t: "recovery", op: "inspect", expectedInstanceId: targetStatus.status.instanceId });
    assert(JSON.stringify(preserved.recovery?.integrity?.current?.manualPaused) === JSON.stringify(sourceManualPaused), "manual pause identities changed");
    const targetSnapshot = await target.request({ t: "ui_snapshot", after: 0 });
    const targetTasksDigest = digest((targetSnapshot.tasks ?? []).map((task: any) => ({ id: task.id, state: task.state, owner: task.owner })).sort((a: any, b: any) => a.id - b.id));
    assert(targetTasksDigest === sourceTasksDigest, `task identity/state digest changed across recovery: ${sourceTasksDigest} -> ${targetTasksDigest}`);
    const inspected = await target.request({ t: "recovery", op: "inspect", expectedInstanceId: targetStatus.status.instanceId });
    assert(inspected.ok === true && inspected.recovery?.phase === "released", `target recovery was not released: ${JSON.stringify(inspected)}`);
    console.log(JSON.stringify({ sourceProtocol: 9, targetProtocol: 10, sourceInstanceId: sourceState.instanceId, targetInstanceId: targetStatus.status.instanceId, operationId, queuePreserved: true, taskDigest: targetTasksDigest, targetDigest: packageDigest(PACKAGE_ROOT) }, null, 2));
  } finally { target.close(); }
}

try {
  await main();
} finally {
  await stopOwnedDaemon();
  rmSync(root, { recursive: true, force: true });
}
