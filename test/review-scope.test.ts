import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import type { Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { classifyVerificationOnly, CODE_SCOPE_LINE, CODE_SCOPE_REFUSAL, verificationOnlyItem, type ReviewScope } from "../src/hub/review-scope.ts";
import { Tasks } from "../src/hub/tasks.ts";

// agent-hub#852 (task #514): a review scope. A `code` reviewer's sandbox cannot run tests or read CI, so its request says so and its
// verification-only rejection is refused; a `full` reviewer keeps today's text and every verdict.
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const head = "a".repeat(40);
class Reviewer extends BasePeer { received: Envelope[] = []; async start() { this.setState("idle"); } async stop() { this.setState("offline"); } async deliver(envs: Envelope[]) { this.received.push(...envs); } }

function rig(scope: ReviewScope | undefined, opts: { checkPassed?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-review-scope-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  const roles: Record<string, string[]> = { codex: ["implementer"], "codex-review": ["reviewer"], director: ["conductor"] };
  const tasks = new Tasks({ cwd: dir, board, bus, roles, project: "review-scope", routing: () => loadRouting(dir), reviewOnly: peer => peer === "codex-review", ...(scope ? { reviewScope: () => scope } : {}), notify: text => notices.push(text) });
  const task = board.propose("user", { title: "finished implementation", class: "implement" });
  board.update(task.id, "user", "accepted", { owner: "codex", reviewer: "codex-review", state: "in_progress", refs: { commit: head } });
  if (opts.checkPassed) board.update(task.id, "hub", "check passed", {}, "scripts/check.sh -> exit 0\ncheck: OK");
  const peer = new Reviewer("codex-review"); bus.add(peer);
  cleanups.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  const body = async () => { await peer.start(); await tasks.done("codex", task.id, "done"); return peer.received.filter(env => env.kind === "review").at(-1)?.body ?? ""; };
  return { tasks, board, task, notices, body };
}

const VERIFICATION_ONLY = ["Required scripts/check.sh --changed success at 34dbc3b0413a26bec589175f5ed60d44ed06374f has not been verified; provide its successful receipt.", "Required exact-head CI is not green per hub brief; provide green required checks before merge."];

test("AC2: a code reviewer's request replaces every check and CI line with one fixed line; a full reviewer keeps today's text", async () => {
  const code = await rig("code").body();
  expect(code).toContain(CODE_SCOPE_LINE);
  for (const gone of ["No check ran for this class", "run the affected tests yourself", "Hub-verified", "CI passed at this exact head", "exact-head full CI is not green"]) expect(code, gone).not.toContain(gone);
  expect((code.match(/Your sandbox cannot run tests or read CI/g) ?? []).length).toBe(1);
  // Everything else about the checklist is as before.
  expect(code).toContain("Map the changed signatures and call sites to");
  expect(code).toContain("List what is unmet in hub_review's unmet, one item each.");
  for (const scope of ["full", undefined] as const) {
    const full = await rig(scope).body();
    expect(full, String(scope)).toContain("No check ran for this class: run the affected tests yourself.");
    expect(full, String(scope)).not.toContain("Your sandbox cannot run tests or read CI");
  }
  // A check the hub itself ran still shows for a full reviewer, and is not shown to a code reviewer who could not read it.
  expect(await rig("full", { checkPassed: true }).body()).toContain("Check result: scripts/check.sh -> exit 0");
  const codeWithCheck = await rig("code", { checkPassed: true }).body();
  expect(codeWithCheck).toContain(CODE_SCOPE_LINE); expect(codeWithCheck).not.toContain("Check result:");
});

test("AC3: a code reviewer's approval records scope code in the history, and a full reviewer's verdict records none", async () => {
  const code = rig("code"); await code.body();
  const approved = await code.tasks.review("codex-review", code.task.id, "approved", "the code matches the plan");
  expect(approved.state).toBe("approved");
  expect(approved.history.findLast(entry => entry.event === "approved")).toMatchObject({ by: "codex-review", reviewScope: "code" });
  const full = rig("full"); await full.body();
  const done = await full.tasks.review("codex-review", full.task.id, "approved", "ok");
  expect(done.history.findLast(entry => entry.event === "approved")?.reviewScope).toBeUndefined();
  const none = rig(undefined); await none.body();
  expect((await none.tasks.review("codex-review", none.task.id, "approved", "ok")).history.findLast(entry => entry.event === "approved")?.reviewScope).toBeUndefined();
});

test("AC3: a code reviewer's verification-only changes_requested is refused before any effect, naming AC2, and never counts toward escalation", async () => {
  const f = rig("code"); await f.body();
  const before = f.board.get(f.task.id)!, rejectionsBefore = before.rejections, historyBefore = before.history.length;
  for (const unmet of [VERIFICATION_ONLY, [VERIFICATION_ONLY[1]!], ["Affected tests remain unverified: bun test failed in preload with EPERM before any test ran."]]) {
    await expect(f.tasks.review("codex-review", f.task.id, "changes_requested", "cannot verify", unmet)).rejects.toThrow("#852 AC2");
  }
  await expect(f.tasks.review("codex-review", f.task.id, "changes_requested", CODE_SCOPE_REFUSAL.slice(0, 20), VERIFICATION_ONLY)).rejects.toThrow(/code-scope reviewer cannot establish|review scope is code/);
  const after = f.board.get(f.task.id)!;
  expect(after.state).toBe("in_review"); expect(after.rejections).toBe(rejectionsBefore); expect(after.history.length).toBe(historyBefore);
  expect(after.history.some(entry => entry.event === "changes_requested")).toBe(false);
});

test("AC3: a code reviewer's real code finding, or a mixed verdict, is accepted and counts; a full reviewer may cite verification", async () => {
  const f = rig("code"); await f.body();
  const mixed = await f.tasks.review("codex-review", f.task.id, "changes_requested", "two points", [...VERIFICATION_ONLY, "validateInstances does not refuse a non-string model."]);
  expect(mixed.rejections).toBe(1);
  expect(mixed.history.findLast(entry => entry.event === "changes_requested")).toMatchObject({ reviewScope: "code" });
  const code = rig("code"); await code.body();
  expect((await code.tasks.review("codex-review", code.task.id, "changes_requested", "bug", ["src/hub/tasks.ts review() does not handle a withheld note."])).rejections).toBe(1);
  // A verdict with no unmet items at all is not a verification-only rejection: when unsure, the verdict stands.
  const bare = rig("code"); await bare.body();
  const bareResult = await bare.tasks.review("codex-review", bare.task.id, "changes_requested", "needs a closer look");
  expect(bareResult.rejections).toBe(1); expect(bareResult.history.some(entry => entry.event === "changes_requested")).toBe(true);
  const full = rig("full"); await full.body();
  expect((await full.tasks.review("codex-review", full.task.id, "changes_requested", "no tests", VERIFICATION_ONLY)).rejections).toBe(1);
  const unset = rig(undefined); await unset.body();
  expect((await unset.tasks.review("codex-review", unset.task.id, "changes_requested", "no tests", VERIFICATION_ONLY)).rejections).toBe(1);
});

test("AC3: a person's verdict is never classified, whatever the reviewer scope", async () => {
  const f = rig("code"); await f.body();
  expect((await f.tasks.review("user", f.task.id, "changes_requested", "cannot see CI", VERIFICATION_ONLY)).rejections).toBe(1);
});

test("the classifier refuses only clearly verification-only items, and keeps every real code finding seen on #467, #510 and #512", () => {
  const rejected = [
    ...VERIFICATION_ONLY,
    "Reviewer affected tests remain unverified: all five files were blocked before test bodies by read-only sandbox EPERM in test/hub-home.ts.",
    "AC5: Supply successful scripts/check.sh --changed output for committed head c08e9a3837320199fdeb465b588a461ed658d311 (check: OK); the public task view contains no check result and the review brief reports exact-head full CI not green.",
    "Verification: provide successful affected-test execution at this exact head; reviewer test bodies could not run because read-only sandbox blocked preload temp creation.",
    "Verification: exact-head green gate evidence remains unavailable in the review brief; the required scripts/check.sh --changed success is unverified.",
    "AC5: Affected tests remain independently unverified: bun test test/jcode-peer.test.ts failed in preload with EPERM creating its isolated temporary home, before any test ran; rerun on the reviewed head in a writable authorized test environment.",
  ];
  for (const item of rejected) expect(verificationOnlyItem(item), item).toBe(true);
  const kept = [
    "Install-input cache identity: unchanged package.json/bun.lock can reuse stale generated node_modules.",
    "Pruning does not preserve volumes whose key label is absent or inconsistent with its name.",
    "Update docs/dogfood.md as required by AGENTS.md for a user-facing feature.",
    "Correct docs/operations.md restart guidance: declarations are captured once at daemon startup.",
    "The tests do not cover the lifecycle script refusal.",
    "Plan conformance: dependencyManifest(packageJson) became async dependencyManifest(source).",
    "src/hub/tasks.ts review() does not handle a withheld note.",
    "Foreign-key pruning protection is missing.",
    "Document/reconcile the signature change in the design spec.",
    "A race between the check and the volume removal.",
    "",
  ];
  for (const item of kept) expect(verificationOnlyItem(item), item).toBe(false);
  expect(classifyVerificationOnly([], [])).toBe(false);
  expect(classifyVerificationOnly(rejected, [])).toBe(true);
  expect(classifyVerificationOnly([rejected[0]!, kept[0]!], [])).toBe(false);
  expect(classifyVerificationOnly(rejected, [{ id: "f1", pass: "bugs", severity: "important", disposition: "open" }])).toBe(false);
  expect(classifyVerificationOnly(rejected, [{ id: "f1", pass: "bugs", severity: "important", disposition: "fixed" }])).toBe(true);
});
