import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { phaseReceipt, validatePhaseLinks, phaseView, workflowHash } from "../src/hub/workflow.ts";
import { sdlcConfig, sdlcReceipt, type SdlcGh, type SdlcMode } from "../src/hub/sdlc.ts";
const A = "a".repeat(40), B = "b".repeat(40), H = "c".repeat(64);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });
const phase = (result = "unverified", required = true) => ({ id: "phase-one", head: A, tasks: [], criteria: [{ id: "criterion-one", required, result, refs: result === "verified" ? ["sha256:" + H] : [] }] });
function rig(mode: SdlcMode = "enforce", privateTask = false, workflow: "none" | "gsd-lite" = "gsd-lite") {
  const dir = mkdtempSync(join(tmpdir(), "ahub-workflow-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  cleanups.push(() => { board.close(); rmSync(dir, { force: true, recursive: true }); });
  let head = A;
  const gh: SdlcGh = async args => ({ code: 0, stdout: JSON.stringify(args[0] === "pr" ? { headRefOid: head, state: "OPEN", reviewDecision: "APPROVED", reviewRequests: [], statusCheckRollup: [{ name: "gate", conclusion: "SUCCESS" }], files: [] } : { data: { repository: { pullRequest: { headRefOid: head, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) });
  const config = sdlcConfig({ mode, workflow, required_checks: ["gate"] });
  const tasks = new Tasks({ board, bus, cwd: dir, project: "fixture", routing: () => loadRouting(dir), notify: text => notices.push(text), sdlc: { config: () => config, gh } });
  const parent = board.propose(USER, { title: privateTask ? "private marker 900101-1234567" : "parent", class: "implement", ...(privateTask ? { signals: ["pii"] } : {}) });
  board.update(parent.id, USER, "accepted", { state: "in_progress", owner: "codex", reviewer: USER });
  tasks.recordLifecycle(USER, parent.id, { repo: "owner/repo", issue: 1, pr: 2, localHead: A, localResult: "passed", reviewedHead: A });
  return { board, tasks, parent: parent.id, config, notices, head: (v: string) => { head = v; } };
}

test("gsd-lite defaults none, validates bounded identities/hashed refs and invalidates another PR's phase (#257)", () => {
  expect(sdlcConfig(undefined).workflow).toBeUndefined(); expect(sdlcConfig({ workflow: "none" })).toEqual(sdlcConfig(undefined));
  expect(() => sdlcConfig({ workflow: "full-gsd" })).toThrow();
  for (const p of [{ ...phase(), extra: true }, { ...phase(), id: "forged\nheader" }, phase("green"), { ...phase("verified"), criteria: [{ ...phase().criteria[0], result: "verified", refs: [] }] }, { ...phase(), tasks: [{ id: 2, after: [2] }] }, { ...phase(), criteria: Array(33).fill(phase().criteria[0]) }, { ...phase(), criteria: [{ ...phase().criteria[0], refs: ["unhashed free text"] }] }]) expect(() => phaseReceipt(p)).toThrow();
  const old = sdlcReceipt({ repo: "owner/repo", pr: 2, phase: phase() }); expect(sdlcReceipt({ pr: 3 }, old).phase).toBeUndefined();
});

test("phase imports require exact current after edges and preserve accepted owners and reservations (#257)", () => {
  const r = rig(), first = r.board.propose(USER, { title: "first", class: "implement" });
  r.board.update(first.id, USER, "accepted", { owner: "pi", state: "in_progress" });
  const second = r.board.propose(USER, { title: "second", class: "implement", deps: [first.id], reserved: "kimi" });
  const before = JSON.stringify([r.board.get(first.id), r.board.get(second.id)]);
  const p = { ...phase(), tasks: [{ id: first.id, after: [] }, { id: second.id, after: [first.id] }] };
  r.tasks.recordLifecycle(USER, r.parent, { phase: p }); expect(JSON.stringify([r.board.get(first.id), r.board.get(second.id)])).toBe(before);
  expect(() => r.tasks.recordLifecycle(USER, r.parent, { phase: { ...p, tasks: [{ id: second.id, after: [] }] } })).toThrow("Tasks.after");
  expect(() => r.tasks.recordLifecycle(USER, r.parent, { phase: { ...p, tasks: [{ id: r.parent, after: [] }] } })).toThrow("parent");
  const privateChild = r.board.propose(USER, { title: "PII", class: "implement", signals: ["pii"] });
  expect(() => r.tasks.recordLifecycle(USER, r.parent, { phase: { ...phase(), tasks: [{ id: privateChild.id, after: [] }] } })).toThrow("private");
  expect(() => validatePhaseLinks(r.board.get(r.parent)!, phaseReceipt(p), id => { const t = r.board.get(id); return id === first.id && t ? { ...t, deps: [second.id] } : t; }, () => false)).toThrow("cycle");
});

test("only the phase reviewer/person records checklists; required unknown verdicts block approval in enforce (#257)", async () => {
  const r = rig();
  expect(() => r.tasks.recordLifecycle("codex", r.parent, { phase: phase("verified") })).toThrow("only its reviewer");
  r.tasks.recordLifecycle(USER, r.parent, { phase: phase() });
  await r.tasks.done("codex", r.parent, "done");
  await expect(r.tasks.review(USER, r.parent, "approved", undefined, undefined, A)).rejects.toThrow("phase criterion criterion-one: unverified");
  r.tasks.recordLifecycle(USER, r.parent, { phase: phase("verified") });
  expect((await r.tasks.review(USER, r.parent, "approved", undefined, undefined, A)).state).toBe("approved");
  r.head(B); expect((await r.tasks.lifecycleStatus(r.parent)).blockers).toContain("phase checklist head missing or stale");
});

test("gsd-lite advise preserves transitions, none preserves traces, and exports are current sanitized board hashes (#257)", async () => {
  const r = rig("advise"); r.tasks.recordLifecycle(USER, r.parent, { phase: phase() });
  await r.tasks.done("codex", r.parent, "done"); expect((await r.tasks.review(USER, r.parent, "approved")).state).toBe("approved");
  expect((await r.tasks.lifecycleStatus(r.parent)).ready).toBe(false); expect(r.notices.join(" ")).toContain("unverified");
  expect(r.tasks.explain(r.parent).join(" ")).toContain("workflow: gsd-lite");
  const plain = rig("off", false, "none"); expect(plain.tasks.explain(plain.parent).join(" ")).not.toContain("workflow:");
  const exported = r.tasks.workflowExport(r.parent); expect(exported.stateHash).toBe(workflowHash(exported.state)); expect(exported.sourceHash).toBe(workflowHash(r.config));
  expect(JSON.stringify(exported)).not.toContain('"title"');
  const secret = rig("advise", true); secret.tasks.recordLifecycle(USER, secret.parent, { phase: phase("verified") });
  expect(JSON.stringify(secret.tasks.publicView(secret.board.get(secret.parent)!))).not.toContain("criterion-one");
  expect(JSON.stringify(secret.tasks.workflowExport(secret.parent))).not.toContain("private marker");
  expect(JSON.stringify(secret.tasks.workflowExport(secret.parent))).not.toContain(H);
});

test("phase readiness follows unfinished children and current dependencies, never stored plan authority (#257)", () => {
  const r = rig(), child = r.board.propose(USER, { title: "child", class: "implement" });
  const p = { ...phase("verified"), tasks: [{ id: child.id, after: [] }] }; r.tasks.recordLifecycle(USER, r.parent, { phase: p });
  let changed = false;
  const view = () => phaseView(r.config, r.board.get(r.parent)!, id => { const t = r.board.get(id); return changed && id === child.id && t ? { ...t, deps: [999] } : t; }, t => r.tasks.isPii(t))!;
  expect(view().blockers).toContain("phase child tasks not approved");
  r.board.update(child.id, USER, "accepted fixture", { state: "in_progress" });
  r.board.update(child.id, USER, "approved fixture", { state: "approved" }); expect(view().ready).toBe(true);
  changed = true; expect(view().ready).toBe(false); expect(view().blockers).toContain("phase dependency evidence changed or unavailable");
});
