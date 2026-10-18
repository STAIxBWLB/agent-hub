import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realPath } from "../src/hub/project.ts";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { parsePrEvidence, readSdlcPr, sdlcGh, sdlcConfig, sdlcReceipt, sdlcStatus, touchingPrs, type SdlcGh, type SdlcMode } from "../src/hub/sdlc.ts";

const A = "a".repeat(40), B = "b".repeat(40), cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const config = (mode: SdlcMode) => sdlcConfig({ mode, required_checks: ["gate"] });
const raw = (head = A, conclusion = "SUCCESS") => ({ headRefOid: head, state: "OPEN", reviewDecision: "APPROVED", reviewRequests: [], statusCheckRollup: [{ name: "gate", conclusion }], files: [{ path: "src/file.ts" }], unresolvedThreads: 0 });

test("SDLC defaults off and rejects unknown keys, stages, duplicate checks and unsafe artifact identities (#257)", () => {
  expect(sdlcConfig(undefined).mode).toBe("off");
  for (const value of [{ mode: "auto" }, { unknown: true }, { stages: ["release", "spec"] }, { required_checks: ["x", "x"] }, { required_checks: ["x\nspoof"] }]) expect(() => sdlcConfig(value)).toThrow();
  for (const value of [{ repo: "--repo=x" }, { pr: "1" }, { issue: 0 }, { head: A }, { reviewedHead: "abc" }, { localResult: "green" }]) expect(() => sdlcReceipt(value)).toThrow();
  const receipt = sdlcReceipt({ repo: "owner/repo", pr: 1, issue: 2, reviewedHead: A, localHead: A, localResult: "passed" });
  expect(sdlcReceipt({ pr: 3 }, receipt).reviewedHead).toBeUndefined();
  expect(sdlcReceipt({ pr: 3 }, receipt).localHead).toBeUndefined();
});

test("only exact-head successful required checks and a complete clean review are ready (#257)", () => {
  const receipt = sdlcReceipt({ repo: "owner/repo", pr: 1, issue: 2, reviewedHead: A, localHead: A, localResult: "passed" });
  expect(sdlcStatus(config("enforce"), receipt, parsePrEvidence(raw())).ready).toBe(true);
  for (const conclusion of ["NEUTRAL", "SKIPPED", "FAILURE", "TIMED_OUT", "CANCELLED", ""]) expect(sdlcStatus(config("enforce"), receipt, parsePrEvidence(raw(A, conclusion))).ready).toBe(false);
  expect(sdlcStatus(config("enforce"), receipt, parsePrEvidence(raw(B))).blockers).toContain("current head has not been reviewed");
  expect(sdlcStatus(config("enforce"), receipt).ready).toBe(false);
  expect(sdlcStatus(sdlcConfig({ mode: "enforce" }), receipt, parsePrEvidence(raw())).blockers).toContain("required check set unknown");
  for (const unresolvedThreads of [null, 1]) expect(sdlcStatus(config("enforce"), receipt, parsePrEvidence({ ...raw(), unresolvedThreads })).ready).toBe(false);
});

test("fake gh readback never fetches remote bodies; head races and incomplete review pages stay unknown (#257)", async () => {
  const calls: string[][] = [], receipt = sdlcReceipt({ repo: "owner/repo", pr: 1 });
  let threadHead = A, more = false;
  const gh: SdlcGh = async args => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify(args[0] === "pr" ? raw() : { data: { repository: { pullRequest: { headRefOid: threadHead, reviewThreads: { nodes: [{ isResolved: true }], pageInfo: { hasNextPage: more } } } } } }) };
  };
  expect((await readSdlcPr(receipt, gh))?.unresolved).toBe(0);
  expect(calls[0]).toContain("--repo"); expect(calls[0]?.join(" ")).not.toContain("body"); expect(calls[1]?.join(" ")).not.toContain("comments");
  more = true; expect((await readSdlcPr(receipt, gh))?.unresolved).toBeNull();
  threadHead = B; expect(await readSdlcPr(receipt, gh)).toBeUndefined();
  expect(await readSdlcPr(receipt, async () => ({ code: 1, stdout: "credential marker" }))).toBeUndefined();
});

function rig(mode: SdlcMode, pii = false, delayMs = 0) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-sdlc-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  cleanups.push(() => { board.close(); rmSync(dir, { recursive: true, force: true }); });
  let head = A, conclusion = "SUCCESS", calls = 0;
  const gh: SdlcGh = async args => { calls++; if (delayMs) await Bun.sleep(delayMs); return { code: 0, stdout: JSON.stringify(args[0] === "pr" ? raw(head, conclusion) : { data: { repository: { pullRequest: { headRefOid: head, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) }; };
  const tasks = new Tasks({ board, bus, cwd: dir, project: "test", routing: () => loadRouting(dir), notify: message => notices.push(message), sdlc: { config: () => config(mode), gh } });
  const proposed = board.propose(USER, { title: pii ? "patient 900101-1234567 marker" : "work", class: "implement", ...(pii ? { signals: ["pii"] } : {}) });
  board.update(proposed.id, USER, "accepted", { owner: "codex", reviewer: USER, state: "in_progress" });
  tasks.recordLifecycle(USER, proposed.id, { repo: "owner/repo", issue: 2, pr: 1, localHead: A, localResult: "passed", stage: "implement" });
  return { dir, board, tasks, id: proposed.id, notices, calls: () => calls, head: (value: string) => { head = value; }, check: (value: string) => { conclusion = value; } };
}

test("enforce refuses stale review and failed CI before approval, then persists the exact reviewed head (#257)", async () => {
  const r = rig("enforce");
  await r.tasks.done("codex", r.id, "done and checked");
  r.check("FAILURE");
  await expect(r.tasks.review(USER, r.id, "approved", undefined, undefined, A)).rejects.toThrow("required check");
  expect(r.board.get(r.id)?.state).toBe("in_review");
  r.check("SUCCESS"); r.head(B);
  await expect(r.tasks.review(USER, r.id, "approved", undefined, undefined, A)).rejects.toThrow("current head");
  r.tasks.recordLifecycle("codex", r.id, { localHead: B, localResult: "passed" });
  const approved = await r.tasks.review(USER, r.id, "approved", undefined, undefined, B);
  expect(approved.state).toBe("approved"); expect(approved.sdlc?.reviewedHead).toBe(B);
  r.head(A); expect((await r.tasks.lifecycleStatus(r.id)).ready).toBe(false);
});

test("off makes no gh calls and advise never blocks a failed external gate (#257)", async () => {
  for (const mode of ["off", "advise"] as const) {
    const r = rig(mode); r.check("FAILURE");
    await r.tasks.done("codex", r.id, "done");
    expect((await r.tasks.review(USER, r.id, "approved")).state).toBe("approved");
    if (mode === "off") expect(r.calls()).toBe(0);
    else expect(r.notices.join(" ")).toContain("SDLC approval advice");
  }
});

test("lifecycle evidence cannot be recorded by an unrelated peer or leaked from a PII task (#257)", async () => {
  const r = rig("enforce", true);
  expect(() => r.tasks.recordLifecycle("other", r.id, { pr: 3 })).toThrow("owner, reviewer or console");
  expect(() => r.tasks.recordLifecycle("codex", r.id, { reviewedHead: A })).toThrow("only its reviewer");
  expect((await r.tasks.lifecycleStatus(r.id)).ready).toBe(false); expect(r.calls()).toBe(0);
  const view = r.tasks.publicView(r.board.get(r.id)!);
  // #481 S0: recorded as implement, stored under its playbook id.
  expect(view.sdlc).toEqual({ stage: "build" }); expect(JSON.stringify(view)).not.toContain("owner/repo"); expect(JSON.stringify(view)).not.toContain("900101");
});

test("merge conflict projection uses exact paths and does not choose a landing action (#257)", () => {
  expect(touchingPrs([{ pr: 1, paths: ["src/a.ts"] }, { pr: 2, paths: ["src/a.ts", "src/b.ts"] }, { pr: 3, paths: ["src/a.tsx"] }])).toEqual([{ before: 1, after: 2, paths: ["src/a.ts"] }]);
});


test("pending or unavailable GitHub review requests never satisfy the review gate (#257)", async () => {
  const receipt = sdlcReceipt({ repo: "owner/repo", pr: 1, issue: 2, reviewedHead: A, localHead: A, localResult: "passed" });
  for (const reviewRequests of [undefined, null, [{ login: "reviewer" }]]) {
    expect(sdlcStatus(config("enforce"), receipt, parsePrEvidence({ ...raw(), reviewRequests })).blockers).toContain("review requests pending or unknown");
  }
});

test("advise: overlapping dones record one done after a single readback and one advice notice (#382)", async () => {
  const single = rig("advise"); single.tasks.recordLifecycle("codex", single.id, { localHead: A, localResult: "failed" });
  const before = single.calls();
  await single.tasks.done("codex", single.id, "done");
  expect(single.calls() - before).toBe(2); // one PR readback: the view and the review threads
  expect(single.notices.filter(n => n.includes("SDLC review advice")).length).toBe(1);
  for (const reviewed of [true, false]) {
    const r = rig("advise", false, 20);
    if (!reviewed) r.board.update(r.id, USER, "reviewer cleared", { reviewer: null });
    const results = await Promise.allSettled([r.tasks.done("codex", r.id, "first"), r.tasks.done("codex", r.id, "second")]);
    expect(results.filter(x => x.status === "fulfilled").length).toBe(1);
    expect(r.board.get(r.id)!.history.filter(h => h.event === "done").length).toBe(1);
  }
});

test("the owner relinks a PR after a reviewed head was recorded; only the reviewer records a head (#382)", async () => {
  const r = rig("advise");
  await r.tasks.done("codex", r.id, "done");
  r.tasks.recordLifecycle(USER, r.id, { reviewedHead: A });
  expect(r.board.get(r.id)?.sdlc?.reviewedHead).toBe(A);
  expect(() => r.tasks.recordLifecycle("codex", r.id, { pr: 2 })).not.toThrow();
  expect(r.board.get(r.id)?.sdlc?.pr).toBe(2); expect(r.board.get(r.id)?.sdlc?.reviewedHead).toBeUndefined();
  expect(() => r.tasks.recordLifecycle("codex", r.id, { reviewedHead: B })).toThrow();
  const carried = rig("advise");
  carried.tasks.recordLifecycle(USER, carried.id, { reviewedHead: A });
  expect(() => carried.tasks.recordLifecycle("codex", carried.id, { pr: 2, reviewedHead: A })).toThrow("reviewer");
  expect(carried.board.get(carried.id)?.sdlc?.pr).toBe(1);
});


test("#449 SDLC gh refuses project PATH shims and external symlinks into the project before execution", async () => {
  const project = mkdtempSync(join(tmpdir(), "ahub-sdlc-shim-")), outside = mkdtempSync(join(tmpdir(), "ahub-sdlc-link-"));
  cleanups.push(() => { rmSync(project, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  const marker = join(project, "executed"), binary = join(project, "gh"), path = process.env.PATH;
  writeFileSync(binary, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdout.write('untrusted');`); chmodSync(binary, 0o755);
  symlinkSync(binary, join(outside, "gh"));
  try {
    for (const entry of [project, outside]) {
      process.env.PATH = `${entry}:${path ?? ""}`;
      expect(await sdlcGh(["pr", "view", "1", "--repo", "owner/repo"], 1000, project)).toEqual({ code: 1, stdout: "" });
      expect(existsSync(marker)).toBe(false);
    }
  } finally { if (path === undefined) delete process.env.PATH; else process.env.PATH = path; }
});

test("#449 SDLC gh preserves trusted host argv, cwd and stdout while ignoring stderr", async () => {
  const project = mkdtempSync(join(tmpdir(), "ahub-sdlc-project-")), host = mkdtempSync(join(tmpdir(), "ahub-sdlc-host-"));
  cleanups.push(() => { rmSync(project, { recursive: true, force: true }); rmSync(host, { recursive: true, force: true }); });
  const record = join(host, "record.json"), binary = join(host, "gh"), path = process.env.PATH;
  writeFileSync(binary, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(record)},JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()})); process.stdout.write('trusted result'); process.stderr.write('private diagnostic');`); chmodSync(binary, 0o755);
  const argv = ["pr", "view", "1", "--repo", "owner/repo", "--json", "headRefOid"];
  try {
    process.env.PATH = `${host}:${path ?? ""}`;
    expect(await sdlcGh(argv, 1000, project)).toEqual({ code: 0, stdout: "trusted result" });
    expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ argv, cwd: realPath(project) });
  } finally { if (path === undefined) delete process.env.PATH; else process.env.PATH = path; }
});

test("#449 SDLC gh missing executable remains a neutral unavailable readback", async () => {
  const project = mkdtempSync(join(tmpdir(), "ahub-sdlc-missing-")), path = process.env.PATH;
  cleanups.push(() => rmSync(project, { recursive: true, force: true }));
  try {
    process.env.PATH = project;
    expect(await sdlcGh(["pr", "view", "1"], 1000, project)).toEqual({ code: 1, stdout: "" });
  } finally { if (path === undefined) delete process.env.PATH; else process.env.PATH = path; }
});
