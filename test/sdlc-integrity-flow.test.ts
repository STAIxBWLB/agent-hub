import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig, type SdlcGh, type SdlcMode } from "../src/hub/sdlc.ts";
import { Tasks } from "../src/hub/tasks.ts";
import type { RedFirstReceipt } from "../src/hub/test-integrity.ts";

const HEAD = "a".repeat(40), RED = "b".repeat(40), BASE = "c".repeat(40);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function rig(options: { mode?: SdlcMode; bug?: boolean; private?: boolean; change?: "ADDED" | "MODIFIED" | "DELETED"; labelsUnknown?: boolean; reportPath?: string; piiPaths?: string[] } = {}) {
  const mode = options.mode ?? "enforce", change = options.change ?? "ADDED";
  const dir = mkdtempSync(join(tmpdir(), "ahub-integrity-flow-"));
  const board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 });
  cleanups.push(() => { board.close(); rmSync(dir, { recursive: true, force: true }); });
  const calls: string[][] = [], notices: string[] = [];
  const files = [{ path: "src/fix.ts", changeType: "MODIFIED" }, { path: options.reportPath ?? "test/regression.test.ts", changeType: change }];
  const pageInfo = { hasNextPage: false };
  const labelsFor = (issue: number) => [{ name: issue === 3 || options.bug === false ? "enhancement" : "bug" }];
  const gh: SdlcGh = async args => {
    calls.push(args);
    const query = args.find(arg => arg.startsWith("query=")) ?? "";
    const issue = Number(args.find(arg => arg.startsWith("issue="))?.slice(6) ?? 2);
    let result: unknown;
    if (args[0] === "pr" && args[1] === "list") result = [{ number: 1, headRefOid: HEAD, baseRefName: "main", baseRefOid: BASE }];
    else if (query.includes("queue_p")) {
      const nodes = [{ name: "gate", conclusion: "SUCCESS" }];
      const repository: Record<string, unknown> = { pullRequests: { nodes: [{ number: 1, headRefOid: HEAD, baseRefName: "main", baseRefOid: BASE }], pageInfo },
        queue_p1: { headRefOid: HEAD, state: "OPEN", isDraft: false, baseRefName: "main", baseRefOid: BASE, changedFiles: files.length,
          reviewDecision: "APPROVED", reviewRequests: { nodes: [], pageInfo }, reviewThreads: { nodes: [], pageInfo }, statusCheckRollup: { contexts: { nodes, pageInfo } } } };
      for (const match of query.matchAll(/(queue_i\d+|queue_issue\d+):issue\(number:(\d+)\)/g)) repository[match[1]!] = { number: Number(match[2]), labels: { nodes: labelsFor(Number(match[2])), pageInfo } };
      result = { data: { repository } };
    }
    else if (args[0] === "pr" && args[1] === "view") result = {
      headRefOid: HEAD, state: "OPEN", isDraft: false, baseRefName: "main", baseRefOid: BASE,
      reviewDecision: "APPROVED", reviewRequests: [],
      statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }], files, changedFiles: files.length,
    };
    else if (query.includes("issue(number:") && !query.includes("reviewThreads")) {
      if (options.labelsUnknown) return { code: 1, stdout: "" };
      result = { data: { repository: { issue: { number: issue, labels: { nodes: labelsFor(issue), pageInfo } } } } };
    } else if (query.includes("commits(first:")) result = {
      data: { repository: { pullRequest: { headRefOid: HEAD, commits: { nodes: [{ commit: { oid: RED } }, { commit: { oid: HEAD } }], pageInfo } } } },
    };
    else if (args[1]?.startsWith("repos/owner/repo/commits/")) result = {
      sha: RED, parents: [BASE], files: [{ path: "test/regression.test.ts", change: "added" }],
    };
    else if (query.includes("object(expression:")) {
      const head = args.includes(`oid=${RED}`) ? RED : HEAD;
      result = { data: { repository: { object: { oid: head, statusCheckRollup: { contexts: {
        nodes: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: head === RED ? "FAILURE" : "SUCCESS" }], pageInfo,
      } } } } } };
    } else if (query.includes("reviewThreads")) result = {
      data: { repository: { pullRequest: { headRefOid: HEAD, reviewThreads: { nodes: [], pageInfo } },
        ...(query.includes("issue(number:") ? { issue: options.labelsUnknown ? null : { number: issue, labels: { nodes: labelsFor(issue), pageInfo } } } : {}) } },
    };
    else throw new Error(`Unexpected metadata read: ${args.join(" ")}`);
    return { code: 0, stdout: JSON.stringify(result) };
  };
  const tasks = new Tasks({ board, bus, cwd: dir, project: "integrity-flow", repository: "owner/repo",
    piiPaths: options.piiPaths, routing: () => loadRouting(dir), notify: message => notices.push(message), sdlc: { config: () => sdlcConfig({ mode, required_checks: ["gate"] }), gh } });
  const task = board.propose(USER, { title: options.private ? "patient 900101-1234567 marker" : "fix regression", class: "implement",
    plan: { paths: options.reportPath ? ["src/fix.ts", "test/regression.test.ts"] : files.map(file => file.path) }, ...(options.private ? { signals: ["pii"] } : {}) });
  board.update(task.id, USER, "accepted", { owner: "codex", reviewer: USER, state: "in_progress" });
  tasks.recordLifecycle(USER, task.id, { repo: "owner/repo", issue: 2, pr: 1, localHead: HEAD, localResult: "passed", stage: "implement" });
  const receipt = (source: RedFirstReceipt["red"]["source"] = "local"): RedFirstReceipt => ({
    red: { source, head: RED, check: "gate", result: "failed" },
    green: { source, head: HEAD, check: "gate", result: "passed" },
  });
  return { board, tasks, id: task.id, calls, notices, proof: (source?: RedFirstReceipt["red"]["source"]) => tasks.recordLifecycle(USER, task.id, { redFirst: receipt(source) }) };
}

test("S4 enforce rejects bug completion without red-first before changing task state or history", async () => {
  const r = rig(), before = r.board.get(r.id)!;
  await expect(r.tasks.done("codex", r.id, "fixed and checked")).rejects.toThrow("test integrity: red-first receipt missing");
  expect(r.board.get(r.id)?.state).toBe("in_progress");
  expect(r.board.get(r.id)?.history).toEqual(before.history);
  const status = await r.tasks.lifecycleStatus(r.id);
  expect(status.testIntegrity?.applicability).toBe("bug");
  expect(status.testIntegrity?.redFirst).toBe("missing");
});

for (const source of ["local", "container", "ci"] as const) test(`S4 ${source} red-first proof permits completion and exact-head approval`, async () => {
  const r = rig(); r.proof(source);
  expect((await r.tasks.done("codex", r.id, "added red regression, fixed and checked")).state).toBe("in_review");
  expect((await r.tasks.review(USER, r.id, "approved", undefined, undefined, HEAD)).state).toBe("approved");
  const status = await r.tasks.lifecycleStatus(r.id);
  expect(status.testIntegrity).toMatchObject({ applicability: "bug", redFirst: "verified", fileState: "complete", modifiedTests: [], sources: { red: source, green: source }, blockers: [] });
  expect(status.testIntegrity?.checkEvidence).toEqual({ red: source === "ci" ? "observed" : "claimed", green: source === "ci" ? "observed" : "claimed" });
  expect(status.ready).toBe(true);
  expect(r.calls.flat().join(" ")).not.toMatch(/\bbody\b|\bpatch\b|\bcomments\b/);
});

for (const change of ["MODIFIED", "DELETED"] as const) test(`S4 bug ${change} pre-existing test is a completion and approval blocker`, async () => {
  const r = rig({ change }); r.proof();
  await expect(r.tasks.done("codex", r.id, "changed existing regression")).rejects.toThrow("pre-existing test files modified or deleted");
  expect(r.board.get(r.id)?.state).toBe("in_progress");
  // A task already under review must face the same gate, including after a PR changes.
  r.board.update(r.id, USER, "done", { state: "in_review" });
  await expect(r.tasks.review(USER, r.id, "approved", undefined, undefined, HEAD)).rejects.toThrow("pre-existing test files modified or deleted");
  expect(r.board.get(r.id)?.state).toBe("in_review");
  expect((await r.tasks.lifecycleStatus(r.id)).testIntegrity?.modifiedTests).toEqual(["test/regression.test.ts"]);
});

test("S4 non-bug metadata exempts changed existing tests and missing red-first proof", async () => {
  const r = rig({ bug: false, change: "MODIFIED" });
  await r.tasks.done("codex", r.id, "enhancement checked");
  expect((await r.tasks.review(USER, r.id, "approved", undefined, undefined, HEAD)).state).toBe("approved");
  expect((await r.tasks.lifecycleStatus(r.id)).testIntegrity).toMatchObject({ applicability: "not_bug", redFirst: "not_required", modifiedTests: [], blockers: [] });
  expect(r.calls.some(args => args.join(" ").includes("commits(first:"))).toBe(false);
});

test("S4 advise exposes bug test integrity in status and notices without blocking transitions", async () => {
  const r = rig({ mode: "advise", change: "MODIFIED" });
  await r.tasks.done("codex", r.id, "regression checked");
  expect((await r.tasks.review(USER, r.id, "approved", undefined, undefined, HEAD)).state).toBe("approved");
  const status = await r.tasks.lifecycleStatus(r.id);
  expect(status.testIntegrity?.redFirst).toBe("missing");
  expect(status.testIntegrity?.modifiedTests).toEqual(["test/regression.test.ts"]);
  expect(status.blockers.some(blocker => blocker.startsWith("test integrity:"))).toBe(false);
  expect(r.notices.join(" ")).toContain("red-first receipt missing");
  expect(r.notices.join(" ")).toContain("pre-existing test files modified or deleted");
});

test("S4 off retains no new test integrity projection and performs no remote reads", async () => {
  const r = rig({ mode: "off", change: "DELETED" });
  await r.tasks.done("codex", r.id, "done");
  await r.tasks.review(USER, r.id, "approved");
  expect(await r.tasks.lifecycleStatus(r.id)).not.toHaveProperty("testIntegrity");
  expect(r.calls).toEqual([]);
});

test("S4 private status returns neutral unknown evidence without reading issue or PR metadata", async () => {
  const r = rig({ private: true });
  const status = await r.tasks.lifecycleStatus(r.id);
  expect(status.testIntegrity).toEqual({ applicability: "unknown", redFirst: "unknown", fileState: "unknown", modifiedTests: [], blockers: ["test integrity: private evidence unavailable"] });
  expect(r.calls).toEqual([]);
  expect(JSON.stringify(status)).not.toContain("900101");
  expect(JSON.stringify(status)).not.toContain("regression.test.ts");
});


test("S4 unknown issue labels cannot silently exempt an enforce task", async () => {
  const r = rig({ labelsUnknown: true });
  await expect(r.tasks.done("codex", r.id, "done")).rejects.toThrow("issue label metadata unknown");
  expect(r.board.get(r.id)?.state).toBe("in_progress");
});


for (const path of ["test/patient-900101-1234567.test.ts", `test/ghp_${"a".repeat(36)}.test.ts`, "test/private.test.ts"]) {
  test(`S4 public lifecycle withholds sensitive remote test metadata: ${path.slice(0, 22)}`, async () => {
    const r = rig({ mode: "advise", change: "MODIFIED", reportPath: path, piiPaths: ["test/private.test.ts"] });
    const view = r.tasks.publicView(r.board.get(r.id)!);
    expect(view.title).toBe("fix regression"); // The task itself is ordinary; only remote metadata is sensitive.
    const status = await r.tasks.lifecycleStatus(r.id);
    expect(status.testIntegrity).toMatchObject({ applicability: "unknown", modifiedTests: [], blockers: ["test integrity: private evidence unavailable"] });
    expect(JSON.stringify(status)).not.toContain(path);
    const queue = await r.tasks.deliveryQueue("owner/repo");
    expect(queue.rows[0]?.testIntegrity?.[0]).toMatchObject({ applicability: "unknown", modifiedTests: [] });
    expect(JSON.stringify(queue)).not.toContain(path);
  });
}

test("S4 receipt check metadata rejects secrets/private paths and is re-screened in public views", () => {
  const paths: string[] = ["test/private.test.ts"];
  const r = rig({ mode: "advise", piiPaths: paths });
  const proof = (check: string) => ({ red: { source: "local", head: RED, check, result: "failed" }, green: { source: "local", head: HEAD, check, result: "passed" } });
  for (const check of ["test/private.test.ts", `ghp_${"a".repeat(36)}`, "patient 900101-1234567"]) {
    expect(() => r.tasks.recordLifecycle(USER, r.id, { redFirst: proof(check) })).toThrow("PII");
  }
  paths.length = 0;
  r.tasks.recordLifecycle(USER, r.id, { redFirst: proof("test/private.test.ts") });
  paths.push("test/private.test.ts");
  expect(JSON.stringify(r.tasks.publicView(r.board.get(r.id)!))).not.toContain("test/private.test.ts");
});


test("S4 enforce spec relink cannot turn a rejected bug fix into a non-bug task", async () => {
  const r = rig({ change: "MODIFIED" });
  await expect(r.tasks.done("codex", r.id, "attempted completion")).rejects.toThrow("test integrity:");
  const before = r.board.get(r.id)!;
  expect(() => r.tasks.recordLifecycle("codex", r.id, { issue: 3 })).toThrow("only the person may relink");
  expect(() => r.tasks.recordLifecycle("codex", r.id, { repo: "other/repo" })).toThrow("only the person may relink");
  expect(r.board.get(r.id)).toEqual(before);
  await expect(r.tasks.done("codex", r.id, "still a bug fix")).rejects.toThrow("test integrity:");
  r.board.update(r.id, USER, "done", { state: "in_review" });
  await expect(r.tasks.review(USER, r.id, "approved", undefined, undefined, HEAD)).rejects.toThrow("test integrity:");
  // The person can deliberately replace the spec; the checked owner cannot.
  r.tasks.recordLifecycle(USER, r.id, { issue: 3 });
  expect((await r.tasks.lifecycleStatus(r.id)).testIntegrity?.applicability).toBe("not_bug");
  expect((await r.tasks.review(USER, r.id, "approved", undefined, undefined, HEAD)).state).toBe("approved");
});

test("S4 enforce protects an established spec even before its first bug observation", () => {
  const r = rig();
  expect(() => r.tasks.recordLifecycle("codex", r.id, { issue: 3 })).toThrow("only the person may relink");
  expect(r.calls).toEqual([]);
  expect(() => r.tasks.recordLifecycle("codex", r.id, { repo: "owner/repo", issue: 2, pr: 2 })).not.toThrow();
});

for (const mode of ["off", "advise"] as const) test(`S4 ${mode} preserves existing owner relink authority`, () => {
  const r = rig({ mode });
  expect(() => r.tasks.recordLifecycle("codex", r.id, { issue: 3 })).not.toThrow();
  expect(r.board.get(r.id)?.sdlc?.issue).toBe(3);
});
