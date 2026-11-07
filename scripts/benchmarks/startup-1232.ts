import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { realPath } from "../../src/hub/project.ts";
import { sbplString } from "../../src/local/deny.ts";
import { hubGitSync } from "../../src/hub/git.ts";
import { stopOwnedProcess, trackGroup } from "../../src/hub/child-process.ts";
import { DEFAULT_MAX_BYTES } from "../../src/hub/usage-rollup.ts";
import { STARTUP_PHASES } from "../../src/hub/startup-timing.ts";

const MAX_PRIVATE_SAMPLES = 3;
const SAMPLE_TIMEOUT_MS = 60_000;
const PUBLIC_PROBE_TIMEOUT_MS = 10_000;
const OUTPUT_BYTES = 64 * 1024;
const COPY_BYTES = 64 * 1024;
const LEDGER_BUSY_TIMEOUT_MS = 3000;
const SCRIPT = fileURLToPath(import.meta.url);
const PROFILE_KEYS = ["dbBytes", "taskRows", "taskHistoryEntries", "taskTextBytes", "deliveryRows", "deliveryPayloadBytes", "eventBytes", "eventLines", "abandonedFiles", "abandonedBytes", "abandonedMaxBytes"] as const;
export type StartupProfile = Record<typeof PROFILE_KEYS[number], number>;
export const REPRESENTATIVE_PROFILE: StartupProfile = { dbBytes: 37_000_000, taskRows: 770, taskHistoryEntries: 7700, taskTextBytes: 2_000_000,
  deliveryRows: 1000, deliveryPayloadBytes: 2_000_000, eventBytes: 130_000_000, eventLines: 500_000, abandonedFiles: 1, abandonedBytes: 17_000_000, abandonedMaxBytes: 17_000_000 };
export interface BenchmarkOptions { mode: "synthetic" | "private"; samples: number; profile?: StartupProfile; privateState?: string; acceptance?: boolean }
export interface ChildObservation { timing: string; wallMs: number; stopped: boolean; effects: number; eventReadBytes: number; abandonedReadBytes: number; seedPasses: number; seedReadBytes: number; eventReadFileCalls: number; usageRollupReadBytes: number; usageRollupCalls: number; importAndStartupMs?: number }
export interface BenchmarkPorts {
  prepare?: (state: string | undefined, destination: string, profile: StartupProfile, env: NodeJS.ProcessEnv) => Promise<StartupProfile>;
  child?: (root: string, env: NodeJS.ProcessEnv) => Promise<ChildObservation>;
  project?: (root: string, env: NodeJS.ProcessEnv) => void;
}

export const BENCHMARK_STAGES = ["input", "mac-guard", "attempt-reserved", "project", "backup", "event-copy", "abandoned-copy", "profile", "child", "effect-guards", "daemon-import", "copy-rebind", "daemon-start", "ready-check", "timing-read", "daemon-stop", "seed", "seed-imports", "seed-board", "seed-journal", "seed-payload", "seed-events", "seed-abandoned", "copy"] as const;
let publicStage: typeof BENCHMARK_STAGES[number] = "input";
export function benchmarkFailureStage(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join() === "failed,stage" && row.failed === 1 && Number.isInteger(row.stage) && Number(row.stage) >= 0 && Number(row.stage) < BENCHMARK_STAGES.length ? Number(row.stage) : undefined;
}
class BenchmarkStageFailure extends Error {
  constructor(readonly stage: number) { super("startup benchmark did not complete; inspect the numeric failure stage before another authorized attempt"); }
}
function publicDebug(enabled: boolean, details: Record<string, unknown>): void {
  if (enabled) process.stderr.write(JSON.stringify({ publicSyntheticDebug: 1, stage: publicStage, ...details }) + "\n");
}
function publicError(error: unknown): Record<string, unknown> {
  return error instanceof Error ? { error: error.message, stack: error.stack, code: (error as Error & { code?: unknown }).code } : { error: "non-Error public fixture failure" };
}

function refuse(): never { throw new Error("startup benchmark refused; review the isolated fixture configuration and numeric profile before retrying"); }
export function numericProfile(value: unknown): StartupProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return refuse();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== [...PROFILE_KEYS].sort().join() || PROFILE_KEYS.some(key => !Number.isSafeInteger(row[key]) || Number(row[key]) < 0 || Number(row[key]) > 2_000_000_000)) return refuse();
  const profile = Object.fromEntries(PROFILE_KEYS.map(key => [key, row[key]])) as StartupProfile;
  if (profile.dbBytes < profile.taskTextBytes + profile.deliveryPayloadBytes
    || profile.dbBytes === 0 && (profile.taskRows > 0 || profile.deliveryRows > 0)
    || profile.taskRows === 0 && (profile.taskHistoryEntries !== 0 || profile.taskTextBytes !== 0)
    || profile.taskTextBytes < profile.taskRows || profile.taskHistoryEntries < profile.taskRows
    || profile.deliveryRows === 0 && profile.deliveryPayloadBytes !== 0
    || profile.deliveryPayloadBytes < 4 * profile.deliveryRows
    || profile.eventLines === 0 && profile.eventBytes !== 0 || profile.eventBytes < profile.eventLines
    || profile.abandonedFiles === 0 && (profile.abandonedBytes !== 0 || profile.abandonedMaxBytes !== 0)
    || profile.abandonedMaxBytes > profile.abandonedBytes || profile.abandonedBytes > profile.abandonedFiles * profile.abandonedMaxBytes
    || profile.abandonedFiles === 1 && profile.abandonedBytes !== profile.abandonedMaxBytes) return refuse();
  return profile;
}
export function isolatedStartupEnvironment(root: string, mode: "synthetic" | "private" = "private"): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { AHUB_STARTUP_BENCHMARK_CHILD: "1", PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC", TERM: "dumb", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  if (mode === "synthetic") env.AHUB_STARTUP_BENCHMARK_PUBLIC_DEBUG = "1";
  for (const name of ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "AGENTHUB_HOME", "AMEM_HOME", "CODEX_HOME", "KIMI_CODE_HOME", "CLAUDE_CONFIG_DIR"]) {
    const folder = join(root, name.toLowerCase()); mkdirSync(folder, { mode: 0o700 }); env[name] = folder;
  }
  return env;
}

/** Only complete records from the original append-only prefix; never follow a source link. */
export function copyEventPrefix(source: string, destination: string): { bytes: number; lines: number } {
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let out: number | undefined;
  try {
    out = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const before = fstatSync(fd); if (!before.isFile() || before.size > 2_000_000_000) return refuse();
    const buffer = Buffer.alloc(COPY_BYTES); let at = 0, complete = 0, lines = 0;
    while (at < before.size) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - at), at); if (!n) return refuse();
      const chunk = buffer.subarray(0, n); writeFileSync(out, chunk);
      for (let i = 0; i < n; i++) if (chunk[i] === 10) { complete = at + i + 1; lines++; }
      at += n;
    }
    const after = fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size < before.size) return refuse();
    truncateSync(destination, complete);
    return { bytes: complete, lines };
  } finally { closeSync(fd); if (out !== undefined) closeSync(out); }
}

/** Numeric-only durable attempts survive copies and failed runs; the CLI always uses one fixed ledger. */
export function reservePrivateAttempt(file: string): number {
  const existing = lstatSync(file, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) return refuse();
  const db = new Database(file, { create: true }); db.run(`PRAGMA busy_timeout = ${LEDGER_BUSY_TIMEOUT_MS}`);
  try {
    chmodSync(file, 0o600);
    db.run("CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 3))");
    return db.transaction(() => {
      const n = Number((db.query("SELECT COALESCE(MAX(id),0)+1 AS n FROM attempts").get() as { n: number }).n);
      if (n > MAX_PRIVATE_SAMPLES) return refuse();
      db.query("INSERT INTO attempts(id) VALUES (?)").run(n); return n;
    }).immediate();
  } finally { db.close(); }
}

export function timingLine(value: unknown): string {
  if (typeof value !== "string") return refuse();
  const keys = [...STARTUP_PHASES, "total"];
  const pairs = value.slice("startup timings ms: ".length).split(" ");
  if (!value.startsWith("startup timings ms: ") || pairs.length !== keys.length || pairs.some((pair, i) => !new RegExp(`^${keys[i]}=\\d+$`).test(pair))) return refuse();
  return value;
}

async function ownedCommand(argv: string[], cwd: string, env: NodeJS.ProcessEnv, input?: string, onLine?: (line: string) => void, timeoutMs = SAMPLE_TIMEOUT_MS): Promise<string> {
  const debug = env.AHUB_STARTUP_BENCHMARK_PUBLIC_DEBUG === "1";
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true, stdio: ["pipe", "pipe", debug ? "pipe" : "ignore"] }); trackGroup(child);
  let stderr = "";
  child.stderr?.on("data", chunk => { if (Buffer.byteLength(stderr) + chunk.length <= OUTPUT_BYTES) stderr += String(chunk); });
  let output = "", pending = "", overflow = false, childFailureStage: number | undefined;
  child.stdout!.on("data", chunk => {
    if (Buffer.byteLength(output) + chunk.length > OUTPUT_BYTES) { overflow = true; return; }
    output += String(chunk); pending += String(chunk);
    while (pending.includes("\n")) {
      const cut = pending.indexOf("\n"), line = pending.slice(0, cut);
      try { childFailureStage = benchmarkFailureStage(JSON.parse(line)) ?? childFailureStage; } catch { /* No unclassified child output becomes a diagnostic. */ }
      onLine?.(line); pending = pending.slice(cut + 1);
    }
  });
  const drained = Promise.all([new Promise<void>(done => child.stdout!.once("end", done)),
    child.stderr ? new Promise<void>(done => child.stderr!.once("end", done)) : Promise.resolve()]);
  const exited = new Promise<number | null>((done, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) done(child.exitCode);
    else { child.once("exit", done); child.once("error", reject); }
  });
  // Attach rejection handling before any teardown can race an early child failure.
  void exited.catch(() => {});
  if (input !== undefined) child.stdin!.end(input); else child.stdin!.end();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("bounded benchmark child did not finish; inspect its numeric stage before retrying")), timeoutMs); })]);
    clearTimeout(timer);
    await Promise.race([drained, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("benchmark output did not settle; retain the fixture and inspect process ownership")), timeoutMs); })]);
    if (code !== 0 || overflow) { publicDebug(debug, { boundary: "command-exit", executable: basename(argv[0]!), exitCode: code, overflow: Number(overflow), stderr }); throw new BenchmarkStageFailure(childFailureStage ?? BENCHMARK_STAGES.indexOf(publicStage)); }
    return output;
  } catch (error) { publicDebug(debug, { boundary: "command-failed", executable: basename(argv[0]!), stderr, ...publicError(error) }); throw error; } finally {
    clearTimeout(timer);
    await stopOwnedProcess(child, { group: true });
  }
}

const BACKUP = `import pathlib,sqlite3,sys
source,dest=sys.argv[1:]
a=sqlite3.connect(pathlib.Path(source).resolve().as_uri()+'?mode=ro',uri=True,timeout=3)
b=sqlite3.connect(dest,timeout=3)
try:
 a.backup(b)
 b.commit()
 assert b.execute('PRAGMA journal_mode=DELETE').fetchone()[0]=='delete'
 b.commit()
finally:b.close();a.close()
`;
export async function backupStartupDatabase(source: string, destination: string, env: NodeJS.ProcessEnv, timeoutMs = SAMPLE_TIMEOUT_MS): Promise<void> {
  publicStage = "backup";
  const python = Bun.which("python3", { PATH: env.PATH }), uid = process.getuid?.(); if (!python || uid === undefined || !env.HOME) return refuse();
  const parent = dirname(destination), directory = lstatSync(parent), root = realPath(dirname(env.HOME)), canonicalParent = realPath(parent);
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077) !== 0 || canonicalParent !== root && !canonicalParent.startsWith(root + "/")) return refuse();
  // The destination is exclusively ours from creation. Never repair/remove another connection's artifacts.
  for (const suffix of ["", "-wal", "-shm", "-journal"]) if (lstatSync(destination + suffix, { throwIfNoEntry: false })) return refuse();
  const created = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let identity: ReturnType<typeof fstatSync>;
  try { identity = fstatSync(created); } finally { closeSync(created); }
  await ownedCommand([python, "-I", "-c", BACKUP, source, destination], parent, env, undefined, undefined, timeoutMs);
  const currentDirectory = lstatSync(parent), current = lstatSync(destination);
  if (currentDirectory.dev !== directory.dev || currentDirectory.ino !== directory.ino || currentDirectory.uid !== uid || (currentDirectory.mode & 0o077) !== 0
    || !current.isFile() || current.nlink !== 1 || current.uid !== uid || current.dev !== identity.dev || current.ino !== identity.ino) return refuse();
  if (lstatSync(destination + "-wal", { throwIfNoEntry: false }) || lstatSync(destination + "-journal", { throwIfNoEntry: false })) return refuse();
  const headerFile = openSync(destination, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const header = Buffer.alloc(2);
    if (readSync(headerFile, header, 0, header.length, 18) !== header.length || header[0] !== 1 || header[1] !== 1) return refuse();
  } finally { closeSync(headerFile); }
  // Some SQLite builds leave an SHM file after closing a DELETE-mode backup. No reader of this fresh copy has opened yet.
  const shm = destination + "-shm", sidecar = lstatSync(shm, { throwIfNoEntry: false });
  if (sidecar) {
    if (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink !== 1 || sidecar.uid !== uid || (sidecar.mode & 0o077) !== 0) return refuse();
    const sidecarFile = openSync(shm, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const opened = fstatSync(sidecarFile); if (opened.dev !== sidecar.dev || opened.ino !== sidecar.ino || opened.nlink !== 1 || opened.uid !== uid) return refuse(); }
    finally { closeSync(sidecarFile); }
    unlinkSync(shm);
  }
  chmodSync(destination, 0o600);
}
export function databaseProfile(file: string): Pick<StartupProfile, "dbBytes" | "taskRows" | "taskHistoryEntries" | "taskTextBytes" | "deliveryRows" | "deliveryPayloadBytes"> {
  const db = new Database(file, { readonly: true }); db.run(`PRAGMA busy_timeout = ${LEDGER_BUSY_TIMEOUT_MS}`);
  try {
    const exists = (table: string) => !!db.query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table);
    const count = (sql: string) => Number((db.query(sql).get() as { n: number | null }).n ?? 0);
    return { dbBytes: statSync(file).size,
      taskRows: exists("tasks") ? count("SELECT COUNT(*) AS n FROM tasks") : 0,
      taskHistoryEntries: exists("tasks") ? count("SELECT SUM(CASE WHEN json_valid(history) THEN json_array_length(history) ELSE 0 END) AS n FROM tasks") : 0,
      taskTextBytes: exists("tasks") ? count("SELECT SUM(COALESCE(length(CAST(title AS BLOB)),0)+COALESCE(length(CAST(detail AS BLOB)),0)) AS n FROM tasks") : 0,
      deliveryRows: exists("deliveries") ? count("SELECT COUNT(*) AS n FROM deliveries") : 0,
      deliveryPayloadBytes: exists("deliveries") ? count("SELECT SUM(COALESCE(length(CAST(originals AS BLOB)),0)+COALESCE(length(CAST(out_json AS BLOB)),0)) AS n FROM deliveries") : 0 };
  } finally { db.close(); }
}
async function prepareState(source: string | undefined, destination: string, profile: StartupProfile, env: NodeJS.ProcessEnv): Promise<StartupProfile> {
  if (!source) {
    const request = join(dirname(destination), "seed.json"); writeFileSync(request, JSON.stringify({ destination, profile }), { mode: 0o600, flag: "wx" });
    await ownedCommand([process.execPath, SCRIPT, "--seed", request], dirname(destination), env);
  } else {
    const sourceDb = join(source, "hub.db"); if (!lstatSync(sourceDb).isFile()) return refuse();
    publicStage = "backup";
    await backupStartupDatabase(sourceDb, join(destination, "hub.db"), env);
    publicStage = "event-copy";
    copyEventPrefix(join(source, "events.jsonl"), join(destination, "events.jsonl"));
    publicStage = "abandoned-copy";
    for (const name of readdirSync(source)) {
      if (!/^restart\.abandoned\.[a-zA-Z0-9_.-]+\.json$/.test(name)) continue;
      const original = join(source, name), before = lstatSync(original);
      if (!before.isFile() || before.isSymbolicLink() || before.size > 2_000_000_000) return refuse();
      const fd = openSync(original, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(fd); if (opened.dev !== before.dev || opened.ino !== before.ino) return refuse();
        const output = openSync(join(destination, name), "wx", 0o600);
        try {
          const buffer = Buffer.alloc(COPY_BYTES); let at = 0;
          while (at < opened.size) { const n = readSync(fd, buffer, 0, Math.min(buffer.length, opened.size - at), at); if (!n) return refuse(); writeFileSync(output, buffer.subarray(0, n)); at += n; }
        } finally { closeSync(output); }
        const after = fstatSync(fd);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return refuse();
      } finally { closeSync(fd); }
      chmodSync(join(destination, name), 0o600);
    }
  }
  publicStage = "profile";
  const events = readFileSync(join(destination, "events.jsonl"));
  const abandoned = readdirSync(destination).filter(name => /^restart\.abandoned\./.test(name)).map(name => statSync(join(destination, name)).size);
  return { ...databaseProfile(join(destination, "hub.db")), eventBytes: events.length, eventLines: events.reduce((n, byte) => n + Number(byte === 10), 0),
    abandonedFiles: abandoned.length, abandonedBytes: abandoned.reduce((a, b) => a + b, 0), abandonedMaxBytes: Math.max(0, ...abandoned) };
}

function project(root: string, env: NodeJS.ProcessEnv): void {
  for (const args of [["init", "-q"], ["-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "fixture"]]) {
    const run = hubGitSync(["-C", root, ...args], { env, encoding: "utf8", timeout: SAMPLE_TIMEOUT_MS });
    if (run.status !== 0) { publicDebug(env.AHUB_STARTUP_BENCHMARK_PUBLIC_DEBUG === "1", { boundary: "project-git", executable: "git", exitCode: run.status, stderr: run.stderr }); return refuse(); }
  }
}
/** Additional private-copy containment only; no process/signal exceptions or outbound network permission. */
export function privateStartupSandboxProfile(typedState: string, canonicalState: string): string {
  if (![typedState, canonicalState].every(value => isAbsolute(value) && value !== "/" && !/[\p{Cc}\p{Cf}]/u.test(value))) return refuse();
  return ["(version 1)", "(allow default)", "(deny network-outbound)",
    ...[...new Set([typedState, canonicalState])].map(value => `(deny file-read* file-write* (subpath ${sbplString(value)}))`), ""].join("\n");
}
export async function probePrivateStartupGuard(typedState: string): Promise<{ profile: string; canonicalState: string; macGuard: 1 }> {
  publicStage = "mac-guard";
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) return refuse();
  const canonicalState = realPath(typedState), profile = privateStartupSandboxProfile(typedState, canonicalState);
  const root = mkdtempSync(join(tmpdir(), "ahub-startup-1232-mac-guard-")); chmodSync(root, 0o700);
  let stopped = false;
  try {
    const env = isolatedStartupEnvironment(root, "private");
    // Same exact profile as the measured child. Failure precedes ledger reservation and any source-state copy.
    await ownedCommand(["/usr/bin/sandbox-exec", "-p", profile, "/usr/bin/true"], root, env, undefined, undefined, PUBLIC_PROBE_TIMEOUT_MS); stopped = true;
    return { profile, canonicalState, macGuard: 1 };
  } finally { if (stopped) rmSync(root, { recursive: true, force: true }); }
}

async function child(root: string, env: NodeJS.ProcessEnv, sandboxProfile?: string): Promise<ChildObservation> {
  const started = performance.now(); let ready: { timing: string; importAndStartupMs: number; eventReadBytes: number; abandonedReadBytes: number; seedPasses: number; seedReadBytes: number; eventReadFileCalls: number; usageRollupReadBytes: number; usageRollupCalls: number } | undefined, wallMs = 0;
  const argv = sandboxProfile ? ["/usr/bin/sandbox-exec", "-p", sandboxProfile, process.execPath, SCRIPT, "--child", root] : [process.execPath, SCRIPT, "--child", root];
  const raw = await ownedCommand(argv, root, env, undefined, line => {
    try {
      const value = JSON.parse(line);
      if (value.ready === 1 && !ready && value.effects === 0 && Number.isFinite(value.importAndStartupMs) && value.importAndStartupMs >= 0) {
        if (![value.eventReadBytes, value.abandonedReadBytes, value.seedPasses, value.seedReadBytes, value.eventReadFileCalls, value.usageRollupReadBytes, value.usageRollupCalls].every(n => Number.isSafeInteger(n) && n >= 0)) return;
        if (value.seedReadBytes > value.eventReadBytes) return;
        ready = { timing: timingLine(value.timing), importAndStartupMs: value.importAndStartupMs, eventReadBytes: value.eventReadBytes, abandonedReadBytes: value.abandonedReadBytes, seedPasses: value.seedPasses, seedReadBytes: value.seedReadBytes, eventReadFileCalls: value.eventReadFileCalls, usageRollupReadBytes: value.usageRollupReadBytes, usageRollupCalls: value.usageRollupCalls }; wallMs = performance.now() - started;
      }
    } catch { /* Non-protocol output is discarded, never forwarded. */ }
  });
  const last = JSON.parse(raw.trim().split("\n").at(-1) ?? "null") as { stopped?: number; effects?: number } | null;
  if (!ready || last?.stopped !== 1 || last.effects !== 0) return refuse();
  return { ...ready, wallMs, stopped: true, effects: 0 };
}
export async function runStartupBenchmark(options: BenchmarkOptions, ports: BenchmarkPorts = {}): Promise<Record<string, string | number>[]> {
  publicStage = "input";
  if (!Number.isInteger(options.samples) || options.samples < 1 || options.samples > MAX_PRIVATE_SAMPLES || options.mode === "private" && process.platform !== "darwin") return refuse();
  if (options.mode === "private" && Object.keys(ports).length !== 0) return refuse();
  const profile = numericProfile(options.profile ?? REPRESENTATIVE_PROFILE), results: Record<string, string | number>[] = [];
  if (options.mode === "private" && (!options.privateState || !lstatSync(options.privateState).isDirectory())) return refuse();
  publicStage = "mac-guard";
  const privateGuard = options.mode === "private" ? await probePrivateStartupGuard(options.privateState!) : undefined;
  const baseline = options.mode === "synthetic" ? mkdtempSync(join(tmpdir(), "ahub-startup-1232-baseline-")) : undefined;
  let baselineStopped = false;
  try {
    if (baseline) {
      chmodSync(baseline, 0o700); const env = isolatedStartupEnvironment(baseline, "synthetic"), state = join(baseline, "state"); mkdirSync(state, { mode: 0o700 });
      publicStage = "seed";
      await (ports.prepare ?? prepareState)(undefined, state, profile, env); baselineStopped = true;
    }
    for (let sample = 0; sample < options.samples; sample++) {
      publicStage = "attempt-reserved";
      const attempt = options.mode === "private" ? reservePrivateAttempt(join(tmpdir(), "ahub-startup-1232-attempts.sqlite")) : sample + 1;
      const root = mkdtempSync(join(tmpdir(), "ahub-startup-1232-")); chmodSync(root, 0o700);
      let stopped = true;
      try {
        const env = isolatedStartupEnvironment(root, options.mode), cwd = join(root, "project"), state = join(root, "state");
        mkdirSync(cwd, { mode: 0o700 }); mkdirSync(state, { mode: 0o700 });
        stopped = false;
        publicStage = "project";
        (ports.project ?? project)(cwd, env);
        publicStage = "copy";
        const sizes = numericProfile(await (ports.prepare ?? prepareState)(baseline ? join(baseline, "state") : options.privateState, state, profile, env));
        stopped = false;
        publicStage = "child";
        if (privateGuard && realPath(options.privateState!) !== privateGuard.canonicalState) return refuse();
        const observation = await (ports.child ?? ((sampleRoot: string, sampleEnv: NodeJS.ProcessEnv) => child(sampleRoot, sampleEnv, privateGuard?.profile)))(root, env); stopped = observation.stopped;
        if (!stopped || observation.effects !== 0) return refuse();
        const breakdown = startupReadBreakdown(observation);
        if (options.acceptance && (observation.wallMs >= 5000 || observation.abandonedReadBytes > 0 || observation.seedPasses !== 1 || observation.eventReadFileCalls !== 0 || observation.usageRollupReadBytes > DEFAULT_MAX_BYTES || breakdown.residualExtraReadBytes > 1)) return refuse();
        results.push({ synthetic: Number(options.mode === "synthetic"), macGuard: privateGuard?.macGuard ?? 0, sample: attempt, ...sizes, wallMs: Math.round(observation.wallMs),
          ...(observation.importAndStartupMs === undefined ? {} : { importAndStartupMs: Math.round(observation.importAndStartupMs) }), timing: timingLine(observation.timing), effects: observation.effects, seedPasses: observation.seedPasses, seedReadBytes: observation.seedReadBytes, eventReadFileCalls: observation.eventReadFileCalls, eventReadBytes: observation.eventReadBytes,
          ...breakdown, usageRollupReadBytes: observation.usageRollupReadBytes, usageRollupCalls: observation.usageRollupCalls, abandonedReadBytes: observation.abandonedReadBytes });
      } finally {
        // An unconfirmed child retains its private fixture; never delete state beneath an owner.
        if (stopped) rmSync(root, { recursive: true, force: true });
      }
    }
    return results;
  } finally { if (baseline && baselineStopped) rmSync(baseline, { recursive: true, force: true }); }
}

/** Empty arrays are valid completed rows; padding is JSON whitespace, never invented delivery content. */
export function syntheticDeliveryPayload(bytes: number, n: number): { originals: string; out: string } {
  if (!Number.isSafeInteger(bytes) || bytes < 4) return refuse();
  const envelope = { id: `synthetic-${n}`, trace: `synthetic-${n}`, from: "hub", to: ["claude"], body: "", hop: 0, ts: 1, kind: "chat", priority: "status" };
  const baseBytes = Buffer.byteLength(JSON.stringify([envelope])), extra = bytes - 2 * baseBytes;
  if (extra < 0) return { originals: "[]" + " ".repeat(bytes - 4), out: "[]" };
  return { originals: JSON.stringify([{ ...envelope, body: "x".repeat(Math.floor(extra / 2)) }]), out: JSON.stringify([{ ...envelope, body: "x".repeat(Math.ceil(extra / 2)) }]) };
}
export function syntheticEventLine(bytes: number, n: number): string {
  if (!Number.isSafeInteger(bytes) || bytes < 1) return refuse();
  const base = JSON.stringify({ v: 1, at: "2026-01-01T00:00:00.000Z", type: "native_turn_end", peer: "claude", id: `synthetic-${n}` });
  // A short/blank original line contributes to line count too; it is not fabricated as a native event.
  if (bytes < base.length + 1) return " ".repeat(bytes - 1) + "\n";
  return base + " ".repeat(bytes - base.length - 1) + "\n";
}
export function abandonedSizes(profile: StartupProfile): number[] {
  numericProfile(profile);
  if (!profile.abandonedFiles) return [];
  const rest = profile.abandonedBytes - profile.abandonedMaxBytes, count = profile.abandonedFiles - 1;
  return [profile.abandonedMaxBytes, ...Array.from({ length: count }, (_, n) => Math.floor(rest / count) + Number(n < rest % count))];
}

export async function seedStartupFixture(file: string): Promise<void> {
  const { destination, profile: input } = JSON.parse(readFileSync(file, "utf8")) as { destination: string; profile: unknown }, profile = numericProfile(input);
  publicStage = "seed-imports";
  const { Board } = await import("../../src/hub/board.ts");
  const { DeliveryJournal } = await import("../../src/hub/delivery-journal.ts");
  publicStage = "seed-board";
  const dbFile = join(destination, "hub.db"), board = new Board(dbFile);
  for (let n = 0; n < profile.taskRows; n++) {
    const bytes = Math.floor(profile.taskTextBytes / profile.taskRows) + Number(n < profile.taskTextBytes % profile.taskRows);
    const title = "synthetic".slice(0, bytes);
    board.propose("hub", { title, detail: "x".repeat(bytes - title.length), class: "implement", backlog: true });
  }
  board.close();
  publicStage = "seed-journal";
  const journal = new DeliveryJournal({ file: dbFile, projectRoot: join(dirname(destination), "project"), projectId: "synthetic-startup", instanceId: "synthetic-seed" }); journal.close();
  publicStage = "seed-payload";
  const db = new Database(dbFile); db.run(`PRAGMA busy_timeout = ${LEDGER_BUSY_TIMEOUT_MS}`);
  try {
    const updateHistory = db.query("UPDATE tasks SET history=? WHERE id=?");
    db.transaction(() => { for (let n = 0; n < profile.taskRows; n++) {
      const count = Math.floor(profile.taskHistoryEntries / profile.taskRows) + Number(n < profile.taskHistoryEntries % profile.taskRows);
      updateHistory.run(JSON.stringify(Array.from({ length: count }, (_, index) => ({ at: 1, by: "hub", event: index === 0 ? "backlogged" : "fixture" }))), n + 1);
    } })();
    const add = db.query("INSERT INTO deliveries(id,project_id,peer,state,revision,created_at,updated_at,originals,out_json) VALUES(?,?,?,'completed',1,1,1,?,?)");
    db.transaction(() => {
      let remainingBytes = profile.deliveryPayloadBytes;
      for (let n = 0; n < profile.deliveryRows; n++) {
        const target = Math.floor(remainingBytes / (profile.deliveryRows - n));
        const { originals, out } = syntheticDeliveryPayload(target, n);
        add.run(`delivery-${n}`, "synthetic-startup", "claude", originals, out); remainingBytes -= Buffer.byteLength(originals) + Buffer.byteLength(out);
      }
    })();
    db.run("CREATE TABLE startup_fixture_padding(bytes BLOB)");
    const pages = Number((db.query("PRAGMA page_count").get() as { page_count: number }).page_count);
    db.query("INSERT INTO startup_fixture_padding VALUES(zeroblob(?))").run(Math.max(0, profile.dbBytes - pages * 4096 - 3 * 4096));
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { db.close(); }
  publicStage = "seed-events";
  const events = openSync(join(destination, "events.jsonl"), "wx", 0o600);
  try {
    let written = 0;
    for (let n = 0; n < profile.eventLines; n++) {
      const target = Math.floor((profile.eventBytes - written) / (profile.eventLines - n));
      const line = syntheticEventLine(target, n);
      writeFileSync(events, line); written += Buffer.byteLength(line);
    }
  } finally { closeSync(events); }
  publicStage = "seed-abandoned";
  for (const [n, bytes] of abandonedSizes(profile).entries()) {
    const content = bytes >= 3 ? "{}" + " ".repeat(bytes - 3) + "\n" : bytes === 2 ? "{}" : "\n".repeat(bytes);
    writeFileSync(join(destination, `restart.abandoned.synthetic-${n}.json`), content, { mode: 0o600 });
  }
}

/** Benchmark-only Bun builtin interception. No operation is fabricated; unspecified exports retain their real implementations. */
async function interceptBuiltins(specifiers: string[], overrides: (real: Record<string, any>) => Record<string, unknown>): Promise<() => void> {
  const { mock } = await import("bun:test");
  const captured = await Promise.all(specifiers.map(async specifier => ({ specifier, real: { ...await import(specifier) } })));
  try {
    for (const { specifier, real } of captured) {
      const replacements = overrides(real), source = real.default ?? real, descriptors = Object.getOwnPropertyDescriptors(source);
      for (const [name, value] of Object.entries(replacements)) descriptors[name] = { value, writable: true, configurable: true, enumerable: true };
      const forwarded = { ...real, ...replacements, default: Object.create(Object.getPrototypeOf(source), descriptors) };
      mock.module(specifier, () => forwarded);
    }
  } catch (error) { for (const { specifier, real } of captured) mock.module(specifier, () => real); throw error; }
  return () => { for (const { specifier, real } of captured) mock.module(specifier, () => real); };
}

export async function installStartupReadObserver(stateDir: string): Promise<{ counts: { eventReadBytes: number; abandonedReadBytes: number; restartReadBytes: number; eventReadFileCalls: number }; restore(): void }> {
  const descriptors = new Map<number, string>();
  const counts = { eventReadBytes: 0, abandonedReadBytes: 0, restartReadBytes: 0, eventReadFileCalls: 0 };
  const sourceName = (value: unknown): string | undefined => typeof value === "number" ? descriptors.get(value) : typeof value === "string" ? resolve(value) : undefined;
  const noteRead = (name: string | undefined, bytes: number) => {
    if (name === join(stateDir, "events.jsonl")) counts.eventReadBytes += bytes;
    if (name === join(stateDir, "restart.json")) counts.restartReadBytes += bytes;
    if (name && dirname(name) === stateDir && /restart\.abandoned\.[^/]+\.json$/.test(name)) counts.abandonedReadBytes += bytes;
  };
  const restore = await interceptBuiltins(["fs", "node:fs"], real => ({
    openSync: (...args: any[]) => { const fd = real.openSync(...args), name = sourceName(args[0]); if (name) descriptors.set(fd, name); return fd; },
    closeSync: (fd: number) => { descriptors.delete(fd); real.closeSync(fd); },
    readSync: (...args: any[]) => { const n = real.readSync(...args); noteRead(sourceName(args[0]), n); return n; },
    readFileSync: (...args: any[]) => {
      const name = sourceName(args[0]), data = real.readFileSync(...args);
      if (name === join(stateDir, "events.jsonl")) counts.eventReadFileCalls++;
      noteRead(name, typeof data === "string" ? Buffer.byteLength(data) : data.byteLength); return data;
    },
  }));
  return { counts, restore };
}

export function startupReadOnlyProcessAllowed(command: unknown, args: unknown): boolean {
  if (typeof command !== "string" || !Array.isArray(args) || args.some(word => typeof word !== "string")) return false;
  const executable = ["git", "ps", "realpath"].includes(command) ? Bun.which(command, { PATH: process.env.PATH }) ?? "" : command;
  if (["/bin/ps", "/usr/bin/ps", "/bin/realpath", "/usr/bin/realpath"].includes(executable)) return true;
  if (!["/usr/bin/git", "/bin/git"].includes(executable)) return false;
  const words = [...args] as string[];
  while (words.length && words[0]!.startsWith("-")) { const option = words.shift(); if (option === "-c" || option === "-C" || option === "--git-dir" || option === "--work-tree") words.shift(); }
  const verb = words.shift();
  if (verb === "remote") return words.length === 2 && words[0] === "get-url" && words[1] === "origin";
  if (verb === "config" && words.includes("--path")) return words.length === 2 && words[0] === "--path" && words[1] === "core.worktree";
  return ["rev-parse", "ls-files", "status", "show-ref", "symbolic-ref", "diff", "log", "reflog", "cat-file", "for-each-ref"].includes(verb ?? "")
    || verb === "config" && words.some(word => ["--get", "--get-all", "--get-regexp", "--list"].includes(word))
    || verb === "worktree" && words[0] === "list";
}

async function installStartupEffectDenials(): Promise<{ deny(): never; effects(): number; restore(): void }> {
  let effects = 0;
  const deny = () => { effects++; publicDebug(process.env.AHUB_STARTUP_BENCHMARK_PUBLIC_DEBUG === "1", { boundary: "effect-denied", ...publicError(new Error("public fixture effect was refused")) }); return refuse(); }, restorers: (() => void)[] = [];
  const originalFetch = globalThis.fetch, originalWebSocket = globalThis.WebSocket, originalConnect = Bun.connect;
  globalThis.fetch = Object.assign(deny, { preconnect: deny });
  globalThis.WebSocket = class { constructor() { deny(); } } as unknown as typeof WebSocket;
  Bun.connect = deny as typeof Bun.connect;
  restorers.push(() => { globalThis.fetch = originalFetch; globalThis.WebSocket = originalWebSocket; Bun.connect = originalConnect; });

  restorers.push(await interceptBuiltins(["child_process", "node:child_process"], real => {
    const replacements: Record<string, unknown> = { exec: deny, execSync: deny, fork: deny };
    for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) replacements[name] = (command: unknown, args: unknown, ...rest: unknown[]) => {
      if (startupReadOnlyProcessAllowed(command, args)) return real[name](command, args, ...rest);
      publicDebug(process.env.AHUB_STARTUP_BENCHMARK_PUBLIC_DEBUG === "1", { boundary: "process-refused", executable: typeof command === "string" ? basename(command) : "unknown" }); return deny();
    };
    return replacements;
  }));
  for (const name of ["http", "https", "net", "tls", "dgram", "dns"]) restorers.push(await interceptBuiltins([name, `node:${name}`], real => {
    const replacements: Record<string, unknown> = {};
    for (const key of ["request", "get", "connect", "createConnection", "createSocket", "lookup", "resolve", "resolve4", "resolve6"]) if (typeof real[key] === "function") replacements[key] = deny;
    if (real.Socket) { const original = real.Socket.prototype.connect; real.Socket.prototype.connect = deny; restorers.push(() => { real.Socket.prototype.connect = original; }); }
    return replacements;
  }));
  const nativeSpawn = Bun.spawn, nativeSpawnSync = Bun.spawnSync;
  const bunAllowed = (value: any) => { const argv = Array.isArray(value) ? value : value?.cmd; return Array.isArray(argv) && startupReadOnlyProcessAllowed(argv[0], argv.slice(1)); };
  const refuseBun = (value: any) => {
    const argv = Array.isArray(value) ? value : value?.cmd;
    publicDebug(process.env.AHUB_STARTUP_BENCHMARK_PUBLIC_DEBUG === "1", { boundary: "bun-process-refused", executable: typeof argv?.[0] === "string" ? basename(argv[0]) : "unknown" }); return deny();
  };
  Bun.spawn = ((value: any, options: any) => bunAllowed(value) ? nativeSpawn(value, options) : refuseBun(value)) as typeof Bun.spawn;
  Bun.spawnSync = ((value: any, options: any) => bunAllowed(value) ? nativeSpawnSync(value, options) : refuseBun(value)) as typeof Bun.spawnSync;
  restorers.push(() => { Bun.spawn = nativeSpawn; Bun.spawnSync = nativeSpawnSync; });
  return { deny, effects: () => effects, restore: () => { for (const restore of restorers.reverse()) restore(); } };
}

/** Public normal-runtime proof of interception; never consumes the private sample ledger. */
export async function runStartupPublicProbe(): Promise<Record<string, number>> {
  const root = mkdtempSync(join(tmpdir(), "ahub-startup-1232-probe-")); chmodSync(root, 0o700);
  let stopped = false;
  try {
    const env = isolatedStartupEnvironment(root);
    const raw = await ownedCommand([process.execPath, SCRIPT, "--probe-child", root], root, env, undefined, undefined, PUBLIC_PROBE_TIMEOUT_MS); stopped = true;
    const value: unknown = JSON.parse(raw);
    const keys = ["normalRuntime", "namedReadBytes", "defaultReadBytes", "eventReaderBytes", "rollupBytes", "restartBytes", "abandonedMetadataBytes", "abandonedBodyBytes", "processDenials", "networkDenials", "restored"];
    if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== keys.sort().join() || Object.values(value).some(n => !Number.isSafeInteger(n) || Number(n) < 0)) return refuse();
    const row = value as Record<string, number>;
    if (row.normalRuntime !== 1 || row.namedReadBytes! < 8 || row.defaultReadBytes! < 8 || row.eventReaderBytes! < 1 || row.rollupBytes! < 1 || row.restartBytes! < 2 || row.abandonedMetadataBytes !== 0 || row.abandonedBodyBytes! < 2 || row.processDenials !== 2 || row.networkDenials !== 4 || row.restored !== 1) return refuse();
    return row;
  } finally { if (stopped) rmSync(root, { recursive: true, force: true }); }
}

async function publicProbeChild(root: string): Promise<void> {
  if (process.env.AHUB_STARTUP_BENCHMARK_CHILD !== "1" || process.env.HOME !== join(root, "home")) return refuse();
  const state = join(root, "state"); mkdirSync(state, { mode: 0o700 });
  const events = join(state, "events.jsonl"), restart = join(state, "restart.json"), abandoned = join(state, "restart.abandoned.public.json");
  const data = JSON.stringify({ v: 1, at: "2026-01-01T00:00:00.000Z", type: "state", peer: "claude", state: "offline" }) + "\n";
  writeFileSync(events, data); writeFileSync(restart, "{}"); writeFileSync(abandoned, "{}");
  const nativeRead = readFileSync, nativeSpawn = (await import("node:child_process")).spawn, nativeFetch = globalThis.fetch;
  const guards = await installStartupEffectDenials(), observer = await installStartupReadObserver(state);
  const metrics: Record<string, number> = { normalRuntime: 1 };
  try {
    const fs = await import("node:fs");
    let before = observer.counts.eventReadBytes;
    if (fs.readFileSync(events, "utf8") !== data) return refuse();
    metrics.namedReadBytes = observer.counts.eventReadBytes - before;
    before = observer.counts.eventReadBytes;
    if (fs.default.readFileSync(events, "utf8") !== data) return refuse();
    metrics.defaultReadBytes = observer.counts.eventReadBytes - before;
    const { readEvents } = await import("../../src/hub/events.ts");
    before = observer.counts.eventReadBytes;
    if (readEvents(events).length !== 1) return refuse();
    metrics.eventReaderBytes = observer.counts.eventReadBytes - before;
    const { UsageRollup } = await import("../../src/hub/usage-rollup.ts");
    const rollup = new UsageRollup(join(state, "hub.db"), events);
    before = observer.counts.eventReadBytes;
    try { rollup.poll(); } finally { rollup.close(); }
    metrics.rollupBytes = observer.counts.eventReadBytes - before;
    const { readRestartSnapshot } = await import("../../src/hub/restart.ts");
    if (readRestartSnapshot(state, { projectRoot: root, projectId: "public-probe" }) !== undefined) return refuse();
    metrics.restartBytes = observer.counts.restartReadBytes;
    fs.statSync(abandoned); fs.readdirSync(state);
    metrics.abandonedMetadataBytes = observer.counts.abandonedReadBytes;
    fs.default.readFileSync(abandoned);
    metrics.abandonedBodyBytes = observer.counts.abandonedReadBytes;
    const denied = (operation: () => unknown) => { const n = guards.effects(); try { operation(); } catch { /* The denial must happen before any effect. */ } if (guards.effects() !== n + 1) return refuse(); };
    const cp = await import("node:child_process"), http = await import("node:http"), net = await import("node:net");
    denied(() => cp.spawn("startup-benchmark-refused-native", []));
    denied(() => cp.default.spawn("startup-benchmark-refused-native", []));
    metrics.processDenials = guards.effects();
    denied(() => http.request("http://127.0.0.1:1"));
    denied(() => net.default.connect(1, "127.0.0.1"));
    denied(() => globalThis.fetch("http://127.0.0.1:1"));
    denied(() => globalThis.fetch.preconnect("http://127.0.0.1:1"));
    metrics.networkDenials = guards.effects() - metrics.processDenials!;
  } finally { observer.restore(); guards.restore(); }
  const restoredFs = await import("node:fs"), restoredCp = await import("node:child_process");
  if (restoredFs.readFileSync !== nativeRead || restoredCp.spawn !== nativeSpawn || globalThis.fetch !== nativeFetch) return refuse();
  metrics.restored = 1;
  process.stdout.write(JSON.stringify(metrics) + "\n");
}

/** Attribute actual observer bytes around the real synchronous method, including failed or zero-consumption polls. */
export async function installStartupRollupReadObserver(eventReadBytes: () => number): Promise<{ counts: { usageRollupReadBytes: number; usageRollupCalls: number }; restore(): void }> {
  const { UsageRollup } = await import("../../src/hub/usage-rollup.ts");
  const prototype = UsageRollup.prototype, descriptor = Object.getOwnPropertyDescriptor(prototype, "poll");
  if (!descriptor || typeof descriptor.value !== "function") return refuse();
  const original = descriptor.value as typeof UsageRollup.prototype.poll;
  const counts = { usageRollupReadBytes: 0, usageRollupCalls: 0 };
  const poll: typeof original = function(this: InstanceType<typeof UsageRollup>, ...args: Parameters<typeof original>) {
    const before = eventReadBytes(); counts.usageRollupCalls++;
    try { return Reflect.apply(original, this, args) as ReturnType<typeof original>; }
    finally { counts.usageRollupReadBytes += eventReadBytes() - before; }
  };
  Object.defineProperty(prototype, "poll", { ...descriptor, value: poll });
  return { counts, restore: () => { Object.defineProperty(prototype, "poll", descriptor); } };
}

export function startupReadBreakdown(observation: Pick<ChildObservation, "eventReadBytes" | "seedPasses" | "seedReadBytes" | "eventReadFileCalls" | "abandonedReadBytes" | "usageRollupReadBytes" | "usageRollupCalls">): { auxiliaryReadBytes: number; residualExtraReadBytes: number } {
  const counts = [observation.eventReadBytes, observation.seedPasses, observation.seedReadBytes, observation.eventReadFileCalls, observation.abandonedReadBytes, observation.usageRollupReadBytes, observation.usageRollupCalls];
  if (counts.some(value => !Number.isSafeInteger(value) || value < 0)) return refuse();
  const auxiliaryReadBytes = observation.eventReadBytes - observation.seedReadBytes, residualExtraReadBytes = auxiliaryReadBytes - observation.usageRollupReadBytes;
  if (!Number.isSafeInteger(residualExtraReadBytes) || residualExtraReadBytes < 0 || observation.seedPasses === 0 && observation.seedReadBytes !== 0 || observation.usageRollupCalls === 0 && observation.usageRollupReadBytes !== 0) return refuse();
  return { auxiliaryReadBytes, residualExtraReadBytes };
}

/** Sum every invocation; overwriting the last observation would hide a second seed pass. */
export function startupSeedCounter(): { metrics: { seedPasses: number; seedReadBytes: number }; observed(value: { readPasses: number; readBytes: number }): void } {
  const metrics = { seedPasses: 0, seedReadBytes: 0 };
  return { metrics, observed: value => { metrics.seedPasses += value.readPasses; metrics.seedReadBytes += value.readBytes; } };
}

/** Isolated child only: deny effects before importing the composition root. */
async function measure(root: string): Promise<void> {
  const importedAt = performance.now(), cwd = join(root, "project"), stateDir = join(root, "state");
  if (process.env.AHUB_STARTUP_BENCHMARK_CHILD !== "1" || process.env.HOME !== join(root, "home") || process.env.AGENTHUB_HOME !== join(root, "agenthub_home")) return refuse();
  publicStage = "effect-guards";
  const guards = await installStartupEffectDenials(), deny = guards.deny;
  const observer = await installStartupReadObserver(stateDir), io = observer.counts, seedCounter = startupSeedCounter();
  const rollupObserver = await installStartupRollupReadObserver(() => io.eventReadBytes);
  let daemon: Awaited<ReturnType<typeof import("../../src/hub/daemon.ts").startDaemon>> | undefined;
  try {
    publicStage = "daemon-import";
    const { startDaemon, DEFAULT_CONFIG } = await import("../../src/hub/daemon.ts");
    const { ADAPTERS } = await import("../../src/adapters/registry.ts");
    publicStage = "copy-rebind";
    const db = new Database(join(stateDir, "hub.db")); db.run(`PRAGMA busy_timeout = ${LEDGER_BUSY_TIMEOUT_MS}`);
    const rows = db.query("SELECT project_id FROM delivery_meta LIMIT 2").all() as { project_id: string }[];
    if (rows.length > 1) { db.close(); return refuse(); }
    const row = rows[0];
    // Rebind only the disposable copy's project path; no live descriptor/leadership file is copied or read.
    db.query("UPDATE delivery_meta SET project_root=?").run(cwd); db.close();
    publicStage = "daemon-start";
    daemon = await startDaemon({ cwd, stateDir, startupSeedObserved: seedCounter.observed, projectId: row?.project_id ?? "synthetic-startup", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
      agentDrift: async () => [], terminal: () => ({ available: () => ({ ok: false, why: "benchmark effects are refused" }), open: deny }), notifier: deny,
      memorySync: deny, memorySyncTrigger: () => {}, piiScreen: async () => deny(), webFetchTransport: deny,
      config: { ...DEFAULT_CONFIG, roster: Object.fromEntries(ADAPTERS.map(definition => [definition.kind, false])),
        memory: { ...DEFAULT_CONFIG.memory, native: true, enabled: true, sync_interval_min: 0 },
        pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
        inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: true },
        recovery: { ...DEFAULT_CONFIG.recovery, auto_resume_after_crash: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false },
        specs: { ...DEFAULT_CONFIG.specs, enabled: false }, schedules: [], folder_triggers: [], start: { agents: [] },
      } });
    const importAndStartupMs = performance.now() - importedAt;
    publicStage = "ready-check";
    if (daemon.bus.peers.size !== 0 || guards.effects() !== 0) return refuse();
    publicStage = "timing-read";
    const lines = readFileSync(join(stateDir, "hub.log"), "utf8").split("\n").filter(line => line.includes("startup timings ms: "));
    if (lines.length !== 1) return refuse();
    const timing = timingLine(lines[0]!.slice(lines[0]!.indexOf("startup timings ms: ")));
    await new Promise<void>(done => process.stdout.write(JSON.stringify({ timing, importAndStartupMs, ready: 1, effects: guards.effects(), ...seedCounter.metrics, ...io, ...rollupObserver.counts }) + "\n", () => done()));
    publicStage = "daemon-stop";
    await daemon.stop();
    if (guards.effects() !== 0) return refuse();
    process.stdout.write(JSON.stringify({ stopped: 1, effects: guards.effects() }) + "\n");
  } finally {
    try { await daemon?.stop(); } finally { rollupObserver.restore(); }
    observer.restore(); guards.restore();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === "--seed" && process.env.AHUB_STARTUP_BENCHMARK_CHILD === "1") await seedStartupFixture(args[1]!);
    else if (args[0] === "--probe-child") await publicProbeChild(args[1]!);
    else if (args[0] === "--mac-guard-probe" && args.length === 2) {
      const typed = isAbsolute(args[1]!) ? args[1]! : `${process.cwd()}/${args[1]!}`;
      const result = await probePrivateStartupGuard(typed); process.stdout.write(JSON.stringify({ macGuard: result.macGuard }) + "\n");
    }
    else if (args[0] === "--public-probe" && args.length === 1) process.stdout.write(JSON.stringify(await runStartupPublicProbe()) + "\n");
    else if (args[0] === "--child") await measure(args[1]!);
    else {
      if ((!args.includes("--synthetic") && !args.includes("--private-state")) || args.includes("--synthetic") && args.includes("--private-state")) refuse();
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--synthetic" || args[i] === "--acceptance") continue;
        if (!["--private-state", "--samples", "--profile"].includes(args[i]!) || !args[i + 1] || args[i + 1]!.startsWith("--")) refuse();
        i++;
      }
      const value = (key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
      const privateState = value("--private-state"), profileFile = value("--profile");
      const results = await runStartupBenchmark({ mode: privateState ? "private" : "synthetic", privateState: privateState ? isAbsolute(privateState) ? privateState : `${process.cwd()}/${privateState}` : undefined,
        acceptance: args.includes("--acceptance"), samples: Number(value("--samples") ?? 1), profile: profileFile ? numericProfile(JSON.parse(readFileSync(profileFile, "utf8"))) : undefined });
      for (const result of results) process.stdout.write(JSON.stringify(result) + "\n");
    }
  } catch (error) {
    const publicOnly = args.includes("--synthetic") && !args.includes("--private-state") || ["--seed", "--child", "--probe-child"].includes(args[0] ?? "") && process.env.AHUB_STARTUP_BENCHMARK_PUBLIC_DEBUG === "1";
    publicDebug(publicOnly, publicError(error));
    process.stdout.write(JSON.stringify({ failed: 1, stage: error instanceof BenchmarkStageFailure ? error.stage : BENCHMARK_STAGES.indexOf(publicStage) }) + "\n");
    process.stderr.write("startup benchmark did not complete; inspect its isolated configuration and numeric profile before another authorized attempt\n"); process.exitCode = 1; }
}
