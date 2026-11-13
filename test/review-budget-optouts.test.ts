import { expect, test } from "bun:test";
import { DEFAULT_REVIEW_UNKNOWN_QUOTA, reviewBudgetAdmission, reviewBudgetPolicyDescription, type ReviewBudgetSnapshot, type ReviewGate, type ReviewUnknownQuota } from "../src/hub/review-budget.ts";
import { selectReviewerPool } from "../src/hub/reviewer-pool.ts";

const now = 1_700_000_000_000;
const snapshot = (extra: Partial<ReviewBudgetSnapshot> = {}): ReviewBudgetSnapshot => ({ gate: 0.8, now, readings: {}, paused: {}, ...extra });
const candidates = [{ id: "alpha-review", kind: "alpha", family: "alpha" }, { id: "beta-review", kind: "beta", family: "beta" }];
const choose = (budget: ReviewBudgetSnapshot, extra: Partial<Parameters<typeof selectReviewerPool>[0]> = {}) => selectReviewerPool({ pool: ["alpha", "beta"], candidates, seed: 0, budget, ...extra });

test("default unknown quota remains skip with actionable settings and a reusable bounded host policy description", () => {
  expect(DEFAULT_REVIEW_UNKNOWN_QUOTA).toBe("skip");
  const denied = reviewBudgetAdmission("alpha-review", snapshot()); expect(denied.state).toBe("unknown");
  expect(denied.reason).toContain("review.unknown_quota=pass"); expect(denied.reason).toContain("review.gate=off");
  expect(reviewBudgetPolicyDescription({ gate: 0.8 })).toContain("review.unknown_quota=skip");
  expect(reviewBudgetPolicyDescription({ gate: 0.8, unknownQuota: "pass" })).toContain("unknown quota admitted");
  const off = reviewBudgetPolicyDescription({ gate: "off" }); expect(off).toContain("waiting disabled"); expect(off).toContain("Budget/manual pauses still block");
});

test("gate off bypasses missing, invalid and above-floor readings without inventing reset evidence", () => {
  const cases: ReviewBudgetSnapshot["readings"][] = [{}, { "alpha-review": { headroom: 0.01, resetsAt: now + 60_000 } }, { "alpha-review": { headroom: NaN, resetsAt: now + 60_000 } }];
  for (const readings of cases) {
    const admitted = reviewBudgetAdmission("alpha-review", snapshot({ gate: "off", readings }));
    expect(admitted).toEqual({ state: "available", rule: "review.gate=off (quota floor and unknown check disabled)" });
    expect(choose(snapshot({ gate: "off", readings })).quotaWait).toBeUndefined();
  }
});

test("off and unknown-pass never lift an actual Budget or manual pause, and off disables all quota waiting", () => {
  for (const gate of ["off", 0.8] as const) for (const unknownQuota of ["skip", "pass"] as const) {
    const budget = snapshot({ gate, unknownQuota, paused: { "alpha-review": { resetsAt: now + 60_000 }, "beta-review": { resetsAt: now + 120_000 } } });
    expect(reviewBudgetAdmission("alpha-review", budget).state).toBe("paused");
    expect(reviewBudgetAdmission("alpha-review", { ...budget, manualPaused: ["alpha-review"] }).state).toBe("manual");
    const selected = choose(budget, { candidates: candidates.map(row => ({ ...row, blocked: "paused" })) });
    expect(selected.reviewer).toBeNull(); if (gate === "off") expect(selected.quotaWait).toBeUndefined();
  }
});

test("unknown pass admits only unknown observations; known numeric floor and normal admissions retain their rule", () => {
  const budget = snapshot({ unknownQuota: "pass", readings: { "alpha-review": { headroom: 0.1, resetsAt: now + 60_000 } } });
  expect(reviewBudgetAdmission("alpha-review", budget).state).toBe("floor");
  const unknown = reviewBudgetAdmission("beta-review", budget); expect(unknown.state).toBe("available"); expect(unknown.rule).toContain("review.unknown_quota=pass"); expect(unknown.resetsAt).toBeUndefined();
  const selected = choose(budget); expect(selected.reviewer).toBe("beta-review"); expect(selected.quotaWait).toBeUndefined();
  expect(selected.walk.at(-1)?.reason).toContain("selected (unavailable skip); admitted by review.unknown_quota=pass");
  const known = reviewBudgetAdmission("alpha-review", snapshot({ readings: { "alpha-review": { headroom: 0.4 } } }));
  expect(known.state).toBe("available"); expect(known.rule).toContain("review.gate=0.8"); expect(known.rule).toContain("below 80% floor");
});

test("an admitted unknown with another blocker cannot manufacture a quota-only wait", () => {
  const budget = snapshot({ unknownQuota: "pass", paused: { "alpha-review": { resetsAt: now + 60_000 } } });
  const selected = choose(budget, { candidates: [{ ...candidates[0]!, blocked: "paused" }, { ...candidates[1]!, blocked: "offline" }] });
  expect(selected.reviewer).toBeNull(); expect(selected.quotaWait).toBeUndefined(); expect(selected.walk.at(-1)?.reason).toContain("offline");
});

test("opt-outs preserve failed, same-family and non-quota health blockers", () => {
  for (const budget of [snapshot({ gate: "off" }), snapshot({ unknownQuota: "pass" })]) {
    expect(choose(budget, { failed: ["alpha-review", "beta-review"] }).reviewer).toBeNull();
    expect(choose(budget, { implementerFamily: "alpha", sameFamily: "never", candidates: [candidates[0]!] }).reviewer).toBeNull();
    for (const blocked of ["offline", "isolation unavailable", "off roster", "paused"]) expect(choose(budget, { candidates: candidates.map(row => ({ ...row, blocked })) }).reviewer).toBeNull();
  }
});

test("invalid host policies remain unavailable without echoing unsupported caller literals", () => {
  for (const gate of ["PRIVATE_GATE_CANARY", NaN, Infinity, -1, 2] as unknown as ReviewGate[]) {
    const denied = reviewBudgetAdmission("alpha-review", snapshot({ gate, unknownQuota: "pass" })); expect(denied.state).toBe("unknown"); expect(denied.reason).not.toContain("PRIVATE_GATE_CANARY");
  }
  const unknownQuota = "PRIVATE_POLICY_CANARY" as ReviewUnknownQuota;
  expect(reviewBudgetAdmission("alpha-review", snapshot({ gate: "off", unknownQuota })).state).toBe("unknown");
  expect(reviewBudgetPolicyDescription({ gate: 0.8, unknownQuota })).not.toContain("PRIVATE_POLICY_CANARY");
});
