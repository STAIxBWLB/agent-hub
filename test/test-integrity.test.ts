import { describe, expect, test } from "bun:test";
import { isTestPath, parseIssueLabels, parseRedFirst, readTestIntegrity, testIntegrityBlockers } from "../src/hub/test-integrity.ts";
import type { SdlcGh } from "../src/hub/sdlc.ts";

const RED = "a".repeat(40), HEAD = "b".repeat(40);
const receipt = () => ({ red: { source: "local" as const, head: RED, check: "bun test test/regression.test.ts", result: "failed" as const }, green: { source: "container" as const, head: HEAD, check: "bun test test/regression.test.ts", result: "passed" as const } });
const evidence = () => ({ head: HEAD, pathsComplete: true, typesComplete: true, fileChanges: [{ path: "test/regression.test.ts", change: "ADDED" }] });
const refs = () => ({ repo: "acme/project", issue: 12, pr: 34, redFirst: receipt() });
function fake(options: { labels?: string[]; truncated?: boolean; commitsTruncated?: boolean; files?: { path: string; change: string }[]; parents?: string[]; redState?: string; greenState?: string; head?: string; redMissing?: boolean; checksTruncated?: boolean; checkType?: string; commitIds?: string[]; commitMap?: Record<string, { parents: string[]; files: { path: string; change: string }[] }> } = {}) {
  const calls: string[][] = [];
  const run: SdlcGh = async args => {
    calls.push(args);
    const query = args.find(a => a.startsWith("query=")) ?? "";
    let result: unknown;
    if (query.includes("labels(")) result = { data: { repository: { issue: { number: 12, labels: { nodes: (options.labels ?? ["bug"]).map(name => ({ name })), pageInfo: { hasNextPage: options.truncated ?? false } } } } } };
    else if (query.includes("pullRequest(")) result = { data: { repository: { pullRequest: { headRefOid: options.head ?? HEAD, commits: { nodes: (options.commitIds ?? [...(options.redMissing ? [] : [RED]), HEAD]).map(oid => ({ commit: { oid } })), pageInfo: { hasNextPage: options.commitsTruncated ?? false } } } } } };
    else if (query.includes("object(")) {
      const red = args.includes(`oid=${RED}`);
      result = { data: { repository: { object: { oid: red ? RED : HEAD, statusCheckRollup: { contexts: { nodes: [{ __typename: options.checkType ?? "CheckRun", name: receipt().red.check, context: receipt().red.check, state: red ? options.redState ?? "FAILURE" : options.greenState ?? "SUCCESS", status: "COMPLETED", conclusion: red ? options.redState ?? "FAILURE" : options.greenState ?? "SUCCESS" }], pageInfo: { hasNextPage: options.checksTruncated ?? false } } } } } } };
    } else {
      const sha = args[1]!.split("/commits/")[1]!.split("?")[0]!;
      const metadata = options.commitMap?.[sha];
      result = { sha, parents: metadata?.parents ?? options.parents ?? ["c".repeat(40)], files: metadata?.files ?? options.files ?? [{ path: "test/regression.test.ts", change: "added" }] };
    }
    return { code: 0, stdout: JSON.stringify(result) };
  };
  return { run, calls };
}

describe("test integrity receipt", () => {
  test("strict source-labelled receipt round trips", () => expect(parseRedFirst(receipt())).toEqual(receipt()));
  test("rejects unknown fields, malformed hashes, controls, unequal checks and heads", () => {
    for (const value of [null, { ...receipt(), extra: true }, { ...receipt(), red: { ...receipt().red, head: "abc" } }, { ...receipt(), red: { ...receipt().red, check: "bad\ncheck" } }, { ...receipt(), green: { ...receipt().green, check: "other" } }, { ...receipt(), green: { ...receipt().green, head: RED } }, { ...receipt(), red: { ...receipt().red, source: "claimed" } }]) expect(() => parseRedFirst(value)).toThrow();
  });
  test("recognizes test directories and filenames without accepting unsafe paths", () => {
    for (const path of ["test/a.ts", "tests/a.py", "src/__tests__/a.ts", "src/a.test.ts", "src/a.spec.jsx", "pkg/cache_test.go", "src/test_cache.py", "src/cache_test.py", "lib/cache_spec.rb", "src/CacheTest.java", "src/Test.java"]) expect(isTestPath(path)).toBe(true);
    for (const path of ["src/tester.ts", "src/a.ts", "../test/a.ts", "/test/a.ts", "test/../src/a.ts", "pkg/cache_test.go.txt", "src/test_cache.ts", "src/cache_test.py.txt", "lib/cache_spec.js", "src/CacheTests.java"]) expect(isTestPath(path)).toBe(false);
  });
});

describe("test integrity metadata", () => {
  test("non-bug labels bypass all proof and PR reads", async () => {
    const f = fake({ labels: ["enhancement"] });
    const view = await readTestIntegrity(refs(), undefined, f.run);
    expect(view.applicability).toBe("not_bug"); expect(view.blockers).toEqual([]); expect(f.calls).toHaveLength(1);
  });
  test("complete preloaded labels avoid redundant reads, including known unavailable labels", async () => {
    const f = fake();
    const known = await readTestIntegrity(refs(), { ...evidence(), issueLabels: { issue: 12, labels: ["enhancement"] } }, f.run);
    expect(known.applicability).toBe("not_bug"); expect(f.calls).toHaveLength(0);
    const unavailable = await readTestIntegrity(refs(), { ...evidence(), issueLabels: { issue: 12, labels: null } }, f.run);
    expect(unavailable.applicability).toBe("unknown"); expect(f.calls).toHaveLength(0);
    const mismatch = await readTestIntegrity(refs(), { ...evidence(), issueLabels: { issue: 13, labels: [] } }, f.run);
    expect(mismatch.applicability).toBe("bug"); expect(f.calls.length).toBeGreaterThan(0);
  });
  test("label projection validates issue identity and completeness", () => {
    const labels = { nodes: [{ name: "bug" }], pageInfo: { hasNextPage: false } };
    expect(parseIssueLabels({ number: 12, labels }, 12)).toEqual(["bug"]);
    expect(parseIssueLabels({ number: 12, labels: { ...labels, nodes: [] } }, 12)).toEqual([]);
    expect(parseIssueLabels({ number: 13, labels }, 12)).toBeUndefined();
    expect(parseIssueLabels({ number: 12, labels: { ...labels, pageInfo: { hasNextPage: true } } }, 12)).toBeUndefined();
    expect(parseIssueLabels({ number: 12, labels: { ...labels, nodes: [{ name: "bad\nlabel" }] } }, 12)).toBeUndefined();
  });
  test("bug labels are exact and case insensitive", async () => {
    const f = fake({ labels: ["BUG"] }); const view = await readTestIntegrity(refs(), evidence(), f.run);
    expect(view.applicability).toBe("bug"); expect(view.redFirst).toBe("verified"); expect(view.sources).toEqual({ red: "local", green: "container" }); expect(view.checkEvidence).toEqual({ red: "claimed", green: "claimed" }); expect(view.blockers).toEqual([]);
    expect((await readTestIntegrity(refs(), evidence(), fake({ labels: ["bugfix"] }).run)).applicability).toBe("not_bug");
  });
  test("missing or truncated labels fail closed", async () => {
    expect((await readTestIntegrity(refs(), evidence(), fake({ truncated: true }).run)).applicability).toBe("unknown");
    expect((await readTestIntegrity({ pr: 34 }, evidence(), fake().run)).blockers.length).toBeGreaterThan(0);
  });
  test("modified and deleted pre-existing tests are flagged; added tests are allowed", async () => {
    const e = evidence(); e.fileChanges.push({ path: "src/a.spec.ts", change: "MODIFIED" }, { path: "tests/old.py", change: "DELETED" }, { path: "src/a.ts", change: "MODIFIED" });
    const view = await readTestIntegrity(refs(), e, fake().run);
    expect(view.modifiedTests).toEqual(["src/a.spec.ts", "tests/old.py"]); expect(view.blockers.length).toBeGreaterThan(0);
  });
  test("incomplete, renamed and missing inventories stay unknown", async () => {
    for (const e of [undefined, { ...evidence(), pathsComplete: false }, { ...evidence(), typesComplete: false }, { ...evidence(), fileChanges: [{ path: "test/a.ts", change: "RENAMED" }] }]) expect((await readTestIntegrity(refs(), e, fake().run)).fileState).toBe("unknown");
  });
  test("requires a red receipt and green at the PR head", async () => {
    expect((await readTestIntegrity({ repo: "acme/project", issue: 12, pr: 34 }, evidence(), fake().run)).redFirst).toBe("missing");
    expect((await readTestIntegrity({ ...refs(), redFirst: { ...receipt(), green: { ...receipt().green, head: "d".repeat(40) } } }, evidence(), fake().run)).redFirst).toBe("invalid");
  });
  test("red commit must be a complete single-parent tests-only addition", async () => {
    for (const options of [{ files: [{ path: "src/a.ts", change: "added" }] }, { files: [{ path: "test/a.ts", change: "modified" }] }, { parents: [HEAD, HEAD] }, { files: [] }]) expect((await readTestIntegrity(refs(), evidence(), fake(options).run)).redFirst).toBe("invalid");
    expect((await readTestIntegrity(refs(), evidence(), fake({ commitsTruncated: true }).run)).redFirst).toBe("unknown");
  });
  test("CI receipts require exact named failure then success, never cancellation", async () => {
    const r = refs(); r.redFirst.red.source = "ci" as never; r.redFirst.green.source = "ci" as never;
    expect((await readTestIntegrity(r, evidence(), fake().run)).redFirst).toBe("verified");
    expect((await readTestIntegrity(r, evidence(), fake({ redState: "CANCELLED" }).run)).redFirst).toBe("invalid");
    expect((await readTestIntegrity(r, evidence(), fake({ greenState: "FAILURE" }).run)).redFirst).toBe("invalid");
  });
  test("CI results require CheckRun identities and label observed evidence per leg", async () => {
    const r = refs(); r.redFirst.red.source = "ci" as never;
    const observed = await readTestIntegrity(r, evidence(), fake().run);
    expect(observed.redFirst).toBe("verified"); expect(observed.checkEvidence).toEqual({ red: "observed", green: "claimed" });
    for (const checkType of ["StatusContext", "Unknown", ""]) {
      const rejected = await readTestIntegrity(r, evidence(), fake({ checkType }).run);
      expect(rejected.redFirst).toBe("invalid"); expect(rejected.checkEvidence?.red).toBe("claimed");
    }
  });
  test("preceding implementation commits invalidate red-first regardless of connection order", async () => {
    const prior = "d".repeat(40), base = "c".repeat(40);
    for (const commitIds of [[HEAD, RED, prior], [prior, HEAD, RED]]) {
      const f = fake({ commitIds, commitMap: {
        [RED]: { parents: [prior], files: [{ path: "test/regression.test.ts", change: "added" }] },
        [prior]: { parents: [base], files: [{ path: "src/fix.ts", change: "modified" }] },
      } });
      expect((await readTestIntegrity(refs(), evidence(), f.run)).redFirst).toBe("invalid");
    }
  });
  test("preceding tests-only commits are allowed but merge and cyclic ancestry refuse", async () => {
    const prior = "d".repeat(40), base = "c".repeat(40);
    const setup = { parents: [prior], files: [{ path: "test/regression.test.ts", change: "added" }] };
    const testFiles = [{ path: "src/cache_test.py", change: "modified" }];
    const f = fake({ commitIds: [HEAD, RED, prior], commitMap: { [RED]: setup, [prior]: { parents: [base], files: testFiles } } });
    expect((await readTestIntegrity(refs(), evidence(), f.run)).redFirst).toBe("verified");
    const merge = fake({ commitIds: [HEAD, RED, prior], commitMap: { [RED]: setup, [prior]: { parents: [base, HEAD], files: testFiles } } });
    expect((await readTestIntegrity(refs(), evidence(), merge.run)).redFirst).toBe("invalid");
    const cycle = fake({ commitIds: [HEAD, RED, prior], commitMap: { [RED]: setup, [prior]: { parents: [RED], files: testFiles } } });
    expect((await readTestIntegrity(refs(), evidence(), cycle.run)).redFirst).toBe("unknown");
  });
  test("commit truncation, drift, absent red and check pagination refuse proof", async () => {
    expect((await readTestIntegrity(refs(), evidence(), fake({ files: Array.from({ length: 100 }, (_, i) => ({ path: `test/${i}.ts`, change: "added" })) }).run)).redFirst).toBe("unknown");
    expect((await readTestIntegrity(refs(), evidence(), fake({ head: RED }).run)).redFirst).toBe("unknown");
    expect((await readTestIntegrity(refs(), evidence(), fake({ redMissing: true }).run)).redFirst).toBe("invalid");
    const r = refs(); r.redFirst.red.source = "ci" as never;
    expect((await readTestIntegrity(r, evidence(), fake({ checksTruncated: true }).run)).redFirst).toBe("unknown");
  });
  test("remote errors reveal no remote text and all calls have metadata-only bounded arguments", async () => {
    const f = fake(); await readTestIntegrity(refs(), evidence(), f.run);
    expect(f.calls.every(args => !args.join(" ").includes("patch") && !args.join(" ").includes("body"))).toBe(true);
    const bad: SdlcGh = async () => ({ code: 1, stdout: "private remote text" });
    const view = await readTestIntegrity(refs(), evidence(), bad); expect(JSON.stringify(view)).not.toContain("private remote text"); expect(testIntegrityBlockers(view).length).toBeGreaterThan(0); expect(testIntegrityBlockers(undefined)).toEqual([]);
  });
});
