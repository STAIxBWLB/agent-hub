import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board } from "../../src/hub/board.ts";
import { Bus } from "../../src/hub/bus.ts";
import { Tasks, type TasksDeps } from "../../src/hub/tasks.ts";
import { BasePeer } from "../../src/hub/peers.ts";
import { USER } from "../../src/hub/envelope.ts";
import { loadRouting } from "../../src/hub/routing.ts";
import { parseRole, parseRoleDocument, taskRoleText } from "../../src/hub/roles.ts";
import { SHIPPED_ROLES } from "../../src/hub/shipped-roles.ts";
import { guidanceVariantKey, type GuidanceVariantPayloadV1 } from "../../src/hub/guidance-variants.ts";
import { GuidanceProbeStore } from "../../src/hub/guidance-probe-store.ts";
import { GUIDANCE_PROBE_MODEL, probeHash, probeSessionGeneration, type ProbeFakeLaunch, type ProbeFakeObservation, type ProbeMeasuredSession } from "../../src/hub/guidance-probes.ts";
import { FakeGuidanceProbeProvider, fakeEffectValue, guidanceProbeFixture } from "../fakes/guidance-probe-provider.ts";
import vectors from "../fixtures/guidance-variant-v1.json";

// The real Tasks + Store + Bus fixture of the probe control tests, shared so the status and gate tests drive the same composition instead of a fork of it.
export class Peer extends BasePeer {
  sessionGeneration = "actual-peer-generation";
  nativeSession = "actual-native-session";
  async start() { this.setState("idle"); }
  async stop() {}
  async deliver() {}
}
export class Timer {
  next = 0;
  readonly jobs = new Map<number, { callback: () => void; ms: number }>();
  readonly cleared: unknown[] = [];
  set = (callback: () => void, ms: number): unknown => { const id = this.next++; this.jobs.set(id, { callback, ms }); return id; };
  clear = (handle: unknown): void => { this.cleared.push(handle); if (typeof handle === "number") this.jobs.delete(handle); };
  fire(id: number): void { const job = this.jobs.get(id); if (!job) throw new Error("expected scheduled callback"); this.jobs.delete(id); job.callback(); }
  fireDelay(ms: number): void { const job = [...this.jobs].find(([, job]) => job.ms === ms); if (!job) throw new Error("expected named timer bound"); this.fire(job[0]); }
}
export async function probeTasksFixture(clean: (() => unknown | Promise<unknown>)[], options: { shipped?: boolean; runner?: boolean } = {}) {
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

/** A matched observation that carries the host's own measurement, so a receipt can be a real success. */
export function witnessedProbe(f: Awaited<ReturnType<typeof probeTasksFixture>>, over: Partial<Omit<ProbeMeasuredSession, "startedAt">> = {}) {
  const runtime = guidanceProbeFixture().registration.manifest.runtime;
  return async (input: ProbeFakeLaunch, effects: Parameters<typeof f.provider.launch>[1]): Promise<ProbeFakeObservation> => {
    const request = { sequence: 0, unit: "model_calls" as const, descriptorSha256: probeHash(`call-${input.slot.id}`), reservedTokens: 20 };
    await effects.runEffect(request, async () => fakeEffectValue(request, "ok", 10));
    return { reservation: input.reservation, outcome: "closed_fixture", servedModel: GUIDANCE_PROBE_MODEL, inputFrameHash: input.inputSha256,
      workerEffectiveInputHash: input.slot.role === "worker" ? input.inputSha256 : null, nonGuidanceInputSha256: input.slot.role === "worker" ? input.nonGuidanceInputSha256 : null,
      candidateArtifactSha256: null, usage: "known_fixture",
      measured: { servedModel: GUIDANCE_PROBE_MODEL, workerEffectiveInputSha256: input.slot.role === "worker" ? input.inputSha256 : null,
        nonGuidanceInputSha256: input.slot.role === "worker" ? input.nonGuidanceInputSha256 : null,
        runtime: { runtimeSha256: runtime.runtimeSha256, toolsetSha256: runtime.toolsetSha256, modelConfigSha256: runtime.modelConfigSha256 },
        teardownVerified: true, cancelled: false, timedOut: false, unavailable: false, limits: [], scratchBytes: 0,
        output: { v: 1, entries: [], excluded: [], totalBytes: 0 }, ...over } };
  };
}
/** Register and run the baseline, then the candidate, through the real Tasks lifecycle. */
export async function runProbeExperiment(f: Awaited<ReturnType<typeof probeTasksFixture>>, script?: (input: ProbeFakeLaunch) => Partial<Omit<ProbeMeasuredSession, "startedAt">>) {
  const receipt = await f.tasks.guidanceProbeRegister(USER, f.registration());
  f.provider.script = (input, effects) => witnessedProbe(f, script?.(input) ?? {})(input, effects);
  await f.tasks.guidanceProbeStart(USER, receipt.id, 0);
  const variant = await f.variant();
  await f.tasks.guidanceProbeStart(USER, receipt.id, f.store.read({ projectKey: f.projectKey, id: receipt.id })!.receipt.revision, variant.id);
  return { id: receipt.id, key: { projectKey: f.projectKey, id: receipt.id } };
}

