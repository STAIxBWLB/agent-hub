import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer, isIP } from "node:net";

export type MlxState = "disabled" | "starting" | "ready" | "stopped" | "foreign" | "error";

export interface MlxOptions {
  runtimeDir?: string;
  modelPath?: string;
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

interface ProcessSignature {
  command: string;
  start: string;
}

const DEFAULT_RUNTIME_DIR = join(homedir(), ".agenthub", "runtimes", "mlx");
const DEFAULT_MODEL_PATH = join(homedir(), ".agenthub", "models", "qwen3-8b-mlx");
const DEFAULT_BIN = join(DEFAULT_RUNTIME_DIR, "bin", "mlx_lm.server");
const OWNER_FILE = "owner.json";
const LOCK_DIR = "start.lock";

const ownerPath = (runtimeDir: string) => join(runtimeDir, OWNER_FILE);
const lockPath = (runtimeDir: string) => join(runtimeDir, LOCK_DIR);

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
    if (value.schema !== 1 || typeof value.token !== "string" || !Number.isSafeInteger(value.pid) ||
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

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireStartLock(runtimeDir: string): () => void {
  const path = lockPath(runtimeDir);
  try {
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: process.pid, processStart: processInfo(process.pid)?.start ?? "" }), { mode: 0o600 });
    return () => rmSync(path, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let lock: { pid?: number; processStart?: string };
    try { lock = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")); }
    catch { throw new Error("MLX startup lock is unreadable; inspect it before retrying"); }
    if (!Number.isSafeInteger(lock.pid) || typeof lock.processStart !== "string") throw new Error("MLX startup lock is malformed; inspect it before retrying");
    const pid = lock.pid!;
    const current = processInfo(pid);
    if (current && current.start === lock.processStart) throw new Error("another MLX startup owns the runtime lock");
    if (processAlive(pid)) throw new Error("MLX startup lock owner cannot be authenticated");
    rmSync(path, { recursive: true, force: true });
    return acquireStartLock(runtimeDir);
  }
}

function writeOwner(runtimeDir: string, owner: OwnerRecord): void {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const temporary = `${ownerPath(runtimeDir)}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, ownerPath(runtimeDir));
}

async function acquireGeneration(runtimeDir: string, maxConcurrency: number, signal?: AbortSignal): Promise<() => void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    for (let slot = 0; slot < maxConcurrency; slot++) {
      const path = join(runtimeDir, `generation-${slot}.lock`);
      try {
        mkdirSync(path, { mode: 0o700 });
        const token = randomUUID();
        writeFileSync(join(path, "owner.json"), JSON.stringify({ token, pid: process.pid, processStart: processInfo(process.pid)?.start ?? "" }), { mode: 0o600 });
        return () => {
          try {
            const current = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as { token?: string };
            if (current.token === token) rmSync(path, { recursive: true, force: true });
          } catch { /* another owner or an already released slot */ }
        };
      } catch { /* try another slot */ }
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
}

async function waitForExit(owner: OwnerRecord, readInfo: (pid: number) => ProcessSignature | undefined): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (!readInfo(owner.pid) && !processAlive(owner.pid)) return;
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
    if (current || processAlive(owner.pid)) return { state: "foreign", url: `http://${host}:${owner.port}/v1`, model: owner.modelPath, pid: owner.pid, maxInputTokens, maxConcurrency, active: 0, lastError: "runtime record does not match the live process" };
    return { state: "stopped", model: owner.modelPath, maxInputTokens, maxConcurrency, active: 0 };
  }
  const url = `http://${owner.host}:${owner.port}/v1`;
  const healthy = await (options.health ?? defaultHealth)(url, AbortSignal.timeout(1_000));
  return { state: healthy ? "ready" : "starting", url, model: owner.modelPath, pid: owner.pid, maxInputTokens, maxConcurrency, active: 0 };
}

export async function ensureMlx(options: MlxOptions = {}): Promise<MlxHandle> {
  const runtimeDir = options.runtimeDir ?? DEFAULT_RUNTIME_DIR;
  const modelPath = options.modelPath ?? DEFAULT_MODEL_PATH;
  const bin = options.bin ?? DEFAULT_BIN;
  const host = options.host ?? "127.0.0.1";
  const maxInputTokens = options.maxInputTokens ?? 16_000;
  const maxConcurrency = options.maxConcurrency ?? 1;
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
      const releaseSlot = await acquireGeneration(runtimeDir, maxConcurrency, signal);
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
  const releaseStartLock = acquireStartLock(runtimeDir);
  let child: ChildProcess | undefined;
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
    } finally { closeSync(logFd); }
    if (!child.pid) throw new Error("MLX process did not provide a PID");
    const signature = (options.processInfo ?? processInfo)(child.pid);
    if (!signature) throw new Error("could not verify MLX process ownership");
    const owner: OwnerRecord = { ...ownerBase, pid: child.pid, processStart: signature.start };
    writeOwner(runtimeDir, owner);
    const url = `http://${host}:${port}/v1`;
    for (let i = 0; i < 100; i++) {
      if (await health(url, AbortSignal.timeout(500))) {
        child.unref?.();
        let active = 0;
        // The server is machine-shared. Relay shutdown releases this process's handle;
        // only the explicit stopMlx operation may stop the owned runtime.
        const close = async () => {};
        return { url, model: modelPath, status: () => ({ state: "ready", url, model: modelPath, pid: child?.pid, maxInputTokens, maxConcurrency, active }), acquire: async (signal) => {
          const releaseSlot = await acquireGeneration(runtimeDir, maxConcurrency, signal);
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
  const runtimeDir = options.runtimeDir ?? DEFAULT_RUNTIME_DIR;
  const owner = readOwner(runtimeDir);
  if (!owner) return;
  if (!ownedProcess(owner, options.processInfo ?? processInfo)) {
    if ((options.processInfo ?? processInfo)(owner.pid) || processAlive(owner.pid)) throw new Error("MLX owner record does not match the live process; refusing to kill it");
    rmSync(ownerPath(runtimeDir), { force: true });
    return;
  }
  process.kill(owner.pid, "SIGTERM");
  await waitForExit(owner, options.processInfo ?? processInfo);
  rmSync(ownerPath(runtimeDir), { force: true });
}
