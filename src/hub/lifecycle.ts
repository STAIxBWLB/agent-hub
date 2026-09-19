import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { ControlClient, PROTOCOL, readControl } from "./control-client.ts";
import { startDaemon } from "./daemon.ts";
import { Registry, type Project } from "./registry.ts";
import { CODEX_APP, CODEX_PROXY, CONTROL, SWITCHYARD } from "./ports.ts";
import { assertLifecycleAvailable } from "./recovery-store.ts";

export type ProjectInspection = {
  state: "running" | "stopped" | "stopping" | "unavailable" | "incompatible" | "missing" | "starting";
  status?: any;
  error?: string;
};

function processAlive(pid: unknown): boolean | undefined {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined; }
}

/** A port or PID alone is never evidence that the selected project's hub is alive. */
export async function inspectProject(project: Project): Promise<ProjectInspection> {
  if (!existsSync(project.root)) return { state: "missing", error: "project directory is missing" };
  const control = readControl(project.stateDir);
  if (control) {
    if (processAlive(control.pid) === false) return { state: "stopped" };
    if (control.protocol !== undefined && control.protocol !== PROTOCOL) {
      return { state: "incompatible", error: `hub protocol ${control.protocol}; stop with its matching CLI before upgrading` };
    }
    if ((control.projectId && control.projectId !== project.id) || control.cwd !== project.root) {
      return { state: "unavailable", error: "state directory belongs to a different project" };
    }
    let client: ControlClient | undefined;
    try {
      // Older manifests omit identity. Authenticate first, then require the full current contract.
      client = await ControlClient.connect(project.stateDir, { role: "console", projectRoot: project.root,
        ...(control.projectId ? { projectId: project.id } : {}), ...(control.instanceId ? { instanceId: control.instanceId } : {}) });
      const response = await client.request({ t: "status" }, 3000);
      if (!response.status || response.status.projectId !== project.id || !response.status.instanceId || response.status.cwd !== project.root) {
        return { state: "unavailable", error: "authenticated hub identity does not match registration" };
      }
      if (project.instanceId && project.instanceId !== response.status.instanceId && processAlive(project.pid) !== false) {
        return { state: "unavailable", error: "daemon instance differs from the registry claim" };
      }
      return response.status.stopping
        ? { state: "stopping", status: response.status, error: "hub shutdown is pending; wait before starting it again" }
        : { state: "running", status: response.status };
    } catch (error) {
      return { state: (error as { code?: number }).code === 4426 ? "incompatible" : "unavailable", error: (error as Error).message };
    } finally { client?.close(); }
  }
  if (project.instanceId && processAlive(project.pid) !== false) return { state: "starting", error: "daemon owns a startup or shutdown claim" };
  try {
    const pid = Number(readFileSync(join(project.stateDir, "hub.pid"), "utf8").trim());
    if (processAlive(pid) !== false) return { state: "unavailable", error: "state has a live or uncertain owner but no usable control connection" };
  } catch { /* no legacy PID file */ }
  return { state: "stopped" };
}

/** Probe the full stride's used ports before publishing a daemon; close only our own probes. */
async function available(base: number): Promise<boolean> {
  const servers: Server[] = [];
  try {
    for (const offset of [CONTROL, CODEX_APP, CODEX_PROXY, SWITCHYARD]) {
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

/** Called only in the detached daemon process. A competing starter exits without touching state. */
export async function runProjectDaemon(project: Project, unattended = false): Promise<void> {
  assertLifecycleAvailable();
  const registry = new Registry();
  const instanceId = randomUUID();
  let claimed = false;
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    const before = await inspectProject(registry.get(project.id) ?? project);
    if (before.state === "running" || before.state === "starting") return;
    if (before.state !== "stopped") throw new Error(before.error ?? before.state);
    claimed = registry.claim(project.id, instanceId, process.pid);
    if (!claimed) return;
    let base = registry.get(project.id)!.basePort;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await available(base)) {
        try {
          daemon = await startDaemon({ cwd: project.root, stateDir: project.stateDir, projectId: project.id, instanceId,
            controlPort: base + CONTROL, codexAppPort: base + CODEX_APP, codexProxyPort: base + CODEX_PROXY,
            switchyardPort: base + SWITCHYARD, unattended });
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
        }
      }
      base = registry.reallocate(project.id, instanceId);
    }
    if (!daemon) throw new Error("no free hub port range after 100 attempts");
    const stop = () => { void daemon!.stop().catch((error) => console.error(`shutdown incomplete: ${(error as Error).message}`)); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try { await daemon.stopped; }
    finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
  } finally {
    if (claimed) registry.release(project.id, instanceId);
    registry.close();
  }
}

export async function startProject(project: Project, options: { unattended?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<any> {
  assertLifecycleAvailable();
  const registry = new Registry();
  try {
    const current = registry.get(project.id);
    if (!current || current.root !== project.root || current.stateDir !== project.stateDir) throw new Error("project registration changed; refresh before starting");
    const before = await inspectProject(current);
    if (before.state === "running") return before.status;
    if (before.state !== "stopped" && before.state !== "starting") throw new Error(before.error ?? before.state);
    if (!existsSync(join(project.root, ".agenthub", "config.json"))) throw new Error("project is not initialized; run ahub init there first");
    if (before.state === "stopped") {
      mkdirSync(project.stateDir, { recursive: true });
      const marker = join(project.stateDir, "project.json");
      const temporary = `${marker}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ root: project.root, projectId: project.id }), { mode: 0o600 });
      renameSync(temporary, marker);
      const log = openSync(join(project.stateDir, "hub.log"), "a");
      try {
        const child = spawn(process.execPath, [join(import.meta.dir, "../cli/main.ts"), "--project", project.root, "daemon",
          ...(options.unattended ? ["--unattended"] : [])], {
          cwd: project.root, detached: true, stdio: ["ignore", log, log],
          env: { ...(options.env ?? process.env), AGENTHUB_STATE_DIR: project.stateDir, AGENTHUB_PROJECT_DIR: project.root,
            AGENTHUB_UNATTENDED: options.unattended ? "1" : "0" },
        });
        child.on("error", () => {}); // bounded readiness below reports failure with the project's log path
        child.unref();
      } finally { closeSync(log); }
    }
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const observed = await inspectProject(registry.get(project.id) ?? project);
      if (observed.state === "running") return observed.status;
      if (observed.state === "incompatible" || observed.state === "missing") throw new Error(observed.error ?? observed.state);
      await Bun.sleep(100);
    }
    throw new Error(`hub readiness not confirmed; inspect ${join(project.stateDir, "hub.log")} before retrying`);
  } finally { registry.close(); }
}

export async function stopProject(project: Project, expectedInstance?: string): Promise<void> {
  assertLifecycleAvailable();
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
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = readControl(project.stateDir);
    if (!current) return; // daemon removes its manifest only after owned children stop
    if (current.instanceId !== instanceId) throw new Error("a new hub instance started; it was not stopped");
    await Bun.sleep(100);
  }
  throw new Error("shutdown is still pending; state and ownership were retained");
}
