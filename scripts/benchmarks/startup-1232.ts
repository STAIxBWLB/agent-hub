import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { hubGitSync } from "../../src/hub/git.ts";
import { stopOwnedProcess, trackGroup } from "../../src/hub/child-process.ts";
import { STARTUP_PHASES } from "../../src/hub/startup-timing.ts";

const MAX_PRIVATE_SAMPLES = 3;
const SAMPLE_TIMEOUT_MS = 60_000;
const OUTPUT_BYTES = 64 * 1024;
const COPY_BYTES = 64 * 1024;
const LEDGER_BUSY_TIMEOUT_MS = 3000;
const SCRIPT = fileURLToPath(import.meta.url);
const PROFILE_KEYS = ["dbBytes", "taskRows", "taskHistoryEntries", "taskTextBytes", "deliveryRows", "deliveryPayloadBytes", "eventBytes", "eventLines", "abandonedFiles", "abandonedBytes", "abandonedMaxBytes"] as const;
export type StartupProfile = Record<typeof PROFILE_KEYS[number], number>;
export const REPRESENTATIVE_PROFILE: StartupProfile = { dbBytes: 37_000_000, taskRows: 770, taskHistoryEntries: 7700, taskTextBytes: 2_000_000,
  deliveryRows: 1000, deliveryPayloadBytes: 2_000_000, eventBytes: 130_000_000, eventLines: 500_000, abandonedFiles: 1, abandonedBytes: 17_000_000, abandonedMaxBytes: 17_000_000 };
export interface BenchmarkOptions { mode: "synthetic" | "private"; samples: number; profile?: StartupProfile; privateState?: string; acceptance?: boolean }
export interface ChildObservation { timing: string; wallMs: number; stopped: boolean; effects: number; eventReadBytes: number; abandonedReadBytes: number; importAndStartupMs?: number }
export interface BenchmarkPorts {
  prepare?: (state: string | undefined, destination: string, profile: StartupProfile, env: NodeJS.ProcessEnv) => Promise<StartupProfile>;
  child?: (root: string, env: NodeJS.ProcessEnv) => Promise<ChildObservation>;
  project?: (root: string, env: NodeJS.ProcessEnv) => void;
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
export function isolatedStartupEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { AHUB_STARTUP_BENCHMARK_CHILD: "1", PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC", TERM: "dumb", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
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

async function ownedCommand(argv: string[], cwd: string, env: NodeJS.ProcessEnv, input?: string, onLine?: (line: string) => void): Promise<string> {
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true, stdio: ["pipe", "pipe", "ignore"] }); trackGroup(child);
  let output = "", pending = "", overflow = false;
  child.stdout!.on("data", chunk => {
    if (Buffer.byteLength(output) + chunk.length > OUTPUT_BYTES) { overflow = true; return; }
    output += String(chunk); pending += String(chunk);
    while (pending.includes("\n")) { const cut = pending.indexOf("\n"); onLine?.(pending.slice(0, cut)); pending = pending.slice(cut + 1); }
  });
  const drained = new Promise<void>(done => child.stdout!.once("end", done));
  const exited = new Promise<number | null>((done, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) done(child.exitCode);
    else { child.once("exit", done); child.once("error", reject); }
  });
  // Attach rejection handling before any teardown can race an early child failure.
  void exited.catch(() => {});
  if (input !== undefined) child.stdin!.end(input); else child.stdin!.end();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("bounded benchmark child did not finish; inspect its numeric stage before retrying")), SAMPLE_TIMEOUT_MS); })]);
    clearTimeout(timer);
    await Promise.race([drained, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("benchmark output did not settle; retain the fixture and inspect process ownership")), SAMPLE_TIMEOUT_MS); })]);
    if (code !== 0 || overflow) return refuse();
    return output;
  } finally {
    clearTimeout(timer);
    await stopOwnedProcess(child, { group: true });
  }
}

const BACKUP = `import pathlib,sqlite3,sys
source,dest=sys.argv[1:]
a=sqlite3.connect(pathlib.Path(source).resolve().as_uri()+'?mode=ro',uri=True,timeout=3)
b=sqlite3.connect(dest,timeout=3)
try:a.backup(b)
finally:b.close();a.close()
`;
async function backup(source: string, destination: string, env: NodeJS.ProcessEnv): Promise<void> {
  const python = Bun.which("python3", { PATH: env.PATH }); if (!python) return refuse();
  await ownedCommand([python, "-I", "-c", BACKUP, source, destination], dirname(destination), env);
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
    await backup(sourceDb, join(destination, "hub.db"), env);
    copyEventPrefix(join(source, "events.jsonl"), join(destination, "events.jsonl"));
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
  const events = readFileSync(join(destination, "events.jsonl"));
  const abandoned = readdirSync(destination).filter(name => /^restart\.abandoned\./.test(name)).map(name => statSync(join(destination, name)).size);
  return { ...databaseProfile(join(destination, "hub.db")), eventBytes: events.length, eventLines: events.reduce((n, byte) => n + Number(byte === 10), 0),
    abandonedFiles: abandoned.length, abandonedBytes: abandoned.reduce((a, b) => a + b, 0), abandonedMaxBytes: Math.max(0, ...abandoned) };
}

function project(root: string, env: NodeJS.ProcessEnv): void {
  for (const args of [["init", "-q"], ["-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "fixture"]]) {
    const run = hubGitSync(["-C", root, ...args], { env, encoding: "utf8", timeout: SAMPLE_TIMEOUT_MS }); if (run.status !== 0) return refuse();
  }
}
async function child(root: string, env: NodeJS.ProcessEnv): Promise<ChildObservation> {
  const started = performance.now(); let ready: { timing: string; importAndStartupMs: number; eventReadBytes: number; abandonedReadBytes: number } | undefined, wallMs = 0;
  const raw = await ownedCommand([process.execPath, SCRIPT, "--child", root], root, env, undefined, line => {
    try {
      const value = JSON.parse(line);
      if (value.ready === 1 && !ready && value.effects === 0 && Number.isFinite(value.importAndStartupMs) && value.importAndStartupMs >= 0) {
        if (![value.eventReadBytes, value.abandonedReadBytes].every(n => Number.isSafeInteger(n) && n >= 0)) return;
        ready = { timing: timingLine(value.timing), importAndStartupMs: value.importAndStartupMs, eventReadBytes: value.eventReadBytes, abandonedReadBytes: value.abandonedReadBytes }; wallMs = performance.now() - started;
      }
    } catch { /* Non-protocol output is discarded, never forwarded. */ }
  });
  const last = JSON.parse(raw.trim().split("\n").at(-1) ?? "null") as { stopped?: number; effects?: number } | null;
  if (!ready || last?.stopped !== 1 || last.effects !== 0) return refuse();
  return { ...ready, wallMs, stopped: true, effects: 0 };
}
export async function runStartupBenchmark(options: BenchmarkOptions, ports: BenchmarkPorts = {}): Promise<Record<string, string | number>[]> {
  if (!Number.isInteger(options.samples) || options.samples < 1 || options.samples > MAX_PRIVATE_SAMPLES || options.mode === "private" && process.platform !== "darwin") return refuse();
  const profile = numericProfile(options.profile ?? REPRESENTATIVE_PROFILE), results: Record<string, string | number>[] = [];
  if (options.mode === "private" && (!options.privateState || !lstatSync(options.privateState).isDirectory())) return refuse();
  const baseline = options.mode === "synthetic" ? mkdtempSync(join(tmpdir(), "ahub-startup-1232-baseline-")) : undefined;
  let baselineStopped = false;
  try {
    if (baseline) {
      chmodSync(baseline, 0o700); const env = isolatedStartupEnvironment(baseline), state = join(baseline, "state"); mkdirSync(state, { mode: 0o700 });
      await (ports.prepare ?? prepareState)(undefined, state, profile, env); baselineStopped = true;
    }
    for (let sample = 0; sample < options.samples; sample++) {
      const attempt = options.mode === "private" ? reservePrivateAttempt(join(tmpdir(), "ahub-startup-1232-attempts.sqlite")) : sample + 1;
      const root = mkdtempSync(join(tmpdir(), "ahub-startup-1232-")); chmodSync(root, 0o700);
      let stopped = true;
      try {
        const env = isolatedStartupEnvironment(root), cwd = join(root, "project"), state = join(root, "state");
        mkdirSync(cwd, { mode: 0o700 }); mkdirSync(state, { mode: 0o700 });
        stopped = false;
        (ports.project ?? project)(cwd, env);
        const sizes = numericProfile(await (ports.prepare ?? prepareState)(baseline ? join(baseline, "state") : options.privateState, state, profile, env));
        stopped = false;
        const observation = await (ports.child ?? child)(root, env); stopped = observation.stopped;
        if (!stopped || observation.effects !== 0) return refuse();
        if (options.acceptance && (observation.wallMs >= 5000 || observation.abandonedReadBytes > 0 || sizes.eventBytes > 0 && observation.eventReadBytes >= sizes.eventBytes)) return refuse();
        results.push({ synthetic: Number(options.mode === "synthetic"), sample: attempt, ...sizes, wallMs: Math.round(observation.wallMs),
          ...(observation.importAndStartupMs === undefined ? {} : { importAndStartupMs: Math.round(observation.importAndStartupMs) }), timing: timingLine(observation.timing), effects: observation.effects, eventReadBytes: observation.eventReadBytes, abandonedReadBytes: observation.abandonedReadBytes });
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
  const { Board } = await import("../../src/hub/board.ts");
  const { DeliveryJournal } = await import("../../src/hub/delivery-journal.ts");
  const dbFile = join(destination, "hub.db"), board = new Board(dbFile);
  for (let n = 0; n < profile.taskRows; n++) {
    const bytes = Math.floor(profile.taskTextBytes / profile.taskRows) + Number(n < profile.taskTextBytes % profile.taskRows);
    const title = "synthetic".slice(0, bytes);
    board.propose("hub", { title, detail: "x".repeat(bytes - title.length), class: "implement", backlog: true });
  }
  board.close();
  const journal = new DeliveryJournal({ file: dbFile, projectRoot: join(dirname(destination), "project"), projectId: "synthetic-startup", instanceId: "synthetic-seed" }); journal.close();
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
  const events = openSync(join(destination, "events.jsonl"), "wx", 0o600);
  try {
    let written = 0;
    for (let n = 0; n < profile.eventLines; n++) {
      const target = Math.floor((profile.eventBytes - written) / (profile.eventLines - n));
      const line = syntheticEventLine(target, n);
      writeFileSync(events, line); written += Buffer.byteLength(line);
    }
  } finally { closeSync(events); }
  for (const [n, bytes] of abandonedSizes(profile).entries()) {
    const content = bytes >= 3 ? "{}" + " ".repeat(bytes - 3) + "\n" : bytes === 2 ? "{}" : "\n".repeat(bytes);
    writeFileSync(join(destination, `restart.abandoned.synthetic-${n}.json`), content, { mode: 0o600 });
  }
}

export async function installStartupReadObserver(stateDir: string): Promise<{ counts: { eventReadBytes: number; abandonedReadBytes: number }; restore(): void }> {
  const { syncBuiltinESMExports } = await import("node:module");
  const fs = (await import("node:fs")).default, descriptors = new Map<number, string>();
  const counts = { eventReadBytes: 0, abandonedReadBytes: 0 };
  const sourceName = (value: unknown): string | undefined => typeof value === "number" ? descriptors.get(value) : typeof value === "string" ? resolve(value) : undefined;
  const noteRead = (name: string | undefined, bytes: number) => {
    if (name === join(stateDir, "events.jsonl")) counts.eventReadBytes += bytes;
    if (name && dirname(name) === stateDir && /restart\.abandoned\.[^/]+\.json$/.test(name)) counts.abandonedReadBytes += bytes;
  };
  const originalOpen = fs.openSync, originalClose = fs.closeSync, originalRead = fs.readSync, originalReadFile = fs.readFileSync;
  (fs as any).openSync = (...args: any[]) => { const fd = (originalOpen as any)(...args), name = sourceName(args[0]); if (name) descriptors.set(fd, name); return fd; };
  fs.closeSync = fd => { descriptors.delete(fd); originalClose(fd); };
  (fs as any).readSync = (...args: any[]) => { const n = (originalRead as any)(...args); noteRead(sourceName(args[0]), n); return n; };
  (fs as any).readFileSync = (...args: any[]) => {
    const name = sourceName(args[0]), data = (originalReadFile as any)(...args);
    noteRead(name, typeof data === "string" ? Buffer.byteLength(data) : data.byteLength); return data;
  };
  syncBuiltinESMExports();
  return { counts, restore: () => { fs.openSync = originalOpen; fs.closeSync = originalClose; fs.readSync = originalRead; fs.readFileSync = originalReadFile; syncBuiltinESMExports(); } };
}

/** Isolated child only: deny effects before importing the composition root. */
async function measure(root: string): Promise<void> {
  const importedAt = performance.now(), cwd = join(root, "project"), stateDir = join(root, "state");
  let effects = 0;
  const deny = () => { effects++; return refuse(); };
  if (process.env.AHUB_STARTUP_BENCHMARK_CHILD !== "1" || process.env.HOME !== join(root, "home") || process.env.AGENTHUB_HOME !== join(root, "agenthub_home")) return refuse();
  globalThis.fetch = Object.assign(deny, { preconnect: deny });
  globalThis.WebSocket = class { constructor() { deny(); } } as unknown as typeof WebSocket;
  Bun.connect = deny as typeof Bun.connect;
  const cp = (await import("node:child_process")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const allowed = (command: unknown, args: unknown): boolean => {
    if (typeof command !== "string" || !Array.isArray(args)) return false;
    // The pinned portable helper deliberately invokes git/realpath by basename. Resolve only these closed names in the isolated fixed PATH.
    const executable = ["git", "ps", "realpath"].includes(command) ? Bun.which(command, { PATH: process.env.PATH }) ?? "" : command;
    if (["/bin/ps", "/usr/bin/ps", "/bin/realpath", "/usr/bin/realpath"].includes(executable)) return true;
    if (!["/usr/bin/git", "/bin/git"].includes(executable)) return false;
    const words = [...args] as string[];
    while (words.length && words[0]!.startsWith("-")) { const option = words.shift(); if (option === "-c" || option === "-C" || option === "--git-dir" || option === "--work-tree") words.shift(); }
    const verb = words.shift();
    return ["rev-parse", "ls-files", "status", "show-ref", "symbolic-ref", "diff", "log", "reflog", "cat-file", "for-each-ref"].includes(verb ?? "")
      || verb === "config" && words.some(word => ["--get", "--get-all", "--get-regexp", "--list"].includes(word))
      || verb === "worktree" && words[0] === "list";
  };
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"] as const) {
    const original = cp[name] as (...args: any[]) => any;
    (cp as any)[name] = (command: unknown, args: unknown, ...rest: unknown[]) => allowed(command, args) ? original(command, args, ...rest) : deny();
  }
  for (const name of ["exec", "execSync", "fork"] as const) (cp as any)[name] = deny;
  syncBuiltinESMExports();
  for (const specifier of ["node:http", "node:https", "node:net", "node:tls", "node:dgram", "node:dns"]) {
    const mod = (await import(specifier)).default;
    for (const key of ["request", "get", "connect", "createConnection", "createSocket", "lookup", "resolve", "resolve4", "resolve6"]) if (typeof mod[key] === "function") mod[key] = deny;
    if (mod.Socket) mod.Socket.prototype.connect = deny;
  }
  syncBuiltinESMExports();
  const observer = await installStartupReadObserver(stateDir), io = observer.counts;
  const nativeSpawn = Bun.spawn, nativeSpawnSync = Bun.spawnSync;
  const bunAllowed = (value: any) => { const argv = Array.isArray(value) ? value : value?.cmd; return Array.isArray(argv) && allowed(argv[0], argv.slice(1)); };
  Bun.spawn = ((value: any, options: any) => bunAllowed(value) ? nativeSpawn(value, options) : deny()) as typeof Bun.spawn;
  Bun.spawnSync = ((value: any, options: any) => bunAllowed(value) ? nativeSpawnSync(value, options) : deny()) as typeof Bun.spawnSync;
  const { startDaemon, DEFAULT_CONFIG } = await import("../../src/hub/daemon.ts");
  const { ADAPTERS } = await import("../../src/adapters/registry.ts");
  const db = new Database(join(stateDir, "hub.db")); db.run(`PRAGMA busy_timeout = ${LEDGER_BUSY_TIMEOUT_MS}`);
  const rows = db.query("SELECT project_id FROM delivery_meta LIMIT 2").all() as { project_id: string }[];
  if (rows.length > 1) { db.close(); return refuse(); }
  const row = rows[0];
  // Rebind only the disposable copy's project path; no live descriptor/leadership file is copied or read.
  db.query("UPDATE delivery_meta SET project_root=?").run(cwd); db.close();
  const daemon = await startDaemon({ cwd, stateDir, projectId: row?.project_id ?? "synthetic-startup", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
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
  try {
    if (daemon.bus.peers.size !== 0 || effects !== 0) return refuse();
    const lines = readFileSync(join(stateDir, "hub.log"), "utf8").split("\n").filter(line => line.includes("startup timings ms: "));
    if (lines.length !== 1) return refuse();
    const timing = timingLine(lines[0]!.slice(lines[0]!.indexOf("startup timings ms: ")));
    await new Promise<void>(done => process.stdout.write(JSON.stringify({ timing, importAndStartupMs, ready: 1, effects, ...io }) + "\n", () => done()));
    await daemon.stop();
    if (effects !== 0) return refuse();
    process.stdout.write(JSON.stringify({ stopped: 1, effects }) + "\n");
  } finally { await daemon.stop(); }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === "--seed" && process.env.AHUB_STARTUP_BENCHMARK_CHILD === "1") await seedStartupFixture(args[1]!);
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
      const results = await runStartupBenchmark({ mode: privateState ? "private" : "synthetic", privateState: privateState ? resolve(privateState) : undefined,
        acceptance: args.includes("--acceptance"), samples: Number(value("--samples") ?? 1), profile: profileFile ? numericProfile(JSON.parse(readFileSync(profileFile, "utf8"))) : undefined });
      for (const result of results) process.stdout.write(JSON.stringify(result) + "\n");
    }
  } catch { process.stderr.write("startup benchmark did not complete; inspect its isolated configuration and numeric profile before another authorized attempt\n"); process.exitCode = 1; }
}
