import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Registry } from "../src/hub/registry.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { authorizeConductorRecovery, type ConductorRecoveryBinding } from "../src/hub/recovery-authority.ts";
import { readOperation, recoveryLock, recoveryRunner, signedRunner, stopSignedRunner } from "../src/hub/recovery-store.ts";
import { realPath } from "../src/hub/project.ts";
import { processLiveness, processSignature } from "../src/pi/process-signature.ts";
import type { RecoveryOperation } from "../src/cli/upgrade.ts";
import { emulatedBoundedTools } from "./fakes/bounded-capabilities.ts";
import { COMPAT } from "../src/adapters/compat.ts";

/** Poll a named completion condition, never infer completion from elapsed sleep. */
async function until(check: () => boolean, label: string, attempts = 300): Promise<void> {
  for (let index = 0; index < attempts && !check(); index++) await Bun.sleep(20);
  expect(check(), label).toBe(true);
}
function freeWindow(): number {
  for (let attempt = 0; attempt < 10; attempt++) {
    const probes: { stop(closeActiveConnections?: boolean): void }[] = [];
    try {
      const first = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("fixture") }); probes.push(first);
      const base = first.port!; if (base > 65532) continue;
      for (const offset of [1, 2]) probes.push(Bun.serve({ hostname: "127.0.0.1", port: base + offset, fetch: () => new Response("fixture") }));
      return base;
    } catch { /* Another fixture owns this window; use another ephemeral probe. */ }
    finally { for (const probe of probes) probe.stop(true); }
  }
  throw new Error("no free fixture port window");
}
interface OwnedPid { pid: number; signature: string; instanceId?: string }

test("conductor CLI detached restart completes through a real target process without console delegation or native calls", async () => {
  const temporary = realPath(mkdtempSync(join(tmpdir(), "ahub-conductor-restart-process-"))), root = join(temporary, "project"), home = join(temporary, "hub");
  const userHome = join(temporary, "user"), bin = join(temporary, "bin"), unexpected = join(temporary, "unexpected-native");
  mkdirSync(join(root, ".agenthub"), { recursive: true }); mkdirSync(userHome); mkdirSync(bin);
  const vendors = { CLAUDE_CONFIG_DIR: join(userHome, "claude"), CODEX_HOME: join(userHome, "codex"), KIMI_CODE_HOME: join(userHome, "kimi"), PI_CODING_AGENT_DIR: join(userHome, "pi"), QWEN_HOME: join(userHome, "qwen"), JCODE_HOME: join(userHome, "jcode"), AMEM_HOME: join(userHome, "memory"), XDG_CONFIG_HOME: join(userHome, ".config") };
  const overrides = Object.keys(process.env).filter(key => key.startsWith("OMNIROUTE_") || key.startsWith("CF_ACCESS_"));
  const old = Object.fromEntries(["AGENTHUB_HOME", "HOME", "PATH", "LANG", "LC_ALL", "TZ", "TERM", "NO_COLOR", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL", ...Object.keys(vendors), ...overrides].map(key => [key, process.env[key]]));
  for (const key of overrides) delete process.env[key];
  const env: Record<string, string> = { PATH: `${bin}:/usr/bin:/bin`, HOME: userHome, AGENTHUB_HOME: home, ...vendors, LANG: "C", LC_ALL: "C", TZ: "UTC", TERM: "dumb", NO_COLOR: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null" };
  Object.assign(process.env, env);
  expect(Bun.spawnSync(["git", "init", "-q", root], { cwd: root, env, timeout: 2000 }).exitCode).toBe(0);
  // Production target drift can ask only metadata after release. No installed
  // agent/Orca/provider tool is reachable; every other invocation is a failure.
  for (const name of ["claude", "codex", "kimi", "pi", "qwen", "jcode", "agy", "orca", "curl", "npm"]) {
    const metadata = Object.values(COMPAT).filter(policy => policy.probe[0] === name).map(policy => policy.probe.slice(1));
    writeFileSync(join(bin, name), `#!${process.execPath}\nif(${JSON.stringify(metadata)}.some(args=>JSON.stringify(args)===JSON.stringify(process.argv.slice(2)))){console.log("fixture metadata only");process.exit(0)}\nconst {appendFileSync}=await import("node:fs");appendFileSync(${JSON.stringify(unexpected)},${JSON.stringify(name + " refused\n")});process.exit(97);\n`, { mode: 0o700 });
  }
  const config = { roles: { ...DEFAULT_CONFIG.roles, codex: ["conductor", "planner"], claude: ["implementer"] }, planner: "codex",
    kimi_cmd: ["kimi"], qwen_cmd: ["qwen"], jcode_home: vendors.JCODE_HOME,
    roster: { codex: true, claude: false, kimi: false, pi: false, local: false, qwen: false, jcode: false, agy: false },
    memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
    omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [] }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
    mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, snapshots: { enabled: false, keep: 20 },
    task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, tasks: { ...DEFAULT_CONFIG.tasks, auto_pull: false }, pet: { ...DEFAULT_CONFIG.pet, window: false }, batch_ms: 0 };
  for (const file of ["config.json", "config.local.json"]) writeFileSync(join(root, ".agenthub", file), JSON.stringify(config));
  const registry = new Registry(join(home, "registry.db"));
  const registered = registry.register(root), basePort = freeWindow();
  // Fixture-only registry allocation from the free-port probe, never a guessed port.
  const allocation = new Database(registry.path); allocation.run("PRAGMA busy_timeout = 5000");
  allocation.query("UPDATE projects SET base_port=? WHERE id=?").run(basePort, registered.id); allocation.close();
  const project = registry.get(registered.id)!, sourceInstance = crypto.randomUUID();
  let source: Awaited<ReturnType<typeof startDaemon>> | undefined, sourceRelease: Promise<void> | undefined;
  let operationId: string | undefined, runner: OwnedPid | undefined, target: OwnedPid | undefined;
  let cli: ReturnType<typeof Bun.spawn> | undefined;
  const stopTarget = async () => {
    const row = registry.get(project.id);
    if (!target && row?.instanceId && row.instanceId !== sourceInstance && row.pid && row.pidSignature) target = { pid: row.pid, signature: row.pidSignature, instanceId: row.instanceId };
    if (!target || processLiveness(target.pid, target.signature) === "gone") return;
    if (target.pid === process.pid || processLiveness(target.pid, target.signature) !== "live") throw new Error("target cleanup ownership unavailable");
    const person = await ControlClient.connect(project.stateDir, { role: "console", projectRoot: root, projectId: project.id, instanceId: target.instanceId });
    try { expect((await person.request({ t: "kill", instanceId: target.instanceId })).ok).toBe(true); } finally { person.close(); }
    await until(() => processLiveness(target!.pid, target!.signature) === "gone", "owned target process ended");
  };
  try {
    source = await startDaemon({ cwd: root, stateDir: project.stateDir, projectId: project.id, instanceId: sourceInstance,
      controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: loadConfig(root), snapshotClock: () => 0, configWatch: false,
      agentDrift: false, boundedTools: emulatedBoundedTools(), onShutdownStart: () => {
        const id = recoveryLock(home, root), pid = id ? signedRunner(id, home) : undefined, signature = pid ? processSignature(pid) : undefined;
        if (pid && signature) runner = { pid, signature };
      } });
    const signature = processSignature(process.pid); expect(signature).toBeDefined();
    expect(registry.claim(project.id, sourceInstance, process.pid, signature)).toBe(true);
    // The source is an actual daemon in this test process. Its signed registry
    // claim must retire on stopped, not wait for the surrounding test process.
    sourceRelease = source.stopped.then(() => { registry.release(project.id, sourceInstance); });
    expect([...source.bus.peers.values()].filter(peer => peer.state !== "offline")).toEqual([]);
    const main = join(realPath(resolve(import.meta.dir, "..")), "src", "cli", "main.js");
    const producer = Bun.spawn([process.execPath, main, "--project", root, "restart", "--yes", "--json"], { cwd: root, env: { ...env, AGENTHUB_PEER_ID: "codex" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    cli = producer;
    const timer = setTimeout(() => producer.kill("SIGTERM"), 10_000);
    let code: number, stdout: string, stderr: string;
    try { [code, stdout, stderr] = await Promise.all([producer.exited, new Response(producer.stdout).text(), new Response(producer.stderr).text()]); }
    finally { clearTimeout(timer); }
    expect(code, stderr!).toBe(0);
    const announced = JSON.parse(stdout!); operationId = announced.id; expect(operationId).toMatch(/^[a-f0-9-]{36}$/);
    let receipt: RecoveryOperation | undefined;
    await until(() => {
      receipt = readOperation<RecoveryOperation>(operationId!, home);
      return receipt.phase === "completed" || receipt.phase === "blocked";
    }, "detached conductor restart reaches terminal receipt", 750);
    expect({ phase: receipt!.phase, step: receipt!.step, error: receipt!.error }).toEqual({ phase: "completed", step: "completed", error: undefined });
    await sourceRelease;
    expect(receipt!.plan.kind).toBe("restart"); expect(receipt!.targetRoot).toBe(receipt!.sourceRoot);
    expect(receipt!.plan.projects).toHaveLength(1); expect(receipt!.plan.projects[0]!.terminals).toEqual([]);
    expect(receipt!.plan.projects[0]!.source.peers.every(peer => peer.state === "offline")).toBe(true);
    expect(receipt!.sourceRoot.startsWith(join(home, "releases"))).toBe(true);
    expect(receipt!.pluginInstalled).not.toBe(true); expect(receipt!.globalInstalled).not.toBe(true);
    expect(receipt!.delegatedAudits).toEqual(expect.arrayContaining([expect.objectContaining({ peer: "codex", command: "restart" })]));
    expect(runner).toBeDefined(); expect(runner!.pid).not.toBe(process.pid); expect(runner!.pid).not.toBe(producer.pid);
    await until(() => processLiveness(runner!.pid, runner!.signature) === "gone", "owned detached runner ended");
    expect(recoveryRunner(operationId!, home)).toBeUndefined();
    const claimed = registry.get(project.id)!;
    expect(claimed.instanceId).not.toBe(sourceInstance); expect(claimed.pid).not.toBe(process.pid); expect(claimed.pidSignature).toBeDefined();
    target = { pid: claimed.pid!, signature: claimed.pidSignature!, instanceId: claimed.instanceId! };
    expect(processLiveness(target.pid, target.signature)).toBe("live");
    const person = await ControlClient.connect(project.stateDir, { role: "console", projectRoot: root, projectId: project.id, instanceId: target.instanceId });
    try {
      const status = (await person.request({ t: "status" })).status;
      expect(status.instanceId).toBe(target.instanceId); expect(status.recovery).toMatchObject({ operationId, phase: "released" });
    } finally { person.close(); }
    const privateGrant = JSON.parse(readFileSync(join(project.stateDir, `conductor-recovery.${operationId}.json`), "utf8")) as { retired: boolean; binding: ConductorRecoveryBinding };
    expect(privateGrant.retired).toBe(true); expect(privateGrant.binding.peer).toBe("codex");
    expect(() => authorizeConductorRecovery(project.stateDir, privateGrant.binding, () => true)).toThrow("conductor recovery authority unavailable");
    expect(existsSync(unexpected)).toBe(false);
    await stopTarget();
  } finally {
    const failures: unknown[] = [], safely = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { failures.push(error); } };
    await safely(async () => { if (cli && cli.exitCode === null) { cli.kill("SIGTERM"); await cli.exited; } });
    try { operationId ??= recoveryLock(home, root); } catch (error) { failures.push(error); }
    await safely(async () => { if (operationId && recoveryRunner(operationId, home) !== undefined) expect(await stopSignedRunner(operationId, home)).toBe(true); });
    await safely(stopTarget);
    await safely(async () => { await source?.stop(); await sourceRelease; });
    await safely(async () => { if (runner) await until(() => processLiveness(runner!.pid, runner!.signature) === "gone", "no owned runner survives cleanup"); });
    registry.close();
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (!failures.length) rmSync(temporary, { recursive: true, force: true });
    expect(failures.length, "owned restart processes could not all be confirmed stopped; fixture retained").toBe(0);
  }
}, 30_000);
