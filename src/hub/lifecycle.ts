import { resolveProjectRuntime, recordProjectRuntime, confirmProjectRuntime, projectRuntimeRefusal, type ProjectRuntimeSelection } from "./project-runtime.ts";
import { pruneRuntimeCaptures } from "./runtime-capture-prune.ts";
import { isDatabaseBusyReply, RecoveryDatabaseBusy } from "./recovery-error.ts";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:net";
import { ControlClient, PROTOCOL, PROTOCOL_MIN, controlProtocolWindow, readControl } from "./control-client.ts";
import { negotiateProtocol, protocolWindow } from "./protocol-window.ts";
import { assertHubDbCompatible } from "./db-schema.ts";
import { verifyPackage, verifyRecoveryTarget } from "../cli/recovery-package.ts";
import { VERSION } from "../version.ts";
import { startDaemon } from "./daemon.ts";
import { terminalOpener } from "./terminal-open.ts";
import { Registry, type Project } from "./registry.ts";
import { CODEX_APP, CODEX_PROXY, CONTROL } from "./ports.ts";
import { assertLifecycleAvailable, readOperation, recoveryLock } from "./recovery-store.ts";
import { realPath } from "./project.ts";
import { processLiveness, processSignature } from "../pi/process-signature.ts";

export type ProjectInspection = {
  failure?: { code: "database_busy" };
  state: "running" | "stopped" | "stopping" | "unavailable" | "incompatible" | "missing" | "starting";
  status?: any;
  error?: string;
};

/** A port or PID alone is never evidence that the selected project's hub is alive. */
export async function inspectProject(project: Project, timeoutMs = 3000, readerPeer?: string): Promise<ProjectInspection> {
  if (!existsSync(project.root)) return { state: "missing", error: "project directory is missing" };
  const control = readControl(project.stateDir);
  if (control) {
    if (processLiveness(control.pid, control.pidSignature) === "gone") return { state: "stopped" };
    const advertised = controlProtocolWindow(control);
    if ((control.protocol !== undefined || control.protocolMin !== undefined || control.protocolMax !== undefined)
      && (!advertised || negotiateProtocol(protocolWindow(PROTOCOL, PROTOCOL_MIN)!, advertised) === undefined)) {
      return { state: "incompatible", error: `hub protocol ${control.protocol}; stop with its matching CLI before upgrading` };
    }
    if ((control.projectId && control.projectId !== project.id) || control.cwd !== project.root) {
      return { state: "unavailable", error: "state directory belongs to a different project" };
    }
    let client: ControlClient | undefined;
    try {
      // Older manifests omit identity. Authenticate first, then require the full current contract.
      client = await ControlClient.connect(project.stateDir, { ...(readerPeer ? { role: "tools" as const, peer: readerPeer } : { role: "console" as const }), projectRoot: project.root,
        ...(control.projectId ? { projectId: project.id } : {}), ...(control.instanceId ? { instanceId: control.instanceId } : {}) }, timeoutMs);
      const response = await client.request({ t: "status" }, timeoutMs);
      if (isDatabaseBusyReply(response)) return { state: "unavailable", error: new RecoveryDatabaseBusy().message, failure: { code: "database_busy" } };
      if (!response.status || response.status.projectId !== project.id || !response.status.instanceId || response.status.cwd !== project.root) {
        return { state: "unavailable", error: "authenticated hub identity does not match registration" };
      }
      if (project.instanceId && project.instanceId !== response.status.instanceId && processLiveness(project.pid, project.pidSignature) !== "gone") {
        return { state: "unavailable", error: "daemon instance differs from the registry claim" };
      }
      return response.status.stopping
        ? { state: "stopping", status: response.status, error: "hub shutdown is pending; wait before starting it again" }
        : { state: "running", status: response.status };
    } catch (error) {
      return { state: (error as { code?: number }).code === 4426 ? "incompatible" : "unavailable", error: (error as Error).message };
    } finally { client?.close(); }
  }
  if (project.instanceId && processLiveness(project.pid, project.pidSignature) !== "gone") return { state: "starting", error: "daemon owns a startup or shutdown claim" };
  try {
    // Written only by daemons up to 0.12.20 (#226): an unsigned legacy record, read as those releases read it.
    const pid = Number(readFileSync(join(project.stateDir, "hub.pid"), "utf8").trim());
    if (processLiveness(pid) !== "gone") return { state: "unavailable", error: "state has a live or uncertain owner but no usable control connection" };
  } catch { /* no legacy PID file */ }
  return { state: "stopped" };
}

/** Probe the full stride's used ports before publishing a daemon; close only our own probes. */
async function available(base: number): Promise<boolean> {
  const servers: Server[] = [];
  try {
    for (const offset of [CONTROL, CODEX_APP, CODEX_PROXY]) {
      const server = createServer();
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(base + offset, "127.0.0.1", () => resolve());
      });
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return false;
    throw error;
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    })));
  }
}

/** The signals the project daemon stops on (see `runProjectDaemon`). */
export const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;

function startupRuntime(project: Project, env: NodeJS.ProcessEnv, registry: Registry) {
  const sourceRoot = resolve(import.meta.dir, "../.."), id = env.AGENTHUB_RECOVERY_OPERATION;
  if (id && recoveryLock(undefined, project.root) === id) {
    const op = readOperation<{ targetRoot?: string; targetDigest?: string; plan: { kind: "restart" | "upgrade"; version: string; projects: { project: Project }[] } }>(id);
    if (!op.targetRoot || !op.targetDigest || op.plan.version !== VERSION || realPath(op.targetRoot) !== realPath(sourceRoot)
      || !op.plan.projects.some(row => row.project.id === project.id && row.project.root === project.root && row.project.stateDir === project.stateDir))
      throw new Error("recovery startup does not match its retained target runtime");
    // Authority binds this exact target path. Do not re-stage it at a different, byte-identical path.
    return { root: sourceRoot, digest: op.targetDigest, version: VERSION, kind: op.plan.kind, check: () => verifyRecoveryTarget(op.plan.kind, sourceRoot, VERSION) };
  }
  const retained = resolveProjectRuntime(project, VERSION, sourceRoot, registry);
  return { ...retained, check: () => verifyRecoveryTarget(retained.kind, retained.root, retained.version) };
}

/** Called only in the detached daemon process. A competing starter exits without touching state. */
export async function runProjectDaemon(project: Project, unattended = false): Promise<void> {
  assertLifecycleAvailable(project.root);
  assertHubDbCompatible(join(project.stateDir, "hub.db"));
  const registry = new Registry();
  const instanceId = randomUUID();
  let claimed = false;
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  // ponytail: shutdown is bounded as a whole, not per peer; a peer whose stop never settles
  // escapes only through this process-level deadline (issue #56). 15 s leaves the amem
  // SessionEnd capture row each peer's stop() awaits (`Capture.end`) its chance. Upgrade path: per-peer stop deadlines.
  const SHUTDOWN_DEADLINE_MS = 15_000;
  let forcedExit: ReturnType<typeof setTimeout> | undefined;
  const onShutdownStart = () => {
    if (forcedExit) return;
    forcedExit = setTimeout(() => {
      console.error(`hub shutdown did not finish within ${SHUTDOWN_DEADLINE_MS / 1000} s; exiting anyway`);
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    forcedExit.unref();
  };
  try {
    const before = await inspectProject(registry.get(project.id) ?? project);
    if (before.state === "running" || before.state === "starting") return;
    if (before.state !== "stopped") throw new Error(before.error ?? before.state);
    claimed = registry.claim(project.id, instanceId, process.pid, processSignature(process.pid));
    if (!claimed) return;
    registry.runtimeCaptureLocked(() => {
      const runtime = startupRuntime(project, process.env, registry);
      // Direct internal daemon entry must not bypass the selected runtime. Normal up already spawned its verified capture.
      if (realPath(resolve(import.meta.dir, "../..")) !== runtime.root || verifyPackage(resolve(import.meta.dir, "../.."), VERSION) !== runtime.digest)
        throw projectRuntimeRefusal(runtime.version, "start with ahub up so the recorded runtime is used");
      recordProjectRuntime(project, runtime, instanceId, registry);
    });
    let base = registry.get(project.id)!.basePort;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await available(base)) {
        try {
          daemon = await startDaemon({ cwd: project.root, stateDir: project.stateDir, projectId: project.id, instanceId,
            controlPort: base + CONTROL, codexAppPort: base + CODEX_APP, codexProxyPort: base + CODEX_PROXY,
            unattended, onShutdownStart, agentDrift: true,
            // #269: the real terminal providers belong to the running product; a daemon built without them opens nothing.
            terminal: (template) => terminalOpener({ template, cwd: project.root, stateDir: project.stateDir }) });
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
        }
      }
      base = registry.reallocate(project.id, instanceId);
    }
    if (!daemon) throw new Error("no free hub port range after 100 attempts");
    const stop = () => { void daemon!.stop().catch((error) => console.error(`shutdown incomplete: ${(error as Error).message}`)); };
    // Every signal the hub exits on goes through stop(), never the default action: a default action ends the process with no `exit` event and no stop(), so memory sync's git (which
    // agent-mem 0.7.0 runs in its own process group, stopped only through the daemon's `syncStop` signal) would outlive the hub holding the memory repository. SIGHUP is a closing
    // terminal, SIGQUIT is Ctrl-\; a handler also keeps SIGQUIT from its default core dump (agent-mem #435: Bun honours it, and a core file of the whole image delays the exit).
    for (const name of STOP_SIGNALS) process.on(name, stop);
    try { await daemon.stopped; }
    finally { if (forcedExit) clearTimeout(forcedExit); for (const name of STOP_SIGNALS) process.off(name, stop); }
  } finally {
    if (claimed) registry.release(project.id, instanceId);
    registry.close();
  }
}

export async function startProject(project: Project, options: { unattended?: boolean; env?: NodeJS.ProcessEnv; liveTest?: boolean; current?: () => void } = {}): Promise<any> {
  options.current?.();
  assertLifecycleAvailable(project.root);
  const registry = new Registry();
  try {
    const current = registry.get(project.id);
    if (!current || current.root !== project.root || current.stateDir !== project.stateDir) throw new Error("project registration changed; refresh before starting");
    const before = await inspectProject(current);
    options.current?.();
    if (before.state === "running") return before.status;
    if (before.state !== "stopped" && before.state !== "starting") throw new Error(before.error ?? before.state);
    if (!existsSync(join(project.root, ".agenthub", "config.json"))) throw new Error("project is not initialized; run ahub init there first");
    let launchedRuntime: ProjectRuntimeSelection | undefined;
    if (before.state === "stopped") {
      const launchEnv = { ...(options.env ?? process.env) };
      // Expired operation ids must not make an ordinary startup load a retired snapshot.
      if (launchEnv.AGENTHUB_RECOVERY_OPERATION !== recoveryLock(undefined, project.root)) delete launchEnv.AGENTHUB_RECOVERY_OPERATION;
      registry.runtimeCaptureLocked(() => {
        const claim = registry.get(project.id);
        if (!claim || claim.root !== project.root || claim.stateDir !== project.stateDir) throw new Error("project registration changed; refresh before starting");
        // A competing starter owns readiness now. Never replace its selection or create a second native start.
        if (claim.instanceId && processLiveness(claim.pid, claim.pidSignature) !== "gone") return;
        const runtime = startupRuntime(project, launchEnv, registry);
        options.current?.();
        assertLifecycleAvailable(project.root);
        if (runtime.check() !== runtime.digest) throw new Error("staged startup runtime changed");
        // The selected runtime's own preflight decides schema compatibility; an older invoking CLI cannot preflight for it.
        recordProjectRuntime(project, runtime, null, registry);
        launchedRuntime = runtime;
        mkdirSync(project.stateDir, { recursive: true });
        const marker = join(project.stateDir, "project.json");
        const temporary = `${marker}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify({ root: project.root, projectId: project.id }), { mode: 0o600 });
        renameSync(temporary, marker);
        const log = openSync(join(project.stateDir, "hub.log"), "a");
        try {
          options.current?.();
          const child = spawn(process.execPath, [join(runtime.root, "src/cli/main.ts"), "--project", project.root, ...(options.liveTest ? ["--live-test"] : []), "daemon",
            ...(options.unattended ? ["--unattended"] : [])], {
            cwd: project.root, detached: true, stdio: ["ignore", log, log],
            env: { ...launchEnv, AGENTHUB_STATE_DIR: project.stateDir, AGENTHUB_PROJECT_DIR: project.root,
              AGENTHUB_UNATTENDED: options.unattended ? "1" : "0" },
          });
          child.on("error", () => {}); // bounded readiness below reports failure with the project's log path
          child.unref();
        } finally { closeSync(log); }
      });
    }
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const observed = await inspectProject(registry.get(project.id) ?? project);
      options.current?.();
      if (observed.state === "running") {
        if (launchedRuntime) confirmProjectRuntime(project, launchedRuntime, observed.status, registry);
        // Unknown references defer maintenance; cache cleanup never changes a confirmed startup outcome.
        try { pruneRuntimeCaptures(); } catch { /* retain captures on unreadable inventory or cleanup failure */ }
        return observed.status;
      }
      if (observed.state === "incompatible" || observed.state === "missing") throw new Error(observed.error ?? observed.state);
      await Bun.sleep(100);
    }
    throw new Error(`hub readiness not confirmed; inspect ${join(project.stateDir, "hub.log")} before retrying`);
  } finally { registry.close(); }
}

/** Whether `instanceId` still holds the project's registry claim, counted as held while its process may be alive. */
function claimHeld(id: string, instanceId: string): boolean {
  const registry = new Registry();
  try {
    const row = registry.get(id);
    return row?.instanceId === instanceId && (row.pid === null || processLiveness(row.pid, row.pidSignature) !== "gone");
  } finally { registry.close(); }
}

export async function stopProject(project: Project, expectedInstance?: string): Promise<void> {
  assertLifecycleAvailable(project.root);
  const inspection = await inspectProject(project);
  if (inspection.state === "stopped") return;
  if (inspection.state !== "running" && inspection.state !== "stopping") throw new Error(inspection.error ?? "hub ownership is not verified; not stopping it");
  const instanceId = inspection.status.instanceId as string;
  if (expectedInstance && expectedInstance !== instanceId) throw new Error("hub restarted; refresh before stopping");
  const client = await ControlClient.connect(project.stateDir, { role: "console", projectId: project.id, projectRoot: project.root, instanceId });
  try {
    const result = await client.request({ t: "kill", instanceId }, 3000);
    if (!result.ok) throw new Error(result.error ?? "hub did not acknowledge shutdown");
  } finally { client.close(); }
  await awaitStopped(project, instanceId);
}

/** After a verified stop request: wait until that instance's manifest and registry claim are gone. */
export async function awaitStopped(project: Project, instanceId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = readControl(project.stateDir);
    // The daemon removes its manifest only after owned children stop; its process releases the registry claim just
    // after that. Until then `projects remove` refuses and `up` reads the project as starting, so wait for both.
    if (!current && !claimHeld(project.id, instanceId)) return;
    if (current && current.instanceId !== instanceId) throw new Error("a new hub instance started; it was not stopped");
    await Bun.sleep(100);
  }
  throw new Error("shutdown is still pending; state and ownership were retained");
}
