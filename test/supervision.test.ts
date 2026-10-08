import { expect, test } from "bun:test";
import type { Task } from "../src/hub/board.ts";
import { SupervisionFeed, type SupervisionNotice, type SupervisionScope } from "../src/hub/supervision.ts";

const task = (id: number, by = "claude", state: Task["state"] = "in_progress"): Task => ({
  id, title: `work ${id}`, detail: "PRIVATE DETAIL", class: "implement", owner: "kimi", reviewer: "codex", state,
  refs: {}, signals: [], rejections: 0, history: [{ at: 1, by, event: "proposed" }], created: 1, updated: 1,
});
function fixture(initial = [task(1)]) {
  let conductor: string | undefined = "claude";
  let scope: SupervisionScope = "own";
  let admit = true;
  let now = 120_000;
  const tasks = initial;
  const notices: SupervisionNotice[] = [];
  const feed = new SupervisionFeed({ conductor: () => conductor, scope: () => scope, tasks: () => tasks,
    isPrivate: (t) => t.signals.includes("pii"), publicTitle: (t) => `#${t.id} ${t.title}`,
    now: () => now, emit: (n) => { if (!admit) return false; notices.push(n); return true; } });
  return { feed, tasks, notices, role: (p: string | undefined) => { conductor = p; }, scope: (s: SupervisionScope) => { scope = s; }, admit: (a: boolean) => { admit = a; }, now: (n: number) => { now = n; } };
}

test("supervision scope is persisted actor ownership, all, off, and current conductor role", () => {
  const owned = task(1);
  const assigned = task(2, "user");
  assigned.history.push({ at: 2, by: "claude", event: "reassigned", owner: "kimi", note: "PRIVATE NOTE" });
  const other = task(3, "user");
  const f = fixture([owned, assigned, other]);
  expect(f.feed.includes(owned)).toBe(true);
  expect(f.feed.includes(assigned)).toBe(true);
  expect(f.feed.includes(other)).toBe(false);
  expect(f.feed.milestone(3, "accepted")).toBe(false);
  f.scope("all");
  expect(f.feed.milestone(3, "accepted")).toBe(true);
  expect(f.notices[0]?.peer).toBe("claude");
  f.scope("off");
  expect(f.feed.milestone(1, "accepted")).toBe(false);
  f.scope("own");
  f.role(undefined);
  expect(f.feed.milestone(1, "accepted")).toBe(false);
});

test("milestones have stable queued replacement keys and no independent batch timer", () => {
  const f = fixture();
  f.feed.milestone(1, "moved", { owner: "kimi", reason: "manual" });
  f.feed.milestone(1, "moved", { owner: "pi", reason: "idle" });
  f.feed.milestone(1, "accepted", { by: "pi" });
  expect(f.notices).toHaveLength(3);
  expect(f.notices[0]?.key).toBe(f.notices[1]?.key);
  expect(f.notices[2]?.key).not.toBe(f.notices[1]?.key);
  expect(f.notices.every((n) => n.priority === "status" && n.kind === "task")).toBe(true);
  expect(f.notices[1]?.body).toContain("reason idle");
});

test("private milestone contains only an id, event and public show stub", () => {
  const t = task(1);
  t.title = "PRIVATE TITLE";
  t.signals.push("pii");
  const f = fixture([t]);
  f.feed.milestone(1, "done", { owner: "kimi", check: "failed", reason: "drift" });
  expect(f.notices[0]?.body).toBe("#1 [pii]: done; ahub task show 1");
  expect(JSON.stringify(f.notices)).not.toContain("PRIVATE");
});

test("history mapping does not copy notes or check output", () => {
  const t = task(1);
  const f = fixture([t]);
  f.feed.taskChanged(t, { at: 3, by: "hub", event: "check failed", note: "PRIVATE CHECK OUTPUT" });
  expect(f.notices[0]?.body).toContain("check failed");
  f.feed.taskChanged(t, { at: 4, by: "codex", event: "changes_requested", note: "PRIVATE REVIEW NOTE" });
  expect(f.notices[1]?.body).toContain("verdict changes_requested");
  f.feed.taskChanged(t, { at: 5, by: "hub", event: "idle sweep", sweep: { kind: "idle-owner", activity: 1, step: 2, at: 5 } });
  expect(f.notices[2]?.body).toContain("finding idle-owner");
  expect(JSON.stringify(f.notices)).not.toContain("PRIVATE");
});

test("only aged approvals and needs_review interrupt, with no title or request body", () => {
  const f = fixture();
  const approval = { id: "a1", peer: "kimi", tool: "shell", createdAt: 100_000, title: "PRIVATE TITLE", body: "PRIVATE BODY" };
  expect(f.feed.approvalWaiting(approval)).toBe(false);
  f.now(160_000);
  f.admit(false);
  expect(f.feed.approvalWaiting(approval)).toBe(false);
  f.admit(true);
  expect(f.feed.approvalWaiting(approval)).toBe(true);
  expect(f.feed.approvalWaiting(approval)).toBe(false);
  expect(f.feed.needsReview("kimi", "delivery-1")).toBe(true);
  expect(f.feed.needsReview("kimi", "delivery-1")).toBe(false);
  expect(f.notices.every((n) => n.priority === "important")).toBe(true);
  expect(f.notices[0]?.body).toContain("ahub console");
  expect(f.notices[1]?.body).toContain("ahub queue resolve");
  expect(JSON.stringify(f.notices)).not.toContain("PRIVATE");
});

test("round summary is once per completed set; rejected admission retries and a new task rearms", () => {
  const f = fixture([task(1, "claude", "approved")]);
  f.admit(false);
  expect(f.feed.checkRound()).toBe(false);
  f.admit(true);
  expect(f.feed.checkRound()).toBe(true);
  expect(f.feed.checkRound()).toBe(false);
  f.tasks.push(task(2));
  expect(f.feed.checkRound()).toBe(false);
  f.tasks[1]!.state = "approved";
  expect(f.feed.checkRound()).toBe(true);
  expect(f.feed.checkRound()).toBe(false);
  expect(f.notices).toHaveLength(2);
  expect(f.notices[1]?.body).toContain("1 task approved");
  f.tasks[0]!.state = "in_progress";
  expect(f.feed.checkRound()).toBe(false);
  f.tasks[0]!.state = "approved";
  expect(f.feed.checkRound()).toBe(false);
});

test("offline and budget notices select scoped active owners or reviewers and preserve unknown reset", () => {
  const f = fixture();
  expect(f.feed.peerOffline("local")).toBe(false);
  expect(f.feed.peerOffline("codex")).toBe(true);
  expect(f.feed.budgetPaused("kimi")).toBe(true);
  expect(f.notices[1]?.body).toContain("reset unknown");
  expect(f.notices[1]?.priority).toBe("status");
  expect(f.notices[1]?.kind).toBe("budget");
  f.tasks[0]!.state = "approved";
  expect(f.feed.peerOffline("kimi")).toBe(false);
});

test("daemon-owned durable round signature suppresses a completed set across controller restart", () => {
  const rounds = new Map<string, string>();
  const tasks = [task(1, "claude", "approved")];
  const notices: SupervisionNotice[] = [];
  const create = () => new SupervisionFeed({ conductor: () => "claude", scope: () => "own", tasks: () => tasks,
    publicTitle: (t) => `#${t.id} ${t.title}`, isPrivate: () => false, emit: (n) => { notices.push(n); },
    readRound: (peer) => rounds.get(peer), writeRound: (peer, signature) => { rounds.set(peer, signature); } });
  expect(create().checkRound()).toBe(true);
  expect(create().checkRound()).toBe(false);
  tasks.push(task(2, "claude", "approved"));
  expect(create().checkRound()).toBe(true);
  expect(notices).toHaveLength(2);
});

test("role/off regrant replays withdrawn live approval and hold notices without clearing completed round", () => {
  const f = fixture([task(1, "claude", "approved")]);
  const request = { id: "live", peer: "kimi", tool: "shell", createdAt: 0 };
  expect(f.feed.approvalWaiting(request)).toBe(true);
  expect(f.feed.needsReview("kimi", "delivery")).toBe(true);
  expect(f.feed.checkRound()).toBe(true);
  f.feed.resetPending("codex");
  expect(f.feed.approvalWaiting(request)).toBe(false);
  f.scope("off");
  f.feed.resetPending("claude");
  expect(f.feed.approvalWaiting(request)).toBe(false);
  f.scope("own");
  expect(f.feed.approvalWaiting(request)).toBe(true);
  expect(f.feed.needsReview("kimi", "delivery")).toBe(true);
  expect(f.feed.checkRound()).toBe(false);
});
