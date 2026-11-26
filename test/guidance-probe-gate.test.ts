import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { USER } from "../src/hub/envelope.ts";
import { GUIDANCE_PROBE_MODEL, parseGuidanceProbeReceiptExport, probeHash } from "../src/hub/guidance-probes.ts";
import { guidanceProbeStatusLines } from "../src/ui/guidance-view.ts";
import { fakeEffectValue } from "./fakes/guidance-probe-provider.ts";
import { probeTasksFixture, runProbeExperiment, witnessedProbe } from "./helpers/guidance-probe-tasks.ts";

// #1226 T4 / AC7, the FAKE-PROVIDER leg only. One end-to-end pass over the real Tasks + Store + Bus lifecycle with the fake provider, reading the result through
// the same export the producer panel and the CLI print. It proves the T1..T3 contracts hold TOGETHER from register to export; it does NOT prove, and nothing in
// it claims, a real model call, a real worker, OS-level isolation, effective guidance delivery to a model or sampling control. AC7's authorized live
// local-worker trial is NOT run here and stays open (#1226).
const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
const rows = (file: string) => { const db = new Database(file, { readonly: true }); try {
  return JSON.stringify([db.query("SELECT * FROM guidance_probe_manifests").all(), db.query("SELECT * FROM guidance_probe_sessions").all(), db.query("SELECT * FROM guidance_probe_lanes").all(), db.query("SELECT * FROM guidance_probe_receipts").all()]);
} finally { db.close(); } };

test("AC7 fake-provider leg: register, run baseline and candidate, seal, and read the export, with every contract holding at once", async () => {
  const f = await probeTasksFixture(clean), taskBefore = f.tasks.publicView(f.board.get(f.taskId)!);
  const run = await runProbeExperiment(f), exported = await f.tasks.guidanceProbeReceipts(USER, run.id);
  // The lifecycle ran exactly the planned slots, each launched once through the fake provider and nothing else.
  expect(f.provider.launches.map(launch => launch.slot.id)).toEqual(["baseline", "candidate1"]);
  // AC1: baseline and candidate share every non-guidance input byte; only the admitted guidance differs.
  const [baseline, candidate] = f.provider.launches;
  expect(baseline!.nonGuidanceInputSha256).toBe(candidate!.nonGuidanceInputSha256); expect(baseline!.inputSha256).not.toBe(candidate!.inputSha256);
  // AC3: shared budgets include every session; one attempt per slot, one model call per slot, no silent second execution.
  expect(exported.status.counters).toMatchObject({ workerAttempts: 2, editorAttempts: 0, modelCalls: 2 });
  // AC4: the denominator is complete and the export says exactly why the pair is or is not comparable. This fixture's candidate is an ordinary G1 variant, so the
  // authoring is `uncontrolled` and the pair is honestly NOT comparable, with that one reason, though both arms succeeded.
  expect(exported.counts).toMatchObject({ succeeded: 2, failed: 0, cancelled: 0, timed_out: 0, unavailable: 0, unknown: 0, planned: 0, not_needed: 0 });
  expect(exported.comparable).toBe(false); expect(exported.reasons).toEqual(["authoring_uncontrolled"]);
  // AC4/AC6: every receipt is host-sealed, digest-verified, bound to its slot, and carries the host's own measurement.
  for (const slot of exported.slots) {
    const receipt = slot.receipt!;
    expect(receipt.state).toBe("succeeded"); expect(receipt.servedModel).toBe(GUIDANCE_PROBE_MODEL); expect(receipt.requestedModel).toBe(GUIDANCE_PROBE_MODEL);
    expect(receipt.slotId).toBe(slot.slotId); expect(receipt.limits).toEqual([]); expect(receipt.usage.tokensObserved).not.toBeNull();
  }
  // AC5: nothing reached an ordinary observer: no message, no PII screen, no lineage read, and the task's public bytes are unchanged.
  expect(f.messages).toHaveLength(0); expect(f.control.screenCalls).toBe(0); expect(f.control.resolverCalls).toBe(0);
  expect(f.tasks.publicView(f.board.get(f.taskId)!)).toEqual(taskBefore);
  // The export is what the consumer's closed parser accepts, and its text states the fixture-only scope.
  expect(parseGuidanceProbeReceiptExport(JSON.parse(JSON.stringify(exported)))).toEqual(exported);
  const text = guidanceProbeStatusLines(exported).join("\n");
  expect(text).toContain("Fixture evidence only"); expect(text).toContain("no live model or worker trial");
}, 30_000);

test("reading the result, any number of times, writes nothing and launches nothing", async () => {
  const f = await probeTasksFixture(clean), run = await runProbeExperiment(f);
  const before = rows(f.file), launches = f.provider.launches.length, integrity = f.store.integrity();
  for (let i = 0; i < 3; i++) { await f.tasks.guidanceProbeShow(USER, run.id); await f.tasks.guidanceProbeReceipts(USER, run.id); }
  expect(rows(f.file)).toBe(before); expect(f.provider.launches).toHaveLength(launches); expect(f.store.integrity()).toEqual(integrity);
});

test("a restart in the middle of a probe: the dead process's session is recorded unknown, counted in the denominator and never launched again (AC3, AC6)", async () => {
  const f = await probeTasksFixture(clean), receipt = await f.tasks.guidanceProbeRegister(USER, f.registration());
  // The previous process reserved the baseline and died before settling it.
  const key = { projectKey: f.projectKey, id: receipt.id }, host = f.store.read(key)!.binding;
  const reserved = f.store.reserveSession({ key, expectedRevision: 0, host, now: f.clock.now }, () => ({ host }));
  if (reserved.kind !== "granted") throw new Error("expected a reservation");
  expect(f.store.receipts(key)).toEqual([]);
  const before = f.provider.launches.length;
  expect(f.store.reconcile(f.clock.now + 1)).toEqual({ reconciled: 1, failed: 0 });
  const exported = await f.tasks.guidanceProbeReceipts(USER, receipt.id);
  expect(exported.counts.unknown).toBe(1); expect(exported.counts.succeeded).toBe(0); expect(exported.comparable).toBe(false);
  expect(exported.slots[0]!.receipt!.state).toBe("unknown"); expect(exported.slots[0]!.receipt!.limits).toContain("teardown_unverified");
  // The session itself is held as unknown, not recorded as a known failure or a success: the host did not witness how it ended.
  expect(exported.slots[0]!.state).toBe("unknown_held"); expect(exported.status.state).toBe("unknown_held"); expect(exported.status.evidence).toBe("unknown");
  expect(f.provider.launches).toHaveLength(before);
  // A second reconcile is idempotent and the replay of the same start never launches.
  const after = rows(f.file); expect(f.store.reconcile(f.clock.now + 2)).toEqual({ reconciled: 0, failed: 0 }); expect(rows(f.file)).toBe(after);
});

test("a fallback model or a drifted runtime never rounds to comparable, and the denominator keeps the arm (AC4)", async () => {
  const f = await probeTasksFixture(clean), receipt = await f.tasks.guidanceProbeRegister(USER, f.registration());
  f.provider.script = async (input, effects) => witnessedProbe(f, { servedModel: "fallback/other", runtime: { runtimeSha256: probeHash("drift"), toolsetSha256: probeHash("t"), modelConfigSha256: probeHash("m") } })(input, effects);
  await f.tasks.guidanceProbeStart(USER, receipt.id, 0);
  const exported = await f.tasks.guidanceProbeReceipts(USER, receipt.id);
  expect(exported.comparable).toBe(false); expect(exported.counts.succeeded).toBe(0);
  expect(exported.counts.succeeded + exported.counts.unknown + exported.counts.failed + exported.counts.cancelled + exported.counts.timed_out + exported.counts.unavailable).toBe(1);
  expect(exported.slots[0]!.receipt!.servedModel).toBe("fallback/other");
});

test("an unconfigured registration refuses before any reservation", async () => {
  const f = await probeTasksFixture(clean, { runner: false }), receipt = await f.tasks.guidanceProbeRegister(USER, f.registration());
  const before = rows(f.file);
  await expect(f.tasks.guidanceProbeStart(USER, receipt.id, 0)).rejects.toThrow(/runner is unavailable/);
  expect(rows(f.file)).toBe(before); expect(f.provider.launches).toHaveLength(0);
});

test("a host-selected probe still refuses console and non-conductor requests before reserving", async () => {
  const f = await probeTasksFixture(clean, { runner: false });
  const receipt = await f.tasks.guidanceProbeRegister(USER, f.registration());
  f.dependency.live = { id: receipt.id, adapter: {
    ports: f.provider,
    prepareWorkerFrame: () => { throw new Error("must refuse before preparation"); },
  } };
  const before = rows(f.file);
  await expect(f.tasks.guidanceProbeStart(USER, receipt.id, 0)).rejects.toThrow(/authenticated conductor/);
  await expect(f.tasks.guidanceProbeStart("codex", receipt.id, 0)).rejects.toThrow(/conductor|operational/);
  expect(rows(f.file)).toBe(before);
  expect(f.provider.launches).toHaveLength(0);
});

test("only the selected native conductor start gets a durable live-mode reservation", async () => {
  const f = await probeTasksFixture(clean, { runner: false });
  const declaration = f.registration();
  declaration.manifest.limits.modelCalls = 16;
  delete declaration.manifest.improverContextHash;
  delete declaration.manifest.improverContextBytes;
  delete declaration.snapshots.improverContext;
  const receipt = await f.tasks.guidanceProbeRegister("claude", declaration);
  f.dependency.live = { id: receipt.id, adapter: {
    ports: f.provider,
    prepareWorkerFrame: () => ({ inputFrame: "Model-free wiring fixture", nonGuidanceInputSha256: probeHash("fixture") }),
  } };
  f.provider.script = witnessedProbe(f);
  await f.tasks.guidanceProbeStart("claude", receipt.id, 0);
  expect(f.provider.launches.map(launch => launch.slot.id)).toEqual(["baseline"]);
  expect(f.store.hasLiveRecords()).toBe(true);
  const [baseline] = f.store.receipts({ projectKey: f.projectKey, id: receipt.id });
  expect(baseline?.mode).toBe("live");
});
