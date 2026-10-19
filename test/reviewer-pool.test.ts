import { expect, test } from "bun:test";
import { selectReviewerPool, type ReviewerPoolCandidate, type ReviewerPoolInput } from "../src/hub/reviewer-pool.ts";

const pool = ["alpha", "beta", "gamma", "delta"];
const candidates = pool.map(kind => ({ id: `${kind}-review`, kind, family: kind }));
const select = (extra: Partial<ReviewerPoolInput> = {}) => selectReviewerPool({ pool, candidates, seed: 0, ...extra });

test("each implementer family gets an independent reviewer for every rotation start", () => {
  for (const implementerFamily of pool) for (let seed = 0; seed < pool.length; seed++) {
    const result = select({ implementerFamily, seed });
    expect(result.reviewer).not.toBeNull();
    expect(result.family).not.toBe(implementerFamily);
    expect(result.reason).not.toBe("same-family fallback");
  }
});

test("task-id or PR seed selects the declared kind slot before instance expansion", () => {
  for (const [seed, id] of [[0, "alpha-review"], [1, "beta-review"], [6, "gamma-review"], [11, "delta-review"]] as const) {
    expect(select({ seed }).reviewer).toBe(id);
  }
  const extras = [...candidates, { id: "alpha-a", kind: "alpha", family: "alpha" }];
  expect(select({ candidates: extras, seed: 1 }).reviewer).toBe("beta-review");
  expect(select({ candidates: extras, seed: 0 }).reviewer).toBe("alpha-a");
  expect(select({ pool: ["undeclared", "gamma", "alpha"], seed: 1 }).reviewer).toBe("gamma-review");
});

test("rotation skips unavailable and current-review failed candidates in order", () => {
  const blocked = candidates.map(candidate => candidate.kind === "alpha" ? { ...candidate, blocked: "offline" } : candidate);
  const result = select({ candidates: blocked, failed: ["beta-review"] });
  expect(result).toMatchObject({ reviewer: "gamma-review", family: "gamma", reason: "unavailable skip" });
  expect(result.walk.map(row => row.id)).toEqual(["alpha-review", "beta-review", "gamma-review"]);
  expect(result.walk[0]?.reason).toContain("offline");
  expect(result.walk[1]?.reason).toContain("failed");
  expect(select({ implementerFamily: "alpha" }).reason).toBe("implementer skip");
});

test("same-family fallback happens only after all other families cannot run", () => {
  const blocked = candidates.map(candidate => candidate.family === "alpha" ? candidate : { ...candidate, blocked: "paused" });
  expect(select({ candidates: blocked, implementerFamily: "alpha" })).toMatchObject({ reviewer: "alpha-review", family: "alpha", reason: "same-family fallback" });
  expect(select({ candidates: blocked, implementerFamily: "alpha", failed: ["alpha-review"] })).toMatchObject({ reviewer: null, blocked: "no reviewer can run" });
  const other = blocked.map(candidate => candidate.family === "delta" ? { id: candidate.id, kind: candidate.kind, family: candidate.family } : candidate);
  expect(select({ candidates: other, implementerFamily: "alpha" })).toMatchObject({ reviewer: "delta-review", family: "delta" });
});

test("delta continuity prefers the previous independent family and rerotate restores rotation", () => {
  expect(select({ implementerFamily: "alpha", continuityFamily: "delta", seed: 1 })).toMatchObject({ reviewer: "delta-review", family: "delta" });
  expect(select({ implementerFamily: "alpha", continuityFamily: "delta", seed: 1, rerotate: true }).reviewer).toBe("beta-review");
  expect(select({ implementerFamily: "alpha", continuityFamily: "alpha", seed: 1 }).reviewer).toBe("beta-review");
  expect(select({ implementerFamily: "alpha", continuityFamily: "delta", seed: 1, failed: ["delta-review"] }).reviewer).toBe("beta-review");
});

test("empty and exhausted pools produce an explicit blocked result", () => {
  expect(select({ candidates: [] })).toEqual({ reviewer: null, walk: pool.map(kind => ({ id: "", kind, family: "", reason: "no declared reviewer" })), blocked: "no reviewer can run" });
  expect(select({ pool: [] })).toEqual({ reviewer: null, walk: [], blocked: "no reviewer can run" });
  expect(select({ failed: candidates.map(candidate => candidate.id) })).toMatchObject({ reviewer: null, blocked: "no reviewer can run" });
  expect(select({ pool: ["unlisted"] })).toMatchObject({ reviewer: null, blocked: "no reviewer can run" });
});

test("candidate iteration order does not affect the walk and input data remains unchanged", () => {
  const rows: ReviewerPoolCandidate[] = [{ id: "beta-z", kind: "beta", family: "beta" }, ...candidates, { id: "beta-a", kind: "beta", family: "beta", blocked: "quota" }];
  const before = JSON.stringify(rows);
  const result = select({ candidates: rows, seed: 1 });
  expect(result.reviewer).toBe("beta-review");
  expect(select({ candidates: [...rows].reverse(), seed: 1 })).toEqual(result);
  expect(JSON.stringify(rows)).toBe(before);
  expect(select({ candidates: rows, pool: ["beta", "beta", "alpha"], seed: 1 }).reviewer).toBe("alpha-review");
});

test("missing declared kinds do not renumber configured rotation slots", () => {
  expect(select({ pool: ["missing", "alpha", "beta"], seed: 1 }).reviewer).toBe("alpha-review");
});

test("a missing configured kind is recorded as an unavailable slot before the selected reviewer", () => {
  const result = select({ pool: ["alpha", "beta"], candidates: [candidates[0]!], seed: 1 });
  expect(result).toMatchObject({ reviewer: "alpha-review", family: "alpha", reason: "unavailable skip" });
  expect(result.walk).toEqual([
    { id: "", kind: "beta", family: "", reason: "no declared reviewer" },
    { id: "alpha-review", kind: "alpha", family: "alpha", reason: "selected (unavailable skip)" },
  ]);
});

test("a selected walk entry describes selection rather than a skip", () => {
  const result = select({ failed: ["alpha-review"] });
  expect(result.reason).toBe("unavailable skip");
  expect(result.walk.at(-1)?.reason).toBe("selected (unavailable skip)");
});
