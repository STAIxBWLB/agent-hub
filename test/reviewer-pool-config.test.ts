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
