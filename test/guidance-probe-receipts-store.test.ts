import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { GuidanceProbeFixtureHost, GuidanceProbeStore } from "../src/hub/guidance-probe-store.ts";
import { GUIDANCE_PROBE_MODEL, GuidanceProbeError, PROBE_RETENTION_MS, probeHash, type ProbeChildBinding, type ProbeMeasuredSession, type ProbeReservation, type ProbeRetentionFs } from "../src/hub/guidance-probes.ts";
import { previewRetained, removeRetained } from "../src/local/probe-workspace.ts";
import { FakeGuidanceProbeProvider, fakeEffectValue, guidanceProbeFixture, guidanceProbeFixtureKey } from "./fakes/guidance-probe-provider.ts";

// #1226 T3 Store contract: seal once, hydrate with tamper detection, reconcile only on an explicit call, and report the outcome denominator privately.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const measured = (over: Partial<ProbeMeasuredSession> = {}): ProbeMeasuredSession => ({ startedAt: 100, servedModel: GUIDANCE_PROBE_MODEL, workerEffectiveInputSha256: null, nonGuidanceInputSha256: null,
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
  /** Run every planned session, in order, to a settled state: the smallest honest way to a terminal (closed) experiment. Returns the reservations in order. */
  async function runAll(): Promise<ProbeReservation[]> {
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
  /** Run the planned baseline worker session to a settled state with fully known usage, returning its reservation. */
  async function baseline(): Promise<ProbeReservation> {
    let reservation!: ProbeReservation;
    const run = new GuidanceProbeFixtureHost(store, { ports: provider, revalidate, now: () => clock.now, onReserved: value => { reservation = value; } });
    await run.start({ key, expectedRevision: store.read(key)!.receipt.revision, host: source.host, now: clock.now }, new AbortController().signal);
    return reservation;
  }
  return { directory, file, store, key, clock, source, revalidate, provider, host, baseline, runAll };
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
    for (const [over, state] of [[{ cancelled: true }, "cancelled"], [{ unavailable: true }, "unavailable"], [{ timedOut: true }, "timed_out"]] as const) {
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
    expect(f.store.reconcile(200)).toEqual({ reconciled: 1 });
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
    expect(f.store.reconcile(300)).toEqual({ reconciled: 0 });
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
    expect(f.store.reconcile(500)).toEqual({ reconciled: 0 });
    expect(f.store.receipts(f.key)).toEqual([sealed]);
  });
  test("an experiment with nothing in flight is untouched by reconcile", () => {
    const f = fixture(); const before = rows(f.file);
    expect(f.store.reconcile(500)).toEqual({ reconciled: 0 });
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

  test("the experiment really is terminal here, so the cases below test prune and not the fixture", async () => {
    const f = await terminal();
    expect(["closed_fixture", "failed_fixture"]).toContain(f.store.read(f.key)!.receipt.state);
    expect(f.sealed.length).toBeGreaterThan(1);
  });
  test("nothing is prunable before the output's own expiresAt, and the plan says why", async () => {
    const f = await terminal();
    const plan = f.store.previewPrune(f.key, f.sealed[0]!.expiresAt - 1, fs);
    expect(plan.slots.find(item => item.slotId === "baseline")!.keep).toEqual([{ relative: ".", reason: "not_expired" }]);
    expect(plan.retainedBytes).toBe(0);
    f.store.prune(f.key, f.sealed[0]!.expiresAt - 1, plan.digest, fs);
    expect(existsSync(f.output)).toBe(true);
  });
  test("after expiry, preview lists the exact files, then prune removes them and marks the slot pruned", async () => {
    const f = await terminal(); const now = f.sealed[0]!.expiresAt;
    const plan = f.store.previewPrune(f.key, now, fs);
    expect(plan.slots.find(item => item.slotId === "baseline")!.remove).toEqual([{ relative: "output/answer.txt", bytes: 6 }]);
    expect(plan.retainedBytes).toBe(6);
    const result = f.store.prune(f.key, now, plan.digest, fs);
    expect(result.pruned).toEqual(["baseline"]);
    expect(existsSync(f.output)).toBe(false); expect(existsSync(f.directory)).toBe(false);
    expect(f.store.previewPrune(f.key, now, fs).slots.find(item => item.slotId === "baseline")!.keep).toEqual([{ relative: ".", reason: "already_pruned" }]);
  });
  test("a prune never deletes a receipt or a manifest: the denominator's record survives", async () => {
    const f = await terminal(); const now = f.sealed[0]!.expiresAt;
    const before = f.store.receipts(f.key);
    f.store.prune(f.key, now, f.store.previewPrune(f.key, now, fs).digest, fs);
    expect(f.store.receipts(f.key)).toEqual(before);
    expect(f.store.outcome(f.key)!.counts.succeeded + f.store.outcome(f.key)!.counts.unknown).toBeGreaterThan(0);
    expect(f.store.read(f.key)).toBeDefined();
  });
  test("previewPrune is read-only: it writes no row and removes no file", async () => {
    const f = await terminal(); const read = () => { const db = new Database(f.db, { readonly: true }); try { return JSON.stringify(db.query("SELECT * FROM guidance_probe_receipts").all()); } finally { db.close(); } };
    const before = read();
    f.store.previewPrune(f.key, f.sealed[0]!.expiresAt, fs);
    expect(read()).toBe(before); expect(existsSync(f.output)).toBe(true);
  });
  test("prune refuses a digest that is not the current plan and removes nothing", async () => {
    const f = await terminal(); const now = f.sealed[0]!.expiresAt;
    expect(() => f.store.prune(f.key, now, "0".repeat(64), fs)).toThrow(GuidanceProbeError);
    expect(() => f.store.prune(f.key, now, "not-a-digest", fs)).toThrow(GuidanceProbeError);
    expect(existsSync(f.output)).toBe(true);
  });
  test("a plan approved before the owned set changed is refused afterwards", async () => {
    const f = await terminal(); const now = f.sealed[0]!.expiresAt;
    const approved = f.store.previewPrune(f.key, now, fs);
    await Bun.sleep(30); // one filesystem timestamp tick: a recycled inode is told apart by its change time
    rmSync(f.output); writeFileSync(f.output, "a replacement now owned by someone else");
    expect(() => f.store.prune(f.key, now, approved.digest, fs)).toThrow(GuidanceProbeError);
    expect(existsSync(f.output)).toBe(true);
  });
  test("a replaced file is kept: the slot stays retained and its replacement is untouched", async () => {
    const f = await terminal(); const now = f.sealed[0]!.expiresAt;
    await Bun.sleep(30); // one filesystem timestamp tick: a recycled inode is told apart by its change time
    rmSync(f.output); writeFileSync(f.output, "not ours");
    const plan = f.store.previewPrune(f.key, now, fs);
    const result = f.store.prune(f.key, now, plan.digest, fs);
    expect(result.pruned).toEqual([]);
    expect(result.kept).toContainEqual({ slotId: "baseline", relative: "output/answer.txt", reason: "identity_changed" });
    expect(readFileSync(f.output, "utf8")).toBe("not ours");
    // The slot is NOT marked pruned: a later preview still sees it as retained, so the kept file is never forgotten.
    const after = f.store.previewPrune(f.key, now, fs).slots.find(item => item.slotId === "baseline")!;
    expect(after.keep.map(item => item.reason)).not.toContain("already_pruned");
    expect(after.keep).toContainEqual({ relative: "output/answer.txt", reason: "identity_changed" });
  });
  test("a mixed slot (one file ours, one swapped between preview and prune): ours go, the slot is NOT marked pruned, the swap survives", async () => {
    const f = await terminal(); const now = f.sealed[0]!.expiresAt;
    // Give the retained record a second file so one can be swapped while the other is still ours.
    const second = join(f.directory, "output", "second.txt"); writeFileSync(second, "two"); const s2 = statSync(second);
    const db = new Database(f.db); try {
      const row = db.query("SELECT retained FROM guidance_probe_receipts WHERE slot_id='baseline'").get() as { retained: string };
      const record = JSON.parse(row.retained); record.files.push({ relative: "output/second.txt", dev: s2.dev, ino: s2.ino, bytes: 3, ctimeNs: statSync(second, { bigint: true }).ctimeNs.toString() });
      db.query("UPDATE guidance_probe_receipts SET retained=? WHERE slot_id='baseline'").run(JSON.stringify(record));
    } finally { db.close(); }
    const plan = f.store.previewPrune(f.key, now, fs);
    expect(plan.slots.find(item => item.slotId === "baseline")!.remove.map(item => item.relative).sort()).toEqual(["output/answer.txt", "output/second.txt"]);
    // Between the person's preview and the prune, make the second file a stranger's. A fresh digest is computed inside prune, so approve THAT plan's digest.
    await Bun.sleep(30); // one filesystem timestamp tick: a recycled inode is told apart by its change time
    rmSync(second); writeFileSync(second, "not ours");
    const current = f.store.previewPrune(f.key, now, fs);
    const result = f.store.prune(f.key, now, current.digest, fs);
    expect(existsSync(f.output)).toBe(false);
    expect(readFileSync(second, "utf8")).toBe("not ours");
    expect(result.pruned).toEqual([]);
    expect(result.kept).toContainEqual({ slotId: "baseline", relative: "output/second.txt", reason: "identity_changed" });
    expect(f.store.previewPrune(f.key, now, fs).slots.find(item => item.slotId === "baseline")!.keep.map(item => item.reason)).not.toContain("already_pruned");
  });
  test("an unknown-held (crashed) experiment is never prunable, however old", async () => {
    const f = fixture(); const crashed = f.store.reserveSession({ key: f.key, expectedRevision: 0, host: f.source.host, now: 100 }, f.revalidate);
    if (crashed.kind !== "granted") throw new Error("reservation");
    f.store.reconcile(100);
    const plan = f.store.previewPrune(f.key, Number.MAX_SAFE_INTEGER - 1, fs);
    for (const slot of plan.slots) expect(slot.remove).toEqual([]);
    expect(plan.retainedBytes).toBe(0);
  });
  test("an experiment that is still active (not terminal) is not prunable", async () => {
    const f = fixture(), reservation = await f.baseline();
    const root = mkdtempSync(join(tmpdir(), "ahub-probe-active-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const directory = join(root, "r"); mkdirSync(directory); const dir = statSync(directory);
    f.store.sealReceipt(reservation, measured({ retained: { directory, dev: dir.dev, ino: dir.ino, files: [] } }));
    expect(f.store.read(f.key)!.receipt.state).toBe("active");
    const plan = f.store.previewPrune(f.key, Number.MAX_SAFE_INTEGER - 1, fs);
    expect(plan.slots.every(slot => slot.remove.length === 0)).toBe(true);
    expect(plan.slots[0]!.keep[0]!.reason).toMatch(/experiment_active|no_retained_output/);
  });
});
