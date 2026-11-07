import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abandonedSizes, copyEventPrefix, databaseProfile, installStartupReadObserver, isolatedStartupEnvironment, numericProfile, reservePrivateAttempt, runStartupBenchmark, runStartupPublicProbe, seedStartupFixture, syntheticDeliveryPayload, timingLine, type BenchmarkPorts, type StartupProfile } from "../scripts/benchmarks/startup-1232.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { STARTUP_PHASES } from "../src/hub/startup-timing.ts";

const cleanup: string[] = [];
afterEach(() => { for (const root of cleanup.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory(): string { const root = mkdtempSync(join(tmpdir(), "startup-benchmark-fixture-")); cleanup.push(root); return root; }
const PROFILE: StartupProfile = { dbBytes: 4096, taskRows: 1, taskHistoryEntries: 1, taskTextBytes: 9, deliveryRows: 0, deliveryPayloadBytes: 0,
  eventBytes: 100, eventLines: 1, abandonedFiles: 1, abandonedBytes: 20, abandonedMaxBytes: 20 };
const TIMING = "startup timings ms: " + [...STARTUP_PHASES.map(phase => `${phase}=0`), "total=0"].join(" ");

test("benchmark environment contains only isolated homes and fixed metadata variables", () => {
  const root = directory(), env = isolatedStartupEnvironment(root);
  expect(env.HOME).toBe(join(root, "home"));
  expect(env.AGENTHUB_HOME).toBe(join(root, "agenthub_home"));
  expect(env.AMEM_HOME).toBe(join(root, "amem_home"));
  expect(env.PATH).toBe("/usr/bin:/bin");
  for (const key of ["AGENTHUB_PEER_ID", "AGENTHUB_STATE_DIR", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OMNIROUTE_API_KEY", "NODE_OPTIONS", "ORCA_CLI_COMMAND"]) expect(env[key]).toBeUndefined();
  for (const key of ["HOME", "TMPDIR", "AGENTHUB_HOME", "AMEM_HOME", "CODEX_HOME", "KIMI_CODE_HOME", "CLAUDE_CONFIG_DIR"]) expect(statSync(env[key]!).mode & 0o777).toBe(0o700);
});

test("public debug is derived only from the synthetic mode and absent from private child environments", () => {
  expect(isolatedStartupEnvironment(directory(), "synthetic").AHUB_STARTUP_BENCHMARK_PUBLIC_DEBUG).toBe("1");
  expect(isolatedStartupEnvironment(directory(), "private").AHUB_STARTUP_BENCHMARK_PUBLIC_DEBUG).toBeUndefined();
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

function fakePorts(observed: { roots: string[]; sources: (string | undefined)[] }, changes: { stopped?: boolean; eventReadBytes?: number; abandonedReadBytes?: number } = {}): BenchmarkPorts {
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
      return { timing: TIMING, wallMs: 4, stopped: changes.stopped ?? true, effects: 0, eventReadBytes: changes.eventReadBytes ?? 0, abandonedReadBytes: changes.abandonedReadBytes ?? 0 };
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

for (const reads of [{ eventReadBytes: PROFILE.eventBytes }, { abandonedReadBytes: 1 }]) test("acceptance rejects full event or abandoned-snapshot reads even with a fast fake child", async () => {
  const observed = { roots: [] as string[], sources: [] as (string | undefined)[] };
  await expect(runStartupBenchmark({ mode: "synthetic", samples: 1, profile: PROFILE, acceptance: true }, fakePorts(observed, reads))).rejects.toThrow();
  expect(observed.roots.every(root => !existsSync(root))).toBe(true);
});
