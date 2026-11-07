/** Model-free baseline. Production prepare/current and ReviewerPrintPeer's timer are reused. */
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { request } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ReviewerBackend, ReviewerLaunch } from "../../src/adapters/reviewer-print.ts";

export const KIMI_WATCH_INPUT_BYTES = 1_048_576;
const POLLS = 3, AUTHORITY_SAMPLES = 8, SLOW_MS = 150, DEADLINE_MS = 10_000;
// Shared numeric trace: one causal counter works across main/requester threads.
const ORDER = 0, START = 1, SENT = 2, DISPATCH = 3, RESPONSE = 4, HOLD = 5;
let failureStage = 0;
const numericFailure = () => new Error("benchmark failed");
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
export function sampleCurrentAuthority(check: () => boolean, count = AUTHORITY_SAMPLES): number[] {
  const values: number[] = [];
  for (let i = 0; i < count; i++) { const start = performance.now(); if (!check()) throw numericFailure(); values.push(performance.now() - start); }
  return values;
}
export interface Watch1284Sample { startsMs: number[]; checkMs: number[]; syntheticMs: number[]; startToStartMs: number[]; maxConcurrent: number }
function samples(): Watch1284Sample { return { startsMs: [], checkMs: [], syntheticMs: [], startToStartMs: [], maxConcurrent: 0 }; }
/** Collector can be reused by a later worker-backed benchmark without copying a policy check. */
export function recordWatch1284Sample(rows: Watch1284Sample, start: number, checkMs: number, syntheticMs: number, concurrent: number): void {
  const prior = rows.startsMs.at(-1); if (prior !== undefined) rows.startToStartMs.push(start - prior);
  rows.startsMs.push(start); rows.checkMs.push(checkMs); rows.syntheticMs.push(syntheticMs); rows.maxConcurrent = Math.max(rows.maxConcurrent, concurrent);
}
export interface KimiWatch1284Baseline {
  schema: 1; inputBytes: number; agentBytes: number; cadenceMs: 100; syntheticHoldMs: number;
  authorityMs: number[]; ordinary: Watch1284Sample; slow: Watch1284Sample;
  ordering: { firstCheckStart: number; firstCheckEnd: number; controlDispatch: number; controlResponse: number };
  cleanup: { peerStopped: number; requesterJoined: number; profileRemoved: number; sourceUnchanged: number };
}

async function requester(): Promise<void> {
  const data = workerData as { mode?: string; shared?: SharedArrayBuffer; url?: string };
  if (data.mode !== "control-requester" || !(data.shared instanceof SharedArrayBuffer) || typeof data.url !== "string") throw numericFailure();
  const url = new URL(data.url); if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/control") throw numericFailure();
  const trace = new Int32Array(data.shared);
  parentPort!.postMessage(1);
  if (Atomics.wait(trace, START, 0, 5000) === "timed-out") throw numericFailure();
  await new Promise<void>((resolve, reject) => {
    const req = request(url, { method: "GET", agent: false }, res => {
      res.once("error", () => reject(numericFailure())); res.resume(); res.once("end", () => {
        Atomics.store(trace, RESPONSE, Atomics.add(trace, ORDER, 1) + 1);
        parentPort!.postMessage(2); resolve();
      });
    });
    req.once("error", () => { Atomics.store(trace, SENT, -1); Atomics.notify(trace, SENT); reject(numericFailure()); });
    req.setTimeout(5000, () => req.destroy(numericFailure()));
    req.once("socket", socket => socket.once("connect", () => {
      req.once("finish", () => { Atomics.store(trace, SENT, 1); Atomics.notify(trace, SENT); }); req.end();
    }));
  });
  parentPort!.close();
}

export async function runKimiReviewWatchBaseline(): Promise<KimiWatch1284Baseline> {
  failureStage = 1;
  const root = mkdtempSync(join(tmpdir(), "ahub-kimi-watch-1284-"));
  const keys = ["HOME", "KIMI_CODE_HOME", "AGENTHUB_HOME", "AMEM_HOME", "TMPDIR", "XDG_CONFIG_HOME"] as const;
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) { const directory = join(root, key.toLowerCase()); mkdirSync(directory, { mode: 0o700 }); process.env[key] = directory; }
    return await preparedBaseline(root);
  } finally {
    for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
    rmSync(root, { recursive: true, force: true });
  }
}
async function preparedBaseline(root: string): Promise<KimiWatch1284Baseline> {
  const native = process.env.KIMI_CODE_HOME!;
  for (const name of ["credentials", "oauth"]) mkdirSync(join(native, name), { mode: 0o700 });
  const sourceConfig = 'default_model="fixture"\n[providers."managed:kimi-code"]\ntype="kimi"\nbase_url="https://api.kimi.ai/coding/v1"\n[providers."managed:kimi-code".oauth]\nstorage="file"\nkey="oauth/kimi-code"\n[models.fixture]\nprovider="managed:kimi-code"\nmodel="fixture"\n';
  writeFileSync(join(native, "config.toml"), sourceConfig, { mode: 0o600 });
  writeFileSync(join(native, "device_id"), "synthetic-device", { mode: 0o600 });
  writeFileSync(join(native, "credentials/kimi-code.json"), "synthetic-only", { mode: 0o600 });
  writeFileSync(join(native, "oauth/kimi-code"), "synthetic-only", { mode: 0o600 });
  // Import home-sensitive production modules only after every home points inside this owned fixture.
  const { kimiReviewerBackend } = await import("../../src/adapters/kimi-review.ts");
  const { ReviewerPrintPeer } = await import("../../src/adapters/reviewer-print.ts");
  const { createReviewerMcpSession } = await import("../../src/adapters/reviewer-mcp.ts");
  const { COMPAT } = await import("../../src/adapters/compat.ts");
  const { newEnvelope, frame, HUB } = await import("../../src/hub/envelope.ts");
  const version = COMPAT["kimi-review"].verified.at(-1); if (!version) throw numericFailure();
  const controller = new AbortController(), ordinary = samples(), slow = samples();
  const ordinaryDone = deferred<void>(), slowDone = deferred<void>(), released = deferred<void>(), ready = deferred<void>(), response = deferred<void>();
  const trace = new Int32Array(new SharedArrayBuffer(6 * Int32Array.BYTES_PER_ELEMENT));
  let phase: "none" | "ordinary" | "slow" = "none", active = 0, inputBytes = 0, agentBytes = 0, profile: string | undefined;
  let firstStart = 0, firstEnd = 0, worker: Worker | undefined, peer: InstanceType<typeof ReviewerPrintPeer> | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    if (req.headers.has("origin") || req.method !== "GET" || new URL(req.url).pathname !== "/control") return new Response("0", { status: 403 });
    Atomics.store(trace, DISPATCH, Atomics.add(trace, ORDER, 1) + 1); return new Response("0");
  } });
  const backend: ReviewerBackend = { ...kimiReviewerBackend, async prepare(context) {
    const launch = await kimiReviewerBackend.prepare({ ...context, signal: AbortSignal.any([context.signal, controller.signal]) });
    if ("unavailable" in launch) throw numericFailure();
    if (context.task === undefined) return launch;
    inputBytes = Buffer.byteLength(context.input ?? ""); if (inputBytes !== KIMI_WATCH_INPUT_BYTES) throw numericFailure();
    profile = launch.cwd; agentBytes = statSync(launch.args[launch.args.indexOf("--agent-file") + 1]!).size;
    const current = launch.current!;
    return { ...launch, current: () => {
      const measured = phase !== "none" && peer?.reviewing === 7, rows = phase === "slow" ? slow : ordinary;
      if (!measured || rows.startsMs.length >= POLLS) return current();
      const start = performance.now(); active++; let synthetic = 0;
      try {
        if (phase === "slow") {
          const order = Atomics.add(trace, ORDER, 1) + 1;
          if (!firstStart) { firstStart = order; Atomics.store(trace, START, 1); Atomics.notify(trace, START);
            Atomics.wait(trace, SENT, 0, 5000); if (Atomics.load(trace, SENT) !== 1) throw numericFailure(); }
          const held = performance.now(); Atomics.wait(trace, HOLD, 0, SLOW_MS); synthetic = performance.now() - held;
        }
        const checkStart = performance.now(), valid = current(), cost = performance.now() - checkStart;
        if (!valid) throw numericFailure();
        if (phase === "slow") { const end = Atomics.add(trace, ORDER, 1) + 1; if (!firstEnd) firstEnd = end; }
        recordWatch1284Sample(rows, start, cost, synthetic, active);
        if (rows.startsMs.length === POLLS) (phase === "slow" ? slowDone : ordinaryDone).resolve();
        return valid;
      } finally { active--; }
    } } satisfies ReviewerLaunch;
  } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    peer = new ReviewerPrintPeer("kimi-review", { cwd: root, command: [process.execPath, import.meta.path, "--fake-cli", version],
      mcpConfig: '{"mcpServers":{}}', systemPrompt: "Synthetic benchmark only.", watchdogMs: DEADLINE_MS,
      backend, verdictSince: () => false, inputReleased: () => released.resolve(),
      taskMcp: (task, current) => createReviewerMcpSession({ task, current,
        tools: ["hub_review", "hub_task_show"].map(name => ({ name, description: "fixture", inputSchema: { type: "object" as const, properties: {}, additionalProperties: false as const } })), call: async () => "0" }) });
    const run = async () => {
      failureStage = 2; await peer!.start();
      const env = newEnvelope(HUB, "", { kind: "review", to: ["kimi-review"], refs: { task: "7", commit: "a".repeat(40) } });
      env.body = "x".repeat(KIMI_WATCH_INPUT_BYTES - Buffer.byteLength(frame(env)));
      await peer!.deliver([env]); await released.promise; if (controller.signal.aborted) throw numericFailure();
      failureStage = 3; const authorityMs = sampleCurrentAuthority(() => peer!.reviewToken(7) !== undefined);
      failureStage = 4; phase = "ordinary"; await ordinaryDone.promise; phase = "none"; if (controller.signal.aborted) throw numericFailure();
      failureStage = 5; worker = new Worker(import.meta.path, { workerData: { mode: "control-requester", shared: trace.buffer, url: `http://127.0.0.1:${server.port}/control` } });
      worker.on("message", value => { if (value === 1) ready.resolve(); if (value === 2) response.resolve(); if (value === 3) { ready.reject(numericFailure()); response.reject(numericFailure()); } });
      worker.on("error", () => { ready.reject(numericFailure()); response.reject(numericFailure()); });
      // Attach both rejection handlers before waiting for either event.
      const workerEvents = Promise.all([ready.promise, response.promise]); void workerEvents.catch(() => {});
      await ready.promise; if (controller.signal.aborted) throw numericFailure();
      failureStage = 6; phase = "slow"; await slowDone.promise; phase = "none"; await workerEvents;
      return { schema: 1 as const, inputBytes, agentBytes, cadenceMs: 100 as const, syntheticHoldMs: SLOW_MS, authorityMs, ordinary, slow,
        ordering: { firstCheckStart: firstStart, firstCheckEnd: firstEnd, controlDispatch: Atomics.load(trace, DISPATCH), controlResponse: Atomics.load(trace, RESPONSE) },
        cleanup: { peerStopped: 0, requesterJoined: 0, profileRemoved: 0, sourceUnchanged: 0 } };
    };
    const result = await Promise.race([run(), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(numericFailure()); }, DEADLINE_MS); })]);
    failureStage = 7; phase = "none"; await peer.stop(); result.cleanup.peerStopped = Number(peer.state === "offline");
    await worker?.terminate(); worker = undefined; result.cleanup.requesterJoined = 1;
    result.cleanup.profileRemoved = Number(!!profile && !existsSync(profile));
    result.cleanup.sourceUnchanged = Number(readFileSync(join(native, "config.toml"), "utf8") === sourceConfig && readFileSync(join(native, "oauth/kimi-code"), "utf8") === "synthetic-only");
    return result;
  } finally {
    phase = "none"; if (timer) clearTimeout(timer); controller.abort();
    try { await peer?.stop(); }
    finally { try { await worker?.terminate(); } finally { await server.stop(true); } }
  }
}

if (!isMainThread) {
  void requester().catch(() => { parentPort?.postMessage(3); parentPort?.close(); process.exitCode = 1; });
} else if (import.meta.main && process.argv.includes("--fake-cli")) {
  const version = process.argv[process.argv.indexOf("--fake-cli") + 1];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) process.exit(2);
  if (process.argv.at(-1) === "--version") console.log(version);
  else { void (async () => { for await (const _ of Bun.stdin.stream()) { /* Drain synthetic facts without observing or printing them. */ } setInterval(() => {}, 1000); })(); }
} else if (import.meta.main) {
  try { console.log(JSON.stringify(await runKimiReviewWatchBaseline())); }
  catch { console.log(JSON.stringify({ schema: 1, failed: 1, stage: failureStage })); process.exitCode = 1; }
}
