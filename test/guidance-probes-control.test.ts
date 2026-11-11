import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { HUB, USER, newEnvelope } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { parseRole, parseRoleDocument, taskRoleText } from "../src/hub/roles.ts";
import { SHIPPED_ROLES } from "../src/hub/shipped-roles.ts";
import { guidanceVariantKey, type GuidanceVariantPayloadV1 } from "../src/hub/guidance-variants.ts";
import { GuidanceProbeStore } from "../src/hub/guidance-probe-store.ts";
import { GuidanceProbeError, GUIDANCE_PROBE_MODEL, GUIDANCE_PROBE_REGISTRATION_BYTES, GUIDANCE_PROBE_STOP_TIMEOUT_MS, guidanceProbeManifestKey, parseGuidanceProbePublicReceipt,
  parseGuidanceProbePublicStatus, parseGuidanceProbeRegistration, parseGuidanceProbeSubcommand, probeHash, probeSessionGeneration,
  guidanceProbeWorkerFrame, guidanceProbeNonGuidanceInputHash,
  type GuidanceProbeFakePorts, type ProbeFakeEffects, type ProbeFakeLaunch, type ProbeFakeObservation, type ProbePublicReceipt, type ProbePublicStatus } from "../src/hub/guidance-probes.ts";
import { CONDUCTOR_DAEMON_OPERATIONS, conductorOperation, operationalRequestLabel } from "../src/hub/operational-authority.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";
import { DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import { FakeGuidanceProbeProvider, fakeEffectValue, guidanceProbeFixture } from "./fakes/guidance-probe-provider.ts";
import vectors from "./fixtures/guidance-variant-v1.json";

const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
class Peer extends BasePeer {
  sessionGeneration = "actual-peer-generation";
  nativeSession = "actual-native-session";
  async start() { this.setState("idle"); }
  async stop() {}
  async deliver() {}
}
class Timer {
  next = 0;
  readonly jobs = new Map<number, { callback: () => void; ms: number }>();
  readonly cleared: unknown[] = [];
  set = (callback: () => void, ms: number): unknown => { const id = this.next++; this.jobs.set(id, { callback, ms }); return id; };
  clear = (handle: unknown): void => { this.cleared.push(handle); if (typeof handle === "number") this.jobs.delete(handle); };
  fire(id: number): void { const job = this.jobs.get(id); if (!job) throw new Error("expected scheduled callback"); this.jobs.delete(id); job.callback(); }
  fireDelay(ms: number): void { const job = [...this.jobs].find(([, job]) => job.ms === ms); if (!job) throw new Error("expected named timer bound"); this.fire(job[0]); }
}
function closed(input: ProbeFakeLaunch): ProbeFakeObservation {
  return { reservation: input.reservation, outcome: "closed_fixture", servedModel: GUIDANCE_PROBE_MODEL, inputFrameHash: input.inputSha256,
    workerEffectiveInputHash: input.slot.role === "worker" ? input.inputSha256 : null,
    nonGuidanceInputSha256: input.slot.role === "worker" ? input.nonGuidanceInputSha256 : null,
    candidateArtifactSha256: null, usage: "unknown" };
}
async function fixture(options: { shipped?: boolean; runner?: boolean } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-guidance-probe-control-")), file = join(cwd, "hub.db");
  clean.push(() => rmSync(cwd, { recursive: true, force: true }));
  const board = new Board(file); clean.push(() => board.close());
  const clock = { now: 1000 }, store = new GuidanceProbeStore(file, () => clock.now); clean.push(() => store.close());
  const roster = new Set(["codex", "claude", "pi"]), bus = new Bus({ batchMs: 0, rostered: by => roster.has(by) }); clean.push(() => bus.closeJournal());
  for (const id of roster) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const bytes = options.shipped ? SHIPPED_ROLES["test-engineer"]! : vectors.baseline, layer = options.shipped ? "shipped" as const : "project" as const;
  const role = parseRole(bytes, "test-engineer", layer), catalog = { roles: new Map([[role.id, role]]), errors: [] };
  const created = board.propose(USER, { title: "Public probe fixture", class: options.shipped ? "test" : "implement", role: role.id });
  board.update(created.id, USER, "accepted", { owner: "codex", reviewer: "pi", state: "in_progress" });
  const roles: Record<string, string[]> = { codex: ["implementer"], claude: ["conductor"], pi: ["reviewer"] };
  const control = { private: false, review: false, operational: true, connection: "host-console-connection-a", alive: true,
    patterns: [] as string[], deny: [] as string[], screenCalls: 0, resolverCalls: 0 };
  const routing = loadRouting(cwd), projectKey = "probe-control-fixture", messages: string[] = [], provider = new FakeGuidanceProbeProvider(), timer = new Timer();
  const dependency: NonNullable<TasksDeps["guidanceProbes"]> = { store, ...(options.runner === false ? {} : { fakePorts: provider }), timer,
    prepareEditorFrame: () => "Explicit bounded fixture editor input.",
    session: by => {
      const connection = control.connection, peer = by === USER ? undefined : bus.peers.get(by);
      const generation = by === USER ? connection : peer?.sessionGeneration, nativeSession = by === USER ? null : peer?.nativeSession ?? null;
      if (!probeSessionGeneration(generation)) return undefined;
      return { generation, nativeSession, requestConnectionId: connection, current: () => {
        if (!control.alive || control.connection !== connection || by !== USER && (bus.peers.get(by) !== peer || peer?.sessionGeneration !== generation || (peer?.nativeSession ?? null) !== nativeSession))
          throw new Error("captured fixture request session changed");
      } };
    } };
  const deps: TasksDeps = { cwd, board, bus, project: "fixture", roles, catalog, guidanceProbes: dependency, now: () => clock.now,
    notify: text => messages.push(text), tell: (_by, text) => messages.push(text), share: (_by, text) => messages.push(text),
    routing: () => ({ ...routing, signals: { ...routing.signals, pii_screen: "off", pii_patterns: control.patterns }, constraints: { ...routing.constraints, pii: "local_only" } }),
    deny: control.deny, privateTurn: () => control.private, reviewObserverInput: () => control.review,
    operational: by => by === "claude" && control.operational,
    piiScreen: async () => { control.screenCalls++; return { label: "clear", ms: 0 }; },
    executionLineage: { projectKey, cursorKey: "probe-control-key", readDelivery: () => { control.resolverCalls++; return undefined; } } };
  const tasks = new Tasks(deps); clean.push(() => tasks.stopGuidanceProbes());
  const registration = () => {
    const value = guidanceProbeFixture().registration, task = board.get(created.id)!;
    value.manifest.projectKey = projectKey; value.manifest.task = { id: task.id, created: task.created, flowRevision: task.history.length };
    value.manifest.role = { id: role.id, layer, baselineSha256: role.hash }; value.manifest.guidance.baselineSha256 = probeHash(taskRoleText(role));
    value.manifest.slots = [value.manifest.slots[0]!, value.manifest.slots[2]!];
    return value;
  };
  const variant = async () => {
    const task = board.get(created.id)!, scope = parseRoleDocument(bytes, role.id, layer).sections.find(item => item.name === "Scope")!;
    const candidate = bytes.slice(0, scope.contentStartUtf16) + "\nCandidate probe behavior is observable.\n\n" + bytes.slice(scope.endUtf16);
    const payload: GuidanceVariantPayloadV1 = { v: 1, projectKey, experimentId: "separate-owner-g1", taskId: task.id, taskCreated: task.created, flowRevision: task.history.length,
      author: USER, baseline: { roleId: role.id, layer, sha256: role.hash, bytes }, candidate: { sha256: probeHash(candidate), bytes: candidate },
      rationale: { problemHypothesis: "An observable case is absent.", expectedObservableDifference: "Reports name the case." }, evidenceRefs: [] };
    const value = { ...payload, id: guidanceVariantKey(payload) }; await tasks.guidanceVariantCreate(USER, value); return value;
  };
  return { cwd, file, board, store, bus, roles, roster, role, bytes, clock, control, dependency, tasks, provider, timer, messages, registration, variant, deps, projectKey, taskId: created.id };
}

test("Tasks private probe registration/show preserve public task bytes and production refuses before any selected-G1 read or reservation", async () => {
  const f = await fixture({ runner: false }), value = f.registration(), taskBefore = f.tasks.publicView(f.board.get(f.taskId)!);
  const registered = await f.tasks.guidanceProbeRegister(USER, value), key = { projectKey: f.projectKey, id: registered.id };
  expect(registered.evidence).toBe("declaration");
  const baseline = f.store.reserveSession({ key, expectedRevision: 0, host: f.store.read(key)!.binding, now: f.clock.now }, () => ({ host: f.store.read(key)!.binding }));
  if (baseline.kind !== "granted") throw new Error("expected seeded closed fixture baseline");
  f.store.settleSession({ reservation: baseline.reservation, outcome: "closed_fixture", candidateArtifactSha256: null, now: f.clock.now });
  let childReads = 0; const location = f.board.guidanceVariantLocation.bind(f.board);
  f.board.guidanceVariantLocation = (...args) => { childReads++; return location(...args); };
  const before = f.store.integrity();
  await expect(f.tasks.guidanceProbeStart(USER, registered.id, f.store.read(key)!.receipt.revision, probeHash("unused-child"))).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(childReads).toBe(0); expect(f.store.integrity()).toEqual(before); expect(f.timer.jobs.size).toBe(0);
  const shown = await f.tasks.guidanceProbeShow(USER, registered.id), publicJson = JSON.stringify(shown);
  expect(publicJson).not.toContain(value.snapshots.task); expect(publicJson).not.toContain(f.bytes); expect(publicJson).not.toContain("baselineGuidance");
  expect(f.tasks.publicView(f.board.get(f.taskId)!)).toEqual(taskBefore); expect(f.control.screenCalls).toBe(0); expect(f.control.resolverCalls).toBe(0); expect(f.messages).toHaveLength(0);
});

test("probe CLI authority labels and public replies stay closed, with the derived envelope cap", () => {
  expect(GUIDANCE_PROBE_REGISTRATION_BYTES).toBeGreaterThan(32_768);
  const registration = guidanceProbeFixture().registration;
  for (const key of ["task", "baselineContext", "systemPolicy"] as const) {
    const value = "x".repeat(20_000);
    registration.snapshots[key] = value;
    registration.manifest.inputs[key] = { sha256: probeHash(value), bytes: Buffer.byteLength(value) };
  }
  expect(Buffer.byteLength(JSON.stringify(registration))).toBeGreaterThan(32_768);
  expect(parseGuidanceProbeRegistration(registration)).toEqual(registration);
  expect(DAEMON_FEATURES).toContain("guidance_probes");
  for (const [sub, wire] of [["register", "guidance_probe_register"], ["start", "guidance_probe_start"], ["show", "guidance_probe_show"], ["cancel", "guidance_probe_cancel"]] as const) {
    expect(CONDUCTOR_DAEMON_OPERATIONS).toContain(`guidance probe ${sub}`);
    expect(conductorOperation("guidance", ["probe", sub])).toBe(`guidance probe ${sub}`);
    expect(classifyPeerCommand("guidance", ["probe", sub])).toBe("conductor");
    expect(operationalRequestLabel({ t: wire })).toBe(`guidance probe ${sub}`);
  }
  const receipt: ProbePublicReceipt = { id: "a".repeat(64), revision: 0, state: "declared", already: false, taskId: 1, experimentId: "probe", evidence: "declaration" };
  expect(parseGuidanceProbePublicReceipt(receipt)).toEqual(receipt);
  expect(parseGuidanceProbePublicReceipt({ ...receipt, actor: "user" })).toBeUndefined();
  const status: ProbePublicStatus = { ...receipt, counters: { workerAttempts: 0, editorAttempts: 0, modelCalls: 0, toolCalls: 0, tokensReserved: 0,
    tokensObservedKnown: 0, inputBytes: 0, scratchBytes: 0, outputBytes: 0, elapsedHighWaterMs: 0, usageUnknown: false },
    cancelRequested: false, notNeeded: 0, comparable: false, authoring: "unknown" };
  expect(parseGuidanceProbePublicStatus(status)).toEqual(status);
  expect(parseGuidanceProbePublicStatus({ ...status, counters: { ...status.counters, modelCalls: -1 } })).toBeUndefined();
});

test("probe CLI dispatch requires its explicit prefix and leaves guidance show to the existing parser", () => {
  const id = "a".repeat(64);
  expect(parseGuidanceProbeSubcommand(["show", "--id", id])).toBeUndefined();
  expect(parseGuidanceProbeSubcommand(["probe", "show", "--id", id])).toEqual({ op: "show", id, json: false });
  expect(() => parseGuidanceProbeSubcommand(["probe", "show", "--id", "bad"])).toThrow();
});

test("current person/conductor/session/private/review/task-state guards refuse before private writes", async () => {
  const f = await fixture(), value = f.registration(), before = f.store.integrity();
  await expect(f.tasks.guidanceProbeRegister("codex", value)).rejects.toBeInstanceOf(PreEffectToolRefusal);
  for (const by of [USER, "claude"]) {
    f.control.private = true; await expect(f.tasks.guidanceProbeRegister(by, value)).rejects.toBeInstanceOf(PreEffectToolRefusal); f.control.private = false;
    f.control.review = true; await expect(f.tasks.guidanceProbeRegister(by, value)).rejects.toBeInstanceOf(PreEffectToolRefusal); f.control.review = false;
  }
  f.control.operational = false; await expect(f.tasks.guidanceProbeRegister("claude", value)).rejects.toBeInstanceOf(PreEffectToolRefusal); f.control.operational = true;
  f.roster.delete("claude"); await expect(f.tasks.guidanceProbeRegister("claude", value)).rejects.toBeInstanceOf(PreEffectToolRefusal); f.roster.add("claude");
  f.roles.pi = ["conductor"]; await expect(f.tasks.guidanceProbeRegister("claude", value)).rejects.toBeInstanceOf(PreEffectToolRefusal); f.roles.pi = ["reviewer"];
  f.control.alive = false; await expect(f.tasks.guidanceProbeRegister(USER, value)).rejects.toThrow(); f.control.alive = true;
  expect(f.store.integrity()).toEqual(before);
  f.board.update(f.taskId, USER, "submitted", { state: "in_review" });
  await expect(f.tasks.guidanceProbeRegister(USER, f.registration())).rejects.toBeInstanceOf(PreEffectToolRefusal);
  f.board.update(f.taskId, USER, "changes_requested", { state: "changes_requested" });
  f.board.update(f.taskId, USER, "accepted", { state: "in_progress" });
  f.board.update(f.taskId, USER, "note", { signals: ["pii"] });
  await expect(f.tasks.guidanceProbeRegister(USER, f.registration())).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(f.store.integrity()).toEqual(before);
});

test("write-free input-budget registration refusal keeps its cause and creates no phantom id", async () => {
  const f = await fixture(), value = f.registration();
  value.manifest.limits.inputBytes = value.manifest.inputs.task.bytes + value.manifest.inputs.baselineContext.bytes
    + value.manifest.inputs.dataPolicy.bytes + value.manifest.inputs.systemPolicy.bytes;
  expect(parseGuidanceProbeRegistration(value)).toBeDefined();
  const before = f.store.integrity(), key = { projectKey: f.projectKey, id: guidanceProbeManifestKey(value.manifest) };
  const error = await f.tasks.guidanceProbeRegister(USER, value).then(() => undefined, error => error);
  expect(error).toBeInstanceOf(GuidanceProbeError); expect(error.reason).toBe("budget");
  expect(error.message).toContain("limits.inputBytes"); expect(error.message).not.toContain("unconfirmed");
  expect(f.store.read(key)).toBeUndefined(); expect(f.store.integrity()).toEqual(before);
});

test("stale and lane-held start refusals remain known and write-free", async () => {
  const f = await fixture(), receipt = await f.tasks.guidanceProbeRegister(USER, f.registration());
  const before = f.store.integrity();
  const stale = await f.tasks.guidanceProbeStart(USER, receipt.id, 999).then(() => undefined, error => error);
  expect(stale).toBeInstanceOf(GuidanceProbeError); expect(stale.reason).toBe("changed");
  expect(stale.message).not.toContain("unconfirmed"); expect(f.store.integrity()).toEqual(before); expect(f.provider.launches).toHaveLength(0);
  await f.tasks.guidanceProbeStart(USER, receipt.id, 0);
  const other = f.registration(); other.manifest.experimentId = "another-public-experiment";
  const registered = await f.tasks.guidanceProbeRegister(USER, other), heldBefore = f.store.integrity();
  const held = await f.tasks.guidanceProbeStart(USER, registered.id, 0).then(() => undefined, error => error);
  expect(held).toBeInstanceOf(GuidanceProbeError); expect(held.reason).toBe("held");
  expect(held.message).not.toContain("unconfirmed"); expect(f.store.integrity()).toEqual(heldBefore); expect(f.provider.launches).toHaveLength(1);
});

test("a post-reservation startup failure stays unconfirmed while preserving host no-launch evidence", async () => {
  const f = await fixture(), receipt = await f.tasks.guidanceProbeRegister(USER, f.registration());
  f.store.exposeLaunch = () => { throw new GuidanceProbeError("changed"); };
  await expect(f.tasks.guidanceProbeStart(USER, receipt.id, 0)).rejects.toThrow("guidance probe attempt outcome is unconfirmed");
  expect(f.provider.launches).toHaveLength(0);
  const session = f.store.read({ projectKey: f.projectKey, id: receipt.id })!.sessions[0]!;
  expect(session.state).toBe("failed_known"); expect(session.coverage.preLaunchFailure).toBe(true);
});

test("same live console session replays without launch while a new connection cannot borrow its original start", async () => {
  const f = await fixture(), receipt = await f.tasks.guidanceProbeRegister(USER, f.registration());
  await f.tasks.guidanceProbeStart(USER, receipt.id, 0);
  const before = f.store.integrity();
  expect((await f.tasks.guidanceProbeStart(USER, receipt.id, 0)).already).toBe(true); expect(f.provider.launches).toHaveLength(1);
  expect(f.store.integrity()).toEqual(before);
  f.control.connection = "host-console-connection-b";
  await expect(f.tasks.guidanceProbeStart(USER, receipt.id, 0)).rejects.toThrow();
  expect(f.provider.launches).toHaveLength(1); expect(f.store.integrity()).toEqual(before);
});

test("reopened Store replays only with a fresh current binding; a missing bridge cannot replay a retained start", async () => {
  const f = await fixture(), receipt = await f.tasks.guidanceProbeRegister(USER, f.registration());
  await f.tasks.guidanceProbeStart(USER, receipt.id, 0);
  const before = f.store.integrity(), reopened = new GuidanceProbeStore(f.file, () => f.clock.now); clean.push(() => reopened.close());
  const sameConnectionTasks = new Tasks({ ...f.deps, guidanceProbes: { ...f.dependency, store: reopened } });
  clean.push(() => sameConnectionTasks.stopGuidanceProbes());
  expect((await sameConnectionTasks.guidanceProbeStart(USER, receipt.id, 0)).already).toBe(true);
  expect(reopened.integrity()).toEqual(before); expect(f.provider.launches).toHaveLength(1);

  f.control.connection = "host-console-connection-after-reopen";
  await expect(sameConnectionTasks.guidanceProbeStart(USER, receipt.id, 0)).rejects.toBeInstanceOf(PreEffectToolRefusal);
  const noBridge = new Tasks({ ...f.deps, guidanceProbes: { store: reopened, fakePorts: f.provider } });
  clean.push(() => noBridge.stopGuidanceProbes());
  await expect(noBridge.guidanceProbeStart(USER, receipt.id, 0)).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(reopened.integrity()).toEqual(before); expect(f.provider.launches).toHaveLength(1);
});
test("same native conductor session preserves exact identity but a different request connection refuses replay", async () => {
  const f = await fixture(), receipt = await f.tasks.guidanceProbeRegister("claude", f.registration());
  const peer = f.bus.peers.get("claude")!, native = { generation: peer.sessionGeneration, nativeSession: peer.nativeSession };
  await f.tasks.guidanceProbeStart("claude", receipt.id, 0);
  expect((await f.tasks.guidanceProbeStart("claude", receipt.id, 0)).already).toBe(true);
  const before = f.store.integrity(); f.control.connection = "host-conductor-new-connection";
  expect({ generation: peer.sessionGeneration, nativeSession: peer.nativeSession }).toEqual(native);
  await expect(f.tasks.guidanceProbeStart("claude", receipt.id, 0)).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(f.store.integrity()).toEqual(before); expect(f.provider.launches).toHaveLength(1);
});

test("same-CAS duplicates during async worker preparation neither reserve an unframed slot nor borrow another connection", async () => {
  const f = await fixture(), registered = await f.tasks.guidanceProbeRegister("claude", f.registration());
  let ready!: () => void, release!: () => void;
  const preparing = new Promise<void>(resolve => { ready = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  clean.push(release);
  let preparations = 0;
  f.dependency.prepareWorkerFrame = async (state, _slot, guidance) => {
    preparations++; ready(); await gate;
    const { task, baselineContext, systemPolicy } = state.registration.snapshots;
    return { inputFrame: guidanceProbeWorkerFrame(task, baselineContext, systemPolicy, guidance),
      nonGuidanceInputSha256: guidanceProbeNonGuidanceInputHash(task, baselineContext, systemPolicy) };
  };
  const running = f.tasks.guidanceProbeStart("claude", registered.id, 0).then(value => ({ value }), error => { ready(); return { error }; });
  await preparing;
  const key = { projectKey: f.projectKey, id: registered.id }, before = f.store.integrity(), counters = f.store.read(key)!.counters;
  expect(counters.workerAttempts).toBe(0); expect(f.provider.launches).toHaveLength(0);
  const duplicate = await f.tasks.guidanceProbeStart("claude", registered.id, 0);
  expect(duplicate.already).toBe(true); expect(duplicate.state).toBe("declared"); expect(duplicate.evidence).toBe("declaration");
  expect(f.store.integrity()).toEqual(before); expect(f.store.read(key)!.counters).toEqual(counters); expect(preparations).toBe(1);
  await expect(f.tasks.guidanceProbeStart(USER, registered.id, 0)).rejects.toBeInstanceOf(PreEffectToolRefusal);
  const originalSession = f.dependency.session!;
  f.dependency.session = by => {
    const captured = originalSession(by);
    return captured && { ...captured, requestConnectionId: "separate-conductor-request-connection" };
  };
  try { await expect(f.tasks.guidanceProbeStart("claude", registered.id, 0)).rejects.toBeInstanceOf(PreEffectToolRefusal); }
  finally { f.dependency.session = originalSession; }
  expect(f.store.integrity()).toEqual(before); expect(f.store.read(key)!.counters.workerAttempts).toBe(0); expect(preparations).toBe(1);
  release(); const completed = await running;
  expect("value" in completed).toBe(true); expect(f.provider.launches).toHaveLength(1); expect(preparations).toBe(1);
  expect(f.store.read(key)!.counters.workerAttempts).toBe(1); expect(f.store.read(key)!.counters.modelCalls).toBe(1);
  expect(f.store.read(key)!.counters.inputBytes).toBe(counters.inputBytes + Buffer.byteLength(f.provider.launches[0]!.inputFrame));
  expect(f.store.read(key)!.sessions[0]!.state).toBe("closed_fixture"); expect(f.tasks.guidanceProbesPending()).toBe(0);
});

test("an ordinary delivered hub message preserves the admitted conductor probe and its next effect", async () => {
  const f = await fixture(), receipt = await f.tasks.guidanceProbeRegister("claude", f.registration());
  let ready!: () => void, release!: () => void, received!: () => void;
  const observed = new Promise<void>(resolve => { ready = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const delivered = new Promise<void>(resolve => { received = resolve; });
  clean.push(release);
  const peer = f.bus.peers.get("claude")!, beforeDelivery = f.bus.lastDeliveredTo("claude").map(item => item.id);
  peer.deliver = async () => { received(); };
  let nextEffect = false;
  f.provider.script = async (input, effects) => {
    const first = { sequence: 0, unit: "model_calls" as const, descriptorSha256: probeHash("before-ordinary-delivery"), reservedTokens: 20 };
    await effects.runEffect(first, async () => fakeEffectValue(first, "first fixture result", 5));
    ready(); await gate;
    const next = { sequence: 1, unit: "model_calls" as const, descriptorSha256: probeHash("after-ordinary-delivery"), reservedTokens: 20 };
    await effects.runEffect(next, async () => { nextEffect = true; return fakeEffectValue(next, "next fixture result", 5); });
    return { ...closed(input), usage: "known_fixture" };
  };
  const running = f.tasks.guidanceProbeStart("claude", receipt.id, 0).then(value => ({ value }), error => { ready(); return { error }; });
  await observed;
  const message = newEnvelope(HUB, "Ordinary public coordination update.", { to: ["claude"], priority: "important" });
  expect(f.bus.publish(message)).toEqual(["claude"]);
  await delivered;
  expect(f.bus.lastDeliveredTo("claude").map(item => item.id)).not.toEqual(beforeDelivery);
  release();
  const result = await running;
  expect("value" in result).toBe(true); expect(nextEffect).toBe(true);
  const state = f.store.read({ projectKey: f.projectKey, id: receipt.id })!;
  expect(state.admissionHold).toBe("none"); expect(state.sessions[0]!.state).toBe("closed_fixture");
  expect(state.counters.modelCalls).toBe(2); expect(state.counters.tokensObservedKnown).toBe(10);
  expect(f.provider.stops).toHaveLength(0); expect(f.tasks.guidanceProbesPending()).toBe(0);
});

for (const changed of ["role", "roster", "privacy"] as const) test(`an admitted conductor probe still refuses its next effect after ${changed} changes`, async () => {
  const f = await fixture(), receipt = await f.tasks.guidanceProbeRegister("claude", f.registration());
  let ready!: () => void, release!: () => void;
  const observed = new Promise<void>(resolve => { ready = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  clean.push(release);
  let nextEffect = false;
  f.provider.script = async (input, effects) => {
    const first = { sequence: 0, unit: "model_calls" as const, descriptorSha256: probeHash(`before-${changed}-change`), reservedTokens: 20 };
    await effects.runEffect(first, async () => fakeEffectValue(first, "first fixture result", 5));
    ready(); await gate;
    const next = { sequence: 1, unit: "model_calls" as const, descriptorSha256: probeHash(`after-${changed}-change`), reservedTokens: 20 };
    await effects.runEffect(next, async () => { nextEffect = true; return fakeEffectValue(next, "must not run", 5); });
    return { ...closed(input), usage: "known_fixture" };
  };
  const running = f.tasks.guidanceProbeStart("claude", receipt.id, 0).then(value => ({ value }), error => { ready(); return { error }; });
  await observed;
  const key = { projectKey: f.projectKey, id: receipt.id };
  expect(f.store.read(key)!.counters.modelCalls).toBe(1);
  if (changed === "role") f.roles.claude = ["implementer"];
  else if (changed === "roster") f.roster.delete("claude");
  else f.control.private = true;
  release();
  const result = await running;
  expect("error" in result).toBe(true); expect(nextEffect).toBe(false);
  expect(f.store.read(key)!.counters.modelCalls).toBe(1);
  expect(f.store.read(key)!.receipt.state).toBe("unknown_held");
  await f.tasks.stopGuidanceProbes();
  expect(f.tasks.guidanceProbesPending()).toBe(0);
});

test("ordinary G1 reads retain their strict delivered-input snapshot fence", async () => {
  const f = await fixture(), variant = await f.variant();
  const query = { taskId: variant.taskId, taskCreated: variant.taskCreated, experimentId: variant.experimentId, id: variant.id };
  expect(f.tasks.guidanceVariantRead("codex", query).state).toBe("available");
  const records = f.board.guidanceVariants.bind(f.board);
  let delivered = false;
  f.board.guidanceVariants = (...args) => {
    const current = records(...args);
    if (!delivered) {
      delivered = true;
      f.bus.publish(newEnvelope(HUB, "A new public G1 input context.", { to: ["codex"], priority: "important" }));
    }
    return current;
  };
  expect(f.tasks.guidanceVariantRead("codex", query)).toEqual({ state: "unavailable" });
  expect(delivered).toBe(true); expect(f.bus.lastDeliveredTo("codex")).toHaveLength(1);
});

test("real shipped G1 provenance stays private under unrelated deny while exact rendered private input refuses before binding", async () => {
  const f = await fixture({ shipped: true }), variant = await f.variant();
  expect(variant.baseline.bytes).toBe(SHIPPED_ROLES["test-engineer"]!); expect(f.role.source).toContain("agency-agents");
  f.control.deny.push("secrets/**");
  const receipt = await f.tasks.guidanceProbeRegister(USER, f.registration()), key = { projectKey: f.projectKey, id: receipt.id };
  await f.tasks.guidanceProbeStart(USER, receipt.id, 0);
  const before = f.store.integrity(); f.control.patterns.push("Candidate probe behavior");
  await expect(f.tasks.guidanceProbeStart(USER, receipt.id, f.store.read(key)!.receipt.revision, variant.id)).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(f.store.integrity()).toEqual(before); expect(f.provider.launches).toHaveLength(1);
  f.control.patterns.length = 0;
  await f.tasks.guidanceProbeStart(USER, receipt.id, f.store.read(key)!.receipt.revision, variant.id);
  expect(f.provider.launches).toHaveLength(2); expect(JSON.parse(f.provider.launches[1]!.inputFrame).guidance).toContain("Candidate probe behavior");
  const publicJson = JSON.stringify(await f.tasks.guidanceProbeShow(USER, receipt.id));
  expect(publicJson).not.toContain(f.role.source); expect(publicJson).not.toContain("agency-agents"); expect(publicJson).not.toContain(variant.candidate.bytes);
  expect(f.control.screenCalls).toBe(0); expect(f.control.resolverCalls).toBe(0); expect(f.messages).toHaveLength(0);
});
test("source-owned G1 withdrawal before lock refuses; withdrawal under the probe writer lock is busy and cannot stale-grant", async () => {
  const f = await fixture(), variant = await f.variant(), receipt = await f.tasks.guidanceProbeRegister(USER, f.registration());
  await f.tasks.guidanceProbeStart(USER, receipt.id, 0);
  const key = { projectKey: f.projectKey, id: receipt.id }, otherBoard = new Board(f.file); clean.push(() => otherBoard.close());
  const otherTasks = new Tasks({ ...f.deps, board: otherBoard }); clean.push(() => otherTasks.stopGuidanceProbes());
  const original = f.board.guidanceVariants.bind(f.board), db = (f.store as unknown as { db: { inTransaction: boolean } }).db;
  let attempted = false, outcome: Promise<{ error?: unknown; unexpected?: boolean }> | undefined;
  f.board.guidanceVariants = (...args) => {
    const records = original(...args);
    if (db.inTransaction && !attempted) {
      attempted = true;
      outcome = otherTasks.guidanceVariantWithdraw(USER, { taskId: variant.taskId, taskCreated: variant.taskCreated, experimentId: variant.experimentId, id: variant.id, flowRevision: variant.flowRevision })
        .then(() => ({ unexpected: true }), error => ({ error }));
    }
    return records;
  };
  await f.tasks.guidanceProbeStart(USER, receipt.id, f.store.read(key)!.receipt.revision, variant.id);
  expect(attempted).toBe(true); expect(outcome).toBeDefined();
  const withdrawn = await outcome!; expect(withdrawn?.unexpected).toBeUndefined(); expect(withdrawn?.error).toBeInstanceOf(Error); expect(withdrawn?.error).not.toBeInstanceOf(PreEffectToolRefusal);
  expect(f.board.guidanceVariants(f.projectKey, variant.taskId, variant.taskCreated, variant.experimentId)[0]!.withdrawn).toBeUndefined();
  expect(f.provider.launches).toHaveLength(2);
  const g = await fixture(), late = await g.variant(), registered = await g.tasks.guidanceProbeRegister(USER, g.registration());
  await g.tasks.guidanceProbeStart(USER, registered.id, 0);
  await g.tasks.guidanceVariantWithdraw(USER, { taskId: late.taskId, taskCreated: late.taskCreated, experimentId: late.experimentId, id: late.id, flowRevision: late.flowRevision });
  const gKey = { projectKey: g.projectKey, id: registered.id }, before = g.store.integrity();
  await expect(g.tasks.guidanceProbeStart(USER, registered.id, g.store.read(gKey)!.receipt.revision, late.id)).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(g.store.integrity()).toEqual(before); expect(g.provider.launches).toHaveLength(1);
});

test("zero timer handle is cleared; stale retired watchdog writes nothing", async () => {
  const f = await fixture(), receipt = await f.tasks.guidanceProbeRegister(USER, f.registration());
  let stale: (() => void) | undefined;
  const launch = f.provider.launch.bind(f.provider);
  f.provider.launch = async (input, effects, signal) => { stale = f.timer.jobs.get(0)?.callback; return launch(input, effects, signal); };
  await f.tasks.guidanceProbeStart(USER, receipt.id, 0);
  expect(f.timer.cleared).toContain(0); expect(f.timer.jobs.size).toBe(0); expect(f.tasks.guidanceProbesPending()).toBe(0);
  expect(stale).toBeDefined(); if (!stale) throw new Error("expected captured watchdog");
  const before = f.store.integrity(); stale(); expect(f.store.integrity()).toEqual(before);
});

test("noncooperative owned launch rejects the named drain bound, retains handles, then explicitly drains after release", async () => {
  const f = await fixture(), receipt = await f.tasks.guidanceProbeRegister(USER, f.registration());
  let ready!: () => void, release!: () => void;
  const observed = new Promise<void>(resolve => { ready = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.provider.script = async input => { ready(); await gate; return closed(input); };
  clean.push(release);
  const running = f.tasks.guidanceProbeStart(USER, receipt.id, 0).then(value => ({ value }), error => { ready(); return { error }; });
  await observed;
  const stopping = f.tasks.stopGuidanceProbes().then(() => ({ stopped: true }), error => ({ error }));
  f.clock.now += GUIDANCE_PROBE_STOP_TIMEOUT_MS;
  f.timer.fireDelay(GUIDANCE_PROBE_STOP_TIMEOUT_MS);
  const result = await stopping; expect("error" in result).toBe(true); expect(f.tasks.guidanceProbesPending()).toBeGreaterThan(0);
  expect(f.store.read({ projectKey: f.projectKey, id: receipt.id })!.receipt.state).toBe("unknown_held");
  release(); await running; await f.tasks.stopGuidanceProbes();
  expect(f.tasks.guidanceProbesPending()).toBe(0); expect(f.timer.jobs.size).toBe(0);
  expect(f.store.read({ projectKey: f.projectKey, id: receipt.id })!.admissionHold).not.toBe("none");
});

test("port settlement joins a fire-and-forget effect callback before session settlement and shutdown drain", async () => {
  const f = await fixture(), receipt = await f.tasks.guidanceProbeRegister(USER, f.registration());
  let effectStarted!: () => void, release!: () => void, portSettled!: () => void;
  const started = new Promise<void>(resolve => { effectStarted = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const settled = new Promise<void>(resolve => { portSettled = resolve; });
  clean.push(release);
  let portEffects!: ProbeFakeEffects;
  const launch = f.provider.launch.bind(f.provider);
  f.provider.launch = (input, effects, signal) => launch(input, effects, signal).then(observation => {
    queueMicrotask(portSettled); return observation;
  });
  const request = { sequence: 0, unit: "model_calls" as const, descriptorSha256: probeHash("port-returned-effect"), reservedTokens: 20 };
  f.provider.script = async (input, effects) => {
    portEffects = effects;
    // The port intentionally returns without awaiting its still-owned callback.
    void effects.runEffect(request, async () => {
      effectStarted(); await gate; return fakeEffectValue(request, "late fixture result", 5);
    });
    return closed(input);
  };
  const running = f.tasks.guidanceProbeStart(USER, receipt.id, 0).then(value => ({ value }), error => ({ error }));
  await started; await settled;
  const key = { projectKey: f.projectKey, id: receipt.id };
  expect(f.store.read(key)!.sessions[0]!.state).toBe("running");
  let lateCallback = false;
  const beforeLateCall = f.store.integrity();
  const lateRequest = { sequence: 1, unit: "model_calls" as const, descriptorSha256: probeHash("effect-after-port-settlement"), reservedTokens: 20 };
  await expect(portEffects.runEffect(lateRequest, async () => {
    lateCallback = true; return fakeEffectValue(lateRequest, "must not run", 1);
  })).rejects.toThrow();
  expect(lateCallback).toBe(false); expect(f.store.integrity()).toEqual(beforeLateCall);
  const stopping = f.tasks.stopGuidanceProbes().then(() => ({ stopped: true }), error => ({ error }));
  f.clock.now += GUIDANCE_PROBE_STOP_TIMEOUT_MS;
  f.timer.fireDelay(GUIDANCE_PROBE_STOP_TIMEOUT_MS);
  const drained = await stopping;
  expect("error" in drained).toBe(true); expect(f.tasks.guidanceProbesPending()).toBeGreaterThan(0);
  expect(f.store.read(key)!.receipt.state).toBe("unknown_held");
  release(); await running; await f.tasks.stopGuidanceProbes();
  expect(f.tasks.guidanceProbesPending()).toBe(0);
  expect(f.store.read(key)!.sessions[0]!.state).toBe("unknown_held");
});

test("an unknown launch receipt owns stop; unknown stop evidence retains the active-map handle", async () => {
  const f = await fixture(), receipt = await f.tasks.guidanceProbeRegister(USER, f.registration());
  const request = { sequence: 0, unit: "model_calls" as const, descriptorSha256: probeHash("unknown-launch-observation"), reservedTokens: 20 };
  f.provider.script = async (input, effects) => {
    await effects.runEffect(request, async () => fakeEffectValue(request, "fixture result", 5));
    return { ...closed(input), outcome: "unknown", usage: "unknown" };
  };
  let stops = 0;
  const fakePorts: GuidanceProbeFakePorts = {
    launch: (input, effects, signal) => f.provider.launch(input, effects, signal),
    stop: async input => ({ reservation: input.reservation, stopped: ++stops === 1 ? "unknown" : "known_fixture" }),
  };
  f.dependency.fakePorts = fakePorts;
  await expect(f.tasks.guidanceProbeStart(USER, receipt.id, 0)).rejects.toThrow("guidance probe attempt outcome is unconfirmed");
  const key = { projectKey: f.projectKey, id: receipt.id };
  expect(stops).toBe(1); expect(f.tasks.guidanceProbesPending()).toBe(1);
  expect(f.store.read(key)!.receipt.state).toBe("unknown_held");
  await f.tasks.stopGuidanceProbes();
  expect(stops).toBe(2); expect(f.tasks.guidanceProbesPending()).toBe(0);
  expect(f.store.read(key)!.receipt.state).toBe("unknown_held");
});
test("cancel after G1 withdrawal/flow change preserves intent without rescreening stored prose and drains only its owned fake handle", async () => {
  const f = await fixture(), variant = await f.variant(), receipt = await f.tasks.guidanceProbeRegister(USER, f.registration()), key = { projectKey: f.projectKey, id: receipt.id };
  await f.tasks.guidanceProbeStart(USER, receipt.id, 0);
  let ready!: () => void, release!: () => void, stopped!: () => void;
  const observed = new Promise<void>(resolve => { ready = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const stopObserved = new Promise<void>(resolve => { stopped = resolve; });
  f.provider.script = async input => { ready(); await gate; return closed(input); };
  const originalStop = f.provider.stop.bind(f.provider);
  f.provider.stop = async input => { const result = await originalStop(input); stopped(); return result; };
  clean.push(release);
  const running = f.tasks.guidanceProbeStart(USER, receipt.id, f.store.read(key)!.receipt.revision, variant.id).then(value => ({ value }), error => { ready(); return { error }; });
  await observed;
  await f.tasks.guidanceVariantWithdraw(USER, { taskId: variant.taskId, taskCreated: variant.taskCreated, experimentId: variant.experimentId, id: variant.id, flowRevision: variant.flowRevision });
  f.board.update(f.taskId, USER, "note", {}, "later public task flow"); f.control.patterns.push("Candidate probe behavior");
  const cancel = f.tasks.guidanceProbeCancel(USER, receipt.id, f.store.read(key)!.receipt.revision).then(value => ({ value }), error => ({ error }));
  await stopObserved;
  expect(f.store.read(key)!.cancelRequested).toBe(true); expect(f.provider.stops).toEqual(["candidate1"]);
  release(); await running; const result = await cancel; expect("value" in result).toBe(true);
  expect(f.store.read(key)!.cancelRequested).toBe(true); expect(f.store.read(key)!.receipt.state).toBe("unknown_held");
  expect(f.tasks.guidanceProbesPending()).toBe(0); expect(f.timer.jobs.size).toBe(0);
});

test("a session the host could not witness is sealed unknown, and is never public-comparable (T3, #1226)", async () => {
  const f = await fixture(), receipt = await f.tasks.guidanceProbeRegister(USER, f.registration()), key = { projectKey: f.projectKey, id: receipt.id };
  await f.tasks.guidanceProbeStart(USER, receipt.id, 0);
  const shown = await f.tasks.guidanceProbeShow(USER, receipt.id);
  expect(shown.comparable).toBe(false);
  // The fake provider reports no host measurement, so the host seals its conservative one in the same transaction as the settlement: the session is in the
  // denominator as unknown (teardown not witnessed), never as a success.
  const outcome = f.store.outcome(key)!;
  expect(f.store.receipts(key)).toHaveLength(1);
  expect(f.store.receipts(key)[0]).toMatchObject({ state: "unknown", slotId: "baseline" });
  expect(outcome.comparability.reasons).toContain("teardown_unverified");
  expect(outcome.counts.unknown).toBe(1); expect(outcome.counts.succeeded).toBe(0);
  // The public view carries neither the reasons nor the denominator.
  expect(JSON.stringify(shown)).not.toContain("teardown_unverified");
  expect(Object.keys(shown)).not.toContain("counts");
});
