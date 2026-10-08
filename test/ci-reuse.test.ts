import { expect, test } from "bun:test";
import { findVerifiedRun } from "../scripts/ci-gates.mjs";

test("CI reuse requires the exact tree and both platform gates plus seeded guards", async () => {
  const runs = [1, 2, 3, 4].map(id => ({ id, head_sha: String(id), conclusion: "success", event: id === 1 ? "workflow_dispatch" : "pull_request" }));
  const queried: string[] = [];
  const api = async (path: string) => {
    queried.push(path);
    if (path.startsWith("actions/workflows/")) return { workflow_runs: runs };
    if (path.startsWith("git/commits/")) return { tree: { sha: path.endsWith("2") ? "different" : "expected" } };
    return { jobs: ["check (ubuntu-latest)", "check (macos-latest)", "seeded guards"].map(name => ({ name, conclusion: path.includes("/3/") && name === "seeded guards" ? "skipped" : "success" })) };
  };
  expect((await findVerifiedRun(api, "expected"))?.id).toBe(4);
  expect(queried).not.toContain("git/commits/1");
  expect(queried).not.toContain("actions/runs/2/jobs?per_page=100");
});

test("CI reuse refuses incomplete runs and propagates unavailable evidence", async () => {
  const api = async (path: string) => path.startsWith("actions/workflows/")
    ? { workflow_runs: [{ id: 1, head_sha: "1", conclusion: "success", event: "push" }] }
    : path.startsWith("git/") ? { tree: { sha: "expected" } } : { jobs: [] };
  expect(await findVerifiedRun(api, "expected")).toBeUndefined();
  await expect(findVerifiedRun(async () => { throw new Error("API unavailable"); }, "expected")).rejects.toThrow("API unavailable");
});
