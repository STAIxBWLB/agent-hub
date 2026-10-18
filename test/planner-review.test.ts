import { expect, test } from "bun:test";
import * as lifecycle from "../src/hub/sdlc.ts";
import type { SdlcGh } from "../src/hub/sdlc.ts";

test("planner issue metadata reads no body and ignores comment-only updatedAt changes (#481 S9)", async () => {
  const calls: string[][] = [];
  let updatedAt = "2026-10-18T02:00:00Z";
  const gh: SdlcGh = async args => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify({ data: { repository: { issue: {
      number: 481, state: "OPEN", createdAt: "2026-10-18T00:00:00Z",
      lastEditedAt: "2026-10-18T01:00:00Z", updatedAt,
    } } } }) };
  };
  const read = (lifecycle as unknown as { readPlanIssueMetadata: (repo: string, issue: number, gh: SdlcGh) => Promise<unknown> }).readPlanIssueMetadata;
  const first = await read("STAIxBWLB/agent-hub", 481, gh);
  updatedAt = "2026-10-18T03:00:00Z";
  expect(await read("STAIxBWLB/agent-hub", 481, gh)).toEqual(first);
  expect(first).toEqual({ repo: "STAIxBWLB/agent-hub", issue: 481, state: "OPEN", editedAt: "2026-10-18T01:00:00Z", lastEditedAt: "2026-10-18T01:00:00Z" });
  expect(calls).toHaveLength(2);
  expect(calls[0]?.join(" ")).toContain("lastEditedAt");
  expect(calls[0]?.join(" ")).not.toMatch(/body|comments/);
});

test("planner issue metadata fails closed on malformed or mismatched identities (#481 S9)", async () => {
  const read = (lifecycle as unknown as { readPlanIssueMetadata: (repo: string, issue: number, gh: SdlcGh) => Promise<unknown> }).readPlanIssueMetadata;
  let calls = 0;
  const gh: SdlcGh = async () => { calls++; return { code: 0, stdout: JSON.stringify({ data: { repository: { issue: {
    number: 482, state: "OPEN", createdAt: "2026-10-18T00:00:00Z", lastEditedAt: null,
  } } } }) }; };
  expect(await read("STAIxBWLB/agent-hub", 481, gh)).toBeUndefined();
  expect(await read("--unsafe", 481, gh)).toBeUndefined();
  expect(calls).toBe(1);
});

import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
const close: (() => void)[] = [];
afterEach(() => { for (const fn of close.splice(0)) fn(); });
function reviewRig(gh: SdlcGh, mode: "off" | "advise" | "enforce" = "advise") {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-plan-review-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const roles = { claude: ["planner"], codex: ["implementer"] };
  const notices: string[] = [];
  const deps: TasksDeps = { cwd, board, bus, roles, project: "fixture", routing: () => loadRouting(cwd), notify: text => { notices.push(text); }, sdlc: { config: () => lifecycle.sdlcConfig({ mode }), gh } };
  const tasks = new Tasks(deps);
  const task = board.propose("user", { title: "ordinary implementation", class: "implement", backlog: true });
  board.update(task.id, "user", "lifecycle", { sdlc: { stage: "build", repo: "STAIxBWLB/agent-hub", issue: 481 } });
  close.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  return { board, tasks, task, roles, bus, notices, deps };
}
const metadata = () => ({ code: 0, stdout: JSON.stringify({ data: { repository: { issue: { number: 481, state: "OPEN", createdAt: "2026-10-18T00:00:00Z", lastEditedAt: "2026-10-18T01:00:00Z" } } } }) });

test("plan review is planner-owned and stores only host-read revision and issue edit evidence (#481 S9)", async () => {
  let reads = 0;
  const { board, tasks, task } = reviewRig(async () => { reads++; return metadata(); });
  await expect(tasks.recordPlanReview("codex", task.id, { revision: 0, reason: "reviewed" })).rejects.toThrow("planner");
  expect(reads).toBe(0);
  const saved = await tasks.recordPlanReview("claude", task.id, { revision: 0, reason: "reviewed dependencies and scope" });
  expect(saved.sdlc?.planReview).toMatchObject({ planner: "claude", planningRevision: 0, issue: { repo: "STAIxBWLB/agent-hub", issue: 481, editedAt: "2026-10-18T01:00:00Z" } });
  expect(saved.history.at(-1)?.event).toBe("plan reviewed");
  expect(board.get(task.id)?.state).toBe("backlog");
  await expect(tasks.recordPlanReview("claude", task.id, { revision: 0, reason: "forged", editedAt: "2026-10-18T01:00:00Z" })).rejects.toThrow("revision");
});

test("plan review refuses a planning change during remote readback without writing a receipt (#481 S9)", async () => {
  const r = reviewRig(async () => {
    r.board.plan(r.task.id, "user", { priority: 1 }, 0, "person changed priority");
    return metadata();
  });
  await expect(r.tasks.recordPlanReview("claude", r.task.id, { revision: 0, reason: "reviewed" })).rejects.toThrow("changed");
  expect(r.board.get(r.task.id)?.sdlc?.planReview).toBeUndefined();
  expect(r.board.get(r.task.id)?.history.some(entry => entry.event === "plan reviewed")).toBe(false);
});

test("plan-review freshness tracks planning revision and body edits, and treats unavailable evidence as unknown (#481 S9)", async () => {
  let editedAt = "2026-10-18T01:00:00Z", unavailable = false;
  const r = reviewRig(async () => unavailable ? { code: 1, stdout: "" } : { code: 0, stdout: JSON.stringify({ data: { repository: { issue: { number: 481, state: "OPEN", createdAt: "2026-10-18T00:00:00Z", lastEditedAt: editedAt } } } }) });
  await r.tasks.recordPlanReview("claude", r.task.id, { revision: 0, reason: "reviewed" });
  expect(await r.tasks.planReviewGap(r.board.get(r.task.id)!)).toBeUndefined();
  editedAt = "2026-10-18T02:00:00Z";
  expect(await r.tasks.planReviewGap(r.board.get(r.task.id)!)).toContain("issue edit");
  unavailable = true;
  expect(await r.tasks.planReviewGap(r.board.get(r.task.id)!)).toContain("unavailable");
  r.board.plan(r.task.id, "user", { priority: 1 }, 0, "change scope" );
  expect(await r.tasks.planReviewGap(r.board.get(r.task.id)!)).toContain("planning revision");
});

test("enforce acceptance reads a current plan receipt and fences direct and stale admission (#481 S9)", async () => {
  let editedAt = "2026-10-18T01:00:00Z";
  const r = reviewRig(async () => ({ code: 0, stdout: JSON.stringify({ data: { repository: { issue: { number: 481, state: "OPEN", createdAt: "2026-10-18T00:00:00Z", lastEditedAt: editedAt, updatedAt: editedAt } } } }) }), "enforce");
  r.board.update(r.task.id, "user", "backlog pulled", { state: "proposed", owner: "codex" });
  r.tasks.acceptSpec("user", r.task.id, { issue: 481, edit: { lastEditedAt: editedAt, updatedAt: editedAt } });
  const before = JSON.stringify(r.board.get(r.task.id));
  await expect(r.tasks.acceptReviewed("codex", r.task.id)).rejects.toThrow("plan not reviewed");
  expect(JSON.stringify(r.board.get(r.task.id))).toBe(before);
  await r.tasks.recordPlanReview("claude", r.task.id, { revision: 0, reason: "reviewed before build" });
  expect(() => r.tasks.accept("codex", r.task.id)).toThrow("readback");
  editedAt = "2026-10-18T02:00:00Z";
  r.tasks.acceptSpec("user", r.task.id, { issue: 481, edit: { lastEditedAt: editedAt, updatedAt: editedAt } });
  await expect(r.tasks.acceptReviewed("codex", r.task.id)).rejects.toThrow("issue edit");
  await r.tasks.recordPlanReview("claude", r.task.id, { revision: 0, reason: "reviewed edited issue" });
  expect((await r.tasks.acceptReviewed("codex", r.task.id)).state).toBe("in_progress");
});

import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";
test("enforce does not offer build work before a current planner review (#481 S9)", async () => {
  const r = reviewRig(async () => metadata(), "enforce");
  class Peer extends BasePeer { async start() { this.setState("idle"); } async stop() {} async deliver(_envs: Envelope[]) {} }
  const peer = new Peer("codex");
  const bus = r.bus;
  bus.add(peer); await peer.start();
  const task = await r.tasks.propose("user", { title: "new build scope", class: "implement", owner: "codex" });
  expect(task.owner).toBeNull();
  expect(bus.queued("codex")).toBe(0);
  expect(task.history.some(entry => entry.event === "assigned")).toBe(false);
});

test("done cannot implicitly accept build work without a planner review (#481 S9)", async () => {
  const r = reviewRig(async () => {
    const reading = JSON.parse(metadata().stdout);
    reading.data.repository.issue.updatedAt = "2026-10-18T01:00:00Z";
    return { code: 0, stdout: JSON.stringify(reading) };
  }, "enforce");
  r.board.update(r.task.id, "user", "backlog pulled", { state: "proposed", owner: "codex" });
  r.tasks.acceptSpec("user", r.task.id, { issue: 481, edit: { lastEditedAt: "2026-10-18T01:00:00Z", updatedAt: "2026-10-18T01:00:00Z" } });
  const before = r.board.get(r.task.id);
  await expect(r.tasks.done("codex", r.task.id, "finished")).rejects.toThrow("plan not reviewed");
  expect(r.board.get(r.task.id)).toEqual(before);
});

test("done cannot bypass the WIP limit through implicit acceptance (#481 S9)", async () => {
  const r = reviewRig(async () => metadata(), "off");
  r.board.update(r.task.id, "user", "backlog pulled", { state: "proposed", owner: "codex", reviewer: "user" });
  const running = r.board.propose("user", { title: "already running", class: "summarize" });
  r.board.update(running.id, "codex", "accepted", { state: "in_progress", owner: "codex", reviewer: "user" });
  const before = r.board.get(r.task.id);
  await expect(r.tasks.done("codex", r.task.id, "finished")).rejects.toThrow("planner WIP capacity");
  expect(r.board.get(r.task.id)).toEqual(before);
});

test("combined acceptance rechecks spec evidence instead of trusting an earlier separate gate (#481 S9)", async () => {
  let editedAt = "2026-10-18T01:00:00Z";
  const r = reviewRig(async () => ({ code: 0, stdout: JSON.stringify({ data: { repository: { issue: {
    number: 481, state: "OPEN", createdAt: "2026-10-18T00:00:00Z", lastEditedAt: editedAt, updatedAt: editedAt,
  } } } }) }), "enforce");
  r.board.update(r.task.id, "user", "backlog pulled", { state: "proposed", owner: "codex" });
  r.tasks.acceptSpec("user", r.task.id, { issue: 481, edit: { lastEditedAt: editedAt, updatedAt: editedAt } });
  await r.tasks.recordPlanReview("claude", r.task.id, { revision: 0, reason: "initial review" });
  await r.tasks.specGate("codex", r.task.id);
  editedAt = "2026-10-18T02:00:00Z";
  await r.tasks.recordPlanReview("claude", r.task.id, { revision: 0, reason: "reviewed updated plan" });
  const before = r.board.get(r.task.id);
  await expect(r.tasks.acceptReviewed("codex", r.task.id)).rejects.toThrow("spec changed after acceptance");
  expect(r.board.get(r.task.id)).toEqual(before);
});

test("enabled planner notices point to grooming once per board revision without changing the board (#481 S9)", async () => {
  const r = reviewRig(async () => metadata(), "advise");
  class Planner extends BasePeer { async start() { this.setState("busy"); } async stop() {} async deliver(_envs: Envelope[]) {} }
  const planner = new Planner("claude"); r.bus.add(planner); await planner.start();
  const before = JSON.stringify(r.board.list());
  r.tasks.flushPlannerNotices(); r.tasks.flushPlannerNotices();
  expect(r.bus.pendingEnvelopes("claude").filter(env => env.body.includes("hub_planner_groom"))).toHaveLength(1);
  expect(JSON.stringify(r.board.list())).toBe(before);
});

test("grooming withholds private task evidence and does not fetch its issue (#481 S9)", async () => {
  let reads = 0;
  const r = reviewRig(async () => { reads++; return metadata(); });
  r.board.update(r.task.id, "user", "screened", { signals: ["pii"] });
  const before = JSON.stringify(r.board.list());
  const digest = await r.tasks.groomingDigest("claude");
  expect(JSON.stringify(digest)).not.toContain("481");
  expect(digest.privateTasks).toBe("withheld");
  expect(reads).toBe(0);
  expect(JSON.stringify(r.board.list())).toBe(before);
});

import { mkdirSync, writeFileSync } from "node:fs";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
test("real daemon exposes planner review and grooming with role checks and durable return reasons (#481 S9)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-plan-surface-")), stateDir = join(cwd, ".agenthub/state");
  mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub/sdlc.toml"), 'mode = "enforce"\n');
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      roles: { claude: ["planner"], codex: ["implementer"] }, batch_ms: 0 } });
  const clients: ControlClient[] = [];
  try {
    const connect = async (role: "console" | "tools", peer?: string) => { const c = await ControlClient.connect(stateDir, { role, ...(peer ? { peer } : {}) }); clients.push(c); return c; };
    const person = await connect("console"), planner = await connect("tools", "claude"), other = await connect("tools", "codex");
    const request = (client: ControlClient, op: string, args: unknown = {}) => client.request({ t: "task", op, args });
    expect(await request(person, "hub_task_propose", { title: "future scope", class: "implement", backlog: true })).toMatchObject({ ok: true });
    const backlog = await request(planner, "hub_backlog_list"), id = JSON.parse(backlog.text)[0].id;
    expect(await request(other, "hub_planner_groom")).toMatchObject({ ok: false });
    const groom = await request(planner, "hub_planner_groom"); expect(groom.ok).toBe(true); expect(JSON.parse(groom.text).items).toBeArray();
    expect(await request(planner, "hub_plan_review", { id, revision: 0, reason: "checked dependencies and scope" })).toMatchObject({ ok: true });
    expect(await request(planner, "hub_plan_review", { id, revision: 0, reason: "caller timestamp", editedAt: "2026-10-18T01:00:00Z" })).toMatchObject({ ok: false });
    expect(await request(person, "backlog_pull", { id })).toMatchObject({ ok: true });
    const returned = await request(planner, "hub_backlog_return_untouched", { id, revision: 0, reason: "wait for the active work" });
    expect(returned.ok).toBe(true);
    const row = JSON.parse(returned.text);
    expect(row.state).toBe("backlog");
    expect(row.sdlc.planReview.planner).toBe("claude");
    expect(row.history.at(-1).note).toBe("wait for the active work");
  } finally {
    for (const client of clients) client.close();
    await daemon.stop(); rmSync(cwd, { recursive: true, force: true });
  }
});

import { classifyPeerCommand, liveTestRefusal } from "../src/cli/identity.ts";
test("planner review CLI cannot be delegated as person-attributed content (#481 S9)", () => {
  expect(classifyPeerCommand("sdlc", ["plan-review", "1", "0", "reviewed"])).toBe("console");
  expect(liveTestRefusal("sdlc", ["plan-review", "1", "0", "reviewed"])).toBe(true);
  expect(liveTestRefusal("backlog", ["return-untouched", "1", "0", "queue"])).toBe(true);
});

test("planner authority revoked during issue metadata read cannot save a review (#481 S9)", async () => {
  const r = reviewRig(async () => { r.roles.claude = []; return metadata(); });
  const before = JSON.stringify(r.board.get(r.task.id));
  await expect(r.tasks.recordPlanReview("claude", r.task.id, { revision: 0, reason: "reviewed" })).rejects.toThrow("planner");
  expect(JSON.stringify(r.board.get(r.task.id))).toBe(before);
});

test("advice reports missing plan review while off leaves acceptance ungated (#481 S9)", async () => {
  for (const mode of ["off", "advise"] as const) {
    const r = reviewRig(async () => metadata(), mode);
    r.board.update(r.task.id, "user", "backlog pulled", { state: "proposed", owner: "codex" });
    expect((await r.tasks.acceptReviewed("codex", r.task.id)).state).toBe("in_progress");
    expect(r.notices.some(text => text.includes("plan not reviewed"))).toBe(mode === "advise");
  }
});

test("a private turn cannot persist ordinary planner-authored review or return content (#481 S9)", async () => {
  const r = reviewRig(async () => metadata());
  r.deps.privateTurn = () => true;
  const before = JSON.stringify(r.board.get(r.task.id));
  await expect(r.tasks.recordPlanReview("claude", r.task.id, { revision: 0, reason: "private turn words" })).rejects.toThrow("private turn");
  await expect(r.tasks.returnUntouchedToBacklog("claude", { id: r.task.id, revision: 0, reason: "private turn words" })).rejects.toThrow("private turn");
  expect(JSON.stringify(r.board.get(r.task.id))).toBe(before);
});

test("simultaneous advise self-claims consume only one WIP slot and refuse before the losing proposal write (#481 S9)", async () => {
  const r = reviewRig(async () => metadata(), "advise");
  class Peer extends BasePeer { async start() { this.setState("idle"); } async stop() {} async deliver(_envs: Envelope[]) {} }
  const peer = new Peer("codex"); r.bus.add(peer); await peer.start();
  const results = await Promise.allSettled([r.tasks.propose("codex", { title: "first claim", class: "implement", owner: "codex" }), r.tasks.propose("codex", { title: "second claim", class: "implement", owner: "codex" })]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  expect(r.board.list().filter(task => task.state === "in_progress")).toHaveLength(1);
  expect(r.board.list()).toHaveLength(2);
});

test("private issue identities never reach planner GitHub readbacks (#481 S9)", async () => {
  let reads = 0;
  const r = reviewRig(async () => { reads++; return metadata(); });
  await r.tasks.recordPlanReview("claude", r.task.id, { revision: 0, reason: "public review" });
  r.board.update(r.task.id, "user", "screened", { signals: ["pii"] }); reads = 0;
  expect(await r.tasks.planReviewGap(r.board.get(r.task.id)!)).toContain("private");
  await expect(r.tasks.recordPlanReview("user", r.task.id, { revision: 0, reason: "private review" })).rejects.toThrow("private");
  expect(reads).toBe(0);
});

test("grooming reports host approval and quota blockers as closed codes without copying reasons (#481 S9)", async () => {
  const r = reviewRig(async () => metadata());
  r.deps.plannerBlocks = () => ({ codex: ["approvals", "quota"] });
  r.board.update(r.task.id, "user", "backlog pulled", { state: "proposed", owner: "codex" });
  const digest = await r.tasks.groomingDigest("claude");
  const items = digest.items as { task: number; code?: string }[];
  expect(items.some(item => item.task === r.task.id && item.code === "approvals")).toBe(true);
  expect(items.some(item => item.task === r.task.id && item.code === "quota")).toBe(true);
  expect(JSON.stringify(digest)).not.toContain("ordinary implementation");
});

test("grooming uses real cancellation supersession and independent spec acceptance evidence (#481 S9)", async () => {
  const r = reviewRig(async () => metadata());
  const replacement = r.board.propose("user", { title: "replacement", class: "implement", backlog: true, refs: { repo: "STAIxBWLB/agent-hub" } });
  await r.tasks.cancel(r.task.id, "user", { reason: "replaced", supersededBy: `#${replacement.id}` });
  const afterCancel = JSON.stringify(r.board.list());
  const cancelled = await r.tasks.groomingDigest("claude") as { items: { kind: string; task: number; related?: number[] }[] };
  expect(cancelled.items).toContainEqual({ kind: "superseded", task: r.task.id, related: [replacement.id] });
  expect(JSON.stringify(r.board.list())).toBe(afterCancel);

  const spec = reviewRig(async () => metadata());
  spec.tasks.acceptSpec("user", spec.task.id, { issue: 481, edit: { lastEditedAt: "2026-10-17T01:00:00Z", updatedAt: "2026-10-17T01:00:00Z" } });
  expect((await spec.tasks.groomingDigest("claude") as { items: unknown[] }).items).toContainEqual({ kind: "stale", task: spec.task.id });
  await spec.tasks.recordPlanReview("claude", spec.task.id, { revision: 0, reason: "reviewed new plan" });
  expect((await spec.tasks.groomingDigest("claude") as { items: unknown[] }).items).toContainEqual({ kind: "stale", task: spec.task.id });
});

test("grooming previews reserved backlog blockers without pulling or dispatching (#481 S9)", async () => {
  const r = reviewRig(async () => metadata());
  r.board.plan(r.task.id, "user", { reserved: "codex" }, 0, "future work");
  r.deps.capabilities = () => ({ codex: { spec: true, tests: false, testsReason: "fixture unavailable" } });
  const before = JSON.stringify(r.board.list());
  const digest = await r.tasks.groomingDigest("claude") as { items: unknown[] };
  expect(digest.items).toContainEqual({ kind: "blocked", task: r.task.id, code: "tests" });
  expect(JSON.stringify(r.board.list())).toBe(before);
  expect(r.bus.queued("codex")).toBe(0);
});

test("planner write authority is rechecked after screening and metadata awaits (#481 S9)", async () => {
  let privateTurn = false, reads = 0;
  const screened = reviewRig(async () => { reads++; return metadata(); });
  screened.deps.privateTurn = () => privateTurn;
  const before = screened.board.get(screened.task.id);
  const pending = screened.tasks.recordPlanReview("claude", screened.task.id, { revision: 0, reason: "reviewed" });
  privateTurn = true;
  await expect(pending).rejects.toThrow("private turn");
  expect(reads).toBe(0);
  expect(screened.board.get(screened.task.id)).toEqual(before);

  privateTurn = false;
  const remote = reviewRig(async () => { privateTurn = true; return metadata(); });
  remote.deps.privateTurn = () => privateTurn;
  const remoteBefore = remote.board.get(remote.task.id);
  await expect(remote.tasks.recordPlanReview("claude", remote.task.id, { revision: 0, reason: "reviewed" })).rejects.toThrow("private turn");
  expect(remote.board.get(remote.task.id)).toEqual(remoteBefore);

  privateTurn = false;
  const returned = reviewRig(async () => metadata(), "off");
  returned.deps.privateTurn = () => privateTurn;
  returned.board.update(returned.task.id, "user", "backlog pulled", { state: "proposed", owner: "codex" });
  returned.board.update(returned.task.id, "codex", "accepted", { state: "in_progress" });
  const returnBefore = returned.board.get(returned.task.id);
  const returning = returned.tasks.returnUntouchedToBacklog("claude", { id: returned.task.id, revision: 0, reason: "queue it" });
  privateTurn = true;
  await expect(returning).rejects.toThrow("private turn");
  expect(returned.board.get(returned.task.id)).toEqual(returnBefore);
});

test("grooming rechecks each task's privacy before the next external read (#481 S9)", async () => {
  const reads: number[] = [];
  let second = 0;
  const r = reviewRig(async args => {
    reads.push(Number(args.at(-1)!.split("=")[1]));
    if (second) r.board.update(second, "user", "privacy changed", { signals: ["pii"] });
    return metadata();
  });
  const next = r.board.propose("user", { title: "later private", class: "implement", backlog: true });
  second = next.id;
  r.board.update(next.id, "user", "lifecycle", { sdlc: { stage: "intent", repo: "STAIxBWLB/agent-hub", issue: 482 } });
  const digest = await r.tasks.groomingDigest("claude");
  expect(reads).toEqual([481]);
  expect(digest.privateTasks).toBe("withheld");
});
