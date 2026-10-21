import { expect, test } from "bun:test";
import { planConformance, planFingerprint } from "../src/hub/plan-conformance.ts";
const head = "a".repeat(40);
const evidence = (paths: string[], pathsComplete = true) => ({ head, paths, pathsComplete });
test("plan conformance compares literal exact and directory descendants directionally", () => {
  expect(planConformance(["src/hub", "docs/unused.md"], evidence(["src/hub/a.ts", "src/hubcap/a.ts", "README.md"]))).toEqual({ state: "departure", head, outside: ["src/hubcap/a.ts", "README.md"], untouched: ["docs/unused.md"] });
  expect(planConformance(["src/hub/a.ts"], evidence(["src/hub"]))).toMatchObject({ state: "departure", outside: ["src/hub"], untouched: ["src/hub/a.ts"] });
  expect(planConformance(["."], evidence(["src/a.ts", "README.md"]))).toEqual({ state: "covered", head, outside: [], untouched: [] });
});
test("plan conformance normalizes spelling and deduplicates without touching the inputs", () => {
  const planned = ["./src//hub/", "src/hub", "./docs/a.md"], changed = ["./src//hub/a.ts"];
  expect(planConformance(planned, evidence(changed))).toEqual({ state: "covered", head, outside: [], untouched: ["docs/a.md"] });
  expect(planned).toEqual(["./src//hub/", "src/hub", "./docs/a.md"]);
  expect(changed).toEqual(["./src//hub/a.ts"]);
  expect(planConformance(["src"], evidence(["src/a.ts", "./src/a.ts"])).state).toBe("unknown");
});
test("missing plan and incomplete PR coverage remain unknown, including empty replies", () => {
  for (const plan of [undefined, []]) expect(planConformance(plan, evidence([])).state).toBe("unknown");
  expect(planConformance(["src"], undefined)).toEqual({ state: "unknown", outside: [], untouched: [] });
  for (const pathsComplete of [false, undefined]) expect(planConformance(["src"], { head, paths: [], pathsComplete }).state).toBe("unknown");
  expect(planConformance(["src"], evidence([]))).toEqual({ state: "covered", head, outside: [], untouched: ["src"] });
});
test("invalid relative identities and heads cannot certify plan coverage", () => {
  for (const path of ["/tmp/a.ts", "../a.ts", "src/../a.ts", "src/./a.ts", "", "a\nb.ts", "C:/repo/a.ts"]) {
    expect(planConformance([path], evidence(["a.ts"])).state).toBe("unknown");
    expect(planConformance(["."], evidence([path])).state).toBe("unknown");
  }
  for (const bad of ["short", "A".repeat(40), "a".repeat(39)]) expect(planConformance(["."], { ...evidence([]), head: bad }).state).toBe("unknown");
  expect(planConformance(["."], evidence(Array.from({ length: 1001 }, (_, i) => `file${i}`))).state).toBe("unknown");
});
test("glob-looking paths remain literal file identities and never expand", () => {
  expect(planConformance(["test/*.ts"], evidence(["test/example.ts"]))).toMatchObject({ state: "departure", outside: ["test/example.ts"], untouched: ["test/*.ts"] });
  expect(planConformance(["test/*.ts"], evidence(["test/*.ts"]))).toMatchObject({ state: "covered", outside: [], untouched: [] });
});
test("plan fingerprints sort object keys while preserving list order and content", () => {
  const first = { paths: ["src/a.ts"], review: { scope: "delta", reviewers: 1 } };
  expect(planFingerprint(first)).toMatch(/^[a-f0-9]{64}$/);
  expect(planFingerprint(first)).toBe(planFingerprint({ review: { reviewers: 1, scope: "delta" }, paths: ["src/a.ts"] }));
  expect(planFingerprint({ proof: ["a", "b"] })).not.toBe(planFingerprint({ proof: ["b", "a"] }));
  expect(planFingerprint(first)).not.toBe(planFingerprint({ ...first, risks: ["compatibility"] }));
});
