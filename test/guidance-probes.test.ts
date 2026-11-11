import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openHubDatabase, type Database } from "../src/hub/db-schema.ts";
import { parseGuidanceVariantV1, renderGuidanceVariantV1 } from "../src/hub/guidance-variants.ts";
import { parseRole, taskRoleText } from "../src/hub/roles.ts";
import vectors from "./fixtures/guidance-variant-v1.json";
import { GuidanceProbeFixtureHost, GuidanceProbeStore } from "../src/hub/guidance-probe-store.ts";
import { GUIDANCE_PROBE_LIMITS, GUIDANCE_PROBE_REGISTRATION_BYTES, GUIDANCE_PROBE_SESSION_BYTES, GUIDANCE_PROBE_MODEL, GuidanceProbeError, guidanceProbeCanonical, guidanceProbeManifestKey, guidanceProbeWorkerFrame,
  parseGuidanceProbeCommand, parseGuidanceProbeManifest, parseGuidanceProbeRegistration, probeHash,
  type ProbeReservation, type ProbeEffectAdmission, type ProbeChildBinding, type ProbeFakeObservation } from "../src/hub/guidance-probes.ts";
import { FakeGuidanceProbeProvider, fakeEffectValue, guidanceProbeFixture, guidanceProbeFixtureKey } from "./fakes/guidance-probe-provider.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ahub-guidance-probe-")), file = join(directory, "hub.db");
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const clock = { now: 100 };
  const store = new GuidanceProbeStore(file, () => clock.now); cleanup.push(() => store.close());
  const source = guidanceProbeFixture(), key = guidanceProbeFixtureKey(source.registration);
  const revalidate = () => ({ host: source.host });
  const register = () => store.register(source.registration, source.host, () => source.host);
  const reserve = (now = 100) => {
    const result = store.reserveSession({ key, expectedRevision: store.read(key)!.receipt.revision, host: source.host, now }, revalidate);
    expect(result.kind).toBe("granted"); if (result.kind !== "granted") throw new Error("expected fixture reservation"); return result.reservation;
  };
  const effect = (reservation: ProbeReservation, sequence = 0): ProbeEffectAdmission => ({ reservation, sequence, unit: "model_calls", amount: 1, reservedTokens: 20, descriptorSha256: probeHash(`call-${sequence}`), now: 100 });
  const usage = (admission: ProbeEffectAdmission, observed: number | null) => store.recordUsage({ admission, observed, observationSha256: probeHash(guidanceProbeCanonical({ admission, observed })) });
  const finish = (reservation: ProbeReservation, artifact: string | null = null) => store.settleSession({ reservation, outcome: "closed_fixture", candidateArtifactSha256: artifact, now: 100 });
  return { ...source, directory, file, store, key, clock, register, reserve, revalidate, effect, usage, finish };
}
const copy = <T>(value: T): T => structuredClone(value);

describe("guidance probe V1 inert contract", () => {
  test("retains code, CR/LF/TAB and exact native SHA-1 tree rather than recasting it", () => {
    const { registration } = guidanceProbeFixture();
    expect(parseGuidanceProbeRegistration(registration)).toEqual(registration);
    expect(registration.snapshots.task).toContain("\r\nconst value = 1;\t");
    const changed = copy(registration.manifest); changed.inputs.codeTree = { objectFormat: "sha256", oid: "b".repeat(64) };
    expect(parseGuidanceProbeManifest(changed)).toEqual(changed);
    changed.inputs.codeTree.oid = "b".repeat(40); expect(parseGuidanceProbeManifest(changed)).toBeUndefined();
  });
  test("full exact model literal, explicit hash length and closed keys", () => {
    for (const model of ["qwen3.8-27b", "qwen27b", `${GUIDANCE_PROBE_MODEL}\n`, "other/model"]) {
      const { registration } = guidanceProbeFixture(); registration.manifest.model.requested = model as typeof GUIDANCE_PROBE_MODEL;
      expect(parseGuidanceProbeManifest(registration.manifest)).toBeUndefined();
    }
    const { registration } = guidanceProbeFixture(); registration.manifest.role.baselineSha256 += "\n";
    expect(parseGuidanceProbeManifest(registration.manifest)).toBeUndefined();
    const value = guidanceProbeFixture().registration.manifest;
    expect(parseGuidanceProbeManifest({ ...value, runner: "native" })).toBeUndefined();
    expect(parseGuidanceProbeManifest({ ...value, limits: { ...value.limits, actor: "user" } })).toBeUndefined();
  });
  test("does not invoke getters, proxy traps, toJSON or custom array iterators", () => {
    const { registration } = guidanceProbeFixture(); let calls = 0;
    const getter = { ...registration.manifest }; Object.defineProperty(getter, "task", { enumerable: true, get() { calls++; return registration.manifest.task; } });
    expect(parseGuidanceProbeManifest(getter)).toBeUndefined();
    expect(parseGuidanceProbeManifest(new Proxy(registration.manifest, { ownKeys() { calls++; return []; } }))).toBeUndefined();
    expect(parseGuidanceProbeManifest({ ...registration.manifest, toJSON() { calls++; return registration.manifest; } })).toBeUndefined();
    const slots = [...registration.manifest.slots]; Object.defineProperty(slots, Symbol.iterator, { value() { calls++; return [][Symbol.iterator](); } });
    expect(parseGuidanceProbeManifest({ ...registration.manifest, slots })).toBeUndefined(); expect(calls).toBe(0);
  });
  test("nonenumerable envelope, sparse slots, invalid policy membership and path traversal refuse", () => {
    const { registration } = guidanceProbeFixture();
    const hidden = { manifest: registration.manifest }; Object.defineProperty(hidden, "snapshots", { value: registration.snapshots });
    expect(parseGuidanceProbeRegistration(hidden)).toBeUndefined();
    const slots = [...registration.manifest.slots]; delete slots[1]; expect(parseGuidanceProbeManifest({ ...registration.manifest, slots })).toBeUndefined();
    for (const relative of ["../outside", "/absolute", "a//b", "a/./b", "a\\b"]) {
      const value = copy(registration); value.snapshots.dataPolicy.allowedWrites = [{ root: "output", relative }];
      expect(parseGuidanceProbeRegistration(value)).toBeUndefined();
    }
    const value = copy(registration); value.snapshots.dataPolicy.roles.worker.dataIds = ["missing"];
    expect(parseGuidanceProbeRegistration(value)).toBeUndefined();
  });
  test("per-snapshot byte ceiling, paired improver context and immutable content key", () => {
    const { registration } = guidanceProbeFixture(), value = copy(registration);
    value.snapshots.task = "a".repeat(GUIDANCE_PROBE_LIMITS.snapshotBytes);
    value.manifest.inputs.task = { sha256: probeHash(value.snapshots.task), bytes: Buffer.byteLength(value.snapshots.task) };
    expect(parseGuidanceProbeRegistration(value)).toBeDefined();
    value.snapshots.task += "a"; value.manifest.inputs.task = { sha256: probeHash(value.snapshots.task), bytes: Buffer.byteLength(value.snapshots.task) };
    expect(parseGuidanceProbeRegistration(value)).toBeUndefined();
    const paired = copy(registration); paired.manifest.improverContextHash = probeHash("experience");
    expect(parseGuidanceProbeRegistration(paired)).toBeUndefined();
    paired.manifest.improverContextBytes = Buffer.byteLength("experience"); paired.snapshots.improverContext = "experience";
    expect(parseGuidanceProbeRegistration(paired)).toEqual(paired);
    expect(guidanceProbeManifestKey(registration.manifest)).toBe(guidanceProbeManifestKey(copy(registration.manifest)));
    expect(guidanceProbeManifestKey(paired.manifest)).not.toBe(guidanceProbeManifestKey(registration.manifest));
  });
  test("safe aggregate storage and fixed stage/role caps", () => {
    const { registration } = guidanceProbeFixture(), value = copy(registration.manifest);
    value.limits.inputBytes = Number.MAX_SAFE_INTEGER; expect(parseGuidanceProbeManifest(value)).toBeUndefined();
    value.limits.inputBytes = 0; value.limits.scratchBytes = GUIDANCE_PROBE_LIMITS.storageBytes; value.limits.outputBytes = 0;
    expect(parseGuidanceProbeManifest(value)).toBeDefined();
    value.slots = [...value.slots, { id: "extra", role: "reflect", arm: "none", stage: "reflect", retryOf: "reflect" }];
    expect(parseGuidanceProbeManifest(value)).toBeUndefined();
  });
  test("zero-editor baseline/preexisting candidates and successor are admitted without invented authoring", () => {
    const value = guidanceProbeFixture().registration.manifest;
    value.slots = [value.slots[0]!, value.slots[2]!, { id: "candidate2", stage: "candidate2", role: "worker", arm: "candidate2" },
      { id: "successor", stage: "successor", role: "worker", arm: "successor" }];
    expect(parseGuidanceProbeManifest(value)).toEqual(value);
    value.slots = [value.slots[0]!]; expect(parseGuidanceProbeManifest(value)).toBeUndefined();
  });
  test("combined maximum multiline/Unicode snapshots exceed 32KiB legitimately and remain bounded on hydration", () => {
    const f = fixture(), cap = GUIDANCE_PROBE_LIMITS.snapshotBytes;
    f.registration.snapshots.task = "\n".repeat(cap);
    f.registration.snapshots.baselineContext = "\\\"".repeat(cap / 2);
    f.registration.snapshots.systemPolicy = "한".repeat(Math.floor(cap / Buffer.byteLength("한"))) + "ab";
    f.registration.snapshots.improverContext = "😀".repeat(cap / Buffer.byteLength("😀"));
    for (const name of ["task", "baselineContext", "systemPolicy"] as const) {
      const text = f.registration.snapshots[name]; f.registration.manifest.inputs[name] = { sha256: probeHash(text), bytes: Buffer.byteLength(text) };
      expect(Buffer.byteLength(text)).toBe(cap);
    }
    f.registration.manifest.improverContextHash = probeHash(f.registration.snapshots.improverContext);
    f.registration.manifest.improverContextBytes = Buffer.byteLength(f.registration.snapshots.improverContext);
    const bytes = Buffer.byteLength(JSON.stringify(f.registration)); expect(bytes).toBeGreaterThan(cap); expect(bytes).toBeLessThanOrEqual(GUIDANCE_PROBE_REGISTRATION_BYTES);
    expect(parseGuidanceProbeRegistration(f.registration)).toEqual(f.registration);
    const key = guidanceProbeFixtureKey(f.registration); f.store.register(f.registration, f.host, () => f.host);
    expect(f.store.read(key)!.registration).toEqual(f.registration); expect(f.store.integrity().experiments).toBe(1);
    f.registration.snapshots.task += "\n";
    expect(parseGuidanceProbeRegistration(f.registration)).toBeUndefined();
  });
  test("worker frame excludes host identity, arm ids and frozen editor experience", () => {
    const value = guidanceProbeFixture();
    const frame = guidanceProbeWorkerFrame(value.registration.snapshots.task, value.registration.snapshots.baselineContext, value.registration.snapshots.systemPolicy, value.host.baselineGuidance);
    expect(JSON.parse(frame)).toEqual({ task: value.registration.snapshots.task, baselineContext: value.registration.snapshots.baselineContext, systemPolicy: value.registration.snapshots.systemPolicy, guidance: value.host.baselineGuidance });
    expect(frame).not.toContain(value.host.nativeSession!); expect(frame).not.toContain(value.registration.manifest.experimentId);
    expect(probeHash(frame)).not.toBe(probeHash("editor experience"));
  });
  test("CLI is closed and does not parse runner/actor or normalize ids", () => {
    const id = "a".repeat(64), variant = "b".repeat(64);
    expect(parseGuidanceProbeCommand(["start", "--id", id, "--revision", "0", "--variant", variant])).toEqual({ op: "start", id, revision: 0, variantId: variant, json: false });
    for (const args of [["show", "--id", `${id}\n`], ["start", "--id", id, "--revision", "01"], ["register", "--file", "fixture.json", "--runner", "native"], ["show", "--id", id, "--actor", "user"]]) expect(parseGuidanceProbeCommand(args)).toBeUndefined();
  });
});

describe("guidance probe private atomic ledger", () => {
  test("inert registration/idempotence and same experiment changed manifest cannot reset budgets", () => {
    const f = fixture(); const first = f.register(); expect(first.state).toBe("declared"); expect(f.register()).toEqual({ ...first, already: true });
    const changed = copy(f.registration); changed.manifest.limits.modelCalls++;
    expect(() => f.store.register(changed, f.host, () => f.host)).toThrow("binding");
    expect(f.store.read(f.key)!.counters.workerAttempts).toBe(0);
    expect(f.store.integrity().experiments).toBe(1);
  });
  test("original start selector replays reserved work without another grant or metadata write", () => {
    const f = fixture(); f.register(); f.reserve(); const before = f.store.integrity();
    expect(f.store.startSelector(f.key, 0)).toEqual({ requestedRevision: 0, slotId: "baseline", variantId: null, inputFrameSha256: null, inputFrameBytes: 0, actor: f.host.actor,
      sessionGeneration: f.host.sessionGeneration, nativeSession: f.host.nativeSession, requestConnectionId: f.host.requestConnectionId });
    expect(f.store.reserveSession({ key: f.key, expectedRevision: 0, host: f.host, now: 999999 }, f.revalidate)).toMatchObject({ kind: "existing", receipt: { already: true } });
    expect(f.store.integrity()).toEqual(before); expect(f.store.read(f.key)!.counters.workerAttempts).toBe(1);
    expect(JSON.stringify(f.store.startSelector(f.key, 0))).not.toContain(f.registration.snapshots.task);
  });
  test("atomically charges exact input frame bytes, rejects cumulative overage, and does not charge replay twice", () => {
    const f = fixture(), frame = "exact host-prepared frame", bytes = Buffer.byteLength(frame);
    const baseBytes = Buffer.byteLength(f.registration.snapshots.task) + Buffer.byteLength(f.registration.snapshots.baselineContext)
      + Buffer.byteLength(guidanceProbeCanonical(f.registration.snapshots.dataPolicy)) + Buffer.byteLength(f.registration.snapshots.systemPolicy)
      + Buffer.byteLength(f.host.baselineGuidance);
    f.registration.manifest.limits.inputBytes = baseBytes + bytes;
    const key = guidanceProbeFixtureKey(f.registration); f.store.register(f.registration, f.host, () => f.host);
    const descriptor = { slotId: "baseline", sha256: probeHash(frame), bytes };
    const first = f.store.reserveSession({ key: key, expectedRevision: 0, host: f.host, preparedFrame: descriptor, now: 100 }, f.revalidate);
    expect(first.kind).toBe("granted"); if (first.kind !== "granted") throw new Error("expected fixture reservation");
    const charged = f.store.read(key)!.counters.inputBytes;
    expect(charged).toBe(baseBytes + bytes);
    expect(f.store.reserveSession({ key: key, expectedRevision: 0, host: f.host, preparedFrame: descriptor, now: 100 }, f.revalidate)).toMatchObject({ kind: "existing" });
    expect(f.store.read(key)!.counters.inputBytes).toBe(charged);
    f.store.settleSession({ reservation: first.reservation, outcome: "closed_fixture", candidateArtifactSha256: null, now: 100 });
    expect(() => f.store.reserveSession({ key: key, expectedRevision: f.store.read(key)!.receipt.revision, host: f.host,
      preparedFrame: { slotId: "proposal1", sha256: probeHash(frame), bytes }, now: 100 }, f.revalidate)).toThrow("budget");
    expect(f.store.read(key)!.counters.inputBytes).toBe(charged);
  });
  test("exact original start replays after multiple effects, closed session and reopen without a second launch", async () => {
    const f = fixture(); f.register(); const provider = new FakeGuidanceProbeProvider();
    let ready!: () => void, release!: () => void;
    const observed = new Promise<void>(resolve => { ready = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    provider.script = async (input, callbacks) => {
      for (let sequence = 0; sequence < 2; sequence++) {
        const request = { sequence, unit: "model_calls" as const, descriptorSha256: probeHash(`replay-effect-${sequence}`), reservedTokens: 20 };
        await callbacks.runEffect(request, async () => fakeEffectValue(request, "fixture", 5));
      }
      ready(); await gate;
      return { reservation: input.reservation, outcome: "closed_fixture", servedModel: GUIDANCE_PROBE_MODEL, inputFrameHash: input.inputSha256,
        workerEffectiveInputHash: input.inputSha256, nonGuidanceInputSha256: input.nonGuidanceInputSha256, candidateArtifactSha256: null, usage: "known_fixture" };
    };
    const runner = new GuidanceProbeFixtureHost(f.store, { ports: provider, revalidate: f.revalidate, now: () => f.clock.now });
    const original = { key: f.key, expectedRevision: 0, host: f.host, now: 100 };
    let firstError: unknown;
    const first = runner.start(original, new AbortController().signal).catch(error => { firstError = error; ready(); });
    await observed;
    try {
      if (firstError) throw firstError;
      const before = f.store.integrity(), replay = await runner.start({ ...original, now: 200 }, new AbortController().signal);
      expect(replay.already).toBe(true); expect(f.store.integrity()).toEqual(before); expect(provider.launches).toHaveLength(1);
      expect(f.store.read(f.key)!.counters).toMatchObject({ workerAttempts: 1, modelCalls: 2, tokensReserved: 40, tokensObservedKnown: 10 });
    } finally { release(); await first; }
    if (firstError) throw firstError;
    expect(f.store.read(f.key)!.sessions[0]!.state).toBe("closed_fixture");
    const before = f.store.integrity();
    expect((await runner.start(original, new AbortController().signal)).already).toBe(true);
    const reopened = new GuidanceProbeStore(f.file, () => f.clock.now); cleanup.push(() => reopened.close());
    const restored = new GuidanceProbeFixtureHost(reopened, { ports: provider, revalidate: f.revalidate, now: () => f.clock.now });
    expect((await restored.start(original, new AbortController().signal)).already).toBe(true);
    expect(reopened.integrity()).toEqual(before); expect(provider.launches).toHaveLength(1);
  });
  test("original start replay cannot change actor/session/variant and current refusal precedes duplicate lookup", () => {
    const f = fixture(); f.register(); f.reserve(); const before = f.store.integrity();
    for (const changed of [{ ...f.host, actor: "pi" }, { ...f.host, sessionGeneration: "changed-generation" }, { ...f.host, nativeSession: "changed-session" }, { ...f.host, requestConnectionId: "changed-connection" }]) {
      expect(() => f.store.reserveSession({ key: f.key, expectedRevision: 0, host: changed, now: 100 }, () => ({ host: changed }))).toThrow("binding");
      expect(f.store.integrity()).toEqual(before);
    }
    const child: ProbeChildBinding = { variantId: probeHash("different-child"), candidateSha256: probeHash("raw"), guidanceSha256: probeHash("rendered"), guidance: "rendered",
      task: f.host.task, role: f.host.role, authoring: "uncontrolled", sourceSessionId: null };
    expect(() => f.store.reserveSession({ key: f.key, expectedRevision: 0, host: f.host, child, now: 100 }, () => ({ host: f.host, child }))).toThrow("binding");
    expect(() => f.store.reserveSession({ key: f.key, expectedRevision: 0, host: f.host, now: 100 }, () => { throw new Error("current authority withdrawn"); })).toThrow();
    expect(f.store.integrity()).toEqual(before);
  });
  test("historical candidate selector revalidates the original G1 rather than rebinding today's next slot", () => {
    const f = fixture(); f.registration.manifest.slots = [f.registration.manifest.slots[0]!, f.registration.manifest.slots[2]!];
    const key = guidanceProbeFixtureKey(f.registration); f.store.register(f.registration, f.host, () => f.host);
    const baseline = f.store.reserveSession({ key, expectedRevision: 0, host: f.host, now: 100 }, f.revalidate);
    if (baseline.kind !== "granted") throw new Error("expected baseline");
    f.store.settleSession({ reservation: baseline.reservation, outcome: "closed_fixture", candidateArtifactSha256: null, now: 100 });
    const child: ProbeChildBinding = { variantId: probeHash("original-child"), candidateSha256: probeHash("raw"), guidanceSha256: probeHash("rendered"), guidance: "rendered",
      task: f.host.task, role: f.host.role, authoring: "uncontrolled", sourceSessionId: null };
    const originalRevision = f.store.read(key)!.receipt.revision;
    const request = { key, expectedRevision: originalRevision, host: f.host, child, now: 100 }, check = () => ({ host: f.host, child });
    const candidate = f.store.reserveSession(request, check); if (candidate.kind !== "granted") throw new Error("expected candidate");
    f.store.settleSession({ reservation: candidate.reservation, outcome: "closed_fixture", candidateArtifactSha256: null, now: 100 });
    expect(f.store.read(key)!.receipt.state).toBe("closed_fixture");
    expect(f.store.startSelector(key, originalRevision)?.variantId).toBe(child.variantId);
    const before = f.store.integrity(); expect(f.store.reserveSession(request, check)).toMatchObject({ kind: "existing", receipt: { state: "closed_fixture", already: true } });
    const different = { ...child, variantId: probeHash("another-current-child") };
    expect(() => f.store.reserveSession({ ...request, child: different }, () => ({ host: f.host, child: different }))).toThrow("binding");
    expect(() => f.store.reserveSession(request, () => { throw new Error("original G1 is now withdrawn"); })).toThrow();
    expect(f.store.integrity()).toEqual(before); expect(f.store.read(key)!.counters.workerAttempts).toBe(2);
  });
  test("pre-lock changed callback refuses zero writes; competing connection cannot write under lock", () => {
    const f = fixture(); f.register(); const before = f.store.integrity();
    expect(() => f.store.reserveSession({ key: f.key, expectedRevision: 0, host: f.host, now: 100 }, () => ({ host: { ...f.host, task: { ...f.host.task, flowRevision: 3 } } }))).toThrow("binding");
    expect(f.store.integrity()).toEqual(before);
    const second = new GuidanceProbeStore(f.file, () => f.clock.now); cleanup.push(() => second.close()); let attempted = false;
    const result = f.store.reserveSession({ key: f.key, expectedRevision: 0, host: f.host, now: 100 }, () => {
      attempted = true;
      expect(() => second.register(f.registration, f.host, () => f.host)).toThrow("storage");
      return f.revalidate();
    });
    expect(attempted).toBe(true); expect(result.kind).toBe("granted");
  });
  test("one lane across experiments, exact duplicate never grants another session", () => {
    const f = fixture(); f.register(); const reservation = f.reserve();
    expect(f.store.reserveSession({ key: f.key, expectedRevision: 0, host: f.host, now: 100 }, f.revalidate).kind).toBe("existing");
    const another = copy(f.registration); another.manifest.experimentId = "separate-experiment"; const otherKey = guidanceProbeFixtureKey(another);
    f.store.register(another, f.host, () => f.host);
    expect(() => f.store.reserveSession({ key: otherKey, expectedRevision: 0, host: f.host, now: 100 }, f.revalidate)).toThrow("uncertain");
    expect(f.store.read(f.key)!.counters.workerAttempts).toBe(1); expect(reservation.slotId).toBe("baseline");
  });
  test("production no runner refuses before any lane/session/late binding reservation", async () => {
    const f = fixture(); f.register(); const before = f.store.integrity();
    const host = new GuidanceProbeFixtureHost(f.store, { revalidate: f.revalidate, now: () => 100 });
    await expect(host.start({ key: f.key, expectedRevision: 0, host: f.host, now: 100 }, new AbortController().signal)).rejects.toThrow("runner is unavailable");
    expect(f.store.integrity()).toEqual(before);
  });
  test("post-launch zero effects or unknown usage stays held even when the fake claims known fixture", async () => {
    for (const mode of ["no-effects", "unknown-usage"] as const) {
      const f = fixture(); f.register(); const provider = new FakeGuidanceProbeProvider();
      provider.script = async (input, effects) => {
        if (mode === "unknown-usage") {
          const request = { sequence: 0, unit: "model_calls" as const, descriptorSha256: probeHash("unknown-usage"), reservedTokens: 20 };
          await effects.runEffect(request, async () => fakeEffectValue(request, "result", null));
        }
        return { reservation: input.reservation, outcome: "closed_fixture", servedModel: GUIDANCE_PROBE_MODEL, inputFrameHash: input.inputSha256,
          workerEffectiveInputHash: input.inputSha256, nonGuidanceInputSha256: input.nonGuidanceInputSha256, candidateArtifactSha256: null, usage: "known_fixture" };
      };
      const runner = new GuidanceProbeFixtureHost(f.store, { ports: provider, revalidate: f.revalidate, now: () => f.clock.now });
      await runner.start({ key: f.key, expectedRevision: 0, host: f.host, now: f.clock.now }, new AbortController().signal);
      const session = f.store.read(f.key)!.sessions[0]!;
      expect(session.state).toBe("unknown_held"); expect(session.coverage.launchExposed).toBe(true); expect(session.coverage.coverageVerified).toBe(false);
      expect(f.store.read(f.key)!.counters.usageUnknown).toBe(true);
    }
  });
  test("host-attested pre-launch failure retains its registered retry without becoming comparable", async () => {
    const f = fixture(), original = f.registration.manifest.slots[0]!;
    f.registration.manifest.slots = [{ ...original }, { ...original, id: "baseline-retry", retryOf: original.id }, f.registration.manifest.slots[2]!];
    const key = guidanceProbeFixtureKey(f.registration); f.store.register(f.registration, f.host, () => f.host);
    f.store.exposeLaunch = () => { throw new Error("host refused before exposing launch"); };
    const provider = new FakeGuidanceProbeProvider(), runner = new GuidanceProbeFixtureHost(f.store, { ports: provider, revalidate: f.revalidate, now: () => f.clock.now });
    await expect(runner.start({ key, expectedRevision: 0, host: f.host, now: f.clock.now }, new AbortController().signal)).rejects.toThrow("uncertain");
    const state = f.store.read(key)!;
    expect(state.sessions[0]!.state).toBe("failed_known"); expect(state.sessions[0]!.coverage).toMatchObject({ preLaunchFailure: true, launchExposed: false });
    expect(state.sessions[1]!.state).toBe("planned"); expect(provider.launches).toHaveLength(0);
    expect(state.receipt.state).toBe("active");
    expect(state.sessions[0]!.coverage.coverageVerified).toBe(false);
    expect(f.store.reserveSession({ key, expectedRevision: state.receipt.revision, host: f.host, now: f.clock.now }, f.revalidate).kind).toBe("granted");
    expect(f.store.read(key)!.counters.workerAttempts).toBe(2);
  });
  test("a terminal host-attested pre-launch failure releases only its known empty lane", async () => {
    const f = fixture(); f.register();
    f.store.exposeLaunch = () => { throw new Error("host refused before exposing launch"); };
    const provider = new FakeGuidanceProbeProvider(), runner = new GuidanceProbeFixtureHost(f.store, { ports: provider, revalidate: f.revalidate, now: () => f.clock.now });
    await expect(runner.start({ key: f.key, expectedRevision: 0, host: f.host, now: f.clock.now }, new AbortController().signal)).rejects.toThrow("uncertain");
    expect(provider.launches).toHaveLength(0);
    expect(f.store.read(f.key)!.receipt.state).toBe("failed_fixture");
    expect(f.store.read(f.key)!.sessions[0]!.coverage.preLaunchFailure).toBe(true);
    expect(f.store.integrity().experiments).toBe(1);
    const another = copy(f.registration); another.manifest.experimentId = "after-known-startup-failure";
    const key = guidanceProbeFixtureKey(another); f.store.register(another, f.host, () => f.host);
    expect(f.store.reserveSession({ key, expectedRevision: 0, host: f.host, now: f.clock.now }, f.revalidate).kind).toBe("granted");
  });
  test("fully covered controlled fake fixture is the only route to comparable status", async () => {
    const f = fixture(), source = f.registration.manifest.slots;
    f.registration.manifest.slots = [source[0]!, source[1]!, source[2]!];
    const key = guidanceProbeFixtureKey(f.registration); f.store.register(f.registration, f.host, () => f.host);
    const candidate = "Controlled fixture candidate.";
    const child: ProbeChildBinding = { variantId: probeHash("controlled-variant"), candidateSha256: probeHash(candidate), guidanceSha256: probeHash(candidate),
      guidance: candidate, task: f.host.task, role: f.host.role, authoring: "uncontrolled", sourceSessionId: null };
    const provider = new FakeGuidanceProbeProvider();
    provider.script = async (input, effects) => {
      const request = { sequence: 0, unit: "model_calls" as const, descriptorSha256: probeHash(`covered-${input.slot.id}`), reservedTokens: 20 };
      await effects.runEffect(request, async () => fakeEffectValue(request, "covered result", 10));
      return { reservation: input.reservation, outcome: "closed_fixture", servedModel: GUIDANCE_PROBE_MODEL, inputFrameHash: input.inputSha256,
        workerEffectiveInputHash: input.slot.role === "worker" ? input.inputSha256 : null,
        nonGuidanceInputSha256: input.slot.role === "worker" ? input.nonGuidanceInputSha256 : null,
        candidateArtifactSha256: input.slot.id === "proposal1" ? child.candidateSha256 : null, usage: "known_fixture" };
    };
    let activeChild: ProbeChildBinding | undefined;
    const runner = new GuidanceProbeFixtureHost(f.store, { ports: provider, revalidate: () => ({ host: f.host, ...(activeChild ? { child: activeChild } : {}) }),
      now: () => f.clock.now, prepareEditorFrame: () => "bounded editor frame" });
    await runner.start({ key, expectedRevision: 0, host: f.host, now: f.clock.now }, new AbortController().signal);
    const proposalRevision = f.store.read(key)!.receipt.revision;
    await runner.start({ key, expectedRevision: proposalRevision, host: f.host, now: f.clock.now }, new AbortController().signal);
    const candidateRevision = f.store.read(key)!.receipt.revision;
    activeChild = child;
    await runner.start({ key, expectedRevision: candidateRevision, host: f.host, child, now: f.clock.now }, new AbortController().signal);
    const sessions = f.store.read(key)!.sessions;
    expect(sessions[0]!.coverage.coverageVerified).toBe(true); expect(sessions[1]!.coverage.coverageVerified).toBe(true);
    expect(sessions[2]!.child!.authoring).toBe("admitted_fixture"); expect(sessions[2]!.coverage.coverageVerified).toBe(true);
    expect(f.store.read(key)!.receipt.state).toBe("closed_fixture");
  });
  test("reservation precedes launch, actual wrapper accounting separates reserved and observed tokens", async () => {
    const f = fixture(); f.register(); const provider = new FakeGuidanceProbeProvider(); let observedReservation = false;
    const launch = provider.launch.bind(provider); provider.launch = async (input, effects, signal) => {
      observedReservation = f.store.read(f.key)!.sessions[0]!.state === "reserved";
      return launch(input, effects, signal);
    };
    const host = new GuidanceProbeFixtureHost(f.store, { ports: provider, revalidate: f.revalidate, now: () => 100 });
    await host.start({ key: f.key, expectedRevision: 0, host: f.host, now: 100 }, new AbortController().signal);
    expect(observedReservation).toBe(true); expect(provider.launches).toHaveLength(1);
    const visible = JSON.parse(provider.launches[0]!.inputFrame);
    expect(visible.systemPolicy).toBe(f.registration.snapshots.systemPolicy);
    expect(visible).toEqual({ task: f.registration.snapshots.task, baselineContext: f.registration.snapshots.baselineContext,
      systemPolicy: f.registration.snapshots.systemPolicy, guidance: f.host.baselineGuidance });
    expect(provider.launches[0]!.inputFrame).not.toContain(f.host.nativeSession!);
    expect(f.store.read(f.key)!.counters).toMatchObject({ workerAttempts: 1, modelCalls: 1, tokensReserved: 20, tokensObservedKnown: 10, usageUnknown: false });
  });
  test("effect replay ignores bookkeeping clock but never charges or invokes twice", () => {
    const f = fixture(); f.register(); const r = f.reserve(), admission = f.effect(r);
    expect(f.store.admitEffect(admission, f.revalidate).kind).toBe("granted");
    expect(f.store.admitEffect({ ...admission, now: 101 }, f.revalidate)).toEqual({ kind: "existing", state: "pending" });
    expect(f.store.read(f.key)!.counters.modelCalls).toBe(1);
    expect(() => f.store.admitEffect({ ...admission, descriptorSha256: probeHash("different") }, f.revalidate)).toThrow("binding");
  });
  test("actual host runEffect replay invokes a fake effect once and tool overrun holds", async () => {
    const f = fixture(); f.register(); const provider = new FakeGuidanceProbeProvider(); let invocations = 0;
    provider.script = async (input, callbacks) => {
      const request = { sequence: 0, unit: "tool_calls" as const, descriptorSha256: probeHash("tool") };
      const work = async () => { invocations++; return fakeEffectValue(request, "tool result", 2); };
      expect((await callbacks.runEffect(request, work)).kind).toBe("executed");
      // Coverage overrun must hold rather than permit a fresh tool effect.
      await expect(callbacks.runEffect({ ...request, sequence: 1 }, work)).rejects.toThrow("uncertain");
      return { reservation: input.reservation, outcome: "closed_fixture", servedModel: GUIDANCE_PROBE_MODEL, inputFrameHash: input.inputSha256, workerEffectiveInputHash: input.inputSha256,
        nonGuidanceInputSha256: input.nonGuidanceInputSha256, candidateArtifactSha256: null, usage: "known_fixture" };
    };
    const runner = new GuidanceProbeFixtureHost(f.store, { ports: provider, revalidate: f.revalidate, now: () => 100 });
    await runner.start({ key: f.key, expectedRevision: 0, host: f.host, now: 100 }, new AbortController().signal);
    expect(invocations).toBe(1); expect(f.store.read(f.key)!.counters).toMatchObject({ toolCalls: 1, usageUnknown: true });
  });
  test("actual host replay with known usage returns existing state without invoking twice", async () => {
    const f = fixture(); f.register(); const provider = new FakeGuidanceProbeProvider(); let invocations = 0;
    provider.script = async (input, callbacks) => {
      const request = { sequence: 0, unit: "tool_calls" as const, descriptorSha256: probeHash("tool") };
      const work = async () => { invocations++; return fakeEffectValue(request, "tool result", 1); };
      expect((await callbacks.runEffect(request, work)).kind).toBe("executed");
      expect(await callbacks.runEffect(request, work)).toEqual({ kind: "existing", state: "settled" });
      return { reservation: input.reservation, outcome: "closed_fixture", servedModel: GUIDANCE_PROBE_MODEL, inputFrameHash: input.inputSha256, workerEffectiveInputHash: input.inputSha256,
        nonGuidanceInputSha256: input.nonGuidanceInputSha256, candidateArtifactSha256: null, usage: "known_fixture" };
    };
    const runner = new GuidanceProbeFixtureHost(f.store, { ports: provider, revalidate: f.revalidate, now: () => 100 });
    await runner.start({ key: f.key, expectedRevision: 0, host: f.host, now: 100 }, new AbortController().signal);
    expect(invocations).toBe(1); expect(f.store.read(f.key)!.counters.toolCalls).toBe(1);
  });
  test("shared model/token/tool budget refusal occurs before another fake effect", async () => {
    const f = fixture(); f.registration.manifest.limits.modelCalls = 1; f.registration.manifest.limits.tokens = 20;
    f.key = guidanceProbeFixtureKey(f.registration); f.register(); let effects = 0;
    const provider = new FakeGuidanceProbeProvider();
    provider.script = async (input, callbacks) => {
      const request = { sequence: 0, unit: "model_calls" as const, descriptorSha256: probeHash("one"), reservedTokens: 20 };
      await callbacks.runEffect(request, async () => { effects++; return fakeEffectValue(request, "one", 10); });
      await expect(callbacks.runEffect({ ...request, sequence: 1, descriptorSha256: probeHash("two") }, async () => { effects++; return fakeEffectValue(request, "two", 10); })).rejects.toThrow("budget");
      return { reservation: input.reservation, outcome: "closed_fixture", servedModel: GUIDANCE_PROBE_MODEL, inputFrameHash: input.inputSha256, workerEffectiveInputHash: input.inputSha256,
        nonGuidanceInputSha256: input.nonGuidanceInputSha256, candidateArtifactSha256: null, usage: "known_fixture" };
    };
    const host = new GuidanceProbeFixtureHost(f.store, { ports: provider, revalidate: f.revalidate, now: () => 100 });
    await host.start({ key: f.key, expectedRevision: 0, host: f.host, now: 100 }, new AbortController().signal);
    expect(effects).toBe(1); expect(f.store.read(f.key)!.counters.tokensReserved).toBe(20);
  });
  test("zero-call budget and unknown token upper bound refuse without a launch/effect", () => {
    const f = fixture(); f.registration.manifest.limits.modelCalls = 0;
    const key = guidanceProbeFixtureKey(f.registration); f.store.register(f.registration, f.host, () => f.host); const before = f.store.integrity();
    expect(() => f.store.reserveSession({ key, expectedRevision: 0, host: f.host, now: 100 }, f.revalidate)).toThrow("budget"); expect(f.store.integrity()).toEqual(before);
    const g = fixture(); g.register(); const r = g.reserve(); const { reservedTokens: _, ...unknown } = g.effect(r);
    expect(() => g.store.admitEffect(unknown, g.revalidate)).toThrow("budget"); expect(g.store.read(g.key)!.counters.modelCalls).toBe(0);
  });
  test("model-only work admits with zero tool quota and refuses a requested tool before invocation", async () => {
    const f = fixture(); f.registration.manifest.limits.toolCalls = 0;
    const key = guidanceProbeFixtureKey(f.registration); f.store.register(f.registration, f.host, () => f.host);
    const provider = new FakeGuidanceProbeProvider(); let tools = 0, models = 0;
    provider.script = async (input, callbacks) => {
      const model = { sequence: 0, unit: "model_calls" as const, descriptorSha256: probeHash("model-only"), reservedTokens: 20 };
      await callbacks.runEffect(model, async () => { models++; return fakeEffectValue(model, "model-only", 10); });
      const tool = { sequence: 1, unit: "tool_calls" as const, descriptorSha256: probeHash("no-tool-quota") };
      await expect(callbacks.runEffect(tool, async () => { tools++; return fakeEffectValue(tool, "forbidden-tool", 1); })).rejects.toThrow("budget");
      return { reservation: input.reservation, outcome: "closed_fixture", servedModel: GUIDANCE_PROBE_MODEL, inputFrameHash: input.inputSha256,
        workerEffectiveInputHash: input.inputSha256, nonGuidanceInputSha256: input.nonGuidanceInputSha256, candidateArtifactSha256: null, usage: "known_fixture" };
    };
    const runner = new GuidanceProbeFixtureHost(f.store, { ports: provider, revalidate: f.revalidate, now: () => f.clock.now });
    await runner.start({ key, expectedRevision: 0, host: f.host, now: 1 }, new AbortController().signal);
    expect(provider.launches).toHaveLength(1); expect(models).toBe(1); expect(tools).toBe(0);
    expect(f.store.read(key)!.counters).toMatchObject({ modelCalls: 1, toolCalls: 0, usageUnknown: false });
  });
  test("post-lock revalidation clock sample refuses the next session after its deadline despite a queued old timestamp", () => {
    const f = fixture(); f.register(); f.finish(f.reserve()); const before = f.store.read(f.key)!;
    const result = f.store.reserveSession({ key: f.key, expectedRevision: before.receipt.revision, host: f.host, now: 100 }, () => {
      f.clock.now = 100 + f.registration.manifest.limits.elapsedMs; return f.revalidate();
    });
    expect(result.kind).toBe("existing"); expect(f.store.read(f.key)!.admissionHold).toBe("elapsed");
    expect(f.store.read(f.key)!.sessions[1]!.state).toBe("planned"); expect(f.store.read(f.key)!.counters.editorAttempts).toBe(0);
  });
  test("effect grant records its fresh critical-section time and usage correlates the returned descriptor", () => {
    const f = fixture(); f.register(); const reservation = f.reserve(), requested = { ...f.effect(reservation), now: 1 };
    const grant = f.store.admitEffect(requested, () => { f.clock.now = 120; return f.revalidate(); });
    expect(grant.kind).toBe("granted"); if (grant.kind !== "granted") throw new Error("expected fresh effect grant");
    expect(grant.admission.now).toBe(120); expect(grant.admission.now).not.toBe(requested.now);
    f.usage(grant.admission, 10); f.store.settleEffect({ admission: grant.admission, outcome: "settled" });
    expect(f.store.read(f.key)!.counters).toMatchObject({ tokensReserved: 20, tokensObservedKnown: 10, usageUnknown: false, elapsedHighWaterMs: 20 });
  });
  test("effect admission samples after revalidation and refuses exhausted time without charging a call", () => {
    const f = fixture(); f.register(); const reservation = f.reserve();
    const result = f.store.admitEffect({ ...f.effect(reservation), now: 100 }, () => {
      f.clock.now = 100 + f.registration.manifest.limits.elapsedMs; return f.revalidate();
    });
    expect(result).toEqual({ kind: "existing", state: "unknown" });
    expect(f.store.read(f.key)!.counters.modelCalls).toBe(0); expect(f.store.read(f.key)!.admissionHold).toBe("elapsed");
  });
  test("clock exhaustion immediately before fake launch prevents launch after session reservation", async () => {
    const f = fixture(); f.register(); const provider = new FakeGuidanceProbeProvider(); let checks = 0;
    const runner = new GuidanceProbeFixtureHost(f.store, { ports: provider, now: () => f.clock.now, revalidate: () => {
      if (++checks === 2) f.clock.now = 100 + f.registration.manifest.limits.elapsedMs; return f.revalidate();
    } });
    await expect(runner.start({ key: f.key, expectedRevision: 0, host: f.host, now: 100 }, new AbortController().signal)).rejects.toThrow("uncertain");
    expect(provider.launches).toHaveLength(0); expect(f.store.read(f.key)!.admissionHold).toBe("elapsed");
    expect(f.store.read(f.key)!.counters.workerAttempts).toBe(1);
  });
  test("clock exhaustion immediately before fake effect invocation preserves spent grant but invokes nothing", async () => {
    const f = fixture(); f.register(); const provider = new FakeGuidanceProbeProvider(); let checks = 0, effects = 0;
    provider.script = async (input, callbacks) => {
      const request = { sequence: 0, unit: "model_calls" as const, descriptorSha256: probeHash("deadline-before-invoke"), reservedTokens: 20 };
      await callbacks.runEffect(request, async () => { effects++; return fakeEffectValue(request, "must-not-run", 10); });
      throw new Error("exhausted effect cannot return success");
    };
    const runner = new GuidanceProbeFixtureHost(f.store, { ports: provider, now: () => f.clock.now, revalidate: () => {
      if (++checks === 4) f.clock.now = 100 + f.registration.manifest.limits.elapsedMs; return f.revalidate();
    } });
    await expect(runner.start({ key: f.key, expectedRevision: 0, host: f.host, now: 100 }, new AbortController().signal)).rejects.toThrow("uncertain");
    expect(provider.launches).toHaveLength(1); expect(effects).toBe(0); expect(f.store.read(f.key)!.admissionHold).toBe("elapsed");
    expect(f.store.read(f.key)!.counters).toMatchObject({ modelCalls: 1, tokensReserved: 20, usageUnknown: true });
  });
  test("cross-await withdrawal refuses a new call; already spent accounting needs no new authority", async () => {
    const f = fixture(); f.register(); const provider = new FakeGuidanceProbeProvider(); let authorized = true, effects = 0;
    const check = () => { if (!authorized) throw new Error("fixture G1 withdrawn"); return f.revalidate(); };
    provider.script = async (input, callbacks) => {
      const request = { sequence: 0, unit: "model_calls" as const, descriptorSha256: probeHash("spent"), reservedTokens: 20 };
      await callbacks.runEffect(request, async () => { effects++; authorized = false; await Promise.resolve(); return fakeEffectValue(request, "spent", 10); });
      await expect(callbacks.runEffect({ ...request, sequence: 1 }, async () => { effects++; return fakeEffectValue(request, "forbidden", 10); })).rejects.toThrow();
      return { reservation: input.reservation, outcome: "closed_fixture", servedModel: GUIDANCE_PROBE_MODEL, inputFrameHash: input.inputSha256, workerEffectiveInputHash: input.inputSha256,
        nonGuidanceInputSha256: input.nonGuidanceInputSha256, candidateArtifactSha256: null, usage: "known_fixture" };
    };
    const host = new GuidanceProbeFixtureHost(f.store, { ports: provider, revalidate: check, now: () => 100 });
    await host.start({ key: f.key, expectedRevision: 0, host: f.host, now: 100 }, new AbortController().signal);
    expect(effects).toBe(1); expect(f.store.read(f.key)!.counters.tokensObservedKnown).toBe(10);
  });
  test("missing, conflicting and late usage never becomes a known zero", () => {
    const f = fixture(); f.register(); const r = f.reserve(), admission = f.effect(r); f.store.admitEffect(admission, f.revalidate);
    f.store.settleEffect({ admission, outcome: "settled" });
    expect(f.store.read(f.key)!.counters).toMatchObject({ tokensObservedKnown: 0, tokensReserved: 20, usageUnknown: true });
    f.usage(admission, 10); expect(f.store.read(f.key)!.counters.usageUnknown).toBe(true);
    f.usage({ ...admission, sequence: 8 }, 0); expect(f.store.read(f.key)!.receipt.state).toBe("unknown_held");
  });
  test("numeric overrun retains consumed budgets and holds instead of refunding", () => {
    const f = fixture(); f.register(); const r = f.reserve(), admission = f.effect(r); f.store.admitEffect(admission, f.revalidate); f.usage(admission, 21);
    expect(f.store.read(f.key)!.counters).toMatchObject({ tokensReserved: 20, tokensObservedKnown: 21, modelCalls: 1, usageUnknown: true });
    expect(f.store.read(f.key)!.receipt.state).toBe("unknown_held");
  });
  test("provider hash equal to host ledger hash still latches a visible-hash conflict", async () => {
    const f = fixture(); f.register(); const provider = new FakeGuidanceProbeProvider();
    provider.script = async (input, callbacks) => {
      const request = { sequence: 0, unit: "model_calls" as const, descriptorSha256: probeHash("forged-visible"), reservedTokens: 20 };
      const admission = { reservation: input.reservation, ...request, amount: 1, now: 100 }, observed = 10;
      const ledgerHash = probeHash(guidanceProbeCanonical({ admission, observed }));
      expect(ledgerHash).not.toBe(probeHash(guidanceProbeCanonical({ request, usage: observed })));
      await callbacks.runEffect(request, async () => ({ value: "fixture", usage: observed, observationSha256: ledgerHash }));
      return { reservation: input.reservation, outcome: "closed_fixture", servedModel: GUIDANCE_PROBE_MODEL, inputFrameHash: input.inputSha256,
        workerEffectiveInputHash: input.inputSha256, nonGuidanceInputSha256: input.nonGuidanceInputSha256, candidateArtifactSha256: null, usage: "known_fixture" };
    };
    const runner = new GuidanceProbeFixtureHost(f.store, { ports: provider, revalidate: f.revalidate, now: () => 100 });
    await runner.start({ key: f.key, expectedRevision: 0, host: f.host, now: 100 }, new AbortController().signal);
    expect(f.store.read(f.key)!.admissionHold).toBe("observation");
    expect(f.store.read(f.key)!.counters.usageUnknown).toBe(true);
  });
  test("wrong/unknown editor served model or generic input hash never yields controlled authoring", async () => {
    for (const override of [{ servedModel: null }, { servedModel: "wrong/model" }, { inputFrameHash: null }, { inputFrameHash: probeHash("wrong-frame") }]) {
      const f = fixture(); f.register(); f.finish(f.reserve()); const provider = new FakeGuidanceProbeProvider();
      provider.script = async input => ({ reservation: input.reservation, outcome: "closed_fixture", servedModel: GUIDANCE_PROBE_MODEL,
        inputFrameHash: input.inputSha256, workerEffectiveInputHash: null, nonGuidanceInputSha256: null,
        candidateArtifactSha256: probeHash("editor artifact"), usage: "known_fixture", ...override });
      const runner = new GuidanceProbeFixtureHost(f.store, { ports: provider, revalidate: f.revalidate, now: () => 100, prepareEditorFrame: () => "bounded editor frame" });
      await runner.start({ key: f.key, expectedRevision: f.store.read(f.key)!.receipt.revision, host: f.host, now: 100 }, new AbortController().signal);
      expect(provider.launches).toHaveLength(1); expect(f.store.read(f.key)!.sessions[1]!.candidateArtifactSha256).toBeNull();
      expect(f.store.read(f.key)!.sessions[1]!.state).toBe("unknown_held"); expect(f.store.read(f.key)!.admissionHold).toBe("observation");
    }
  });
  test("wall clock regression holds the lane across reopen without a reservation refund", () => {
    const f = fixture(); f.register(); const r = f.reserve();
    f.clock.now = 99;
    expect(f.store.admitEffect({ ...f.effect(r), now: 99 }, f.revalidate)).toEqual({ kind: "existing", state: "unknown" });
    const reopened = new GuidanceProbeStore(f.file, () => f.clock.now); cleanup.push(() => reopened.close());
    expect(reopened.read(f.key)!.receipt.state).toBe("unknown_held"); expect(reopened.read(f.key)!.counters.workerAttempts).toBe(1);
    expect(() => reopened.reserveSession({ key: f.key, expectedRevision: reopened.read(f.key)!.receipt.revision, host: f.host, now: 200 }, f.revalidate)).toThrow("uncertain");
  });
  test("late close after recovered clock cannot clear the sticky elapsed hold or delete the final lane", () => {
    const f = fixture(); f.registration.manifest.slots = [f.registration.manifest.slots[0]!, f.registration.manifest.slots[2]!];
    const key = guidanceProbeFixtureKey(f.registration); f.store.register(f.registration, f.host, () => f.host);
    const first = f.store.reserveSession({ key, expectedRevision: 0, host: f.host, now: 100 }, f.revalidate);
    if (first.kind !== "granted") throw new Error("expected baseline");
    f.store.settleSession({ reservation: first.reservation, outcome: "closed_fixture", candidateArtifactSha256: null, now: 100 });
    const child: ProbeChildBinding = { variantId: probeHash("current-variant"), candidateSha256: probeHash("raw role"), guidanceSha256: probeHash("rendered"), guidance: "rendered",
      task: f.host.task, role: f.host.role, authoring: "uncontrolled", sourceSessionId: null };
    const check = () => ({ host: f.host, child });
    const second = f.store.reserveSession({ key, expectedRevision: f.store.read(key)!.receipt.revision, host: f.host, child, now: 100 }, check);
    if (second.kind !== "granted") throw new Error("expected candidate");
    f.clock.now = 99;
    expect(f.store.admitEffect({ ...f.effect(second.reservation), now: 99 }, check)).toEqual({ kind: "existing", state: "unknown" });
    f.clock.now = 101;
    f.store.settleSession({ reservation: second.reservation, outcome: "closed_fixture", candidateArtifactSha256: null, now: 101 });
    expect(f.store.read(key)!.admissionHold).toBe("elapsed"); expect(f.store.read(key)!.receipt.state).toBe("unknown_held");
    const db = openHubDatabase(f.file); cleanup.push(() => db.close());
    expect((db.query("SELECT COUNT(*) AS n FROM guidance_probe_lanes WHERE project=?").get(key.projectKey) as { n: number }).n).toBe(1);
    expect(f.store.read(key)!.counters.workerAttempts).toBe(2);
  });
  test("cancel narrows after flow change but does not release or resurrect", () => {
    const f = fixture(); f.register(); f.reserve(); const current = { ...f.host, task: { ...f.host.task, flowRevision: 9 } };
    const revision = f.store.read(f.key)!.receipt.revision;
    expect(f.store.cancelIntent({ key: f.key, expectedRevision: revision, host: current }, () => current).state).toBe("closing");
    expect(() => f.store.reserveSession({ key: f.key, expectedRevision: f.store.read(f.key)!.receipt.revision, host: f.host, now: 100 }, f.revalidate)).toThrow("uncertain");
    expect(() => f.store.cancelIntent({ key: f.key, expectedRevision: revision + 1, host: { ...current, task: { ...current.task, created: 999 } } }, () => ({ ...current, task: { ...current.task, created: 999 } }))).toThrow("binding");
  });
  test("cancel intent survives hold, unknown settlement and reopen without releasing or granting", () => {
    const f = fixture(); f.register(); const reservation = f.reserve();
    f.store.cancelIntent({ key: f.key, expectedRevision: f.store.read(f.key)!.receipt.revision, host: f.host }, () => f.host);
    f.store.latchHold(reservation, "observation");
    f.store.settleSession({ reservation, outcome: "unknown", candidateArtifactSha256: null, now: f.clock.now });
    const reopened = new GuidanceProbeStore(f.file, () => f.clock.now); cleanup.push(() => reopened.close());
    const state = reopened.read(f.key)!; expect(state.cancelRequested).toBe(true); expect(state.receipt.state).toBe("unknown_held");
    const before = reopened.integrity();
    expect(reopened.reserveSession({ key: f.key, expectedRevision: 0, host: f.host, now: f.clock.now }, f.revalidate)).toMatchObject({ kind: "existing", receipt: { already: true, state: "unknown_held" } });
    expect(() => reopened.reserveSession({ key: f.key, expectedRevision: state.receipt.revision, host: f.host, now: f.clock.now }, f.revalidate)).toThrow("uncertain");
    expect(reopened.integrity()).toEqual(before); expect(reopened.read(f.key)!.counters.workerAttempts).toBe(1);
    const db = openHubDatabase(f.file); cleanup.push(() => db.close());
    expect((db.query("SELECT COUNT(*) AS n FROM guidance_probe_lanes WHERE project=?").get(f.key.projectKey) as { n: number }).n).toBe(1);
    db.query("UPDATE guidance_probe_manifests SET cancel_requested=2 WHERE project=? AND id=?").run(f.key.projectKey, f.key.id);
    expect(() => reopened.read(f.key)).toThrow("storage");
  });
  test("late candidate is atomically bound to existing current G1; external provenance stays uncontrolled", () => {
    const f = fixture(); f.register(); f.finish(f.reserve()); f.finish(f.reserve());
    const child: ProbeChildBinding = { variantId: probeHash("variant"), candidateSha256: probeHash("Raw candidate role file."), guidanceSha256: probeHash("Candidate guidance."), guidance: "Candidate guidance.", task: f.host.task, role: f.host.role, authoring: "admitted_fixture", sourceSessionId: "invented" };
    const result = f.store.reserveSession({ key: f.key, expectedRevision: f.store.read(f.key)!.receipt.revision, host: f.host, child, now: 100 }, () => ({ host: f.host, child }));
    expect(result.kind).toBe("granted"); expect(f.store.read(f.key)!.sessions[2]!.child).toMatchObject({ variantId: child.variantId, authoring: "uncontrolled", sourceSessionId: null });
    expect(f.store.read(f.key)!.counters.workerAttempts).toBe(2);
  });
  test("owned G1 raw candidate hash and rendered guidance hash bind different byte representations", async () => {
    const f = fixture(), g1 = parseGuidanceVariantV1(vectors.golden.record);
    f.host.task = { id: g1.taskId, created: g1.taskCreated, flowRevision: g1.flowRevision };
    f.host.role = { id: g1.baseline.roleId, layer: g1.baseline.layer, baselineSha256: g1.baseline.sha256 };
    f.host.baselineGuidance = taskRoleText(parseRole(g1.baseline.bytes, g1.baseline.roleId, g1.baseline.layer));
    f.registration.manifest.task = f.host.task; f.registration.manifest.role = f.host.role;
    f.registration.manifest.guidance.baselineSha256 = probeHash(f.host.baselineGuidance);
    f.registration.manifest.slots = [f.registration.manifest.slots[0]!, f.registration.manifest.slots[2]!];
    const key = guidanceProbeFixtureKey(f.registration); f.store.register(f.registration, f.host, () => f.host);
    const first = f.store.reserveSession({ key, expectedRevision: 0, host: f.host, now: 100 }, f.revalidate);
    if (first.kind !== "granted") throw new Error("expected baseline");
    f.store.settleSession({ reservation: first.reservation, outcome: "closed_fixture", candidateArtifactSha256: null, now: 100 });
    const rendered = renderGuidanceVariantV1(g1);
    expect(probeHash(g1.candidate.bytes)).toBe(g1.candidate.sha256); expect(probeHash(rendered)).not.toBe(g1.candidate.sha256);
    const child: ProbeChildBinding = { variantId: g1.id, candidateSha256: g1.candidate.sha256, guidanceSha256: probeHash(rendered), guidance: rendered,
      task: f.host.task, role: f.host.role, authoring: "uncontrolled", sourceSessionId: null };
    const before = f.store.integrity(), wrong = { ...child, guidanceSha256: child.candidateSha256 };
    expect(() => f.store.reserveSession({ key, expectedRevision: f.store.read(key)!.receipt.revision, host: f.host, child: wrong, now: 100 }, () => ({ host: f.host, child: wrong }))).toThrow("binding");
    expect(f.store.integrity()).toEqual(before);
    const provider = new FakeGuidanceProbeProvider(), runner = new GuidanceProbeFixtureHost(f.store, { ports: provider, revalidate: () => ({ host: f.host, child }), now: () => 100 });
    await runner.start({ key, expectedRevision: f.store.read(key)!.receipt.revision, host: f.host, child, now: 100 }, new AbortController().signal);
    expect(JSON.parse(provider.launches[0]!.inputFrame).guidance).toBe(rendered);
    expect(JSON.parse(provider.launches[0]!.inputFrame).guidance).not.toBe(g1.candidate.bytes);
    expect(f.store.read(key)!.sessions[1]!.child).toMatchObject({ candidateSha256: g1.candidate.sha256, guidanceSha256: probeHash(rendered), authoring: "uncontrolled" });
  });
  test("lane invalid/oversized fields never launder to a legitimate null slot", () => {
    for (const [column, bad] of [["slot_id", "x".repeat(257)], ["slot_id", 42], ["manifest_id", "x".repeat(65)], ["manifest_id", new Uint8Array([1])]] as const) {
      const f = fixture(); f.register(); f.finish(f.reserve());
      const db = openHubDatabase(f.file); cleanup.push(() => db.close());
      db.query(`UPDATE guidance_probe_lanes SET ${column}=? WHERE project=?`).run(bad, f.key.projectKey);
      expect(() => f.store.integrity()).toThrow("storage");
      expect(() => f.store.reserveSession({ key: f.key, expectedRevision: f.store.read(f.key)!.receipt.revision, host: f.host, now: 100 }, f.revalidate)).toThrow("storage");
    }
    const f = fixture(); f.register(); f.finish(f.reserve());
    expect(f.store.reserveSession({ key: f.key, expectedRevision: f.store.read(f.key)!.receipt.revision, host: f.host, now: 100 }, f.revalidate).kind).toBe("granted");
  });
  test("lane project/reference corruption is rejected by the bounded recovery projection", () => {
    for (const [column, bad] of [["project", "x".repeat(257)], ["project", new Uint8Array([1])], ["manifest_id", probeHash("missing")], ["slot_id", "missing-slot"]] as const) {
      const f = fixture(); f.register(); f.reserve(); const db = openHubDatabase(f.file); cleanup.push(() => db.close());
      db.query(`UPDATE guidance_probe_lanes SET ${column}=? WHERE project=?`).run(bad, f.key.projectKey);
      expect(() => f.store.integrity()).toThrow("storage");
    }
  });
  test("integrity manifest/session/lane passes retain one read snapshot across another connection's commit", () => {
    const f = fixture(); f.register(); const setup = openHubDatabase(f.file); setup.run("PRAGMA journal_mode = WAL"); setup.close();
    const second = new GuidanceProbeStore(f.file, () => f.clock.now); cleanup.push(() => second.close());
    const before = f.store.integrity(), internal = f.store as unknown as { db: Database }, db = internal.db;
    const original = db.query.bind(db), descriptor = Object.getOwnPropertyDescriptor(db, "query"); let inserted = false;
    // Intercept only this owned read, after its real session SELECT. The concurrent write uses the real second connection.
    Object.defineProperty(db, "query", { configurable: true, value: (sql: string) => {
      const statement = original(sql);
      if (!sql.includes("FROM guidance_probe_sessions WHERE")) return statement;
      return Object.create(statement, { all: { value: (...args: Parameters<typeof statement.all>) => {
        const rows = statement.all(...args);
        if (!inserted) { inserted = true; second.reserveSession({ key: f.key, expectedRevision: 0, host: f.host, now: 100 }, f.revalidate); }
        return rows;
      } } });
    } });
    try { expect(f.store.integrity()).toEqual(before); }
    finally { if (descriptor) Object.defineProperty(db, "query", descriptor); else Reflect.deleteProperty(db, "query"); }
    expect(inserted).toBe(true); expect(f.store.integrity().digest).not.toBe(before.digest);
    expect(f.store.read(f.key)!.counters.workerAttempts).toBe(1);
  });
  test("all four workers/five editors share one root and successful slots cannot repeat", () => {
    const f = fixture();
    f.registration.manifest.slots = [
      { id: "baseline", stage: "baseline", role: "worker", arm: "baseline" }, { id: "proposal1", stage: "proposal1", role: "proposal", arm: "none" },
      { id: "candidate1", stage: "candidate1", role: "worker", arm: "candidate1" }, { id: "proposal2", stage: "proposal2", role: "proposal", arm: "none" },
      { id: "candidate2", stage: "candidate2", role: "worker", arm: "candidate2" }, { id: "compose", stage: "compose", role: "compose", arm: "none" },
      { id: "successor", stage: "successor", role: "worker", arm: "successor" }, { id: "select", stage: "select", role: "select", arm: "none" },
      { id: "reflect", stage: "reflect", role: "reflect", arm: "none" } ];
    const key = guidanceProbeFixtureKey(f.registration); f.store.register(f.registration, f.host, () => f.host);
    for (const slot of f.registration.manifest.slots) {
      const guidance = "Existing current candidate.", child: ProbeChildBinding | undefined = slot.role === "worker" && slot.arm !== "baseline"
        ? { variantId: probeHash(slot.id), candidateSha256: probeHash(guidance), guidanceSha256: probeHash(guidance), guidance, task: f.host.task, role: f.host.role, authoring: "uncontrolled", sourceSessionId: null } : undefined;
      const check = () => ({ host: f.host, ...(child ? { child } : {}) });
      const result = f.store.reserveSession({ key, expectedRevision: f.store.read(key)!.receipt.revision, host: f.host, ...(child ? { child } : {}), now: 100 }, check);
      expect(result.kind).toBe("granted"); if (result.kind !== "granted") throw new Error("expected fixture reservation");
      f.store.settleSession({ reservation: result.reservation, outcome: "closed_fixture", candidateArtifactSha256: probeHash(guidance), now: 100 });
    }
    expect(f.store.read(key)!.counters).toMatchObject({ workerAttempts: 4, editorAttempts: 5 });
    expect(f.store.read(key)!.receipt.state).toBe("closed_fixture");
    const terminal = f.store.read(key)!;
    expect(f.store.cancelIntent({ key, expectedRevision: terminal.receipt.revision, host: f.host }, () => f.host).already).toBe(true);
    expect(f.store.read(key)!.cancelRequested).toBe(false);
    expect(() => f.store.reserveSession({ key, expectedRevision: f.store.read(key)!.receipt.revision, host: f.host, now: 100 }, f.revalidate)).toThrow("uncertain");
    expect(f.store.read(key)!.sessions[2]!.child!.authoring).toBe("uncontrolled");
  });
  test("known failure consumes its preregistered retry slot and the same aggregate call/token budgets", () => {
    const f = fixture(), original = f.registration.manifest.slots[0]!;
    f.registration.manifest.slots = [original, { ...original, id: "baseline-retry", retryOf: original.id }, ...f.registration.manifest.slots.slice(1)];
    const key = guidanceProbeFixtureKey(f.registration); f.store.register(f.registration, f.host, () => f.host);
    for (const outcome of ["failed_known", "closed_fixture"] as const) {
      const result = f.store.reserveSession({ key, expectedRevision: f.store.read(key)!.receipt.revision, host: f.host, now: 100 }, f.revalidate);
      expect(result.kind).toBe("granted"); if (result.kind !== "granted") throw new Error("expected fixture reservation");
      const admission = { ...f.effect(result.reservation), reservation: result.reservation };
      f.store.admitEffect(admission, f.revalidate); f.usage(admission, 10); f.store.settleEffect({ admission, outcome: "settled" });
      f.store.settleSession({ reservation: result.reservation, outcome, candidateArtifactSha256: null, now: 100 });
    }
    expect(f.store.read(key)!.counters).toMatchObject({ workerAttempts: 2, modelCalls: 2, tokensReserved: 40, tokensObservedKnown: 20 });
    expect(f.store.read(key)!.sessions.slice(0, 2).map(item => item.state)).toEqual(["failed_known", "closed_fixture"]);
  });
  test("two adjacent known failures followed by success complete the four-worker zero-editor chain without refunds", () => {
    const f = fixture(), baseline = f.registration.manifest.slots[0]!, candidate = f.registration.manifest.slots[2]!;
    f.registration.manifest.slots = [baseline, { ...baseline, id: "retry1", retryOf: baseline.id }, { ...baseline, id: "retry2", retryOf: "retry1" }, candidate];
    const key = guidanceProbeFixtureKey(f.registration); f.store.register(f.registration, f.host, () => f.host);
    const child: ProbeChildBinding = { variantId: probeHash("existing-g1"), candidateSha256: probeHash("raw-role"), guidanceSha256: probeHash("rendered-role"), guidance: "rendered-role",
      task: f.host.task, role: f.host.role, authoring: "uncontrolled", sourceSessionId: null };
    for (const [index, outcome] of ["failed_known", "failed_known", "closed_fixture", "closed_fixture"].entries()) {
      const selected = index === 3 ? child : undefined, check = () => ({ host: f.host, ...(selected ? { child: selected } : {}) });
      const result = f.store.reserveSession({ key, expectedRevision: f.store.read(key)!.receipt.revision, host: f.host, ...(selected ? { child: selected } : {}), now: 100 }, check);
      if (result.kind !== "granted") throw new Error("expected preregistered attempt");
      f.store.settleSession({ reservation: result.reservation, outcome: outcome as "failed_known" | "closed_fixture", candidateArtifactSha256: null, now: 100 });
    }
    expect(f.store.read(key)!.receipt.state).toBe("closed_fixture");
    expect(f.store.read(key)!.sessions.map(item => item.state)).toEqual(["failed_known", "failed_known", "closed_fixture", "closed_fixture"]);
    expect(f.store.read(key)!.counters).toMatchObject({ workerAttempts: 4, editorAttempts: 0 });
    const db = openHubDatabase(f.file); cleanup.push(() => db.close());
    expect((db.query("SELECT COUNT(*) AS n FROM guidance_probe_lanes WHERE project=?").get(key.projectKey) as { n: number }).n).toBe(0);
    const next = copy(f.registration); next.manifest.experimentId = "independent-after-completed-chain";
    const nextKey = guidanceProbeFixtureKey(next); f.store.register(next, f.host, () => f.host);
    expect(f.store.reserveSession({ key: nextKey, expectedRevision: 0, host: f.host, now: 100 }, f.revalidate).kind).toBe("granted");
    expect(f.store.read(key)!.counters.workerAttempts).toBe(4);
  });
  test("original success marks only its preregistered retries not-needed without charge and waits for explicit candidate start", () => {
    const f = fixture(), baseline = f.registration.manifest.slots[0]!, candidate = f.registration.manifest.slots[2]!;
    f.registration.manifest.slots = [baseline, { ...baseline, id: "retry1", retryOf: baseline.id }, { ...baseline, id: "retry2", retryOf: "retry1" }, candidate];
    const key = guidanceProbeFixtureKey(f.registration); f.store.register(f.registration, f.host, () => f.host);
    const first = f.store.reserveSession({ key, expectedRevision: 0, host: f.host, now: 100 }, f.revalidate);
    if (first.kind !== "granted") throw new Error("expected baseline");
    const charged = copy(f.store.read(key)!.counters);
    f.store.settleSession({ reservation: first.reservation, outcome: "closed_fixture", candidateArtifactSha256: null, now: 100 });
    const waiting = f.store.read(key)!;
    expect(waiting.receipt.state).toBe("active"); expect(waiting.notNeeded).toBe(2); expect(waiting.counters).toEqual(charged);
    expect(waiting.sessions.map(item => item.state)).toEqual(["closed_fixture", "not_needed", "not_needed", "planned"]);
    for (const skipped of waiting.sessions.slice(1, 3)) expect(skipped).toMatchObject({ generation: 0, revision: 0, candidateArtifactSha256: null });
    const child: ProbeChildBinding = { variantId: probeHash("current-candidate"), candidateSha256: probeHash("raw-role"), guidanceSha256: probeHash("rendered-role"), guidance: "rendered-role",
      task: f.host.task, role: f.host.role, authoring: "uncontrolled", sourceSessionId: null };
    const next = f.store.reserveSession({ key, expectedRevision: waiting.receipt.revision, host: f.host, child, now: 100 }, () => ({ host: f.host, child }));
    if (next.kind !== "granted") throw new Error("expected explicit candidate"); expect(next.reservation.slotId).toBe(candidate.id);
    f.store.settleSession({ reservation: next.reservation, outcome: "closed_fixture", candidateArtifactSha256: null, now: 100 });
    expect(f.store.read(key)!.receipt.state).toBe("closed_fixture"); expect(f.store.read(key)!.notNeeded).toBe(2);
    expect(f.store.read(key)!.counters).toMatchObject({ workerAttempts: 2, editorAttempts: 0, modelCalls: 0, toolCalls: 0 });
  });
  test("exhausted known-failure retry chain ends failed and releases without starting later stages", () => {
    const f = fixture(), baseline = f.registration.manifest.slots[0]!, candidate = f.registration.manifest.slots[2]!;
    f.registration.manifest.slots = [baseline, { ...baseline, id: "retry1", retryOf: baseline.id }, { ...baseline, id: "retry2", retryOf: "retry1" }, candidate];
    const key = guidanceProbeFixtureKey(f.registration); f.store.register(f.registration, f.host, () => f.host);
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = f.store.reserveSession({ key, expectedRevision: f.store.read(key)!.receipt.revision, host: f.host, now: 100 }, f.revalidate);
      if (result.kind !== "granted") throw new Error("expected preregistered attempt");
      f.store.settleSession({ reservation: result.reservation, outcome: "failed_known", candidateArtifactSha256: null, now: 100 });
    }
    const failed = f.store.read(key)!;
    expect(failed.receipt.state).toBe("failed_fixture"); expect(failed.notNeeded).toBe(0);
    expect(failed.sessions.map(item => item.state)).toEqual(["failed_known", "failed_known", "failed_known", "planned"]);
    expect(failed.counters).toMatchObject({ workerAttempts: 3, editorAttempts: 0 });
    expect(() => f.store.reserveSession({ key, expectedRevision: failed.receipt.revision, host: f.host, now: 100 }, f.revalidate)).toThrow("uncertain");
    const next = copy(f.registration); next.manifest.experimentId = "independent-after-known-failure";
    const nextKey = guidanceProbeFixtureKey(next); f.store.register(next, f.host, () => f.host);
    expect(f.store.reserveSession({ key: nextKey, expectedRevision: 0, host: f.host, now: 100 }, f.revalidate).kind).toBe("granted");
    expect(f.store.read(key)!.counters.workerAttempts).toBe(3);
  });
  test("unresolved or unknown adjacent retry chains retain the lane and block another experiment", () => {
    const f = fixture(), baseline = f.registration.manifest.slots[0]!, candidate = f.registration.manifest.slots[2]!;
    f.registration.manifest.slots = [baseline, { ...baseline, id: "retry1", retryOf: baseline.id }, { ...baseline, id: "retry2", retryOf: "retry1" }, candidate];
    const key = guidanceProbeFixtureKey(f.registration); f.store.register(f.registration, f.host, () => f.host);
    for (let index = 0; index < 2; index++) {
      const result = f.store.reserveSession({ key, expectedRevision: f.store.read(key)!.receipt.revision, host: f.host, now: 100 }, f.revalidate);
      if (result.kind !== "granted") throw new Error("expected failed attempt");
      f.store.settleSession({ reservation: result.reservation, outcome: "failed_known", candidateArtifactSha256: null, now: 100 });
    }
    const next = copy(f.registration); next.manifest.experimentId = "blocked-by-unresolved-chain";
    const nextKey = guidanceProbeFixtureKey(next); f.store.register(next, f.host, () => f.host);
    expect(f.store.read(key)!.receipt.state).toBe("active");
    expect(() => f.store.reserveSession({ key: nextKey, expectedRevision: 0, host: f.host, now: 100 }, f.revalidate)).toThrow("uncertain");
    const result = f.store.reserveSession({ key, expectedRevision: f.store.read(key)!.receipt.revision, host: f.host, now: 100 }, f.revalidate);
    if (result.kind !== "granted") throw new Error("expected last preregistered retry");
    f.store.settleSession({ reservation: result.reservation, outcome: "unknown", candidateArtifactSha256: null, now: 100 });
    expect(f.store.read(key)!.sessions.map(item => item.state)).toEqual(["failed_known", "failed_known", "unknown_held", "planned"]);
    expect(f.store.read(key)!.counters).toMatchObject({ workerAttempts: 3, editorAttempts: 0 });
    expect(() => f.store.reserveSession({ key: nextKey, expectedRevision: 0, host: f.host, now: 100 }, f.revalidate)).toThrow("uncertain");
  });
  test("oversize stored JSON is refused before hydration and recovery digest detects persisted state", () => {
    const f = fixture(); f.register(); const before = f.store.integrity(); f.reserve(); expect(f.store.integrity().digest).not.toBe(before.digest);
    const db = openHubDatabase(f.file); cleanup.push(() => db.close());
    db.query("UPDATE guidance_probe_sessions SET body=? WHERE project=? AND manifest_id=? AND ordinal=0").run("x".repeat(GUIDANCE_PROBE_SESSION_BYTES + 1), f.key.projectKey, f.key.id);
    expect(() => f.store.read(f.key)).toThrow("storage"); expect(() => f.store.integrity()).toThrow("storage");
  });
});

describe("T2 owner-prepared input and compound resources", () => {
  test("resource overflow rolls back call, token and every coupled reservation before effects", () => {
    const f = fixture(); f.register(); const reservation = f.reserve();
    const before = f.store.integrity(), totals = f.store.read(f.key)!.counters;
    const over = { ...f.effect(reservation), charges: { inputBytes: 20, scratchBytes: 1001, outputBytes: 5 } };
    expect(() => f.store.admitEffect(over, f.revalidate)).toThrow("budget");
    expect(f.store.integrity()).toEqual(before);
    expect(f.store.read(f.key)!.counters).toEqual(totals);
    const input = { ...f.effect(reservation), charges: { inputBytes: 20, scratchBytes: 100, outputBytes: 5 } };
    const grant = f.store.admitEffect(input, f.revalidate);
    expect(grant.kind).toBe("granted");
    if (grant.kind !== "granted") throw new Error("expected compound reservation");
    input.charges.scratchBytes = 999;
    expect(grant.admission.charges).toEqual({ inputBytes: 20, scratchBytes: 100, outputBytes: 5 });
    f.usage(grant.admission, 10); f.store.settleEffect({ admission: grant.admission, outcome: "settled" });
    expect(f.store.read(f.key)!.counters).toMatchObject({ modelCalls: 1, tokensReserved: 20, scratchBytes: 100, outputBytes: 5 });
    const paid = f.store.read(f.key)!.counters;
    expect(f.store.admitEffect(grant.admission, f.revalidate).kind).toBe("existing");
    expect(f.store.read(f.key)!.counters).toEqual(paid);
    expect(() => f.store.admitEffect(input, f.revalidate)).toThrow("changed");
  });

  test("host setup spends storage without synthetic calls; actual initial frame and later input are charged once", async () => {
    const f = fixture(); f.register(); const provider = new FakeGuidanceProbeProvider();
    const frame = JSON.stringify({ model: GUIDANCE_PROBE_MODEL, messages: [{ role: "system", content: "mandatory host fixture policy" }, { role: "user", content: "actual complete fixture request" }], tools: [] });
    const nonGuidance = probeHash("complete request with its guidance slot empty");
    const before = f.store.read(f.key)!.counters.inputBytes;
    let copies = 0;
    provider.script = async (input, effects) => {
      expect(input.inputFrame).toBe(frame); expect(input.inputSha256).toBe(probeHash(frame));
      expect(input.nonGuidanceInputSha256).toBe(nonGuidance);
      const setup = { sequence: 0, unit: "resources" as const, descriptorSha256: probeHash("host setup"), charges: { scratchBytes: 100 } };
      await effects.runEffect(setup, async () => { copies++; return fakeEffectValue(setup, true, 0); });
      expect(f.store.read(f.key)!.counters).toMatchObject({ modelCalls: 0, toolCalls: 0, scratchBytes: 100 });
      expect((await effects.runEffect(setup, async () => { copies++; return fakeEffectValue(setup, true, 0); })).kind).toBe("existing");
      for (const sequence of [1, 2]) {
        const request = { sequence, unit: "model_calls" as const, reservedTokens: 20, descriptorSha256: probeHash(`actual request ${sequence}`), ...(sequence === 2 ? { charges: { inputBytes: 30 } } : {}) };
        await effects.runEffect(request, async () => fakeEffectValue(request, "answer", 10));
      }
      return { reservation: input.reservation, outcome: "closed_fixture", servedModel: GUIDANCE_PROBE_MODEL,
        inputFrameHash: input.inputSha256, workerEffectiveInputHash: input.inputSha256,
        nonGuidanceInputSha256: input.nonGuidanceInputSha256, candidateArtifactSha256: null, usage: "known_fixture" };
    };
    const host = new GuidanceProbeFixtureHost(f.store, { ports: provider, revalidate: f.revalidate, now: () => 100,
      prepareWorkerFrame: async () => ({ inputFrame: frame, nonGuidanceInputSha256: nonGuidance }) });
    const result = await host.start({ key: f.key, expectedRevision: 0, host: f.host, now: 100 }, new AbortController().signal);
    expect(result.state).toBe("active"); expect(copies).toBe(1);
    expect(f.store.read(f.key)!.counters).toMatchObject({ modelCalls: 2, toolCalls: 0, scratchBytes: 100, inputBytes: before + Buffer.byteLength(frame) + 30 });
    expect(f.store.read(f.key)!.sessions[0]!.coverage.coverageVerified).toBe(true);
  });

  test("async preparation revalidates authority before reservation and malformed custom frames never fall back", async () => {
    for (const malformed of [false, true]) {
      const f = fixture(); f.register(); const provider = new FakeGuidanceProbeProvider();
      let current = true;
      const host = new GuidanceProbeFixtureHost(f.store, { ports: provider,
        revalidate: () => { if (!current) throw new GuidanceProbeError("changed"); return f.revalidate(); }, now: () => 100,
        prepareWorkerFrame: async () => {
          if (!malformed) current = false;
          return malformed ? undefined as never : { inputFrame: "full request", nonGuidanceInputSha256: probeHash("fixed") };
        } });
      await expect(host.start({ key: f.key, expectedRevision: 0, host: f.host, now: 100 }, new AbortController().signal)).rejects.toThrow(malformed ? "invalid" : "changed");
      expect(provider.launches).toHaveLength(0);
      expect(f.store.read(f.key)!.counters.workerAttempts).toBe(0);
    }
  });
});
