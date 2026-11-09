import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Task } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { HUB, USER } from "../src/hub/envelope.ts";
import { OWNERSHIP_EVENTS, Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { localSupersedingTask, sdlcConfig, type SdlcGh, type SpecAcceptance } from "../src/hub/sdlc.ts";

// #1328 T4 / AC5: stored person consent may move only through a current host-verified supersession.
const CREATED = "2026-10-17T00:00:00Z", EDITED = "2026-10-18T00:00:00Z", COMMENTED = "2026-10-20T00:00:00Z", CHANGED = "2026-10-21T00:00:00Z";
const CONSENTED_AT = Date.parse("2026-10-19T00:00:00Z");
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

type Options = { edited?: string | null; sourceRepo?: string; destinationRepo?: string; sourceIssue?: number; destinationIssue?: number; sourceCount?: number; reverseIds?: boolean; cohort?: boolean };
function rig(options: Options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-spec-carry-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const host = { lastEditedAt: (options.edited === undefined ? EDITED : options.edited) as string | null | undefined, updatedAt: EDITED, number: undefined as number | undefined, failed: false, privateTurn: false, authority: true, pr: undefined as Record<string, unknown> | undefined };
  const calls: string[][] = [], notices: string[] = [];
  let held: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  const gh: SdlcGh = async args => {
    calls.push([...args]);
    const barrier = held; held = undefined;
    if (barrier) { barrier.entered.resolve(); await barrier.release.promise; }
    if (host.failed) return { code: 1, stdout: "" };
    if (host.pr && args[0] === "pr" && args[1] === "view") return { code: 0, stdout: JSON.stringify(host.pr) };
    if (host.pr && args.some(arg => arg.includes("reviewThreads(first:"))) return { code: 0, stdout: JSON.stringify({ data: { repository: {
      pullRequest: { headRefOid: host.pr.headRefOid, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } },
      issue: { number: options.destinationIssue ?? 7, labels: { nodes: [], pageInfo: { hasNextPage: false } } },
    } } }) };
    const number = host.number ?? Number(args.find(arg => /^(number|issue)=/.test(arg))?.split("=")[1] ?? 7);
    return { code: 0, stdout: JSON.stringify({ data: { repository: { issue: { number, state: "OPEN", createdAt: CREATED, lastEditedAt: host.lastEditedAt, updatedAt: host.updatedAt } } } }) };
  };
  const roles: Record<string, string[]> = { codex: ["implementer"], claude: ["planner"] }, deny: string[] = [], piiPaths: string[] = [];
  const tasks = new Tasks({ cwd, board, bus, project: "spec-carry", repository: "owner/repo", roles, deny, piiPaths,
    ...(options.cohort ? { turnFree: () => true, capable: () => true, idle: () => false, treeHash: () => "fixture-cohort-tree", integrationFacts: () => ({ id: "cohort-carry-facts", text: "fixture integration facts" }), factsCurrent: () => true } : {}),
    routing: () => loadRouting(cwd), notify: text => notices.push(text), privateTurn: () => host.privateTurn,
    requestAuthority: () => () => host.authority ? undefined : "fixture actor authority revoked",
    sdlc: { config: () => sdlcConfig({ mode: "enforce", required_checks: ["gate"] }), gh } });
  cleanup.push(() => { tasks.stopCiWatchers(); bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const sourceRepo = options.sourceRepo ?? "owner/repo", destinationRepo = options.destinationRepo ?? "owner/repo";
  const sourceIssue = options.sourceIssue ?? 7, destinationIssue = options.destinationIssue ?? 7;
  const make = (title: string, repo: string, issue: number, owner: string | null) => {
    const task = board.propose(USER, { title, class: "implement" });
    return board.update(task.id, USER, "fixture identity", { owner, reviewer: USER, sdlc: { stage: "plan", repo, issue } });
  };
  let destination: Task | undefined;
  if (options.reverseIds) destination = make("replacement", destinationRepo, destinationIssue, "codex");
  const sources: Task[] = [];
  const now = Date.now;
  // No await occurs under the fixed clock: both the source row and its real USER consent predate the replacement.
  try {
    Date.now = () => CONSENTED_AT;
    for (let index = 0; index < (options.sourceCount ?? 1); index++) {
      const source = make(`source consent ${index}`, sourceRepo, sourceIssue, null);
      sources.push(tasks.acceptSpec(USER, source.id, { repo: sourceRepo, issue: sourceIssue, edit: { lastEditedAt: options.edited === undefined ? EDITED : options.edited, updatedAt: EDITED } }));
    }
  } finally { Date.now = now; }
  destination ??= make("replacement", destinationRepo, destinationIssue, "codex");
  const source = sources[0]!, destinationId = destination.id;
  const current = () => board.get(destinationId)!;
  const sourceNow = () => board.get(source.id)!;
  const sourceAcceptance = clone(source.sdlc!.acceptance!);
  let cancellationRevision: number | undefined;
  const cancel = async (pointer: string = `#${destinationId}`) => {
    for (const item of sources) {
      const fresh = board.get(item.id)!;
      const cancelled = await tasks.cancel(item.id, USER, { reason: "superseded fixture work", supersededBy: pointer, expectedFlowRevision: fresh.history.length });
      if (item.id === source.id) cancellationRevision = cancelled.cancelled!.flowRevision;
    }
  };
  const patchSource = (patch: Partial<Task>) => board.update(source.id, USER, "fixture source changed", patch);
  const hold = () => { const entered = deferred(), release = deferred(); held = { entered, release }; return { entered: entered.promise, release: release.resolve }; };
  const carryEvents = () => current().history.filter(entry => entry.event === "spec acceptance carried");
  const gate = () => tasks.recordSdlc("codex", destinationId, { stage: "build" });
  const rawState = (id: number, state: string) => {
    // Simulate independently replaced stored state without weakening Board's public closed-state transitions.
    const database = (board as unknown as { db: { query(sql: string): { run(...args: (string | number)[]): unknown } } }).db;
    database.query("UPDATE tasks SET state=? WHERE id=?").run(state, id);
  };
  return { cwd, board, bus, tasks, source, sources, destinationId, sourceRepo, destinationRepo, sourceIssue, destinationIssue, sourceAcceptance, sourceCancellationRevision: () => cancellationRevision, roles, deny, piiPaths, host, calls, notices, current, sourceNow, cancel, patchSource, hold, carryEvents, gate, rawState };
}
async function ready(options: Options = {}) { const r = rig(options); await r.cancel(); return r; }
async function noCarry(r: ReturnType<typeof rig>, expectedReads: number) {
  const before = clone(r.current()), revision = r.board.statusRevision();
  const error = await r.gate().then(() => undefined, (failure: Error) => failure);
  expect(error).toBeInstanceOf(Error);
  expect(error!.message).toMatch(/spec not accepted|spec acceptance missing|spec edit time unknown|changed|authority|private|owner|not yours/);
  expect(r.current().sdlc?.acceptance).toBeUndefined();
  expect(r.carryEvents()).toEqual([]);
  expect(r.calls).toHaveLength(expectedReads);
  expect(r.current()).toEqual(before); expect(r.board.statusRevision()).toBe(revision);
}
function assertCarried(r: ReturnType<typeof rig>) {
  expect(r.current().sdlc?.acceptance).toEqual({ ...r.sourceAcceptance, repo: r.destinationRepo, issue: r.destinationIssue });
  const events = r.carryEvents(); expect(events).toHaveLength(1);
  expect(events[0]!.by).toBe(HUB);
  expect(events[0]!.note).toBe(`from task #${r.source.id}; original person acceptance at ${r.sourceAcceptance.acceptedAt}; cancellation revision ${r.sourceCancellationRevision()}`);
  expect(r.current().history.filter(entry => entry.event === "spec accepted")).toEqual([]);
}

test("unchanged same-issue host body carries stored person consent to its exact replacement (#1328 AC5)", async () => {
  const r = await ready(); await r.gate(); assertCarried(r);
  expect(r.calls).toHaveLength(1);
  expect(r.calls[0]!.join(" ")).toContain("lastEditedAt updatedAt");
  expect(r.current().state).toBe("proposed");
});
test("changed host body requires the person to accept the replacement again (#1328 AC5)", async () => {
  const r = await ready(); r.host.lastEditedAt = CHANGED; r.host.updatedAt = CHANGED;
  await noCarry(r, 1);
});
test("a different issue never inherits the source consent (#1328 AC5)", async () => { await noCarry(await ready({ destinationIssue: 8 }), 0); });
test("a different canonical repository never inherits consent (#1328)", async () => { await noCarry(await ready({ destinationRepo: "other/repo" }), 0); });
test("canonical repository case aliases retain consent while binding the destination spelling (#1328)", async () => {
  const r = await ready({ sourceRepo: "Owner/Repo", destinationRepo: "owner/repo" }); await r.gate(); assertCarried(r);
});
for (const spelling of ["task #", "#", ""] as const) test(`whole local reference ${JSON.stringify(spelling)} authorizes only its destination (#1328)`, async () => {
  const r = rig(); await r.cancel(`${spelling}${r.destinationId}`); await r.gate(); assertCarried(r);
});
for (const pointer of ["prefix #{id}", "#{id} and #999", "task #{id} (replacement)", "owner/repo#{id}", "https://github.com/owner/repo/issues/{id}"] as const) test(`prose or foreign reference ${pointer} cannot grant consent (#1328)`, async () => {
  const r = rig(); await r.cancel(pointer.replace("{id}", String(r.destinationId))); await noCarry(r, 0);
});
test("wrong and self-targeted supersessions do not authorize this task (#1328)", async () => {
  const wrong = rig(); await wrong.cancel(`#${wrong.destinationId + 1}`); await noCarry(wrong, 0);
  const self = rig(); await self.cancel(`#${self.source.id}`); await noCarry(self, 0);
});
test("a later source cannot point backward and form a consent cycle (#1328)", async () => { await noCarry(await ready({ reverseIds: true }), 0); });
test("a pointer on a noncancelled source is not authority (#1328)", async () => {
  const r = rig(); r.patchSource({ cancelled: { reason: "corrupt open-row marker", supersededBy: `#${r.destinationId}`, flowRevision: r.sourceNow().history.length + 1 } });
  await noCarry(r, 0);
});
test("an explicit cold source repository scope cannot use the default project identity (#1328)", async () => {
  const r = await ready(); r.patchSource({ refs: { repo: join(r.cwd, "unregistered-worktree") } }); await noCarry(r, 0);
});
test("an explicit cold destination scope cannot receive project-default consent (#1328)", async () => {
  const r = await ready(); r.board.update(r.destinationId, USER, "fixture destination scope", { refs: { repo: join(r.cwd, "unregistered-worktree") } }); await noCarry(r, 0);
});
test("a cancelled source without stored person consent cannot authorize carry (#1328)", async () => {
  const r = await ready(), sdlc = { ...r.sourceNow().sdlc! }; delete sdlc.acceptance; r.patchSource({ sdlc }); await noCarry(r, 0);
});
for (const failure of ["missing-last-edit", "malformed-last-edit", "malformed-accepted-at"] as const) test(`malformed stored consent ${failure} cannot authorize a host read (#1328)`, async () => {
  const r = await ready(), acceptance = { ...r.sourceNow().sdlc!.acceptance! } as Record<string, unknown>;
  if (failure === "missing-last-edit") delete acceptance.lastEditedAt;
  if (failure === "malformed-last-edit") acceptance.lastEditedAt = "not a timestamp";
  if (failure === "malformed-accepted-at") acceptance.acceptedAt = "person said yes";
  r.patchSource({ sdlc: { ...r.sourceNow().sdlc!, acceptance: acceptance as unknown as SpecAcceptance } });
  await noCarry(r, 0);
});
for (const signal of ["pii", "pii_path"]) test(`private source ${signal} cannot trigger a read or a public copy (#1328)`, async () => {
  const r = await ready(); r.patchSource({ signals: [signal] }); await noCarry(r, 0);
});
test("withheld cancellation metadata cannot authorize public carry (#1328)", async () => {
  const r = await ready(); r.patchSource({ cancelled: { ...r.sourceNow().cancelled!, withheld: true } }); await noCarry(r, 0);
});
test("private destination and private caller context never query the old source issue (#1328)", async () => {
  const destination = await ready(); destination.board.update(destination.destinationId, USER, "fixture private", { signals: ["pii"] }); await noCarry(destination, 0);
  const context = await ready(); context.host.privateTurn = true; await noCarry(context, 0);
});
for (const failure of ["unavailable", "missing-last-edit", "wrong-issue"] as const) test(`unknown host observation ${failure} cannot reuse caller or stored claims (#1328)`, async () => {
  const r = await ready({ edited: null });
  if (failure === "unavailable") r.host.failed = true;
  if (failure === "missing-last-edit") r.host.lastEditedAt = undefined;
  if (failure === "wrong-issue") r.host.number = r.destinationIssue + 1;
  r.host.updatedAt = COMMENTED;
  await noCarry(r, 1);
});
test("explicit host null lastEditedAt still carries after a comments-only updatedAt change (#1328)", async () => {
  const r = await ready({ edited: null }); r.host.updatedAt = COMMENTED;
  await r.gate(); assertCarried(r); expect(r.current().sdlc!.acceptance!.updatedAt).toBe(EDITED);
});
test("repeat lifecycle recording keeps its existing outer history while carrying person consent only once (#1328)", async () => {
  const r = await ready(); await r.gate(); const first = clone(r.current()); await r.gate();
  assertCarried(r); expect(r.current().sdlc).toEqual(first.sdlc); expect(r.calls).toHaveLength(1);
  expect(r.current().history.slice(first.history.length).map(entry => entry.event)).toEqual(["lifecycle"]);
});
test("existing valid destination consent is preserved instead of overwritten by a source (#1328)", async () => {
  const r = await ready();
  const manual = r.tasks.acceptSpec(USER, r.destinationId, { repo: r.destinationRepo, issue: r.destinationIssue, edit: { lastEditedAt: EDITED, updatedAt: COMMENTED } });
  const acceptance = clone(manual.sdlc!.acceptance!); r.host.updatedAt = COMMENTED;
  await r.gate(); expect(r.current().sdlc!.acceptance).toEqual(acceptance); expect(r.carryEvents()).toEqual([]);
});
test("carry clones only acceptance, never the source's plan review or artifact evidence (#1328)", async () => {
  const r = rig();
  r.patchSource({ refs: { branch: "old-artifact", commit: "a".repeat(40) }, sdlc: { ...r.sourceNow().sdlc!, stage: "review", pr: 9, head: "a".repeat(40), reviewedHead: "a".repeat(40), localHead: "a".repeat(40), localResult: "passed", planReview: { planner: "claude", planningRevision: 0, recordedAt: CONSENTED_AT } } });
  await r.cancel(); await r.gate(); assertCarried(r);
  for (const field of ["planReview", "pr", "head", "reviewedHead", "localHead", "localResult", "merge", "criteria"] as const) expect(r.current().sdlc?.[field]).toBeUndefined();
  expect(r.current().sdlc!.stage).toBe("build"); expect(r.current().refs).toEqual({});
});
test("manual acceptance remains USER-only and the wire receipt cannot supply consent (#1328)", () => {
  const r = rig(), edit = { lastEditedAt: EDITED, updatedAt: EDITED };
  expect(() => r.tasks.acceptSpec("codex", r.destinationId, { repo: r.destinationRepo, issue: r.destinationIssue, edit })).toThrow("person");
  expect(() => r.tasks.recordLifecycle("codex", r.destinationId, { acceptance: r.sourceAcceptance })).toThrow("unsupported");
});

type Mutation = (r: ReturnType<typeof rig>) => void;
const mutations: [string, Mutation][] = [
  ["source receipt changes", r => r.patchSource({ sdlc: { ...r.sourceNow().sdlc!, acceptance: { ...r.sourceNow().sdlc!.acceptance!, lastEditedAt: CHANGED } } })],
  ["source pointer changes", r => r.patchSource({ cancelled: { ...r.sourceNow().cancelled!, supersededBy: `#${r.destinationId + 1}` } })],
  ["source cancellation revision changes", r => r.patchSource({ cancelled: { ...r.sourceNow().cancelled!, flowRevision: r.sourceNow().cancelled!.flowRevision + 1 } })],
  ["source cancelled state disappears", r => r.rawState(r.source.id, "proposed")],
  ["source becomes private", r => r.patchSource({ signals: ["pii_path"] })],
  ["source repository refs change", r => r.patchSource({ refs: { repo: "other/repo" } })],
  ["destination issue changes", r => r.board.update(r.destinationId, USER, "fixture relink", { sdlc: { stage: "plan", repo: r.destinationRepo, issue: r.destinationIssue + 1 } })],
  ["destination owner changes", r => r.board.update(r.destinationId, USER, "fixture reassigned", { owner: "kimi" })],
  ["destination revision changes", r => r.board.update(r.destinationId, USER, "fixture unrelated revision", {}, "unchanged issue, new flow")],
  ["destination becomes private", r => r.board.update(r.destinationId, USER, "fixture private", { signals: ["pii_path"] })],
  ["caller authority is revoked", r => { r.host.authority = false; }],
  ["configured owner role changes", r => { r.roles.codex = ["reviewer"]; }],
  ["deny policy changes", r => { r.deny.push("new-private/**"); }],
  ["private-path policy changes", r => { r.piiPaths.push("new-private/**"); }],
  ["caller private context changes", r => { r.host.privateTurn = true; }],
];
for (const [label, mutate] of mutations) test(`awaited host read cannot carry stale consent when ${label} (#1328)`, async () => {
  const r = await ready(), hold = r.hold();
  const outcome = r.gate().then(() => undefined, (failure: Error) => failure);
  await hold.entered;
  try { mutate(r); } finally { hold.release(); }
  const error = await outcome; expect(error).toBeInstanceOf(Error);
  expect(r.current().sdlc?.acceptance).toBeUndefined(); expect(r.carryEvents()).toEqual([]); expect(r.calls).toHaveLength(1);
});
test("a concurrent person's acceptance is never overwritten by an older carry read (#1328)", async () => {
  const r = await ready(), hold = r.hold(), outcome = r.gate().then(() => undefined, (failure: Error) => failure);
  await hold.entered;
  const manual = r.tasks.acceptSpec(USER, r.destinationId, { repo: r.destinationRepo, issue: r.destinationIssue, edit: { lastEditedAt: EDITED, updatedAt: COMMENTED } });
  const acceptance = clone(manual.sdlc!.acceptance!); hold.release();
  expect(await outcome).toBeInstanceOf(Error); expect(r.current().sdlc!.acceptance).toEqual(acceptance); expect(r.carryEvents()).toEqual([]);
});

test("bounded candidate lookup refuses truncation rather than accepting a prefix (#1328)", async () => { await noCarry(await ready({ sourceCount: 33 }), 0); });
test("oversized source metadata is unknown rather than permission to carry (#1328)", async () => {
  const r = await ready(); r.patchSource({ refs: { paths: ["x".repeat(70 * 1024)] } }); await noCarry(r, 0);
});
test("total candidate projection budget refuses partial consent selection (#1328)", async () => {
  const r = await ready({ sourceCount: 5 });
  for (const source of r.sources) r.board.update(source.id, USER, "fixture large refs", { refs: { paths: ["x".repeat(60 * 1024)] } });
  type Statement = { all(...args: unknown[]): unknown[] };
  const database = (r.board as unknown as { db: { query(sql: string): Statement } }).db, query = database.query;
  const observed: unknown[][] = [];
  database.query = function(sql: string): Statement {
    const statement = query.call(this, sql);
    if (!sql.startsWith("WITH candidates AS (")) return statement;
    return { all: (...args: unknown[]) => { const rows = statement.all(...args); observed.push(rows); return rows; } };
  };
  try {
    expect(r.board.specAcceptanceCandidates(r.destinationId)).toEqual({ rows: [], complete: false });
    await noCarry(r, 0);
    expect(observed).toHaveLength(2);
    for (const rows of observed) {
      expect(rows).toHaveLength(r.sources.length);
      for (const row of rows) expect(row).toEqual({ complete: 0, payload: null });
    }
  } finally { database.query = query; }
});
test("candidate lookup never hydrates source tasks or scans all task bodies/history (#1328)", async () => {
  const r = await ready(), get = r.board.get.bind(r.board), list = r.board.list.bind(r.board);
  r.board.get = (id: number) => { if (id === r.source.id) throw new Error("source Task hydration is forbidden in carry"); return get(id); };
  r.board.list = () => { throw new Error("all-task hydration is forbidden in carry"); };
  try { await r.gate(); assertCarried(r); } finally { r.board.get = get; r.board.list = list; }
});
test("acceptReviewed consumes only its own carry revision and preserves the new task's separate plan review (#1328)", async () => {
  const r = await ready();
  const scope = { review: { scope: "full" as const, reviewers: 1 }, ci: "full" as const };
  const reviewed = r.board.update(r.destinationId, USER, "fixture destination plan reviewed", { plan: scope, sdlc: { ...r.current().sdlc!, planReview: { planner: "claude", planningRevision: 0, recordedAt: Date.now(), scope, issue: { repo: r.destinationRepo, issue: r.destinationIssue, state: "OPEN", editedAt: EDITED, lastEditedAt: EDITED } } } });
  const originalReview = clone(reviewed.sdlc!.planReview!);
  const accepted = await r.tasks.acceptReviewed("codex", r.destinationId);
  expect(accepted.state).toBe("in_progress"); expect(accepted.sdlc!.planReview).toEqual(originalReview); assertCarried(r);
  expect(r.calls).toHaveLength(2); // One spec-body observation reused for carry/verdict, then the existing plan readback.
});
for (const stage of [false, true]) test(`${stage ? "specStageGate" : "specGate"} stages consent without any Board write (#1328)`, async () => {
  const r = await ready(), before = clone(r.current()), revision = r.board.statusRevision();
  const changes: unknown[] = []; r.board.onChange = (...args) => { changes.push(args); };
  if (stage) await r.tasks.specStageGate("codex", r.destinationId, { stage: "build" }); else await r.tasks.specGate("codex", r.destinationId);
  expect(r.current()).toEqual(before); expect(r.board.statusRevision()).toBe(revision); expect(changes).toEqual([]);
  expect(r.calls).toHaveLength(1);
});
test("a prospective stage relink cannot authorize carry before the destination identity is recorded (#1328)", async () => {
  const r = await ready();
  await expect(r.tasks.specStageGate("codex", r.destinationId, { stage: "build", repo: "other/repo", issue: 8 })).rejects.toThrow();
  expect(r.current().sdlc?.acceptance).toBeUndefined(); expect(r.current().sdlc!.repo).toBe(r.destinationRepo); expect(r.carryEvents()).toEqual([]); expect(r.calls).toHaveLength(0);
});

test("prospective acceptRefs repository correction cannot authorize consent in a new scope (#1328)", async () => {
  const r = await ready();
  await expect(r.tasks.acceptReviewed("codex", r.destinationId, undefined, { repo: "other/repo" })).rejects.toThrow("spec not accepted");
  expect(r.current().sdlc?.acceptance).toBeUndefined(); expect(r.current().refs).toEqual({});
  expect(r.current().state).toBe("proposed"); expect(r.carryEvents()).toEqual([]); expect(r.calls).toHaveLength(0);
});

test("an existing reviewer stage actor may carry consent without becoming the task owner (#1328)", async () => {
  const r = await ready();
  r.board.update(r.destinationId, USER, "fixture stage reviewer", { reviewer: "claude" }); r.roles.claude = ["reviewer"];
  await r.tasks.recordSdlc("claude", r.destinationId, { stage: "build" });
  assertCarried(r); expect(r.current().owner).toBe("codex"); expect(r.current().sdlc!.stage).toBe("build");
  expect(r.calls).toHaveLength(1);
});
test("reviewer role drift during the stage host read cannot carry consent (#1328)", async () => {
  const r = await ready();
  r.board.update(r.destinationId, USER, "fixture stage reviewer", { reviewer: "claude" }); r.roles.claude = ["reviewer"];
  const hold = r.hold(), outcome = r.tasks.recordSdlc("claude", r.destinationId, { stage: "build" }).then(() => undefined, (error: Error) => error);
  await hold.entered;
  try { r.roles.claude = ["planner"]; } finally { hold.release(); }
  expect(await outcome).toBeInstanceOf(Error); expect(r.current().sdlc?.acceptance).toBeUndefined();
  expect(r.carryEvents()).toEqual([]); expect(r.current().sdlc!.stage).toBe("plan"); expect(r.calls).toHaveLength(1);
});
test("the local supersession parser requires the entire string including its final character (#1328)", () => {
  for (const reference of ["task #2", "#2", "2"]) expect(localSupersedingTask(reference)).toBe(2);
  for (const reference of ["task #2\n", "#2\n", "2\n", "task 2", "#2 extra", "owner/repo#2", "https://github.com/owner/repo/issues/2"]) expect(localSupersedingTask(reference)).toBeUndefined();
});

for (const stale of [false, true]) test(`valid carry with ${stale ? "stale" : "missing"} plan review refuses accept without a Board write (#1328)`, async () => {
  const r = await ready();
  if (stale) r.board.update(r.destinationId, USER, "fixture stale plan review", { sdlc: { ...r.current().sdlc!, planReview: { planner: "claude", planningRevision: 99, recordedAt: Date.now() } } });
  const before = clone(r.current()), revision = r.board.statusRevision(), changes: unknown[] = [];
  r.board.onChange = (...args) => { changes.push(args); };
  await expect(r.tasks.acceptReviewed("codex", r.destinationId)).rejects.toThrow("plan not reviewed");
  expect(r.current()).toEqual(before); expect(r.board.statusRevision()).toBe(revision); expect(changes).toEqual([]); expect(r.calls).toHaveLength(1);
});
test("an outer lifecycle write failure rolls back consent, provenance and status generation together (#1328)", async () => {
  const r = await ready(), before = clone(r.current()), revision = r.board.statusRevision(), update = r.board.update;
  const changes: unknown[] = []; r.board.onChange = (...args) => { changes.push(args); }; let writes = 0;
  r.board.update = function(...args: Parameters<Board["update"]>) { if (++writes === 2) throw new Error("fixture second Board write refused"); return update.apply(this, args); };
  try { await expect(r.gate()).rejects.toThrow("fixture second Board write refused"); } finally { r.board.update = update; }
  expect(writes).toBe(2); expect(r.current()).toEqual(before); expect(r.board.statusRevision()).toBe(revision);
  expect(changes).toEqual([]); expect(r.carryEvents()).toEqual([]);
});
test("a caller object cannot forge the opaque lifecycle carry proof (#1328)", async () => {
  const r = await ready(), before = clone(r.current()), revision = r.board.statusRevision();
  const forged = { task: r.current(), acceptance: r.sourceAcceptance, carried: true };
  const record = r.tasks.recordLifecycle.bind(r.tasks) as (by: string, id: number, input: unknown, deliverables?: undefined, proof?: object) => Task;
  expect(() => record("codex", r.destinationId, { stage: "build" }, undefined, forged)).toThrow();
  expect(r.current()).toEqual(before); expect(r.board.statusRevision()).toBe(revision); expect(r.carryEvents()).toEqual([]); expect(r.calls).toEqual([]);
});
test("incoming done refs in a foreign scope cannot persist staged consent on a refused entry (#1328)", async () => {
  const r = await ready(), before = clone(r.current()), revision = r.board.statusRevision();
  await expect(r.tasks.done("codex", r.destinationId, "completed fixture", { repo: "other/repo" })).rejects.toThrow();
  expect(r.current()).toEqual(before); expect(r.board.statusRevision()).toBe(revision); expect(r.carryEvents()).toEqual([]);
});
test("a same-description Symbol cannot forge Board carry authority (#1328)", async () => {
  const r = await ready(), before = clone(r.current()), revision = r.board.statusRevision(), changes: unknown[] = [];
  r.board.onChange = (...args) => { changes.push(args); };
  const forgedAuthority = Symbol("HOST_SPEC_ACCEPTANCE_CARRY") as Parameters<Board["updateWithSpecAcceptance"]>[1];
  expect(() => r.board.updateWithSpecAcceptance(
    { source: r.source.id, cancellationRevision: r.sourceCancellationRevision()!, acceptance: r.sourceAcceptance }, forgedAuthority,
    r.destinationId, "codex", "lifecycle", { sdlc: { ...before.sdlc!, stage: "build" } }, undefined, {}, before.history.length,
  )).toThrow("host admission authority");
  expect(r.current()).toEqual(before); expect(r.board.statusRevision()).toBe(revision);
  expect(changes).toEqual([]); expect(r.carryEvents()).toEqual([]); expect(r.calls).toEqual([]);
});
test("both committed carry observers see the admitted final destination state (#1328)", async () => {
  const r = await ready(), events: string[] = [], seen: Task[] = [], revisions: number[] = [];
  r.board.onChange = (_task, entry) => { events.push(entry.event); seen.push(clone(r.current())); revisions.push(r.board.statusRevision()); };
  await r.gate(); assertCarried(r);
  expect(events).toEqual(["spec acceptance carried", "lifecycle"]);
  for (const state of seen) expect(state).toEqual(r.current());
  expect(revisions).toEqual([r.board.statusRevision(), r.board.statusRevision()]);
  expect(r.current().sdlc!.stage).toBe("build"); expect(r.calls).toHaveLength(1);
});
test("returned virtual consent cannot mutate the host's staged acceptance proof (#1328)", async () => {
  const r = await ready(), before = clone(r.current()), revision = r.board.statusRevision();
  const result = await r.tasks.specGate("codex", r.destinationId), acceptance = result!.task.sdlc!.acceptance!;
  expect(Object.isFrozen(acceptance)).toBe(true);
  for (const [field, value] of Object.entries({ repo: "other/repo", issue: 99, lastEditedAt: CHANGED, updatedAt: CHANGED, acceptedAt: CONSENTED_AT + 1 })) expect(Reflect.set(acceptance, field, value)).toBe(false);
  expect(acceptance).toEqual({ ...r.sourceAcceptance, repo: r.destinationRepo, issue: r.destinationIssue });
  expect(acceptance.acceptedAt).toBe(CONSENTED_AT);
  expect(r.current()).toEqual(before); expect(r.board.statusRevision()).toBe(revision); expect(r.carryEvents()).toEqual([]);
  expect(r.calls).toHaveLength(1);
});

test("cohort integration intent keeps HUB attribution while carrying the original owner's consent (#1328)", async () => {
  const r = await ready({ cohort: true }), head = "b".repeat(40), oldHead = "a".repeat(40), path = "src/independent.ts";
  r.host.pr = { headRefOid: head, headRefName: "feat/replacement", state: "OPEN", isDraft: false, baseRefName: "main", baseRefOid: "c".repeat(40),
    statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }], reviewDecision: "APPROVED", reviewRequests: [], files: [{ path, changeType: "MODIFIED" }], changedFiles: 1 };
  const scope = { review: { scope: "full" as const, reviewers: 1 }, ci: "full" as const };
  const planReview = { planner: "claude", planningRevision: 0, recordedAt: Date.now(), scope,
    issue: { repo: r.destinationRepo, issue: r.destinationIssue, state: "OPEN" as const, editedAt: EDITED, lastEditedAt: EDITED } };
  r.board.update(r.destinationId, USER, "fixture independently reviewed destination", { plan: { paths: [path], ...scope },
    sdlc: { ...r.current().sdlc!, pr: 9, head, reviewedHead: head, localHead: head, localResult: "passed", planReview } });
  r.patchSource({ sdlc: { ...r.sourceNow().sdlc!, pr: 99, head: oldHead, reviewedHead: oldHead, localHead: oldHead, localResult: "failed",
    planReview: { planner: "old-planner", planningRevision: 8, recordedAt: CONSENTED_AT } } });
  const other = r.board.propose(USER, { title: "overlapping peer work", class: "implement" });
  const member = r.board.update(other.id, USER, "fixture cohort owner", { owner: "kimi" });
  const generation = (task: Task) => task.history.filter(entry => OWNERSHIP_EVENTS.has(entry.event)).length;
  const joined = r.tasks.cohorts.join(r.current(), [member], generation)!;
  expect(joined.cohort.silent).toBe(true);
  r.tasks.cohorts.intent(joined.cohort, member, generation(member));
  const result = await r.tasks.done("codex", r.destinationId, "replacement implementation complete");
  expect(result.history.at(-1)).toMatchObject({ event: "integration requested", by: HUB });
  assertCarried(r); expect(result.sdlc!.planReview).toEqual(planReview);
  expect(result.sdlc).toMatchObject({ pr: 9, head, reviewedHead: head, localHead: head, localResult: "passed" });
  expect(result.history.filter(entry => entry.event === "integration requested")).toHaveLength(1);
  expect(r.tasks.cohorts.of(r.destinationId)!.integration).toMatchObject({ task: r.destinationId, owner: "codex" });
});
