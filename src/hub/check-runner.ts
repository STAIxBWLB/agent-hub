import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { hubGitEnv, hubGitSync } from "./git.ts";
import { hostExecutable } from "./host-executable.ts";
import { PreEffectToolRefusal } from "./tool-refusal.ts";
import { processLiveness, processSignature } from "../pi/process-signature.ts";

export const CHECK_IMAGE = "oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895";
const NETWORK = "agenthub-check";
const DAY = 86_400_000;
const MAX_OUTPUT = 1_048_576;
export interface RunnerState { available: boolean; reason?: string; platform?: string; checkedAt?: number }
export interface CheckRequest {
  task: number; owner: string; generation: number | string; updated: number | string;
  /** Internal board history revision, never part of an agent receipt projection. */
  revision?: number;
  ref: string; check: "test" | "typecheck"; files?: string[];
}
export interface RunReceipt extends CheckRequest {
  run: string; sha: string; tree: string; lockfile: string; excluded: number; dependency_files: number;
  runner: "container"; image: string; platform: string; container: string;
  hub_pid: number; hub_signature: string; created: number;
  status: "queued" | "running" | "finished" | "stale";
  exit: number | null; timed_out: boolean; cancelled: boolean; interrupted: boolean;
  duration_ms: number; tail: string; output_bytes: number; truncated: boolean; output_withheld: boolean;
  error?: string;
}
export interface RunHandle { run: string; done: Promise<RunReceipt> }
export interface CommandResult { code: number | null; stdout: string }
/** Fixed-argv transport seam. The production implementation below is the only container spawner. */
export type ContainerCommand = (args: string[], options?: { signal?: AbortSignal; timeoutMs?: number; output?: (data: Buffer) => void }) => Promise<CommandResult>;
export interface RunnerOptions {
  projectDir: string; stateDir: string; storageDir: string; projectKey: string;
  enabled: boolean | (() => boolean); isDenied: (path: string) => boolean;
  onResult?: (receipt: RunReceipt) => void | Promise<void>;
  /** Daemon authority fence, re-evaluated across every asynchronous stage. */
  isCurrent?: (request: CheckRequest) => boolean;
  /** Test seams; never supplied from a tool request or config. */
  command?: ContainerCommand; timeoutMs?: number; lockWaitMs?: number; lockPollMs?: number;
  schedule?: (callback: () => void, ms: number) => () => void;
  now?: () => number; liveness?: typeof processLiveness; signature?: typeof processSignature;
}
interface Entry { receipt: RunReceipt; resolve: (receipt: RunReceipt) => void; abort: AbortController }
function safePath(path: string): boolean {
  return !!path && !isAbsolute(path) && !path.includes("\\") && !path.includes("\0") && path.split("/").every(p => p !== ".." && p !== "." && p !== "");
}
function hash(data: Uint8Array): string { return createHash("sha256").update(data).digest("hex"); }
function isolatedNetwork(stdout: string): boolean {
  try {
    const value: unknown = JSON.parse(stdout);
    return Array.isArray(value) && value.length === 1 && value[0]?.id === NETWORK && value[0]?.configuration?.name === NETWORK && value[0]?.configuration?.mode === "hostOnly";
  } catch { return false; }
}
function tail(text: string, truncated = false): string {
  const lines = text.trimEnd().split("\n");
  let result = lines.slice(-40).join("\n");
  const cut = truncated || lines.length > 40 || Buffer.byteLength(result) > 4096;
  while (Buffer.byteLength(result) > (cut ? 4090 : 4096)) result = result.slice(1);
  return cut ? `[cut]\n${result}` : result;
}
function runContainer(executable: string, args: string[], options: { signal?: AbortSignal; timeoutMs?: number; output?: (data: Buffer) => void } = {}): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    // No host shell or inherited agent credentials. Only the container client connects to its service.
    const env = { PATH: dirname(executable), HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
    const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), Math.max(1, Math.min(600_000, options.timeoutMs ?? 15_000)));
    const abort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (data: Buffer) => { if (options.output) options.output(data); else stdout = (stdout + data.toString()).slice(-1_048_576); });
    child.stderr.on("data", (data: Buffer) => { options.output?.(data); });
    child.once("error", () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); reject(new Error("container unavailable")); });
    child.once("close", code => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); resolveResult({ code, stdout }); });
  });
}

/** Hub-owned immutable source checks. Authority and current-policy output screening stay in the daemon. */
export class ContainerRunner {
  private readonly command: ContainerCommand;
  private readonly entries = new Map<string, Entry>();
  private readonly queue: Entry[] = [];
  private active?: Entry;
  private closing = false;
  private readonly probes = new Map<AbortController, Promise<RunnerState>>();
  private availableCache?: { at: number; value: RunnerState };
  private readonly now: () => number;
  private readonly signature: string;
  private common = "";
  private readonly records: string;
  private readonly root: string;
  private readonly retentionTimer: ReturnType<typeof setInterval>;
  constructor(private readonly options: RunnerOptions) {
    if (!/^[A-Za-z0-9_-]+$/.test(options.projectKey)) throw new Error("invalid project key");
    this.command = options.command ?? (async (args, opts) => runContainer(hostExecutable("container", options.projectDir), args, opts));
    this.now = options.now ?? Date.now;
    this.signature = (options.signature ?? processSignature)(process.pid) ?? "";
    this.records = join(options.stateDir, "checks");
    this.root = join(options.storageDir, options.projectKey);
    this.retentionTimer = setInterval(() => { void this.retain().catch(() => {}); }, 60_000);
    this.retentionTimer.unref();
  }
  private gitEnv(): NodeJS.ProcessEnv {
    return hubGitEnv({ ...process.env, PATH: dirname(hostExecutable("git", this.options.projectDir)) }, { repositoryIsolation: true });
  }
  private git(args: string[]): string {
    const result = hubGitSync(["-C", this.options.projectDir, ...args], { encoding: "utf8", env: this.gitEnv(), maxBuffer: 64 * 1024 * 1024, timeout: 15_000 });
    if (result.status !== 0 || result.error) throw new Error("source unavailable");
    return result.stdout;
  }
  private enabled(): boolean { return typeof this.options.enabled === "function" ? this.options.enabled() : this.options.enabled; }
  async available(signal?: AbortSignal): Promise<RunnerState> {
    if (this.closing) return { available: false, reason: "stopping" };
    if (!this.enabled()) return { available: false, reason: "not enabled" };
    if (!this.signature) return { available: false, reason: "hub identity unavailable" };
    if (!this.common) {
      try { this.common = this.git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(); } catch { return { available: false, reason: "git source unavailable" }; }
    }
    if (this.availableCache && this.now() - this.availableCache.at < 60_000) return this.availableCache.value;
    const abort = new AbortController(), cancelled = () => abort.abort();
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) abort.abort();
    const pending = Promise.resolve().then(() => this.probeAvailability(abort.signal)).finally(() => {
      signal?.removeEventListener("abort", cancelled); this.probes.delete(abort);
    });
    this.probes.set(abort, pending);
    return pending;
  }
  private async probeAvailability(signal: AbortSignal): Promise<RunnerState> {
    let value: RunnerState;
    try {
      const probe = async (args: string[]) => {
        if (this.closing || signal.aborted) throw new Error("check stopped");
        const result = await this.command(args, { signal, timeoutMs: 15_000 });
        if (this.closing || signal.aborted) throw new Error("check stopped");
        return result;
      };
      const version = await probe(["--version"]);
      const service = await probe(["system", "status"]);
      const image = await probe(["image", "inspect", CHECK_IMAGE]);
      const network = await probe(["network", "inspect", NETWORK]);
      value = version.code !== 0 || service.code !== 0 || image.code !== 0
        ? { available: false, reason: "service or pinned image unavailable" }
        : network.code !== 0 && network.code !== 1
          ? { available: false, reason: "network inspection unavailable" }
          : network.code === 0 && !isolatedNetwork(network.stdout)
          ? { available: false, reason: "network isolation unverified" }
          : { available: true, platform: `linux/arm64 (apple-container ${version.stdout.trim().slice(0, 80)})` };
    } catch { if (this.closing || signal.aborted) return { available: false, reason: this.closing ? "stopping" : "check stopped" }; value = { available: false, reason: "container unavailable" }; }
    const checkedAt = this.now();
    value.checkedAt = checkedAt;
    this.availableCache = { at: checkedAt, value };
    return value;
  }
  start(request: CheckRequest): RunHandle {
    if (this.closing) throw new Error("runner unavailable: stopping");
    if (!this.enabled()) throw new Error("runner unavailable: not enabled");
    if (!Number.isSafeInteger(request.task) || request.task <= 0 || !request.owner || !["test", "typecheck"].includes(request.check) || !request.ref || request.ref.startsWith("-")) throw new Error("invalid check request");
    if (request.check === "test" && (!Array.isArray(request.files) || request.files.length < 1 || request.files.length > 32 || request.files.some(p => typeof p !== "string" || !/^test\/[A-Za-z0-9._/-]+\.test\.ts$/.test(p) || !safePath(p)))) throw new Error("invalid test files");
    if (request.check === "typecheck" && request.files?.length) throw new Error("typecheck takes no files");
    if (this.entries.size >= 3) throw new PreEffectToolRefusal("busy");
    const run = randomUUID();
    const receipt: RunReceipt = { ...request, files: request.files ? [...request.files] : undefined, run, sha: "", tree: "", lockfile: "", excluded: 0, dependency_files: 0,
      runner: "container", image: CHECK_IMAGE, platform: "linux/arm64 (apple-container unknown)", container: `agenthub-check-${run}`, hub_pid: process.pid, hub_signature: this.signature, created: this.now(), status: "queued", exit: null,
      timed_out: false, cancelled: false, interrupted: false, duration_ms: 0, tail: "", output_bytes: 0, truncated: false, output_withheld: false };
    let resolveResult!: (receipt: RunReceipt) => void;
    const done = new Promise<RunReceipt>(r => { resolveResult = r; });
    const entry = { receipt, resolve: resolveResult, abort: new AbortController() };
    this.entries.set(run, entry); this.queue.push(entry);
    void this.drain();
    return { run, done };
  }
  get activeRun(): string | undefined { return this.active?.receipt.run; }
  get queuedRuns(): readonly string[] { return this.queue.map(entry => entry.receipt.run); }
  private current(request: CheckRequest): boolean {
    try { return this.options.isCurrent?.(request) !== false; } catch { return false; }
  }
  private ensureCurrent(entry: Entry): void {
    if (!this.current(entry.receipt)) { entry.receipt.status = "stale"; entry.abort.abort(); throw new Error("check binding stale"); }
  }
  async markStale(run: string): Promise<void> {
    const entry = this.entries.get(run);
    const receipt = entry?.receipt ?? await this.result(run);
    if (!receipt) return;
    receipt.status = "stale";
    entry?.abort.abort();
    await this.save(receipt);
    if (entry === this.active && entry) await this.cleanup(receipt.container);
  }
  private async save(receipt: RunReceipt): Promise<void> {
    await mkdir(this.records, { recursive: true, mode: 0o700 });
    const path = join(this.records, `${receipt.run}.json`);
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(receipt), { mode: 0o600 }); await rename(temp, path);
  }
  private async drain(): Promise<void> {
    if (this.active) return;
    const entry = this.queue.shift(); if (!entry) return;
    this.active = entry;
    try { await this.execute(entry); }
    finally { this.active = undefined; this.entries.delete(entry.receipt.run); entry.resolve({ ...entry.receipt }); void this.drain(); }
  }
  private async heavy(entry: Entry): Promise<() => Promise<void>> {
    const lock = join(this.common, "ahub-heavy.lock");
    const owner = `${process.pid} check-run ${entry.receipt.run} since ${this.now()} in ${this.options.projectDir}`;
    const until = Date.now() + (this.options.lockWaitMs ?? 1_800_000);
    while (true) {
      this.ensureCurrent(entry);
      if (entry.abort.signal.aborted) throw new Error("cancelled");
      try {
        await mkdir(lock);
        try { await writeFile(join(lock, "owner"), owner); } catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
        return async () => { if (await readFile(join(lock, "owner"), "utf8").catch(() => "") === owner) await rm(lock, { recursive: true, force: true }); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const holder = await readFile(join(lock, "owner"), "utf8").catch(() => "");
      const pid = Number(holder.split(" ")[0]);
      if (Number.isSafeInteger(pid) && pid > 0 && (this.options.liveness ?? processLiveness)(pid) === "gone") {
        // check.sh uses the same conservative pid-only legacy lock protocol.
        if (await readFile(join(lock, "owner"), "utf8").catch(() => "") === holder) await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= until) throw new Error("heavy slot held by another run");
      await new Promise<void>(r => { const finish = () => { clearTimeout(timer); entry.abort.signal.removeEventListener("abort", finish); r(); }; const timer = setTimeout(finish, this.options.lockPollMs ?? 10_000); entry.abort.signal.addEventListener("abort", finish, { once: true }); });
    }
  }
  private async snapshot(receipt: RunReceipt, src: string, signal: AbortSignal, current: () => void): Promise<void> {
    const check = () => { current(); if (signal.aborted) throw new Error("check stopped"); };
    check();
    receipt.sha = this.git(["rev-parse", "--verify", `${receipt.ref}^{commit}`]).trim();
    if (!/^[a-f0-9]{40,64}$/.test(receipt.sha)) throw new Error("invalid source head");
    receipt.tree = this.git(["rev-parse", `${receipt.sha}^{tree}`]).trim();
    const entries = this.git(["ls-tree", "-r", "-z", receipt.sha]).split("\0").filter(Boolean);
    if (entries.length > 100_000) throw new Error("source exceeds file limit");
    const parsed = entries.map(entry => {
      const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
      if (!match || !safePath(match[4]!)) throw new Error("invalid source path");
      if (match[1] === "120000" || match[1] === "160000") throw new Error("source has a symlink or submodule");
      if (match[2] !== "blob" || !["100644", "100755"].includes(match[1]!)) throw new Error("unsupported source entry");
      return { mode: match[1]!, oid: match[3]!, path: match[4]! };
    });
    // Refuse lossy staging on case-folding/normalizing hosts, independent of the current host's filesystem.
    // Include every directory prefix and denied entry before creating any staging directory or writing a blob.
    const foldedPaths = new Map<string, { spelling: string; directory: boolean }>();
    for (const entry of parsed) {
      const parts = entry.path.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const spelling = parts.slice(0, i).join("/"), directory = i < parts.length;
        // Upper/lower expansion conservatively includes Unicode multi-character case folds (e.g. sharp s).
        const folded = spelling.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
        const prior = foldedPaths.get(folded);
        if (prior && (prior.spelling !== spelling || prior.directory !== directory)) throw new Error("source path collision");
        foldedPaths.set(folded, { spelling, directory });
      }
    }
    let bytes = 0;
    const paths = new Set<string>();
    await mkdir(src, { recursive: true, mode: 0o700 }); check();
    for (const entry of parsed) {
      check();
      if (this.options.isDenied(entry.path)) { receipt.excluded++; continue; }
      if (entry.path === "node_modules" || entry.path.startsWith("node_modules/")) throw new Error("tracked dependencies refused");
      const data = hubGitSync(["-C", this.options.projectDir, "cat-file", "blob", entry.oid], { encoding: "buffer" as "utf8", env: this.gitEnv(), maxBuffer: 64 * 1024 * 1024, timeout: 15_000 });
      if (data.status !== 0 || data.error) throw new Error("source blob unavailable");
      const blob = Buffer.from(data.stdout);
      bytes += blob.length; if (bytes > 512 * 1024 * 1024) throw new Error("source exceeds byte limit");
      const dest = join(src, entry.path); await mkdir(dirname(dest), { recursive: true }); check(); await writeFile(dest, blob, { mode: entry.mode === "100755" ? 0o700 : 0o600 }); check(); paths.add(entry.path);
    }
    if (receipt.files?.some(file => !paths.has(file))) throw new Error("test file unavailable in snapshot");
    if (!paths.has("bun.lock")) throw new Error("lockfile unavailable");
    const lock = await readFile(join(src, "bun.lock")); check();
    const hostLock = await this.regularFile(join(this.options.projectDir, "bun.lock")); check();
    receipt.lockfile = hash(lock);
    if (receipt.lockfile !== hash(hostLock)) throw new Error("lockfile differs; dependencies unavailable");
    const deps = join(this.options.projectDir, "node_modules");
    const dest = join(src, "node_modules");
    let count = 0, size = 0;
    const walk = async (path: string): Promise<void> => {
      check();
      if (++count > 100_000) throw new Error("dependencies exceed file limit");
      if (this.options.isDenied(`node_modules/${path}`)) throw new Error("dependencies contain a denied path");
      const source = join(deps, path), target = join(dest, path);
      const st = await lstat(source); check();
      if (st.isSymbolicLink()) {
        const link = await readlink(source); check();
        const resolved = relative(deps, resolve(dirname(source), link));
        if (isAbsolute(link) || resolved === ".." || resolved.startsWith(`../`) || !resolved) throw new Error("dependencies contain an escaping symlink");
        await symlink(link, target); check();
      } else if (st.isDirectory()) {
        await mkdir(target, { recursive: true }); check();
        for (const name of await readdir(source)) { if (!safePath(name)) throw new Error("invalid dependency path"); await walk(path ? `${path}/${name}` : name); }
      } else if (st.isFile()) {
        size += st.size; if (size > 1024 * 1024 * 1024) throw new Error("dependencies exceed byte limit");
        const data = await this.regularFile(source); check(); await writeFile(target, data, { mode: (st.mode & 0o111) ? 0o700 : 0o600 }); check();
      } else throw new Error("dependencies contain a special file");
      const after = await lstat(source); check();
      if (after.ino !== st.ino || after.dev !== st.dev || after.mtimeMs !== st.mtimeMs || after.size !== st.size) throw new Error("dependencies changed during copy");
    };
    await walk(""); receipt.dependency_files = count;
    if (receipt.lockfile !== hash(await this.regularFile(join(this.options.projectDir, "bun.lock")))) throw new Error("lockfile changed during copy");
  }
  private async regularFile(path: string): Promise<Buffer> {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("unsafe dependency file");
      const data = readFileSync(fd); const after = fstatSync(fd);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || data.length !== stat.size) throw new Error("dependency file changed during copy");
      return data;
    } finally { closeSync(fd); }
  }
  private async execute(entry: Entry): Promise<void> {
    const r = entry.receipt, begun = this.now(), dir = join(this.root, r.run), src = join(dir, "src");
    let release: (() => Promise<void>) | undefined, cancelDeadline: (() => void) | undefined;
    let output = Buffer.alloc(0), outputTail = Buffer.alloc(0), attemptedContainer = false;
    try {
      this.ensureCurrent(entry);
      await this.save(r); this.ensureCurrent(entry);
      const state = await this.available(entry.abort.signal); this.ensureCurrent(entry); if (!state.available) throw new Error(`runner unavailable: ${state.reason}`);
      r.platform = state.platform!;
      release = await this.heavy(entry); this.ensureCurrent(entry);
      if (entry.abort.signal.aborted) throw new Error("cancelled");
      const timeout = Math.max(1, Math.min(600_000, this.options.timeoutMs ?? 600_000)), deadline = this.now() + timeout;
      const expire = () => { r.timed_out = true; entry.abort.abort(); void this.cleanup(r.container); };
      const schedule = this.options.schedule ?? ((callback: () => void, ms: number) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); });
      cancelDeadline = schedule(expire, timeout);
      const checkRunning = () => {
        this.ensureCurrent(entry);
        if (!entry.abort.signal.aborted && this.now() >= deadline) expire();
        if (entry.abort.signal.aborted) throw new Error("check stopped");
      };
      const command = async (args: string[], limit = 15_000, output?: (data: Buffer) => void) => {
        checkRunning();
        const result = await this.command(args, { signal: entry.abort.signal, timeoutMs: Math.min(limit, deadline - this.now()), ...(output ? { output } : {}) });
        checkRunning(); // A transport may return success after cancellation; it cannot authorize another stage.
        return result;
      };
      await this.snapshot(r, src, entry.abort.signal, checkRunning);
      this.ensureCurrent(entry);
      if (entry.abort.signal.aborted) throw new Error("cancelled");
      const network = await command(["network", "inspect", NETWORK]); this.ensureCurrent(entry);
      if (network.code !== 0 && (await command(["network", "create", "--internal", NETWORK])).code !== 0) throw new Error("runner unavailable: internal network unavailable");
      this.ensureCurrent(entry);
      // Refuse an existing non-internal network rather than trusting its name.
      const info = await command(["network", "inspect", NETWORK]); this.ensureCurrent(entry);
      if (info.code !== 0 || !isolatedNetwork(info.stdout)) throw new Error("runner unavailable: network isolation unverified");
      r.status = "running"; await this.save(r); this.ensureCurrent(entry);
      attemptedContainer = true;
      // Cold VM startup and a <=1.5 GiB source/dependency transfer need their own bounded allowances.
      const run = await command(["run", "--detach", "--rm", "--name", r.container, "--label", `agenthub.project=${this.options.projectKey}`, "--label", `agenthub.hub=${process.pid}:${this.signature}`, "--label", `agenthub.run=${r.run}`, "--network", NETWORK, "--no-dns", "--cpus", "2", "--memory", "4g", "--workdir", "/work", CHECK_IMAGE, "sleep", "600"], 120_000);
      this.ensureCurrent(entry);
      if (run.code !== 0) throw new Error("runner unavailable: container start failed");
      const copy = await command(["cp", `${src}/.`, `${r.container}:/work`], 180_000);
      this.ensureCurrent(entry);
      if (copy.code !== 0) throw new Error("container source transfer failed");
      if (entry.abort.signal.aborted) throw new Error("cancelled");
      const words = r.check === "test" ? ["bun", "test", ...r.files!] : ["bun", "x", "--no-install", "tsc", "--noEmit"];
      const result = await command(["exec", "--workdir", "/work", r.container, ...words], 600_000, data => {
        r.output_bytes += data.length;
        if (output.length < MAX_OUTPUT) output = Buffer.concat([output, data.subarray(0, MAX_OUTPUT - output.length)]);
        outputTail = Buffer.concat([outputTail, data]).subarray(-16_384);
        r.truncated = r.output_bytes > MAX_OUTPUT;
      });
      this.ensureCurrent(entry);
      r.exit = entry.abort.signal.aborted ? null : result.code;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      r.error = entry.abort.signal.aborted ? "check stopped" : code ? "check filesystem or runtime unavailable" : error instanceof Error ? error.message : "check unavailable";
    }
    finally {
      cancelDeadline?.();
      // Teardown has separate bounded commands so an expired check can still prove container removal.
      const removed = !attemptedContainer || await this.cleanup(r.container);
      if (!removed) { r.error = "container cleanup unconfirmed; heavy slot retained"; r.exit = null; }
      await rm(src, { recursive: true, force: true }).catch(() => {});
      if (release && removed) await release().catch(() => {});
      r.duration_ms = Math.max(0, this.now() - begun); r.tail = tail(outputTail.toString("utf8"), r.output_bytes > outputTail.length); if (r.status !== "stale") r.status = "finished";
      if (!this.current(r)) { r.status = "stale"; }
      try { await mkdir(dir, { recursive: true, mode: 0o700 }); await writeFile(join(dir, "output.log"), r.truncated ? Buffer.concat([output.subarray(0, MAX_OUTPUT - 7), Buffer.from("\n[cut]\n")]) : output, { mode: 0o600 }); await this.save(r); await this.retain(); } catch { r.error = "check receipt storage unavailable"; r.tail = ""; r.output_withheld = true; }
      if (!this.current(r)) { r.status = "stale"; await this.save(r).catch(() => {}); }
      try { if (r.status !== "stale") await this.options.onResult?.({ ...r }); } catch { /* A notice cannot retry a completed check. */ }
    }
  }
  private async cleanup(name: string): Promise<boolean> {
    await this.command(["kill", name]).catch(() => {});
    await this.command(["rm", name]).catch(() => {});
    try {
      const list = await this.command(["list", "--all", "--format", "json"]);
      if (list.code !== 0) return false;
      const entries: unknown = JSON.parse(list.stdout);
      return Array.isArray(entries) && !entries.some(c => c?.id === name || c?.configuration?.id === name);
    } catch { return false; }
  }
  async result(run: string): Promise<RunReceipt | undefined> {
    if (!/^[a-f0-9-]{36}$/.test(run)) return undefined;
    const live = this.entries.get(run); if (live) return { ...live.receipt };
    try {
      const r = JSON.parse(await readFile(join(this.records, `${run}.json`), "utf8")) as RunReceipt;
      if (!r || r.run !== run || r.container !== `agenthub-check-${run}` || !Number.isFinite(r.created) || !Number.isSafeInteger(r.hub_pid) || r.hub_pid <= 0 || typeof r.hub_signature !== "string" || !["queued", "running", "finished", "stale"].includes(r.status)) throw new Error("invalid receipt");
      return r;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      throw new Error("check receipt unavailable");
    }
  }
  async consumeOutput(run: string): Promise<void> { if (/^[a-f0-9-]{36}$/.test(run)) await rm(join(this.root, run, "output.log"), { force: true }); }
  async cancel(run: string): Promise<void> {
    const entry = this.entries.get(run); if (!entry) return;
    entry.receipt.cancelled = true; entry.abort.abort();
    const queued = this.queue.indexOf(entry);
    if (queued >= 0) {
      // No VM or heavy slot exists for a queued run. Settle it independently of the active run.
      this.queue.splice(queued, 1); this.entries.delete(run);
      const receipt = entry.receipt;
      receipt.status = receipt.status === "stale" || !this.current(receipt) ? "stale" : "finished";
      receipt.duration_ms = Math.max(0, this.now() - receipt.created);
      receipt.error = "check cancelled before start";
      try { await this.save(receipt); }
      catch { receipt.error = "check receipt storage unavailable"; receipt.output_withheld = true; }
      if (!this.current(receipt) && receipt.status !== "stale") { receipt.status = "stale"; await this.save(receipt).catch(() => {}); }
      entry.resolve({ ...receipt });
      try { if (receipt.status !== "stale") await this.options.onResult?.({ ...receipt }); } catch { /* A saved cancellation is never retried. */ }
      return;
    }
    if (entry === this.active) await this.cleanup(entry.receipt.container);
  }
  async stopAll(): Promise<void> {
    this.closing = true; clearInterval(this.retentionTimer);
    for (const abort of this.probes.keys()) abort.abort();
    for (const entry of this.entries.values()) { entry.receipt.interrupted = true; entry.abort.abort(); }
    if (this.active) await this.cleanup(this.active.receipt.container);
    await Promise.allSettled([...this.probes.values()]);
    while (this.entries.size) await new Promise(r => setTimeout(r, 5));
  }
  async sweep(): Promise<string[]> {
    const unknown: string[] = [];
    if (!this.enabled()) { await this.retain(); return unknown; }
    let containers: unknown;
    try { const list = await this.command(["list", "--all", "--format", "json"]); if (list.code !== 0) return unknown; containers = JSON.parse(list.stdout); } catch { return unknown; }
    if (!Array.isArray(containers)) return unknown;
    for (const container of containers) {
      const c = container as { id?: string; configuration?: { id?: string; labels?: Record<string, string> }; labels?: Record<string, string> };
      const labels = c.configuration?.labels ?? c.labels;
      if (labels?.["agenthub.project"] !== this.options.projectKey) continue;
      const name = c.configuration?.id ?? c.id;
      const run = labels["agenthub.run"];
      if (!name || !run || name !== `agenthub-check-${run}`) { unknown.push("orphan check: unknown owner"); continue; }
      const r = await this.result(run);
      if (!r || r.container !== name || !r.hub_signature || labels["agenthub.hub"] !== `${r.hub_pid}:${r.hub_signature}`) { unknown.push(`orphan check ${name}: unknown owner`); continue; }
      const liveness = (this.options.liveness ?? processLiveness)(r.hub_pid, r.hub_signature);
      if (liveness === "live") continue;
      if (liveness !== "gone") { unknown.push(`orphan check ${name}: unknown owner`); continue; }
      if (!await this.cleanup(name)) { unknown.push(`orphan check ${name}: cleanup unconfirmed`); continue; }
      r.interrupted = true; if (r.status !== "stale") r.status = "finished"; r.exit = null; r.tail = "";
      await rm(join(this.root, run, "src"), { recursive: true, force: true }); await this.save(r);
    }
    await this.retain(); return unknown;
  }
  private async retain(): Promise<void> {
    const names = await readdir(this.records).catch(() => []);
    const receipts: RunReceipt[] = [];
    for (const name of names) { if (!name.endsWith(".json")) continue; const r = await this.result(name.slice(0, -5)); if (r) receipts.push(r); }
    receipts.sort((a, b) => b.created - a.created);
    for (const [index, r] of receipts.entries()) {
      if (this.entries.has(r.run)) continue;
      if (index >= 200) await rm(join(this.records, `${r.run}.json`), { force: true });
      if (this.now() - r.created >= DAY) await rm(join(this.root, r.run), { recursive: true, force: true });
      else if (index >= 20) await this.consumeOutput(r.run);
    }
    // A crash before a receipt rename must not retain an unindexed staging directory forever.
    for (const name of await readdir(this.root).catch(() => [])) {
      if (!/^[a-f0-9-]{36}$/.test(name) || this.entries.has(name)) continue;
      const path = join(this.root, name); const st = await lstat(path);
      if (this.now() - st.mtimeMs >= DAY) await rm(path, { recursive: true, force: true });
    }
  }
}
