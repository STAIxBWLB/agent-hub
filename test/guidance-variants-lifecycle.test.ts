import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { USER } from "../src/hub/envelope.ts";
import { parseRole, type RoleCatalog } from "../src/hub/roles.ts";
import { guidanceVariantKey, type GuidanceVariantPayloadV1, type GuidanceVariantV1 } from "../src/hub/guidance-variants.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import { taskExecutionReference, executionReferenceDigest } from "../src/hub/execution-links.ts";
import vectors from "./fixtures/guidance-variant-v1.json";

const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); });
class Peer extends BasePeer { async start() { this.setState("idle"); } async stop() {} async deliver() {} }
async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-guidance-lifecycle-"));
  let board = new Board(join(cwd, "hub.db"));
  const roster = new Set(["codex", "claude", "kimi"]), bus = new Bus({ batchMs: 0, rostered: peer => roster.has(peer) });
  clean.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  for (const id of roster) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const role = parseRole(vectors.baseline, "test-engineer", "project");
  const catalog: RoleCatalog = { roles: new Map([[role.id, role]]), errors: [] };
  const task = board.propose(USER, { title: "Guidance lifecycle fixture", class: "implement", role: role.id });
  board.update(task.id, USER, "accepted", { owner: "codex", reviewer: "claude", state: "in_progress" });
  const roles: Record<string, string[]> = { codex: ["implementer"], claude: ["reviewer"], kimi: ["implementer"] };
  const control: { private: boolean; review: boolean; held: boolean; screening: boolean; authority?: string; screen?: () => Promise<void>; time: number } = { private: false, review: false, held: false, screening: false, time: 1000 };
  const routing = loadRouting(cwd), projectKey = "guidance-lifecycle-fixture", notices: string[] = [];
  const makeTasks = () => new Tasks({ cwd, board, bus, project: "fixture", catalog, roles, now: () => control.time,
    notify: text => notices.push(text), share: (_peer, text) => notices.push(text), tell: (_peer, text) => notices.push(text),
    routing: () => ({ ...routing, signals: { ...routing.signals, pii_screen: control.screening ? "local" : "off", pii_patterns: [] }, constraints: { ...routing.constraints, pii: "local_only" } }),
    privateTurn: () => control.private, reviewObserverInput: () => control.review, sweepHeld: () => control.held,
    requestAuthority: () => () => control.authority,
    piiScreen: async () => { await control.screen?.(); return { label: "clear", ms: 0 }; },
    executionLineage: { projectKey, cursorKey: "guidance-fixture-cursor-key-000001", readDelivery: () => undefined },
  });
  let tasks = makeTasks();
  const input = (author = "codex", experimentId = "experiment-a", problem = "Checks omit an edge case."): GuidanceVariantV1 => {
    const current = board.get(task.id)!, { id: _goldenId, ...golden } = vectors.golden.record;
    const value: GuidanceVariantPayloadV1 = {
      ...golden, v: 1, baseline: { ...golden.baseline, layer: "project" }, projectKey, experimentId, taskId: current.id, taskCreated: current.created,
      flowRevision: current.history.length, author,
      rationale: { ...golden.rationale, problemHypothesis: problem },
      evidenceRefs: [taskExecutionReference(projectKey, current.id, current.created)],
    };
    return { ...value, id: guidanceVariantKey(value) };
  };
  const read = (value: GuidanceVariantV1) => ({ taskId: value.taskId, taskCreated: value.taskCreated, experimentId: value.experimentId, id: value.id });
  const withdraw = (value: GuidanceVariantV1) => ({ ...read(value), flowRevision: board.get(task.id)!.history.length });
  return { cwd, bus, task, roles, roster, control, catalog, input, read, withdraw, projectKey, notices,
    get board() { return board; }, get tasks() { return tasks; },
    restart() { board.close(); board = new Board(join(cwd, "hub.db")); tasks = makeTasks(); },
  };
}

test("declared create and exact replay persist separately without changing task or public task bytes", async () => {
  const f = await fixture(), input = f.input(), before = f.board.get(f.task.id)!;
  const publicBefore = f.tasks.publicView(before), storageBefore = f.board.guidanceVariantsIntegrity();
  const first = await f.tasks.guidanceVariantCreate("codex", input);
  expect(first).toEqual({ id: input.id, taskId: input.taskId, experimentId: input.experimentId, status: "declared", already: false });
  expect(f.board.hasGuidanceVariants()).toBe(true);
  const saved = f.board.guidanceVariantsIntegrity();
  expect(saved.experiments).toBe(storageBefore.experiments + 1); expect(saved.variants).toBe(storageBefore.variants + 1);
  f.control.time = 2000;
  expect(await f.tasks.guidanceVariantCreate("codex", input)).toEqual({ ...first, already: true });
  expect(f.board.guidanceVariantsIntegrity()).toEqual(saved);
  expect(f.board.get(f.task.id)).toEqual(before);
  expect(f.tasks.publicView(f.board.get(f.task.id)!)).toEqual(publicBefore);
  const view = f.tasks.guidanceVariantRead("codex", f.read(input));
  if (view.state !== "available") throw new Error("fixture guidance should be available");
  expect(view.records).toHaveLength(1);
  const stored = f.board.guidanceVariants(f.projectKey, input.taskId, input.taskCreated, input.experimentId)[0]!;
  expect(stored.variant).toEqual(input);
  expect(stored.createdBy).toBe("codex"); expect(stored.createdAt).toBe(1000);
  const { experimentId: _publicExperiment, ...metadata } = view.records[0]!;
  expect(metadata).toEqual({
    id: input.id, taskId: input.taskId, taskCreated: input.taskCreated, flowRevision: input.flowRevision,
    roleId: input.baseline.roleId, layer: input.baseline.layer,
    baselineSha256: input.baseline.sha256, candidateSha256: input.candidate.sha256,
    changedSections: ["Scope"], bytes: { baseline: Buffer.byteLength(input.baseline.bytes), candidate: Buffer.byteLength(input.candidate.bytes), record: Buffer.byteLength(JSON.stringify(input)) },
    author: input.author, status: "declared", applicable: true, rationale: input.rationale,
    evidence: [{ key: executionReferenceDigest(input.evidenceRefs[0]!), status: "declared" }],
  });
  for (const field of ["variant", "createdBy", "createdAt", "withdrawn", "baseline", "candidate"])
    expect(Object.hasOwn(view.records[0]!, field)).toBe(false);
  expect(f.tasks.guidanceVariantApplicable("codex", f.read(input))).toBe(true);
  expect(f.notices).toEqual([]);
});

test("withdrawal is one way, repeat preserves attribution, and create replay never revives it", async () => {
  const f = await fixture(), input = f.input(); await f.tasks.guidanceVariantCreate("codex", input);
  const beforeTask = f.board.get(f.task.id)!;
  f.control.time = 2000;
  const first = await f.tasks.guidanceVariantWithdraw("codex", f.withdraw(input));
  expect(first).toEqual({ id: input.id, taskId: input.taskId, experimentId: input.experimentId, status: "withdrawn", already: false });
  const integrity = f.board.guidanceVariantsIntegrity();
  f.control.time = 3000;
  expect(await f.tasks.guidanceVariantWithdraw(USER, f.withdraw(input))).toEqual({ ...first, already: true });
  expect(f.board.guidanceVariantsIntegrity()).toEqual(integrity);
  const replay = await f.tasks.guidanceVariantCreate("codex", input);
  expect(replay.status).toBe("withdrawn"); expect(replay.already).toBe(true);
  expect(f.board.guidanceVariantsIntegrity()).toEqual(integrity);
  const view = f.tasks.guidanceVariantRead("codex", f.read(input));
  if (view.state !== "available") throw new Error("withdrawn history should remain readable");
  const stored = f.board.guidanceVariants(f.projectKey, input.taskId, input.taskCreated, input.experimentId)[0]!;
  expect(stored.variant).toEqual(input); expect(stored.createdBy).toBe("codex"); expect(stored.createdAt).toBe(1000);
  expect(stored.withdrawn).toEqual({ by: "codex", at: 2000 });
  expect(view.records[0]!.status).toBe("withdrawn");
  expect(Object.hasOwn(view.records[0]!, "withdrawn")).toBe(false);
  expect(view.records[0]!.applicable).toBe(false);
  expect(f.tasks.guidanceVariantApplicable("codex", f.read(input))).toBe(false);
  expect(f.board.get(f.task.id)).toEqual(beforeTask);
});

test("restart retains exact declaration, frozen baseline, withdrawal and attribution", async () => {
  const f = await fixture(), input = f.input(); await f.tasks.guidanceVariantCreate("codex", input);
  const before = f.tasks.guidanceVariantRead("codex", f.read(input)), integrity = f.board.guidanceVariantsIntegrity();
  const storedBefore = f.board.guidanceVariants(f.projectKey, input.taskId, input.taskCreated, input.experimentId);
  f.restart();
  expect(f.board.guidanceVariants(f.projectKey, input.taskId, input.taskCreated, input.experimentId)).toEqual(storedBefore);
  expect(f.tasks.guidanceVariantRead("codex", f.read(input))).toEqual(before);
  expect(f.board.guidanceVariantsIntegrity()).toEqual(integrity);
  await f.tasks.guidanceVariantWithdraw("codex", f.withdraw(input));
  const withdrawn = f.tasks.guidanceVariantRead("codex", f.read(input)), after = f.board.guidanceVariantsIntegrity();
  const storedWithdrawn = f.board.guidanceVariants(f.projectKey, input.taskId, input.taskCreated, input.experimentId);
  f.restart();
  expect(f.board.guidanceVariants(f.projectKey, input.taskId, input.taskCreated, input.experimentId)).toEqual(storedWithdrawn);
  expect(f.tasks.guidanceVariantRead("codex", f.read(input))).toEqual(withdrawn);
  expect(f.board.guidanceVariantsIntegrity()).toEqual(after);
});

test("stale flow and changed catalog retain history but cannot become applicable or silently rebase", async () => {
  const f = await fixture(), input = f.input(); await f.tasks.guidanceVariantCreate("codex", input);
  f.board.update(f.task.id, USER, "note", {}, "New revision");
  const before = f.board.guidanceVariantsIntegrity();
  await expect(f.tasks.guidanceVariantCreate("codex", input)).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(f.tasks.guidanceVariantApplicable("codex", f.read(input))).toBe(false);
  const view = f.tasks.guidanceVariantRead("codex", f.read(input));
  if (view.state !== "available") throw new Error("historical declaration should be readable");
  expect(f.board.guidanceVariants(f.projectKey, input.taskId, input.taskCreated, input.experimentId)[0]!.variant).toEqual(input); expect(view.records[0]!.applicable).toBe(false);
  f.catalog.roles.set("test-engineer", parseRole(vectors.baseline.replace("Check behavior.", "Check another behavior."), "test-engineer", "project"));
  await expect(f.tasks.guidanceVariantCreate("codex", f.input())).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(f.board.guidanceVariantsIntegrity()).toEqual(before);
  // Withdrawal wraps the current flow; the historical record is never rewritten.
  await f.tasks.guidanceVariantWithdraw("codex", f.withdraw(input));
  const withdrawn = f.tasks.guidanceVariantRead("codex", f.read(input));
  if (withdrawn.state !== "available") throw new Error("withdrawal history should be readable");
  expect(f.board.guidanceVariants(f.projectKey, input.taskId, input.taskCreated, input.experimentId)[0]!.variant).toEqual(input);
  expect(withdrawn.records[0]!.status).toBe("withdrawn");
});

test("sixteen historical variants include withdrawals and independent experiments have their own ceiling", async () => {
  const f = await fixture();
  const inputs = Array.from({ length: 16 }, (_, index) => f.input("codex", "experiment-a", `Case ${index} needs observation.`));
  for (const input of inputs) await f.tasks.guidanceVariantCreate("codex", input);
  await f.tasks.guidanceVariantWithdraw("codex", f.withdraw(inputs[0]!));
  const atCap = f.board.guidanceVariantsIntegrity();
  expect((await f.tasks.guidanceVariantCreate("codex", inputs[1]!)).already).toBe(true);
  await expect(f.tasks.guidanceVariantCreate("codex", f.input("codex", "experiment-a", "Another case needs observation."))).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(f.board.guidanceVariantsIntegrity()).toEqual(atCap);
  await f.tasks.guidanceVariantCreate("codex", f.input("codex", "experiment-b"));
  expect(f.board.guidanceVariantsIntegrity().variants).toBe(atCap.variants + 1);
  expect(f.board.guidanceVariantsIntegrity().experiments).toBe(atCap.experiments + 1);
});

test("write admission matches owner base plus roster and permits only the person under review", async () => {
  const f = await fixture();
  for (const actor of ["claude", "kimi", "hub", "admin", "peer@room", ""]) {
    await expect(f.tasks.guidanceVariantCreate(actor, f.input())).rejects.toBeInstanceOf(PreEffectToolRefusal);
  }
  f.roles.codex = [];
  await expect(f.tasks.guidanceVariantCreate("codex", f.input())).rejects.toBeInstanceOf(PreEffectToolRefusal);
  f.roles.codex = ["implementer"]; f.roster.delete("codex");
  await expect(f.tasks.guidanceVariantCreate("codex", f.input())).rejects.toBeInstanceOf(PreEffectToolRefusal);
  f.roster.add("codex");
  f.board.update(f.task.id, USER, "done", { state: "in_review" });
  await expect(f.tasks.guidanceVariantCreate("codex", f.input())).rejects.toBeInstanceOf(PreEffectToolRefusal);
  const person = f.input(USER);
  expect((await f.tasks.guidanceVariantCreate(USER, person)).status).toBe("declared");
  await expect(f.tasks.guidanceVariantWithdraw("codex", f.withdraw(person))).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect((await f.tasks.guidanceVariantWithdraw(USER, f.withdraw(person))).status).toBe("withdrawn");
});

for (const state of ["approved", "cancelled"] as const) test(`closed ${state} task refuses every writer without touching storage`, async () => {
  const f = await fixture(), input = f.input(); await f.tasks.guidanceVariantCreate("codex", input);
  f.board.update(f.task.id, USER, state, { state }); const before = f.board.guidanceVariantsIntegrity();
  for (const actor of ["codex", USER]) {
    await expect(f.tasks.guidanceVariantCreate(actor, f.input(actor))).rejects.toBeInstanceOf(PreEffectToolRefusal);
    await expect(f.tasks.guidanceVariantWithdraw(actor, f.withdraw(input))).rejects.toBeInstanceOf(PreEffectToolRefusal);
  }
  expect(f.board.guidanceVariantsIntegrity()).toEqual(before);
});

for (const change of ["authority", "owner", "flow", "role", "roster", "catalog", "private", "review", "pii", "hold"] as const)
  test(`create rechecks ${change} after screening and persists no partial experiment`, async () => {
    const f = await fixture(), input = f.input(); let arrive!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { arrive = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    f.control.screening = true; f.control.screen = async () => { arrive(); await gate; };
    const before = f.board.guidanceVariantsIntegrity();
    const pending = f.tasks.guidanceVariantCreate("codex", input).then(() => undefined, error => error);
    await entered;
    if (change === "authority") f.control.authority = "Native session changed";
    else if (change === "owner") f.board.update(f.task.id, USER, "assigned", { owner: "kimi" });
    else if (change === "flow") f.board.update(f.task.id, USER, "note", {}, "New revision");
    else if (change === "role") f.roles.codex = [];
    else if (change === "roster") f.roster.delete("codex");
    else if (change === "catalog") f.catalog.roles.set("test-engineer", parseRole(vectors.baseline.replace("Check behavior.", "Check another behavior."), "test-engineer", "project"));
    else if (change === "private") f.control.private = true;
    else if (change === "review") f.control.review = true;
    else if (change === "pii") f.board.update(f.task.id, USER, "note", { signals: ["pii"] });
    else f.control.held = true;
    release(); expect(await pending).toBeInstanceOf(PreEffectToolRefusal);
    expect(f.board.guidanceVariantsIntegrity()).toEqual(before);
  });

test("concurrent duplicate creates share one immutable record and one experiment", async () => {
  const f = await fixture(), input = f.input(), before = f.board.guidanceVariantsIntegrity();
  const results = await Promise.all([f.tasks.guidanceVariantCreate("codex", input), f.tasks.guidanceVariantCreate("codex", input)]);
  expect(results.map(result => result.already).sort()).toEqual([false, true]);
  const after = f.board.guidanceVariantsIntegrity();
  expect(after.variants).toBe(before.variants + 1); expect(after.experiments).toBe(before.experiments + 1);
});

test("task incarnation, project binding, authenticated author and complete closed envelope are checked before storage", async () => {
  const f = await fixture(), input = f.input(), before = f.board.guidanceVariantsIntegrity();
  const { id: _id, ...unsigned } = input;
  for (const changed of [
    { ...unsigned, taskCreated: input.taskCreated + 1 }, { ...unsigned, flowRevision: input.flowRevision + 1 },
    { ...unsigned, projectKey: "another-project" }, { ...unsigned, taskId: 999999 },
    { ...unsigned, author: "kimi" },
  ]) {
    const rekeyed = { ...changed, id: guidanceVariantKey(changed) };
    await expect(f.tasks.guidanceVariantCreate("codex", rekeyed)).rejects.toBeInstanceOf(PreEffectToolRefusal);
  }
  for (const changed of [{ ...input, tested: true }, { ...input, authority: "user" }])
    await expect(f.tasks.guidanceVariantCreate("codex", changed)).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(f.board.guidanceVariantsIntegrity()).toEqual(before);
  await f.tasks.guidanceVariantCreate("codex", input);
  const created = f.board.guidanceVariantsIntegrity();
  for (const changed of [
    { ...f.withdraw(input), taskCreated: input.taskCreated + 1 },
    { ...f.withdraw(input), flowRevision: input.flowRevision + 1 },
    { ...f.withdraw(input), authority: "user" },
  ]) await expect(f.tasks.guidanceVariantWithdraw("codex", changed)).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(f.board.guidanceVariantsIntegrity()).toEqual(created);
});

test("the sixteen variant ceiling is not an experiment-count ceiling", async () => {
  const f = await fixture(), before = f.board.guidanceVariantsIntegrity();
  for (let index = 0; index < 17; index++) await f.tasks.guidanceVariantCreate("codex", f.input("codex", `experiment-${index}`));
  const after = f.board.guidanceVariantsIntegrity();
  expect(after.experiments).toBe(before.experiments + 17);
  expect(after.variants).toBe(before.variants + 17);
});

for (const change of ["peer-object", "generation", "generation-unknown", "native-session"] as const)
  test(`screened create is fenced to the original ${change} identity`, async () => {
    const f = await fixture(), input = f.input(), peer = f.bus.peers.get("codex")!;
    let generation: string | undefined = "generation-one", session = "session-one";
    Object.defineProperty(peer, "sessionGeneration", { configurable: true, get: () => generation });
    Object.defineProperty(peer, "nativeSession", { configurable: true, get: () => session });
    let arrive!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { arrive = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    f.control.screening = true; f.control.screen = async () => { arrive(); await gate; };
    const before = f.board.guidanceVariantsIntegrity();
    const pending = f.tasks.guidanceVariantCreate("codex", input).then(() => undefined, error => error);
    await entered;
    if (change === "peer-object") {
      const replacement = new Peer("codex"); await replacement.start(); f.bus.add(replacement);
    } else if (change === "generation") generation = "generation-two";
    else if (change === "generation-unknown") generation = undefined;
    else session = "session-two";
    release(); expect(await pending).toBeInstanceOf(PreEffectToolRefusal);
    expect(f.board.guidanceVariantsIntegrity()).toEqual(before);
  });

test("a present but unknown generation is not the absent legacy generation port", async () => {
  const f = await fixture(), input = f.input(), peer = f.bus.peers.get("codex")!;
  Object.defineProperty(peer, "sessionGeneration", { configurable: true, get: () => undefined });
  let screens = 0;
  f.control.screening = true; f.control.screen = async () => { screens++; };
  const before = f.board.guidanceVariantsIntegrity();
  await expect(f.tasks.guidanceVariantCreate("codex", input)).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(screens).toBe(0); expect(f.board.guidanceVariantsIntegrity()).toEqual(before);
});
