import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ControlClient, PROTOCOL } from "./control-client.ts";
import { Registry, type Project } from "./registry.ts";
import { hubHome } from "./project.ts";
import { startDashboard } from "./ui.ts";
import { projectChain } from "../memory/recall.ts";
import type { ProjectInspection } from "./lifecycle.ts";

export type ProjectRecord = Project;
export type Lifecycle = {
  inspectProject(project: Project): Promise<ProjectInspection>;
  startProject(project: Project, options?: { unattended?: boolean; env?: NodeJS.ProcessEnv }): Promise<any>;
  stopProject(project: Project, expectedInstance?: string): Promise<void>;
};
export type ManagerOptions = { registry?: Registry; lifecycle?: Lifecycle; home?: string; cli?: string };
type ManagerHandle = { stop(): Promise<void>; stopped: Promise<void> };
type Manifest = { port: number; protocol: number; instanceId: string; pid: number };
const active = new Map<string, { handle: ManagerHandle; issue(): string }>();
const CONTROL_TIMEOUT = 3000;
const SUPPORTED_MANAGER_PROTOCOLS = new Set([8, PROTOCOL]);
const safeError = (error: unknown) => error instanceof Error ? error.message.slice(0, 300) : "operation failed";

function files(home: string) {
  const dir = join(home, "manager");
  return { dir, token: join(dir, "control-token"), status: join(dir, "status.json"), owner: join(dir, "owner.db") };
}
function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of ["AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_UNATTENDED", "AGENTHUB_OMNIROUTE_URL", "OMNIROUTE_API_KEY"]) delete out[key];
  return out;
}
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("completion was not confirmed; refresh before retrying")), ms);
  })]); } finally { clearTimeout(timer); }
}
function alive(pid: number): boolean | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined; }
}
function claimOwner(path: string, instanceId: string): Database {
  const db = new Database(path, { create: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.run("CREATE TABLE IF NOT EXISTS owner (slot INTEGER PRIMARY KEY CHECK (slot = 1), instance_id TEXT NOT NULL, pid INTEGER NOT NULL)");
    db.transaction(() => {
      const row = db.query("SELECT pid FROM owner WHERE slot = 1").get() as { pid: number } | null;
      if (row && alive(row.pid) !== false) throw new Error("manager has a live or uncertain owner");
      db.query("INSERT OR REPLACE INTO owner (slot, instance_id, pid) VALUES (1, ?, ?)").run(instanceId, process.pid);
    }).immediate();
    return db;
  } catch (error) { db.close(); throw error; }
}
function readManifest(home: string): Manifest | undefined {
  try {
    const status = JSON.parse(readFileSync(files(home).status, "utf8"));
    if (!Number.isInteger(status.port) || status.port < 1 || status.port > 65535 || typeof status.instanceId !== "string") return undefined;
    return status;
  } catch { return undefined; }
}
function removeManifest(home: string, instanceId: string) {
  if (readManifest(home)?.instanceId !== instanceId) return;
  rmSync(files(home).status, { force: true });
  rmSync(files(home).token, { force: true });
}

export async function startManager(options: ManagerOptions = {}): Promise<ManagerHandle> {
  const home = options.home ?? hubHome();
  const existing = active.get(home);
  if (existing) return existing.handle;
  if (!options.lifecycle) throw new Error("manager lifecycle is not configured");
  const lifecycle = options.lifecycle;
  const registry = options.registry ?? new Registry(join(home, "registry.db"));
  const ownsRegistry = !options.registry;
  const f = files(home);
  mkdirSync(f.dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex"), instanceId = randomUUID();
  let owner: Database | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let dashboard: ReturnType<typeof startDashboard> | undefined;
  let stopping = false;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  const cleanup = () => {
    dashboard?.stop(); server?.stop(true);
    active.delete(home);
    removeManifest(home, instanceId);
    if (owner) {
      owner.query("DELETE FROM owner WHERE slot = 1 AND instance_id = ? AND pid = ?").run(instanceId, process.pid);
      owner.close(); owner = undefined;
    }
    if (ownsRegistry) registry.close();
  };
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    cleanup(); resolveStopped();
  };
  try {
    owner = claimOwner(f.owner, instanceId);
    const aliases = new Map<string, { at: number; names: string[] }>();
    const list = async () => {
      const projects = registry.list();
      for (const p of projects) if (!aliases.has(p.id) || Date.now() - aliases.get(p.id)!.at > 60_000) {
        aliases.set(p.id, { at: Date.now(), names: existsSync(p.root) ? projectChain(p.root) : [] });
      }
      const rows = await Promise.all(projects.map(async (project) => {
        let result: ProjectInspection;
        try { result = await bounded(lifecycle.inspectProject(project), 7000); }
        catch (error) { result = { state: "unavailable", error: safeError(error) }; }
        const names = aliases.get(project.id)!.names;
        const shared = projects.some((other) => other.id !== project.id && aliases.get(other.id)!.names.some((name) => names.includes(name)));
        return { id: project.id, root: project.root, state: result.state,
          instanceId: result.state === "running" ? result.status?.instanceId ?? null : null,
          peers: result.status?.peers ?? {}, tasks: result.status?.tasks ?? {},
          ...(shared ? { warning: "Native memory aliases are shared with another registered project." } : {}),
          ...(result.error ? { error: result.error } : {}) };
      }));
      return { ok: true, mode: "all", projects: rows };
    };
    const act = async (input: Record<string, unknown>) => {
      if (stopping) return { ok: false, error: "manager is stopping" };
      const project = typeof input.projectId === "string" ? registry.get(input.projectId) : undefined;
      if (!project) return { ok: false, error: "unknown project" };
      let client: ControlClient | undefined;
      try {
        if (input.action === "start") {
          const status = await bounded(lifecycle.startProject(project, { unattended: false, env: { ...scrubEnv(process.env), AGENTHUB_HOME: home } }), 20_000);
          return { ok: true, projectId: project.id, instanceId: status.instanceId };
        }
        if (typeof input.instanceId !== "string" || !input.instanceId) return { ok: false, error: "expected daemon instance is required" };
        if (input.action === "stop") {
          await bounded(lifecycle.stopProject(project, input.instanceId), 20_000);
          return { ok: true };
        }
        if (!["snapshot", "send", "pause", "resume", "permit", "propose", "assign"].includes(String(input.action))) return { ok: false, error: "invalid dashboard action" };
        client = await ControlClient.connect(project.stateDir, { role: "console", projectId: project.id, projectRoot: project.root, instanceId: input.instanceId });
        return await client.request(input.action === "snapshot"
          ? { t: "ui_snapshot", after: input.after ?? 0 }
          : { t: "ui_action", action: input, instanceId: input.instanceId }, 10_000);
      } catch (error) { return { ok: false, error: safeError(error) }; }
      finally { client?.close(); }
    };
    dashboard = startDashboard({ projects: list, snapshot: (after, input = {}) => act({ ...input, action: "snapshot", after }), action: act });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 1024,
      fetch(req) {
        if (req.headers.has("origin")) return new Response("forbidden", { status: 403 });
        if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response("unauthorized", { status: 401 });
        if (req.method !== "POST") return new Response("POST required", { status: 405 });
        const expected = req.headers.get("x-agenthub-instance");
        if (expected && expected !== instanceId) return Response.json({ ok: false, error: "manager instance changed" }, { status: 409 });
        if (stopping) return Response.json({ ok: false, error: "manager is stopping" }, { status: 409 });
        const path = new URL(req.url).pathname;
        if (path === "/open") return Response.json({ ok: true, instanceId, protocol: PROTOCOL, url: dashboard!.issue() });
        if (path === "/stop") { setTimeout(() => void stop(), 0); return Response.json({ ok: true, instanceId }); }
        return new Response("not found", { status: 404 });
      },
    });
    writeFileSync(f.token, token, { mode: 0o600 });
    chmodSync(f.token, 0o600);
    const temp = `${f.status}.${instanceId}.tmp`;
    writeFileSync(temp, JSON.stringify({ port: server.port, protocol: PROTOCOL, instanceId, pid: process.pid }));
    renameSync(temp, f.status);
    const handle = { stop, stopped };
    active.set(home, { handle, issue: () => dashboard!.issue() });
    return handle;
  } catch (error) { cleanup(); throw error; }
}

async function managerRequest(home: string, path: "/open" | "/stop"): Promise<{ status: Manifest; body: any }> {
  const status = readManifest(home);
  if (!status) throw new Error("manager manifest is unavailable");
  if (!SUPPORTED_MANAGER_PROTOCOLS.has(status.protocol)) throw new Error("manager protocol is incompatible; use its matching CLI to stop it");
  const token = readFileSync(files(home).token, "utf8").trim();
  if (!token) throw new Error("manager token is unavailable");
  const response = await fetch(`http://127.0.0.1:${status.port}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "x-agenthub-instance": status.instanceId }, signal: AbortSignal.timeout(CONTROL_TIMEOUT),
  });
  if (!response.ok) throw new Error(`manager refused request (${response.status}); ownership was not verified`);
  const body = await response.json() as { ok?: boolean; instanceId?: string; url?: string };
  if (!body.ok || body.instanceId !== status.instanceId) throw new Error("manager identity changed; refresh before retrying");
  return { status, body };
}

export async function openManager(options: ManagerOptions = {}): Promise<string> {
  const home = options.home ?? hubHome();
  const local = active.get(home);
  if (local) return local.issue();
  try { return (await managerRequest(home, "/open")).body.url; }
  catch (error) {
    const old = readManifest(home);
    if (old && alive(old.pid) !== false) throw error;
    // A definitely dead manager can be recovered by its ownership claim.
  }
  const f = files(home);
  mkdirSync(f.dir, { recursive: true, mode: 0o700 });
  const log = openSync(join(f.dir, "manager.log"), "a");
  try {
    const proc = spawn(process.execPath, [options.cli ?? join(import.meta.dir, "../cli/main.ts"), "manager"], {
      cwd: home, detached: true, stdio: ["ignore", log, log], env: { ...scrubEnv(process.env), AGENTHUB_HOME: home },
    });
    proc.on("error", () => {}); proc.unref();
  } finally { closeSync(log); }
  const deadline = Date.now() + 8000;
  let error: unknown;
  while (Date.now() < deadline) {
    try { return (await managerRequest(home, "/open")).body.url; }
    catch (caught) { error = caught; await Bun.sleep(100); }
  }
  throw new Error(`manager readiness not confirmed: ${safeError(error)}; see ${join(f.dir, "manager.log")}`);
}

/** Refresh an explicitly supported protocol-8 manager onto the current CLI after upgrade. */
export async function refreshManager(options: ManagerOptions = {}): Promise<string> {
  const home = options.home ?? hubHome();
  const manifest = readManifest(home);
  if (manifest && manifest.protocol === 8) {
    await managerRequest(home, "/stop");
    const deadline = Date.now() + CONTROL_TIMEOUT;
    while (Date.now() < deadline && readManifest(home)) await Bun.sleep(25);
    if (readManifest(home)) throw new Error("legacy manager shutdown is still pending; refresh was not confirmed");
  }
  return openManager(options);
}

export async function stopManager(options: ManagerOptions = {}): Promise<void> {
  const home = options.home ?? hubHome();
  const local = active.get(home);
  if (local) return local.handle.stop();
  if (!existsSync(files(home).status)) return;
  const { status } = await managerRequest(home, "/stop");
  const deadline = Date.now() + CONTROL_TIMEOUT;
  while (Date.now() < deadline) {
    const current = readManifest(home);
    if (!current) return;
    if (current.instanceId !== status.instanceId) throw new Error("a new manager instance started; it was not stopped");
    await Bun.sleep(25);
  }
  throw new Error("manager shutdown is still pending; project hubs were not changed");
}
