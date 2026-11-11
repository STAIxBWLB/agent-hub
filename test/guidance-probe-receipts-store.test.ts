import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { GuidanceProbeFixtureHost, GuidanceProbeStore } from "../src/hub/guidance-probe-store.ts";
import { GUIDANCE_PROBE_MODEL, GuidanceProbeError, PROBE_OUTPUT_LIMITS, PROBE_RETENTION_MS, guidanceProbeCanonical, probeHash, probeReceiptDigest, type ProbeChildBinding, type ProbeMeasuredSession, type ProbeReservation, type ProbeRetentionFs } from "../src/hub/guidance-probes.ts";
import { previewRetained, removeRetained } from "../src/local/probe-workspace.ts";
import { FakeGuidanceProbeProvider, fakeEffectValue, guidanceProbeFixture, guidanceProbeFixtureKey } from "./fakes/guidance-probe-provider.ts";

const guidanceProbeCanonicalFor = (admission: unknown, observed: number) => guidanceProbeCanonical({ admission, observed });
// #1226 T3 Store contract: seal once, hydrate with tamper detection, reconcile only on an explicit call, and report the outcome denominator privately.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const declared = guidanceProbeFixture().registration.manifest.runtime;
const measured = (over: Partial<ProbeMeasuredSession> = {}): ProbeMeasuredSession => ({ startedAt: 100, servedModel: GUIDANCE_PROBE_MODEL, workerEffectiveInputSha256: null, nonGuidanceInputSha256: null,
  runtime: { runtimeSha256: declared.runtimeSha256, toolsetSha256: declared.toolsetSha256, modelConfigSha256: declared.modelConfigSha256 },
  teardownVerified: true, cancelled: false, timedOut: false, unavailable: false, limits: [], scratchBytes: 0, output: { v: 1, entries: [], excluded: [], totalBytes: 0 }, ...over });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ahub-probe-receipts-")), file = join(directory, "hub.db");
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const clock = { now: 100 };
  const store = new GuidanceProbeStore(file, () => clock.now); cleanup.push(() => store.close());
  const source = guidanceProbeFixture(), key = guidanceProbeFixtureKey(source.registration);
  const revalidate = () => ({ host: source.host });
  store.register(source.registration, source.host, () => source.host);
  const provider = new FakeGuidanceProbeProvider();
  const host = new GuidanceProbeFixtureHost(store, { ports: provider, revalidate, now: () => clock.now });
  /** Take the next planned session through reservation, launch and one settled model call, but leave it open (neither settled nor sealed). */
  function openNext(): { reservation: ProbeReservation; check: () => { host: typeof source.host; child?: ProbeChildBinding } } {
    const state = store.read(key)!, index = state.sessions.findIndex(item => item.state === "planned"), slot = state.registration.manifest.slots[index]!;
    let child: ProbeChildBinding | undefined;
    if (slot.role === "worker" && slot.arm !== "baseline") {
      const guidance = "Candidate guidance."; child = { variantId: probeHash("variant"), candidateSha256: probeHash(guidance), guidanceSha256: probeHash(guidance), guidance, task: source.host.task, role: source.host.role, authoring: "uncontrolled", sourceSessionId: null };
    }
    const check = () => ({ host: source.host, ...(child ? { child } : {}) });
    const frame = { slotId: slot.id, sha256: probeHash(`frame-${slot.id}`), bytes: 5 };
    const reserved = store.reserveSession({ key, expectedRevision: state.receipt.revision, host: source.host, ...(child ? { child } : {}), preparedFrame: frame, now: clock.now }, check);
    if (reserved.kind !== "granted") throw new Error("expected a reservation");
    const reservation = reserved.reservation;
    store.exposeLaunch(reservation, check);
    const admitted = store.admitEffect({ reservation, sequence: 0, unit: "model_calls", amount: 1, descriptorSha256: probeHash(`m-${slot.id}`), reservedTokens: 20, now: clock.now }, check);
    if (admitted.kind !== "granted") throw new Error("expected an effect");
    store.recordUsage({ admission: admitted.admission, observed: 10, observationSha256: probeHash(guidanceProbeCanonical({ admission: admitted.admission, observed: 10 })) });
    store.settleEffect({ admission: admitted.admission, outcome: "settled" });
    return { reservation, check };
  }
  /** Settle the next planned session straight through the Store, with fully known usage and NO receipt, so a test seals it with the measurement it wants. */
  function settleNext(): ProbeReservation {
    const { reservation } = openNext();
    store.settleObservedSession({ reservation, outcome: "closed_fixture", candidateArtifactSha256: null, now: clock.now }, "known_fixture");
    return reservation;
  }
  /** Settle every planned session through the Store, unsealed: the smallest honest way to a terminal (closed) experiment. Returns the reservations in order. */
  function runAll(): Promise<ProbeReservation[]> {
    const reservations: ProbeReservation[] = [];
    while (store.read(key)!.sessions.some(item => item.state === "planned")) reservations.push(settleNext());
    return Promise.resolve(reservations);
  }
  /** The same, but driven through the fixture host, which settles AND seals each session itself in one transaction. */
  async function runAllThroughHost(): Promise<ProbeReservation[]> {
    const reservations: ProbeReservation[] = [];
    for (;;) {
      const state = store.read(key)!;
      if (!state.sessions.some(item => item.state === "planned")) break;
      let reservation: ProbeReservation | undefined;
      const run = new GuidanceProbeFixtureHost(store, { ports: provider, revalidate, now: () => clock.now, onReserved: value => { reservation = value; },
        prepareEditorFrame: () => "bounded editor frame" });
      const next = state.sessions.findIndex(item => item.state === "planned");
      const slot = state.registration.manifest.slots[next]!;
      let child: ProbeChildBinding | undefined;
      if (slot.role === "worker" && slot.arm !== "baseline") {
        const guidance = "Candidate guidance."; child = { variantId: probeHash("variant"), candidateSha256: probeHash(guidance), guidanceSha256: probeHash(guidance), guidance, task: source.host.task, role: source.host.role, authoring: "uncontrolled", sourceSessionId: null };
      }
      const live = child ? new GuidanceProbeFixtureHost(store, { ports: provider, revalidate: () => ({ host: source.host, child: child! }), now: () => clock.now, onReserved: value => { reservation = value; }, prepareEditorFrame: () => "bounded editor frame" }) : run;
      await live.start({ key, expectedRevision: state.receipt.revision, host: source.host, ...(child ? { child } : {}), now: clock.now }, new AbortController().signal);
      if (reservation) reservations.push(reservation);
    }
    return reservations;
  }
  /** Run the planned baseline worker session to a settled state with fully known usage and no receipt, returning its reservation. */
  async function baseline(): Promise<ProbeReservation> { return settleNext(); }
  return { directory, file, store, key, clock, source, revalidate, provider, host, baseline, runAll, runAllThroughHost, openNext };
}

describe("sealing", () => {
  test("a fully covered closed session seals as a success with the host's own fingerprints, not the provider's", async () => {
    const f = fixture(), reservation = await f.baseline();
    const sealed = f.store.sealReceipt(reservation, measured({ workerEffectiveInputSha256: probeHash("w"), nonGuidanceInputSha256: probeHash("n") }));
    expect(sealed.state).toBe("succeeded");
    expect(sealed.servedModel).toBe(GUIDANCE_PROBE_MODEL);
    expect(sealed.runtimeSha256).toBe(f.source.registration.manifest.runtime.runtimeSha256);
    expect(sealed.usage).toMatchObject({ modelCalls: 1, modelUsageKnown: 1 });
    expect(sealed.expiresAt).toBe(sealed.endedAt + PROBE_RETENTION_MS);
    expect(f.store.receipts(f.key)).toEqual([sealed]);
  });
  test("sealing twice with the same facts replays the stored receipt; different facts latch the observation hold", async () => {
    const f = fixture(), reservation = await f.baseline();
    const first = f.store.sealReceipt(reservation, measured());
    expect(f.store.sealReceipt(reservation, measured())).toEqual(first);
    expect(f.store.receipts(f.key)).toHaveLength(1);
    expect(() => f.store.sealReceipt(reservation, measured({ servedModel: "fallback/model" }))).toThrow(GuidanceProbeError);
    expect(f.store.read(f.key)!.admissionHold).toBe("observation");
    expect(f.store.receipts(f.key)[0]).toEqual(first);
  });
  test("an unsettled session cannot be sealed: a receipt only describes a finished session", () => {
    const f = fixture();
    const result = f.store.reserveSession({ key: f.key, expectedRevision: 0, host: f.source.host, now: 100 }, f.revalidate);
    if (result.kind !== "granted") throw new Error("expected a reservation");
    expect(() => f.store.sealReceipt(result.reservation, measured())).toThrow(GuidanceProbeError);
    expect(f.store.receipts(f.key)).toEqual([]);
  });
  test("a stale reservation (wrong generation or revision) cannot seal", async () => {
    const f = fixture(), reservation = await f.baseline();
    expect(() => f.store.sealReceipt({ ...reservation, generation: reservation.generation + 1 }, measured())).toThrow(GuidanceProbeError);
    expect(() => f.store.sealReceipt({ ...reservation, revision: reservation.revision + 1 }, measured())).toThrow(GuidanceProbeError);
  });
  test("a timeout is never a success, whatever else is true", async () => {
    const f = fixture(), reservation = await f.baseline();
    expect(f.store.sealReceipt(reservation, measured({ timedOut: true })).state).toBe("timed_out");
  });
  test("each known cause maps to its own non-success state", async () => {
    // `unavailable` (could not start) is covered under F3: a session that already called the model can never be it.
    for (const [over, state] of [[{ cancelled: true }, "cancelled"], [{ timedOut: true }, "timed_out"]] as const) {
      const f = fixture(), reservation = await f.baseline();
      expect(f.store.sealReceipt(reservation, measured(over)).state, state).toBe(state);
    }
  });
  test("unverified teardown, an unobserved served model or a mismatched one never seal success", async () => {
    for (const over of [{ teardownVerified: false }, { servedModel: null }, { servedModel: "other/model" }]) {
      const f = fixture(), reservation = await f.baseline();
      const sealed = f.store.sealReceipt(reservation, measured(over));
      expect(sealed.state, JSON.stringify(over)).toBe("unknown");
      expect(sealed.limits.length).toBeGreaterThan(0);
    }
  });
  test("output the host excluded keeps the receipt from succeeding and is recorded as a limit", async () => {
    const f = fixture(), reservation = await f.baseline();
    const sealed = f.store.sealReceipt(reservation, measured({ output: { v: 1, entries: [], excluded: [{ relative: "output/link", reason: "linked" }], totalBytes: 0 } }));
    expect(sealed.state).not.toBe("succeeded");
    expect(sealed.limits).toContain("output_truncated");
  });
  test("the 1 GiB cap holds at runtime: scratch or output over its declared bound is a non-success and extra output is not retained", async () => {
    const declared = guidanceProbeFixture().registration.manifest.limits;
    {
      const f = fixture(), reservation = await f.baseline();
      const sealed = f.store.sealReceipt(reservation, measured({ scratchBytes: declared.scratchBytes + 1 }));
      expect(sealed.state).not.toBe("succeeded"); expect(sealed.limits).toContain("storage_over_cap");
    }
    {
      const f = fixture(), reservation = await f.baseline();
      const big = { relative: "output/big", sha256: probeHash("big"), bytes: declared.outputBytes + 1 };
      const sealed = f.store.sealReceipt(reservation, measured({ output: { v: 1, entries: [big], excluded: [], totalBytes: big.bytes } }));
      expect(sealed.state).not.toBe("succeeded"); expect(sealed.limits).toContain("storage_over_cap");
      expect(sealed.output.entries).toEqual([]); expect(sealed.output.totalBytes).toBe(0);
      expect(sealed.output.excluded.map(item => item.relative)).toEqual(["output/big"]);
    }
  });
});

describe("tamper and torn state", () => {
  const edit = (file: string, sql: string, ...args: (string | number)[]) => { const db = new Database(file); try { db.query(sql).run(...args); } finally { db.close(); } };
  test("an edited receipt body fails hydration as storage corruption, not as a quiet different answer", async () => {
    const f = fixture(), reservation = await f.baseline(); f.store.sealReceipt(reservation, measured());
    edit(f.file, "UPDATE guidance_probe_receipts SET body=replace(body,'\"succeeded\"','\"failed\"')");
    expect(() => f.store.receipts(f.key)).toThrow(GuidanceProbeError);
    expect(() => f.store.integrity()).toThrow(GuidanceProbeError);
  });
  test("a receipt row moved to another slot or experiment is refused", async () => {
    const f = fixture(), reservation = await f.baseline(); f.store.sealReceipt(reservation, measured());
    edit(f.file, "UPDATE guidance_probe_receipts SET slot_id='candidate1'");
    expect(() => f.store.receipts(f.key)).toThrow(GuidanceProbeError);
  });
  test("a receipt that claims success for a session that did not close is refused", async () => {
    const f = fixture(), reservation = await f.baseline(); f.store.sealReceipt(reservation, measured());
    f.store.latchHold(reservation, "usage");
    edit(f.file, "UPDATE guidance_probe_sessions SET body=replace(body,'\"closed_fixture\"','\"unknown_held\"') WHERE slot_id='baseline'");
    expect(() => f.store.receipts(f.key)).toThrow(GuidanceProbeError);
  });
  test("a receipt row with no experiment (orphan) fails the recovery integrity pass", async () => {
    const f = fixture(), reservation = await f.baseline(); f.store.sealReceipt(reservation, measured());
    edit(f.file, "UPDATE guidance_probe_receipts SET manifest_id=?", "e".repeat(64));
    expect(() => f.store.integrity()).toThrow(GuidanceProbeError);
  });
  test("a deleted or added receipt changes the recovery digest, so a restart snapshot notices", async () => {
    const f = fixture(), reservation = await f.baseline();
    const before = f.store.integrity().digest;
    f.store.sealReceipt(reservation, measured());
    const sealed = f.store.integrity().digest;
    expect(sealed).not.toBe(before);
    edit(f.file, "DELETE FROM guidance_probe_receipts");
    expect(f.store.integrity().digest).toBe(before);
  });
  test("an oversized receipt row is refused by the SQL length guard before it is parsed", async () => {
    const f = fixture(), reservation = await f.baseline(); f.store.sealReceipt(reservation, measured());
    edit(f.file, "UPDATE guidance_probe_receipts SET body=?", "x".repeat(40000));
    expect(() => f.store.receipts(f.key)).toThrow(GuidanceProbeError);
  });
  test("hasRecords sees a receipt, so a target without the feature is still refused", async () => {
    const f = fixture();
    expect(f.store.hasRecords()).toBe(true);
    const bare = mkdtempSync(join(tmpdir(), "ahub-probe-bare-")); cleanup.push(() => rmSync(bare, { recursive: true, force: true }));
    const empty = new GuidanceProbeStore(join(bare, "hub.db")); cleanup.push(() => empty.close());
    expect(empty.hasRecords()).toBe(false);
  });
});

describe("reconcile after a crash (explicit call only)", () => {
  /** Leave a reserved session behind exactly as a crash would: reserved, never settled, no receipt. */
  function crashed() {
    const f = fixture();
    const result = f.store.reserveSession({ key: f.key, expectedRevision: 0, host: f.source.host, now: 100 }, f.revalidate);
    if (result.kind !== "granted") throw new Error("expected a reservation");
    return { ...f, reservation: result.reservation };
  }
  const rows = (file: string) => { const db = new Database(file, { readonly: true }); try {
    return JSON.stringify([db.query("SELECT * FROM guidance_probe_manifests").all(), db.query("SELECT * FROM guidance_probe_sessions").all(),
      db.query("SELECT * FROM guidance_probe_lanes").all(), db.query("SELECT * FROM guidance_probe_receipts").all()]);
  } finally { db.close(); } };

  test("opening the store, reading and every read-only call write nothing, even with an unreconciled session present", () => {
    const f = crashed(); const before = rows(f.file);
    const reopened = new GuidanceProbeStore(f.file); cleanup.push(() => reopened.close());
    reopened.read(f.key); reopened.receipts(f.key); reopened.outcome(f.key); reopened.integrity(); reopened.hasRecords();
    expect(rows(f.file)).toBe(before);
  });
  test("a store opened on a read-only database file proves the point at the file layer: no row changes and no write is attempted", () => {
    const f = crashed(); const before = rows(f.file);
    f.store.close();
    const handle = new Database(f.file, { readonly: true });
    try {
      // The Store's own reads, run over a connection that physically cannot write.
      expect(() => handle.query("UPDATE guidance_probe_manifests SET revision=revision").run()).toThrow();
    } finally { handle.close(); }
    const reopened = new GuidanceProbeStore(f.file); cleanup.push(() => reopened.close());
    reopened.receipts(f.key); reopened.outcome(f.key);
    expect(rows(f.file)).toBe(before);
  });
  test("reconcile records the unfinished session as unknown_held with an unknown receipt, never as a failure or a success", () => {
    const f = crashed();
    expect(f.store.reconcile(200)).toEqual({ reconciled: 1, failed: 0 });
    const state = f.store.read(f.key)!;
    expect(state.sessions[0]!.state).toBe("unknown_held");
    expect(state.receipt.state).toBe("unknown_held");
    const [sealed] = f.store.receipts(f.key);
    expect(sealed).toMatchObject({ slotId: "baseline", state: "unknown", servedModel: null });
    expect(sealed!.limits).toContain("teardown_unverified");
    expect(f.store.outcome(f.key)!.counts).toMatchObject({ unknown: 1, failed: 0, succeeded: 0 });
  });
  test("reconcile is idempotent: a second call finds nothing and writes nothing", () => {
    const f = crashed(); f.store.reconcile(200);
    const after = rows(f.file);
    expect(f.store.reconcile(300)).toEqual({ reconciled: 0, failed: 0 });
    expect(rows(f.file)).toBe(after);
  });
  test("reconcile never launches, retries or restarts: no provider call, no new reservation, attempts unchanged", () => {
    const f = crashed(); const attempts = f.store.read(f.key)!.counters.workerAttempts;
    f.store.reconcile(200);
    expect(f.provider.launches).toHaveLength(0);
    expect(f.store.read(f.key)!.counters.workerAttempts).toBe(attempts);
    expect(f.store.read(f.key)!.sessions.filter(item => ["reserved", "running"].includes(item.state))).toHaveLength(0);
  });
  test("the lane stays held after reconcile: nothing new can be reserved until a person cancels", () => {
    const f = crashed(); f.store.reconcile(200);
    expect(() => f.store.reserveSession({ key: f.key, expectedRevision: f.store.read(f.key)!.receipt.revision, host: f.source.host, now: 200 }, f.revalidate)).toThrow(GuidanceProbeError);
    const cancelled = f.store.cancelIntent({ key: f.key, expectedRevision: f.store.read(f.key)!.receipt.revision, host: f.source.host }, () => f.source.host);
    expect(cancelled.state).toBe("closing");
  });
  test("a session that already has a receipt is left alone by reconcile", async () => {
    const f = fixture(), reservation = await f.baseline(); const sealed = f.store.sealReceipt(reservation, measured());
    expect(f.store.reconcile(500)).toEqual({ reconciled: 0, failed: 0 });
    expect(f.store.receipts(f.key)).toEqual([sealed]);
  });
  test("an experiment with nothing in flight is untouched by reconcile", () => {
    const f = fixture(); const before = rows(f.file);
    expect(f.store.reconcile(500)).toEqual({ reconciled: 0, failed: 0 });
    expect(rows(f.file)).toBe(before);
  });
});

describe("private outcome status", () => {
  test("a sealed success, an unstarted slot and a not-yet-run slot are counted apart", async () => {
    const f = fixture(), reservation = await f.baseline(); f.store.sealReceipt(reservation, measured());
    const { counts } = f.store.outcome(f.key)!;
    expect(counts.succeeded).toBe(1);
    expect(counts.planned).toBe(f.source.registration.manifest.slots.length - 1);
    expect(counts.failed + counts.cancelled + counts.timed_out + counts.unavailable + counts.unknown).toBe(0);
  });
  test("a non-success arm stays in the denominator and the pair is incomparable", async () => {
    const f = fixture(), reservation = await f.baseline(); f.store.sealReceipt(reservation, measured({ timedOut: true }));
    const status = f.store.outcome(f.key)!;
    expect(status.counts.timed_out).toBe(1);
    expect(status.comparability.comparable).toBe(false);
  });
  test("an unknown key has no outcome", () => {
    const f = fixture();
    expect(f.store.outcome({ projectKey: f.key.projectKey, id: "f".repeat(64) })).toBeUndefined();
  });
});

describe("prune: preview first, owned bytes only, receipts never", () => {
  const fs: ProbeRetentionFs = { preview: record => previewRetained(record), remove: record => removeRetained(record) };
  /** The Store decides expiry on its own trusted clock, so a test moves that clock and never hands prune a `now`. */
  const expire = (f: { clock: { now: number } }, sealed: { expiresAt: number }) => { f.clock.now = sealed.expiresAt; };
  /** A whole experiment run to its terminal state, with the baseline's output retained as a real directory on disk. */
  async function terminal(measuredFor: (index: number) => Partial<ProbeMeasuredSession> = () => ({})) {
    const f = fixture(), reservations = await f.runAll();
    const root = mkdtempSync(join(tmpdir(), "ahub-probe-prune-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const directory = join(root, "retained-1"); mkdirSync(join(directory, "output"), { recursive: true });
    const output = join(directory, "output", "answer.txt"); writeFileSync(output, "answer");
    const file = statSync(output, { bigint: true }), dir = statSync(directory);
    const record = { directory, dev: dir.dev, ino: dir.ino, files: [{ relative: "output/answer.txt", dev: Number(file.dev), ino: Number(file.ino), bytes: 6, ctimeNs: file.ctimeNs.toString() }] };
    const sealed = reservations.map((reservation, index) => f.store.sealReceipt(reservation, measured(index === 0
      ? { retained: record, output: { v: 1, entries: [{ relative: "output/answer.txt", sha256: probeHash("answer"), bytes: 6 }], excluded: [], totalBytes: 6 }, ...measuredFor(index) } : measuredFor(index))));
    return { ...f, db: f.file, root, directory, output, sealed, record };
  }
  const baselineKeep = (f: { store: GuidanceProbeStore; key: { projectKey: string; id: string } }) => f.store.previewPrune(f.key, fs).slots.find(item => item.slotId === "baseline")!;

  test("the experiment really is terminal here, so the cases below test prune and not the fixture", async () => {
    const f = await terminal();
    expect(["closed_fixture", "failed_fixture"]).toContain(f.store.read(f.key)!.receipt.state);
    expect(f.sealed.length).toBeGreaterThan(1);
  });
  test("nothing is prunable before the output's own expiresAt, and the plan says why", async () => {
    const f = await terminal(); f.clock.now = f.sealed[0]!.expiresAt - 1;
    const plan = f.store.previewPrune(f.key, fs);
    expect(baselineKeep(f).keep).toEqual([{ relative: ".", reason: "not_expired" }]);
    expect(plan.retainedBytes).toBe(0);
    f.store.prune(f.key, plan.digest, fs);
    expect(existsSync(f.output)).toBe(true);
  });
  test("expiry is the Store's own clock: there is no caller-supplied time to pull a retention date forward", async () => {
    const f = await terminal();
    expect(f.store.previewPrune.length).toBe(2); expect(f.store.prune.length).toBe(3);
    f.clock.now = f.sealed[0]!.expiresAt - 1;
    expect(baselineKeep(f).remove).toEqual([]);
    f.clock.now = f.sealed[0]!.expiresAt;
    expect(baselineKeep(f).remove).toEqual([{ relative: "output/answer.txt", bytes: 6 }]);
  });
  test("after expiry, preview lists the exact files, then prune removes them and marks the slot pruned", async () => {
    const f = await terminal(); expire(f, f.sealed[0]!);
    const plan = f.store.previewPrune(f.key, fs);
    expect(plan.slots.find(item => item.slotId === "baseline")!.remove).toEqual([{ relative: "output/answer.txt", bytes: 6 }]);
    expect(plan.retainedBytes).toBe(6);
    const result = f.store.prune(f.key, plan.digest, fs);
    expect(result.pruned).toEqual(["baseline"]);
    expect(existsSync(f.output)).toBe(false); expect(existsSync(f.directory)).toBe(false);
    expect(baselineKeep(f).keep).toEqual([{ relative: ".", reason: "already_pruned" }]);
  });
  test("a prune never deletes a receipt or a manifest: the denominator's record survives", async () => {
    const f = await terminal(); expire(f, f.sealed[0]!);
    const before = f.store.receipts(f.key);
    f.store.prune(f.key, f.store.previewPrune(f.key, fs).digest, fs);
    expect(f.store.receipts(f.key)).toEqual(before);
    expect(f.store.outcome(f.key)!.counts.succeeded + f.store.outcome(f.key)!.counts.unknown).toBeGreaterThan(0);
    expect(f.store.read(f.key)).toBeDefined();
  });
  test("previewPrune is read-only: it writes no row and removes no file", async () => {
    const f = await terminal(); expire(f, f.sealed[0]!);
    const read = () => { const db = new Database(f.db, { readonly: true }); try { return JSON.stringify(db.query("SELECT * FROM guidance_probe_receipts").all()); } finally { db.close(); } };
    const before = read();
    f.store.previewPrune(f.key, fs);
    expect(read()).toBe(before); expect(existsSync(f.output)).toBe(true);
  });
  test("prune refuses a digest that is not the current plan and removes nothing", async () => {
    const f = await terminal(); expire(f, f.sealed[0]!);
    expect(() => f.store.prune(f.key, "0".repeat(64), fs)).toThrow(GuidanceProbeError);
    expect(() => f.store.prune(f.key, "not-a-digest", fs)).toThrow(GuidanceProbeError);
    expect(existsSync(f.output)).toBe(true);
  });
  test("a plan approved before the owned set changed is refused afterwards", async () => {
    const f = await terminal(); expire(f, f.sealed[0]!);
    const approved = f.store.previewPrune(f.key, fs);
    await Bun.sleep(30); // one filesystem timestamp tick: a recycled inode is told apart by its change time
    rmSync(f.output); writeFileSync(f.output, "a replacement now owned by someone else");
    expect(() => f.store.prune(f.key, approved.digest, fs)).toThrow(GuidanceProbeError);
    expect(existsSync(f.output)).toBe(true);
  });
  test("a replaced file is kept: the slot stays retained and its replacement is untouched", async () => {
    const f = await terminal(); expire(f, f.sealed[0]!);
    await Bun.sleep(30);
    rmSync(f.output); writeFileSync(f.output, "not ours");
    const plan = f.store.previewPrune(f.key, fs);
    const result = f.store.prune(f.key, plan.digest, fs);
    expect(result.pruned).toEqual([]);
    expect(result.kept).toContainEqual({ slotId: "baseline", relative: "output/answer.txt", reason: "identity_changed" });
    expect(readFileSync(f.output, "utf8")).toBe("not ours");
    const after = baselineKeep(f);
    expect(after.keep.map(item => item.reason)).not.toContain("already_pruned");
    expect(after.keep).toContainEqual({ relative: "output/answer.txt", reason: "identity_changed" });
  });
  test("a mixed slot (one file ours, one swapped between preview and prune): ours go, the slot is NOT marked pruned, the swap survives", async () => {
    const f = await terminal(); expire(f, f.sealed[0]!);
    const second = join(f.directory, "output", "second.txt"); writeFileSync(second, "two"); const s2 = statSync(second);
    const db = new Database(f.db); try {
      const row = db.query("SELECT retained FROM guidance_probe_receipts WHERE slot_id='baseline'").get() as { retained: string };
      const record = JSON.parse(row.retained); record.files.push({ relative: "output/second.txt", dev: s2.dev, ino: s2.ino, bytes: 3, ctimeNs: statSync(second, { bigint: true }).ctimeNs.toString() });
      db.query("UPDATE guidance_probe_receipts SET retained=? WHERE slot_id='baseline'").run(JSON.stringify(record));
    } finally { db.close(); }
    const plan = f.store.previewPrune(f.key, fs);
    expect(plan.slots.find(item => item.slotId === "baseline")!.remove.map(item => item.relative).sort()).toEqual(["output/answer.txt", "output/second.txt"]);
    await Bun.sleep(30);
    rmSync(second); writeFileSync(second, "not ours");
    const current = f.store.previewPrune(f.key, fs);
    const result = f.store.prune(f.key, current.digest, fs);
    expect(existsSync(f.output)).toBe(false);
    expect(readFileSync(second, "utf8")).toBe("not ours");
    expect(result.pruned).toEqual([]);
    expect(result.kept).toContainEqual({ slotId: "baseline", relative: "output/second.txt", reason: "identity_changed" });
    expect(baselineKeep(f).keep.map(item => item.reason)).not.toContain("already_pruned");
  });
  test("an experiment with a session in flight is never prunable, however old", async () => {
    const f = fixture(), reservation = await f.baseline();
    const root = mkdtempSync(join(tmpdir(), "ahub-probe-active-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const directory = join(root, "r"); mkdirSync(directory); const dir = statSync(directory);
    f.store.sealReceipt(reservation, measured({ retained: { directory, dev: dir.dev, ino: dir.ino, files: [] } }));
    expect(f.store.read(f.key)!.receipt.state).toBe("active");
    f.clock.now = Number.MAX_SAFE_INTEGER - 1;
    const plan = f.store.previewPrune(f.key, fs);
    expect(plan.slots.every(slot => slot.remove.length === 0)).toBe(true);
    expect(plan.slots[0]!.keep[0]!.reason).toMatch(/experiment_active|no_retained_output/);
  });

  // F8: the person's or conductor's cancel releases a held experiment; usageUnknown alone never blocks.
  describe("a held or unknown experiment expires through the person's cancel", () => {
    /** A crash-reconciled experiment whose session left real retained output; the cancel is the only thing that ends the hold. */
    function heldWithOutput() {
      const f = fixture();
      const result = f.store.reserveSession({ key: f.key, expectedRevision: 0, host: f.source.host, now: 100 }, f.revalidate);
      if (result.kind !== "granted") throw new Error("reservation");
      f.store.reconcile(100);
      return f;
    }
    test("a crash-reconciled experiment (unknown_held, usage unknown) is NOT prunable until it is cancelled", () => {
      const f = heldWithOutput(); f.clock.now = Number.MAX_SAFE_INTEGER - 1;
      expect(f.store.read(f.key)!.receipt.state).toBe("unknown_held");
      expect(f.store.previewPrune(f.key, fs).slots.every(slot => slot.remove.length === 0)).toBe(true);
      expect(f.store.previewPrune(f.key, fs).slots[0]!.keep[0]!.reason).toBe("no_retained_output");
    });
    test("after the cancel, its retained output expires and is prunable; the receipt is kept and still counts as unknown", async () => {
      const f = await terminal(); const root = mkdtempSync(join(tmpdir(), "ahub-probe-held-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
      // Hold the finished experiment with a usage hold, as a latched hold after the fact would, then cancel it.
      f.store.latchHold(f.sealed.length ? (await (async () => { const state = f.store.read(f.key)!; return { key: f.key, slotId: "baseline", generation: state.sessions[0]!.generation, revision: state.sessions[0]!.revision }; })()) : (undefined as never), "usage");
      expect(f.store.read(f.key)!.receipt.state).toBe("unknown_held");
      f.clock.now = f.sealed[0]!.expiresAt;
      expect(baselineKeep(f).keep.map(item => item.reason)).toEqual(["experiment_held"]);
      f.store.cancelIntent({ key: f.key, expectedRevision: f.store.read(f.key)!.receipt.revision, host: f.source.host }, () => f.source.host);
      const plan = f.store.previewPrune(f.key, fs);
      expect(plan.slots.find(item => item.slotId === "baseline")!.remove).toEqual([{ relative: "output/answer.txt", bytes: 6 }]);
      const before = f.store.receipts(f.key);
      expect(f.store.prune(f.key, plan.digest, fs).pruned).toEqual(["baseline"]);
      expect(f.store.receipts(f.key)).toEqual(before);
      expect(existsSync(f.output)).toBe(false);
    });
    test("usageUnknown alone never blocks a prune of a finished experiment", async () => {
      const f = await terminal(); expire(f, f.sealed[0]!);
      expect(f.store.read(f.key)!.counters.usageUnknown).toBe(false);
      const db = new Database(f.db); try {
        const row = db.query("SELECT counters FROM guidance_probe_manifests").get() as { counters: string };
        db.query("UPDATE guidance_probe_manifests SET counters=?").run(JSON.stringify({ ...JSON.parse(row.counters), usageUnknown: true }));
      } finally { db.close(); }
      expect(f.store.read(f.key)!.counters.usageUnknown).toBe(true);
      expect(baselineKeep(f).remove).toEqual([{ relative: "output/answer.txt", bytes: 6 }]);
    });
  });
});

describe("a receipt reflects the host's own facts (F1)", () => {
  test("a changed host fingerprint is recorded, never replaced by the declaration, and makes the pair incomparable (input_drift)", async () => {
    const f = fixture(), reservations = await f.runAll();
    const drifted = { runtimeSha256: probeHash("another-runtime"), toolsetSha256: declared.toolsetSha256, modelConfigSha256: declared.modelConfigSha256 };
    const sealed = reservations.map((reservation, index) => f.store.sealReceipt(reservation, measured(index === 0 ? { runtime: drifted } : {})));
    expect(sealed[0]!.runtimeSha256).toBe(drifted.runtimeSha256);
    expect(sealed[0]!.runtimeSha256).not.toBe(f.source.registration.manifest.runtime.runtimeSha256);
    expect(sealed[1]!.runtimeSha256).toBe(declared.runtimeSha256);
    const status = f.store.outcome(f.key)!;
    expect(status.comparability.comparable).toBe(false);
    expect(status.comparability.reasons).toContain("input_drift");
  });
  test("a host that could not read its fingerprints records null, and that is unverified coverage, never the declaration", async () => {
    const f = fixture(), reservation = await f.baseline();
    const sealed = f.store.sealReceipt(reservation, measured({ runtime: null }));
    expect(sealed.runtimeSha256).toBeNull(); expect(sealed.toolsetSha256).toBeNull(); expect(sealed.modelConfigSha256).toBeNull();
    expect(sealed.state).not.toBe("succeeded"); expect(sealed.limits).toContain("coverage_unverified");
  });
  test("matching host and declared fingerprints leave the experiment comparable on that axis", async () => {
    const f = fixture(), reservations = await f.runAll();
    // Workers carry the non-guidance hash the baseline had; the editor slots carry none. Only the fingerprints are under test here.
    const workerFacts = { workerEffectiveInputSha256: probeHash("w"), nonGuidanceInputSha256: probeHash("n") };
    const state = f.store.read(f.key)!;
    reservations.forEach(reservation => f.store.sealReceipt(reservation, measured(state.registration.manifest.slots.find(slot => slot.id === reservation.slotId)!.role === "worker" ? workerFacts : {})));
    expect(f.store.outcome(f.key)!.comparability.reasons).not.toContain("input_drift");
  });
});

describe("a receipt is derived from the session's own settled facts (F2)", () => {
  test("tokensObserved is this session's, not the experiment's running total", async () => {
    const f = fixture(), reservations = await f.runAll();
    const sealed = reservations.map(reservation => f.store.sealReceipt(reservation, measured()));
    const total = f.store.read(f.key)!.counters.tokensObservedKnown;
    const each = sealed.map(item => item.usage.tokensObserved);
    expect(each.every(value => value === 10)).toBe(true); // the fake provider observes 10 tokens per session
    expect(total).toBe(10 * sealed.length);
    expect(each[1]).toBeLessThan(total);
  });
  test("an identical replay after a LATER session ran returns the stored receipt and latches nothing", async () => {
    const f = fixture(), baseline = await f.baseline();
    const first = f.store.sealReceipt(baseline, measured());
    // A later session runs and settles: the experiment's running totals move, which must not change what the first session's receipt would say.
    const rest = await f.runAll();
    expect(rest.length).toBeGreaterThan(0);
    const again = f.store.sealReceipt(baseline, measured());
    expect(again).toEqual(first);
    expect(f.store.read(f.key)!.admissionHold).toBe("none");
  });
  test("a cancel that arrives after a session settled cannot change its replayed receipt", async () => {
    const f = fixture(), baseline = await f.baseline();
    const first = f.store.sealReceipt(baseline, measured());
    f.store.cancelIntent({ key: f.key, expectedRevision: f.store.read(f.key)!.receipt.revision, host: f.source.host }, () => f.source.host);
    expect(f.store.sealReceipt(baseline, measured())).toEqual(first);
    expect(f.store.read(f.key)!.admissionHold).toBe("none");
  });
  test("a changed measured fact still latches the hold (the replay check was not loosened)", async () => {
    const f = fixture(), baseline = await f.baseline();
    f.store.sealReceipt(baseline, measured());
    expect(() => f.store.sealReceipt(baseline, measured({ runtime: { ...measured().runtime!, runtimeSha256: probeHash("x") } }))).toThrow(GuidanceProbeError);
    expect(f.store.read(f.key)!.admissionHold).toBe("observation");
  });
});

describe("what the host cannot vouch for is unknown, not cancelled or timed out (F3)", () => {
  /** Reserve a session, then make the experiment look the way it does after a cancel request or an elapsed hold, then crash. */
  function crashedAfter(setup: (f: ReturnType<typeof fixture>) => void) {
    const f = fixture();
    const result = f.store.reserveSession({ key: f.key, expectedRevision: 0, host: f.source.host, now: 100 }, f.revalidate);
    if (result.kind !== "granted") throw new Error("reservation");
    setup(f);
    return f;
  }
  test("a crash after a cancel request reconciles as unknown (teardown unverified), not cancelled", () => {
    const f = crashedAfter(x => { x.store.cancelIntent({ key: x.key, expectedRevision: x.store.read(x.key)!.receipt.revision, host: x.source.host }, () => x.source.host); });
    expect(f.store.read(f.key)!.cancelRequested).toBe(true);
    f.store.reconcile(200);
    const [sealed] = f.store.receipts(f.key);
    expect(sealed!.state).toBe("unknown"); expect(sealed!.limits).toContain("teardown_unverified");
    expect(f.store.outcome(f.key)!.counts).toMatchObject({ unknown: 1, cancelled: 0, timed_out: 0 });
  });
  test("a crash with an elapsed hold already latched reconciles as unknown, not timed_out", () => {
    const f = crashedAfter(x => { x.store.latchHold({ key: x.key, slotId: "baseline", generation: 1, revision: 1 }, "elapsed"); });
    expect(f.store.read(f.key)!.admissionHold).toBe("elapsed");
    f.store.reconcile(200);
    const [sealed] = f.store.receipts(f.key);
    expect(sealed!.state).toBe("unknown");
    expect(f.store.outcome(f.key)!.counts).toMatchObject({ unknown: 1, timed_out: 0 });
  });
  // The order is what is under test: the session settled UNDER a cancel (so its own cause is `cancel`), and then its teardown was not verified. The host
  // cannot vouch for it, so it is `unknown`; `cancelled` would claim a clean stop the host never saw. With a verified teardown the same session IS cancelled.
  test("a session that settled under a cancel is unknown when its teardown was not verified, and cancelled when it was", async () => {
    for (const [teardownVerified, expected] of [[false, "unknown"], [true, "cancelled"]] as const) {
      const f = fixture(), { reservation } = f.openNext();
      f.store.cancelIntent({ key: f.key, expectedRevision: f.store.read(f.key)!.receipt.revision, host: f.source.host }, () => f.source.host);
      f.store.settleObservedSession({ reservation, outcome: "closed_fixture", candidateArtifactSha256: null, now: f.clock.now }, "known_fixture");
      expect(f.store.read(f.key)!.sessions[0]!.state).toBe("unknown_held");
      expect(f.store.sealReceipt(reservation, measured({ teardownVerified })).state, String(teardownVerified)).toBe(expected);
    }
  });
  test("an elapsed hold at settlement is timed_out with a verified teardown and unknown without one", async () => {
    for (const [teardownVerified, expected] of [[false, "unknown"], [true, "timed_out"]] as const) {
      const f = fixture(), { reservation } = f.openNext();
      f.store.latchHold(reservation, "elapsed");
      f.store.settleObservedSession({ reservation, outcome: "closed_fixture", candidateArtifactSha256: null, now: f.clock.now }, "known_fixture");
      expect(f.store.sealReceipt(reservation, measured({ teardownVerified })).state, String(teardownVerified)).toBe(expected);
    }
  });
  test("a confinement error after a model call is never `unavailable`: only a session that could not start is", async () => {
    const f = fixture(), baseline = await f.baseline(); // the baseline made one model call
    expect(f.store.read(f.key)!.sessions[0]!.coverage.modelCalls).toBeGreaterThan(0);
    expect(f.store.sealReceipt(baseline, measured({ unavailable: true })).state).not.toBe("unavailable");
  });
  test("a session that never called the model and could not start IS unavailable", () => {
    const f = fixture();
    const result = f.store.reserveSession({ key: f.key, expectedRevision: 0, host: f.source.host, now: 100 }, f.revalidate);
    if (result.kind !== "granted") throw new Error("reservation");
    const settled = f.store.settlePreLaunchAndSeal(result.reservation, 100, measured({ unavailable: true, teardownVerified: true }));
    expect(settled.sealed.state).toBe("unavailable");
    expect(f.store.outcome(f.key)!.counts.unavailable).toBe(1);
  });
});

describe("settlement and receipt are one transaction (F6)", () => {
  test("a run through the host leaves every settled session with its receipt, even when the adapter measured nothing", async () => {
    const f = fixture(); await f.runAllThroughHost();
    const state = f.store.read(f.key)!;
    const settled = state.sessions.filter(item => !["planned", "not_needed"].includes(item.state));
    const sealed = f.store.receipts(f.key);
    expect(settled.length).toBeGreaterThan(0);
    expect(sealed.map(item => item.slotId).sort()).toEqual(settled.map(item => item.slotId).sort());
    // The fake provider reports no measurement, so the host sealed its conservative one: never a success it could not witness.
    expect(sealed.every(item => item.state !== "succeeded")).toBe(true);
  });
  test("a seal that fails rolls the settlement back too: the session is still open, not settled without a receipt", async () => {
    const f = fixture(); const { reservation } = f.openNext();
    const result = { reservation };
    const before = f.store.read(f.key)!.sessions[0]!.state;
    expect(before).toBe("running");
    // A malformed retained record is refused inside the seal, after the settlement was written in the same transaction.
    const bad = measured({ retained: { directory: "relative/not/absolute", dev: 1, ino: 1, files: [] } });
    expect(() => f.store.settleAndSeal({ reservation: result.reservation, outcome: "closed_fixture", candidateArtifactSha256: null, now: 100 }, "known_fixture", bad)).toThrow(GuidanceProbeError);
    expect(f.store.read(f.key)!.sessions[0]!.state).toBe(before);
    expect(f.store.receipts(f.key)).toEqual([]);
    // The unsettled session is what reconcile records at the next start.
    expect(f.store.reconcile(300)).toEqual({ reconciled: 1, failed: 0 });
    expect(f.store.receipts(f.key)[0]!.state).toBe("unknown");
  });
  test("the host settles an adapter failure as unknown WITH a receipt, so the session is not receipt-less", async () => {
    const f = fixture(); f.provider.script = async () => { throw new Error("adapter crashed"); };
    const host = new GuidanceProbeFixtureHost(f.store, { ports: f.provider, revalidate: f.revalidate, now: () => f.clock.now });
    await expect(host.start({ key: f.key, expectedRevision: 0, host: f.source.host, now: f.clock.now }, new AbortController().signal)).rejects.toBeInstanceOf(GuidanceProbeError);
    const state = f.store.read(f.key)!;
    expect(state.sessions[0]!.state).toBe("unknown_held");
    expect(f.store.receipts(f.key).map(item => item.slotId)).toEqual(["baseline"]);
    expect(f.store.receipts(f.key)[0]!.state).toBe("unknown");
  });
});

describe("hydration checks the session row (N1)", () => {
  const edit = (file: string, sql: string, ...args: (string | number)[]) => { const db = new Database(file); try { db.query(sql).run(...args); } finally { db.close(); } };
  test("a receipt whose revision differs from its session row is storage corruption", async () => {
    const f = fixture(), reservation = await f.baseline(); f.store.sealReceipt(reservation, measured());
    edit(f.file, "UPDATE guidance_probe_sessions SET body=replace(body,'\"revision\":1','\"revision\":2') WHERE slot_id='baseline'");
    expect(() => f.store.receipts(f.key)).toThrow(GuidanceProbeError);
  });
  test("a receipt whose state no session state could produce is refused (a `failed` receipt on a closed session)", async () => {
    const f = fixture(), reservation = await f.baseline(); f.store.sealReceipt(reservation, measured());
    const db = new Database(f.file); try {
      const row = db.query("SELECT body FROM guidance_probe_receipts").get() as { body: string };
      const body = JSON.parse(row.body); body.state = "failed"; body.limits = []; delete body.digest;
      body.digest = probeReceiptDigest(body);
      db.query("UPDATE guidance_probe_receipts SET body=?").run(JSON.stringify(body));
    } finally { db.close(); }
    expect(() => f.store.receipts(f.key)).toThrow(GuidanceProbeError);
  });
});

describe("a truly read-only open (N2)", () => {
  test("a Store opened read-only reads receipts and outcome, and its write paths fail", async () => {
    const f = fixture(), reservation = await f.baseline(); f.store.sealReceipt(reservation, measured());
    const ro = new GuidanceProbeStore(f.file, () => 100, true); cleanup.push(() => ro.close());
    expect(ro.receipts(f.key)).toHaveLength(1); expect(ro.outcome(f.key)!.counts.succeeded).toBe(1);
    expect(() => ro.reconcile(500)).not.toThrow(); // nothing to reconcile: the loop finds no row to write
    expect(() => ro.sealReceipt(reservation, measured({ servedModel: "other/model" }))).toThrow(GuidanceProbeError);
  });
  test("a read-only open over an unreconciled crash leaves every row byte-identical; reconcile through it fails instead of writing", () => {
    const f = fixture(); const result = f.store.reserveSession({ key: f.key, expectedRevision: 0, host: f.source.host, now: 100 }, f.revalidate);
    if (result.kind !== "granted") throw new Error("reservation");
    const dump = () => { const db = new Database(f.file, { readonly: true }); try { return JSON.stringify([db.query("SELECT * FROM guidance_probe_manifests").all(), db.query("SELECT * FROM guidance_probe_sessions").all(), db.query("SELECT * FROM guidance_probe_receipts").all()]); } finally { db.close(); } };
    const before = dump();
    const ro = new GuidanceProbeStore(f.file, () => 100, true); cleanup.push(() => ro.close());
    ro.read(f.key); ro.receipts(f.key); ro.outcome(f.key); ro.integrity(); ro.hasRecords(); ro.previewPrune(f.key, { preview: record => previewRetained(record), remove: record => removeRetained(record) });
    expect(dump()).toBe(before);
    expect(() => ro.reconcile(500)).toThrow(GuidanceProbeError);
    expect(dump()).toBe(before);
  });
});

// R2: a session that meets every success condition and writes the most files with the longest allowed names must seal as a success, not roll back at the digest.
describe("the largest valid manifest seals as a success (R2)", () => {
  const name = (index: number) => { const head = `output/${String(index).padStart(3, "0")}-`; return head + "x".repeat(PROBE_OUTPUT_LIMITS.nameBytes - Buffer.byteLength(head)); };
  test("64 entries with the longest allowed names seal as succeeded and read back", async () => {
    const f = fixture(), reservation = await f.baseline();
    const entries = Array.from({ length: PROBE_OUTPUT_LIMITS.entries }, (_, i) => ({ relative: name(i), sha256: probeHash(`f${i}`), bytes: 1 }));
    // The fixture declares a small output bound; this test is about the receipt record, so the bound is the one the manifest declares.
    const sealed = f.store.sealReceipt(reservation, measured({ output: { v: 1, entries, excluded: [], totalBytes: entries.length } }));
    expect(sealed.state).toBe("succeeded"); expect(sealed.output.entries).toHaveLength(PROBE_OUTPUT_LIMITS.entries);
    expect(Buffer.byteLength(JSON.stringify(sealed))).toBeLessThanOrEqual(PROBE_OUTPUT_LIMITS.receiptBytes);
    expect(f.store.receipts(f.key)).toEqual([sealed]);
    expect(f.store.outcome(f.key)!.counts.succeeded).toBe(1);
  });
  test("a receipt hydration would refuse is never written: the seal refuses it whole instead of leaving corrupt storage", async () => {
    const f = fixture(), reservation = await f.baseline();
    const bad = { relative: "output/" + "y".repeat(PROBE_OUTPUT_LIMITS.nameBytes), sha256: probeHash("y"), bytes: 1 };
    expect(() => f.store.sealReceipt(reservation, measured({ output: { v: 1, entries: [bad], excluded: [], totalBytes: 1 } }))).toThrow(GuidanceProbeError);
    expect(f.store.receipts(f.key)).toEqual([]);
    expect(() => f.store.integrity()).not.toThrow();
  });
});

// N4: one bad experiment must not hide the others, and the daemon must be able to log why.
describe("reconcile visits every experiment (N4)", () => {
  test("a corrupt experiment is reported with its key and the next experiment is still reconciled", () => {
    const f = fixture();
    const result = f.store.reserveSession({ key: f.key, expectedRevision: 0, host: f.source.host, now: 100 }, f.revalidate);
    if (result.kind !== "granted") throw new Error("reservation");
    // A second experiment whose stored state is unreadable sorts BEFORE the real one, so a loop that stops at the first failure never reaches it.
    const db = new Database(f.file);
    try {
      db.query("INSERT INTO guidance_probe_manifests SELECT project, ?, ?, manifest, task_input, baseline_context, data_policy, system_policy, improver_context, binding, counters, revision, state, first_reserved, last_wall, admission_hold, cancel_requested FROM guidance_probe_manifests")
        .run("0".repeat(64), "other-experiment");
      db.query("UPDATE guidance_probe_manifests SET counters='not json' WHERE id=?").run("0".repeat(64));
    } finally { db.close(); }
    const failures: { id: string | undefined; reason: string }[] = [];
    const outcome = f.store.reconcile(200, (key, error) => failures.push({ id: key?.id, reason: error instanceof GuidanceProbeError ? error.reason : "error" }));
    expect(outcome.failed).toBe(1); expect(failures).toEqual([{ id: "0".repeat(64), reason: expect.any(String) }]);
    expect(outcome.reconciled).toBe(1);
    expect(f.store.receipts(f.key)[0]!.state).toBe("unknown");
  });
  test("with no callback the first failure is thrown only AFTER every experiment was tried", () => {
    const f = fixture();
    const result = f.store.reserveSession({ key: f.key, expectedRevision: 0, host: f.source.host, now: 100 }, f.revalidate);
    if (result.kind !== "granted") throw new Error("reservation");
    const db = new Database(f.file);
    try {
      db.query("INSERT INTO guidance_probe_manifests SELECT project, ?, ?, manifest, task_input, baseline_context, data_policy, system_policy, improver_context, binding, counters, revision, state, first_reserved, last_wall, admission_hold, cancel_requested FROM guidance_probe_manifests")
        .run("0".repeat(64), "other-experiment");
      db.query("UPDATE guidance_probe_manifests SET counters='not json' WHERE id=?").run("0".repeat(64));
    } finally { db.close(); }
    expect(() => f.store.reconcile(200)).toThrow(GuidanceProbeError);
    expect(f.store.receipts(f.key)[0]!.state).toBe("unknown");
  });
});

// N5: a receipt must describe the session it sits beside, and the recovery pass is where an edited pair is caught.
describe("integrity cross-checks receipts against sessions (N5)", () => {
  const edit = (file: string, sql: string, ...args: (string | number)[]) => { const db = new Database(file); try { db.query(sql).run(...args); } finally { db.close(); } };
  test("a receipt whose generation does not match its session fails the recovery integrity pass", async () => {
    const f = fixture(), reservation = await f.baseline(); f.store.sealReceipt(reservation, measured());
    expect(() => f.store.integrity()).not.toThrow();
    const body = JSON.parse(new Database(f.file, { readonly: true }).query("SELECT body FROM guidance_probe_receipts").get()!["body" as never] as string);
    const { digest: _digest, ...rest } = body; const moved = { ...rest, generation: rest.generation + 1 };
    edit(f.file, "UPDATE guidance_probe_receipts SET body=?", JSON.stringify({ ...moved, digest: probeReceiptDigest(moved) }));
    expect(() => f.store.integrity()).toThrow(GuidanceProbeError);
  });
  test("a receipt claiming success for a session that did not close fails the recovery integrity pass too", async () => {
    const f = fixture(), reservation = await f.baseline(); f.store.sealReceipt(reservation, measured());
    f.store.latchHold(reservation, "usage");
    edit(f.file, "UPDATE guidance_probe_sessions SET body=replace(body,'\"closed_fixture\"','\"unknown_held\"') WHERE slot_id='baseline'");
    expect(() => f.store.integrity()).toThrow(GuidanceProbeError);
  });
});

// N6: the in-flight guard must be what blocks the prune, so the session has to be reserved or running and the experiment otherwise prunable.
describe("an in-flight session blocks a prune on its own (N6)", () => {
  const fs: ProbeRetentionFs = { preview: record => previewRetained(record), remove: record => removeRetained(record) };
  test("a cancelled experiment (otherwise prunable) with one session still running is not prunable", async () => {
    const f = fixture();
    const first = await f.baseline();
    const root = mkdtempSync(join(tmpdir(), "ahub-probe-inflight-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const directory = join(root, "r"); mkdirSync(join(directory, "output"), { recursive: true });
    const file = join(directory, "output", "a.txt"); writeFileSync(file, "a");
    const stat = statSync(file, { bigint: true }), dir = statSync(directory);
    const record = { directory, dev: dir.dev, ino: dir.ino, files: [{ relative: "output/a.txt", dev: Number(stat.dev), ino: Number(stat.ino), bytes: 1, ctimeNs: stat.ctimeNs.toString() }] };
    const sealed = f.store.sealReceipt(first, measured({ retained: record, output: { v: 1, entries: [{ relative: "output/a.txt", sha256: probeHash("a"), bytes: 1 }], excluded: [], totalBytes: 1 } }));
    // The next session is reserved and running. The person's cancel makes the experiment "finished" by the state rule, so ONLY the in-flight guard can block.
    f.openNext();
    f.store.cancelIntent({ key: f.key, expectedRevision: f.store.read(f.key)!.receipt.revision, host: f.source.host }, () => f.source.host);
    expect(f.store.read(f.key)!.cancelRequested).toBe(true);
    expect(f.store.read(f.key)!.sessions.some(item => ["reserved", "running"].includes(item.state))).toBe(true);
    f.clock.now = sealed.expiresAt;
    const plan = f.store.previewPrune(f.key, fs);
    expect(plan.slots.find(item => item.slotId === sealed.slotId)!.keep.map(item => item.reason)).toEqual(["experiment_active"]);
    expect(plan.retainedBytes).toBe(0);
    f.store.prune(f.key, plan.digest, fs);
    expect(existsSync(file)).toBe(true);
  });
});
