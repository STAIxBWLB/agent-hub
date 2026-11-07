import { afterEach, expect, test } from "bun:test";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyEventPrefix, installStartupReadObserver, isolatedStartupEnvironment, numericProfile, reservePrivateAttempt, runStartupBenchmark, timingLine, type BenchmarkPorts, type StartupProfile } from "../scripts/benchmarks/startup-1232.ts";
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
