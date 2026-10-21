import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board, type Task } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig, type SdlcMode } from "../src/hub/sdlc.ts";

const A = "a".repeat(40), B = "b".repeat(40), cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const finding = (id = "missing-origin-check", extra: Record<string, unknown> = {}) => ({ id, pass: "security" as const, severity: "important" as const, disposition: "open" as const, path: "src/server.ts", ...extra });
function rig(mode: SdlcMode = "off", options: Partial<TasksDeps> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-structured-review-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const notices: string[] = [], shared: string[] = [], policy = { mode, maxNits: 5, head: A };
  const routing = loadRouting(cwd);
  const deps: TasksDeps = { cwd, project: "fixture", board, bus, routing: () => routing,
    notify: text => notices.push(text), share: (_by, text) => shared.push(text),
    sdlc: { config: () => ({ ...sdlcConfig({ mode: policy.mode, required_checks: ["gate"] }), maxNits: policy.maxNits }),
      gh: async args => ({ code: 0, stdout: JSON.stringify(args[0] === "pr"
        ? { headRefOid: policy.head, state: "OPEN", reviewDecision: "APPROVED", reviewRequests: [], statusCheckRollup: [{ name: "gate", conclusion: "SUCCESS" }], files: [], unresolvedThreads: 0 }
        : { data: { repository: { pullRequest: { headRefOid: policy.head, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) }) }, ...options };
  const tasks = new Tasks(deps);
  cleanups.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const create = (pii = false) => {
    const row = board.propose("user", { title: "review fixture", class: "implement", ...(pii ? { signals: ["pii"] } : {}) });
    board.update(row.id, "user", "accepted", { state: "in_progress", owner: "codex", reviewer: "claude" });
    return board.update(row.id, "codex", "done", { state: "in_review", refs: { commit: policy.head }, sdlc: { stage: "review", repo: "o/r", issue: 1, pr: 2, localHead: policy.head, localResult: "passed" } });
  };
  const reopen = (id: number) => {
    board.update(id, "codex", "accepted", { state: "in_progress" });
    return board.update(id, "codex", "done", { state: "in_review", refs: { commit: policy.head }, sdlc: { ...board.get(id)!.sdlc!, localHead: policy.head } });
  };
  return { cwd, board, bus, tasks, deps, policy, routing, notices, shared, create, reopen };
}
const submit = (tasks: Tasks, id: number, findings: unknown, verdict = "changes_requested", by = "claude", head: string | undefined = A): Promise<Task> =>
  Reflect.apply(tasks.review, tasks, [by, id, verdict, undefined, undefined, head, undefined, findings]);

test("S3 enforce refuses open Important approval before any board effect", async () => {
  const r = rig("enforce"), row = r.create(), before = r.board.get(row.id)!;
  await expect(submit(r.tasks, row.id, [finding()], "approved", "user")).rejects.toThrow(/important/i);
  expect(r.board.get(row.id)).toEqual(before);
});

test("S3 same-head omission cannot erase open Important, while a fixed disposition permits approval", async () => {
  const r = rig(), row = r.create();
  await submit(r.tasks, row.id, [finding()]);
  r.reopen(row.id); r.policy.mode = "enforce";
  await expect(submit(r.tasks, row.id, undefined, "approved", "user")).rejects.toThrow(/important/i);
  expect(r.board.get(row.id)?.state).toBe("in_review");
  const next = await submit(r.tasks, row.id, [finding(undefined, { disposition: "fixed" })], "approved", "user");
  expect(next.state).toBe("approved");
  expect(next.history.at(-1)?.reviewFindings?.items[0]?.disposition).toBe("fixed");
});

test("S3 findings persist on the reviewed head and do not falsely attach to a new head", async () => {
  const r = rig(), row = r.create();
  const rejected = await submit(r.tasks, row.id, [finding()]);
  expect(rejected.history.findLast(entry => entry.event === "changes_requested")?.reviewFindings).toEqual({ head: A, items: [finding()] });
  r.policy.head = B; r.policy.mode = "enforce"; r.reopen(row.id);
  expect((await submit(r.tasks, row.id, undefined, "approved", "user", B)).state).toBe("approved");
  expect((await r.tasks.lifecycleStatus(row.id)).findings?.openImportant ?? 0).toBe(0);
});

test("S3 accepted is person-only and always needs a rationale", async () => {
  for (const [by, extra] of [["claude", { rationale: "person chose the risk" }], ["user", {}]] as const) {
    const r = rig(), row = r.create();
    await expect(submit(r.tasks, row.id, [finding(undefined, { disposition: "accepted", ...extra })], "changes_requested", by)).rejects.toThrow(/person|rationale/i);
    expect(r.board.get(row.id)?.state).toBe("in_review");
  }
  const r = rig(), row = r.create();
  const approved = await submit(r.tasks, row.id, [finding(undefined, { disposition: "accepted", rationale: "bounded documented exception" })], "approved", "user");
  expect(approved.history.at(-1)?.reviewFindings?.items[0]?.rationale).toBe("bounded documented exception");
});

test("S3 nit caps and malformed findings refuse even with lifecycle off", async () => {
  const r = rig(), row = r.create(); r.policy.maxNits = 0;
  await expect(submit(r.tasks, row.id, [finding("naming", { severity: "nit" })])).rejects.toThrow(/nit/i);
  await expect(submit(r.tasks, row.id, [finding(), finding()])).rejects.toThrow(/duplicate/i);
  expect(r.board.get(row.id)?.state).toBe("in_review");
});

test("S3 PII findings are stored privately and never enter publicView or recurrence proposals", async () => {
  const r = rig();
  for (let i = 0; i < 2; i++) {
    const row = r.create(true), next = await submit(r.tasks, row.id, [finding("PRIVATE_FINDING_CANARY", { path: "private/patient.txt" })], "changes_requested", "user");
    expect(next.history.findLast(entry => entry.event === "changes_requested")?.reviewFindings?.items[0]?.id).toBe("PRIVATE_FINDING_CANARY");
    expect(JSON.stringify(r.tasks.publicView(next, true))).not.toMatch(/PRIVATE_FINDING_CANARY|patient\.txt|reviewFindings/);
  }
  expect(r.board.list("backlog")).toHaveLength(0);
  expect(r.shared.join("\n")).not.toContain("PRIVATE_FINDING_CANARY");
});

test("S3 structured-only reviews keep an uncleared screen verdict withheld after restart", async () => {
  const r = rig("off", { piiScreen: async () => ({ label: "unknown", miss: "failed", ms: 0 }) });
  r.routing.signals.pii_screen = "local";
  const row = r.create(), next = await submit(r.tasks, row.id, [finding("WITHHELD_FINDING_CANARY", { rationale: "uncleared finding metadata" })]);
  expect(next.history.findLast(entry => entry.event === "changes_requested")?.withheld).toBe(true);
  expect(next.history.findLast(entry => entry.event === "changes_requested")?.reviewFindings?.items[0]?.id).toBe("WITHHELD_FINDING_CANARY");
  const restarted = new Tasks(r.deps);
  expect(JSON.stringify(restarted.publicView(r.board.get(row.id)!, true))).not.toContain("WITHHELD_FINDING_CANARY");
  expect(r.board.list("backlog")).toHaveLength(0);
});

test("S3 a second task with the same finding proposes one durable backlog amendment, never for same-task repeats", async () => {
  const r = rig(), one = r.create();
  await submit(r.tasks, one.id, [finding()]); r.reopen(one.id);
  await submit(r.tasks, one.id, [finding()]);
  expect(r.board.list("backlog")).toHaveLength(0);
  const two = r.create(); await submit(r.tasks, two.id, [finding()]);
  const cards = r.board.list("backlog"); expect(cards).toHaveLength(1);
  expect(cards[0]?.class).toBe("plan"); expect(cards[0]?.owner).toBeNull();
  expect(`${cards[0]?.title}\n${cards[0]?.detail}`).toMatch(/AGENTS\.md|agent-notes/);
  const restarted = new Tasks(r.deps), three = r.create(); await submit(restarted, three.id, [finding()]);
  expect(r.board.list("backlog").map(card => card.id)).toEqual(cards.map(card => card.id));
});

test("S3 an asynchronous screen cannot commit findings after ownership or privacy changed", async () => {
  let enter!: () => void, release!: () => void;
  let started = false;
  const entered = new Promise<void>(r => { enter = r; }), gate = new Promise<void>(r => { release = r; });
  const r = rig("off", { piiScreen: async () => { started = true; enter(); await gate; return { label: "clear", ms: 0 }; } });
  r.routing.signals.pii_screen = "local";
  const row = r.create(), reviewing = submit(r.tasks, row.id, [finding()], "approved").then(value => ({ value }), error => ({ error }));
  await Promise.race([entered, Bun.sleep(1000)]);
  expect(started).toBe(true);
  r.board.update(row.id, "user", "owner changed", { owner: "kimi", signals: ["pii"] }); release();
  expect((await reviewing)).toHaveProperty("error");
  expect(r.board.get(row.id)?.state).toBe("in_review");
  expect(r.board.get(row.id)?.history.some(entry => !!entry.reviewFindings)).toBe(false);
});

test("S3 public findings with private path hints are withheld and never proposed", async () => {
  const r = rig("off", { piiPaths: ["private/"] });
  for (let i = 0; i < 2; i++) {
    const row = r.create();
    await submit(r.tasks, row.id, [finding("private-path-finding", { path: "private/record.txt" })]);
    const view = JSON.stringify(r.tasks.publicView(r.board.get(row.id)!, true));
    expect(view).not.toContain("private/record.txt");
    expect(view).not.toContain("private-path-finding");
    expect(view).toContain('"openImportant":1');
  }
  expect(r.board.list("backlog")).toHaveLength(0);
});

test("S3 private-turn reviewers cannot publish structured metadata on ordinary tasks", async () => {
  const r = rig("off", { privateTurn: peer => peer === "claude" }), row = r.create();
  await expect(submit(r.tasks, row.id, [finding()])).rejects.toThrow(/private turn/);
  expect(r.board.get(row.id)?.state).toBe("in_review");
  expect(r.board.get(row.id)?.history.some(entry => entry.reviewFindings)).toBe(false);
});

test("S3 tool schema advertises optional bounded findings without changing legacy required args", async () => {
  const { TASK_TOOLS } = await import("../src/hub/hub-tools.ts");
  const schema = TASK_TOOLS.find(tool => tool.name === "hub_review")!.inputSchema;
  expect(schema.required).toEqual(["id", "verdict"]);
  expect(schema.properties.findings).toMatchObject({ type: "array", maxItems: 64,
    items: { required: ["id", "pass", "severity", "disposition"], additionalProperties: false,
      properties: { rationale: { maxLength: 2048 }, disposition: { enum: ["open", "fixed", "false_positive", "accepted"] } } } });
});
