import { expect, test } from "bun:test";
import { sdlcConfig, sdlcReceipt, parsePrEvidence, sdlcStatus } from "../src/hub/sdlc.ts";
import { profileTaskTools } from "../src/hub/hub-tools.ts";

const RED = "a".repeat(40), HEAD = "b".repeat(40);
const redFirst = {
  red: { source: "local", head: RED, check: "regression", result: "failed" },
  green: { source: "container", head: HEAD, check: "regression", result: "passed" },
};
const enabled = sdlcConfig({ mode: "enforce", required_checks: ["gate"] });

test("enabled lifecycle records source-labelled red-first legs and relinking invalidates them", () => {
  const receipt = sdlcReceipt({ stage: "test", repo: "owner/repo", issue: 1, pr: 2, redFirst }, undefined, enabled);
  expect(receipt).toMatchObject({ redFirst });
  expect(sdlcReceipt({ issue: 3 }, receipt, enabled)).not.toHaveProperty("redFirst");
  expect(sdlcReceipt({ repo: "other/repo" }, receipt, enabled)).not.toHaveProperty("redFirst");
  expect(sdlcReceipt({ pr: 4 }, receipt, enabled)).not.toHaveProperty("redFirst");
});

test("PR evidence carries change types used by S4 independently of S2 count completeness", () => {
  const read = parsePrEvidence({ headRefOid: HEAD, state: "OPEN", changedFiles: 2,
    statusCheckRollup: [], reviewRequests: [], unresolvedThreads: 0,
    files: [{ path: "test/new.test.ts", changeType: "ADDED" }, { path: "test/old.test.ts", changeType: "MODIFIED" }] });
  expect(read).toMatchObject({ pathsComplete: true, typesComplete: true, fileChanges: [
    { path: "test/new.test.ts", change: "ADDED" }, { path: "test/old.test.ts", change: "MODIFIED" },
  ] });
});

test("only the enabled lifecycle advertises red-first input; off retains its old receipt boundary", () => {
  const schema = (criteria: boolean) => profileTaskTools("dev", undefined, criteria).find(tool => tool.name === "hub_sdlc_record")!.inputSchema.properties.receipt as { properties: Record<string, unknown> };
  expect(schema(true).properties).toHaveProperty("redFirst");
  expect(schema(false).properties).not.toHaveProperty("redFirst");
  expect(() => sdlcReceipt({ redFirst })).toThrow();
});

test("S4 blocks enforce readiness and stays visible advice without blocking advise", () => {
  const receipt = { stage: "review", repo: "owner/repo", issue: 1, pr: 2, reviewedHead: HEAD, localHead: HEAD, localResult: "passed" as const };
  const evidence = parsePrEvidence({ headRefOid: HEAD, state: "OPEN", changedFiles: 0, files: [],
    reviewDecision: "APPROVED", reviewRequests: [], unresolvedThreads: 0, statusCheckRollup: [{ name: "gate", conclusion: "SUCCESS" }] });
  const integrity = { applicability: "bug", redFirst: "missing", fileState: "complete", modifiedTests: ["test/old.test.ts"], blockers: ["test integrity: red-first receipt missing", "test integrity: pre-existing test files modified or deleted"] };
  const status = (mode: "enforce" | "advise" | "off") => Reflect.apply(sdlcStatus, undefined,
    [sdlcConfig({ mode, required_checks: ["gate"] }), receipt, evidence, undefined, undefined, [], undefined, undefined, integrity]);
  expect(status("enforce").ready).toBe(false);
  expect(status("enforce").blockers).toContain("test integrity: red-first receipt missing");
  expect(status("advise").ready).toBe(true);
  expect(status("advise")).toMatchObject({ testIntegrity: integrity });
  expect(status("off")).not.toHaveProperty("testIntegrity");
});
