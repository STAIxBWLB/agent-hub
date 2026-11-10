import { GUIDANCE_PROBE_MODEL, guidanceProbeCanonical, guidanceProbeManifestKey, probeHash,
  type ProbeRegistrationV1, type ProbeHostBinding, type ProbeDataPolicyV1, type ProbeSlot,
  type GuidanceProbeFakePorts, type ProbeFakeLaunch, type ProbeFakeEffects, type ProbeFakeObservation,
  type ProbeFakeEffectRequest, type ProbeFakeEffectValue } from "../../src/hub/guidance-probes.ts";

export function guidanceProbeFixture(): { registration: ProbeRegistrationV1; host: ProbeHostBinding } {
  const policy: ProbeDataPolicyV1 = { v: 1, allowedWrites: [{ root: "output", relative: "result.txt" }], admittedData: [], roles: {
    worker: { dataIds: [], guidanceOnlyExperience: true }, proposal: { dataIds: [], improverContext: false },
    compose: { dataIds: [], improverContext: false }, select: { dataIds: [], anonymizedDeliverables: true }, reflect: { dataIds: [], closedRoundOnly: true } } };
  const host: ProbeHostBinding = { projectKey: "fixture-project", actor: "codex", task: { id: 1, created: 10, flowRevision: 2 },
    role: { id: "fixture-role", layer: "project", baselineSha256: probeHash("catalog") }, baselineGuidance: "Baseline guidance.", sessionGeneration: 1, nativeSession: "fixture-session" };
  const snapshots = { task: "Read code.\r\nconst value = 1;\tKeep exact bytes.\n", baselineContext: "Fixed context.", dataPolicy: policy, systemPolicy: "Fixture system policy." };
  const reference = (text: string) => ({ sha256: probeHash(text), bytes: Buffer.byteLength(text) });
  const slots: ProbeSlot[] = [ { id: "baseline", stage: "baseline", role: "worker", arm: "baseline" },
    { id: "proposal1", stage: "proposal1", role: "proposal", arm: "none" }, { id: "candidate1", stage: "candidate1", role: "worker", arm: "candidate1" },
    { id: "select", stage: "select", role: "select", arm: "none" }, { id: "reflect", stage: "reflect", role: "reflect", arm: "none" } ];
  return { host, registration: { manifest: { v: 1, projectKey: host.projectKey, experimentId: "fixture-experiment", task: host.task, role: host.role,
    inputs: { task: reference(snapshots.task), baselineContext: reference(snapshots.baselineContext), dataPolicy: reference(guidanceProbeCanonical(policy)),
      systemPolicy: reference(snapshots.systemPolicy), codeTree: { objectFormat: "sha1", oid: "a".repeat(40) } },
    runtime: { runtimeSha256: probeHash("runtime"), toolsetSha256: probeHash("tools"), modelConfigSha256: probeHash("config") },
    model: { requested: GUIDANCE_PROBE_MODEL, expectedServed: GUIDANCE_PROBE_MODEL }, guidance: { baselineSha256: probeHash(host.baselineGuidance) }, slots,
    limits: { modelCalls: 100, toolCalls: 100, elapsedMs: 10000, tokens: 1000, inputBytes: 500000, scratchBytes: 1000, outputBytes: 1000 } }, snapshots } };
}
export const guidanceProbeFixtureKey = (registration: ProbeRegistrationV1) => ({ projectKey: registration.manifest.projectKey, id: guidanceProbeManifestKey(registration.manifest) });
export function fakeEffectValue<T>(request: ProbeFakeEffectRequest, value: T, usage: number | null): ProbeFakeEffectValue<T> {
  return { value, usage, observationSha256: probeHash(guidanceProbeCanonical({ request, usage })) };
}
/** A test-owned provider. It has no network, model, process, account or Store port. */
export class FakeGuidanceProbeProvider implements GuidanceProbeFakePorts {
  readonly launches: ProbeFakeLaunch[] = [];
  readonly stops: string[] = [];
  script?: (input: ProbeFakeLaunch, effects: ProbeFakeEffects, signal: AbortSignal) => Promise<ProbeFakeObservation>;
  async launch(input: ProbeFakeLaunch, effects: ProbeFakeEffects, signal: AbortSignal): Promise<ProbeFakeObservation> {
    this.launches.push(input);
    if (this.script) return this.script(input, effects, signal);
    const request: ProbeFakeEffectRequest = { sequence: 0, unit: "model_calls", descriptorSha256: probeHash("fake-model-call"), reservedTokens: 20 };
    await effects.runEffect(request, async () => fakeEffectValue(request, "fixture result", 10));
    return { reservation: input.reservation, outcome: "closed_fixture", servedModel: GUIDANCE_PROBE_MODEL,
      inputFrameHash: input.inputSha256, workerEffectiveInputHash: input.slot.role === "worker" ? input.inputSha256 : null,
      nonGuidanceInputSha256: input.slot.role === "worker" ? input.nonGuidanceInputSha256 : null,
      candidateArtifactSha256: null, usage: "known_fixture" };
  }
  async stop(input: { reservation: ProbeFakeLaunch["reservation"] }): Promise<{ reservation: ProbeFakeLaunch["reservation"]; stopped: "known_fixture" }> {
    this.stops.push(input.reservation.slotId); return { reservation: input.reservation, stopped: "known_fixture" };
  }
}
