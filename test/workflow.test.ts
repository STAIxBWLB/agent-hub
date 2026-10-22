import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { criteriaReceipt, criteriaView, workflowHash } from "../src/hub/workflow.ts";
import { sdlcConfig, sdlcReceipt, type SdlcGh, type SdlcMode } from "../src/hub/sdlc.ts";
const A = "a".repeat(40), B = "b".repeat(40), H = "c".repeat(64);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });
// #481 S8: the head-bound acceptance-criteria checklist that replaced the gsd-lite phase.
const checklist = (result = "unverified", required = true) => ({ id: "phase-one", head: A, criteria: [{ id: "criterion-one", required, result, refs: result === "verified" ? ["sha256:" + H] : [] }] });
function rig(mode: SdlcMode = "enforce", privateTask = false, workflow: "none" | "gsd-lite" = "gsd-lite") {
  const dir = mkdtempSync(join(tmpdir(), "ahub-workflow-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  cleanups.push(() => { board.close(); rmSync(dir, { force: true, recursive: true }); });
  let head = A;
  const gh: SdlcGh = async args => {
    const issueArg = args.find(arg => arg.startsWith("issue="));
    return { code: 0, stdout: JSON.stringify(args[0] === "pr" ? { headRefOid: head, state: "OPEN", reviewDecision: "APPROVED", reviewRequests: [], statusCheckRollup: [{ name: "gate", conclusion: "SUCCESS" }], files: [], changedFiles: 0 } : { data: { repository: {
      pullRequest: { headRefOid: head, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } },
      ...(issueArg ? { issue: { number: Number(issueArg.split("=")[1]), labels: { nodes: [], pageInfo: { hasNextPage: false } } } } : {}),
    } } }) };
  };
  const config = sdlcConfig({ mode, workflow, required_checks: ["gate"] }, "0.12.35");
  const tasks = new Tasks({ board, bus, cwd: dir, project: "fixture", repository: "owner/repo", routing: () => loadRouting(dir), notify: text => notices.push(text), sdlc: { config: () => config, gh } });
  const parent = board.propose(USER, { title: privateTask ? "private marker 900101-1234567" : "parent", class: "implement", plan: { paths: ["src/hub/tasks.ts"] }, ...(privateTask ? { signals: ["pii"] } : {}) });
  board.update(parent.id, USER, "accepted", { state: "in_progress", owner: "codex", reviewer: USER });
  tasks.recordLifecycle(USER, parent.id, { repo: "owner/repo", issue: 1, pr: 2, localHead: A, localResult: "passed", reviewedHead: A });
  return { board, tasks, parent: parent.id, config, notices, head: (v: string) => { head = v; } };
}

test("criteria checklists validate bounded identities and hashed refs, and another PR's checklist is dropped (#481 S8)", () => {
  expect(sdlcConfig(undefined).workflow).toBeUndefined(); expect(sdlcConfig({ workflow: "none" }, "0.12.35")).toEqual(sdlcConfig(undefined));
  expect(() => sdlcConfig({ workflow: "full-gsd" }, "0.12.35")).toThrow();
  for (const p of [{ ...checklist(), extra: true }, { ...checklist(), id: "forged\nheader" }, checklist("green"), { ...checklist("verified"), criteria: [{ ...checklist().criteria[0], result: "verified", refs: [] }] }, { ...checklist(), criteria: Array(33).fill(checklist().criteria[0]) }, { ...checklist(), criteria: [{ ...checklist().criteria[0], refs: ["unhashed free text"] }] }, { ...checklist(), criteria: [checklist().criteria[0], checklist().criteria[0]] }]) expect(() => criteriaReceipt(p)).toThrow();
  expect(criteriaReceipt({ ...checklist(), criteria: [{ ...checklist().criteria[0], id: "AC8b" }] }).criteria[0]!.id).toBe("AC8b"); // ids name the issue's AC ids
  const old = sdlcReceipt({ repo: "owner/repo", pr: 2, criteria: checklist() }); expect(sdlcReceipt({ pr: 3 }, old).criteria).toBeUndefined();
});

test("checklist task import is retired: a task list is refused before any write, and a stored one reads with a note (#481 S8)", () => {
  const r = rig(), first = r.board.propose(USER, { title: "first", class: "implement" });
  const before = JSON.stringify(r.board.list());
  expect(() => r.tasks.recordLifecycle(USER, r.parent, { criteria: { ...checklist(), tasks: [{ id: first.id, after: [] }] } })).toThrow("task import was retired");
  // From 0.13.0 the retired `phase` name is refused outright (#481), still before any write.
  expect(() => r.tasks.recordLifecycle(USER, r.parent, { phase: { ...checklist(), tasks: [{ id: first.id, after: [] }] } })).toThrow("retired in");
  expect(JSON.stringify(r.board.list())).toBe(before);
  // A receipt stored before #481 keeps its criteria; its task list is shown as ignored and never gates readiness.
  r.board.update(r.parent, USER, "lifecycle", { sdlc: { ...r.board.get(r.parent)!.sdlc!, phase: { ...criteriaReceipt(checklist("verified")), tasks: [{ id: first.id, after: [] }] } } });
  const view = criteriaView(r.config, r.board.get(r.parent)!, () => false)!;
  expect(view.ready).toBe(true); expect(view.criteria?.[0]?.id).toBe("criterion-one"); expect(view.note).toContain("task import was retired");
});

test("only the phase reviewer/person records checklists; required unknown verdicts block approval in enforce (#257)", async () => {
  const r = rig();
  expect(() => r.tasks.recordLifecycle("codex", r.parent, { criteria: checklist("verified") })).toThrow("only its reviewer");
  expect(() => r.tasks.recordLifecycle("codex", r.parent, { phase: checklist("verified") })).toThrow("retired in"); // the retired name is refused from 0.13.0
  expect(() => r.tasks.recordLifecycle(USER, r.parent, { criteria: { ...checklist(), criteria: [{ ...checklist().criteria[0], id: "claim-900101-1234567" }] } })).toThrow("PII pattern");
  r.tasks.recordLifecycle(USER, r.parent, { criteria: checklist() });
  await r.tasks.done("codex", r.parent, "done");
  await expect(r.tasks.review(USER, r.parent, "approved", undefined, undefined, A)).rejects.toThrow("criterion criterion-one: unverified");
  expect(() => r.tasks.recordLifecycle(USER, r.parent, { phase: checklist("verified") })).toThrow("retired in"); // the window closed in 0.13.0 (#481)
  r.tasks.recordLifecycle(USER, r.parent, { criteria: checklist("verified") });
  expect(r.board.get(r.parent)!.sdlc!.criteria?.criteria[0]?.result).toBe("verified");
  expect((await r.tasks.review(USER, r.parent, "approved", undefined, undefined, A)).state).toBe("approved");
  r.head(B); expect((await r.tasks.lifecycleStatus(r.parent)).blockers).toContain("criteria checklist head missing or stale");
});

test("gsd-lite advise preserves transitions, none preserves traces, and exports are current sanitized board hashes (#257)", async () => {
  const r = rig("advise"); r.tasks.recordLifecycle(USER, r.parent, { criteria: checklist() });
  await r.tasks.done("codex", r.parent, "done"); expect((await r.tasks.review(USER, r.parent, "approved")).state).toBe("approved");
  expect((await r.tasks.lifecycleStatus(r.parent)).ready).toBe(false); expect(r.notices.join(" ")).toContain("unverified");
  expect(r.tasks.explain(r.parent).join(" ")).toContain("criteria checklist required on every task (retired gsd-lite setting");
  const off = rig("off"); off.tasks.recordLifecycle(USER, off.parent, { criteria: checklist() });
  expect((off.tasks.publicView(off.board.get(off.parent)!).lifecycle as any).criteria.blockers).toContain("criterion criterion-one: unverified");
  const plain = rig("off", false, "none"); expect(plain.tasks.explain(plain.parent).join(" ")).not.toContain("criteria checklist required");
  expect(plain.tasks.publicView(plain.board.get(plain.parent)!).lifecycle).toBeUndefined();
  const exported = r.tasks.workflowExport(r.parent); expect(exported.stateHash).toBe(workflowHash(exported.state)); expect(exported.sourceHash).toBe(workflowHash(r.config));
  expect(exported.schema).toBe(2); expect(JSON.stringify(exported)).not.toContain("gsd"); expect(JSON.stringify(exported)).not.toContain('"title"');
  const secret = rig("advise", true); secret.tasks.recordLifecycle(USER, secret.parent, { criteria: checklist("verified") });
  expect(JSON.stringify(secret.tasks.publicView(secret.board.get(secret.parent)!))).not.toContain("criterion-one");
  expect(JSON.stringify(secret.tasks.workflowExport(secret.parent))).not.toContain("private marker");
  expect(JSON.stringify(secret.tasks.workflowExport(secret.parent))).not.toContain(H);
});

test("a recorded checklist counts in an enabled lifecycle without any workflow setting (#481 S8)", async () => {
  const r = rig("enforce", false, "none");
  expect((await r.tasks.lifecycleStatus(r.parent)).criteria).toBeUndefined(); // nothing recorded, nothing required
  r.tasks.recordLifecycle(USER, r.parent, { criteria: checklist() });
  await r.tasks.done("codex", r.parent, "done");
  await expect(r.tasks.review(USER, r.parent, "approved", undefined, undefined, A)).rejects.toThrow("criterion criterion-one: unverified");
  const off = rig("off", false, "none"); off.tasks.recordLifecycle(USER, off.parent, { criteria: checklist() });
  expect(off.tasks.publicView(off.board.get(off.parent)!).lifecycle).toBeUndefined(); // off keeps its #257 output
});

test("new gsd-lite tasks expose checklist guidance before the first receipt and preserve none defaults (#257)", () => {
  const r = rig("off"), fresh = r.board.propose(USER, { title: "fresh task", class: "implement" });
  expect(fresh.sdlc).toBeUndefined();
  const projected = r.tasks.publicView(fresh).lifecycle as any;
  expect(projected).toBeDefined(); // a seeded omission must fail an assertion before any property access
  expect(projected.workflow).toBeUndefined(); expect(projected.criteria.blockers).toContain("criteria checklist missing");
  expect(projected.next).toBe("criteria checklist missing"); expect(projected.actor).toBe("reviewer/person");
  const plain = rig("off", false, "none"), old = plain.board.propose(USER, { title: "fresh task", class: "implement" });
  expect(plain.tasks.publicView(old).lifecycle).toBeUndefined();
});

test("a plain off lifecycle keeps the #257 export bytes; enabled and retired-setting lifecycles export schema 2 (#481 S8)", () => {
  const off = rig("off", false, "none"), exported = off.tasks.workflowExport(off.parent) as any;
  const state = { id: off.parent, state: "in_progress", stage: "spec", phase: null };
  expect(exported).toEqual({ schema: 1, workflow: "none", state, stateHash: workflowHash(state), sourceHash: workflowHash(off.config) });
  const enabled = rig("advise", false, "none"); expect((enabled.tasks.workflowExport(enabled.parent) as any).schema).toBe(2);
  const retired = rig("off"); expect((retired.tasks.workflowExport(retired.parent) as any).schema).toBe(2);
});

test("a checklist with a PII-pattern id is refused in every mode, including the off phase path, with nothing stored or exposed (#481 S8)", () => {
  for (const [mode, workflow, key] of [["off", "none", "phase"], ["off", "none", "criteria"], ["advise", "none", "criteria"], ["advise", "none", "phase"], ["off", "gsd-lite", "phase"]] as const) {
    const r = rig(mode, false, workflow), before = JSON.stringify(r.board.get(r.parent));
    const leaked = { ...checklist(), criteria: [{ ...checklist().criteria[0], id: "claim-900101-1234567" }] };
    // The retired `phase` name is refused from 0.13.0 (#481) before the PII screen; either way nothing is stored or exposed.
    expect(() => r.tasks.recordLifecycle(USER, r.parent, { [key]: leaked })).toThrow(key === "phase" ? "retired in" : "PII pattern");
    expect(JSON.stringify(r.board.get(r.parent))).toBe(before);
    expect(JSON.stringify(r.tasks.publicView(r.board.get(r.parent)!))).not.toContain("900101");
  }
});
