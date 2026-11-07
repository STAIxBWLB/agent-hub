import { expect, test } from "bun:test";
import { KIMI_WATCH_INPUT_BYTES, recordWatch1284Sample, runKimiReviewWatchBaseline, sampleCurrentAuthority, type Watch1284Sample } from "../../scripts/benchmarks/kimi-review-watch-1284.ts";

test("Kimi max-input baseline uses actual prepare and old peer timer, retaining separate authority cost and causal control ordering", async () => {
  const result = await runKimiReviewWatchBaseline();
  expect(result.inputBytes).toBe(KIMI_WATCH_INPUT_BYTES); expect(result.agentBytes).toBeGreaterThan(result.inputBytes);
  expect(result.authorityMs).toHaveLength(8); expect(result.authorityMs.every(ms => Number.isFinite(ms) && ms >= 0)).toBe(true);
  for (const rows of [result.ordinary, result.slow]) {
    expect(rows.startsMs).toHaveLength(3); expect(rows.checkMs).toHaveLength(3); expect(rows.startToStartMs).toHaveLength(2);
    expect(rows.maxConcurrent).toBe(1); expect(rows.checkMs.every(ms => Number.isFinite(ms) && ms >= 0)).toBe(true);
  }
  expect(result.ordinary.syntheticMs).toEqual([0, 0, 0]);
  expect(result.syntheticHoldMs).toBeGreaterThan(result.cadenceMs);
  expect(result.slow.syntheticMs.every(ms => Number.isFinite(ms) && ms >= 0)).toBe(true);
  expect(result.ordering.firstCheckStart).toBeGreaterThan(0);
  expect(result.ordering.firstCheckEnd).toBeGreaterThan(result.ordering.firstCheckStart);
  expect(result.ordering.controlDispatch).toBeGreaterThan(result.ordering.firstCheckEnd);
  expect(result.ordering.controlResponse).toBeGreaterThan(result.ordering.controlDispatch);
  expect(result.cleanup).toEqual({ peerStopped: 1, requesterJoined: 1, profileRemoved: 1, sourceUnchanged: 1 });
  const onlyNumbers = (value: unknown): boolean => {
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(onlyNumbers);
    return !!value && typeof value === "object" && Object.values(value).every(onlyNumbers);
  };
  expect(onlyNumbers(result)).toBe(true);
}, 20_000);

test("benchmark collectors preserve full authority refusal and start-to-start rather than end-to-start cadence", () => {
  let checked = 0; expect(sampleCurrentAuthority(() => { checked++; return true; }, 2)).toHaveLength(2); expect(checked).toBe(2);
  expect(() => sampleCurrentAuthority(() => false, 1)).toThrow("benchmark failed");
  const rows: Watch1284Sample = { startsMs: [], checkMs: [], syntheticMs: [], startToStartMs: [], maxConcurrent: 0 };
  recordWatch1284Sample(rows, 100, 3, 150, 1); recordWatch1284Sample(rows, 253, 4, 150, 1);
  expect(rows.startToStartMs).toEqual([153]); expect(rows.checkMs).toEqual([3, 4]); expect(rows.syntheticMs).toEqual([150, 150]);
});
