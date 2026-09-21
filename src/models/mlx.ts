import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer, isIP } from "node:net";
import { Database } from "bun:sqlite";

export type MlxState = "disabled" | "starting" | "ready" | "stopped" | "foreign" | "error";

export interface MlxOptions {
  provider?: "legacy" | "ollama";
  runtimeDir?: string;
  modelPath?: string;
  model?: string;
  sourceModel?: string;
  bin?: string;
  host?: string;
  port?: number;
  maxInputTokens?: number;
  maxConcurrency?: number;
  maxTokens?: number;
  /** Test/runtime injection; the default runs the pinned executable directly. */
  spawn?: typeof spawn;
  health?: (url: string, signal: AbortSignal) => Promise<boolean>;
  processInfo?: (pid: number) => ProcessSignature | undefined;
  contextWindow?: number;
}

export interface MlxStatus {
  state: MlxState;
  url?: string;
  model?: string;
  pid?: number;
  maxInputTokens: number;
  maxConcurrency: number;
  active: number;
  lastError?: string;
  provider?: "legacy" | "ollama";
  modelAvailable?: boolean;
  modelResident?: boolean;
  expiresAt?: string | null;
  contextWindow?: number;
  maxTokens?: number;
}

export interface MlxHandle {
  readonly status: () => MlxStatus;
  readonly url: string;
  readonly model: string;
  readonly acquire: (signal?: AbortSignal) => Promise<() => void>;
  readonly close: () => Promise<void>;
}

interface OwnerRecord {
  schema: 1;
  token: string;
  pid: number;
  bin: string;
  modelPath: string;
  host: string;
  port: number;
  startedAt: number;
  processStart: string;
}

export interface ProcessSignature {
  command: string;
  start: string;
}

const DEFAULT_RUNTIME_DIR = join(homedir(), ".agenthub", "runtimes", "mlx");
const DEFAULT_MODEL_PATH = join(homedir(), ".agenthub", "models", "qwen3-8b-mlx");
const OWNER_FILE = "owner.json";
const GENERATION_DB = "generation-slots.db";

const ownerPath = (runtimeDir: string) => join(runtimeDir, OWNER_FILE);
const generationDbPath = (runtimeDir: string) => join(runtimeDir, GENERATION_DB);

function assertLoopback(host: string): void {
  const value = host.toLowerCase();
  if (value !== "localhost" && value !== "127.0.0.1" && value !== "::1" && !(isIP(value) === 4 && value.startsWith("127."))) {
    throw new Error("MLX host must be loopback");
  }
}

function readOwner(runtimeDir: string): OwnerRecord | undefined {
  if (!existsSync(ownerPath(runtimeDir))) return undefined;
  try {
    const value = JSON.parse(readFileSync(ownerPath(runtimeDir), "utf8")) as Partial<OwnerRecord>;
    if (value.schema !== 1 || typeof value.token !== "string" || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
        typeof value.bin !== "string" || typeof value.modelPath !== "string" || typeof value.host !== "string" ||
        !Number.isInteger(value.port) || typeof value.startedAt !== "number" || typeof value.processStart !== "string") throw new Error("MLX owner record is malformed; inspect it before retrying");
    return value as OwnerRecord;
  } catch (error) { throw new Error(`MLX owner record is unreadable: ${(error as Error).message}`); }
}

function processInfo(pid: number): ProcessSignature | undefined {
  try {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], { encoding: "utf8" });
    if (result.status !== 0) return undefined;
    const line = String(result.stdout).trim();
    const match = /^(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/.exec(line);
    return match ? { start: match[1]!, command: match[2]! } : undefined;
  } catch {
    return undefined;
  }
}

function ownedProcess(owner: OwnerRecord, readInfo = processInfo): boolean {
  const current = readInfo(owner.pid);
  return !!current && current.start === owner.processStart && current.command.includes(owner.bin) && current.command.includes(owner.modelPath);
}

function processAlive(pid: number): boolean | undefined {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined;
  }
}

function acquireStartLock(runtimeDir: string, readInfo: (pid: number) => ProcessSignature | undefined): () => void {
  // A pre-SQLite lock cannot be reclaimed safely by this version. Leave it for
  // explicit inspection instead of allowing two starters to race on the GPU.
  if (existsSync(join(runtimeDir, "start.lock"))) throw new Error("legacy MLX startup lock exists; inspect it before retrying");
  const db = generationDatabase(runtimeDir);
  const self = readInfo(process.pid);
  if (!self) { db.close(); throw new Error("MLX startup owner identity is unavailable"); }
  const token = randomUUID();
  try {
    db.run(`CREATE TABLE IF NOT EXISTS startup_lock (
      slot INTEGER PRIMARY KEY CHECK (slot = 1),
      token TEXT NOT NULL,
      pid INTEGER NOT NULL,
      process_start TEXT NOT NULL
    )`);
    db.transaction(() => {
      const row = db.query("SELECT slot, token, pid, process_start FROM startup_lock WHERE slot = 1").get() as Record<string, unknown> | null;
      if (row) {
        if (row.slot !== 1 || typeof row.token !== "string" || !row.token || !Number.isSafeInteger(row.pid) || (row.pid as number) < 1 ||
            typeof row.process_start !== "string" || !row.process_start) throw new Error("MLX startup lock is malformed; inspect it before retrying");
        const current = readInfo(row.pid as number);
        if (current && current.start === row.process_start) throw new Error("another MLX startup owns the runtime lock");
        if (!current && processAlive(row.pid as number) !== false) throw new Error("MLX startup lock owner cannot be authenticated");
        db.query("DELETE FROM startup_lock WHERE slot = 1 AND token = ? AND pid = ? AND process_start = ?")
          .run(row.token as string, row.pid as number, row.process_start as string);
      }
      db.query("INSERT INTO startup_lock (slot, token, pid, process_start) VALUES (1, ?, ?, ?)").run(token, process.pid, self.start);
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { db.query("DELETE FROM startup_lock WHERE slot = 1 AND token = ? AND pid = ? AND process_start = ?").run(token, process.pid, self.start); }
    finally { db.close(); }
  };
}

function writeOwner(runtimeDir: string, owner: OwnerRecord): void {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const temporary = `${ownerPath(runtimeDir)}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, ownerPath(runtimeDir));
}

interface GenerationOwner {
  slot: number;
  token: string;
  pid: number;
  processStart: string;
}

class GenerationSlotBusy extends Error {}

function generationDatabase(runtimeDir: string): Database {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const db = new Database(generationDbPath(runtimeDir), { create: true });
  try {
    db.run("PRAGMA busy_timeout = 100");
    db.run(`CREATE TABLE IF NOT EXISTS generation_slots (
      slot INTEGER PRIMARY KEY,
      token TEXT NOT NULL,
      pid INTEGER NOT NULL,
      process_start TEXT NOT NULL
    )`);
    return db;
  } catch (error) { db.close(); throw new Error(`MLX generation lock database is unreadable: ${(error as Error).message}`); }
}

function parseGenerationOwner(slot: number, row: Record<string, unknown>): GenerationOwner {
  if (row.slot !== slot || typeof row.token !== "string" || !row.token || !Number.isSafeInteger(row.pid) || (row.pid as number) < 1 ||
      typeof row.process_start !== "string" || !row.process_start) {
    throw new Error("MLX generation owner is malformed; inspect it before retrying");
  }
  return { slot, token: row.token, pid: row.pid as number, processStart: row.process_start };
}

function claimGenerationSlot(db: Database, slot: number, readInfo: (pid: number) => ProcessSignature | undefined): (() => void) | undefined {
  const token = randomUUID();
  const self = readInfo(process.pid);
  if (!self) throw new Error("MLX generation owner identity is unavailable");
  try {
    db.transaction(() => {
      const row = db.query("SELECT slot, token, pid, process_start FROM generation_slots WHERE slot = ?").get(slot) as Record<string, unknown> | null;
      if (row) {
        const owner = parseGenerationOwner(slot, row);
        const current = readInfo(owner.pid);
        if (current && current.start === owner.processStart) throw new GenerationSlotBusy("generation slot is active");
        if (!current && processAlive(owner.pid) !== false) throw new Error("MLX generation owner cannot be authenticated");
        // A different start signature proves PID reuse; a missing process with
        // ESRCH proves the old owner exited. The transaction makes reclamation
        // and replacement one atomic state transition.
        db.query("DELETE FROM generation_slots WHERE slot = ? AND token = ? AND pid = ? AND process_start = ?")
          .run(owner.slot, owner.token, owner.pid, owner.processStart);
      }
      db.query("INSERT INTO generation_slots (slot, token, pid, process_start) VALUES (?, ?, ?, ?)")
        .run(slot, token, process.pid, self.start);
    }).immediate();
  } catch (error) {
    if (error instanceof GenerationSlotBusy) return undefined;
    const message = String((error as Error).message).toLowerCase();
    if (message.includes("database is locked") || message.includes("database is busy")) return undefined;
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      db.query("DELETE FROM generation_slots WHERE slot = ? AND token = ? AND pid = ? AND process_start = ?")
        .run(slot, token, process.pid, self.start);
    } finally { db.close(); }
  };
}

export async function acquireGeneration(runtimeDir: string, maxConcurrency: number, signal?: AbortSignal, readInfo: (pid: number) => ProcessSignature | undefined = processInfo): Promise<() => void> {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) throw new Error("MLX maxConcurrency must be a positive integer");
  if (signal?.aborted) throw new Error("MLX generation acquisition cancelled");
  const deadline = Date.now() + 120_000;
  const db = generationDatabase(runtimeDir);
  try {
    for (;;) {
      for (let slot = 0; slot < maxConcurrency; slot++) {
        const release = claimGenerationSlot(db, slot, readInfo);
        if (release) return release;
      }
      if (signal?.aborted) throw new Error("MLX generation acquisition cancelled");
      if (Date.now() >= deadline) throw new Error("MLX generation is busy");
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          error ? reject(error) : resolve();
        };
        const timer = setTimeout(() => finish(), 50);
        const abort = () => finish(new Error("MLX generation acquisition cancelled"));
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
  } catch (error) {
    db.close();
    throw error;
  }
}

async function waitForExit(owner: OwnerRecord, readInfo: (pid: number) => ProcessSignature | undefined): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (!readInfo(owner.pid) && processAlive(owner.pid) === false) return;
    await Bun.sleep(50);
  }
  throw new Error("MLX process did not terminate after SIGTERM");
}

async function freePort(host: string, requested?: number): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requested ?? 0, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("MLX did not provide a usable loopback port");
  return port;
}

async function defaultHealth(url: string, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`${url}/models`, { signal });
    return response.ok;
  } catch {
    return false;
  }
}

function argsFor(options: Required<Pick<MlxOptions, "modelPath" | "host" | "port">> & { maxConcurrency: number; maxTokens?: number }): string[] {
  return [
    "--model", options.modelPath,
    "--host", options.host,
    "--port", String(options.port),
    "--allowed-origins", `http://${options.host}:${options.port}`,
    "--decode-concurrency", String(options.maxConcurrency),
    "--prompt-concurrency", String(options.maxConcurrency),
    "--chat-template-args", JSON.stringify({ enable_thinking: false }),
    ...(options.maxTokens ? ["--max-tokens", String(options.maxTokens)] : []),
  ];
}

export async function inspectMlx(options: MlxOptions = {}): Promise<MlxStatus> {
  if (options.provider === "ollama") {
    const { inspectOllama } = await import("./ollama.ts");
    return inspectOllama(options);
  }
  const runtimeDir = options.runtimeDir ?? DEFAULT_RUNTIME_DIR;
  const modelPath = options.modelPath ?? DEFAULT_MODEL_PATH;
  const host = options.host ?? "127.0.0.1";
  const maxInputTokens = options.maxInputTokens ?? 16_000;
  const maxConcurrency = options.maxConcurrency ?? 1;
  assertLoopback(host);
  const owner = readOwner(runtimeDir);
  if (!owner) return { state: "stopped", model: modelPath, maxInputTokens, maxConcurrency, active: 0 };
  const current = (options.processInfo ?? processInfo)(owner.pid);
  if (!ownedProcess(owner, options.processInfo ?? processInfo)) {
    if (current || processAlive(owner.pid) !== false) return { state: "foreign", url: `http://${host}:${owner.port}/v1`, model: owner.modelPath, pid: owner.pid, maxInputTokens, maxConcurrency, active: 0, lastError: "runtime record does not match the live process" };
    return { state: "stopped", model: owner.modelPath, maxInputTokens, maxConcurrency, active: 0 };
  }
  const url = `http://${owner.host}:${owner.port}/v1`;
  const healthy = await (options.health ?? defaultHealth)(url, AbortSignal.timeout(1_000));
  return { state: healthy ? "ready" : "starting", url, model: owner.modelPath, pid: owner.pid, maxInputTokens, maxConcurrency, active: 0 };
}

export async function ensureMlx(options: MlxOptions = {}): Promise<MlxHandle> {
  if (options.provider === "ollama") {
    const { ensureOllama } = await import("./ollama.ts");
    return ensureOllama(options);
  }
  const runtimeDir = options.runtimeDir ?? DEFAULT_RUNTIME_DIR;
  const modelPath = options.modelPath ?? DEFAULT_MODEL_PATH;
  const bin = options.bin ?? join(runtimeDir, "bin", "mlx_lm.server");
  const host = options.host ?? "127.0.0.1";
  const maxInputTokens = options.maxInputTokens ?? 16_000;
  const maxConcurrency = options.maxConcurrency ?? 1;
  const readInfo = options.processInfo ?? processInfo;
  assertLoopback(host);
  const health = options.health ?? defaultHealth;
  const existing = await inspectMlx(options);
  const existingOwner = readOwner(runtimeDir);
  if (existingOwner && (existingOwner.modelPath !== modelPath || existingOwner.host !== host || (options.port !== undefined && existingOwner.port !== options.port) || existingOwner.bin !== bin)) {
    throw new Error("MLX runtime is already owned with different host, port, binary or model settings");
  }
  const sharedHandle = (status: MlxStatus): MlxHandle => {
    let active = 0;
    return { url: status.url!, model: modelPath, status: () => ({ ...status, active }), acquire: async (signal) => {
      const releaseSlot = await acquireGeneration(runtimeDir, maxConcurrency, signal, readInfo);
      active++;
      return () => { active = Math.max(0, active - 1); releaseSlot(); };
    }, close: async () => {} };
  };
  if (existing.state === "ready" && existing.url && existing.model === modelPath) return sharedHandle(existing);
  if (existing.state === "starting" && existing.url && existing.model === modelPath) {
    for (let i = 0; i < 100; i++) {
      if (await health(existing.url, AbortSignal.timeout(500))) return sharedHandle({ ...existing, state: "ready" });
      await Bun.sleep(100);
    }
    throw new Error("existing MLX runtime did not become healthy within 10 seconds");
  }
  if (existing.state === "foreign") throw new Error("MLX endpoint is owned by an unknown process; refusing to kill or reuse it");
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const releaseStartLock = acquireStartLock(runtimeDir, readInfo);
  let child: ChildProcess | undefined;
  let startupError: Error | undefined;
  try {
    const port = await freePort(host, options.port);
    const token = randomUUID();
    const ownerBase: Omit<OwnerRecord, "pid" | "processStart"> = { schema: 1, token, bin, modelPath, host, port, startedAt: Date.now() };
    const spawnProcess = options.spawn ?? spawn;
    const logFd = openSync(join(runtimeDir, "mlx.log"), "a");
    try {
      child = spawnProcess(bin, argsFor({ modelPath, host, port, maxConcurrency, maxTokens: options.maxTokens }), {
        cwd: runtimeDir,
        env: { PATH: process.env.PATH ?? "", HOME: homedir() },
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
      child.once?.("error", (error) => { startupError = error; });
    } finally { closeSync(logFd); }
    if (!child.pid) throw new Error("MLX process did not provide a PID");
    const signature = readInfo(child.pid);
    if (!signature) throw new Error("could not verify MLX process ownership");
    const owner: OwnerRecord = { ...ownerBase, pid: child.pid, processStart: signature.start };
    writeOwner(runtimeDir, owner);
    const url = `http://${host}:${port}/v1`;
    for (let i = 0; i < 100; i++) {
      if (startupError) throw startupError;
      if (child.exitCode != null || child.signalCode != null) throw new Error("MLX exited before becoming healthy; inspect mlx.log");
      if (await health(url, AbortSignal.timeout(500))) {
        child.unref?.();
        let active = 0;
        // The server is machine-shared. Relay shutdown releases this process's handle;
        // only the explicit stopMlx operation may stop the owned runtime.
        const close = async () => {};
        return { url, model: modelPath, status: () => ({ state: "ready", url, model: modelPath, pid: child?.pid, maxInputTokens, maxConcurrency, active }), acquire: async (signal) => {
          const releaseSlot = await acquireGeneration(runtimeDir, maxConcurrency, signal, readInfo);
          active++;
          return () => { active = Math.max(0, active - 1); releaseSlot(); };
        }, close };
      }
      await Bun.sleep(100);
    }
    throw new Error("MLX did not become healthy within 10 seconds");
  } catch (error) {
    try { child?.kill("SIGTERM"); } catch { /* best effort for our child only */ }
    rmSync(ownerPath(runtimeDir), { force: true });
    throw error;
  } finally { releaseStartLock(); }
}

export async function stopMlx(options: MlxOptions = {}): Promise<void> {
  if (options.provider === "ollama") {
    const { stopOllama } = await import("./ollama.ts");
    return stopOllama(options);
  }
  const runtimeDir = options.runtimeDir ?? DEFAULT_RUNTIME_DIR;
  const owner = readOwner(runtimeDir);
  if (!owner) return;
  if (!ownedProcess(owner, options.processInfo ?? processInfo)) {
    if ((options.processInfo ?? processInfo)(owner.pid) || processAlive(owner.pid) !== false) throw new Error("MLX owner record does not match the live process; refusing to kill it");
    rmSync(ownerPath(runtimeDir), { force: true });
    return;
  }
  process.kill(owner.pid, "SIGTERM");
  await waitForExit(owner, options.processInfo ?? processInfo);
  rmSync(ownerPath(runtimeDir), { force: true });
}
