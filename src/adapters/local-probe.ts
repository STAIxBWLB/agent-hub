import { createHash } from "node:crypto";
import { LocalPeer, localProbeFingerprints, prepareLocalProbeInput } from "./local-worker.ts";
import { GUIDANCE_PROBE_LIMITS, GUIDANCE_PROBE_MODEL, guidanceProbeCanonical, guidanceProbeManifestKey, probeHash,
  type ProbeFakeLaunch, type ProbeFakeObservation, type ProbeMeasuredSession, type ProbeReceiptLimit, type ProbeReservation, type ProbeRetainedRecord, type ProbeResourceCharges, type ProbeSlot, type ProbeStoredState } from "../hub/guidance-probes.ts";
import { collectProbeOutput, materializeProbeWorkspace, probeWorkspaceCurrent, PROBE_WORKSPACE_LIMITS, removeRetained, retainProbeOutput,
  type ProbeWorkspace } from "../local/probe-workspace.ts";
import { ProbeConfinementError, requireProbeConfinement, verifyProbeConfinement, type ProbeConfinement } from "../local/probe-sandbox.ts";
import { ProbeLocalError, probeLocalEffect, type ProbeLocalAdapter, type ProbeLocalAdapterOptions, type ProbeLocalEffectScope,
  type ProbeLocalSource, type ProbePreparedLocalInput } from "../local/probe-types.ts";

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
  /** Output collected and retained once, after the stop reported quiescence and before the host releases the workspace. */
  harvest?: { output: ProbeMeasuredSession["output"]; scratchBytes: number; limits: ProbeReceiptLimit[]; retained?: ProbeMeasuredSession["retained"] };
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
  const retentionRoot = options.retentionRoot;
  const fixture = options.fixture && Object.freeze({ materialize: options.fixture.materialize.bind(options.fixture), confine: options.fixture.confine.bind(options.fixture) });
  const config = Object.freeze({ maxSteps: options.config.maxSteps, maxOutputTokens: options.config.maxOutputTokens,
    ...(options.config.tokenUpperBound === undefined ? {} : { tokenUpperBound: options.config.tokenUpperBound }) });
  const prepared = new Map<string, Prepared>(), owned = new Map<string, Owned>(), completed = new WeakSet<ProbeReservation>();
  // Every retention directory this adapter created, by canonical record. `discardRetained` removes only a record that is still exactly one of these: the host
  // can hand back nothing else, so a forged or altered record never reaches a delete. Removal is by the identity captured at creation (`removeRetained`).
  const retainedHere = new Map<string, ProbeRetainedRecord>();
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
  /**
   * Collect, then retain, the declared output. This runs only AFTER `close` returned: the peer and the confinement have then reported quiescence, so no
   * child can still be writing (the contract's Sealing order), and before the host releases the workspace it owns. When the stop failed or is uncertain
   * nothing is read at all: the output of a process tree that may still be running is not evidence. It never throws: a failure is recorded as a limit,
   * which can only keep the receipt from being a success. The declared caps hold here too: past either, nothing is retained and the receipt carries
   * `storage_over_cap`.
   */
  const harvestOutput = (entry: Owned, ready: Prepared): void => {
    if (entry.harvest || !entry.workspace) return;
    if (!entry.closed || entry.closeFailed) { entry.harvest = { output: { v: 1, entries: [], excluded: [], totalBytes: 0 }, scratchBytes: 0, limits: ["output_truncated"] }; return; }
    const limits = ready.state.registration.manifest.limits;
    try {
      const collected = collectProbeOutput(entry.workspace, limits.outputBytes);
      const harvest: NonNullable<Owned["harvest"]> = { output: collected.manifest, scratchBytes: collected.scratchBytes, limits: [] };
      // Scratch deeper than the walk limit was not fully measured: treat its size as unknown, which is over the cap.
      const over = collected.scratchUnmeasured || collected.scratchBytes > limits.scratchBytes || collected.manifest.totalBytes > limits.outputBytes;
      if (over) harvest.limits.push("storage_over_cap");
      else if (retentionRoot && collected.manifest.entries.length > 0) {
        try {
          harvest.retained = retainProbeOutput(entry.workspace, collected, retentionRoot);
          retainedHere.set(guidanceProbeCanonical(harvest.retained), harvest.retained);
          // The host discards right after the launch returns, so only recent records matter; a sealed one is never asked for again. Bounded, oldest first.
          while (retainedHere.size > GUIDANCE_PROBE_LIMITS.slots) retainedHere.delete(retainedHere.keys().next().value!);
        } catch { harvest.limits.push("output_truncated"); }
      }
      entry.harvest = harvest;
    } catch { entry.harvest = { output: { v: 1, entries: [], excluded: [], totalBytes: 0 }, scratchBytes: 0, limits: ["output_truncated"] }; }
  };
  /** The host's own fingerprints at seal time, never the declaration's. Null when they cannot be read, which the Store treats as unverified coverage. */
  const hostRuntime = (): ProbeMeasuredSession["runtime"] => {
    try { const actual = localProbeFingerprints(config); return { runtimeSha256: actual.runtimeSha256, toolsetSha256: actual.toolsetSha256, modelConfigSha256: actual.modelConfigSha256 }; }
    catch { return null; }
  };
  const measuredSession = (entry: Owned, servedModel: string | null, flags: { unavailable: boolean }): Omit<ProbeMeasuredSession, "startedAt"> => ({
    servedModel, workerEffectiveInputSha256: null, nonGuidanceInputSha256: null, runtime: hostRuntime(),
    teardownVerified: entry.closed && !entry.closeFailed, cancelled: entry.controller.signal.aborted, timedOut: false, unavailable: flags.unavailable,
    limits: entry.harvest?.limits ?? [], scratchBytes: entry.harvest?.scratchBytes ?? 0,
    output: entry.harvest?.output ?? { v: 1, entries: [], excluded: [], totalBytes: 0 }, ...(entry.harvest?.retained ? { retained: entry.harvest.retained } : {}),
  });
  const observation = (input: ProbeFakeLaunch, ready: Prepared, servedModel: string | null, outcome: ProbeFakeObservation["outcome"], usage: ProbeFakeObservation["usage"],
    entry?: Owned, unavailable = false): ProbeFakeObservation => ({
    reservation: input.reservation, outcome, servedModel, inputFrameHash: ready.input.inputSha256,
    workerEffectiveInputHash: input.slot.role === "worker" ? ready.input.inputSha256 : null,
    nonGuidanceInputSha256: input.slot.role === "worker" ? ready.input.nonGuidanceInputSha256 : null,
    candidateArtifactSha256: null, usage,
    ...(entry ? { measured: { ...measuredSession(entry, servedModel, { unavailable }),
      workerEffectiveInputSha256: input.slot.role === "worker" ? ready.input.inputSha256 : null,
      nonGuidanceInputSha256: input.slot.role === "worker" ? ready.input.nonGuidanceInputSha256 : null } } : {}),
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
          accounting.current(); await close(entry); harvestOutput(entry, ready);
          effects.current(); current();
          return observation(input, ready, result.servedModel, result.complete ? "closed_fixture" : "failed_known", result.usageKnown ? "known_fixture" : "unknown", entry);
        }).catch(async error => {
          if (error instanceof ProbeConfinementError) entry.closeUnknown = error.stop;
          try { await close(entry); }
          catch { throw new ProbeLocalError("interrupted"); }
          // Only after the stop confirmed quiescence, and only while the workspace is still ours: a drifted workspace is read by identity or not at all.
          harvestOutput(entry, ready);
          // `unavailable` means the session could not start: a confinement error before any peer existed. Once a peer ran, the Store treats it as unknown or failed.
          return observation(input, ready, entry.peer?.probeObservation().servedModel ?? null, "unknown", "unknown", entry, error instanceof ProbeConfinementError && !entry.peer);
        }).finally(() => {
          signal.removeEventListener("abort", abort);
          if (entry.closed) { completed.add(entry.reservation); owned.delete(id); }
        });
        return entry.promise;
      },
      discardRetained(record) {
        // Only what this adapter retained and has not yet handed to a receipt. A record that is not exactly one of ours is ignored, never deleted.
        const key = guidanceProbeCanonical(record), ours = retainedHere.get(key);
        if (!ours) return;
        retainedHere.delete(key);
        try { removeRetained(ours, true); } catch { /* the identity checks inside leave a replaced name alone; a failure leaves the directory for the person's prune preview */ }
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
