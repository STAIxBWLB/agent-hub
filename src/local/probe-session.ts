import { createHash } from "node:crypto";
import { LocalPeer, localProbeFingerprints, prepareLocalProbeInput } from "../adapters/local-worker.ts";
import { GUIDANCE_PROBE_LIMITS, GUIDANCE_PROBE_MODEL, guidanceProbeCanonical, guidanceProbeManifestKey, probeHash,
  type ProbeFakeLaunch, type ProbeFakeObservation, type ProbeReservation, type ProbeResourceCharges, type ProbeSlot, type ProbeStoredState } from "../hub/guidance-probes.ts";
import { materializeProbeWorkspace, probeWorkspaceCurrent, PROBE_WORKSPACE_LIMITS,
  type ProbeWorkspace } from "./probe-workspace.ts";
import { ProbeConfinementError, requireProbeConfinement, verifyProbeConfinement, type ProbeConfinement } from "./probe-sandbox.ts";
import { ProbeLocalError, probeLocalEffect, type ProbeLocalAdapter, type ProbeLocalAdapterOptions, type ProbeLocalEffectScope,
  type ProbeLocalSource, type ProbePreparedLocalInput } from "./probe-types.ts";

interface Prepared {
  state: ProbeStoredState;
  slot: ProbeSlot;
  guidance: string;
  source: ProbeLocalSource;
  input: ProbePreparedLocalInput;
}
interface Owned {
  reservation: ProbeReservation;
  controller: AbortController;
  promise?: Promise<ProbeFakeObservation>;
  peer?: LocalPeer;
  workspace?: ProbeWorkspace;
  confinement?: ProbeConfinement;
  closeUnknown?: () => Promise<void>;
  closed: boolean;
  closeFailed?: boolean;
}
const bytesHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const reservationKey = (reservation: ProbeReservation) => probeHash(guidanceProbeCanonical(reservation));
const positiveCharge = (charges: ProbeResourceCharges) => Object.values(charges).some(value => typeof value === "number" && value > 0);
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Constructor-only host adapter. No runtime, configuration or wire path selects this factory. */
export function createGuidanceProbeLocalAdapter(options: ProbeLocalAdapterOptions): ProbeLocalAdapter {
  if (options.fixture && options.fixture.evidence !== "fixture_only") throw new ProbeLocalError("invalid");
  const current = options.current.bind(options), resolveInput = options.resolveInput.bind(options), permit = options.permit.bind(options), omni = options.omni;
  const workspaceOwned = options.workspaceOwned?.bind(options);
  const fixture = options.fixture && Object.freeze({ materialize: options.fixture.materialize.bind(options.fixture), confine: options.fixture.confine.bind(options.fixture) });
  const config = Object.freeze({ maxSteps: options.config.maxSteps, maxOutputTokens: options.config.maxOutputTokens,
    ...(options.config.tokenUpperBound === undefined ? {} : { tokenUpperBound: options.config.tokenUpperBound }) });
  const prepared = new Map<string, Prepared>(), owned = new Map<string, Owned>(), completed = new WeakSet<ProbeReservation>();
  const prepare = async (state: ProbeStoredState, slot: ProbeSlot, guidance: string): Promise<Prepared> => {
    current();
    state = freeze(JSON.parse(JSON.stringify(state)) as ProbeStoredState);
    slot = freeze({ ...slot });
    const resolved = await resolveInput(state, slot); current();
    const source: ProbeLocalSource = { files: resolved.files.map(file => ({ dataId: file.dataId, relative: file.relative, sha256: file.sha256, bytes: Buffer.from(file.bytes) })),
      verifySource: resolved.verifySource, ...(resolved.sourceTree ? { sourceTree: { repo: resolved.sourceTree.repo, tree: { ...resolved.sourceTree.tree }, files: resolved.sourceTree.files.map(file => ({ ...file })) } } : {}) };
    const ids = new Set<string>(), policy = state.registration.snapshots.dataPolicy, role = policy.roles[slot.role];
    for (const file of source.files) {
      const declared = policy.admittedData.find(item => item.id === file.dataId);
      if (ids.has(file.dataId) || !role.dataIds.includes(file.dataId) || !declared || declared.sha256 !== file.sha256
        || declared.bytes !== file.bytes.byteLength || bytesHash(file.bytes) !== file.sha256 || file.bytes.byteLength > PROBE_WORKSPACE_LIMITS.fileBytes)
        throw new ProbeLocalError("invalid");
      ids.add(file.dataId);
    }
    if (source.sourceTree && guidanceProbeCanonical(source.sourceTree.tree) !== guidanceProbeCanonical(state.registration.manifest.inputs.codeTree))
      throw new ProbeLocalError("drift");
    const descriptors = source.files.map(file => ({ dataId: file.dataId, relative: file.relative, sha256: file.sha256, bytes: file.bytes.byteLength }));
    const input = freeze(prepareLocalProbeInput(state, slot, guidance, descriptors, config)), record = { state, slot, guidance, source, input };
    if (slot.role === "worker" && slot.arm !== "baseline") {
      const baseline = [...state.sessions].reverse().find(session => session.state === "closed_fixture" && session.coverage.coverageVerified
        && state.registration.manifest.slots.some(item => item.id === session.slotId && item.role === "worker" && item.arm === "baseline"));
      const baselineSlot = baseline && state.registration.manifest.slots.find(item => item.id === baseline.slotId);
      if (!baselineSlot || baseline?.state !== "closed_fixture" || !baseline.coverage.coverageVerified
        || baseline.coverage.inputFrameSha256 !== prepareLocalProbeInput(state, baselineSlot, state.binding.baselineGuidance, descriptors, config).inputSha256)
        throw new ProbeLocalError("drift");
    }
    const key = `${guidanceProbeManifestKey(state.registration.manifest)}:${slot.id}`;
    prepared.delete(key); prepared.set(key, record);
    // Only preparation entries are evicted; no retained execution, budget or experiment is reset.
    while (prepared.size > GUIDANCE_PROBE_LIMITS.slots) prepared.delete(prepared.keys().next().value!);
    return record;
  };
  const close = async (entry: Owned, retry = false): Promise<void> => {
    if (entry.closed) return;
    if (entry.closeFailed && !retry) throw new ProbeLocalError("interrupted");
    try {
      if (entry.peer) await entry.peer.stopProbe();
      else if (entry.confinement) await entry.confinement.stop();
      if (entry.closeUnknown) await entry.closeUnknown();
      entry.closed = true;
    } catch { entry.closeFailed = true; throw new ProbeLocalError("interrupted"); }
  };
  const observation = (input: ProbeFakeLaunch, ready: Prepared, servedModel: string | null, outcome: ProbeFakeObservation["outcome"], usage: ProbeFakeObservation["usage"]): ProbeFakeObservation => ({
    reservation: input.reservation, outcome, servedModel, inputFrameHash: ready.input.inputSha256,
    workerEffectiveInputHash: input.slot.role === "worker" ? ready.input.inputSha256 : null,
    nonGuidanceInputSha256: input.slot.role === "worker" ? ready.input.nonGuidanceInputSha256 : null,
    candidateArtifactSha256: null, usage,
  });
  return {
    prepareWorkerFrame: async (state, slot, guidance) => {
      const record = await prepare(state, slot, guidance);
      return { inputFrame: record.input.inputFrame, nonGuidanceInputSha256: record.input.nonGuidanceInputSha256 };
    },
    prepareEditorFrame: async (state, slot) => (await prepare(state, slot, state.binding.baselineGuidance)).input.inputFrame,
    ports: {
      launch(input, effects, signal) {
        current();
        const key = `${guidanceProbeManifestKey(input.manifest)}:${input.slot.id}`, ready = prepared.get(key), id = reservationKey(input.reservation);
        if (!ready || owned.has(id) || signal.aborted || input.purpose !== "guidance_probe" || ready.input.role !== input.slot.role
          || input.inputFrame !== ready.input.inputFrame || input.inputSha256 !== ready.input.inputSha256
          || input.slot.role === "worker" && input.nonGuidanceInputSha256 !== ready.input.nonGuidanceInputSha256)
          return Promise.reject(new ProbeLocalError("drift"));
        prepared.delete(key);
        const entry: Owned = { reservation: input.reservation, controller: new AbortController(), closed: false };
        owned.set(id, entry);
        const abort = () => entry.controller.abort(); signal.addEventListener("abort", abort, { once: true });
        let sequence = 0;
        const sourceCurrent = () => {
          if (signal.aborted || entry.controller.signal.aborted || entry.closed) throw new ProbeLocalError("interrupted");
          effects.current(); current();
          const actual = localProbeFingerprints(config), expected = input.manifest.runtime;
          if (actual.runtimeSha256 !== expected.runtimeSha256 || actual.toolsetSha256 !== expected.toolsetSha256 || actual.modelConfigSha256 !== expected.modelConfigSha256)
            throw new ProbeLocalError("drift");
        };
        const accounting: ProbeLocalEffectScope = { effects, next: () => sequence++, current: () => {
          sourceCurrent();
          if (entry.workspace && !fixture) {
            if (entry.confinement) requireProbeConfinement(entry.confinement, entry.workspace);
            else probeWorkspaceCurrent(entry.workspace);
          }
        } };
        const reserve = async (charges: ProbeResourceCharges, descriptor: string): Promise<void> => {
          if (!positiveCharge(charges)) return;
          await probeLocalEffect(accounting, "resources", descriptor, charges, undefined, async () => ({ value: undefined, usage: 0 }));
        };
        entry.promise = Promise.resolve().then(async () => {
          accounting.current();
          const workspaceInput = { role: input.slot.role, policy: ready.state.registration.snapshots.dataPolicy, files: ready.source.files,
            ...(ready.source.sourceTree ? { sourceTree: ready.source.sourceTree } : {}), verifySource: ready.source.verifySource,
            reserveStorage: (bytes: number) => reserve({ scratchBytes: bytes }, "probe-workspace-storage"), current: sourceCurrent,
            maxBytes: PROBE_WORKSPACE_LIMITS.workspaceBytes };
          entry.workspace = await (fixture ? fixture.materialize(workspaceInput) : materializeProbeWorkspace(workspaceInput));
          workspaceOwned?.(entry.workspace);
          accounting.current();
          if (entry.workspace.role !== input.slot.role || JSON.stringify(entry.workspace.files) !== JSON.stringify(ready.input.files)) throw new ProbeLocalError("drift");
          entry.confinement = await (fixture ? fixture.confine(entry.workspace) : verifyProbeConfinement(entry.workspace, entry.controller.signal));
          if (entry.confinement.workspace !== entry.workspace) throw new ProbeLocalError("drift");
          accounting.current();
          entry.peer = new LocalPeer("local", { cwd: entry.workspace.root, omni, fixedModel: GUIDANCE_PROBE_MODEL,
            maxSteps: config.maxSteps, tools: { deny: [], permit } }, entry.confinement, fixture ? "fixture_only" : undefined);
          const result = await entry.peer.runProbe({ purpose: "guidance_probe", prepared: ready.input, workspace: entry.workspace,
            confinement: entry.confinement, config, accounting, reserve }, entry.controller.signal);
          accounting.current(); await close(entry);
          effects.current(); current();
          return observation(input, ready, result.servedModel, result.complete ? "closed_fixture" : "failed_known", result.usageKnown ? "known_fixture" : "unknown");
        }).catch(async error => {
          if (error instanceof ProbeConfinementError) entry.closeUnknown = error.stop;
          try { await close(entry); }
          catch { throw new ProbeLocalError("interrupted"); }
          return observation(input, ready, entry.peer?.probeObservation().servedModel ?? null, "unknown", "unknown");
        }).finally(() => {
          signal.removeEventListener("abort", abort);
          if (entry.closed) { completed.add(entry.reservation); owned.delete(id); }
        });
        return entry.promise;
      },
      async stop(input) {
        const entry = owned.get(reservationKey(input.reservation));
        if (!entry) return { reservation: input.reservation, stopped: completed.has(input.reservation) ? "known_fixture" : "unknown" };
        entry.controller.abort();
        await entry.promise?.catch(() => {});
        await close(entry, true);
        completed.add(entry.reservation); owned.delete(reservationKey(entry.reservation));
        return { reservation: input.reservation, stopped: "known_fixture" };
      },
    },
  };
}
