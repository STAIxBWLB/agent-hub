import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRecoveryDriver } from "../src/cli/upgrade-runtime.ts";
import { RecoveryDatabaseBusy } from "../src/hub/recovery-error.ts";
import { PROTOCOL, ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { HUB_DB_BUSY_TIMEOUT_MS } from "../src/hub/db-timeout.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { readRestartSnapshot } from "../src/hub/restart.ts";

// A normal foreign WAL writer does not block these reads. This diagnostic copy
// deliberately uses rollback journaling: it proves the real recovery RPC's busy
// outcome, not the unknown statement/holder of the historical CI failure.
async function fixture() {
  const temp = mkdtempSync(join(tmpdir(), "agenthub-recovery-busy-"));
  const cwd = join(temp, "project"), stateDir = join(cwd, ".agenthub", "state");
  mkdirSync(cwd);
  const operationId = "busy-recovery", instanceId = "busy-source", projectId = "busy-project";
  const options = { cwd, stateDir, projectId, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [] } } };
  const source = await startDaemon({ ...options, instanceId });
  const client = await ControlClient.connect(stateDir, { role: "console" });
  const rpc = (op: string) => client.request({ t: "recovery", op, operationId, expectedInstanceId: instanceId });
  expect((await client.request({ t: "task", op: "hub_task_propose", args: { title: "Preserve this task through a busy recovery", class: "implement" } })).ok).not.toBe(false);
  const before = JSON.parse((await client.request({ t: "task", op: "hub_task_list", args: {} })).text);
  expect(before).toHaveLength(1);
  expect((await rpc("prepare")).recovery.phase).toBe("prepared");

  const journal = (source.bus as unknown as { journal: DeliveryJournal }).journal;
  const handle = journal as unknown as { db: Database };
  const original = handle.db, originalSnapshot = journal.snapshot;
  const copyPath = join(temp, "snapshot.db");
  original.query("VACUUM INTO ?").run(copyPath);
  const copy = new Database(copyPath);
  copy.run(`PRAGMA busy_timeout = ${HUB_DB_BUSY_TIMEOUT_MS}`);
  copy.run("PRAGMA journal_mode = DELETE");
  handle.db = copy;

  const holderPath = join(temp, "holder.ts");
  writeFileSync(holderPath, `import { Database } from "bun:sqlite";
const db = new Database(process.argv[2]);
db.run("PRAGMA busy_timeout = ${HUB_DB_BUSY_TIMEOUT_MS}");
db.run("BEGIN EXCLUSIVE");
console.log("HELD");
process.on("message", (message) => {
  if (message === "release") {
    db.run("ROLLBACK"); db.close(); process.disconnect();
  }
});
`);
  const holder = Bun.spawn([process.execPath, holderPath, copyPath], { stdout: "pipe", stderr: "pipe", ipc() {} });
  const reader = holder.stdout.getReader();
  const ready = await reader.read();
  expect(new TextDecoder().decode(ready.value)).toContain("HELD");
  let releaseSent = false;
  const signalRelease = () => {
    if (!releaseSent) { releaseSent = true; holder.send("release"); }
  };
  const release = async () => {
    signalRelease();
    expect(await holder.exited).toBe(0); // foreign process consumed release and closed its connection
  };
  const useCopyOnce = (atBoundary?: () => void) => {
    journal.snapshot = function () {
      atBoundary?.();
      try { return originalSnapshot.call(this); }
      finally {
        // Only this diagnostic read uses the copied connection, including on a
        // busy refusal; later timer callbacks and shutdown use the real handle.
        handle.db = original;
        journal.snapshot = originalSnapshot;
      }
    };
  };
  const knownPeers = source.bus.knownPeers, queueSummary = source.bus.queueSummary;
  const useStatusCopyOnce = () => {
    // Include an offline peer so status performs its normal journal summary read.
    source.bus.knownPeers = () => ["busy-offline-peer"];
    source.bus.queueSummary = function (peer) {
      try { return queueSummary.call(this, peer); }
      finally {
        handle.db = original;
        this.knownPeers = knownPeers;
        this.queueSummary = queueSummary;
      }
    };
  };
  const cleanup = async () => {
    journal.snapshot = originalSnapshot;
    source.bus.knownPeers = knownPeers;
    source.bus.queueSummary = queueSummary;
    handle.db = original;
    if (holder.exitCode === null) holder.kill();
    await holder.exited;
    client.close();
    await source.stop();
    copy.close();
    rmSync(temp, { recursive: true, force: true });
  };
  return { temp, stateDir, options, source, client, operationId, projectId, rpc, before, signalRelease, release, useCopyOnce, useStatusCopyOnce, cleanup };
}

test("foreign contention in a pre-commit status read settles its rid with the named outcome (#303)", async () => {
  const f = await fixture();
  try {
    f.useStatusCopyOnce();
    const reply = await f.client.request({ t: "status" });
    expect(reply).toMatchObject({ ok: false, code: "database_busy", retryable: true });
    expect(reply.error).toContain("resume this recovery operation");
    expect(JSON.stringify(reply)).not.toContain("database is locked");
    await f.release();
    expect((await f.client.request({ t: "status" })).status.tasks.proposed).toBe(1);
  } finally { await f.cleanup(); }
}, 15_000);

async function restoreAndCheck(f: Awaited<ReturnType<typeof fixture>>) {
  await f.source.stopped;
  const snapshot = readRestartSnapshot(f.stateDir, { projectRoot: f.options.cwd, projectId: f.projectId, operationId: f.operationId });
  expect(snapshot?.operationId).toBe(f.operationId);
  const previous = process.env.AGENTHUB_RECOVERY_OPERATION;
  let target: Awaited<ReturnType<typeof startDaemon>>;
  try {
    process.env.AGENTHUB_RECOVERY_OPERATION = f.operationId;
    target = await startDaemon({ ...f.options, instanceId: "busy-target" });
  } finally {
    if (previous === undefined) delete process.env.AGENTHUB_RECOVERY_OPERATION;
    else process.env.AGENTHUB_RECOVERY_OPERATION = previous;
  }
  let client: ControlClient | undefined;
  try {
    client = await ControlClient.connect(f.stateDir, { role: "console" });
    const inspect = await client.request({ t: "recovery", op: "inspect", operationId: f.operationId, expectedInstanceId: "busy-target" });
    expect(inspect.recovery.phase).toBe("restored");
    expect(inspect.recovery.integrity.current).toEqual(inspect.recovery.integrity.expected);
    expect((await client.request({ t: "recovery", op: "release", operationId: f.operationId, expectedInstanceId: "busy-target" })).released).toBe(true);
    const after = JSON.parse((await client.request({ t: "task", op: "hub_task_list", args: {} })).text);
    expect(after).toEqual(f.before);
  } finally { client?.close(); await target.stop(); }
}

test("a recovery commit names exhausted foreign database contention and can be resumed (#303)", async () => {
  const f = await fixture();
  try {
    f.useCopyOnce();
    const result = await f.rpc("commit");
    expect(result).toMatchObject({ t: "recovery", ok: false, code: "database_busy", retryable: true });
    expect(result.error).toContain("resume this recovery operation");
    expect(JSON.stringify(result)).not.toMatch(/database is locked|database table is locked/);
    expect(readRestartSnapshot(f.stateDir, { projectRoot: f.options.cwd, projectId: f.projectId })).toBeUndefined();
    const log = readFileSync(join(f.stateDir, "hub.log"), "utf8");
    expect(log).toContain("recovery commit database contention");
    expect(log).not.toMatch(/database is locked|database table is locked/);
    expect(log).toContain("snapshot"); // real journal metadata SELECT's stack, rather than a thrown stand-in
    await f.release();
    expect((await f.rpc("inspect")).recovery.phase).toBe("prepared");
    f.useCopyOnce();
    expect((await f.rpc("commit")).committed).toBe(true);
    await restoreAndCheck(f);
  } finally { await f.cleanup(); }
}, 15_000);

test("a foreign lock released at the snapshot boundary lets recovery commit complete (#303)", async () => {
  const f = await fixture();
  try {
    let boundary = false;
    f.useCopyOnce(() => {
      boundary = true;
      f.signalRelease();
    });
    // IPC is consumed by another process while the daemon's synchronous SELECT
    // may wait. This boundary proves release within the bound, not time spent blocked.
    expect((await f.rpc("commit")).committed).toBe(true);
    expect(boundary).toBe(true);
    await f.release();
    await restoreAndCheck(f);
  } finally { await f.cleanup(); }
}, 15_000);


for (const form of ["legacy", "named"] as const) test(`a current coordinator settles the ${form} hub busy reply without hanging (#303)`, async () => {
  const root = mkdtempSync(join(tmpdir(), "agenthub-busy-wire-")), stateDir = join(root, "state");
  mkdirSync(stateDir);
  const requests: string[] = [];
  const project = { id: "busy-wire", root, stateDir, basePort: 0, instanceId: "wire-source", pid: null };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response("upgrade required", { status: 400 }); },
    websocket: { message(socket, data) {
      const request = JSON.parse(String(data));
      requests.push(request.t);
      const reply = request.t === "hello"
        ? { t: "welcome", ok: true, projectId: project.id, instanceId: project.instanceId, cwd: root }
        : { t: "recovery", ok: false, error: form === "legacy" ? "database is locked" : new RecoveryDatabaseBusy().message,
          ...(form === "named" ? { code: "database_busy", retryable: true } : {}) };
      socket.send(JSON.stringify({ ...reply, rid: request.rid }));
    } },
  });
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: server.port, protocol: PROTOCOL, projectId: project.id, instanceId: project.instanceId, cwd: root }));
  writeFileSync(join(stateDir, "control-token"), "wire-fixture-token");
  try {
    await expect(makeRecoveryDriver().commit(project, "wire-operation", "wire-source")).rejects.toBeInstanceOf(RecoveryDatabaseBusy);
    expect(requests).toEqual(["hello", "recovery"]);
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
