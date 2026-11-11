import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localProbeFingerprints } from "../src/adapters/local-worker.ts";
import { createGuidanceProbeLocalAdapter } from "../src/adapters/local-probe.ts";
import { GuidanceProbeFixtureHost, GuidanceProbeStore } from "../src/hub/guidance-probe-store.ts";
import { GUIDANCE_PROBE_MODEL, probeHash, type GuidanceProbeFakePorts, type ProbeRetentionFs } from "../src/hub/guidance-probes.ts";
import { materializeProbeWorkspace, previewRetained, probeWorkspacePrivateRoot, removeRetained, type ProbeWorkspace } from "../src/local/probe-workspace.ts";
import type { ProbeLocalModelConfig } from "../src/local/probe-types.ts";
import type { OmniRoute, ChatResult } from "../src/omniroute/client.ts";
import { guidanceProbeFixture, guidanceProbeFixtureKey } from "./fakes/guidance-probe-provider.ts";

// #1226 T3 R1: the host settles and seals every launch. Output the adapter retained for a measurement the host then DISCARDS (a fallback model, a failed seal,
// a lost clock) used to have no row, so no prune could ever reach it. The real adapter, a real Store and the real fixture host run together here: no mocks.
const cleanup: (() => unknown)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const config: ProbeLocalModelConfig = { maxSteps: 4, maxOutputTokens: 128, tokenUpperBound: 16384 };
const fs: ProbeRetentionFs = { preview: record => previewRetained(record), remove: record => removeRetained(record) };

/** The fixture is the baseline worker slot of the shared fixture declaration, rebuilt so its runtime and system policy are the adapter's own. */
function setup(served: string, options: { clock?: { now: number }; failSeal?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "ahub-probe-owner-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const retention = join(directory, "retention"); mkdirSync(retention);
  const source = guidanceProbeFixture(), actual = localProbeFingerprints(config), registration = source.registration;
  registration.snapshots.systemPolicy = actual.systemPolicy;
  registration.manifest.inputs.systemPolicy = { sha256: probeHash(actual.systemPolicy), bytes: Buffer.byteLength(actual.systemPolicy) };
  registration.manifest.runtime = { runtimeSha256: actual.runtimeSha256, toolsetSha256: actual.toolsetSha256, modelConfigSha256: actual.modelConfigSha256 };
  registration.manifest.limits.tokens = config.tokenUpperBound! * config.maxSteps;
  registration.manifest.limits.scratchBytes = 100000; registration.manifest.limits.outputBytes = 100000;
  const clock = options.clock ?? { now: 100 };
  const store = new GuidanceProbeStore(join(directory, "hub.db"), () => clock.now); cleanup.push(() => store.close());
  store.register(registration, source.host, () => source.host);
  const key = guidanceProbeFixtureKey(registration);
  let created: ProbeWorkspace | undefined, privateRoot: string | undefined;
  const reply = (): ChatResult => ({ message: { role: "assistant", content: "done" }, servedModel: served, servedModelExact: true, usage: { totalTokens: 5 } });
  const adapter = createGuidanceProbeLocalAdapter({
    omni: { chat: async () => { writeFileSync(join(created!.output, "answer.txt"), "the answer"); return reply(); } } as unknown as OmniRoute,
    config, permit: async () => true, current: () => {}, resolveInput: () => ({ files: [], verifySource: () => "task_source" }), retentionRoot: retention,
    workspaceOwned: workspace => { privateRoot = probeWorkspacePrivateRoot(workspace); },
    fixture: { evidence: "fixture_only",
      materialize: async input => { created = await materializeProbeWorkspace({ ...input, policy: { ...input.policy, allowedWrites: [{ root: "output", relative: "answer.txt" }] } }); return created; },
      confine: async workspace => ({ workspace, profile: "fixture-only, not an OS proof", env: {}, stop: async () => {} }) } });
  cleanup.push(() => { if (privateRoot) rmSync(privateRoot, { recursive: true, force: true }); });
  const discarded: unknown[] = [];
  const ports: GuidanceProbeFakePorts = { ...adapter.ports, discardRetained: record => { discarded.push(record); adapter.ports.discardRetained!(record); } };
  const host = new GuidanceProbeFixtureHost(store, { ports, revalidate: () => ({ host: source.host }), now: () => clock.now,
    prepareWorkerFrame: adapter.prepareWorkerFrame, prepareEditorFrame: async (state, slot) => adapter.prepareEditorFrame(state, slot) });
  const start = () => host.start({ key, expectedRevision: store.read(key)!.receipt.revision, host: source.host, now: clock.now }, new AbortController().signal);
  return { store, key, retention, host, start, discarded, source, clock, adapter, directory };
}
const retainedDirectories = (root: string) => readdirSync(root);

describe("retained output always has an owner (R1)", () => {
  test("control: a matching served model seals the retained directory with its receipt, and prune reaches it", async () => {
    const f = setup(GUIDANCE_PROBE_MODEL);
    await f.start();
    expect(retainedDirectories(f.retention)).toHaveLength(1);
    expect(f.discarded).toEqual([]);
    const [receipt] = f.store.receipts(f.key);
    expect(receipt!.state).toBe("succeeded");
    f.clock.now = receipt!.expiresAt;
    // The experiment is not finished (one slot ran), so prune is blocked and says why; the point here is that the directory IS owned by a row.
    const plan = f.store.previewPrune(f.key, fs);
    expect(plan.slots.find(item => item.slotId === receipt!.slotId)!.keep.map(item => item.reason)).not.toContain("no_retained_output");
  });
  test("a fallback model (the AC4 case): the retained directory is discarded or owned by a row, never left with no owner", async () => {
    const f = setup("fallback/other-model");
    await f.start().catch(() => {});
    const [receipt] = f.store.receipts(f.key);
    expect(receipt).toBeDefined();
    expect(receipt!.state).not.toBe("succeeded");
    // The observation did not match, so the receipt is sealed conservatively WITHOUT the record: the adapter's directory has no row, and must be gone.
    expect(f.discarded).toHaveLength(1);
    expect(retainedDirectories(f.retention)).toEqual([]);
  });
  test("a record the adapter did not create is ignored, even with the real identity: only the adapter's own canonical record reaches a delete", async () => {
    const f = setup(GUIDANCE_PROBE_MODEL);
    await f.start();
    const db = new Database(join(f.directory, "hub.db"), { readonly: true });
    const row = db.query("SELECT retained FROM guidance_probe_receipts").get() as { retained: string }; db.close();
    const real = JSON.parse(row.retained) as { directory: string; files: { bytes: number }[] };
    // Same directory, same device and inode, same files: only a byte count differs, which `removeRetained` never checks. Without the adapter's own ledger
    // this record would delete the real file; with it, the record is not one the adapter created and nothing happens.
    const forged = { ...real, files: real.files.map(file => ({ ...file, bytes: file.bytes + 1 })) };
    f.adapter.ports.discardRetained!(forged as never);
    expect(existsSync(join(real.directory, "output", "answer.txt"))).toBe(true);
    // The exact record the adapter created IS removable through it, once.
    f.adapter.ports.discardRetained!(real as never);
    expect(existsSync(join(real.directory, "output", "answer.txt"))).toBe(false);
  });
  test("a lost clock at settlement seals nothing, so the retained directory is discarded rather than left unowned", async () => {
    const f = setup(GUIDANCE_PROBE_MODEL);
    // The clock moves backwards between the launch and the settle: the Store latches the elapsed hold and seals nothing.
    const original = f.store.settleAndSeal.bind(f.store);
    (f.store as unknown as { settleAndSeal: typeof original }).settleAndSeal = (input, usage, measured) => { f.clock.now = 1; return original(input, usage, measured); };
    await f.start().catch(() => {});
    expect(f.discarded).toHaveLength(1);
    expect(retainedDirectories(f.retention)).toEqual([]);
  });
  test("a seal that fails leaves no unowned directory: the failed seal's output is discarded and the session is settled unknown", async () => {
    const f = setup(GUIDANCE_PROBE_MODEL);
    const original = f.store.settleAndSeal.bind(f.store); let first = true;
    (f.store as unknown as { settleAndSeal: typeof original }).settleAndSeal = (input, usage, measured) => {
      if (first) { first = false; throw new Error("disk full"); }
      return original(input, usage, measured);
    };
    await f.start().catch(() => {});
    // The first seal threw, so the measurement was never sealed with its record; the host then settled the session unknown with the conservative one.
    expect(f.discarded).toHaveLength(1);
    expect(retainedDirectories(f.retention)).toEqual([]);
    expect(f.store.receipts(f.key).map(item => item.state)).toEqual(["unknown"]);
  });
});
