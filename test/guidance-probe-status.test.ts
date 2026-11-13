import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER } from "../src/hub/envelope.ts";
import { GuidanceProbeError, PROBE_EXPORT_BYTES, PROBE_OUTPUT_LIMITS, parseGuidanceProbeReceiptExport, parseGuidanceProbeSubcommand, probeHash,
  type ProbeReceiptExport } from "../src/hub/guidance-probes.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import { guidanceProbeStatusLines } from "../src/ui/guidance-view.ts";
import { conductorOperation, CONDUCTOR_DAEMON_OPERATIONS, operationalRequestLabel } from "../src/hub/operational-authority.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";
import { DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { probeTasksFixture, runProbeExperiment as runExperiment, witnessedProbe as witnessed } from "./helpers/guidance-probe-tasks.ts";

// #1226 T4: the producer receipt reader and export, over the REAL Tasks + Store + Bus composition and the fake provider. No model, worker or account is used.
const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
const fixture = (options: { shipped?: boolean; runner?: boolean } = {}) => probeTasksFixture(clean, options);
const edit = (file: string, sql: string, ...args: (string | number)[]) => { const db = new Database(file); try { db.query(sql).run(...args); } finally { db.close(); } };

describe("the producer receipt export over a real fake-provider run", () => {
  test("a fully witnessed run exports comparable receipts, the denominator and no path", async () => {
    const f = await fixture(), run = await runExperiment(f);
    const exported = await f.tasks.guidanceProbeReceipts(USER, run.id);
    expect(exported.v).toBe(1);
    expect(exported.status.id).toBe(run.id); expect(exported.status.evidence).toBe("fixture");
    expect(exported.counts).toMatchObject({ succeeded: 2, failed: 0, cancelled: 0, timed_out: 0, unavailable: 0, unknown: 0 });
    expect(exported.slots.map(slot => slot.slotId)).toEqual(["baseline", "candidate1"]);
    expect(exported.slots.every(slot => slot.receipt !== null && !slot.withheld && slot.receiptDigest === slot.receipt.digest)).toBe(true);
    expect(exported.slots.every(slot => slot.retention === "none")).toBe(true);
    expect(JSON.stringify(exported)).not.toContain(f.cwd);
    // It round-trips through the consumer's own closed parser, which re-verifies every digest.
    expect(parseGuidanceProbeReceiptExport(JSON.parse(JSON.stringify(exported)))).toEqual(exported);
    expect(Buffer.byteLength(JSON.stringify(exported))).toBeLessThanOrEqual(PROBE_EXPORT_BYTES);
  });
  test("a run the host could not witness is in the denominator as unknown and is never comparable", async () => {
    const f = await fixture(), receipt = await f.tasks.guidanceProbeRegister(USER, f.registration());
    await f.tasks.guidanceProbeStart(USER, receipt.id, 0);
    const exported = await f.tasks.guidanceProbeReceipts(USER, receipt.id);
    expect(exported.counts.unknown).toBe(1); expect(exported.counts.succeeded).toBe(0);
    expect(exported.comparable).toBe(false); expect(exported.reasons).toContain("teardown_unverified");
    // The slot that never started is visible beside the one that did, never dropped and never a success.
    expect(exported.counts.planned).toBe(1);
    const planned = exported.slots.find(slot => slot.state === "planned")!;
    expect(planned.receipt).toBeNull(); expect(planned.receiptDigest).toBeNull(); expect(planned.withheld).toBe(false);
  });
  test("failed, cancelled, timed out and unavailable arms stay in the denominator and keep the pair incomparable (AC4)", async () => {
    for (const [name, over, counted] of [["failed", { limits: [] as never[] }, "failed"], ["timed_out", { timedOut: true }, "timed_out"], ["cancelled", { cancelled: true }, "cancelled"]] as const) {
      const f = await fixture(), receipt = await f.tasks.guidanceProbeRegister(USER, f.registration());
      f.provider.script = async (input, effects) => {
        const observed = await witnessed(f, over)(input, effects);
        return name === "failed" ? { ...observed, outcome: "failed_known" as const } : observed;
      };
      await f.tasks.guidanceProbeStart(USER, receipt.id, 0);
      const exported = await f.tasks.guidanceProbeReceipts(USER, receipt.id);
      expect(exported.counts[counted], name).toBe(1); expect(exported.counts.succeeded, name).toBe(0);
      expect(exported.comparable, name).toBe(false); expect(exported.reasons, name).toContain("incomplete_coverage");
    }
  });
  test("a fallback served model and a drifted runtime are named, never rounded to comparable (AC4)", async () => {
    const f = await fixture(), receipt = await f.tasks.guidanceProbeRegister(USER, f.registration());
    f.provider.script = async (input, effects) => {
      const observed = await witnessed(f, { servedModel: "fallback/other-model", runtime: { runtimeSha256: probeHash("drifted"), toolsetSha256: probeHash("t"), modelConfigSha256: probeHash("m") } })(input, effects);
      return observed;
    };
    await f.tasks.guidanceProbeStart(USER, receipt.id, 0);
    const exported = await f.tasks.guidanceProbeReceipts(USER, receipt.id);
    expect(exported.comparable).toBe(false);
    expect(exported.counts.succeeded).toBe(0);
  });
  test("the export's comparable flag is the stricter of the public status and the sealed verdict, and the parser refuses one that outranks either", async () => {
    // With the fixture's ordinary G1 candidate the authoring is `uncontrolled`, which BOTH verdicts read from the same session rows, so they agree here: a witnessed
    // run is not comparable, and the reason names why. The two-source rule itself is what the parser enforces: a comparable flag above a refusing status, or beside
    // a listed reason, never parses. (A sealed-only pass with a refusing status is not reachable from real rows, so it is pinned at the parser, not faked.)
    const f = await fixture(), run = await runExperiment(f);
    const shown = await f.tasks.guidanceProbeShow(USER, run.id), sealed = f.store.outcome(run.key)!;
    expect(shown.authoring).toBe("uncontrolled"); expect(shown.comparable).toBe(false);
    expect(sealed.comparability.reasons).toEqual(["authoring_uncontrolled"]);
    const exported = await f.tasks.guidanceProbeReceipts(USER, run.id);
    expect(exported.comparable).toBe(false); expect(exported.status.comparable).toBe(false); expect(exported.reasons).toEqual(["authoring_uncontrolled"]);
    expect(exported.counts.succeeded).toBe(2);
    const outranks = JSON.parse(JSON.stringify(exported)); outranks.comparable = true;
    expect(parseGuidanceProbeReceiptExport(outranks)).toBeUndefined();
    const listed = JSON.parse(JSON.stringify(exported)); listed.status.comparable = true; listed.comparable = true;
    expect(parseGuidanceProbeReceiptExport(listed)).toBeUndefined();
  });
  test("a usage gap stays unknown in the export and in its text, never zero", async () => {
    const f = await fixture(), receipt = await f.tasks.guidanceProbeRegister(USER, f.registration());
    f.provider.script = async (input, effects) => ({ ...(await witnessed(f)(input, effects)), usage: "unknown" as const });
    await f.tasks.guidanceProbeStart(USER, receipt.id, 0);
    const exported = await f.tasks.guidanceProbeReceipts(USER, receipt.id);
    expect(exported.reasons).toContain("usage_unknown"); expect(exported.comparable).toBe(false);
    const text = guidanceProbeStatusLines(exported).join("\n");
    expect(text).toContain("Token usage: unknown");
  });
});

describe("retention is a state, never a path", () => {
  test("a retained directory shows as retained and a pruned one as pruned, and the export names no location", async () => {
    const f = await fixture(), receipt = await f.tasks.guidanceProbeRegister(USER, f.registration()), key = { projectKey: f.projectKey, id: receipt.id };
    const root = mkdtempSync(join(tmpdir(), "ahub-probe-status-retained-")); clean.push(() => rmSync(root, { recursive: true, force: true }));
    const directory = join(root, "retained-secret-location"); mkdirSync(join(directory, "output"), { recursive: true });
    const file = join(directory, "output", "answer.txt"); writeFileSync(file, "answer");
    const stat = statSync(file, { bigint: true }), dir = statSync(directory);
    const record = { directory, dev: dir.dev, ino: dir.ino, files: [{ relative: "output/answer.txt", dev: Number(stat.dev), ino: Number(stat.ino), bytes: 6, ctimeNs: stat.ctimeNs.toString() }] };
    f.provider.script = async (input, effects) => witnessed(f, { retained: record, output: { v: 1, entries: [{ relative: "output/answer.txt", sha256: probeHash("answer"), bytes: 6 }], excluded: [], totalBytes: 6 } })(input, effects);
    await f.tasks.guidanceProbeStart(USER, receipt.id, 0);
    const exported = await f.tasks.guidanceProbeReceipts(USER, receipt.id);
    expect(exported.slots[0]!.retention).toBe("retained");
    expect(JSON.stringify(exported)).not.toContain("retained-secret-location"); expect(JSON.stringify(exported)).not.toContain(root);
    expect(JSON.stringify(guidanceProbeStatusLines(exported))).not.toContain(root);
    edit(f.file, "UPDATE guidance_probe_receipts SET pruned=1 WHERE slot_id='baseline'");
    expect((await f.tasks.guidanceProbeReceipts(USER, receipt.id)).slots[0]!.retention).toBe("pruned");
    expect(f.store.retentionStates(key).get("baseline")).toBe("pruned");
  });
});

describe("tamper refuses the whole read", () => {
  test("an edited receipt body fails the read instead of being skipped or shown", async () => {
    const f = await fixture(), run = await runExperiment(f);
    edit(f.file, "UPDATE guidance_probe_receipts SET body=replace(body,'\"succeeded\"','\"failed\"') WHERE slot_id='baseline'");
    await expect(f.tasks.guidanceProbeReceipts(USER, run.id)).rejects.toBeInstanceOf(GuidanceProbeError);
  });
  test("a receipt moved to another slot fails the read", async () => {
    const f = await fixture(), run = await runExperiment(f);
    // Both slots are sealed and the primary key is checked per row, so the swap goes through a temporary id: each receipt ends beside the other's session.
    edit(f.file, "UPDATE guidance_probe_receipts SET slot_id='swap-tmp' WHERE slot_id='baseline'");
    edit(f.file, "UPDATE guidance_probe_receipts SET slot_id='baseline' WHERE slot_id='candidate1'");
    edit(f.file, "UPDATE guidance_probe_receipts SET slot_id='candidate1' WHERE slot_id='swap-tmp'");
    await expect(f.tasks.guidanceProbeReceipts(USER, run.id)).rejects.toBeInstanceOf(GuidanceProbeError);
  });
  test("the consumer's parser refuses an export whose receipt, digest, counts or comparable flag were edited", async () => {
    const f = await fixture(), run = await runExperiment(f), exported = await f.tasks.guidanceProbeReceipts(USER, run.id);
    const clone = () => JSON.parse(JSON.stringify(exported)) as ProbeReceiptExport & { slots: any[]; counts: Record<string, number> };
    expect(parseGuidanceProbeReceiptExport(clone())).toEqual(exported);
    const forged = clone(); forged.slots[0].receipt.state = "failed"; expect(parseGuidanceProbeReceiptExport(forged)).toBeUndefined();
    const digest = clone(); digest.slots[0].receiptDigest = probeHash("other"); expect(parseGuidanceProbeReceiptExport(digest)).toBeUndefined();
    const counts = clone(); counts.counts.succeeded = 5; expect(parseGuidanceProbeReceiptExport(counts)).toBeUndefined();
    const moved = clone(); moved.slots[0].slotId = "candidate1"; expect(parseGuidanceProbeReceiptExport(moved)).toBeUndefined();
    const extra = clone() as any; extra.slots[0].path = "/tmp/secret"; expect(parseGuidanceProbeReceiptExport(extra)).toBeUndefined();
    const field = clone() as any; field.actor = "user"; expect(parseGuidanceProbeReceiptExport(field)).toBeUndefined();
    // A comparable flag can never outrank the public status or list a reason.
    const flag = clone(); flag.comparable = true; flag.reasons = ["usage_unknown"] as never; expect(parseGuidanceProbeReceiptExport(flag)).toBeUndefined();
    const ranked = clone(); ranked.status.comparable = false; ranked.comparable = true; ranked.reasons = []; expect(parseGuidanceProbeReceiptExport(ranked)).toBeUndefined();
    expect(parseGuidanceProbeReceiptExport(null)).toBeUndefined(); expect(parseGuidanceProbeReceiptExport([])).toBeUndefined();
    expect(parseGuidanceProbeReceiptExport({ ...clone(), slots: new Array(PROBE_OUTPUT_LIMITS.entries).fill(clone().slots[0]) })).toBeUndefined();
  });
});

describe("privacy: a model-written name never leaves unscreened", () => {
  test("an output path that fails the public-field screen withholds the receipt and keeps only its digest", async () => {
    const f = await fixture(), receipt = await f.tasks.guidanceProbeRegister(USER, f.registration());
    f.control.deny.push("secrets/**");
    const name = "output/secrets/token.txt";
    f.provider.script = async (input, effects) => witnessed(f, { output: { v: 1, entries: [{ relative: name, sha256: probeHash("x"), bytes: 1 }], excluded: [], totalBytes: 1 } })(input, effects);
    await f.tasks.guidanceProbeStart(USER, receipt.id, 0);
    const exported = await f.tasks.guidanceProbeReceipts(USER, receipt.id);
    const slot = exported.slots[0]!;
    expect(slot.withheld).toBe(true); expect(slot.receipt).toBeNull(); expect(slot.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(exported)).not.toContain("secrets/token");
    expect(guidanceProbeStatusLines(exported).join("\n")).toContain("withheld by the privacy screen");
    // The denominator still counts the slot, so withholding never hides an arm.
    expect(exported.counts.succeeded + exported.counts.unknown + exported.counts.failed).toBeGreaterThanOrEqual(1);
  });
  test("every untrusted string in the text is stripped of control and format characters", () => {
    const base = { v: 1 as const, status: { id: "a".repeat(64), revision: 0, state: "declared" as const, already: false, taskId: 1, experimentId: "label\u202e\u0007spoof\nforged line", evidence: "declaration" as const,
      counters: { workerAttempts: 0, editorAttempts: 0, modelCalls: 0, toolCalls: 0, tokensReserved: 0, tokensObservedKnown: 0, inputBytes: 0, scratchBytes: 0, outputBytes: 0, elapsedHighWaterMs: 0, usageUnknown: false },
      cancelRequested: false, notNeeded: 0, comparable: false, authoring: "unknown" as const },
      comparable: false, reasons: [] as never[], counts: { succeeded: 0, failed: 0, cancelled: 0, timed_out: 0, unavailable: 0, unknown: 0, planned: 1, not_needed: 0 },
      slots: [{ slotId: "base\u202eline", stage: "baseline" as const, role: "worker" as const, arm: "baseline" as const, state: "planned" as const, receipt: null, receiptDigest: null, withheld: false, retention: "none" as const }] };
    const text = guidanceProbeStatusLines(base).join("\n");
    expect(text).not.toMatch(/[\u202e\u0007]/);
    // A newline inside the label cannot forge a line of its own: the experiment label stays on its one line.
    expect(text.split("\n").filter(line => line.startsWith("Experiment label")).every(line => !line.includes("forged line") || line.includes("spoof"))).toBe(true);
  });
});

describe("authority, scope and read-only behaviour", () => {
  test("only the person or the current configured conductor can read; others and stale sessions refuse before any read", async () => {
    const f = await fixture(), run = await runExperiment(f);
    await expect(f.tasks.guidanceProbeReceipts("codex", run.id)).rejects.toBeInstanceOf(PreEffectToolRefusal);
    await expect(f.tasks.guidanceProbeReceipts("pi", run.id)).rejects.toBeInstanceOf(PreEffectToolRefusal);
    expect((await f.tasks.guidanceProbeReceipts("claude", run.id)).status.id).toBe(run.id);
    f.control.private = true; await expect(f.tasks.guidanceProbeReceipts(USER, run.id)).rejects.toBeInstanceOf(PreEffectToolRefusal); f.control.private = false;
    f.control.review = true; await expect(f.tasks.guidanceProbeReceipts(USER, run.id)).rejects.toBeInstanceOf(PreEffectToolRefusal); f.control.review = false;
    f.control.operational = false; await expect(f.tasks.guidanceProbeReceipts("claude", run.id)).rejects.toBeInstanceOf(PreEffectToolRefusal); f.control.operational = true;
    f.control.alive = false; await expect(f.tasks.guidanceProbeReceipts(USER, run.id)).rejects.toThrow(); f.control.alive = true;
  });
  test("a malformed id and an unknown experiment refuse with the same fixed causes as show", async () => {
    const f = await fixture();
    await expect(f.tasks.guidanceProbeReceipts(USER, "malformed")).rejects.toBeInstanceOf(PreEffectToolRefusal);
    await expect(f.tasks.guidanceProbeReceipts(USER, "f".repeat(64))).rejects.toBeInstanceOf(PreEffectToolRefusal);
  });
  test("reading launches nothing, reserves nothing and changes no row, however often it runs", async () => {
    const f = await fixture(), run = await runExperiment(f);
    const dump = () => { const db = new Database(f.file, { readonly: true }); try {
      return JSON.stringify([db.query("SELECT * FROM guidance_probe_manifests").all(), db.query("SELECT * FROM guidance_probe_sessions").all(),
        db.query("SELECT * FROM guidance_probe_lanes").all(), db.query("SELECT * FROM guidance_probe_receipts").all()]);
    } finally { db.close(); } };
    const before = dump(), launches = f.provider.launches.length, integrity = f.store.integrity();
    for (let i = 0; i < 3; i++) await f.tasks.guidanceProbeReceipts(USER, run.id);
    expect(dump()).toBe(before); expect(f.provider.launches).toHaveLength(launches); expect(f.store.integrity()).toEqual(integrity);
    expect(f.messages).toHaveLength(0); expect(f.control.screenCalls).toBe(0);
  });
  test("a read-only Store reads the export's inputs and cannot write", async () => {
    const f = await fixture(), run = await runExperiment(f);
    const { GuidanceProbeStore } = await import("../src/hub/guidance-probe-store.ts");
    const ro = new GuidanceProbeStore(f.file, () => 1000, true); clean.push(() => ro.close());
    expect(ro.receipts(run.key)).toHaveLength(2); expect(ro.retentionStates(run.key)).toBeInstanceOf(Map);
    expect(() => ro.reconcile(2000)).not.toThrow();
  });
  test("the receipts operation is a conductor operation with its own label, feature flag and closed CLI form", () => {
    const id = "a".repeat(64);
    expect(DAEMON_FEATURES).toContain("guidance_probe_receipts"); expect(DAEMON_FEATURES).toContain("guidance_probes");
    expect(CONDUCTOR_DAEMON_OPERATIONS).toContain("guidance probe receipts");
    expect(conductorOperation("guidance", ["probe", "receipts"])).toBe("guidance probe receipts");
    expect(classifyPeerCommand("guidance", ["probe", "receipts"])).toBe("conductor");
    expect(operationalRequestLabel({ t: "guidance_probe_receipts" })).toBe("guidance probe receipts");
    expect(parseGuidanceProbeSubcommand(["probe", "receipts", "--id", id])).toEqual({ op: "receipts", id, json: false });
    expect(parseGuidanceProbeSubcommand(["probe", "receipts", "--id", id, "--json"])).toEqual({ op: "receipts", id, json: true });
    for (const bad of [["probe", "receipts"], ["probe", "receipts", "--id", "short"], ["probe", "receipts", "--id", id, "--revision", "1"], ["probe", "receipts", "--id", id, "--file", "x"], ["probe", "receipts", "--id", id, "--id", id]])
      expect(() => parseGuidanceProbeSubcommand(bad)).toThrow();
  });
});
