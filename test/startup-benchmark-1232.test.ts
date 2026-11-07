import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abandonedSizes, backupStartupDatabase, benchmarkFailureStage, BENCHMARK_STAGES, copyEventPrefix, databaseProfile, installStartupReadObserver, installStartupRollupReadObserver, isolatedStartupEnvironment, numericProfile, privateStartupSandboxProfile, reservePrivateAttempt, runStartupBenchmark, runStartupPublicProbe, seedStartupFixture, settleStartupMeasurement, syntheticDeliveryPayload, startupReadOnlyProcessAllowed, startupSeedCounter, startupReadBreakdown, timingLine, type BenchmarkPorts, type StartupProfile } from "../scripts/benchmarks/startup-1232.ts";
import { UsageRollup, DEFAULT_MAX_BYTES } from "../src/hub/usage-rollup.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { STARTUP_PHASES } from "../src/hub/startup-timing.ts";

const cleanup: string[] = [];
afterEach(() => { for (const root of cleanup.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory(): string { const root = mkdtempSync(join(tmpdir(), "startup-benchmark-fixture-")); cleanup.push(root); return root; }
const PROFILE: StartupProfile = { dbBytes: 4096, taskRows: 1, taskHistoryEntries: 1, taskTextBytes: 9, deliveryRows: 0, deliveryPayloadBytes: 0,
  eventBytes: 100, eventLines: 1, abandonedFiles: 1, abandonedBytes: 20, abandonedMaxBytes: 20 };
const TIMING = "startup timings ms: " + [...STARTUP_PHASES.map(phase => `${phase}=0`), "total=0"].join(" ");

test("a rejected daemon stop still restores every isolated hook and preserves its error", async () => {
  const calls: string[] = [], error = new Error("fixture stop rejected");
  await expect(settleStartupMeasurement(async () => { calls.push("stop"); throw error; },
    [() => { calls.push("rollup"); }, () => { calls.push("reader"); }, () => { calls.push("effects"); }])).rejects.toBe(error);
  expect(calls).toEqual(["stop", "rollup", "reader", "effects"]);
});

test("one failed restorer cannot skip later hooks or replace the first cleanup error", async () => {
  const calls: string[] = [], error = new Error("fixture rollup restore rejected");
  await expect(settleStartupMeasurement(async () => { calls.push("stop"); }, [
    () => { calls.push("rollup"); throw error; },
    () => { calls.push("reader"); throw new Error("fixture reader restore rejected"); },
    () => { calls.push("effects"); },
  ])).rejects.toBe(error);
  expect(calls).toEqual(["stop", "rollup", "reader", "effects"]);
});

test("benchmark environment contains only isolated homes and fixed metadata variables", () => {
  const root = directory(), env = isolatedStartupEnvironment(root);
  expect(env.HOME).toBe(join(root, "home"));
  expect(env.AGENTHUB_HOME).toBe(join(root, "agenthub_home"));
  expect(env.AMEM_HOME).toBe(join(root, "amem_home"));
  expect(env.PATH).toBe("/usr/bin:/bin");
  for (const key of ["AGENTHUB_PEER_ID", "AGENTHUB_STATE_DIR", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OMNIROUTE_API_KEY", "NODE_OPTIONS", "ORCA_CLI_COMMAND"]) expect(env[key]).toBeUndefined();
  for (const key of ["HOME", "TMPDIR", "AGENTHUB_HOME", "AMEM_HOME", "CODEX_HOME", "KIMI_CODE_HOME", "CLAUDE_CONFIG_DIR"]) expect(statSync(env[key]!).mode & 0o777).toBe(0o700);
});

test("private Mac profile denies outbound networking and both original-state spellings with SBPL escaping", () => {
  const typed = '/source/"quoted"/back\\slash', canonical = "/canonical/state";
  const profile = privateStartupSandboxProfile(typed, canonical);
  expect(profile).toStartWith("(version 1)\n(allow default)\n(deny network-outbound)\n");
  expect(profile).toContain('(deny file-read* file-write* (subpath "/source/\\"quoted\\"/back\\\\slash"))');
  expect(profile).toContain('(deny file-read* file-write* (subpath "/canonical/state"))');
  expect(profile).not.toContain("process");
  expect(profile).not.toContain("signal");
  const one = privateStartupSandboxProfile(canonical, canonical);
  expect(one.split("(deny file-read*")).toHaveLength(2);
  expect(() => privateStartupSandboxProfile("relative", canonical)).toThrow();
  expect(() => privateStartupSandboxProfile("/", canonical)).toThrow();
  expect(() => privateStartupSandboxProfile("/source\ninvalid", canonical)).toThrow();
});

test("public debug is derived only from the synthetic mode and absent from private child environments", () => {
  expect(isolatedStartupEnvironment(directory(), "synthetic").AHUB_STARTUP_BENCHMARK_PUBLIC_DEBUG).toBe("1");
  expect(isolatedStartupEnvironment(directory(), "private").AHUB_STARTUP_BENCHMARK_PUBLIC_DEBUG).toBeUndefined();
});

test("process guard admits only the observed origin/worktree getters and rejects writes or extra arguments", () => {
  for (const args of [
    ["-C", "/fixture", "remote", "get-url", "origin"],
    ["--git-dir", "/fixture/.git", "config", "--path", "core.worktree"],
  ]) expect(startupReadOnlyProcessAllowed("/usr/bin/git", args)).toBe(true);
  for (const args of [
    ["remote", "set-url", "origin", "fixture"], ["remote", "add", "origin", "fixture"],
    ["remote", "get-url", "upstream"], ["remote", "get-url", "origin", "extra"],
    ["config", "core.worktree", "fixture"], ["config", "--add", "core.worktree", "fixture"],
    ["config", "--path", "core.worktree", "fixture"], ["config", "--path", "other.key"],
    ["config", "--path", "core.worktree", "--get"],
  ]) expect(startupReadOnlyProcessAllowed("/usr/bin/git", args)).toBe(false);
});

test("event snapshot keeps the complete append-only prefix and rejects source symlinks", () => {
  const root = directory(), source = join(root, "events.jsonl"), output = join(root, "copy.jsonl");
  const complete = '{"fixture":"' + "x".repeat(70_000) + '"}\n';
  writeFileSync(source, complete + '{"private":"incomplete');
  expect(copyEventPrefix(source, output)).toEqual({ bytes: Buffer.byteLength(complete), lines: 1 });
  expect(readFileSync(output, "utf8")).toBe(complete);
  expect(readFileSync(source, "utf8")).toEndWith('{"private":"incomplete');
  symlinkSync(source, join(root, "linked"));
  expect(() => copyEventPrefix(join(root, "linked"), join(root, "refused"))).toThrow();
});

test("read observer sees actual named builtin imports and descriptor reads without counting metadata", async () => {
  const root = directory(), file = join(root, "events.jsonl"), abandoned = join(root, "restart.abandoned.fixture.json");
  writeFileSync(file, "fixture\n"); writeFileSync(abandoned, "body\n");
  const observer = await installStartupReadObserver(root);
  try {
    statSync(file);
    expect(observer.counts.eventReadBytes).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("fixture\n");
    expect(observer.counts.eventReadBytes).toBeGreaterThanOrEqual(8);
    const before = observer.counts.eventReadBytes, fd = openSync(file, "r");
    try { expect(readSync(fd, Buffer.alloc(4), 0, 4, 0)).toBe(4); } finally { closeSync(fd); }
    expect(observer.counts.eventReadBytes).toBe(before + 4);
    readFileSync(abandoned);
    expect(observer.counts.abandonedReadBytes).toBeGreaterThanOrEqual(5);
    const recorded = observer.counts.eventReadBytes;
    observer.restore(); readFileSync(file);
    expect(observer.counts.eventReadBytes).toBe(recorded);
  } finally { observer.restore(); }
});

test("normal Bun script observes production readers and named/default effect denials before private diagnostics", async () => {
  const row = await runStartupPublicProbe();
  expect(row.normalRuntime).toBe(1);
  expect(row.namedReadBytes).toBeGreaterThanOrEqual(8);
  expect(row.defaultReadBytes).toBeGreaterThanOrEqual(8);
  expect(row.eventReaderBytes).toBeGreaterThan(0);
  expect(row.rollupBytes).toBeGreaterThan(0);
  expect(row.restartBytes).toBeGreaterThanOrEqual(2);
  expect(row.abandonedMetadataBytes).toBe(0);
  expect(row.abandonedBodyBytes).toBeGreaterThanOrEqual(2);
  expect(row.processDenials).toBe(2);
  expect(row.networkDenials).toBe(4);
  expect(row.restored).toBe(1);
}, 20_000);

test("rollup IO wrapper delegates real poll results, counts all actual reads and restores its descriptor", async () => {
  const root = directory(), file = join(root, "events.jsonl"), line = JSON.stringify({ at: "2026-01-01T00:00:00Z", type: "state", peer: "claude", state: "offline" }) + "\n";
  writeFileSync(file, line);
  const descriptor = Object.getOwnPropertyDescriptor(UsageRollup.prototype, "poll");
  const observer = await installStartupReadObserver(root);
  const rollupObserver = await installStartupRollupReadObserver(() => observer.counts.eventReadBytes);
  const rollup = new UsageRollup(join(root, "hub.db"), file);
  try {
    // A zero-time slice consumes no records but really reads the file. poll.bytes cannot stand in for IO.
    expect(rollup.poll(0).bytes).toBe(0);
    expect(rollupObserver.counts).toEqual({ usageRollupCalls: 1, usageRollupReadBytes: Buffer.byteLength(line) });
    expect(rollup.poll().bytes).toBe(Buffer.byteLength(line));
    expect(rollup.poll().bytes).toBe(0);
    expect(rollupObserver.counts.usageRollupCalls).toBe(3);
    expect(rollupObserver.counts.usageRollupReadBytes).toBe(observer.counts.eventReadBytes);
    const before = rollupObserver.counts.usageRollupReadBytes;
    const fd = openSync(file, "r");
    try { expect(readSync(fd, Buffer.alloc(Buffer.byteLength(line)), 0, Buffer.byteLength(line), 0)).toBe(Buffer.byteLength(line)); } finally { closeSync(fd); }
    expect(rollupObserver.counts.usageRollupReadBytes).toBe(before);
    expect(observer.counts.eventReadBytes).toBe(before + Buffer.byteLength(line));
    rollupObserver.restore();
    expect(Object.getOwnPropertyDescriptor(UsageRollup.prototype, "poll")).toEqual(descriptor);
    appendFileSync(file, line);
    expect(rollup.poll().bytes).toBe(Buffer.byteLength(line));
    expect(rollupObserver.counts.usageRollupCalls).toBe(3);
    expect(rollupObserver.counts.usageRollupReadBytes).toBe(before);
  } finally { rollup.close(); rollupObserver.restore(); observer.restore(); }
});

test("private attempts are reserved durably before work, including attempts that never start a child", () => {
  const ledger = join(directory(), "attempts.sqlite");
  expect(reservePrivateAttempt(ledger)).toBe(1);
  expect(reservePrivateAttempt(ledger)).toBe(2);
  expect(reservePrivateAttempt(ledger)).toBe(3);
  expect(() => reservePrivateAttempt(ledger)).toThrow("review the isolated fixture configuration");
  expect(statSync(ledger).mode & 0o777).toBe(0o600);
});

test("numeric profile and timing projection reject content or missing fields", () => {
  expect(numericProfile(PROFILE)).toEqual(PROFILE);
  expect(() => numericProfile({ ...PROFILE, taskTitle: "private" })).toThrow();
  expect(() => numericProfile({ ...PROFILE, taskRows: Number.NaN })).toThrow();
  expect(timingLine(TIMING)).toBe(TIMING);
  expect(() => timingLine(TIMING + " private=1")).toThrow();
  expect(() => timingLine(TIMING.replace("schema=0", "schema=private"))).toThrow();
});

test("online read-only WAL source backup is immediately readable by Bun without destination sidecars", async () => {
  const root = directory(), env = isolatedStartupEnvironment(root), source = join(root, "source.sqlite"), destination = join(root, "copy.sqlite");
  const writer = new Database(source);
  try {
    writer.run("PRAGMA journal_mode=WAL");
    writer.run("CREATE TABLE tasks(title TEXT,detail TEXT,history TEXT)");
    writer.run("INSERT INTO tasks VALUES ('fixture','public','[{}]')");
    expect(existsSync(source + "-wal")).toBe(true);
    await backupStartupDatabase(source, destination, env, 10_000);
    expect(existsSync(destination + "-wal")).toBe(false);
    expect(existsSync(destination + "-shm")).toBe(false);
    // First destination open is the actual Bun readonly profile reader, not a Python repair/read.
    expect(databaseProfile(destination)).toMatchObject({ taskRows: 1, taskHistoryEntries: 1, taskTextBytes: 13 });
    const reader = new Database(destination, { readonly: true });
    try { expect(reader.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" }); } finally { reader.close(); }
    expect(writer.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(writer.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 });
  } finally { writer.close(); }
}, 20_000);

test("backup refuses preexisting destination artifacts without removing or overwriting them", async () => {
  const root = directory(), env = isolatedStartupEnvironment(root), source = join(root, "unused-source.sqlite"), destination = join(root, "copy.sqlite"), kept = join(root, "kept");
  writeFileSync(source, "public source"); writeFileSync(kept, "keep this public fixture");
  symlinkSync(kept, destination + "-shm");
  await expect(backupStartupDatabase(source, destination, env, 10_000)).rejects.toThrow();
  expect(readFileSync(kept, "utf8")).toBe("keep this public fixture");
  expect(existsSync(destination + "-shm")).toBe(true);
  expect(existsSync(destination)).toBe(false);
  rmSync(destination + "-shm");
  writeFileSync(destination, "preexisting destination");
  await expect(backupStartupDatabase(source, destination, env, 10_000)).rejects.toThrow();
  expect(readFileSync(destination, "utf8")).toBe("preexisting destination");
});

test("failure diagnostics accept only closed numeric stages and no child prose or path", () => {
  const stage = BENCHMARK_STAGES.indexOf("profile");
  expect(benchmarkFailureStage({ failed: 1, stage })).toBe(stage);
  expect(benchmarkFailureStage({ failed: 1, stage, error: "private body" })).toBeUndefined();
  expect(benchmarkFailureStage({ failed: 1, stage: "profile" })).toBeUndefined();
  expect(benchmarkFailureStage({ failed: 1, stage: -1 })).toBeUndefined();
  expect(benchmarkFailureStage({ failed: 1, stage: BENCHMARK_STAGES.length })).toBeUndefined();
});

test("database aggregates count every non-NULL field independently and empty tables as zero", () => {
  const file = join(directory(), "public.sqlite"), db = new Database(file);
  try {
    db.run("CREATE TABLE tasks(title TEXT, detail TEXT, history TEXT)");
    db.run("CREATE TABLE deliveries(originals TEXT, out_json TEXT)");
    expect(databaseProfile(file)).toMatchObject({ taskRows: 0, taskHistoryEntries: 0, taskTextBytes: 0, deliveryRows: 0, deliveryPayloadBytes: 0 });
    // Defensive aggregate coverage only, not a claim these legacy NULL rows satisfy current delivery DDL.
    db.run("INSERT INTO tasks VALUES ('abc',NULL,'[]'),(NULL,'xy','[{}]'),(NULL,NULL,NULL)");
    db.run("INSERT INTO deliveries VALUES ('[]',NULL),(NULL,' [] '),('[]','[]'),(NULL,NULL)");
    expect(databaseProfile(file)).toMatchObject({ taskRows: 3, taskHistoryEntries: 1, taskTextBytes: 5, deliveryRows: 4, deliveryPayloadBytes: 10 });
  } finally { db.close(); }
});

for (const bytes of [4, 5, 7, 100, 1000]) test(`completed payload fixture preserves valid arrays and exactly ${bytes} bytes`, () => {
  const row = syntheticDeliveryPayload(bytes, 1);
  expect(Array.isArray(JSON.parse(row.originals))).toBe(true);
  expect(Array.isArray(JSON.parse(row.out))).toBe(true);
  expect(Buffer.byteLength(row.originals) + Buffer.byteLength(row.out)).toBe(bytes);
});

test("profile consistency refuses impossible aggregates and distributes abandoned remainder exactly", () => {
  for (const change of [
    { dbBytes: 0 }, { taskRows: 0 }, { taskTextBytes: 0 }, { taskHistoryEntries: 0 }, { deliveryRows: 2, deliveryPayloadBytes: 7 },
    { eventLines: 0 }, { eventBytes: 0 }, { abandonedFiles: 0 }, { abandonedFiles: 2, abandonedBytes: 5, abandonedMaxBytes: 2 },
    { abandonedFiles: 1, abandonedBytes: 21 },
  ]) expect(() => numericProfile({ ...PROFILE, ...change })).toThrow();
  const value = { ...PROFILE, abandonedFiles: 4, abandonedBytes: 18, abandonedMaxBytes: 8 };
  expect(abandonedSizes(value)).toEqual([8, 4, 3, 3]);
});

for (const deliveryRows of [0, 32]) test(`small public synthetic database handles ${deliveryRows} mostly empty completed rows`, async () => {
  const root = directory(), state = join(root, "state"); mkdirSync(state); mkdirSync(join(root, "project"));
  const profile: StartupProfile = { dbBytes: 1024 * 1024, taskRows: 0, taskHistoryEntries: 0, taskTextBytes: 0, deliveryRows,
    deliveryPayloadBytes: deliveryRows ? deliveryRows * 4 + 1 : 0, eventBytes: 3, eventLines: 2, abandonedFiles: 4, abandonedBytes: 18, abandonedMaxBytes: 8 };
  const request = join(root, "request.json"); writeFileSync(request, JSON.stringify({ destination: state, profile }));
  await seedStartupFixture(request);
  expect(databaseProfile(join(state, "hub.db"))).toMatchObject({ taskRows: 0, taskHistoryEntries: 0, taskTextBytes: 0, deliveryRows, deliveryPayloadBytes: profile.deliveryPayloadBytes });
  const db = new Database(join(state, "hub.db"), { readonly: true });
  try {
    const rows = db.query("SELECT originals,out_json FROM deliveries").all() as { originals: string; out_json: string }[];
    expect(rows.every(row => Array.isArray(JSON.parse(row.originals)) && Array.isArray(JSON.parse(row.out_json)))).toBe(true);
  } finally { db.close(); }
  const journal = new DeliveryJournal({ file: join(state, "hub.db"), projectRoot: join(root, "project"), projectId: "synthetic-startup", instanceId: "synthetic-shape-check" });
  try { expect(journal.list()).toHaveLength(deliveryRows); } finally { journal.close(); }
  const sizes = Array.from({ length: profile.abandonedFiles }, (_, n) => statSync(join(state, `restart.abandoned.synthetic-${n}.json`)).size);
  expect(sizes.reduce((a, b) => a + b, 0)).toBe(profile.abandonedBytes);
  expect(Math.max(...sizes)).toBe(profile.abandonedMaxBytes);
  const events = readFileSync(join(state, "events.jsonl"));
  expect(events.length).toBe(profile.eventBytes);
  expect(events.filter(byte => byte === 10).length).toBe(profile.eventLines);
});

function fakePorts(observed: { roots: string[]; sources: (string | undefined)[] }, changes: { stopped?: boolean; eventReadBytes?: number; abandonedReadBytes?: number; seedPasses?: number; seedReadBytes?: number; eventReadFileCalls?: number; usageRollupReadBytes?: number; usageRollupCalls?: number } = {}): BenchmarkPorts {
  return {
    project: () => {},
    prepare: async (source, state, profile) => {
      observed.sources.push(source);
      writeFileSync(join(state, "hub.db"), "fixture only");
      return profile;
    },
    child: async root => {
      observed.roots.push(root);
      expect(statSync(root).mode & 0o777).toBe(0o700);
      return { timing: TIMING, wallMs: 4, stopped: changes.stopped ?? true, effects: 0, eventReadBytes: changes.eventReadBytes ?? PROFILE.eventBytes, abandonedReadBytes: changes.abandonedReadBytes ?? 0,
        seedPasses: changes.seedPasses ?? 1, seedReadBytes: changes.seedReadBytes ?? PROFILE.eventBytes, eventReadFileCalls: changes.eventReadFileCalls ?? 0, usageRollupReadBytes: changes.usageRollupReadBytes ?? 0, usageRollupCalls: changes.usageRollupCalls ?? 0 };
    },
  };
}

test("serialized synthetic samples clone one baseline into fresh isolated copies and remove only confirmed stopped copies", async () => {
  const observed = { roots: [] as string[], sources: [] as (string | undefined)[] };
  const results = await runStartupBenchmark({ mode: "synthetic", samples: 3, profile: PROFILE }, fakePorts(observed));
  expect(observed.sources[0]).toBeUndefined();
  expect(observed.sources.slice(1).every(source => source === observed.sources[1])).toBe(true);
  expect(new Set(observed.roots).size).toBe(3);
  expect(observed.roots.every(root => !existsSync(root))).toBe(true);
  expect(results.map(row => row.sample)).toEqual([1, 2, 3]);
  expect(results.every(row => row.synthetic === 1 && row.effects === 0)).toBe(true);
  expect(JSON.stringify(results)).not.toContain("fixture only");
});

test("unconfirmed fake child retains its copy instead of deleting state under an owner", async () => {
  const observed = { roots: [] as string[], sources: [] as (string | undefined)[] };
  await expect(runStartupBenchmark({ mode: "synthetic", samples: 1, profile: PROFILE }, fakePorts(observed, { stopped: false }))).rejects.toThrow();
  expect(observed.roots).toHaveLength(1);
  expect(existsSync(observed.roots[0]!)).toBe(true);
  cleanup.push(observed.roots[0]!); // This fixture used no process; only the test can establish that fact.
});

test("acceptance allows exactly one streaming seed pass and reports independent cold rollup IO", async () => {
  const observed = { roots: [] as string[], sources: [] as (string | undefined)[] };
  const results = await runStartupBenchmark({ mode: "synthetic", samples: 1, profile: PROFILE, acceptance: true }, fakePorts(observed, { eventReadBytes: PROFILE.eventBytes + 8 * 1024 * 1024, usageRollupReadBytes: 8 * 1024 * 1024, usageRollupCalls: 1 }));
  expect(results[0]!.seedPasses).toBe(1);
  expect(results[0]!.seedReadBytes).toBe(PROFILE.eventBytes);
  expect(results[0]!.eventReadFileCalls).toBe(0);
  expect(results[0]!.auxiliaryReadBytes).toBe(8 * 1024 * 1024);
  expect(results[0]!.usageRollupReadBytes).toBe(8 * 1024 * 1024);
  expect(results[0]!.residualExtraReadBytes).toBe(0);
});

test("seed observation sums every invocation so a second pass is never hidden by overwrite", async () => {
  const counter = startupSeedCounter();
  counter.observed({ readPasses: 1, readBytes: PROFILE.eventBytes });
  counter.observed({ readPasses: 1, readBytes: PROFILE.eventBytes });
  expect(counter.metrics).toEqual({ seedPasses: 2, seedReadBytes: 2 * PROFILE.eventBytes });
  const observed = { roots: [] as string[], sources: [] as (string | undefined)[] };
  await expect(runStartupBenchmark({ mode: "synthetic", samples: 1, profile: PROFILE, acceptance: true }, fakePorts(observed, { ...counter.metrics, eventReadBytes: counter.metrics.seedReadBytes }))).rejects.toThrow();
});

for (const reads of [{ seedPasses: 2 }, { eventReadFileCalls: 1 }, { abandonedReadBytes: 1 }]) test("acceptance rejects extra seed passes, whole-file reads and abandoned-snapshot bodies", async () => {
  const observed = { roots: [] as string[], sources: [] as (string | undefined)[] };
  await expect(runStartupBenchmark({ mode: "synthetic", samples: 1, profile: PROFILE, acceptance: true }, fakePorts(observed, reads))).rejects.toThrow();
  expect(observed.roots.every(root => !existsSync(root))).toBe(true);
});

test("acceptance rejects an extra full descriptor scan outside the real bounded rollup scope", async () => {
  const observed = { roots: [] as string[], sources: [] as (string | undefined)[] };
  const profile = { ...PROFILE, eventBytes: 130_000_000, eventLines: 500_000 };
  await expect(runStartupBenchmark({ mode: "synthetic", samples: 1, profile, acceptance: true }, fakePorts(observed, {
    seedPasses: 1, seedReadBytes: profile.eventBytes, eventReadFileCalls: 0,
    usageRollupReadBytes: DEFAULT_MAX_BYTES, usageRollupCalls: 1, eventReadBytes: 2 * profile.eventBytes + DEFAULT_MAX_BYTES,
  }))).rejects.toThrow();
  expect(observed.roots.every(root => !existsSync(root))).toBe(true);
});

test("acceptance rejects a full log read inside rollup scope rather than trusting consumed poll bytes", async () => {
  const observed = { roots: [] as string[], sources: [] as (string | undefined)[] };
  const profile = { ...PROFILE, eventBytes: 130_000_000, eventLines: 500_000 };
  await expect(runStartupBenchmark({ mode: "synthetic", samples: 1, profile, acceptance: true }, fakePorts(observed, {
    seedReadBytes: profile.eventBytes, usageRollupReadBytes: profile.eventBytes, usageRollupCalls: 1, eventReadBytes: 2 * profile.eventBytes,
  }))).rejects.toThrow();
});

test("IO breakdown rejects negative and inconsistent attribution instead of hiding residual reads", () => {
  const base = { seedPasses: 1, seedReadBytes: 100, eventReadBytes: 121, usageRollupReadBytes: 20, usageRollupCalls: 1, abandonedReadBytes: 0, eventReadFileCalls: 0 };
  expect(startupReadBreakdown(base)).toEqual({ auxiliaryReadBytes: 21, residualExtraReadBytes: 1 });
  for (const changes of [{ seedReadBytes: -1 }, { eventReadBytes: 119 }, { usageRollupReadBytes: -1 }, { usageRollupCalls: 0 }, { seedPasses: 0 }, { eventReadBytes: Number.NaN }]) {
    expect(() => startupReadBreakdown({ ...base, ...changes })).toThrow();
  }
});
