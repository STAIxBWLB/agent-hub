import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KimiUsage } from "../../src/hub/kimi-usage.ts";

const CHUNK = 128 * 1024;
const SLICES = 16;
const AGENTS = ["main", "agent-a", "agent-b"] as const;
const SESSION = "session_fixture";

export interface KimiWireDrainMeasurement {
  mode: "baseline" | "sliced";
  slices: number;
  drainMs: number;
  longestSliceMs: number;
  sliceMs: number[];
  discovery: number;
  bytes: number;
  yields: number;
  reports: number;
}

export async function runKimiWireDrainBenchmark(mode: "baseline" | "sliced"): Promise<KimiWireDrainMeasurement> {
  const home = mkdtempSync(join(tmpdir(), "ahub-kimi-drain-1283-"));
  try {
    const directory = join(home, "sessions", "wd_fixture", SESSION);
    for (const agent of AGENTS) mkdirSync(join(directory, "agents", agent), { recursive: true });
    writeFileSync(join(home, "session_index.jsonl"), `${JSON.stringify({ sessionId: SESSION, sessionDir: directory })}\n`);
    const now = 1_790_000_100_000, target = Math.floor((SLICES * CHUNK - 64 * 1024) / AGENTS.length);
    for (const agent of AGENTS) {
      const wire = join(directory, "agents", agent, "wire.jsonl");
      writeFileSync(wire, `${JSON.stringify({ type: "metadata", protocol_version: "1.5", created_at: now - 1000 })}\n`);
      for (let index = 0; statSync(wire).size < target; index++) {
        const rows = Array.from({ length: 100 }, (_, offset) => JSON.stringify({
          type: "usage.record", agentId: agent, model: "kimi-code/k3",
          usage: { inputOther: 1, output: 1, inputCacheRead: 10, inputCacheCreation: 0 }, usageScope: "turn", time: now - 100 + (index + offset) % 50,
        })).join("\n") + "\n";
        appendFileSync(wire, rows);
      }
    }
    const observations: { bytes: number; discovery: number }[] = [], durations: number[] = [];
    const pending = new Map<number, () => void>();
    let sequence = 0, reports = 0;
    const usage = new KimiUsage({
      home, maxBytes: CHUNK, now: () => now, ceiling: () => 1000, session: () => SESSION,
      observe: stats => observations.push(stats),
      ...(mode === "sliced" ? { schedule: (delay: number, run: () => void) => {
        const id = ++sequence;
        if (delay === 0) pending.set(id, () => {
          const before = observations.length, started = performance.now();
          run();
          if (observations.length > before) durations.push(performance.now() - started);
        });
        return () => { pending.delete(id); };
      } } : {}),
      record: () => {}, report: () => { reports++; }, forget: () => {}, notice: () => {},
    });
    const collect = () => {
      const before = observations.length, started = performance.now();
      usage.collect("kimi");
      if (observations.length > before) durations.push(performance.now() - started);
    };
    const started = performance.now();
    let yields = 0;
    if (mode === "baseline") {
      for (let pass = 0; observations.length < SLICES && pass < SLICES; pass++) collect();
      if (observations.length !== SLICES) throw new Error("baseline stopped before its backlog was read");
    } else {
      collect();
      while (observations.length < SLICES && pending.size) {
        const next = pending.entries().next().value as [number, () => void];
        pending.delete(next[0]);
        await new Promise<void>(resolve => setImmediate(resolve));
        yields++;
        next[1]();
      }
      if (observations.length !== SLICES) throw new Error("drain stopped before its backlog was read");
    }
    usage.stop();
    return {
      mode, slices: observations.length, drainMs: performance.now() - started,
      longestSliceMs: durations.length ? Math.max(...durations) : 0,
      sliceMs: durations,
      discovery: observations.reduce((sum, row) => sum + row.discovery, 0),
      bytes: observations.reduce((sum, row) => sum + row.bytes, 0), yields, reports,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (import.meta.main) console.log(JSON.stringify(await runKimiWireDrainBenchmark(process.argv[2] === "baseline" ? "baseline" : "sliced"), null, 2));
