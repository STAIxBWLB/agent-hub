import { expect, test } from "bun:test";
import { readMergeQueue, type DeliveryTask } from "../src/hub/sdlc-queue.ts";
import { sdlcConfig, type SdlcGh } from "../src/hub/sdlc.ts";
const HEAD = "a".repeat(40), BASE = "b".repeat(40);
function queueFixture(drift: boolean) {
  const calls: string[][] = [], pageInfo = { hasNextPage: false };
  const labels = (number: number, final = false) => ({ number, labels: { nodes: drift && final && number === 2 ? [{ name: "bug" }] : [], pageInfo } });
  const files = [{ path: "src/fix.ts", changeType: "MODIFIED" }, { path: "test/new.test.ts", changeType: "ADDED" }];
  const pr = { headRefOid: HEAD, baseRefName: "main", baseRefOid: BASE, state: "OPEN", isDraft: false, changedFiles: 2,
    files, reviewDecision: "APPROVED", reviewRequests: [], statusCheckRollup: [{ name: "gate", conclusion: "SUCCESS" }] };
  const run: SdlcGh = async args => {
    calls.push(args);
    const query = args.find(arg => arg.startsWith("query=")) ?? "";
    const list = [{ number: 1, headRefOid: HEAD, baseRefName: "main", baseRefOid: BASE }];
    if (args[0] === "pr" && args[1] === "list") return { code: 0, stdout: JSON.stringify(list) };
    if (args[0] === "pr") return { code: 0, stdout: JSON.stringify(pr) };
    if (query.includes("queue_p")) {
      const repository: Record<string, unknown> = { pullRequests: { nodes: list, pageInfo },
        queue_p1: { ...pr, reviewRequests: { nodes: [], pageInfo }, reviewThreads: { nodes: [], pageInfo }, statusCheckRollup: { contexts: { nodes: pr.statusCheckRollup, pageInfo } } } };
      for (const match of query.matchAll(/(queue_i\d+|queue_issue\d+):issue\(number:(\d+)\)/g)) repository[match[1]!] = labels(Number(match[2]), true);
      return { code: 0, stdout: JSON.stringify({ data: { repository } }) };
    }
    const issue = Number(args.find(arg => arg.startsWith("issue="))?.slice(6) ?? args.at(-1)?.split("=")[1]);
    return { code: 0, stdout: JSON.stringify({ data: { repository: { issue: labels(issue), pullRequest: { headRefOid: HEAD, reviewThreads: { nodes: [], pageInfo } } } } }) };
  };
  const tasks: DeliveryTask[] = [1, 2].map(id => ({ id, private: false, after: [], receipt: {
    stage: "review", repo: "owner/repo", issue: id, pr: 1, reviewedHead: HEAD, localHead: HEAD, localResult: "passed",
  } }));
  return { run, calls, tasks };
}

test("S4 queue verifies every linked issue, including a second holder changing to bug", async () => {
  const f = queueFixture(true);
  const report = await readMergeQueue("owner/repo", sdlcConfig({ mode: "enforce", required_checks: ["gate"] }), f.tasks, f.run);
  expect(report.complete).toBe(false);
  expect(report.order).toEqual([]);
  expect(report.rows[0]?.ready).toBe(false);
  expect(f.calls.at(-1)?.join(" ")).toContain("queue_issue2:issue(number:2)");
});

test("S4 queue permits complete non-bug metadata for multiple holders of one PR", async () => {
  const f = queueFixture(false);
  const report = await readMergeQueue("owner/repo", sdlcConfig({ mode: "enforce", required_checks: ["gate"] }), f.tasks, f.run);
  expect(report.complete).toBe(true);
  expect(report.rows[0]?.ready).toBe(true);
  expect(report.rows[0]?.testIntegrity?.map(item => item.applicability)).toEqual(["not_bug", "not_bug"]);
});
