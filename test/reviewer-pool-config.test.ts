import { expect, test } from "bun:test";
import { reviewerPoolConfig } from "../src/hub/reviewer-pool-config.ts";

test("review pool config retains registry defaults and validates bounded explicit order", () => {
  const defaults = ["alpha", "beta"];
  expect(reviewerPoolConfig({}, defaults, defaults)).toEqual({ pool: defaults, rerotate: false });
  expect(reviewerPoolConfig({ pool: ["beta", "alpha"], rerotate: true }, defaults, defaults)).toEqual({ pool: ["beta", "alpha"], rerotate: true });
  for (const pool of [[], ["alpha", "alpha"], ["unknown"], ["alpha-review"], ["bad name"], [1], "alpha", null]) expect(() => reviewerPoolConfig({ pool }, defaults, defaults)).toThrow("review.pool");
  expect(() => reviewerPoolConfig({ rerotate: "yes" }, defaults, defaults)).toThrow("review.rerotate");
  expect(() => reviewerPoolConfig(null, defaults, defaults)).toThrow("review");
});

test("effective config accepts pool policy but rejects unknown kinds before use", async () => {
  const { validateRawConfig } = await import("../src/hub/config-apply.ts");
  expect(() => validateRawConfig({ review: { pool: ["codex", "claude", "kimi", "agy"], rerotate: false } })).not.toThrow();
  expect(() => validateRawConfig({ review: { pool: ["unregistered"] } })).toThrow("review.pool");
  for (const kind of ["local", "pi"]) expect(() => validateRawConfig({ review: { pool: [kind] } })).toThrow("review.pool");
});

test("default reviewer pool includes receipt-checked Kimi and excludes the agy implementer slot", async () => {
  const { DEFAULT_REVIEW_POOL, definitionOf } = await import("../src/adapters/registry.ts");
  expect(DEFAULT_REVIEW_POOL).toEqual(["claude", "codex", "kimi"]);
  expect(definitionOf("agy")?.reviewer).toMatchObject({ defaultPool: false, unavailable: "agy is an implementer peer (#485)" });
});

test("review quota opt-outs normalize explicit values and reject other literals with accepted values", () => {
  const kinds = ["alpha"];
  expect(reviewerPoolConfig({ gate: "off", unknown_quota: "pass" }, kinds, kinds)).toMatchObject({ gate: "off", unknownQuota: "pass" });
  expect(reviewerPoolConfig({ gate: 0, unknown_quota: "skip" }, kinds, kinds)).toMatchObject({ gate: 0, unknownQuota: "skip" });
  expect(reviewerPoolConfig({ gate: 1 }, kinds, kinds)).toMatchObject({ gate: 1 });
  for (const gate of ["OFF", "0.8", "PRIVATE_GATE_CANARY", null, false, NaN, Infinity, -0.1, 1.1]) {
    let error: unknown; try { reviewerPoolConfig({ gate }, kinds, kinds); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error); const message = (error as Error).message;
    expect(message).toContain("review.gate"); expect(message).toContain('"off" or a finite number in 0..1'); expect(message).not.toContain("PRIVATE_GATE_CANARY");
  }
  for (const unknown_quota of ["PASS", "off", "PRIVATE_POLICY_CANARY", null, false, 1]) {
    expect(() => reviewerPoolConfig({ unknown_quota }, kinds, kinds)).toThrow('review.unknown_quota must be "skip" or "pass"');
  }
});
