import { openHubDatabase, type Database } from "./db-schema.ts";
import { createHash } from "node:crypto";
import { GUIDANCE_ROLE_MAX_BYTES } from "./guidance-variants.ts";
import { GUIDANCE_PROBE_LIMITS, GUIDANCE_PROBE_SESSION_BYTES, GuidanceProbeError, guidanceProbeCanonical, guidanceProbeManifestKey,
  parseGuidanceProbeRegistration, probeHash, probeInteger, probeSha256,
  type ProbeRegistrationV1, type ProbeHostBinding, type ProbeKey, type ProbeReceipt, type ProbeStoredState,
  type ProbeCounters, type ProbeSession, type ProbeSessionAdmission, type ProbeAdmissionRecheck,
  type ProbeReservation, type ProbeReservationResult, type ProbeEffectAdmission, type ProbeEffectAdmissionResult,
  type ProbeEffectSettlement, type ProbeSessionSettlement, type ProbeUsageObservation, type ProbeCancellation,
  type ProbeIntegrity, type ProbeChildBinding, type GuidanceProbeFakePorts, type ProbeFakeEffects,
  type ProbeFakeEffectRequest, type ProbeFakeEffectValue, type ProbeFakeEffectResult, type ProbeFakeObservation } from "./guidance-probes.ts";

interface Effect { admission: ProbeEffectAdmission; state: "pending" | "settled" | "unknown"; usageHash: string | null; observed: number | null }
interface Session extends ProbeSession { host?: ProbeHostBinding; effect: Effect | null }
interface Stored extends Omit<ProbeStoredState, "sessions"> { sessions: Session[]; lastWall: number | null }
type Row = Record<string, unknown>;
const fail = (reason: ConstructorParameters<typeof GuidanceProbeError>[0]): never => { throw new GuidanceProbeError(reason); };
const canonical = guidanceProbeCanonical;
function sessionCanonical(session: Session): string {
  if (session.host) canonical(session.host);
  if (session.child) canonical(session.child);
  if (session.effect) canonical(session.effect);
  const { host: _host, child: _child, effect: _effect, ...metadata } = session; canonical(metadata);
  return canonical(session, GUIDANCE_PROBE_SESSION_BYTES);
}
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const sameAdmission = (a: ProbeEffectAdmission, b: ProbeEffectAdmission): boolean => {
  const { now: _a, ...left } = a, { now: _b, ...right } = b; return same(left, right);
};
const sameChild = (a: ProbeChildBinding | undefined, b: ProbeChildBinding | undefined): boolean => {
  if (!a || !b) return a === b;
  const { authoring: _a, sourceSessionId: _b, ...left } = a, { authoring: _c, sourceSessionId: _d, ...right } = b;
  return same(left, right);
};
const taskEpoch = (a: ProbeHostBinding, b: ProbeHostBinding): boolean => a.projectKey === b.projectKey && a.task.id === b.task.id && a.task.created === b.task.created;
const invariant = (a: ProbeHostBinding, b: ProbeHostBinding): boolean => taskEpoch(a, b) && same(a.task, b.task) && same(a.role, b.role) && a.baselineGuidance === b.baselineGuidance;
const checkedInteger = (value: unknown): number => probeInteger(value) ? value : fail("storage");
const checkedHash = (value: unknown): string => probeSha256(value) ? value : fail("storage");
function json<T>(value: unknown): T { if (typeof value !== "string") return fail("storage"); return JSON.parse(value) as T; }
function host(value: ProbeHostBinding): void {
  canonical(value);
  if (!value || typeof value.actor !== "string" || !value.actor || !probeInteger(value.sessionGeneration)
    || typeof value.baselineGuidance !== "string" || Buffer.byteLength(value.baselineGuidance) > GUIDANCE_ROLE_MAX_BYTES
    || !probeSha256(value.role?.baselineSha256) || !probeInteger(value.task?.id) || value.task.id === 0
    || !probeInteger(value.task.created) || !probeInteger(value.task.flowRevision)) fail("changed");
}
const counters = (): ProbeCounters => ({ workerAttempts: 0, editorAttempts: 0, modelCalls: 0, toolCalls: 0,
  tokensReserved: 0, tokensObservedKnown: 0, inputBytes: 0, scratchBytes: 0, outputBytes: 0,
  elapsedHighWaterMs: 0, usageUnknown: false });
const receipt = (state: Stored, already = false): ProbeReceipt => ({ ...state.receipt, already });
const advance = (state: Stored): void => { state.receipt.revision = increment(state.receipt.revision); };
function increment(value: number, amount = 1): number { if (!probeInteger(value) || !probeInteger(amount) || amount > Number.MAX_SAFE_INTEGER - value) return fail("budget"); return value + amount; }
function charge(state: Stored, name: keyof Omit<ProbeCounters, "usageUnknown">, amount: number, maximum: number): void {
  const next = increment(state.counters[name], amount); if (next > maximum) fail("budget"); state.counters[name] = next;
}
function elapsed(state: Stored, now: number, first = false): void {
  if (!probeInteger(now) || state.lastWall !== null && now < state.lastWall) fail("held");
  if (state.firstReservedAt === null && first) state.firstReservedAt = now;
  if (state.firstReservedAt !== null) {
    const age = now - state.firstReservedAt;
    if (!probeInteger(age) || age < state.counters.elapsedHighWaterMs || age > state.registration.manifest.limits.elapsedMs) fail("budget");
    state.counters.elapsedHighWaterMs = age;
  }
  state.lastWall = now;
}
function boundChild(state: Stored, input: ProbeSessionAdmission, session: Session): void {
  const slot = state.registration.manifest.slots.find(item => item.id === session.slotId)!;
  if (slot.role !== "worker" || slot.arm === "baseline") { if (input.child) fail("changed"); return; }
  const child = input.child;
  if (!child || !probeSha256(child.variantId) || !probeSha256(child.candidateSha256) || !same(child.task, input.host.task)
    || !same(child.role, input.host.role) || typeof child.guidance !== "string" || Buffer.byteLength(child.guidance) > GUIDANCE_ROLE_MAX_BYTES
    || probeHash(child.guidance) !== child.candidateSha256) fail("changed");
  if (session.child) { if (!same(session.child, child)) fail("changed"); return; }
  const producerStage = slot.arm === "successor" ? "compose" : slot.arm === "candidate2" ? "proposal2" : "proposal1";
  const source = state.sessions.findLast(item => state.registration.manifest.slots.find(slot => slot.id === item.slotId)?.stage === producerStage && item.state === "closed_fixture");
  const controlled = source?.state === "closed_fixture" && source.candidateArtifactSha256 === child.candidateSha256;
  session.child = { ...child, authoring: controlled ? "admitted_fixture" : "uncontrolled", sourceSessionId: controlled ? source.slotId : null };
  charge(state, "inputBytes", Buffer.byteLength(child.guidance), state.registration.manifest.limits.inputBytes);
}
function snapshotBytes(registration: ProbeRegistrationV1): number {
  return Object.entries(registration.snapshots).reduce((total, [key, value]) => total + Buffer.byteLength(key === "dataPolicy" ? canonical(value) : value as string), 0);
}

/** Private same-db ledger. It never reads G1 tables or owns Task authority. */
export class GuidanceProbeStore {
  private readonly db: Database;
  constructor(file: string) {
    this.db = openHubDatabase(file, { create: true });
    this.db.run(`CREATE TABLE IF NOT EXISTS guidance_probe_manifests (
      project TEXT NOT NULL,id TEXT NOT NULL,experiment TEXT NOT NULL,manifest TEXT NOT NULL,
      task_input TEXT NOT NULL,baseline_context TEXT NOT NULL,data_policy TEXT NOT NULL,system_policy TEXT NOT NULL,improver_context TEXT,
      binding TEXT NOT NULL,counters TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,first_reserved INTEGER,last_wall INTEGER,
      PRIMARY KEY(project,id),UNIQUE(project,experiment))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS guidance_probe_lanes (project TEXT PRIMARY KEY,manifest_id TEXT NOT NULL,slot_id TEXT)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS guidance_probe_sessions (project TEXT NOT NULL,manifest_id TEXT NOT NULL,ordinal INTEGER NOT NULL,
      slot_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project,manifest_id,slot_id),UNIQUE(project,manifest_id,ordinal))`);
  }
  close(): void { this.db.close(); }
  private transaction<T>(action: () => T): T {
    try { return this.db.transaction(action).immediate(); }
    catch (error) { if (error instanceof GuidanceProbeError) throw error; throw new GuidanceProbeError("storage"); }
  }
  private readStored(key: ProbeKey): Stored | undefined {
    checkedHash(key.id);
    const columns = ["manifest", "task_input", "baseline_context", "data_policy", "system_policy", "improver_context", "binding", "counters"];
    const projected = columns.map(name => `CASE WHEN typeof(${name})='text' AND length(CAST(${name} AS BLOB))<=${GUIDANCE_PROBE_LIMITS.recordBytes} THEN ${name} END AS ${name}`).join(",");
    const row = this.db.query(`SELECT ${projected},CASE WHEN typeof(experiment)='text' AND length(CAST(experiment AS BLOB))<=256 THEN experiment END AS experiment,
      revision,state,first_reserved,last_wall FROM guidance_probe_manifests WHERE project=? AND id=?`).get(key.projectKey, key.id) as Row | null;
    if (!row) return undefined;
    const registration = parseGuidanceProbeRegistration({ manifest: json(row.manifest), snapshots: {
      task: row.task_input, baselineContext: row.baseline_context, dataPolicy: json(row.data_policy), systemPolicy: row.system_policy,
      ...(row.improver_context === null ? {} : { improverContext: row.improver_context }) } });
    if (!registration || guidanceProbeManifestKey(registration.manifest) !== key.id || registration.manifest.projectKey !== key.projectKey
      || registration.manifest.experimentId !== row.experiment || canonical(registration.manifest) !== row.manifest) return fail("storage");
    const binding = json<ProbeHostBinding>(row.binding); host(binding);
    if (binding.projectKey !== key.projectKey || !same(binding.task, registration.manifest.task) || !same(binding.role, registration.manifest.role)
      || probeHash(binding.baselineGuidance) !== registration.manifest.guidance.baselineSha256) return fail("storage");
    const totals = json<ProbeCounters>(row.counters), expected = counters();
    if (!same(Object.keys(totals).sort(), Object.keys(expected).sort()) || typeof totals.usageUnknown !== "boolean"
      || Object.entries(totals).some(([name, value]) => name !== "usageUnknown" && !probeInteger(value))) return fail("storage");
    const rows = this.db.query(`SELECT slot_id,ordinal,CASE WHEN typeof(body)='text' AND length(CAST(body AS BLOB))<=? THEN body END AS body
      FROM guidance_probe_sessions WHERE project=? AND manifest_id=? ORDER BY ordinal LIMIT ?`)
      .all(GUIDANCE_PROBE_SESSION_BYTES, key.projectKey, key.id, GUIDANCE_PROBE_LIMITS.slots + 1) as Row[];
    if (rows.length !== registration.manifest.slots.length || rows.length > GUIDANCE_PROBE_LIMITS.slots) return fail("storage");
    const sessions = rows.map((item, index) => {
      const session = json<Session>(item.body), slot = registration.manifest.slots[index]!;
      if (item.ordinal !== index || item.slot_id !== slot.id || session.slotId !== slot.id || !probeInteger(session.generation) || !probeInteger(session.revision)
        || !["planned", "reserved", "running", "failed_known", "closed_fixture", "unknown_held"].includes(session.state)
        || session.candidateArtifactSha256 !== null && !probeSha256(session.candidateArtifactSha256)) return fail("storage");
      const fields = Object.keys(session);
      if (fields.some(name => !["slotId", "generation", "revision", "state", "candidateArtifactSha256", "child", "host", "effect"].includes(name))
        || !Object.hasOwn(session, "effect") || session.state === "planned" && (session.effect !== null || session.host !== undefined || session.child !== undefined || session.generation !== 0)) return fail("storage");
      if (session.host) { host(session.host); if (!invariant(binding, session.host)) return fail("storage"); }
      else if (session.state !== "planned") return fail("storage");
      if (session.child && (!probeSha256(session.child.variantId) || !probeSha256(session.child.candidateSha256) || !same(session.child.task, binding.task)
        || !same(session.child.role, binding.role) || typeof session.child.guidance !== "string" || Buffer.byteLength(session.child.guidance) > GUIDANCE_ROLE_MAX_BYTES
        || probeHash(session.child.guidance) !== session.child.candidateSha256 || !["admitted_fixture", "uncontrolled"].includes(session.child.authoring))) return fail("storage");
      if (session.effect) {
        const effect = session.effect, admission = effect.admission;
        if (!admission || !["pending", "settled", "unknown"].includes(effect.state) || !probeInteger(admission.sequence) || !probeInteger(admission.amount)
          || !probeSha256(admission.descriptorSha256) || !same(admission.reservation.key, key) || admission.reservation.slotId !== slot.id
          || admission.reservation.generation !== session.generation || admission.reservation.revision !== session.revision
          || !["model_calls", "tool_calls", "tokens", "input_bytes", "scratch_bytes", "output_bytes"].includes(admission.unit)
          || effect.usageHash !== null && !probeSha256(effect.usageHash) || effect.observed !== null && !probeInteger(effect.observed)) return fail("storage");
      }
      sessionCanonical(session); return session;
    });
    if (!["declared", "active", "closing", "closed_fixture", "unknown_held"].includes(row.state as string)) return fail("storage");
    return { registration, binding, receipt: { id: key.id, revision: checkedInteger(row.revision), state: row.state as ProbeReceipt["state"], already: false },
      counters: totals, firstReservedAt: row.first_reserved === null ? null : checkedInteger(row.first_reserved),
      lastWall: row.last_wall === null ? null : checkedInteger(row.last_wall), sessions };
  }
  read(key: ProbeKey): ProbeStoredState | undefined {
    try { const state = this.readStored(key); if (!state) return undefined; const { lastWall: _, ...result } = state; return result; }
    catch (error) { if (error instanceof GuidanceProbeError) throw error; throw new GuidanceProbeError("storage"); }
  }
  private get(key: ProbeKey): Stored { return this.readStored(key) ?? fail("changed"); }
  private save(key: ProbeKey, state: Stored): void {
    this.db.query("UPDATE guidance_probe_manifests SET counters=?,revision=?,state=?,first_reserved=?,last_wall=? WHERE project=? AND id=?")
      .run(canonical(state.counters), state.receipt.revision, state.receipt.state, state.firstReservedAt, state.lastWall, key.projectKey, key.id);
    for (const session of state.sessions) this.db.query("UPDATE guidance_probe_sessions SET body=? WHERE project=? AND manifest_id=? AND slot_id=?")
      .run(sessionCanonical(session), key.projectKey, key.id, session.slotId);
  }
  private clockLost(key: ProbeKey, state: Stored, now: number): boolean {
    if (probeInteger(now) && (state.lastWall === null || now >= state.lastWall)
      && (state.firstReservedAt === null || now >= state.firstReservedAt && now - state.firstReservedAt >= state.counters.elapsedHighWaterMs)) return false;
    state.receipt.state = "unknown_held"; advance(state); this.save(key, state); return true;
  }
  register(value: ProbeRegistrationV1, binding: ProbeHostBinding, revalidate: () => ProbeHostBinding): ProbeReceipt {
    const registration = parseGuidanceProbeRegistration(value); if (!registration) return fail("invalid"); host(binding);
    const manifest = registration.manifest, id = guidanceProbeManifestKey(manifest), key = { projectKey: manifest.projectKey, id };
    if (manifest.projectKey !== binding.projectKey || !same(manifest.task, binding.task) || !same(manifest.role, binding.role)
      || probeHash(binding.baselineGuidance) !== manifest.guidance.baselineSha256) return fail("changed");
    const bytes = increment(snapshotBytes(registration), Buffer.byteLength(binding.baselineGuidance));
    if (bytes > manifest.limits.inputBytes) return fail("budget");
    return this.transaction(() => {
      if (!same(binding, revalidate())) return fail("changed");
      const existing = this.db.query("SELECT id FROM guidance_probe_manifests WHERE project=? AND experiment=?").get(key.projectKey, manifest.experimentId) as { id: string } | null;
      if (existing) { if (existing.id !== id) return fail("changed"); const state = this.get(key); if (!invariant(state.binding, binding)) return fail("changed"); return receipt(state, true); }
      const totals = counters(); totals.inputBytes = bytes;
      const snap = registration.snapshots;
      this.db.query(`INSERT INTO guidance_probe_manifests(project,id,experiment,manifest,task_input,baseline_context,data_policy,system_policy,improver_context,binding,counters,revision,state)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(key.projectKey, id, manifest.experimentId, canonical(manifest), snap.task, snap.baselineContext,
          canonical(snap.dataPolicy), snap.systemPolicy, snap.improverContext ?? null, canonical(binding), canonical(totals), 0, "declared");
      manifest.slots.forEach((slot, index) => this.db.query("INSERT INTO guidance_probe_sessions(project,manifest_id,ordinal,slot_id,body) VALUES(?,?,?,?,?)")
        .run(key.projectKey, id, index, slot.id, canonical({ slotId: slot.id, generation: 0, revision: 0, state: "planned", candidateArtifactSha256: null, effect: null })));
      return { id, revision: 0, state: "declared", already: false };
    });
  }
  reserveSession(input: ProbeSessionAdmission, revalidate: () => ProbeAdmissionRecheck): ProbeReservationResult {
    return this.transaction(() => {
      const fresh = revalidate(); if (!same(fresh.host, input.host) || !sameChild(fresh.child, input.child)) return fail("changed");
      const state = this.get(input.key);
      if (!invariant(state.binding, input.host) || !probeInteger(input.expectedRevision)) return fail("changed");
      if (state.receipt.revision !== input.expectedRevision) {
        const running = state.sessions.find(item => item.state === "reserved" || item.state === "running");
        if (running && state.receipt.revision === increment(input.expectedRevision) && same(running.host, input.host)
          && (input.child ? running.child?.variantId === input.child.variantId : !running.child)) return { kind: "existing", receipt: receipt(state, true) };
        return fail("changed");
      }
      if (["closing", "closed_fixture", "unknown_held"].includes(state.receipt.state) || state.counters.usageUnknown) return fail("held");
      const lane = this.db.query("SELECT manifest_id,slot_id FROM guidance_probe_lanes WHERE project=?").get(input.key.projectKey) as { manifest_id: string; slot_id: string | null } | null;
      if (lane && (lane.manifest_id !== input.key.id || lane.slot_id !== null)) return fail("held");
      const index = state.sessions.findIndex(item => item.state === "planned"), session = state.sessions[index]; if (!session) return fail("held");
      const slot = state.registration.manifest.slots[index]!, previous = state.sessions[index - 1];
      if (previous && previous.state !== "closed_fixture" && !(previous.state === "failed_known" && slot.retryOf === previous.slotId)) return fail("held");
      if (slot.retryOf && previous?.state !== "failed_known") return fail("held");
      // No fake launch can begin when a first model/tool call already cannot be admitted.
      const limits = state.registration.manifest.limits;
      if (state.counters.modelCalls >= limits.modelCalls || state.counters.toolCalls >= limits.toolCalls
        || limits.tokens !== undefined && state.counters.tokensReserved >= limits.tokens) return fail("budget");
      if (this.clockLost(input.key, state, input.now)) return { kind: "existing", receipt: receipt(state) };
      elapsed(state, input.now, true); boundChild(state, input, session);
      charge(state, slot.role === "worker" ? "workerAttempts" : "editorAttempts", 1, slot.role === "worker" ? GUIDANCE_PROBE_LIMITS.workerAttempts : GUIDANCE_PROBE_LIMITS.editorAttempts);
      session.host = input.host; session.generation = increment(session.generation); session.revision = increment(session.revision); session.state = "reserved";
      state.receipt.state = "active"; advance(state);
      this.db.query("INSERT INTO guidance_probe_lanes(project,manifest_id,slot_id) VALUES(?,?,?) ON CONFLICT(project) DO UPDATE SET slot_id=excluded.slot_id")
        .run(input.key.projectKey, input.key.id, slot.id);
      this.save(input.key, state);
      return { kind: "granted", reservation: { key: input.key, slotId: slot.id, generation: session.generation, revision: session.revision } };
    });
  }
  private owned(state: Stored, reservation: ProbeReservation): Session {
    const session = state.sessions.find(item => item.slotId === reservation.slotId);
    if (!session || session.generation !== reservation.generation || session.revision !== reservation.revision || !["reserved", "running"].includes(session.state)) return fail("changed");
    return session;
  }
  admitEffect(input: ProbeEffectAdmission, revalidate: () => ProbeAdmissionRecheck): ProbeEffectAdmissionResult {
    return this.transaction(() => {
      const state = this.get(input.reservation.key), session = this.owned(state, input.reservation), fresh = revalidate();
      if (!same(fresh.host, session.host) || !sameChild(fresh.child, session.child) || !invariant(state.binding, fresh.host)) return fail("changed");
      if (state.receipt.state !== "active" || state.counters.usageUnknown || !probeInteger(input.sequence) || !probeSha256(input.descriptorSha256) || !probeInteger(input.amount)) return fail("held");
      if (["model_calls", "tool_calls"].includes(input.unit) && input.amount !== 1) return fail("invalid");
      const previous = session.effect;
      if (previous && input.sequence === previous.admission.sequence) {
        if (!sameAdmission(input, previous.admission)) return fail("changed");
        return { kind: "existing", state: previous.state };
      }
      if (input.sequence !== (previous ? increment(previous.admission.sequence) : 0) || previous?.state === "pending" || previous?.state === "unknown") return fail("held");
      if (previous?.admission.unit === "model_calls" && previous.usageHash === null) {
        state.counters.usageUnknown = true; state.receipt.state = "unknown_held"; advance(state); this.save(input.reservation.key, state);
        return { kind: "existing", state: "unknown" };
      }
      if (this.clockLost(input.reservation.key, state, input.now)) return { kind: "existing", state: "unknown" };
      elapsed(state, input.now);
      const limits = state.registration.manifest.limits;
      const names = { model_calls: ["modelCalls", limits.modelCalls], tool_calls: ["toolCalls", limits.toolCalls], tokens: ["tokensReserved", limits.tokens], input_bytes: ["inputBytes", limits.inputBytes], scratch_bytes: ["scratchBytes", limits.scratchBytes], output_bytes: ["outputBytes", limits.outputBytes] } as const;
      const target = names[input.unit]; if (!target || target[1] === undefined) return fail("budget");
      charge(state, target[0], input.amount, target[1]);
      if (input.unit === "model_calls") {
        if (limits.tokens !== undefined && !probeInteger(input.reservedTokens)) return fail("budget");
        if (input.reservedTokens !== undefined) charge(state, "tokensReserved", input.reservedTokens, limits.tokens ?? Number.MAX_SAFE_INTEGER);
      } else if (input.reservedTokens !== undefined) return fail("invalid");
      session.effect = { admission: input, state: "pending", usageHash: null, observed: null }; session.state = "running";
      advance(state); this.save(input.reservation.key, state); return { kind: "granted", admission: input };
    });
  }
  private effect(state: Stored, admission: ProbeEffectAdmission): { session: Session; effect: Effect } {
    const session = state.sessions.find(item => item.slotId === admission.reservation.slotId);
    if (!session || !session.effect || !same(session.effect.admission, admission)) return fail("changed");
    return { session, effect: session.effect };
  }
  recordUsage(input: ProbeUsageObservation): ProbeReceipt {
    return this.transaction(() => {
      const state = this.get(input.admission.reservation.key);
      const session = state.sessions.find(item => item.slotId === input.admission.reservation.slotId), effect = session?.effect;
      const expectedHash = probeHash(canonical({ admission: input.admission, observed: input.observed }));
      if (!effect || !same(effect.admission, input.admission) || !probeSha256(input.observationSha256) || input.observationSha256 !== expectedHash
        || input.observed !== null && !probeInteger(input.observed) || effect.usageHash !== null && effect.usageHash !== input.observationSha256) {
        state.counters.usageUnknown = true; state.receipt.state = "unknown_held";
      } else if (effect.usageHash === input.observationSha256) return receipt(state, true);
      else {
        effect.usageHash = input.observationSha256; effect.observed = input.observed;
        if (input.observed === null) state.counters.usageUnknown = true;
        else if (input.admission.unit === "model_calls") {
          state.counters.tokensObservedKnown = increment(state.counters.tokensObservedKnown, input.observed);
          if (input.admission.reservedTokens !== undefined && input.observed > input.admission.reservedTokens) state.counters.usageUnknown = true;
        } else if (input.admission.unit === "tool_calls" && input.observed > input.admission.amount) state.counters.usageUnknown = true;
        if (state.counters.usageUnknown) state.receipt.state = "unknown_held";
      }
      advance(state); this.save(input.admission.reservation.key, state); return receipt(state);
    });
  }
  settleEffect(input: ProbeEffectSettlement): ProbeReceipt {
    return this.transaction(() => {
      const state = this.get(input.admission.reservation.key), { effect } = this.effect(state, input.admission);
      if (effect.state !== "pending") {
        if (effect.state === input.outcome) return receipt(state, true); return fail("changed");
      }
      effect.state = input.outcome;
      if (input.outcome === "unknown" || input.admission.unit === "model_calls" && effect.usageHash === null) { state.counters.usageUnknown = true; state.receipt.state = "unknown_held"; }
      advance(state); this.save(input.admission.reservation.key, state); return receipt(state);
    });
  }
  settleSession(input: ProbeSessionSettlement): ProbeReceipt {
    return this.transaction(() => {
      const state = this.get(input.reservation.key), session = this.owned(state, input.reservation);
      if (this.clockLost(input.reservation.key, state, input.now)) return receipt(state);
      elapsed(state, input.now);
      if (input.candidateArtifactSha256 !== null && !probeSha256(input.candidateArtifactSha256)) return fail("invalid");
      const unknown = input.outcome === "unknown" || state.counters.usageUnknown || session.effect?.state === "pending" || session.effect?.state === "unknown";
      session.state = unknown ? "unknown_held" : input.outcome === "failed_known" ? "failed_known" : "closed_fixture"; session.candidateArtifactSha256 = input.candidateArtifactSha256;
      if (unknown) state.receipt.state = "unknown_held";
      else {
        this.db.query("UPDATE guidance_probe_lanes SET slot_id=NULL WHERE project=? AND manifest_id=? AND slot_id=?").run(input.reservation.key.projectKey, input.reservation.key.id, session.slotId);
        if (state.sessions.every((item, index) => item.state === "closed_fixture" || item.state === "failed_known"
          && state.registration.manifest.slots[index + 1]?.retryOf === item.slotId && state.sessions[index + 1]?.state === "closed_fixture")) {
          state.receipt.state = "closed_fixture";
          this.db.query("DELETE FROM guidance_probe_lanes WHERE project=? AND manifest_id=? AND slot_id IS NULL").run(input.reservation.key.projectKey, input.reservation.key.id);
        }
      }
      advance(state); this.save(input.reservation.key, state); return receipt(state);
    });
  }
  cancelIntent(input: ProbeCancellation, revalidate: () => ProbeHostBinding): ProbeReceipt {
    return this.transaction(() => {
      const state = this.get(input.key), fresh = revalidate();
      if (!same(input.host, fresh) || !taskEpoch(state.binding, fresh) || state.receipt.revision !== input.expectedRevision) return fail("changed");
      if (state.receipt.state === "closing" || state.receipt.state === "closed_fixture") return receipt(state, true);
      state.receipt.state = "closing"; advance(state); this.save(input.key, state); return receipt(state);
    });
  }
  /** Recovery only. O(historical experiments + <=9 sessions each); future keyset/budget upgrade if measured slow. */
  integrity(): ProbeIntegrity {
    const digest = createHash("sha256");
    let experiments = 0, sessions = 0;
    // ponytail: keys stream, each payload remains bounded; no experiment-count cap or incomplete digest.
    for (const key of this.db.query(`SELECT CASE WHEN typeof(project)='text' AND length(CAST(project AS BLOB))<=256 THEN project END AS projectKey,
      CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))<=64 THEN id END AS id FROM guidance_probe_manifests ORDER BY project,id`).iterate() as Iterable<ProbeKey>) {
      if (typeof key.projectKey !== "string") return fail("storage");
      const state = this.get(key); experiments++; sessions += state.sessions.length;
      for (const component of [key, state.registration.manifest, state.binding, state.counters, state.receipt,
        { firstReservedAt: state.firstReservedAt, lastWall: state.lastWall }]) digest.update(canonical(component)).update("\n");
      for (const session of state.sessions) digest.update(sessionCanonical(session)).update("\n");
    }
    const orphan = this.db.query(`SELECT EXISTS(SELECT 1 FROM guidance_probe_sessions s LEFT JOIN guidance_probe_manifests m ON m.project=s.project AND m.id=s.manifest_id WHERE m.id IS NULL)
      OR EXISTS(SELECT 1 FROM guidance_probe_lanes l LEFT JOIN guidance_probe_manifests m ON m.project=l.project AND m.id=l.manifest_id WHERE m.id IS NULL) AS invalid`).get() as { invalid: number };
    if (orphan.invalid) return fail("storage");
    for (const lane of this.db.query(`SELECT CASE WHEN length(CAST(project AS BLOB))<=256 THEN project END AS project,
      CASE WHEN length(CAST(manifest_id AS BLOB))<=64 THEN manifest_id END AS manifest_id,
      CASE WHEN slot_id IS NULL OR length(CAST(slot_id AS BLOB))<=256 THEN slot_id END AS slot_id FROM guidance_probe_lanes ORDER BY project`).iterate() as Iterable<Row>) {
      if (typeof lane.project !== "string" || !probeSha256(lane.manifest_id)) return fail("storage"); digest.update(canonical(lane)).update("\n");
    }
    return { experiments, sessions, digest: digest.digest("hex") };
  }
}

/** Host test composition only. No wire/config runner selection or independent caller authority. */
export class GuidanceProbeFixtureHost {
  constructor(private readonly store: GuidanceProbeStore, private readonly options: {
    ports?: GuidanceProbeFakePorts;
    revalidate: () => ProbeAdmissionRecheck;
    now: () => number;
  }) {}
  async start(input: ProbeSessionAdmission, frame: { inputFrame: string; nonGuidanceInputSha256: string }, signal: AbortSignal): Promise<ProbeReceipt> {
    const ports = this.options.ports;
    // Production T1 stops here, before even selecting/binding a child or reserving a slot.
    if (!ports) return fail("runner");
    if (signal.aborted) return fail("held");
    const result = this.store.reserveSession(input, this.options.revalidate);
    if (result.kind === "existing") return result.receipt;
    const reservation = result.reservation;
    try {
      const state = this.store.read(input.key)!;
      const slot = state.registration.manifest.slots.find(item => item.id === reservation.slotId)!;
      const effects = this.effects(reservation, signal);
      const observation = await ports.launch({ reservation, slot, manifest: state.registration.manifest,
        inputFrame: frame.inputFrame, inputSha256: probeHash(frame.inputFrame), nonGuidanceInputSha256: frame.nonGuidanceInputSha256, purpose: "guidance_probe" }, effects, signal);
      const matched = this.matchObservation(observation, reservation, frame, slot.role === "worker");
      return this.store.settleSession({ reservation, outcome: matched ? observation.outcome : "unknown",
        candidateArtifactSha256: matched ? observation.candidateArtifactSha256 : null, now: this.options.now() });
    } catch {
      this.store.settleSession({ reservation, outcome: "unknown", candidateArtifactSha256: null, now: this.options.now() });
      throw new GuidanceProbeError("held");
    }
  }
  private matchObservation(value: ProbeFakeObservation, reservation: ProbeReservation,
    frame: { inputFrame: string; nonGuidanceInputSha256: string }, worker: boolean): boolean {
    return !!value && same(value.reservation, reservation) && ["closed_fixture", "failed_known", "unknown"].includes(value.outcome)
      && (!worker || value.servedModel === "qwen27b/qwen3.8-27b" && value.workerEffectiveInputHash === probeHash(frame.inputFrame)
        && value.nonGuidanceInputSha256 === frame.nonGuidanceInputSha256)
      && (value.candidateArtifactSha256 === null || probeSha256(value.candidateArtifactSha256));
  }
  private effects(reservation: ProbeReservation, signal: AbortSignal): ProbeFakeEffects {
    return { runEffect: async <T>(request: ProbeFakeEffectRequest, effect: (signal: AbortSignal) => Promise<ProbeFakeEffectValue<T>>): Promise<ProbeFakeEffectResult<T>> => {
      if (signal.aborted) return fail("held");
      if (!request || !["model_calls", "tool_calls"].includes(request.unit)) return fail("invalid");
      const admission: ProbeEffectAdmission = { reservation, sequence: request.sequence, unit: request.unit, amount: 1,
        descriptorSha256: request.descriptorSha256, ...(request.reservedTokens === undefined ? {} : { reservedTokens: request.reservedTokens }), now: this.options.now() };
      const granted = this.store.admitEffect(admission, this.options.revalidate);
      if (granted.kind === "existing") return granted;
      try {
        const result = await effect(signal);
        const observed = result.usage, visibleHash = probeHash(canonical({ request, usage: observed }));
        this.store.recordUsage({ admission, observed, observationSha256: result.observationSha256 === visibleHash
          ? probeHash(canonical({ admission, observed })) : result.observationSha256 });
        this.store.settleEffect({ admission, outcome: "settled" });
        return { kind: "executed", value: result.value };
      } catch {
        const observed = null;
        this.store.recordUsage({ admission, observed, observationSha256: probeHash(canonical({ admission, observed })) });
        this.store.settleEffect({ admission, outcome: "unknown" });
        throw new GuidanceProbeError("held");
      }
    } };
  }
}
