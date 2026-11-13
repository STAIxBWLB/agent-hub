import { describe, expect, test } from "bun:test";
import { GUIDANCE_PROBE_MODEL, PROBE_OUTPUT_LIMITS, PROBE_RETENTION_MS, classifyProbeComparability, parseProbeReceipt, parseProbeRetained, probeHash, probeOutcomeCounts, probeOutputName, probeReceiptDigest,
  type ProbeReceiptV1 } from "../src/hub/guidance-probes.ts";

// #1226 T3: the pure receipt contract. Storage, reconcile and cleanup have their own files; nothing here touches a database, a process or a clock.
const sha = (name: string) => probeHash(name);
const runtime = { runtimeSha256: sha("runtime"), toolsetSha256: sha("tools"), modelConfigSha256: sha("config") };
function receipt(over: Partial<Omit<ProbeReceiptV1, "digest">> = {}): ProbeReceiptV1 {
  const base: Omit<ProbeReceiptV1, "digest"> = { v: 1, experimentId: "exp", slotId: "baseline", generation: 1, revision: 4, requestedModel: GUIDANCE_PROBE_MODEL, servedModel: GUIDANCE_PROBE_MODEL,
    inputFrameSha256: sha("frame"), workerEffectiveInputSha256: sha("frame"), nonGuidanceInputSha256: sha("non-guidance"), guidanceSha256: sha("guidance"), ...runtime,
    startedAt: 1000, endedAt: 1500, elapsedMs: 500, state: "succeeded", usage: { modelCalls: 2, modelUsageKnown: 2, toolCalls: 1, toolUsageKnown: 1, tokensObserved: 40 }, limits: [],
    output: { v: 1, entries: [{ relative: "output/answer.txt", sha256: sha("answer"), bytes: 6 }], excluded: [], totalBytes: 6 }, expiresAt: 1500 + PROBE_RETENTION_MS, ...over };
  return { ...base, digest: probeReceiptDigest(base) };
}
const resealed = (r: ProbeReceiptV1, over: Partial<Omit<ProbeReceiptV1, "digest">>): ProbeReceiptV1 => {
  const { digest: _digest, ...rest } = r; const next = { ...rest, ...over }; return { ...next, digest: probeReceiptDigest(next) };
};

describe("receipt parsing is closed, inert and digest-checked", () => {
  test("a well-formed receipt round-trips", () => {
    const r = receipt(); expect(parseProbeReceipt(JSON.parse(JSON.stringify(r)))).toEqual(r);
  });
  test("any edited field breaks the digest, so a tampered receipt is refused", () => {
    const r = receipt();
    for (const edit of [{ servedModel: "other/model" }, { state: "failed" }, { elapsedMs: 1 }, { inputFrameSha256: sha("other") }, { startedAt: 999 }]) {
      expect(parseProbeReceipt({ ...r, ...edit })).toBeUndefined();
    }
    expect(parseProbeReceipt({ ...r, output: { ...r.output, totalBytes: 7 } })).toBeUndefined();
    expect(parseProbeReceipt({ ...r, output: { ...r.output, entries: [{ ...r.output.entries[0]!, sha256: sha("tampered") }] } })).toBeUndefined();
  });
  test("unknown keys, wrong types and a requested model other than the pinned literal refuse", () => {
    const r = receipt();
    expect(parseProbeReceipt({ ...r, extra: 1 })).toBeUndefined();
    expect(parseProbeReceipt({ ...r, v: 2 })).toBeUndefined();
    expect(parseProbeReceipt(resealed(r, { requestedModel: "qwen3.8-27b" as typeof GUIDANCE_PROBE_MODEL }))).toBeUndefined();
    expect(parseProbeReceipt(resealed(r, { state: "ok" as never }))).toBeUndefined();
    expect(parseProbeReceipt(resealed(r, { limits: ["made_up" as never] }))).toBeUndefined();
    expect(parseProbeReceipt(null)).toBeUndefined();
    expect(parseProbeReceipt("receipt")).toBeUndefined();
  });
  test("an output nested past the walk limit parses only as a closed exclusion (over_depth) and forbids a success", () => {
    const r = receipt({ state: "unknown", limits: ["output_truncated"], output: { v: 1, entries: [], excluded: [{ relative: "output/d0/d1", reason: "over_depth" }], totalBytes: 0 } });
    expect(parseProbeReceipt(JSON.parse(JSON.stringify(r)))).toEqual(r);
    const lying = receipt({ state: "succeeded", output: { v: 1, entries: [], excluded: [{ relative: "output/d0/d1", reason: "over_depth" }], totalBytes: 0 } });
    expect(parseProbeReceipt(JSON.parse(JSON.stringify(lying)))).toBeUndefined();
    expect(parseProbeReceipt({ ...r, output: { ...r.output, excluded: [{ relative: "output/x", reason: "too_deep" }] } })).toBeUndefined();
  });
  test("a fingerprint is either a sha or null; anything else is refused", () => {
    expect(parseProbeReceipt(JSON.parse(JSON.stringify(receipt({ runtimeSha256: null, state: "unknown", limits: ["coverage_unverified"] }))))).toBeDefined();
    const r = receipt();
    for (const bad of ["not-a-sha", 7, ""]) expect(parseProbeReceipt({ ...r, runtimeSha256: bad })).toBeUndefined();
  });
  test("expiresAt is exactly seal time plus the retention constant, so retention is never silently longer", () => {
    expect(parseProbeReceipt(resealed(receipt(), { expiresAt: 1500 + PROBE_RETENTION_MS + 1 }))).toBeUndefined();
    expect(parseProbeReceipt(resealed(receipt(), { expiresAt: 1500 }))).toBeUndefined();
    expect(PROBE_RETENTION_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });
  test("a success cannot carry a limit, an excluded output or a served model other than the requested one", () => {
    const r = receipt();
    expect(parseProbeReceipt(resealed(r, { limits: ["output_truncated"] }))).toBeUndefined();
    expect(parseProbeReceipt(resealed(r, { limits: ["usage_unknown"] }))).toBeUndefined();
    expect(parseProbeReceipt(resealed(r, { output: { ...r.output, excluded: [{ relative: "output/x", reason: "linked" }] } }))).toBeUndefined();
    expect(parseProbeReceipt(resealed(r, { servedModel: null }))).toBeUndefined();
    expect(parseProbeReceipt(resealed(r, { servedModel: "other/model" }))).toBeUndefined();
    // The same facts are fine on a non-success receipt: that is how they are recorded.
    expect(parseProbeReceipt(resealed(r, { state: "unknown", limits: ["served_model_unobserved"], servedModel: null }))).toBeDefined();
    expect(parseProbeReceipt(resealed(r, { state: "timed_out", limits: ["teardown_unverified"] }))).toBeDefined();
  });
  test("output manifest bounds: entry count, file size, duplicate names, traversal and a wrong total", () => {
    const r = receipt(), entry = (name: string, bytes = 1) => ({ relative: name, sha256: sha(name), bytes });
    const over = Array.from({ length: PROBE_OUTPUT_LIMITS.entries + 1 }, (_, i) => entry(`output/f${i}`));
    expect(parseProbeReceipt(resealed(r, { output: { v: 1, entries: over, excluded: [], totalBytes: over.length } }))).toBeUndefined();
    expect(parseProbeReceipt(resealed(r, { output: { v: 1, entries: [entry("output/a", PROBE_OUTPUT_LIMITS.fileBytes + 1)], excluded: [], totalBytes: PROBE_OUTPUT_LIMITS.fileBytes + 1 } }))).toBeUndefined();
    expect(parseProbeReceipt(resealed(r, { output: { v: 1, entries: [entry("output/a"), entry("output/a")], excluded: [], totalBytes: 2 } }))).toBeUndefined();
    for (const bad of ["../escape", "/abs/path", "output/../../x", ""]) {
      expect(parseProbeReceipt(resealed(r, { output: { v: 1, entries: [entry(bad)], excluded: [], totalBytes: 1 } })), bad).toBeUndefined();
    }
  });
  test("a getter, proxy or toJSON cannot smuggle a field past the inert copy", () => {
    const r = receipt(); let calls = 0;
    const getter = { ...r }; Object.defineProperty(getter, "state", { enumerable: true, get() { calls++; return "succeeded"; } });
    expect(parseProbeReceipt(getter)).toBeUndefined();
    expect(parseProbeReceipt(new Proxy(r, { ownKeys() { calls++; return []; } }))).toBeUndefined();
    expect(parseProbeReceipt({ ...r, toJSON() { calls++; return {}; } })).toBeUndefined();
    expect(calls).toBe(0);
  });
});

describe("comparability and the outcome denominator (AC4)", () => {
  type SlotInput = Parameters<typeof classifyProbeComparability>[0]["slots"][number];
  const slots: SlotInput[] = [
    { slotId: "baseline", role: "worker", arm: "baseline", reserved: true, coverageVerified: true, authoring: "admitted_fixture" },
    { slotId: "candidate1", role: "worker", arm: "candidate1", reserved: true, coverageVerified: true, authoring: "admitted_fixture" },
  ];
  const pair = () => [receipt({ slotId: "baseline" }), receipt({ slotId: "candidate1" })];
  const classify = (receipts: ProbeReceiptV1[], over: { holds?: boolean; slots?: SlotInput[] } = {}) =>
    classifyProbeComparability({ slots: over.slots ?? slots, receipts, runtime, holds: over.holds ?? false });

  test("a matched, fully observed pair is comparable", () => {
    expect(classify(pair())).toEqual({ comparable: true, reasons: [] });
  });
  test("a served model other than the requested one makes the pair incomparable", () => {
    const [a, b] = pair();
    expect(classify([a!, resealed(b!, { state: "unknown", servedModel: "fallback/model" })]).reasons).toContain("served_model_mismatch");
  });
  test("an unobserved served model is incomparable, not matching", () => {
    const [a, b] = pair();
    expect(classify([a!, resealed(b!, { state: "unknown", servedModel: null, limits: ["served_model_unobserved"] })]).reasons).toContain("served_model_unobserved");
  });
  test("input drift: a worker whose non-guidance bytes differ, or a runtime fingerprint that differs, is incomparable", () => {
    const [a, b] = pair();
    expect(classify([a!, resealed(b!, { nonGuidanceInputSha256: sha("drifted") })]).reasons).toContain("input_drift");
    expect(classify([a!, resealed(b!, { toolsetSha256: sha("other-tools") })]).reasons).toContain("input_drift");
    expect(classify([a!, resealed(b!, { nonGuidanceInputSha256: null })]).reasons).toContain("input_drift");
  });
  test("a fingerprint the host never observed (null) is drift it cannot rule out, never a match", () => {
    const [a, b] = pair();
    for (const field of ["runtimeSha256", "toolsetSha256", "modelConfigSha256"] as const) {
      const unread = resealed(b!, { [field]: null, state: "unknown", limits: ["coverage_unverified"] });
      expect(parseProbeReceipt(JSON.parse(JSON.stringify(unread)))).toEqual(unread);
      expect(classify([a!, unread]).reasons, field).toContain("input_drift");
    }
  });
  test("usage gaps stay unknown and make the pair incomparable, never zero", () => {
    const [a, b] = pair();
    expect(classify([a!, resealed(b!, { usage: { ...b!.usage, tokensObserved: null } })]).reasons).toContain("usage_unknown");
    expect(classify([a!, resealed(b!, { usage: { ...b!.usage, modelUsageKnown: 1 } })]).reasons).toContain("usage_unknown");
    expect(classify(pair(), { holds: true }).reasons).toContain("usage_unknown");
  });
  test("a reserved slot with no receipt, an uncontrolled arm and an unverified teardown each block comparability", () => {
    const [a, b] = pair();
    expect(classify([a!]).reasons).toContain("missing_receipt");
    expect(classify(pair(), { slots: [slots[0]!, { ...slots[1]!, authoring: "uncontrolled" }] }).reasons).toContain("authoring_uncontrolled");
    expect(classify([a!, resealed(b!, { state: "unknown", limits: ["teardown_unverified"] })]).reasons).toContain("teardown_unverified");
  });
  test("a non-success arm is never comparable with a success: the pair is incomparable, not dropped", () => {
    const [a, b] = pair();
    for (const state of ["failed", "cancelled", "timed_out", "unavailable", "unknown"] as const) {
      const verdict = classify([a!, resealed(b!, { state })]);
      expect(verdict.comparable, state).toBe(false);
      expect(verdict.reasons, state).toContain("incomplete_coverage");
    }
  });
  test("reasons are a sorted, de-duplicated closed list", () => {
    const [a, b] = pair();
    const verdict = classify([resealed(a!, { servedModel: null, state: "unknown" }), resealed(b!, { servedModel: null, state: "unknown" })], { holds: true });
    expect(verdict.reasons).toEqual([...new Set(verdict.reasons)].sort());
  });
  test("slots that were never reserved are not counted against the pair", () => {
    expect(classify(pair(), { slots: [...slots, { slotId: "later", role: "select", arm: "none", reserved: false, coverageVerified: false }] }).comparable).toBe(true);
  });

  test("the denominator counts every reserved slot: failed, cancelled, timed out, unavailable and unknown all stay in", () => {
    const states = ["succeeded", "failed", "cancelled", "timed_out", "unavailable", "unknown"] as const;
    const sealed = states.map((state, i) => receipt({ slotId: `s${i}`, state, ...(state === "succeeded" ? {} : { limits: ["teardown_unverified" as const] }) }));
    const counts = probeOutcomeCounts(states.map((_, i) => ({ slotId: `s${i}`, state: "closed_fixture" as const })), sealed);
    expect(counts).toEqual({ succeeded: 1, failed: 1, cancelled: 1, timed_out: 1, unavailable: 1, unknown: 1, planned: 0, not_needed: 0 });
  });
  test("a reserved slot with no sealed receipt is unknown, never failed; unstarted slots are reported apart", () => {
    const counts = probeOutcomeCounts([
      { slotId: "a", state: "unknown_held" }, { slotId: "b", state: "running" }, { slotId: "c", state: "planned" }, { slotId: "d", state: "not_needed" },
    ], []);
    expect(counts).toEqual({ succeeded: 0, failed: 0, cancelled: 0, timed_out: 0, unavailable: 0, unknown: 2, planned: 1, not_needed: 1 });
  });
});

// R2: the receipt byte bound is derived from the largest valid receipt, so a session that meets every success condition and writes the most files with the
// longest allowed names still seals as a success instead of throwing at the digest and being recorded unknown with an empty manifest.
describe("the receipt byte bound holds the largest valid receipt (R2)", () => {
  /** A name at the exact byte limit whose JSON form is the longest the bound allows: every byte a double quote would cost two, but those are refused, so a plain
   *  name at the limit with multi-byte characters (up to 3 bytes each) is the realistic worst case; a backslash-free ASCII name is the cheapest. Use both. */
  const longName = (index: number, bytes: number = PROBE_OUTPUT_LIMITS.nameBytes): string => {
    const head = `output/${String(index).padStart(3, "0")}-`; return head + "x".repeat(bytes - Buffer.byteLength(head));
  };
  const widest = (index: number): string => { const head = `output/${String(index).padStart(3, "0")}-`; const rest = PROBE_OUTPUT_LIMITS.nameBytes - Buffer.byteLength(head);
    return head + "\u20ac".repeat(Math.floor(rest / 3)) + "x".repeat(rest % 3); };
  const manifest = (name: (index: number) => string, excludedName: (index: number) => string) => {
    const entries = Array.from({ length: PROBE_OUTPUT_LIMITS.entries }, (_, i) => ({ relative: name(i), sha256: sha(`f${i}`), bytes: 1 }));
    const excluded = Array.from({ length: PROBE_OUTPUT_LIMITS.entries }, (_, i) => ({ relative: excludedName(i), reason: "over_depth" as const }));
    return { v: 1 as const, entries, excluded, totalBytes: entries.length };
  };
  test("the derived bound is above the real maximum: 64 entries of the longest names plus 64 exclusions round-trip", () => {
    for (const name of [longName, widest]) {
      const output = manifest(name, name);
      // A success needs no exclusion, so build the success case with entries only and the maximal failure case with both.
      const success = receipt({ output: { ...output, excluded: [] }, state: "succeeded" });
      expect(Buffer.byteLength(JSON.stringify(success))).toBeLessThanOrEqual(PROBE_OUTPUT_LIMITS.receiptBytes);
      expect(parseProbeReceipt(JSON.parse(JSON.stringify(success)))).toEqual(success);
      const failed = receipt({ output, state: "failed" });
      expect(Buffer.byteLength(JSON.stringify(failed))).toBeLessThanOrEqual(PROBE_OUTPUT_LIMITS.receiptBytes);
      expect(parseProbeReceipt(JSON.parse(JSON.stringify(failed)))).toEqual(failed);
    }
  });
  test("the bound is derived, not chosen: it is at least what the largest receipt serializes to, with room for every other field", () => {
    const output = manifest(longName, longName);
    const biggest = receipt({ output, state: "failed", servedModel: "m".repeat(256), experimentId: "e".repeat(256), slotId: "s".repeat(256),
      limits: ["usage_unknown", "served_model_unobserved", "served_model_mismatch", "teardown_unverified", "output_truncated", "storage_over_cap", "coverage_unverified"] });
    expect(PROBE_OUTPUT_LIMITS.receiptBytes).toBeGreaterThan(Buffer.byteLength(JSON.stringify(biggest)));
    expect(parseProbeReceipt(JSON.parse(JSON.stringify(biggest)))).toEqual(biggest);
  });
  test("a name past the name bound, or with a control or format character, is refused", () => {
    const over = receipt({ output: { v: 1, entries: [{ relative: longName(0, PROBE_OUTPUT_LIMITS.nameBytes + 1), sha256: sha("a"), bytes: 1 }], excluded: [], totalBytes: 1 } });
    expect(parseProbeReceipt(JSON.parse(JSON.stringify(over)))).toBeUndefined();
    for (const bad of ["output/a\u0000b", "output/a\u202eb", "output/a\nb"]) {
      expect(parseProbeReceipt(JSON.parse(JSON.stringify(receipt({ output: { v: 1, entries: [{ relative: bad, sha256: sha("a"), bytes: 1 }], excluded: [], totalBytes: 1 } }))))).toBeUndefined();
    }
  });
  test("probeOutputName is the one check for entries, exclusions and retained records", () => {
    expect(probeOutputName("output/answer.txt")).toBe(true);
    expect(probeOutputName("/etc/passwd")).toBe(false); expect(probeOutputName("output/../x")).toBe(false); expect(probeOutputName("")).toBe(false);
    expect(probeOutputName("a".repeat(PROBE_OUTPUT_LIMITS.nameBytes))).toBe(true); expect(probeOutputName("a".repeat(PROBE_OUTPUT_LIMITS.nameBytes + 1))).toBe(false);
    expect(parseProbeRetained({ directory: "/r", dev: 1, ino: 2, files: [{ relative: "o".repeat(PROBE_OUTPUT_LIMITS.nameBytes + 1), dev: 1, ino: 3, bytes: 1, ctimeNs: "1" }] })).toBeUndefined();
  });
});
