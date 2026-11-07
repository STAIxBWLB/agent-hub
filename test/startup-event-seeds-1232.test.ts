import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseEventLine, readEvents, type StampedEvent } from "../src/hub/events.ts";
import { readStartupEventSeeds } from "../src/hub/startup-event-seeds.ts";
import { kimiSeedRows } from "../src/hub/kimi-usage.ts";
import { TokenWindow } from "../src/hub/token-window.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { realPath } from "../src/hub/project.ts";
import { installStartupReadObserver } from "../scripts/benchmarks/startup-1232.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory(): string { const root = realPath(mkdtempSync(join(tmpdir(), "ahub-startup-seeds-"))); roots.push(root); return root; }
const AT = "2026-01-02T03:00:00Z", NOW = Date.parse("2026-01-02T06:00:00Z");
const row = (fixtureTag: string, value: Record<string, unknown>) => ({ fixtureTag, at: AT, ...value });

function fixtureText(): string {
  const records = [
    row("native-old", { type: "native_turn_end", id: "old-native", at: "1970-01-01T00:00:00Z" }),
    row("native-unicode", { type: "native_turn_end", id: "native-제주", extra: "한라·제주" }),
    row("native-zero", { type: "native_turn_end", id: 0 }),
    row("native-numeric", { type: "native_turn_end", id: 42 }),
    row("claude", { type: "usage", source: "claude_transcript", id: "claude-a" }),
    row("claude-no-id", { type: "usage", source: "claude_transcript" }),
    row("claude-measured", { type: "usage", source: "claude_transcript", id: "claude-measured", at: "invalid", measuredAt: AT }),
    row("excluded-measured-old", { type: "usage", source: "claude_transcript", id: "excluded", measuredAt: "1960-01-01T00:00:00Z" }),
    row("excluded-measured-invalid", { type: "usage", source: "claude_transcript", id: "excluded", measuredAt: "invalid" }),
    row("reset-none", { type: "quota_reset", peer: "kimi", window: "tokens" }),
    row("reset-null", { type: "quota_reset", peer: "kimi", window: "tokens", resetsAt: null }),
    row("reset-value", { type: "quota_reset", peer: "kimi", window: "tokens", resetsAt: 1700 }),
    row("kimi-before", { type: "usage", source: "kimi_wire", id: "kimi-before", at: "2026-01-02T01:00:00Z", measuredAt: "2026-01-02T00:45:00Z", inputTokens: 5, cacheWriteTokens: 2, outputTokens: 3 }),
    row("resume-kimi", { type: "budget_resume", peer: "kimi", at: "2026-01-02T02:00:00Z" }),
    row("resume-other", { type: "budget_resume", peer: "other", at: AT }),
    row("kimi-after", { type: "usage", source: "kimi_wire", id: "kimi-after", at: "2026-01-02T02:30:00Z", measuredAt: "2026-01-02T01:30:00Z", inputTokens: 10, cacheWriteTokens: 4, outputTokens: 6 }),
    row("kimi-old", { type: "usage", source: "kimi_wire", id: "kimi-old", at: "2026-01-01T01:00:00Z", inputTokens: 99, outputTokens: 1 }),
    row("token-boundary", { type: "tokens", peer: "local", n: 7, at: "2026-01-02T01:00:00Z" }),
    row("token-old", { type: "tokens", peer: "local", n: 11, at: "2026-01-02T00:59:59Z" }),
    row("token-recent", { type: "tokens", peer: "local", n: 3 }),
    row("token-future", { type: "tokens", peer: "local", n: 13, at: "2026-01-02T07:00:00Z" }),
    row("token-other", { type: "tokens", peer: "other", n: 100 }),
    row("token-invalid", { type: "tokens", peer: "local", n: "4" }),
    row("excluded-old", { type: "state", at: "1960-01-01T00:00:00Z" }),
    row("excluded-invalid", { type: "state", at: "invalid" }),
    row("usage-other", { type: "usage", source: "other", id: "usage-other", at: "invalid", measuredAt: AT }),
    row("tail", { type: "native_turn_end", id: "tail-native" }),
  ];
  return ["", "  ", "{broken", "null", "[]", "0", ...records.map(value => JSON.stringify(value))].join("\r\n");
}

function consumers(events: StampedEvent[]) {
  const resetKeys = new Set(events.flatMap(event => event.type === "quota_reset" ? [`${event.peer}|${event.window}|${event.resetsAt ?? "none"}`] : []));
  const resumedAt = Math.max(0, ...events.flatMap(event => event.type === "budget_resume" && event.peer === "kimi" ? [Date.parse(event.at)] : []).filter(Number.isFinite));
  const window = new TokenWindow(5 * 3_600_000);
  window.seed(events.flatMap(event => event.type === "tokens" && event.peer === "local" ? [{ at: Date.parse(event.at), n: event.n }] : []), NOW);
  return { resetKeys, kimi: kimiSeedRows(events, resumedAt), tokenSum: window.sum(NOW), tokenOldest: window.oldest(NOW) };
}

for (const bufferBytes of [1, 2, 7, 64 * 1024]) test(`streaming startup seeds preserve historical predicates and all consumers at ${bufferBytes}-byte chunks`, () => {
  const root = directory(), file = join(root, "events.jsonl"), text = fixtureText(); writeFileSync(file, text);
  const legacy = readEvents(file), seeds = readStartupEventSeeds(file, { bufferBytes });
  expect(seeds.events).toEqual(legacy);
  expect(seeds.events.map(event => (event as StampedEvent & { fixtureTag: string }).fixtureTag)).toEqual([
    "native-old", "native-unicode", "native-zero", "native-numeric", "claude", "claude-no-id", "claude-measured",
    "reset-none", "reset-null", "reset-value", "kimi-before", "resume-kimi", "resume-other", "kimi-after", "kimi-old",
    "token-boundary", "token-old", "token-recent", "token-future", "token-other", "token-invalid", "usage-other", "tail",
  ]);
  expect(seeds.nativeStopsSeen).toEqual(new Set(legacy.flatMap(event => event.type === "native_turn_end" && event.id ? [event.id] : [])));
  expect(new Set<unknown>(seeds.nativeStopsSeen)).toEqual(new Set<unknown>(["old-native", "native-제주", 42, "tail-native"]));
  expect(seeds.claudeNativeUsageSeen).toEqual(new Set(legacy.filter(event => event.type === "usage" && event.source === "claude_transcript").map(event => (event as { id: string }).id)));
  expect(new Set<unknown>(seeds.claudeNativeUsageSeen)).toEqual(new Set<unknown>(["claude-a", undefined, "claude-measured"]));
  expect(consumers(seeds.events)).toEqual(consumers(legacy));
  const replay = consumers(seeds.events);
  expect(replay.resetKeys).toEqual(new Set(["kimi|tokens|none", "kimi|tokens|1700"]));
  expect(replay.kimi).toEqual([
    { id: "kimi-before", at: Date.parse("2026-01-02T00:45:00Z"), counted: 0 },
    { id: "kimi-after", at: Date.parse("2026-01-02T01:30:00Z"), counted: 20 },
    { id: "kimi-old", at: Date.parse("2026-01-01T01:00:00Z"), counted: 0 },
  ]);
  expect(replay.tokenSum).toBe(23);
  expect(replay.tokenOldest).toBe(Date.parse("2026-01-02T01:00:00Z"));
  expect(seeds.readPasses).toBe(1);
  expect(seeds.readBytes).toBe(Buffer.byteLength(text));
});

test("streaming startup reader performs one actual descriptor pass and no full-file read", async () => {
  const root = directory(), file = join(root, "events.jsonl"), text = fixtureText(); writeFileSync(file, text);
  const observer = await installStartupReadObserver(root);
  try {
    const seeds = readStartupEventSeeds(file, { bufferBytes: 7 });
    expect(observer.counts.eventReadBytes).toBe(Buffer.byteLength(text));
    expect(observer.counts.eventReadFileCalls).toBe(0);
    expect(seeds.readBytes).toBe(observer.counts.eventReadBytes);
  } finally { observer.restore(); }
});

test("shared line predicate retains the explicit since cutoff and measured-time fallback", () => {
  const line = JSON.stringify({ type: "usage", at: AT, measuredAt: "1970-01-01T00:00:00Z", source: "other" });
  expect(parseEventLine(line, 0)).toBeDefined();
  expect(parseEventLine(line, 1)).toBeUndefined();
  expect(parseEventLine(JSON.stringify({ type: "usage", at: AT, measuredAt: null }), Date.parse(AT))).toBeDefined();
  expect(parseEventLine(JSON.stringify({ type: "usage", at: AT, measuredAt: "invalid" }))).toBeUndefined();
});

test("streaming has no line-size ceiling and retains final valid JSON without a newline", () => {
  const root = directory(), file = join(root, "events.jsonl"), body = "x".repeat(1_100_000) + "제주";
  const text = JSON.stringify({ type: "chat", at: AT, body }); writeFileSync(file, text);
  const seeds = readStartupEventSeeds(file, { bufferBytes: 256 });
  expect(seeds.events).toHaveLength(1);
  expect((seeds.events[0] as unknown as { body: string }).body.length).toBe(body.length);
  expect((seeds.events[0] as unknown as { body: string }).body.endsWith("제주")).toBe(true);
  expect(seeds.readBytes).toBe(Buffer.byteLength(text));
  expect(parseEventLine(text)).toEqual(readEvents(file)[0]);
});

test("truncated final JSON, blanks, missing and empty files retain existing reader results", () => {
  const root = directory(), file = join(root, "events.jsonl");
  expect(readStartupEventSeeds(file)).toMatchObject({ events: [], readPasses: 0, readBytes: 0 });
  writeFileSync(file, "");
  expect(readStartupEventSeeds(file)).toMatchObject({ events: [], readPasses: 1, readBytes: 0 });
  writeFileSync(file, fixtureText() + '\n{"type":"usage","at":');
  expect(readStartupEventSeeds(file, { bufferBytes: 1 }).events).toEqual(readEvents(file));
  expect(() => readStartupEventSeeds(file, { bufferBytes: 0 })).toThrow("use the default reader buffer");
});

test("daemon emits one numeric observation and ignores a failing diagnostic observer", async () => {
  const root = directory(), observed: { readPasses: number; readBytes: number }[] = [];
  const daemon = await startDaemon({ cwd: root, stateDir: root, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
    startupSeedObserved: value => { observed.push(value); throw new Error("diagnostic unavailable"); },
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false } },
  });
  try {
    expect(observed).toHaveLength(1);
    expect(observed[0]!.readPasses).toBe(1);
    expect(observed[0]!.readBytes).toBeGreaterThan(0);
    expect(readFileSync(join(root, "hub.log"), "utf8")).toContain("startup timings ms: ");
  } finally { await daemon.stop(); }
}, 20_000);
