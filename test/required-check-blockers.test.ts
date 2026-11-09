import { expect, test } from "bun:test";
import { requiredCiBlocker, readReviewReadiness, reviewReadinessFromEvidence, type PrEvidence } from "../src/hub/sdlc.ts";
const head = "a".repeat(40);
const checks: PrEvidence["checks"] = [{ name: "pending gate", state: "pending" }, { name: "failed gate", state: "failed" }, { name: "green gate", state: "passed" }];
const required = ["missing gate", "pending gate", "failed gate", "green gate"];
const blocker = "exact-head full CI is not green: missing missing gate; pending pending gate; failed failed gate";

test("every non-green required check is named with its status, in configured order (#1328)", () => {
  expect(requiredCiBlocker(required, checks)).toBe(blocker);
  expect(requiredCiBlocker(["green gate"], checks)).toBeUndefined();
  expect(requiredCiBlocker(["unknown"], [{ name: "unknown", state: "unknown" }])).toContain("unknown unknown");
  expect(requiredCiBlocker(["duplicate"], [{ name: "duplicate", state: "passed" }, { name: "duplicate", state: "passed" }])).toContain("duplicate duplicate");
  expect(requiredCiBlocker(["green gate"], checks, false)).toContain("unknown green gate");
});

const reply = (nodes: unknown[], complete = true) => ({ data: { repository: { pullRequest: { headRefOid: head, state: "OPEN", commits: { nodes: [{ commit: { oid: head, tree: { oid: "b".repeat(40) }, statusCheckRollup: { contexts: { nodes, pageInfo: { hasNextPage: !complete } } } } }] }, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } });
test("fresh CI read names missing/pending/failed checks and refuses truncated inventory (#1328)", async () => {
  const nodes = [{ name: "pending gate", status: "IN_PROGRESS", conclusion: null }, { name: "failed gate", status: "COMPLETED", conclusion: "FAILURE" }, { name: "green gate", status: "COMPLETED", conclusion: "SUCCESS" }];
  const read = (complete: boolean) => readReviewReadiness({ stage: "build", repo: "owner/repo", pr: 1 }, head, async () => ({ code: 0, stdout: JSON.stringify(reply(nodes, complete)) }), required);
  expect((await read(true)).blockers).toContain(blocker);
  expect((await read(false)).blockers).toContain(`exact-head full CI is not green: ${required.map(name => `unknown ${name}`).join("; ")}`);
});

test("complete cached and fresh CI evidence use identical named blockers (#1328)", async () => {
  const required = ["pending gate", "failed gate", "green gate"];
  const cached = reviewReadinessFromEvidence({ head, state: "OPEN", checks, paths: [], pathsComplete: true, typesComplete: true, review: "unknown", pendingReviews: 0, unresolved: 0 } as PrEvidence, head, required, "owner/repo");
  const nodes = checks.map(check => ({ name: check.name, status: check.state === "pending" ? "IN_PROGRESS" : "COMPLETED", conclusion: check.state === "failed" ? "FAILURE" : "SUCCESS" }));
  const fresh = await readReviewReadiness({ stage: "build", repo: "owner/repo", pr: 1 }, head, async () => ({ code: 0, stdout: JSON.stringify(reply(nodes)) }), required);
  expect(cached).toEqual(fresh);
});

for (const sample of [
  { label: "missing CheckRun status", node: { name: "gate", conclusion: "SUCCESS" }, problem: "unknown" },
  { label: "malformed CheckRun status", node: { name: "gate", status: "NOT_A_STATUS", conclusion: "SUCCESS" }, problem: "unknown" },
  { label: "WAITING is not a completed CheckRun", node: { name: "gate", status: "WAITING", conclusion: "SUCCESS" }, problem: "unknown" },
  { label: "CheckRun state cannot replace missing conclusion", node: { name: "gate", status: "COMPLETED", state: "SUCCESS" }, problem: "unknown" },
  { label: "StatusContext conclusion cannot replace failed state", node: { context: "gate", state: "FAILURE", conclusion: "SUCCESS" }, problem: "unknown" },
  { label: "valid completed CheckRun", node: { name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }, problem: undefined },
  { label: "valid StatusContext SUCCESS", node: { context: "gate", state: "SUCCESS" }, problem: undefined },
  { label: "pending CheckRun keeps its diagnostic", node: { name: "gate", status: "IN_PROGRESS", conclusion: null }, problem: "pending" },
  { label: "failed CheckRun keeps its diagnostic", node: { name: "gate", status: "COMPLETED", conclusion: "FAILURE" }, problem: "failed" },
  { label: "inconsistent nonpassed context stays blocked", node: { context: "gate", state: "SUCCESS", conclusion: "FAILURE" }, problem: "failed" },
] as const) test(`fresh success proof: ${sample.label} (#1328)`, async () => {
  const result = await readReviewReadiness({ stage: "build", repo: "owner/repo", pr: 1 }, head, async () => ({ code: 0, stdout: JSON.stringify(reply([sample.node])) }), ["gate"]);
  expect(result.ready).toBe(sample.problem === undefined);
  if (sample.problem) expect(result.blockers).toContain(`exact-head full CI is not green: ${sample.problem} gate`);
});

const validGate = { name: "gate", status: "COMPLETED", conclusion: "SUCCESS" };
const freshRows = (nodes: unknown[]) => readReviewReadiness({ stage: "build", repo: "owner/repo", pr: 1 }, head, async () => ({ code: 0, stdout: JSON.stringify(reply(nodes)) }), ["gate"]);
for (const sample of [
  { label: "long nonrequired name", node: { name: "x".repeat(150), status: "QUEUED", conclusion: null } },
  { label: "malformed nonrequired identity", node: { status: "COMPLETED", conclusion: "SUCCESS" } },
]) for (const position of ["before", "after"] as const) test(`fresh required rows ignore ${sample.label} ${position} valid gate (#1328)`, async () => {
  const nodes = position === "before" ? [sample.node, validGate] : [validGate, sample.node];
  const result = await freshRows(nodes);
  expect(result.ready).toBe(true); expect(result.blockers).toEqual([]);
});

test("irrelevant malformed rows cannot supply a missing required check (#1328)", async () => {
  const result = await freshRows([{ name: "other", status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "SUCCESS" }]);
  expect(result.ready).toBe(false);
  expect(result.blockers).toContain("exact-head full CI is not green: missing gate");
});
test("required-row selection retains duplicate required records (#1328)", async () => {
  const result = await freshRows([validGate, validGate]);
  expect(result.ready).toBe(false); expect(result.blockers).toContain("exact-head full CI is not green: duplicate gate");
});
test("fresh inventory bound applies before required-row selection (#1328)", async () => {
  const nodes = [validGate, ...Array.from({ length: 100 }, (_, i) => ({ name: `other${i}`, status: "COMPLETED", conclusion: "SUCCESS" }))];
  const result = await freshRows(nodes);
  expect(result.ready).toBe(false); expect(result.blockers).toContain("exact-head full CI is not green: unknown gate");
});
