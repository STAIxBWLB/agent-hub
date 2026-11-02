#!/usr/bin/env bun
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Task, type TaskState } from "../../src/hub/board.ts";
import { ControlClient } from "../../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../../src/hub/daemon.ts";
import { newEnvelope, USER, type Envelope } from "../../src/hub/envelope.ts";
import { BasePeer } from "../../src/hub/peers.ts";
import { hubGitSync } from "../../src/hub/git.ts";
import { realPath } from "../../src/hub/project.ts";

const OUTPUT_SCHEMA = "agent-hub.control-write-latency/v1";
const MIB = 1024 * 1024;
let fixtureStage = "setup";
let fixtureFailure: Record<string, unknown> | undefined;

/** A local, scripted delivery target, never a native Codex process or model. */
class SyntheticTaskPeer extends BasePeer {
  constructor() { super("codex"); }
  async start(): Promise<void> { this.setState("idle"); }
  async stop(): Promise<void> { this.setState("offline"); }
  async deliver(_envs: Envelope[], id?: string): Promise<void> {
    if (id) { this.delivery({ id, state: "accepted" }); this.delivery({ id, state: "completed" }); }
  }
}

interface Options { smoke: boolean; iterations: number }
interface Counters { listCalls: number; listRows: number; listMs: number; writeCalls: number; writeMs: number; completeCalls: number; completeMs: number }
interface Sample { ms: number; ok: boolean | null; outcome: string; state?: string; owner?: string | null; counters: Counters }
interface Phase { name: string; samples: Sample[] }

function parseArgs(argv: string[]): Options {
  let smoke = false, iterations: number | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--smoke") smoke = true;
    else if (arg === "--iterations") {
      const value = Number(argv[++index]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error("invalid iterations");
      iterations = value;
    } else if (arg === "--help") {
      process.stdout.write(`${JSON.stringify({ schema: OUTPUT_SCHEMA, usage: "bun scripts/benchmarks/control-write-latency.ts [--smoke] [--iterations 1..100]" })}\n`);
      process.exit(0);
    } else throw new Error("unknown argument");
  }
  return { smoke, iterations: iterations ?? (smoke ? 3 : 20) };
}

const emptyCounters = (): Counters => ({ listCalls: 0, listRows: 0, listMs: 0, writeCalls: 0, writeMs: 0, completeCalls: 0, completeMs: 0 });
const fileSize = (path: string): number => { try { return statSync(path).size; } catch { return 0; } };
const round = (value: number): number => Math.round(value * 100) / 100;

function percentiles(samples: Sample[]) {
  const values = samples.map(sample => sample.ms).sort((left, right) => left - right);
  const at = (p: number) => values.length ? round(values[Math.max(0, Math.ceil(values.length * p) - 1)]!) : null;
  const states: Record<string, number> = {}, outcomes: Record<string, number> = {};
  const totals = emptyCounters();
  for (const sample of samples) {
    outcomes[sample.outcome] = (outcomes[sample.outcome] ?? 0) + 1;
    if (sample.state) states[sample.state] = (states[sample.state] ?? 0) + 1;
    totals.listCalls += sample.counters.listCalls; totals.listRows += sample.counters.listRows; totals.listMs += sample.counters.listMs;
    totals.writeCalls += sample.counters.writeCalls; totals.writeMs += sample.counters.writeMs;
    totals.completeCalls += sample.counters.completeCalls; totals.completeMs += sample.counters.completeMs;
  }
  return { count: samples.length, p50Ms: at(0.5), p95Ms: at(0.95), outcomes, states,
    board: { listCalls: totals.listCalls, listRows: totals.listRows, listMs: round(totals.listMs), taskWriteCalls: totals.writeCalls, taskWriteMs: round(totals.writeMs), deliveryCompleteCalls: totals.completeCalls, deliveryCompleteMs: round(totals.completeMs) } };
}

function writeSyntheticEventLog(file: string, targetBytes: number): { bytes: number; rows: number } {
  const base = { v: 1, at: new Date().toISOString(), type: "task", id: 1, event: "synthetic benchmark event", by: "codex", state: "in_progress", owner: "codex", reviewer: "user", class: "implement", pii: false, padding: "" };
  const initial = Buffer.from(`${JSON.stringify(base)}\n`);
  const rowBytes = 512;
  const paddingBytes = rowBytes - initial.length;
  if (paddingBytes < 0) throw new Error("synthetic event row exceeds its bound");
  const row = Buffer.from(`${JSON.stringify({ ...base, padding: "x".repeat(paddingBytes) })}\n`);
  if (row.length !== rowBytes || targetBytes % rowBytes !== 0) throw new Error("synthetic event size is not row aligned");
  const rows = targetBytes / rowBytes, rowsPerChunk = 1024, chunk = Buffer.alloc(rowBytes * rowsPerChunk);
  for (let index = 0; index < rowsPerChunk; index++) row.copy(chunk, index * rowBytes);
  const fd = openSync(file, "w", 0o600);
  try {
    const chunks = Math.floor(rows / rowsPerChunk), tailRows = rows % rowsPerChunk;
    for (let index = 0; index < chunks; index++) writeAll(fd, chunk);
    if (tailRows) writeAll(fd, chunk.subarray(0, tailRows * rowBytes));
  } finally { closeSync(fd); }
  return { bytes: fileSize(file), rows };
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

function git(root: string, ...args: string[]): string {
  const result = hubGitSync(["-C", root, ...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 4 * MIB,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  if (result.status !== 0) throw new Error("fixture git command failed");
  return (result.stdout ?? "").trim();
}

function syntheticNote(task: number, index: number, bytes = 4096): string {
  const prefix = `Synthetic benchmark history ${index} for task ${task}. `;
  const prose = "This is synthetic task history for latency measurement, with no personal or project content. ";
  return prefix + prose.repeat(Math.ceil(bytes / prose.length)).slice(0, Math.max(0, bytes - Buffer.byteLength(prefix)));
}

function seedBoard(file: string, taskCount: number, reviewCount: number, historyNotes: number): number[] {
  const board = new Board(file), reviewIds: number[] = [];
  try {
    for (let index = 0; index < taskCount; index++) {
      const reviewing = index < reviewCount, backlog = !reviewing && index % 4 === 0;
      const task = board.propose(USER, { title: `synthetic benchmark task ${index}`, detail: "synthetic task metadata", class: "implement",
        refs: { paths: ["src/hub/bus.ts"] }, ...(backlog ? { backlog: true } : {}) });
      let note = 0;
      if (reviewing) {
        board.update(task.id, "codex", "accepted", { owner: "codex", reviewer: USER, state: "in_progress" }, syntheticNote(task.id, note++));
        board.update(task.id, "codex", "done", { state: "in_review" }, syntheticNote(task.id, note++));
        reviewIds.push(task.id);
      } else if (!backlog && index % 4 === 1) {
        board.update(task.id, USER, "assigned", { owner: "claude", reviewer: USER }, syntheticNote(task.id, note++));
      }
      while (note < historyNotes) board.update(task.id, "hub", `synthetic history ${note}`, {}, syntheticNote(task.id, note++));
    }
  } finally { board.close(); }
  return reviewIds;
}

function measureBoardMethods(daemon: Awaited<ReturnType<typeof startDaemon>>) {
  let active: Counters | undefined;
  const originalList = Board.prototype.list, originalUpdate = Board.prototype.update, originalPropose = Board.prototype.propose;
  const originalComplete = daemon.bus.completeDelivery;
  Board.prototype.list = function (this: Board, state?: TaskState) {
    const start = performance.now();
    try { const rows = originalList.call(this, state); if (active) { active.listCalls++; active.listRows += rows.length; active.listMs += performance.now() - start; } return rows; }
    catch (error) { if (active) { active.listCalls++; active.listMs += performance.now() - start; } throw error; }
  };
  Board.prototype.update = function (this: Board, ...args: Parameters<typeof originalUpdate>) {
    const start = performance.now();
    try { return originalUpdate.apply(this, args); }
    finally { if (active) { active.writeCalls++; active.writeMs += performance.now() - start; } }
  };
  Board.prototype.propose = function (this: Board, ...args: Parameters<typeof originalPropose>) {
    const start = performance.now();
    try { return originalPropose.apply(this, args); }
    finally { if (active) { active.writeCalls++; active.writeMs += performance.now() - start; } }
  };
  daemon.bus.completeDelivery = function (peer, id) {
    const start = performance.now();
    try { return originalComplete.call(this, peer, id); }
    finally { if (active) { active.completeCalls++; active.completeMs += performance.now() - start; } }
  };
  return {
    setActive(value: Counters | undefined) { active = value; },
    restore() { active = undefined; Board.prototype.list = originalList; Board.prototype.update = originalUpdate; Board.prototype.propose = originalPropose; daemon.bus.completeDelivery = originalComplete; },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error(`fixture readiness timeout: ${label}`);
}

async function main(options: Options): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "ahub-control-write-latency-")), projectPath = join(home, "project"), stateDir = join(home, "state"), privateHome = join(home, "home");
  let project = "";
  const originalEnv = new Map<string, string | undefined>(), remember = (key: string) => { if (!originalEnv.has(key)) originalEnv.set(key, process.env[key]); }, setEnv = (key: string, value?: string) => { remember(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  const clients: ControlClient[] = [], phases = new Map<string, Phase>(), taskRows = options.smoke ? Math.max(30, options.iterations * 2 + 4) : Math.max(600, options.iterations * 2 + 40);
  const historyNotes = options.smoke ? 3 : 12, eventTargetBytes = options.smoke ? 2 * MIB : 105 * MIB;
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, instrument: ReturnType<typeof measureBoardMethods> | undefined;
  try {
    mkdirSync(projectPath, { recursive: true });
    project = realPath(projectPath);
    for (const dir of [stateDir, privateHome, join(project, ".agenthub"), join(project, "src", "hub")]) mkdirSync(dir, { recursive: true });
    for (const key of Object.keys(process.env)) if (key.startsWith("ORCA_") || key.startsWith("AGENTHUB_") || key.startsWith("AMEM_") || key.startsWith("OMNIROUTE_")) setEnv(key, undefined);
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GITHUB_TOKEN", "GH_TOKEN"]) setEnv(key, undefined);
    setEnv("GIT_CONFIG_GLOBAL", "/dev/null"); setEnv("GIT_CONFIG_NOSYSTEM", "1");
    setEnv("HOME", privateHome); setEnv("AGENTHUB_HOME", join(privateHome, "agenthub")); setEnv("AMEM_HOME", join(privateHome, "amem"));
    setEnv("CLAUDE_CONFIG_DIR", join(privateHome, "claude")); setEnv("CODEX_HOME", join(privateHome, "codex")); setEnv("KIMI_CODE_HOME", join(privateHome, "kimi"));
    for (const path of [process.env.AGENTHUB_HOME!, process.env.AMEM_HOME!, process.env.CLAUDE_CONFIG_DIR!, process.env.CODEX_HOME!, process.env.KIMI_CODE_HOME!]) mkdirSync(path, { recursive: true });
    writeFileSync(join(project, ".agenthub", "config.json"), JSON.stringify({ memory: { enabled: false, native: false }, inference: { enabled: false, triage: false }, mlx: { enabled: false }, snapshots: { enabled: false, keep: 1 }, research: { enabled: false }, tasks: { wip_limits: { claude: taskRows * 4, codex: taskRows * 4 } }, batch_ms: 0 }, null, 2));
    writeFileSync(join(project, "AGENTS.md"), "# Synthetic benchmark project\n");
    writeFileSync(join(project, "src", "hub", "bus.ts"), "export const bus = 1;\n");
    git(project, "init", "--quiet"); git(project, "config", "user.name", "Benchmark fixture"); git(project, "config", "user.email", "benchmark@example.invalid");
    git(project, "config", "core.hooksPath", "/dev/null"); git(project, "remote", "add", "origin", "https://example.invalid/agent-hub.git");
    git(project, "add", "-A"); git(project, "commit", "--quiet", "-m", "synthetic benchmark base"); git(project, "branch", "-M", "main");
    const base = git(project, "rev-parse", "HEAD"); git(project, "update-ref", "refs/remotes/origin/main", base);
    writeFileSync(join(project, "src", "hub", "bus.ts"), "export const bus = 2;\n"); git(project, "add", "src/hub/bus.ts"); git(project, "commit", "--quiet", "-m", "synthetic benchmark change");

    fixtureStage = "seed";
    const reviewCount = Math.min(options.iterations, Math.max(1, Math.floor(taskRows / 3)));
    const dbFile = join(stateDir, "hub.db"), seededReviewIds = seedBoard(dbFile, taskRows, reviewCount, historyNotes);
    const seedSizes = { hubDb: fileSize(dbFile), hubDbWal: fileSize(`${dbFile}-wal`) };
    const eventFile = join(stateDir, "events.jsonl"), eventSize = writeSyntheticEventLog(eventFile, eventTargetBytes);

    const config = { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, research: { ...DEFAULT_CONFIG.research, enabled: false }, tasks: { ...DEFAULT_CONFIG.tasks, wip_limits: { ...DEFAULT_CONFIG.tasks.wip_limits, claude: taskRows * 4, codex: taskRows * 4 } } };
    fixtureStage = "startup";
    const startupStart = performance.now();
    daemon = await startDaemon({ cwd: project, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config, configWatch: false, piiScreen: async () => ({ label: "clear", ms: 0 }) });
    const startupMs = performance.now() - startupStart;
    const taskPeer = new SyntheticTaskPeer(); daemon.bus.add(taskPeer); await taskPeer.start();
    instrument = measureBoardMethods(daemon);
    fixtureStage = "task-client";
    const person = await ControlClient.connect(stateDir, { role: "console", projectRoot: project }); clients.push(person);
    const codex = await ControlClient.connect(stateDir, { role: "tools", peer: "codex", projectRoot: project }); clients.push(codex);
    await waitFor(() => daemon!.bus.stateOf("codex") === "idle", options.smoke ? 3_000 : 10_000, "fake task peer attaches");
    const run = async (name: string, invoke: () => Promise<any>, observe: (reply: any) => Omit<Sample, "ms" | "counters">): Promise<any> => {
      const phase = phases.get(name) ?? { name, samples: [] }; phases.set(name, phase);
      const counters = emptyCounters(); instrument!.setActive(counters);
      const start = performance.now(); let reply: any;
      try { reply = await invoke(); }
      catch { reply = { ok: false, error: "request threw" }; }
      const ms = performance.now() - start; instrument!.setActive(undefined);
      phase.samples.push({ ms, counters, ...observe(reply) });
      return reply;
    };
    const ready = async (condition: () => boolean, name: string) => waitFor(condition, options.smoke ? 3_000 : 10_000, name);
    const queryTask = (reply: any): Task | undefined => {
      const id = Number(/task #(\d+):/.exec(String(reply?.text ?? ""))?.[1]);
      if (!Number.isSafeInteger(id) || id < 1) return undefined;
      const readback = new Board(dbFile);
      try { return readback.get(id); } finally { readback.close(); }
    };
    const observeTask = (reply: any, taskId?: number) => {
      const task = taskId ? (() => { const readback = new Board(dbFile); try { return readback.get(taskId); } finally { readback.close(); } })() : queryTask(reply);
      return { ok: typeof reply?.ok === "boolean" ? reply.ok : null, outcome: reply?.ok === true ? "ok" : reply?.ok === false ? "refused_or_unknown" : "unknown", ...(task ? { state: task.state, owner: task.owner } : {}) };
    };

    fixtureStage = "proposals";
    for (let index = 0; index < options.iterations; index++) {
      await run("proposal_backlog", () => person.request({ t: "task", op: "hub_task_propose", args: { title: `synthetic backlog ${index}`, class: "implement", backlog: true, refs: { paths: ["src/hub/bus.ts"] } } }), reply => observeTask(reply));
      const claimed = await run("proposal_claim", () => codex.request({ t: "task", op: "hub_task_propose", args: { title: `synthetic claim ${index}`, class: "implement", owner: "codex", plan: { paths: ["src/hub/bus.ts"] }, refs: { paths: ["src/hub/bus.ts"] } } }), reply => observeTask(reply));
      const observed = queryTask(claimed);
      if (claimed.ok !== true || observed?.owner !== "codex" || observed.state !== "in_progress") {
        fixtureFailure = { ok: claimed.ok, state: observed?.state, owner: observed?.owner, reason: String(claimed.error ?? claimed.text ?? "").replaceAll(home, "<fixture>").slice(0, 1000) };
        throw new Error("synthetic claim did not acquire its task");
      }
    }
    codex.close(); clients.splice(clients.indexOf(codex), 1);
    fixtureStage = "reviews";
    for (let index = 0; index < Math.min(options.iterations, seededReviewIds.length); index++) {
      const task = seededReviewIds[index]!;
      await run("review_approved", () => person.request({ t: "task", op: "hub_review", args: { id: task, verdict: "approved" } }), reply => observeTask(reply, task));
    }
    fixtureStage = "delivery-client";
    const deliveryPeer = await ControlClient.connect(stateDir, { role: "peer", peer: "claude", channel: true, projectRoot: project }); clients.push(deliveryPeer);
    const pushed: { deliveryId: string; generation: string; envIds: string[] }[] = [];
    deliveryPeer.onPush = message => { if (message.t === "deliver" && typeof message.deliveryId === "string" && typeof message.generation === "string") pushed.push({ deliveryId: message.deliveryId, generation: message.generation, envIds: Array.isArray(message.envs) ? message.envs.map((env: { id?: unknown }) => env.id).filter((id: unknown): id is string => typeof id === "string") : [] }); };
    await waitFor(() => daemon!.bus.stateOf("claude") === "idle", options.smoke ? 3_000 : 10_000, "fake delivery peer attaches");
    const deliveryWs = daemon.bus.peers.get("claude") as unknown as { nativeStarted(session: string): void; nativeStopped(session: string): boolean };
    const completeAccepted = async (receipt: { deliveryId: string; generation: string }, session: string) => {
      const accepted = await deliveryPeer.request({ t: "delivery_receipt", deliveryId: receipt.deliveryId, generation: receipt.generation, state: "accepted" });
      if (accepted.ok !== true) throw new Error("fake peer could not accept delivery");
      deliveryWs.nativeStarted(session);
      const result = await deliveryPeer.request({ t: "delivery_complete", deliveryId: receipt.deliveryId, generation: receipt.generation });
      deliveryWs.nativeStopped(session);
      if (result.ok !== true) throw new Error("fake peer could not complete delivery");
    };
    fixtureStage = "delivery-bootstrap";
    const bootstrapUntil = performance.now() + 10_000;
    let quietTurns = 0;
    while (quietTurns < 2) {
      if (performance.now() >= bootstrapUntil) throw new Error("bootstrap delivery drain timed out");
      const receipt = pushed.shift();
      if (receipt) { quietTurns = 0; await completeAccepted(receipt, "benchmark-bootstrap"); }
      else { await new Promise<void>(resolve => setTimeout(resolve, 5)); quietTurns = daemon.bus.queued("claude") === 0 && !daemon.bus.queueSummary("claude").liveAccepted ? quietTurns + 1 : 0; }
    }
    fixtureStage = "delivery-measure";
    for (let index = 0; index < options.iterations; index++) {
      const envelope = newEnvelope(USER, `synthetic correlated delivery ${index}`, { to: ["claude"], kind: "task" });
      daemon.bus.publish(envelope);
      await ready(() => pushed.some(receipt => receipt.envIds.includes(envelope.id)), "correlated fake peer push");
      const receipt = pushed.splice(pushed.findIndex(row => row.envIds.includes(envelope.id)), 1)[0]!;
      const accepted = await deliveryPeer.request({ t: "delivery_receipt", deliveryId: receipt.deliveryId, generation: receipt.generation, state: "accepted" });
      if (accepted.ok !== true) throw new Error("fake peer could not accept delivery");
      deliveryWs.nativeStarted(`benchmark-delivery-${index}`);
      const response = await run("delivery_complete", () => deliveryPeer.request({ t: "delivery_complete", deliveryId: receipt.deliveryId, generation: receipt.generation }), reply => {
        const row = daemon!.bus.queueShow(receipt.deliveryId);
        return { ok: typeof reply?.ok === "boolean" ? reply.ok : null, outcome: row?.state ?? "unknown", state: row?.state };
      });
      deliveryWs.nativeStopped(`benchmark-delivery-${index}`);
      if (response.ok !== true) throw new Error("fake peer could not complete measured delivery");
    }

    const phasesJson = [...phases.values()].map(phase => ({ name: phase.name, ...percentiles(phase.samples) }));
    const metrics = { schema: OUTPUT_SCHEMA, ok: true, mode: options.smoke ? "smoke" : "full", host: { platform: process.platform, arch: process.arch, bun: Bun.version },
      fixture: { tasksSeeded: taskRows, taskHistoryNotes: historyNotes, noteBytes: 4096, boardAfterSeed: seedSizes, boardAfterRun: { hubDb: fileSize(dbFile), hubDbWal: fileSize(`${dbFile}-wal`) }, events: { ...eventSize, bytesAtEndOfSamples: fileSize(eventFile) } },
      startup: { totalMs: round(startupMs), includesStartupEventLogReads: true },
      timing: "p50/p95 are ControlClient request round trips; Board method timings are nested synchronous observations and not additive",
      scope: { taskWrites: "ControlClient task RPCs", deliveryComplete: "real accepted delivery journal path using a synthetic peer ControlClient", channelMcpWrapper: "not measured", nativeModelsAndAccounts: "not used" },
      iterationsPerPhase: options.iterations, phases: phasesJson };
    process.stdout.write(`${JSON.stringify(metrics)}\n`);
  } finally {
    try { instrument?.restore(); }
    finally {
      try { for (const client of clients) client.close(); }
      finally {
        try { if (daemon) await daemon.stop(); }
        finally {
          for (const [key, value] of originalEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
          rmSync(home, { recursive: true, force: true });
        }
      }
    }
  }
}

try { await main(parseArgs(process.argv.slice(2))); }
catch { process.stdout.write(`${JSON.stringify({ schema: OUTPUT_SCHEMA, ok: false, error: "synthetic benchmark fixture failed", stage: fixtureStage, ...(fixtureFailure ? { detail: fixtureFailure } : {}), nextStep: "inspect this synthetic fixture stage before collecting latency evidence" })}\n`); process.exitCode = 2; }
