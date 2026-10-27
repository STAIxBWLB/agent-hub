import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { decideMerge, type MergeInput } from "../src/hub/sdlc-merge.ts";
import type { DeliveryTask } from "../src/hub/sdlc-queue.ts";
import { sdlcConfig, type SdlcGh, type SdlcMode } from "../src/hub/sdlc.ts";
import { Tasks } from "../src/hub/tasks.ts";

// agent-hub #481 S5 (hub task #201): the eval gate through the real Tasks flow and the guarded merge decision, with a fake gh.
const HEAD = "a".repeat(40), BASE = "c".repeat(40);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const pageInfo = { hasNextPage: false };

interface World { paths: string[]; evalCheck: "passed" | "failed" | "absent"; text: string; coverage?: "complete" | "incomplete" }
function fakeGh(world: World) {
  const calls: string[][] = [];
  const checks = () => [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }, ...(world.evalCheck === "absent" ? [] : [{ name: "evals", status: "COMPLETED", conclusion: world.evalCheck === "passed" ? "SUCCESS" : "FAILURE" }])];
  const files = () => world.paths.map(path => ({ path, changeType: "MODIFIED" }));
  const changed = () => world.coverage === "incomplete" ? world.paths.length + 3 : world.paths.length;
  const gh: SdlcGh = async args => {
    calls.push(args);
    const query = args.find(arg => arg.startsWith("query=")) ?? "";
    const issue = Number(args.find(arg => arg.startsWith("issue="))?.slice(6) ?? 2);
    const view = { headRefOid: HEAD, state: "OPEN", isDraft: false, baseRefName: "main", baseRefOid: BASE, reviewDecision: "APPROVED", reviewRequests: [], statusCheckRollup: checks(), files: files(), changedFiles: changed(), headRefName: "feat/x" };
    let result: unknown;
    if (args[0] === "pr" && args[1] === "list") result = [{ number: 1, headRefOid: HEAD, baseRefName: "main", baseRefOid: BASE }];
    else if (args[0] === "pr" && args[1] === "view") result = view;
    else if (args[0] === "api" && args[1]?.includes("/check-runs")) result = { total_count: world.evalCheck === "absent" ? 0 : 1, check_runs: world.evalCheck === "absent" ? [] : [{ name: "evals", status: "completed", conclusion: "success", head_sha: HEAD, text: world.text }] };
    else if (query.includes("queue_p")) {
      const repository: Record<string, unknown> = { pullRequests: { nodes: [{ number: 1, headRefOid: HEAD, baseRefName: "main", baseRefOid: BASE }], pageInfo },
        queue_p1: { ...view, reviewRequests: { nodes: [], pageInfo }, reviewThreads: { nodes: [], pageInfo }, statusCheckRollup: { contexts: { nodes: checks(), pageInfo } } } };
      for (const match of query.matchAll(/(queue_i\d+|queue_issue\d+):issue\(number:(\d+)\)/g)) repository[match[1]!] = { number: Number(match[2]), labels: { nodes: [], pageInfo } };
      result = { data: { repository } };
    } else if (query.includes("reviewThreads") || query.includes("issue(number:")) result = { data: { repository: { pullRequest: { headRefOid: HEAD, reviewThreads: { nodes: [], pageInfo } }, issue: { number: issue, labels: { nodes: [], pageInfo } } } } };
    else throw new Error(`Unexpected metadata read: ${args.join(" ")}`);
    return { code: 0, stdout: JSON.stringify(result) };
  };
  return { gh, calls };
}

function rig(world: World, mode: SdlcMode = "enforce", extra: Record<string, unknown> = { eval_check: "evals" }) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-eval-gate-"));
  const board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 });
  cleanups.push(() => { board.close(); rmSync(dir, { recursive: true, force: true }); });
  const notices: string[] = [], remote = fakeGh(world);
  const config = () => sdlcConfig({ mode, required_checks: ["gate"], ...extra });
  const tasks = new Tasks({ board, bus, cwd: dir, project: "eval-gate", repository: "owner/repo", routing: () => loadRouting(dir), notify: message => notices.push(message), sdlc: { config, gh: remote.gh } });
  const task = board.propose(USER, { title: "tune the role text", class: "implement", plan: { paths: world.paths } });
  board.update(task.id, USER, "accepted", { owner: "codex", reviewer: USER, state: "in_progress" });
  tasks.recordLifecycle(USER, task.id, { repo: "owner/repo", issue: 2, pr: 1, localHead: HEAD, localResult: "passed", stage: "implement" });
  return { board, tasks, id: task.id, notices, calls: remote.calls, config };
}
const reported = "eval_pass_rate=0.92 eval_suite=smoke-1";

test("enforce: a configuration PR cannot be approved without the passing eval check, and a code-only PR is unaffected", async () => {
  const missing = rig({ paths: ["AGENTS.md"], evalCheck: "absent", text: "" });
  await missing.tasks.done("codex", missing.id, "updated the notes");
  await expect(missing.tasks.review(USER, missing.id, "approved", undefined, undefined, HEAD)).rejects.toThrow("required check evals: not successful on current head");
  expect(missing.board.get(missing.id)?.state).toBe("in_review");
  const failed = rig({ paths: ["docs/agent-notes/tests.md"], evalCheck: "failed", text: reported });
  await failed.tasks.done("codex", failed.id, "updated the notes");
  await expect(failed.tasks.review(USER, failed.id, "approved", undefined, undefined, HEAD)).rejects.toThrow("required check evals");
  const code = rig({ paths: ["src/hub/bus.ts"], evalCheck: "absent", text: "" });
  await code.tasks.done("codex", code.id, "code only");
  expect((await code.tasks.review(USER, code.id, "approved", undefined, undefined, HEAD)).state).toBe("approved");
  expect(code.calls.some(args => args[1]?.includes("/check-runs"))).toBe(false); // no eval read for a code-only PR
  expect(await code.tasks.lifecycleStatus(code.id)).not.toHaveProperty("evalGate");
});

test("enforce: a passing eval check with its pass rate and suite is approved, and the approval note records both", async () => {
  const r = rig({ paths: ["AGENTS.md", "src/hub/bus.ts"], evalCheck: "passed", text: reported });
  await r.tasks.done("codex", r.id, "updated AGENTS.md");
  expect((await r.tasks.review(USER, r.id, "approved", undefined, undefined, HEAD)).state).toBe("approved");
  const approved = r.board.get(r.id)!.history.findLast(h => h.event === "approved")!;
  expect(approved.note).toContain("Eval gate: evals passed at aaaaaaaaaaaa, pass rate 0.92, suite smoke-1");
  const status = await r.tasks.lifecycleStatus(r.id);
  expect(status.evalGate).toEqual({ applies: "config", files: 1, check: "evals", state: "passed", passRate: 0.92, suite: "smoke-1", gaps: [] });
});

test("enforce: a pass that reports no pass rate or suite version is refused; advise names the gap and approves", async () => {
  const strict = rig({ paths: ["AGENTS.md"], evalCheck: "passed", text: "all good" });
  await strict.tasks.done("codex", strict.id, "updated AGENTS.md");
  await expect(strict.tasks.review(USER, strict.id, "approved", undefined, undefined, HEAD)).rejects.toThrow("pass rate or suite version not reported by evals");
  expect(strict.board.get(strict.id)?.state).toBe("in_review");
  const advise = rig({ paths: ["AGENTS.md"], evalCheck: "passed", text: "all good" }, "advise");
  await advise.tasks.done("codex", advise.id, "updated AGENTS.md");
  expect((await advise.tasks.review(USER, advise.id, "approved", undefined, undefined, HEAD)).state).toBe("approved");
  expect(advise.notices.join(" ")).toContain("pass rate or suite version not reported by evals");
  expect(advise.board.get(advise.id)!.history.findLast(h => h.event === "approved")!.note ?? "").not.toContain("Eval gate:");
});

test("no eval_check configured: a configuration PR is approved in every mode and the notice names the pending suite choice, off reads nothing", async () => {
  const world: World = { paths: ["templates/roles/dev/code-reviewer.md"], evalCheck: "absent", text: "" };
  const enforce = rig(world, "enforce", {});
  await enforce.tasks.done("codex", enforce.id, "role text");
  expect((await enforce.tasks.review(USER, enforce.id, "approved", undefined, undefined, HEAD)).state).toBe("approved");
  expect((await enforce.tasks.lifecycleStatus(enforce.id)).evalGate).toMatchObject({ state: "not_configured", notes: [expect.stringContaining("suite choice pending the person")] });
  expect(enforce.calls.some(args => args[1]?.includes("/check-runs"))).toBe(false); // nothing to read with no check named
  const advise = rig(world, "advise", {});
  await advise.tasks.done("codex", advise.id, "role text");
  expect((await advise.tasks.review(USER, advise.id, "approved", undefined, undefined, HEAD)).state).toBe("approved");
  expect(advise.notices.join(" ")).toContain("eval check not configured");
  expect(advise.notices.join(" ")).toContain("suite choice pending the person");
  const off = rig(world, "off", {});
  await off.tasks.done("codex", off.id, "role text");
  expect((await off.tasks.review(USER, off.id, "approved")).state).toBe("approved");
  expect(off.calls).toEqual([]);
});

test("the guarded merge decision names the eval gate on every reading, and a code-only PR merges as before", async () => {
  const decide = async (world: World, mode: SdlcMode = "enforce", extra: Record<string, unknown> = { eval_check: "evals" }) => {
    const r = rig(world, mode, extra);
    const subject: DeliveryTask = { id: r.id, after: [], private: false, receipt: { repo: "owner/repo", issue: 2, pr: 1, stage: "merge", reviewedHead: HEAD, localHead: HEAD, localResult: "passed" } };
    const input: MergeInput = { subject, state: "approved", taskState: () => "approved", config: r.config(), tasks: [subject], run: fakeGh(world).gh };
    return decideMerge(input);
  };
  const refused = (d: Awaited<ReturnType<typeof decide>>) => "refused" in d ? d.refused : ["MERGE"];
  expect(refused(await decide({ paths: ["AGENTS.md"], evalCheck: "absent", text: "" }))).toEqual(expect.arrayContaining(["required check evals: missing"]));
  expect(refused(await decide({ paths: ["AGENTS.md"], evalCheck: "failed", text: reported }))).toEqual(expect.arrayContaining(["required check evals: failing"]));
  expect(refused(await decide({ paths: ["AGENTS.md"], evalCheck: "passed", text: "no markers" }))).toEqual(["eval gate: pass rate or suite version not reported by evals"]);
  expect(refused(await decide({ paths: ["AGENTS.md"], evalCheck: "passed", text: reported }))).toEqual(["MERGE"]);
  expect(refused(await decide({ paths: ["src/hub/bus.ts"], evalCheck: "absent", text: "" }))).toEqual(["MERGE"]);
  // Advise and off add no eval gate to the merge decision's evidence gates beyond the check itself.
  expect(refused(await decide({ paths: ["AGENTS.md"], evalCheck: "passed", text: "no markers" }, "advise"))).toEqual(["MERGE"]);
  // No eval_check named: nothing is required, so the decision is the one it was before this slice.
  expect(refused(await decide({ paths: ["AGENTS.md"], evalCheck: "absent", text: "" }, "enforce", {}))).toEqual(["MERGE"]);
  // Unknown file coverage is never read as a code-only PR in enforce.
  expect(refused(await decide({ paths: ["src/a.ts"], evalCheck: "absent", text: "", coverage: "incomplete" }))).toEqual(expect.arrayContaining(["eval gate: PR file coverage incomplete or unknown"]));
});
