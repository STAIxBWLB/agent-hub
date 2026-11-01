import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { approvalBinding } from "../src/hub/task-approval.ts";
import { renderTaskShow } from "../src/cli/task-output.ts";

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function rig(options: Partial<TasksDeps> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-approval-refile-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  let prState = "OPEN", unreadable = false;
  const tasks = new Tasks({ board, bus, cwd, project: "fixture", routing: () => loadRouting(cwd), notify: () => {},
    sdlc: { config: () => sdlcConfig({ mode: "off" }), gh: async () => ({ code: unreadable ? 1 : 0, stdout: JSON.stringify({ state: prState }) }) }, ...options });
  cleanup.push(() => { tasks.stopCiWatchers(); bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const create = async (linked = false) => {
    const task = board.propose("user", { title: "approved re-review", class: "implement" });
    board.update(task.id, "user", "accepted", { owner: "codex", reviewer: "claude", state: "in_progress" });
    board.update(task.id, "codex", "done", { state: "in_review", refs: { commit: A }, ...(linked ? { sdlc: { stage: "review", repo: "fixture/project", pr: 7 } } : {}) });
    return tasks.review("claude", task.id, "approved", "reviewed first head");
  };
  return { board, bus, tasks, create, merged: () => { prState = "MERGED"; }, unknown: () => { unreadable = true; } };
}

test("#1047 approved owner re-submit preserves verdict head and supersedes each earlier review request", async () => {
  const r = rig(), task = await r.create(true);
  const verdict = task.history.findLast(entry => entry.event === "approved")!;
  expect(verdict.reviewedHead).toBe(A); // no explicit head and lifecycle off still bind the verdict
  const first = await r.tasks.done("codex", task.id, "new head", { commit: B });
  expect(first).toMatchObject({ state: "in_review", refs: { commit: B }, rejections: 0 });
  expect(first.history.findLast(entry => entry.event === "approved")).toEqual(verdict);
  expect(approvalBinding(first)).toEqual({ head: A, latestHead: B, mismatch: true, current: false });
  const reviewRevision = first.history.findLastIndex(entry => entry.event === "done");
  const next = await r.tasks.done("codex", task.id, "newer head", { commit: C });
  expect(next.refs.commit).toBe(C);
  expect(r.tasks.reviewBindingCurrent("claude", task.id, { head: B, flowRevision: reviewRevision })).toBe(false);
  await expect(r.tasks.review("claude", task.id, "approved", "stale verdict", undefined, B)).rejects.toThrow(/head/);
  const approved = await r.tasks.review("claude", task.id, "approved", "reviewed latest");
  expect(approvalBinding(approved)).toEqual({ head: C, latestHead: C, mismatch: false, current: true });
  expect(approved.history.filter(entry => entry.event === "approved").map(entry => entry.reviewedHead)).toEqual([A, C]);
});

test("#1047 reviewer withdrawal carries Important findings through a new head", async () => {
  const r = rig(), task = await r.create(true);
  const finding = { id: "important", pass: "bugs", severity: "important", disposition: "open" } as const;
  const withdrawn = await r.tasks.review("claude", task.id, "changes_requested", "withdraw", undefined, A, undefined, [finding]);
  expect(withdrawn.state).toBe("changes_requested");
  expect(approvalBinding(withdrawn)?.current).toBe(false);
  expect(withdrawn.history.findLast(entry => entry.event === "approved")?.reviewedHead).toBe(A);
  const refiled = await r.tasks.done("codex", task.id, "address finding", { commit: B });
  expect(refiled.state).toBe("in_review");
  expect(r.tasks.publicView(refiled).findings).toMatchObject({ openImportant: 1 });
  expect(refiled.history.findLast(entry => entry.event === "changes_requested")?.reviewFindings?.items).toEqual([finding]);
});

test("#1047 approved re-file refuses same/missing/malformed head, wrong owner and wrong reviewer without effects", async () => {
  const r = rig(), task = await r.create();
  for (const [by, refs] of [["codex", undefined], ["codex", { commit: A }], ["codex", { commit: "short" }], ["codex", { commit: B.toUpperCase() }], ["kimi", { commit: B }]] as const) {
    const before = r.board.get(task.id);
    await expect(r.tasks.done(by, task.id, "refused", refs)).rejects.toThrow();
    expect(r.board.get(task.id)).toEqual(before);
  }
  const before = r.board.get(task.id);
  await expect(r.tasks.review("kimi", task.id, "changes_requested")).rejects.toThrow();
  await expect(r.tasks.review("claude", task.id, "approved")).rejects.toThrow();
  expect(r.board.get(task.id)).toEqual(before);
});

for (const kind of ["remote merged", "recorded merged", "unreadable", "cancelled"] as const) {
  test(`#1047 ${kind} refuses both reopening paths before board writes`, async () => {
    const r = rig(), task = await r.create(true);
    if (kind === "remote merged") r.merged();
    if (kind === "unreadable") r.unknown();
    if (kind === "recorded merged") r.board.update(task.id, "hub", "merge recorded", { sdlc: { ...task.sdlc!, merge: { repo: "fixture/project", pr: 7, head: A, at: 1, state: "merged", exit: 0, cleanup: "not_started", ownerNotice: "not_started" } } });
    if (kind === "cancelled") {
      // Cancellation remains terminal even when an older approval exists in history.
      await r.tasks.review("claude", task.id, "changes_requested");
      await r.tasks.cancel(task.id, "user", { reason: "cancel fixture" });
    }
    const before = r.board.get(task.id);
    await expect(r.tasks.done("codex", task.id, "new head", { commit: B })).rejects.toThrow(/merged|unavailable|cancelled/);
    await expect(r.tasks.review("claude", task.id, "changes_requested")).rejects.toThrow(/merged|unavailable|cancelled/);
    expect(r.board.get(task.id)).toEqual(before);
  });
}

test("#1047 public show and review brief name the approval head and flag stale approval without a brief provider", async () => {
  const r = rig(), task = await r.create();
  expect(r.tasks.publicView(task).approval).toEqual({ head: A, latestHead: A, mismatch: false, current: true });
  const next = await r.tasks.done("codex", task.id, "replacement", { commit: B });
  const view = r.tasks.publicView(next, true);
  expect(view.approval).toEqual({ head: A, latestHead: B, mismatch: true, current: false });
  expect(view.history).toContainEqual(expect.objectContaining({ event: "approved", reviewedHead: A }));
  const brief = r.tasks.briefText(next);
  for (const text of [A, B, "HEAD MISMATCH"]) expect(brief).toContain(text);
  for (const width of [80, 200]) {
    const show = renderTaskShow(view, width).map(line => line.map(span => span.text).join("")).join("\n");
    for (const text of [A, B, "HEAD MISMATCH"]) expect(show).toContain(text);
  }
});

test("#1047 approved re-file checks the new head before review and refuses another completion while checking", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const r = rig({ check: () => "fixture", runCheck: async () => { await gate; return { code: 0, timedOut: false, tail: "ok" }; } });
  const task = await r.create();
  try {
    const next = await r.tasks.done("codex", task.id, "new head", { commit: B });
    expect(next).toMatchObject({ state: "in_progress", refs: { commit: B } });
    await expect(r.tasks.done("codex", task.id, "overlap", { commit: C })).rejects.toThrow(/still running/);
    expect(r.board.get(task.id)?.refs.commit).toBe(B);
  } finally { release(); }
  for (let i = 0; i < 200 && r.tasks.checksPending(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(r.tasks.checksPending()).toBe(0);
  expect(r.board.get(task.id)?.state).toBe("in_review");
});

for (const pending of ["owner", "reviewer"] as const) {
  test(`#1047 a delayed ${pending} reopen cannot overwrite a newer transition`, async () => {
    let entered!: () => void, release!: () => void, reads = 0;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const r = rig({ sdlc: { config: () => sdlcConfig({ mode: "off" }), gh: async () => {
      if (++reads === 1) { entered(); await gate; }
      return { code: 0, stdout: JSON.stringify({ state: "OPEN" }) };
    } } });
    const task = await r.create(true);
    const result = (pending === "owner" ? r.tasks.done("codex", task.id, "delayed", { commit: B })
      : r.tasks.review("claude", task.id, "changes_requested", "delayed withdrawal")).then(() => "unexpected success", error => String(error));
    let winner;
    try {
      await started;
      winner = pending === "owner" ? await r.tasks.review("claude", task.id, "changes_requested", "withdraw now")
        : await r.tasks.done("codex", task.id, "new head now", { commit: C });
    } finally { release(); }
    expect(await result).toMatch(/changed|cannot move/);
    expect(r.board.get(task.id)).toEqual(winner!);
  });
}

test("#1047 reopening preserves the head of a legacy approval stored only on its receipt", async () => {
  const r = rig();
  const task = r.board.propose("user", { title: "legacy receipt", class: "implement" });
  r.board.update(task.id, "user", "accepted", { state: "in_progress", owner: "codex", reviewer: "claude" });
  r.board.update(task.id, "codex", "done", { state: "in_review", refs: { commit: A } });
  r.board.update(task.id, "claude", "approved", { state: "approved", sdlc: { stage: "merge", reviewedHead: A } });
  const next = await r.tasks.done("codex", task.id, "new head", { commit: B });
  expect(next.sdlc?.reviewedHead).toBeUndefined();
  expect(next.history.findLast(entry => entry.event === "approved")?.reviewedHead).toBe(A);
  expect(approvalBinding(next)).toEqual({ head: A, latestHead: B, current: false, mismatch: true });
});

test("#1047 a checked re-file of reviewerless approved work requires a fresh person review", async () => {
  const r = rig({ check: () => "fixture", runCheck: async () => ({ code: 0, timedOut: false, tail: "ok" }) });
  const task = r.board.propose("user", { title: "reviewerless approval", class: "implement" });
  r.board.update(task.id, "user", "accepted", { state: "in_progress", owner: "codex" });
  r.board.update(task.id, "codex", "done", { state: "approved", refs: { commit: A } });
  const pending = await r.tasks.done("codex", task.id, "new head", { commit: B });
  expect(pending).toMatchObject({ state: "in_progress", reviewer: "user" });
  for (let i = 0; i < 200 && r.tasks.checksPending(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(r.tasks.checksPending()).toBe(0);
  expect(r.board.get(task.id)).toMatchObject({ state: "in_review", reviewer: "user", refs: { commit: B } });
});

test("#1047 withdrawal followed by a new delivery drops old receipt heads before review", async () => {
  const r = rig(), task = await r.create();
  r.board.update(task.id, "hub", "legacy receipt", { sdlc: { stage: "merge", head: A, reviewedHead: A, localHead: A, localResult: "passed" } });
  await r.tasks.review("claude", task.id, "changes_requested", "withdraw", undefined, A);
  const next = await r.tasks.done("codex", task.id, "new head", { commit: B });
  for (const key of ["head", "reviewedHead", "localHead", "localResult"] as const) expect(next.sdlc?.[key]).toBeUndefined();
  const approved = await r.tasks.review("claude", task.id, "approved", "review new head", undefined, B);
  expect(approved.history.findLast(entry => entry.event === "approved")?.reviewedHead).toBe(B);
});

for (const actor of ["owner", "reviewer"] as const) {
  test(`#1047 a PR merged during the ${actor} screen refuses the final reopening write`, async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const routing = loadRouting(tmpdir()); routing.signals.pii_screen = "local"; routing.constraints.pii = "local_only";
    const r = rig({ routing: () => routing, piiScreen: async text => {
      if (text === "held screen") { entered(); await gate; }
      return { label: "clear", ms: 0 };
    } });
    const task = await r.create(true), before = r.board.get(task.id);
    const outcome = (actor === "owner" ? r.tasks.done("codex", task.id, "held screen", { commit: B })
      : r.tasks.review("claude", task.id, "changes_requested", "held screen")).then(() => "unexpected success", error => String(error));
    try { await started; r.merged(); } finally { release(); }
    expect(await outcome).toContain("merged");
    expect(r.board.get(task.id)).toEqual(before);
  });
}
