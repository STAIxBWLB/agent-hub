import { expect, test } from "bun:test";
import { runKimiWireDrainBenchmark } from "../../scripts/benchmarks/kimi-wire-drain-1283.ts";

test("the same synthetic backlog reports baseline and sliced I/O counts and yields between slices", async () => {
  const baseline = await runKimiWireDrainBenchmark("baseline");
  const sliced = await runKimiWireDrainBenchmark("sliced");
  expect(baseline.slices).toBe(16);
  expect(sliced.slices).toBe(16);
  expect(sliced.discovery).toBe(baseline.discovery);
  expect(sliced.bytes).toBe(baseline.bytes);
  expect(baseline.sliceMs).toHaveLength(1);
  expect(sliced.sliceMs).toHaveLength(16);
  expect(baseline.yields).toBe(0);
  expect(sliced.yields).toBeGreaterThan(0);
  expect(sliced.reports).toBe(1);
  for (const result of [baseline, sliced]) {
    expect(Number.isFinite(result.drainMs) && result.drainMs >= 0).toBe(true);
    expect(Number.isFinite(result.longestSliceMs) && result.longestSliceMs >= 0).toBe(true);
  }
}, 20_000);
