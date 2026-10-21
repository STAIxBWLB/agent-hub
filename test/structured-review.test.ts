import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
  const deps: TasksDeps = { cwd, project: "fixture", repository: "o/r", board, bus, routing: () => routing,
    notify: text => notices.push(text), share: (_by, text) => shared.push(text),
    sdlc: { config: () => ({ ...sdlcConfig({ mode: policy.mode, required_checks: ["gate"] }), maxNits: policy.maxNits }),
      gh: async args => ({ code: 0, stdout: JSON.stringify(args[0] === "pr"
        ? { headRefOid: policy.head, state: "OPEN", reviewDecision: "APPROVED", reviewRequests: [], statusCheckRollup: [{ name: "gate", conclusion: "SUCCESS" }], files: [], changedFiles: 0, unresolvedThreads: 0 }
        : { data: { repository: { pullRequest: { headRefOid: policy.head, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) }) }, ...options };
  const tasks = new Tasks(deps);
  cleanups.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const create = (pii = false) => {
    const row = board.propose("user", { title: "review fixture", class: "implement", plan: { paths: ["src/hub/tasks.ts"] }, ...(pii ? { signals: ["pii"] } : {}) });
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

test("S3 open Important findings carry to a new head until explicitly settled", async () => {
  const r = rig(), row = r.create();
  const rejected = await submit(r.tasks, row.id, [finding()]);
  expect(rejected.history.findLast(entry => entry.event === "changes_requested")?.reviewFindings).toEqual({ head: A, items: [finding()] });
  r.policy.head = B; r.policy.mode = "enforce"; r.reopen(row.id);
  await expect(submit(r.tasks, row.id, undefined, "approved", "user", B)).rejects.toThrow(/important/i);
  expect((await r.tasks.lifecycleStatus(row.id)).findings?.openImportant).toBe(1);
  expect((await submit(r.tasks, row.id, [finding(undefined, { disposition: "fixed" })], "approved", "user", B)).state).toBe("approved");
  expect((await r.tasks.lifecycleStatus(row.id)).findings?.openImportant).toBe(0);
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


test("S3 R1 invalid owner commit skips to the full local head and cannot evade enforce", async () => {
  const r = rig("enforce"), row = r.create();
  r.board.update(row.id, "user", "refs", { refs: { commit: "aaaaaaa" } });
  await r.tasks.review("claude", row.id, "changes_requested", undefined, undefined, undefined, undefined, [finding()]);
  expect(r.board.get(row.id)?.history.findLast(entry => entry.reviewFindings)?.reviewFindings?.head).toBe(A);
  r.reopen(row.id);
  await expect(submit(r.tasks, row.id, undefined, "approved", "user")).rejects.toThrow(/important/i);
});

test("S3 R1 enforce refuses a finding report with no resolvable head", async () => {
  const r = rig("enforce"), row = r.create();
  r.board.update(row.id, "user", "refs", { refs: { commit: "short" }, sdlc: { stage: "review" } });
  await expect(r.tasks.review("claude", row.id, "changes_requested", undefined, undefined, undefined, undefined, [finding()])).rejects.toThrow(/head/i);
  expect(r.board.get(row.id)?.state).toBe("in_review");
});

test("S3 R1 a new review request lists carried semantic findings without their rationale", async () => {
  const r = rig(), row = r.create();
  await submit(r.tasks, row.id, [finding("security-origin", { rationale: "not part of the carried request" })]);
  const requests: string[] = [];
  const untap = r.bus.tap(event => { if (event.t === "envelope" && event.env.kind === "review") requests.push(event.env.body); });
  try {
    r.board.update(row.id, "user", "lifecycle", { sdlc: { ...r.board.get(row.id)!.sdlc!, localHead: B } });
    await r.tasks.done("codex", row.id, "new head", { commit: B });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("security-origin");
    expect(requests[0]).toContain("src/server.ts");
    expect(requests[0]).not.toContain("not part of the carried request");
  } finally { untap(); }
});

test("S3 R1 recurrence distinguishes passes and ignores false positives", async () => {
  const r = rig();
  await submit(r.tasks, r.create().id, [finding("generic-id", { pass: "bugs" })]);
  await submit(r.tasks, r.create().id, [finding("generic-id", { pass: "security" })]);
  expect(r.board.list("backlog")).toHaveLength(0);
  await submit(r.tasks, r.create().id, [finding("generic-id", { pass: "bugs", disposition: "false_positive" })]);
  expect(r.board.list("backlog")).toHaveLength(0);
  await submit(r.tasks, r.create().id, [finding("generic-id", { pass: "bugs" })]);
  expect(r.board.list("backlog")).toHaveLength(1);
});

test("S3 R1 retitling a recurrence card cannot defeat its durable key", async () => {
  const r = rig();
  await submit(r.tasks, r.create().id, [finding()]);
  await submit(r.tasks, r.create().id, [finding()]);
  const card = r.board.list("backlog")[0]!;
  const db = new Database(join(r.cwd, "hub.db"));
  try { db.query("UPDATE tasks SET title = ? WHERE id = ?").run("Person renamed the proposal", card.id); } finally { db.close(); }
  await submit(new Tasks(r.deps), r.create().id, [finding()]);
  expect(r.board.list("backlog").map(item => item.id)).toEqual([card.id]);
});

test("S3 R1 public and lifecycle tallies share valid PR-head precedence", async () => {
  const r = rig("advise"), row = r.create();
  await submit(r.tasks, row.id, [finding("nit-a", { severity: "nit" })]);
  r.policy.head = B; r.reopen(row.id);
  await submit(r.tasks, row.id, [finding("nit-b", { severity: "nit" }), finding("nit-c", { severity: "nit" })], "changes_requested", "claude", B);
  const current = r.board.get(row.id)!;
  r.board.update(row.id, "user", "lifecycle", { refs: { commit: A }, sdlc: { ...current.sdlc!, head: B, reviewedHead: A, localHead: A } });
  const view = r.tasks.publicView(r.board.get(row.id)!);
  expect(view.findings).toMatchObject({ nit: 2 });
  expect(view.lifecycle).toHaveProperty("findings.nit", 2);
  expect((await r.tasks.lifecycleStatus(row.id, false)).findings?.nit).toBe(2);
  expect((await r.tasks.lifecycleStatus(row.id)).findings?.nit).toBe(2);
});

test("S3 R1 private carried findings reach the review request as counts only", async () => {
  const r = rig(), row = r.create(true);
  await submit(r.tasks, row.id, [finding("PRIVATE_CARRIED_CANARY", { path: "private/record.txt" })], "changes_requested", "user");
  const requests: { body: string; private?: boolean }[] = [];
  const untap = r.bus.tap(event => { if (event.t === "envelope" && event.env.kind === "review") requests.push(event.env); });
  try {
    await r.tasks.done("user", row.id, "new head", { commit: B });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toContain("Open Important findings carried until explicitly dispositioned: 1");
    expect(requests[0]?.private).toBe(true);
    expect(requests[0]?.body).not.toContain("PRIVATE_CARRIED_CANARY");
    expect(requests[0]?.body).not.toContain("private/record.txt");
  } finally { untap(); }
});


test("S3 R1 a reclassified false positive is not evidence for a recurring amendment", async () => {
  const r = rig(), first = r.create();
  await submit(r.tasks, first.id, [finding("reclassified", { pass: "bugs" })]);
  r.reopen(first.id);
  await submit(r.tasks, first.id, [finding("reclassified", { pass: "security", disposition: "false_positive" })]);
  await submit(r.tasks, r.create().id, [finding("reclassified", { pass: "bugs" })]);
  expect(r.board.list("backlog")).toHaveLength(0);
});

for (const mode of ["off", "advise", "enforce"] as const) for (const structured of [false, true]) test(`S3 follow-up refuses a supplied head outside current work (${mode}, findings=${structured})`, async () => {
  const r = rig(mode), row = r.create(), before = r.board.get(row.id)!;
  await expect(submit(r.tasks, row.id, structured ? [finding("wrong-head-nit", { severity: "nit" })] : undefined, "changes_requested", "claude", B)).rejects.toThrow(/head/i);
  expect(r.board.get(row.id)).toEqual(before);
});

test("S3 follow-up permits an explicit head when no task head can resolve", async () => {
  const r = rig(), row = r.create();
  r.board.update(row.id, "user", "lifecycle", { refs: { commit: "short" }, sdlc: { stage: "review" } });
  const next = await submit(r.tasks, row.id, [finding("explicit-nit", { severity: "nit" })], "changes_requested", "claude", B);
  expect(next.history.findLast(entry => entry.reviewFindings)?.reviewFindings?.head).toBe(B);
});

test("S3 follow-up rechecks the resolved head after screening even without findings", async () => {
  let enter!: () => void, release!: () => void;
  let started = false;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const r = rig("off", { piiScreen: async () => { started = true; enter(); await gate; return { label: "clear", ms: 0 }; } });
  r.routing.signals.pii_screen = "local";
  const row = r.create();
  const pending = r.tasks.review("claude", row.id, "changes_requested", "reviewed original work", undefined, A).then(value => ({ value }), error => ({ error }));
  try {
    await Promise.race([entered, Bun.sleep(1000)]);
    expect(started).toBe(true);
    r.board.update(row.id, "user", "lifecycle", { refs: { commit: B }, sdlc: { ...row.sdlc!, head: B, localHead: B } });
  } finally { release(); }
  expect(await pending).toHaveProperty("error");
  expect(r.board.get(row.id)?.state).toBe("in_review");
});

for (const [by, cls] of [["user", "plan"], ["hub", "implement"], ["user", "implement"]] as const) test(`S3 follow-up quoted markers on ${by}/${cls} cards cannot suppress a real amendment`, async () => {
  const r = rig();
  r.board.propose(by, { title: "Unrelated quoted marker", class: cls, backlog: true, detail: "Review finding key: security:missing-origin-check" });
  await submit(r.tasks, r.create().id, [finding()]);
  await submit(r.tasks, r.create().id, [finding()]);
  const actual = r.board.list("backlog").filter(row => row.class === "plan" && row.history[0]?.by === "hub");
  expect(actual).toHaveLength(1);
  expect(actual[0]?.title).toContain("Review policy amendment");
});
