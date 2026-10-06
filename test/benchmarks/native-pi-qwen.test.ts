import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { v3ArmOrder, jointAssignment, isSourcePath, ProtectedReadProbe, qualifyRequests, effectiveBuild, parseVersion, claimExclusive, collectSubmissionPatch, disposeAll, writeRecordFresh, evaluateProbe, probeReadiness, ActiveFailureLatch, activeExit, activeTreeFlag, probeErrorClass, emptyProbeWindowStats, diagnoseProbe, safeProbeDiagnosis, PROBE_TRACE_EVENTS, QWEN_0_24_7_LOOP_PROTECTION_MESSAGE, classifyNativeTermination, ActiveToolTrace, diagnoseActiveTermination, safeActiveLoopDiagnosis, ACTIVE_TRACE_COUNTERS, ACTIVE_TOOL_CATEGORIES, type ProbeWindowStats, type ProbeDiagnosis, type ProbeDiagnosisCategory, type PeerFailure, type ActiveLoopDiagnosis } from "../../scripts/benchmarks/native-pi-qwen.ts";
import type { RelayRequestRecord } from "../../src/models/relay.ts";

const script = join(import.meta.dir, "../../scripts/benchmarks/runner.py");
const fixture = () => mkdtempSync(join(tmpdir(), "ahub-bench-v3-test-"));
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
  return r.stdout.trim();
};

const record = (partial: Partial<RelayRequestRecord>): RelayRequestRecord => ({
  id: partial.id ?? Math.random().toString(36).slice(2),
  at: new Date().toISOString(),
  alias: "dgx/coding",
  requestedModel: "flashnext/qwen3.8-flash-next",
  provider: "provider-a",
  actualModel: "qwen3.8-flash-next",
  identitySource: "stream",
  role: "unknown",
  outcome: "completed",
  identified: true,
  durationMs: 100,
  ...partial,
});
const expected = { backend: "flashnext/qwen3.8-flash-next", servedModel: "qwen3.8-flash-next", provider: "provider-a" };

describe("Qwen protected read evidence bound to one native call (#140)", () => {
  const target = "/private/protected/tests.patch";
  const announce = (id: string, kind = "read") => ({ sessionUpdate: "tool_call", toolCallId: id, kind, status: "pending", rawInput: {} });
  const input = (id: string, path = target) => ({ sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress", rawInput: { file_path: path } });
  const failed = (id: string) => ({ sessionUpdate: "tool_call_update", toolCallId: id, status: "failed", content: [{ type: "content", content: { type: "text", text: `EACCES: permission denied, open '${target}'` } }] });
  const cases = [
    { name: "same read id, exact input and kernel denial", updates: [announce("a"), input("a"), failed("a")], denied: true },
    { name: "protected write failure plus unrelated read failure", updates: [announce("w", "edit"), input("w"), failed("w"), announce("r"), input("r", "/project/source.py"), failed("r")], denied: false },
    { name: "wrong target even when error mentions protected file", updates: [announce("a"), input("a", target + ".other"), failed("a")], denied: false },
    { name: "model marker without native read", updates: [{ text: "AHUB_PROBE_DENIED" }], denied: false },
    { name: "late failure after completion", updates: [announce("a"), input("a"), { sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" }, failed("a")], denied: false },
    { name: "failure without announcement", updates: [input("a"), failed("a")], denied: false },
    { name: "mutable kind cannot turn announced edit into read", updates: [announce("a", "edit"), { ...input("a"), kind: "read" }, failed("a")], denied: false },
    { name: "reused id clears the old protected path", updates: [announce("a"), input("a"), announce("a"), input("a", "/project/source.py"), failed("a")], denied: false },
    { name: "conflicting input path cannot recover", updates: [announce("a"), input("a", "/project/source.py"), input("a"), failed("a")], denied: false },
    { name: "read failure without permission denial", updates: [announce("a"), input("a"), { ...failed("a"), content: [{ text: "ENOENT" }] }], denied: false },
  ];
  for (const item of cases) test(item.name, () => {
    const probe = new ProtectedReadProbe(target);
    for (const update of item.updates) probe.observe(update);
    expect(probe.denied).toBe(item.denied);
  });
});

describe("manifest v3 plan arithmetic and joint ownership (#140)", () => {
  test("arm order is the preregistered six-row odd-n Williams layout", () => {
    const arms = ["solo-pi", "solo-qwen", "joint-pi-qwen"];
    const rows: string[][] = [];
    for (let repeat = 0; repeat < 2; repeat++) for (let caseIndex = 0; caseIndex < 10; caseIndex++) rows.push(v3ArmOrder(arms, caseIndex, repeat, 10));
    // The first three rows are the shifted [0,1,2] rows, the next three their reverses, then the pattern repeats.
    expect(rows.slice(0, 6)).toEqual([
      ["solo-pi", "solo-qwen", "joint-pi-qwen"],
      ["solo-qwen", "joint-pi-qwen", "solo-pi"],
      ["joint-pi-qwen", "solo-pi", "solo-qwen"],
      ["joint-pi-qwen", "solo-qwen", "solo-pi"],
      ["solo-pi", "joint-pi-qwen", "solo-qwen"],
      ["solo-qwen", "solo-pi", "joint-pi-qwen"],
    ]);
    expect(rows[10]).toEqual(rows[4]); // the layout repeats every six rows: rows 6-11 equal rows 0-5
    expect(rows.slice(6, 12)).toEqual(rows.slice(0, 6));
    for (const row of rows) expect([...row].sort()).toEqual([...arms].sort());
  });

  test("joint ownership is fixed before inference as (caseIndex+repeat)%2", () => {
    expect(jointAssignment(0, 0)).toEqual({ pi: 0, qwen: 1 });
    expect(jointAssignment(1, 0)).toEqual({ pi: 1, qwen: 0 });
    expect(jointAssignment(0, 1)).toEqual({ pi: 1, qwen: 0 });
    expect(jointAssignment(9, 1)).toEqual({ pi: 0, qwen: 1 });
  });

  test("source guards follow the per-case repository layout", () => {
    expect(isSourcePath(["src"], "src/click/core.py")).toBe(true);
    expect(isSourcePath(["src"], "tests/test_core.py")).toBe(false);
    expect(isSourcePath(["dirty_equals"], "dirty_equals/_boolean.py")).toBe(true);
    expect(isSourcePath(["dirty_equals"], "src/anything.py")).toBe(false);
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../../scripts/benchmarks/manifest-v3-pi-qwen.json"), "utf8"));
    for (const c of manifest.cases) {
      const want = c.repo.startsWith("samuelcolvin_") ? ["dirty_equals"] : ["src"];
      expect(c.source_dirs).toEqual(want);
    }
  });
});

describe("request-linkage qualification over RelayRequestRecord (#139, #140)", () => {
  test("a completed, identified request with the expected served model and provider verifies", () => {
    const q = qualifyRequests([record({})], expected);
    expect(q.verified).toBe(true);
    expect(q.coverage).toEqual({ requests: 1, completed: 1, identified: 1, cancelledUnidentified: 0, mismatches: 0, providerMissing: 0 });
  });

  test("a request cancelled before identification stays explicit and never certifies", () => {
    const cancelled = record({ outcome: "cancelled", identified: false, identitySource: "none", actualModel: undefined, provider: undefined });
    const alone = qualifyRequests([cancelled], expected);
    expect(alone.verified).toBe(false);
    expect(alone.reasons[0]).toContain("no completed generation request");
    expect(alone.coverage.cancelledUnidentified).toBe(1);
    const beside = qualifyRequests([record({}), cancelled], expected);
    expect(beside.verified).toBe(true); // the cancelled record certifies nothing; the completed one stands on its own
    expect(beside.coverage.cancelledUnidentified).toBe(1);
  });

  test("a mismatch on a request cancelled after identification still fails the gate (review #146)", () => {
    // Cancelled after its header/generation event identified the served model: the mismatch is confirmed evidence.
    const bad = record({ outcome: "cancelled", mismatch: true, actualModel: "qwen3.8-other" });
    const q = qualifyRequests([record({}), bad], expected);
    expect(q.verified).toBe(false);
    expect(q.reasons.some((r) => r.includes("mismatch"))).toBe(true);
    expect(q.coverage.mismatches).toBe(1);
    const wrong = record({ outcome: "cancelled", actualModel: "qwen3.8-other" });
    expect(qualifyRequests([record({}), wrong], expected).verified).toBe(false);
    const wrongProvider = record({ outcome: "cancelled", provider: "provider-b" });
    expect(qualifyRequests([record({}), wrongProvider], expected).verified).toBe(false);
  });

  test("a cleanly identified cancellation certifies nothing and fails nothing", () => {
    const clean = record({ outcome: "cancelled" }); // identified, with the expected model and provider
    const q = qualifyRequests([record({}), clean], expected);
    expect(q.verified).toBe(true);
    expect(q.coverage.cancelledUnidentified).toBe(0);
  });

  test("a heartbeat-only record (never identified) fails even with HTTP-level completion", () => {
    const q = qualifyRequests([record({ identified: false, identitySource: "none", actualModel: undefined })], expected);
    expect(q.verified).toBe(false);
    expect(q.reasons.some((r) => r.includes("heartbeat"))).toBe(true);
  });

  test("a mismatch or a different served model or provider is flagged", () => {
    expect(qualifyRequests([record({ mismatch: true })], expected).verified).toBe(false);
    expect(qualifyRequests([record({ actualModel: "qwen3.8-other" })], expected).verified).toBe(false);
    expect(qualifyRequests([record({ provider: "provider-b" })], expected).verified).toBe(false);
    expect(qualifyRequests([record({ requestedModel: "flashnext/other" })], expected).verified).toBe(false);
  });

  test("a missing provider header is coverage, not a failure; an absent journal is", () => {
    const q = qualifyRequests([record({ provider: undefined })], expected);
    expect(q.verified).toBe(true);
    expect(q.coverage.providerMissing).toBe(1);
    expect(qualifyRequests([], expected).verified).toBe(false);
  });
});

describe("probe readiness telemetry only from observed evidence (#150)", () => {
  const targetSha = "a".repeat(64);
  // runner.py's v3 readiness gate (grade's actor_ok): it accepts only a verified structured denial.
  const gateAccepts = (probe: Record<string, unknown>) => probe.checked === true && probe.result === "denied" && ["guard-denial", "tool-failure"].includes(String(probe.evidence));

  test("a probe that never settled before the active start reports unknown, never a synthesized denial", () => {
    // The historical repeat-1 case-07 solo-qwen shape: no answer, no denial event, peer still busy at the deadline.
    const outcome = evaluateProbe("qwen", { denial: false, answers: [], settled: false, state: "busy" });
    expect(outcome).toEqual({ checked: false, result: "unknown", reason: "the probe never settled before its deadline" });
    const probe = probeReadiness("qwen", outcome, targetSha, true);
    expect(probe.checked).toBe(false);
    expect(probe.result).toBe("unknown");
    expect(probe.evidence).toBeUndefined();
    expect(probe.kernelProbe).toEqual({ checked: true, result: "denied" }); // the seatbelt layer was verified before launch
    expect(gateAccepts(probe)).toBe(false);
  });

  test("a peer that failed before settling reports unknown with the state as the reason", () => {
    const outcome = evaluateProbe("pi", { denial: false, answers: [], settled: false, state: "offline" });
    expect(outcome).toEqual({ checked: false, result: "unknown", reason: "the probe peer is offline" });
    expect(gateAccepts(probeReadiness("pi", outcome, targetSha))).toBe(false);
  });

  test("a probe that never ran (no recorded outcome) reports unknown", () => {
    const probe = probeReadiness("pi", undefined, targetSha);
    expect(probe).toEqual({ checked: false, result: "unknown", reason: "the probe never ran", target_sha256: targetSha });
    expect(gateAccepts(probe)).toBe(false);
  });

  test("a settled probe without a native read denial reports failed, not denied", () => {
    // The model wrote the marker, but no guard denial or bound tool failure was observed (correction 2).
    const markerOnly = evaluateProbe("pi", { denial: false, answers: ["[FYI] AHUB_PROBE_DENIED"], settled: true, state: "idle" });
    expect(markerOnly).toEqual({ checked: true, result: "failed", reason: "no structured denial evidence was observed" });
    expect(gateAccepts(probeReadiness("pi", markerOnly, targetSha))).toBe(false);
    // A guard denial without the peer's own probe answer is incomplete too.
    const unmarked = evaluateProbe("pi", { denial: true, answers: ["[FYI] done"], settled: true, state: "idle" });
    expect(unmarked.result).toBe("failed");
    expect(gateAccepts(probeReadiness("pi", unmarked, targetSha))).toBe(false);
    // An accessible report is a failure even when denial evidence exists.
    const accessible = evaluateProbe("qwen", { denial: true, answers: ["[FYI] AHUB_PROBE_ACCESSIBLE"], settled: true, state: "idle" });
    expect(accessible).toEqual({ checked: true, result: "failed", reason: "the peer reported the protected file accessible" });
    expect(gateAccepts(probeReadiness("qwen", accessible, targetSha, true))).toBe(false);
  });

  test("a successful denial serializes checked/denied with its evidence type per peer", () => {
    const pi = evaluateProbe("pi", { denial: true, answers: ["[FYI] AHUB_PROBE_DENIED"], settled: true, state: "idle" });
    expect(pi).toEqual({ checked: true, result: "denied", evidence: "guard-denial" });
    const piProbe = probeReadiness("pi", pi, targetSha);
    expect(piProbe).toEqual({ checked: true, result: "denied", evidence: "guard-denial", target_sha256: targetSha });
    expect(gateAccepts(piProbe)).toBe(true);
    const qwen = evaluateProbe("qwen", { denial: true, answers: [], settled: true, state: "idle" }); // the bound tool failure settles it without an answer
    expect(qwen).toEqual({ checked: true, result: "denied", evidence: "tool-failure" });
    const qwenProbe = probeReadiness("qwen", qwen, targetSha, true);
    expect(qwenProbe.kernelProbe).toEqual({ checked: true, result: "denied" });
    expect(gateAccepts(qwenProbe)).toBe(true);
    // Qwen without the kernel probe verified never claims the seatbelt layer.
    expect(probeReadiness("qwen", qwen, targetSha, false).kernelProbe).toEqual({ checked: false, result: "unknown" });
  });

  test("one peer failing a joint attempt leaves the other's verified denial intact and the arm refused", () => {
    const pi = probeReadiness("pi", evaluateProbe("pi", { denial: true, answers: ["[FYI] AHUB_PROBE_DENIED"], settled: true, state: "idle" }), targetSha);
    const qwen = probeReadiness("qwen", evaluateProbe("qwen", { denial: false, answers: [], settled: false, state: "busy" }), targetSha, true);
    // Per-peer truth: Pi's denial stands, Qwen's is unknown; the joint gate requires both actors, so it refuses.
    expect(gateAccepts(pi)).toBe(true);
    expect(gateAccepts(qwen)).toBe(false);
    expect(gateAccepts(pi) && gateAccepts(qwen)).toBe(false);
  });
});

describe("bounded structured diagnosis of native probe failures (#169)", () => {
  const target = "/private/protected/tests.patch";
  const targetSha = "b".repeat(64);
  const announce = (id: string, kind = "read") => ({ sessionUpdate: "tool_call", toolCallId: id, kind, status: "pending", rawInput: {} });
  const input = (id: string, path = target) => ({ sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress", rawInput: { file_path: path } });
  const settle = (id: string, status: string, content?: unknown) => ({ sessionUpdate: "tool_call_update", toolCallId: id, status, ...(content === undefined ? {} : { content }) });
  const deniedContent = [{ type: "content", content: { type: "text", text: `EACCES: permission denied, open '${target}'` } }];
  // runner.py's v3 readiness gate, as in the #150 block: only a verified structured denial passes.
  const gateAccepts = (probe: Record<string, unknown>) => probe.checked === true && probe.result === "denied" && ["guard-denial", "tool-failure"].includes(String(probe.evidence));
  // Feed the fake ACP tool-update stream (the #140 fixtures' infrastructure) and snapshot the window stats.
  const observed = (updates: unknown[]) => {
    const probe = new ProtectedReadProbe(target);
    for (const u of updates) probe.observe(u);
    return { probe, stats: probe.stats() };
  };
  const diagnose = (peer: string, o: { denial: boolean; answers: string[]; settled: boolean; state: string; deadlineExpired?: boolean; stats?: ProbeWindowStats; sessionId?: string }) =>
    diagnoseProbe(peer, { denial: o.denial, answers: o.answers, settled: o.settled, state: o.state, deadlineExpired: o.deadlineExpired ?? false, stats: o.stats ?? emptyProbeWindowStats(), sessionId: o.sessionId });

  test("the error class is a fixed enum and never carries the raw error text", () => {
    expect(probeErrorClass(undefined)).toBe("unparsed");
    expect(probeErrorClass([])).toBe("unparsed");
    expect(probeErrorClass([{ text: "EACCES: permission denied" }])).toBe("permission");
    expect(probeErrorClass([{ text: "EPERM: operation not permitted" }])).toBe("permission");
    expect(probeErrorClass([{ text: "ENOENT: no such file or directory" }])).toBe("not-found");
    expect(probeErrorClass([{ text: "EIO: something else" }])).toBe("other");
  });

  test("no read: an answer-only marker diagnoses answer-only with protocol evidence unavailable", () => {
    const { probe, stats } = observed([]); // the peer answered without any tool event
    const answers = ["[FYI] AHUB_PROBE_DENIED"];
    const outcome = evaluateProbe("qwen", { denial: probe.denied, answers, settled: true, state: "idle" });
    expect(outcome).toEqual({ checked: true, result: "failed", reason: "no structured denial evidence was observed" });
    const diagnosis = diagnose("qwen", { denial: probe.denied, answers, settled: true, state: "idle", stats });
    expect(diagnosis.category).toBe("answer-only");
    expect(diagnosis.origin).toBe("unknown"); // agent behavior vs tool-event coverage is indistinguishable
    expect(diagnosis.counts["answer-only"]).toBe(1);
    expect(diagnosis.counts["protocol-evidence-unavailable"]).toBe(1);
    expect(diagnosis.counts["target-read-attempted"]).toBe(0);
    const readiness = probeReadiness("qwen", outcome, targetSha, true, diagnosis);
    expect(gateAccepts(readiness)).toBe(false); // the marker alone still never passes (#150)
    expect((readiness.diagnosis as Record<string, unknown>).category).toBe("answer-only");
    // A write (not a read) beside the answer keeps answer-only, with the coverage flag cleared.
    const wrote = observed([announce("w", "edit"), input("w", "/project/source.py"), settle("w", "completed")]);
    const d2 = diagnose("qwen", { denial: wrote.probe.denied, answers, settled: true, state: "idle", stats: wrote.stats });
    expect(d2.category).toBe("answer-only");
    expect(d2.counts["protocol-evidence-unavailable"]).toBe(0);
    expect(d2.counts["target-read-attempted"]).toBe(0);
  });

  test("wrong target: reads on other paths diagnose wrong-target as agent behavior", () => {
    const { probe, stats } = observed([announce("a"), input("a", "/project/source.py"), settle("a", "failed", deniedContent)]);
    expect(probe.denied).toBe(false); // a denial-text failure on the wrong path is not the probe's evidence (#140)
    const outcome = evaluateProbe("qwen", { denial: probe.denied, answers: ["[FYI] AHUB_PROBE_DENIED"], settled: true, state: "idle" });
    expect(outcome.result).toBe("failed");
    const diagnosis = diagnose("qwen", { denial: probe.denied, answers: ["[FYI] AHUB_PROBE_DENIED"], settled: true, state: "idle", stats });
    expect(diagnosis.category).toBe("wrong-target");
    expect(diagnosis.origin).toBe("agent-behavior");
    expect(diagnosis.counts["target-read-attempted"]).toBe(1);
    expect(diagnosis.counts["target-matched"]).toBe(0);
    expect(diagnosis.counts["tool-settled"]).toBe(0);
    expect(gateAccepts(probeReadiness("qwen", outcome, targetSha, true, diagnosis))).toBe(false);
  });

  test("permission refusal: the bound EPERM/EACCES failure is the supported tool denial", () => {
    const { probe, stats } = observed([announce("a"), input("a"), settle("a", "failed", deniedContent)]);
    expect(probe.denied).toBe(true);
    expect(stats.permissionDenials).toBe(1);
    expect(stats.settledTargetReads).toBe(1);
    const outcome = evaluateProbe("qwen", { denial: probe.denied, answers: [], settled: true, state: "idle" });
    expect(outcome).toEqual({ checked: true, result: "denied", evidence: "tool-failure" });
    const diagnosis = diagnose("qwen", { denial: probe.denied, answers: [], settled: true, state: "idle", stats });
    expect(diagnosis.category).toBe("verified-denial");
    expect(diagnosis.origin).toBe("none");
    expect(diagnosis.counts["permission-outcome"]).toBe(1);
    expect(diagnosis.counts["structured-error-class"]).toBe(1);
    // A verified denial's readiness keeps its exact pre-#169 shape: no diagnosis is attached.
    const readiness = probeReadiness("qwen", outcome, targetSha, true, diagnosis);
    expect(readiness.diagnosis).toBeUndefined();
    expect(readiness.kernelProbe).toEqual({ checked: true, result: "denied" });
    expect(gateAccepts(readiness)).toBe(true);
  });

  test("a kernel denial alone never substitutes for the native structured evidence", () => {
    // The observed 2026-10-06 cell: kernel probe denied, native probe unsupported. Still failed, still unavailable.
    const { probe, stats } = observed([]);
    const outcome = evaluateProbe("qwen", { denial: probe.denied, answers: ["[FYI] AHUB_PROBE_DENIED"], settled: true, state: "idle" });
    const diagnosis = diagnose("qwen", { denial: probe.denied, answers: ["[FYI] AHUB_PROBE_DENIED"], settled: true, state: "idle", stats });
    const readiness = probeReadiness("qwen", outcome, targetSha, true, diagnosis);
    expect(readiness.kernelProbe).toEqual({ checked: true, result: "denied" }); // the seatbelt layer was verified
    expect(readiness.result).toBe("failed"); // the native layer was not
    expect(gateAccepts(readiness)).toBe(false);
    expect((readiness.diagnosis as Record<string, unknown>).category).toBe("answer-only");
  });

  test("successful protected read: a completed target read diagnoses accessible, never a denial", () => {
    const { probe, stats } = observed([announce("a"), input("a"), settle("a", "completed", [{ text: "secret" }])]);
    expect(probe.denied).toBe(false);
    expect(stats.completedTargetReads).toBe(1);
    const outcome = evaluateProbe("qwen", { denial: probe.denied, answers: ["[FYI] AHUB_PROBE_ACCESSIBLE"], settled: true, state: "idle" });
    expect(outcome).toEqual({ checked: true, result: "failed", reason: "the peer reported the protected file accessible" });
    const diagnosis = diagnose("qwen", { denial: probe.denied, answers: ["[FYI] AHUB_PROBE_ACCESSIBLE"], settled: true, state: "idle", stats });
    expect(diagnosis.category).toBe("accessible");
    expect(diagnosis.origin).toBe("agent-behavior");
    expect(diagnosis.counts["tool-settled"]).toBe(1);
    expect(diagnosis.counts["permission-outcome"]).toBe(0);
    expect(gateAccepts(probeReadiness("qwen", outcome, targetSha, true, diagnosis))).toBe(false);
    // The completed read diagnoses accessible even without the model's accessible report.
    const silent = diagnose("qwen", { denial: probe.denied, answers: [], settled: true, state: "idle", stats });
    expect(silent.category).toBe("accessible");
  });

  test("malformed/unsupported error: unparsed content is normalization, a known non-permission class is agent behavior", () => {
    const malformed = observed([announce("a"), input("a"), settle("a", "failed")]); // no content at all
    expect(malformed.probe.denied).toBe(false);
    const d1 = diagnose("qwen", { denial: malformed.probe.denied, answers: [], settled: true, state: "idle", stats: malformed.stats });
    expect(d1.category).toBe("unsupported-error");
    expect(d1.origin).toBe("normalization");
    expect(d1.counts["tool-settled"]).toBe(1);
    expect(d1.counts["structured-error-class"]).toBe(0);
    const notFound = observed([announce("a"), input("a"), settle("a", "failed", [{ text: "ENOENT: no such file or directory" }])]);
    const d2 = diagnose("qwen", { denial: notFound.probe.denied, answers: [], settled: true, state: "idle", stats: notFound.stats });
    expect(d2.category).toBe("unsupported-error");
    expect(d2.origin).toBe("agent-behavior");
    expect(d2.counts["structured-error-class"]).toBe(1);
    expect(gateAccepts(probeReadiness("qwen", evaluateProbe("qwen", { denial: false, answers: [], settled: true, state: "idle" }), targetSha, true, d2))).toBe(false);
  });

  test("deadline expiry: an unsettled probe diagnoses deadline and serializes unknown, never a denial", () => {
    const { probe, stats } = observed([]); // no answer, no tool event, still busy at the deadline
    const outcome = evaluateProbe("qwen", { denial: probe.denied, answers: [], settled: false, state: "busy" });
    expect(outcome).toEqual({ checked: false, result: "unknown", reason: "the probe never settled before its deadline" });
    const diagnosis = diagnose("qwen", { denial: probe.denied, answers: [], settled: false, state: "busy", deadlineExpired: true, stats });
    expect(diagnosis.category).toBe("deadline");
    expect(diagnosis.counts.deadline).toBe(1);
    expect(diagnosis.counts["protocol-evidence-unavailable"]).toBe(1);
    const readiness = probeReadiness("qwen", outcome, targetSha, true, diagnosis);
    expect(readiness.result).toBe("unknown");
    expect((readiness.diagnosis as Record<string, unknown>).category).toBe("deadline");
    expect(gateAccepts(readiness)).toBe(false);
    // A read attempted but never settled by the deadline keeps the coverage flag clear.
    const hanging = observed([announce("a"), input("a")]);
    const d2 = diagnose("qwen", { denial: hanging.probe.denied, answers: [], settled: false, state: "busy", deadlineExpired: true, stats: hanging.stats });
    expect(d2.category).toBe("deadline");
    expect(d2.counts["target-read-attempted"]).toBe(1);
    expect(d2.counts["protocol-evidence-unavailable"]).toBe(0);
  });

  test("peer offline: the probe diagnoses peer-offline and stays unknown", () => {
    const outcome = evaluateProbe("pi", { denial: false, answers: [], settled: false, state: "offline" });
    const diagnosis = diagnose("pi", { denial: false, answers: [], settled: false, state: "offline" });
    expect(diagnosis.category).toBe("peer-offline");
    expect(diagnosis.counts["peer-offline"]).toBe(1);
    expect(diagnosis.counts.deadline).toBe(0);
    const readiness = probeReadiness("pi", outcome, targetSha, undefined, diagnosis);
    expect(readiness.result).toBe("unknown");
    expect(gateAccepts(readiness)).toBe(false);
  });

  test("pi: a guard denial without the peer's probe answer diagnoses denial-unconfirmed (#150 stands)", () => {
    const stats = { ...emptyProbeWindowStats(), readsAttempted: 1, targetReads: 1, settledTargetReads: 1, permissionDenials: 1, toolEventsSeen: 1 };
    const outcome = evaluateProbe("pi", { denial: true, answers: ["[FYI] done"], settled: true, state: "idle" });
    expect(outcome.result).toBe("failed"); // the missing pairing answer still fails the probe
    const diagnosis = diagnose("pi", { denial: true, answers: ["[FYI] done"], settled: true, state: "idle", stats });
    expect(diagnosis.category).toBe("denial-unconfirmed");
    expect(diagnosis.origin).toBe("agent-behavior");
    expect(diagnosis.counts["permission-outcome"]).toBe(1);
    expect(gateAccepts(probeReadiness("pi", outcome, targetSha, undefined, diagnosis))).toBe(false);
    // With the pairing answer the same evidence verifies, exactly as before #169.
    const ok = evaluateProbe("pi", { denial: true, answers: ["[FYI] AHUB_PROBE_DENIED"], settled: true, state: "idle" });
    expect(ok).toEqual({ checked: true, result: "denied", evidence: "guard-denial" });
    expect(diagnose("pi", { denial: true, answers: ["[FYI] AHUB_PROBE_DENIED"], settled: true, state: "idle", stats }).category).toBe("verified-denial");
  });

  test("pi: a kernel refusal without the guard denial diagnoses permission-refused as normalization", () => {
    // Pi's accepted evidence is its guard denial; a seatbelt EPERM string from runTool is a refusal seen across
    // a normalization boundary, so it neither passes the predicate nor reads as agent behavior.
    const stats = { ...emptyProbeWindowStats(), readsAttempted: 1, targetReads: 1, settledTargetReads: 1, permissionDenials: 1, toolEventsSeen: 1 };
    const outcome = evaluateProbe("pi", { denial: false, answers: ["[FYI] AHUB_PROBE_DENIED"], settled: true, state: "idle" });
    expect(outcome.result).toBe("failed");
    const diagnosis = diagnose("pi", { denial: false, answers: ["[FYI] AHUB_PROBE_DENIED"], settled: true, state: "idle", stats });
    expect(diagnosis.category).toBe("permission-refused");
    expect(diagnosis.origin).toBe("normalization");
    expect(gateAccepts(probeReadiness("pi", outcome, targetSha, undefined, diagnosis))).toBe(false);
  });

  test("the safe view is a strict scalar allowlist: malicious nested content cannot inject keys or strings", () => {
    const sentinel = "SENTINEL-PATH-/private/secret-do-not-leak";
    const malicious = [
      { sessionUpdate: "tool_call", toolCallId: "a", kind: "read", status: "pending", rawInput: { __proto__: { injected: true }, extra: sentinel }, diagnosis: { category: "verified-denial" } },
      { sessionUpdate: "tool_call_update", toolCallId: "a", status: "in_progress", rawInput: { file_path: target }, session: sentinel, window: "active" },
      { sessionUpdate: "tool_call_update", toolCallId: "a", status: "failed", content: [{ text: `EACCES ${sentinel}` }], counts: { "permission-outcome": 99 } },
    ];
    const { probe, stats } = observed(malicious);
    expect(probe.denied).toBe(true); // the evidence predicate itself is unaffected by the extra keys
    const diagnosis = diagnose("qwen", { denial: probe.denied, answers: [sentinel], settled: true, state: "idle", stats, sessionId: `bad session/id ${sentinel}` });
    const safe = safeProbeDiagnosis(diagnosis);
    expect(Object.keys(safe).sort()).toEqual(["category", "counts", "origin", "peer", "window"]); // the bad session id is dropped
    expect(Object.keys(safe.counts as Record<string, unknown>).sort()).toEqual([...PROBE_TRACE_EVENTS].sort());
    expect(safe.window).toBe("setup-probe");
    expect(JSON.stringify(safe)).not.toContain("SENTINEL");
    // A hand-built diagnosis with injected keys and hostile values is reduced to the allowlist too.
    const hostile = { peer: "evil", session: "ok-session_1", window: "active", category: "verified-denial; DROP", origin: sentinel, counts: { "target-matched": -3, "tool-settled": 1.5, injected: sentinel }, extra: sentinel } as unknown as ProbeDiagnosis;
    const cleaned = safeProbeDiagnosis(hostile);
    expect(Object.keys(cleaned).sort()).toEqual(["category", "counts", "origin", "peer", "session", "window"]);
    expect(cleaned.peer).toBe("unknown");
    expect(cleaned.category).toBe("unknown");
    expect(cleaned.origin).toBe("unknown");
    expect(cleaned.session).toBe("ok-session_1");
    expect((cleaned.counts as Record<string, number>)["target-matched"]).toBe(0);
    expect((cleaned.counts as Record<string, number>)["tool-settled"]).toBe(0);
    expect(JSON.stringify(cleaned)).not.toContain("SENTINEL");
    expect(JSON.stringify(cleaned)).not.toContain("injected");
  });

  test("the diagnosis binds peer, session and the setup probe window; stats snapshots are immutable", () => {
    const probe = new ProtectedReadProbe(target);
    probe.observe(announce("a"));
    const snapshot = probe.stats();
    probe.observe(input("a"));
    probe.observe(settle("a", "failed", deniedContent));
    expect(snapshot.readsAttempted).toBe(1); // the snapshot is bound to the window it was taken in
    expect(snapshot.settledTargetReads).toBe(0);
    expect(probe.stats().settledTargetReads).toBe(1);
    const diagnosis = diagnose("qwen", { denial: probe.denied, answers: [], settled: true, state: "idle", stats: probe.stats(), sessionId: "0192ab-cdef" });
    const safe = safeProbeDiagnosis(diagnosis);
    expect(safe.peer).toBe("qwen");
    expect(safe.session).toBe("0192ab-cdef");
    expect(safe.window).toBe("setup-probe");
  });

  test("no failing diagnosis ever reclassifies the setup as a success", () => {
    // Every failing category: the predicate outcome is failed/unknown, the readiness gate refuses, and the
    // setup loop's throw condition (result !== 'denied') still fires — no retry, no success reclassification.
    const failing: { name: ProbeDiagnosisCategory; peer: string; observation: { denial: boolean; answers: string[]; settled: boolean; state: string; deadlineExpired?: boolean; stats?: ProbeWindowStats } }[] = [
      { name: "answer-only", peer: "qwen", observation: { denial: false, answers: ["[FYI] AHUB_PROBE_DENIED"], settled: true, state: "idle" } },
      { name: "wrong-target", peer: "qwen", observation: { denial: false, answers: [], settled: true, state: "idle", stats: { ...emptyProbeWindowStats(), readsAttempted: 2, wrongTargetReads: 2, toolEventsSeen: 4 } } },
      { name: "accessible", peer: "pi", observation: { denial: true, answers: ["[FYI] AHUB_PROBE_ACCESSIBLE"], settled: true, state: "idle" } },
      { name: "denial-unconfirmed", peer: "pi", observation: { denial: true, answers: [], settled: true, state: "idle", stats: { ...emptyProbeWindowStats(), readsAttempted: 1, targetReads: 1, settledTargetReads: 1, permissionDenials: 1, toolEventsSeen: 1 } } },
      { name: "permission-refused", peer: "pi", observation: { denial: false, answers: ["[FYI] AHUB_PROBE_DENIED"], settled: true, state: "idle", stats: { ...emptyProbeWindowStats(), readsAttempted: 1, targetReads: 1, settledTargetReads: 1, permissionDenials: 1, toolEventsSeen: 1 } } },
      { name: "unsupported-error", peer: "qwen", observation: { denial: false, answers: [], settled: true, state: "idle", stats: { ...emptyProbeWindowStats(), readsAttempted: 1, targetReads: 1, settledTargetReads: 1, otherFailures: 1, toolEventsSeen: 3 } } },
      { name: "peer-offline", peer: "qwen", observation: { denial: false, answers: [], settled: false, state: "offline" } },
      { name: "deadline", peer: "qwen", observation: { denial: false, answers: [], settled: false, state: "busy", deadlineExpired: true } },
    ];
    for (const f of failing) {
      const outcome = evaluateProbe(f.peer, { denial: f.observation.denial, answers: f.observation.answers, settled: f.observation.settled, state: f.observation.state });
      expect(outcome.result).not.toBe("denied"); // the arm still throws: setup stays unavailable with elapsed zero
      const diagnosis = diagnose(f.peer, f.observation);
      expect(diagnosis.category).toBe(f.name);
      const readiness = probeReadiness(f.peer, outcome, targetSha, f.peer === "qwen" ? true : undefined, diagnosis);
      expect(gateAccepts(readiness)).toBe(false);
      expect((readiness.diagnosis as Record<string, unknown>).category).toBe(f.name); // the unavailable reason is exposed
      expect(readiness.peer_failure).toBeUndefined(); // separate from any active-window peer failure
    }
  });
});

describe("effective-build pinning (correction 1)", () => {
  test("the version is read under the isolation environment, not the outer one", async () => {
    const root = fixture();
    try {
      // Qwen's bootstrap failure mode: the managed build in the normal home, the base build under isolation.
      const out = await effectiveBuild(["/bin/sh", "-c", "printf %s \"$FAKE_VERSION\""], { cwd: root, env: { FAKE_VERSION: "0.24.1" } });
      expect(out).toBe("0.24.1");
      expect(parseVersion(out)).toBe("0.24.1");
      expect(parseVersion(await effectiveBuild(["/bin/sh", "-c", "printf %s \"$FAKE_VERSION\""], { cwd: root, env: { FAKE_VERSION: "0.24.7" } }))).toBe("0.24.7");
      expect(parseVersion("qwen code version 0.24.7 (managed)")).toBe("0.24.7");
      expect(parseVersion("no version here")).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // macOS-only: /usr/bin/sandbox-exec does not exist on the ubuntu CI leg (review #146).
  test.skipIf(process.platform !== "darwin")("a seatbelt profile wraps the version command when one is given", async () => {
    const root = fixture();
    try {
      const profile = join(root, "p.sb");
      writeFileSync(profile, "(version 1)(allow default)");
      expect(await effectiveBuild(["/bin/echo", "ok"], { sandboxProfile: profile })).toBe("ok");
      // A profile that denies execution proves the wrapper is really applied.
      writeFileSync(profile, "(version 1)(deny default)");
      await expect(effectiveBuild(["/bin/echo", "ok"], { sandboxProfile: profile })).rejects.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("attempt evidence claims (correction 6)", () => {
  test("an exclusive claim is written once and never overwritten", () => {
    const root = fixture();
    try {
      const claim = join(root, "native-owner.json");
      claimExclusive(claim, JSON.stringify({ pid: 1 }));
      expect(() => claimExclusive(claim, JSON.stringify({ pid: 2 }))).toThrow();
      expect(JSON.parse(readFileSync(claim, "utf8")).pid).toBe(1);
      const rec = join(root, "00-solo-pi.json");
      writeRecordFresh(rec, "{}");
      expect(() => writeRecordFresh(rec, "{}")).toThrow(/attempt evidence already exists/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("submission patch capture (correction 4)", () => {
  test("new source files enter the binary patch; files outside the source dirs stay out", async () => {
    const root = fixture();
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src/tracked.py"), "a\n");
      writeFileSync(join(root, "README.md"), "r\n");
      git(root, "init", "-q");
      git(root, "add", "-A");
      git(root, "-c", "user.name=B", "-c", "user.email=b@localhost", "commit", "-qm", "base");
      const base = git(root, "rev-parse", "HEAD");
      writeFileSync(join(root, "src/tracked.py"), "a\nb\n");
      writeFileSync(join(root, "src/new_module.py"), "new\n"); // a source file the agents created
      writeFileSync(join(root, "scratch.txt"), "outside\n"); // outside the guarded layout: not in the patch
      const patch = await collectSubmissionPatch(root, base, ["src"]);
      expect(patch).toContain("new_module.py");
      expect(patch).toContain("tracked.py");
      expect(patch).not.toContain("scratch.txt");
      // The patch applies cleanly against the baseline: it is a complete submission.
      const work = mkdtempSync(join(tmpdir(), "ahub-bench-v3-apply-"));
      try {
        git(work, "init", "-q");
        mkdirSync(join(work, "src"));
        writeFileSync(join(work, "src/tracked.py"), "a\n");
        git(work, "add", "-A");
        git(work, "-c", "user.name=B", "-c", "user.email=b@localhost", "commit", "-qm", "base");
        const apply = spawnSync("git", ["apply", "--whitespace=nowarn"], { cwd: work, input: patch, encoding: "utf8" });
        expect(apply.status).toBe(0);
        expect(readFileSync(join(work, "src/new_module.py"), "utf8")).toBe("new\n");
      } finally { rmSync(work, { recursive: true, force: true }); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("disposal ordering (correction 5)", () => {
  test("a failing closer neither stops the others nor erases the record captured before disposal", async () => {
    const root = fixture();
    try {
      const order: string[] = [];
      const errors = await disposeAll([
        () => { order.push("first"); },
        () => { throw new Error("closer failed"); },
        () => { order.push("last"); },
      ]);
      expect(order).toEqual(["first", "last"]); // every closer ran
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("closer failed");
      // The active-window record, captured before disposal, is written afterwards, intact.
      const record = join(root, "active-window.json");
      writeRecordFresh(record, JSON.stringify({ elapsedMs: 10, disposalErrors: errors }));
      expect(JSON.parse(readFileSync(record, "utf8")).elapsedMs).toBe(10);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("terminal active-turn peer failure (#160)", () => {
  test("peer-failure submissions refuse late or unverified source trees", () => {
    expect(activeTreeFlag("peer-failure", true)).toBe("tree-changed-after-active-time");
    expect(activeTreeFlag("peer-failure", null)).toBe("tree-unverified-after-active-time");
    expect(activeTreeFlag("peer-failure", false)).toBeUndefined();
    expect(activeTreeFlag("completed", true)).toBe("tree-changed-after-active-time");
    expect(activeTreeFlag("wall-timeout", true)).toBeUndefined(); // legacy timeout semantics
  });
  test("a failure latched during the active phase exits at once as peer-failure, not after the wall budget", () => {
    // The observed study failure: Pi hit its 100-step ceiling and sat idle with no answer; the poll must end on
    // the latch's first tick instead of idling out the remaining wall limit for an answer that cannot come.
    const latch = new ActiveFailureLatch();
    const started = 1_000_000;
    latch.begin(started);
    const failedAt = started + 147_125; // 152.875 s of budget left when the step limit hit
    const noted = latch.note("pi", "step limit reached (100)", failedAt);
    expect(noted).toEqual({ latched: true, phase: "active" });
    expect(latch.failure).toEqual({ peer: "pi", failureClass: "step limit reached (100)", failedAt: new Date(failedAt).toISOString(), activeElapsedMs: 147_125, generation: 1 });
    // Nothing is settled — the failed peer never answers — yet the poll exits immediately with the distinct detail.
    expect(activeExit({ stopRequested: false, terminalFailure: latch.failure !== undefined, peerUnreachable: false, settled: false, quietMs: 0 })).toBe("peer-failure");
  });

  test("the first latched failure wins: the original class and time are preserved", () => {
    const latch = new ActiveFailureLatch();
    latch.begin(1_000_000);
    latch.note("pi", "step limit reached (100)", 1_100_000);
    latch.note("qwen", "session shut down", 1_100_050); // the joint arm's other actor cannot overwrite it
    expect(latch.failure).toMatchObject({ peer: "pi", failureClass: "step limit reached (100)", activeElapsedMs: 100_000 });
  });

  test("an expected denied tool read during setup is not a terminal failure", () => {
    // The protected-file probe denies a native read on purpose; nothing before active_start may latch.
    const latch = new ActiveFailureLatch();
    expect(latch.note("pi", "error: outside benchmark scope", Date.now())).toEqual({ latched: false, phase: "setup" });
    expect(latch.failure).toBeUndefined();
    expect(activeExit({ stopRequested: false, terminalFailure: latch.failure !== undefined, peerUnreachable: false, settled: false, quietMs: 0 })).toBeUndefined();
  });

  test("teardown-only and stale-generation callbacks cannot change a fixed active end cause", () => {
    const latch = new ActiveFailureLatch();
    latch.begin(1_000_000);
    latch.note("pi", "step limit reached (100)", 1_100_000);
    latch.freeze(); // active_end: the end cause is fixed here
    expect(latch.frozen).toBe(true);
    // A stop/watchdog callback during teardown is recorded as an event only; the latched failure stands.
    expect(latch.note("pi", "Pi session shut down before settlement", 1_101_000)).toEqual({ latched: false, phase: "ended" });
    expect(latch.failure).toMatchObject({ peer: "pi", failureClass: "step limit reached (100)", activeElapsedMs: 100_000, generation: 1 });
    // The next attempt's active phase is a new generation: it latches afresh and cannot inherit a stale failure.
    latch.begin(2_000_000);
    expect(latch.failure).toBeUndefined();
    latch.note("qwen", "agent run failed", 2_050_000);
    expect(latch.failure).toMatchObject({ peer: "qwen", activeElapsedMs: 50_000, generation: 2 });
  });

  test("a solo-qwen terminal prompt failure latches and exits early with the qwen metadata (#160 review)", () => {
    // The review's gap: AcpPeer reported a rejected prompt only as a needs_review receipt the driver never
    // observes, so a failed Qwen sat idle until the wall limit exactly as Pi had; its onTurnFailure now feeds
    // the same latch.
    const latch = new ActiveFailureLatch();
    const started = 2_000_000;
    latch.begin(started);
    latch.note("qwen", "session error", started + 61_000);
    expect(latch.failure).toMatchObject({ peer: "qwen", failureClass: "session error", activeElapsedMs: 61_000, generation: 1 });
    // Qwen produced no answer and its process stayed alive (idle, reachable): only the latch ends the wait.
    expect(activeExit({ stopRequested: false, terminalFailure: latch.failure !== undefined, peerUnreachable: false, settled: false, quietMs: 0 })).toBe("peer-failure");
  });

  test("a qwen failure in a joint attempt ends the attempt for both owned actors (#160 review)", () => {
    const latch = new ActiveFailureLatch();
    latch.begin(3_000_000);
    latch.note("qwen", "session error", 3_040_000); // Pi never failed
    expect(latch.failure).toMatchObject({ peer: "qwen" });
    expect(activeExit({ stopRequested: false, terminalFailure: true, peerUnreachable: false, settled: false, quietMs: 0 })).toBe("peer-failure");
    // The exit routes both owned peers through the driver's owned-process teardown (see the teardown call
    // site): a failed actor never leaves the other performing an undefined partial treatment.
  });

  test("the poll's other exits keep their classes; a genuine wall limit is the loop's own exit", () => {
    expect(activeExit({ stopRequested: false, terminalFailure: true, peerUnreachable: false, settled: false, quietMs: 0, wallExpired: true })).toBe("peer-failure");
    expect(activeExit({ stopRequested: false, terminalFailure: false, peerUnreachable: false, settled: false, quietMs: 0, wallExpired: true })).toBe("wall-timeout");
    expect(activeExit({ stopRequested: true, terminalFailure: true, peerUnreachable: false, settled: false, quietMs: 0 })).toBe("interrupted"); // the operator outranks the failure
    expect(activeExit({ stopRequested: false, terminalFailure: true, peerUnreachable: true, settled: false, quietMs: 0 })).toBe("peer-failure"); // the latch outranks the unreachable state it caused
    expect(activeExit({ stopRequested: false, terminalFailure: false, peerUnreachable: true, settled: false, quietMs: 0 })).toBe("native-failure");
    expect(activeExit({ stopRequested: false, terminalFailure: false, peerUnreachable: false, settled: true, quietMs: 999 })).toBeUndefined();
    expect(activeExit({ stopRequested: false, terminalFailure: false, peerUnreachable: false, settled: true, quietMs: 1000 })).toBe("completed");
    // Nothing to end on: undefined, so the loop's own condition exits it as a genuine wall-timeout.
    expect(activeExit({ stopRequested: false, terminalFailure: false, peerUnreachable: false, settled: false, quietMs: 0 })).toBeUndefined();
  });
});

describe("bounded active-window loop-protection diagnostics (#175)", () => {
  const announce = (id: string, kind = "read", title?: string) => ({ sessionUpdate: "tool_call", toolCallId: id, kind, status: "pending", ...(title === undefined ? {} : { title }) });
  const progress = (id: string) => ({ sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress" });
  const settle = (id: string, status: string, content?: unknown) => ({ sessionUpdate: "tool_call_update", toolCallId: id, status, ...(content === undefined ? {} : { content }) });
  const deniedContent = [{ type: "content", content: { type: "text", text: "EACCES: permission denied, open '/private/x'" } }];
  const failure = (partial: Partial<PeerFailure>): PeerFailure => ({ peer: "qwen", failureClass: "session error", failedAt: new Date(0).toISOString(), activeElapsedMs: 100, generation: 1, ...partial });
  const traced = (updates: unknown[], opts: { servers?: string[]; generation?: number; session?: string } = {}) => {
    const trace = new ActiveToolTrace("qwen", opts.servers ?? []);
    trace.begin(opts.generation ?? 1, opts.session);
    for (const u of updates) trace.observe(u);
    trace.freeze();
    return trace;
  };

  test("the pinned loop-protection message produces the fixed terminal class; anything else stays unknown", () => {
    expect(classifyNativeTermination("qwen", QWEN_0_24_7_LOOP_PROTECTION_MESSAGE)).toEqual({ class: "tool-loop-protection", evidence: "pinned-message" });
    for (const other of ["loop detected", "Tool-call loop protection stopped this turn.", `${QWEN_0_24_7_LOOP_PROTECTION_MESSAGE} `, `prefix ${QWEN_0_24_7_LOOP_PROTECTION_MESSAGE}`, "session error", "", undefined]) {
      expect(classifyNativeTermination("qwen", other)).toEqual({ class: "unknown", evidence: "none" });
    }
    // The contract is the pinned Qwen build's: the same words from another peer are not its evidence.
    expect(classifyNativeTermination("pi", QWEN_0_24_7_LOOP_PROTECTION_MESSAGE).class).toBe("unknown");
  });

  test("setup and teardown observations are phase-gated out of the active window", () => {
    const trace = new ActiveToolTrace("qwen");
    trace.observe(announce("s1")); // the setup probe window: dropped
    trace.begin(1, "sess-1");
    trace.observe(announce("a"));
    trace.observe(progress("a"));
    trace.observe(settle("a", "completed"));
    trace.freeze();
    trace.observe(announce("t1")); // teardown: dropped
    const stats = trace.stats();
    expect(stats.counts.updateEvents).toBe(3);
    expect(stats.counts.announcements).toBe(1);
    expect(stats.counts.settled).toBe(1);
    expect(stats.counts.completed).toBe(1);
    expect(stats.counts.unsettled).toBe(0);
    expect(trace.binding).toEqual({ peer: "qwen", session: "sess-1", generation: 1 });
  });

  test("update events, distinct ids and verified settlements are different measures; duplicates never mix them", () => {
    // The study table's shape, scaled down: several update events per call, a duplicate settlement included.
    const trace = traced([
      announce("a"), progress("a"), progress("a"), settle("a", "completed"), settle("a", "completed"),
      announce("b"), progress("b"), settle("b", "failed", deniedContent),
      announce("c"), // never settled
    ]);
    const c = trace.stats().counts;
    expect(c.updateEvents).toBe(9);
    expect(c.distinctCallIds).toBe(3);
    expect(c.announcements).toBe(3);
    expect(c.settled).toBe(2); // verified executions: a terminal update bound to the in-window call
    expect(c.duplicateSettlements).toBe(1); // a repeated terminal update is an event, never a second execution
    expect(c.unsettled).toBe(1);
    expect(c.completed).toBe(1);
    expect(c.failedPermission).toBe(1);
  });

  test("a reused id is a new call: its predecessor's settlement cannot attach to it", () => {
    const trace = traced([
      announce("x"), settle("x", "completed"),
      announce("x"), settle("x", "failed", deniedContent), // a new call under the same id starts clean
    ]);
    const c = trace.stats().counts;
    expect(c.announcements).toBe(2);
    expect(c.distinctCallIds).toBe(1);
    expect(c.reusedIds).toBe(1);
    expect(c.settled).toBe(2);
    expect(c.completed).toBe(1);
    expect(c.failedPermission).toBe(1);
  });

  test("interleaved calls, peers and generations keep separate counters", () => {
    const trace = traced([
      announce("a"), announce("b"), progress("a"), settle("b", "completed"), progress("a"), settle("a", "failed", [{ text: "ENOENT: no such file" }]),
    ]);
    const c = trace.stats().counts;
    expect(c.updateEvents).toBe(6);
    expect(c.settled).toBe(2);
    expect(c.completed).toBe(1);
    expect(c.failedNotFound).toBe(1);
    // A second peer's trace never shares the first's counters.
    const other = new ActiveToolTrace("qwen");
    other.begin(1);
    other.observe(announce("z"));
    other.freeze();
    expect(other.stats().counts.announcements).toBe(1);
    expect(trace.stats().counts.announcements).toBe(2);
    // A new generation inherits nothing, and a stale cancelled generation's late events bind nowhere.
    const stale = new ActiveToolTrace("qwen");
    stale.begin(1, "s1");
    stale.observe(announce("old"));
    stale.observe(settle("old", "completed"));
    stale.begin(2, "s1");
    expect(stale.stats().counts.announcements).toBe(0);
    stale.observe(settle("old", "completed")); // no in-window announcement binds it
    stale.freeze();
    expect(stale.stats().counts.unresolved).toBe(1);
    expect(stale.stats().counts.settled).toBe(0);
  });

  test("expected denial, tool failure, unparsed, unsettled and unresolved outcomes stay distinct", () => {
    const trace = traced([
      announce("p"), settle("p", "failed", deniedContent), // the expected guard/seatbelt denial class
      announce("e"), settle("e", "failed", [{ text: "ENOENT: no such file or directory" }]),
      announce("o"), settle("o", "failed", [{ text: "EIO: something else" }]),
      announce("u"), settle("u", "failed"), // no extractable error text: unparsed
      announce("h"), // open at the freeze: unsettled
      settle("foreign", "failed", deniedContent), // no in-window announcement: unresolved
    ]);
    const c = trace.stats().counts;
    expect(c.failedPermission).toBe(1);
    expect(c.failedNotFound).toBe(1);
    expect(c.failedOther).toBe(1);
    expect(c.failedUnparsed).toBe(1);
    expect(c.unsettled).toBe(1);
    expect(c.unresolved).toBe(1);
    expect(c.settled).toBe(4);
    expect(c.completed).toBe(0);
  });

  test("canonical categories come from the protocol kind and the #138 binding, never re-derived from titles", () => {
    const trace = traced([
      announce("r", "read", "read_file"),
      announce("w", "edit", "write_file"),
      announce("m", "other", "hub_send (pilot-peer-bus MCP Server)"), // a canonical-bound MCP call: its kind is not its identity
      announce("f", "execute", "hub_send (other-bus MCP Server)"), // an unconfigured server: the binding resolves nothing
      announce("n", "not-a-kind", "mystery"),
      announce("j", "read", '{"file_path":"/x"}'), // a title quoting argument JSON is no category source
    ], { servers: ["pilot-peer-bus"] });
    const cats = trace.stats().categories;
    expect(cats.read).toBe(2);
    expect(cats.edit).toBe(1);
    expect(cats.mcp).toBe(1);
    expect(cats.execute).toBe(1);
    expect(cats.unclassed).toBe(1);
    expect(Object.keys(cats).sort()).toEqual([...ACTIVE_TOOL_CATEGORIES].sort());
  });

  test("repeated announcements are a supported pattern; the native guard threshold is never derived from totals", () => {
    // Six identical announcements — past the pinned build's internal consecutive-identical guard (5) — still
    // classify nothing natively: the guard's threshold and predicate are not exposed over the ACP surface.
    const updates = Array.from({ length: 6 }, (_, i) => announce(`r${i}`, "read", "read_file"));
    const trace = traced(updates);
    const c = trace.stats().counts;
    expect(c.announcements).toBe(6);
    expect(c.repeatGroups).toBe(1);
    expect(c.repeatedAnnouncements).toBe(5);
    expect(c.maxRepeat).toBe(6);
    const diagnosis = diagnoseActiveTermination(failure({}), trace);
    expect(diagnosis.supportedPatterns).toEqual(["repeated-announcements"]);
    expect(diagnosis.terminal).toBe("unknown"); // repetition alone classifies nothing
    expect(diagnosis.capabilities).toEqual({ nativeGuardThreshold: "unavailable", nativeGuardPredicate: "unavailable", noopOutcomes: "unavailable" });
    // Distinct titles form no group; a settled permission denial is its own supported pattern.
    expect(traced([announce("a", "read", "one"), announce("b", "read", "two")]).stats().counts.repeatGroups).toBe(0);
    expect(diagnoseActiveTermination(failure({}), traced([announce("a"), settle("a", "failed", deniedContent)])).supportedPatterns).toEqual(["denied-operations"]);
  });

  test("an observed loop-protection stop composes the fixed terminal class with the frozen window", () => {
    // The observed study cells' shape: a busy tool stream, then the pinned loop-protection rejection.
    const trace = traced([
      announce("a"), progress("a"), settle("a", "completed"),
      announce("b", "edit", "edit_file"), settle("b", "failed", deniedContent),
      announce("c", "read", "read_file"), announce("d", "read", "read_file"),
    ], { session: "0192ab-cdef" });
    const diagnosis = diagnoseActiveTermination(failure({ failureClass: QWEN_0_24_7_LOOP_PROTECTION_MESSAGE }), trace);
    expect(diagnosis.terminal).toBe("tool-loop-protection");
    expect(diagnosis.terminalEvidence).toBe("pinned-message");
    expect(diagnosis.observations).toBe("acp-tool-stream");
    expect(diagnosis.window).toBe("active");
    expect(diagnosis.generation).toBe(1);
    expect(diagnosis.session).toBe("0192ab-cdef");
    expect(diagnosis.supportedPatterns).toEqual(["repeated-announcements", "denied-operations"]);
    expect(diagnosis.counts?.updateEvents).toBe(7);
    expect(diagnosis.counts?.distinctCallIds).toBe(4);
    expect(diagnosis.counts?.unsettled).toBe(2);
    const safe = safeActiveLoopDiagnosis(diagnosis);
    expect(JSON.stringify(safe)).not.toContain("read_file"); // titles never leave the trace
    expect(JSON.stringify(safe)).not.toContain(QWEN_0_24_7_LOOP_PROTECTION_MESSAGE.slice(0, 20)); // the raw message is not copied
  });

  test("the safe view is a strict scalar allowlist: nested titles, arguments and dynamic keys cannot inject", () => {
    const sentinel = "SENTINEL-ARG-/private/secret";
    const trace = traced([
      { sessionUpdate: "tool_call", toolCallId: "a", kind: "read", title: `read ${sentinel}`, extra: sentinel, counts: { settled: 99 } },
      { sessionUpdate: "tool_call_update", toolCallId: "a", status: "failed", content: [{ text: `EACCES ${sentinel}` }], session: sentinel },
    ], { session: `bad session/${sentinel}` });
    const diagnosis = diagnoseActiveTermination(failure({ failureClass: `loop protection ${sentinel}` }), trace);
    expect(diagnosis.terminal).toBe("unknown"); // an arbitrary message never classifies, and is never copied
    const safe = safeActiveLoopDiagnosis(diagnosis);
    expect(Object.keys(safe).sort()).toEqual(["capabilities", "categories", "counts", "generation", "observations", "peer", "supportedPatterns", "terminal", "terminalEvidence", "window"].sort()); // the bad session id is dropped
    expect(Object.keys(safe.counts as Record<string, unknown>).sort()).toEqual([...ACTIVE_TRACE_COUNTERS].sort());
    expect(Object.keys(safe.categories as Record<string, unknown>).sort()).toEqual([...ACTIVE_TOOL_CATEGORIES].sort());
    expect(JSON.stringify(safe)).not.toContain("SENTINEL");
    // A hand-built diagnosis with hostile values is reduced to the allowlist too.
    const hostile = {
      peer: "evil", session: "ok-session_1", generation: -2, window: "setup-probe", terminal: "tool-loop-protection", terminalEvidence: "none",
      observations: "acp-tool-stream", capabilities: { nativeGuardThreshold: 5, injected: sentinel }, supportedPatterns: ["repeated-announcements", sentinel],
      counts: { settled: -3, completed: 1.5, injected: sentinel }, categories: { read: 2, injected: sentinel }, extra: sentinel,
    } as unknown as ActiveLoopDiagnosis;
    const cleaned = safeActiveLoopDiagnosis(hostile);
    expect(cleaned.peer).toBe("unknown");
    expect(cleaned.window).toBe("active");
    expect(cleaned.generation).toBe(0);
    expect(cleaned.terminal).toBe("unknown"); // without the pinned-message evidence the class cannot stand
    expect(cleaned.terminalEvidence).toBe("none");
    expect(cleaned.session).toBe("ok-session_1");
    expect(cleaned.capabilities).toEqual({ nativeGuardThreshold: "unavailable", nativeGuardPredicate: "unavailable", noopOutcomes: "unavailable" });
    expect(cleaned.supportedPatterns).toEqual(["repeated-announcements"]);
    expect((cleaned.counts as Record<string, number>).settled).toBe(0);
    expect((cleaned.counts as Record<string, number>).completed).toBe(0);
    expect((cleaned.categories as Record<string, number>).read).toBe(2);
    expect(JSON.stringify(cleaned)).not.toContain("SENTINEL");
    expect(JSON.stringify(cleaned)).not.toContain("injected");
  });

  test("a peer without an observed protocol stream reports observations unavailable, with no counts", () => {
    // Pi latched (its 100-step ceiling): no ACP tool stream is observed for it, and none is synthesized.
    const diagnosis = diagnoseActiveTermination(failure({ peer: "pi", failureClass: "step limit reached (100)" }), undefined);
    expect(diagnosis.observations).toBe("unavailable");
    expect(diagnosis.counts).toBeUndefined();
    expect(diagnosis.supportedPatterns).toEqual([]);
    expect(diagnosis.terminal).toBe("unknown");
    const safe = safeActiveLoopDiagnosis(diagnosis);
    expect(safe.counts).toBeUndefined();
    expect(safe.categories).toBeUndefined();
    expect(safe.observations).toBe("unavailable");
  });
});

// runner.py's v3 gates: manifest validation, prepare provenance, request gate, outside-changes and the report's
// separate quality/model/request-linkage coverage (no Docker, no live agents).
describe("runner.py v3 gates (#140)", () => {
  test("manifest v3 validates, its plan adds up, and malformed v3 fields are refused", () => {
    const code = `import importlib.util,json
s=importlib.util.spec_from_file_location('r',${JSON.stringify(script)});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
v3=json.load(open(${JSON.stringify(join(import.meta.dir, "../../scripts/benchmarks/manifest-v3-pi-qwen.json"))}))
m.validate_manifest(v3)
assert v3['plan']['study']['attempts']==60 and v3['plan']['study']['active_ceiling_s']==18000
assert [m.required_actors(a) for a in v3['arms']]==[['pi'],['qwen'],['pi','qwen']]
import copy
bad=copy.deepcopy(v3); bad['cases'][0]['source_dirs']=['lib']
try: m.validate_manifest(bad); raise AssertionError('bogus source_dirs accepted')
except m.BenchError as e: assert 'source_dirs' in str(e)
bad=copy.deepcopy(v3); bad['versions']['qwen']='managed'
try: m.validate_manifest(bad); raise AssertionError('unpinned build accepted')
except m.BenchError as e: assert 'qwen build' in str(e)
bad=copy.deepcopy(v3); del bad['expected_provider']
try: m.validate_manifest(bad); raise AssertionError('missing provider pin accepted')
except m.BenchError as e: assert 'expected_provider' in str(e)
bad=copy.deepcopy(v3); bad['plan']['study']['attempts']=59
try: m.validate_manifest(bad); raise AssertionError('wrong plan accepted')
except m.BenchError as e: assert 'do not match 60 attempts' in str(e)
`;
    const r = spawnSync("python3", ["-B", "-c", code], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
  });

  test("prepare writes the sealed instruction and pins the driver, peer bus and candidate sources", () => {
    const root = fixture();
    try {
      const archive = join(root, "sample_repo-7.tar");
      const pack = spawnSync("python3", ["-c", `import tarfile,io; t=tarfile.open(${JSON.stringify(archive)},'w'); i=tarfile.TarInfo('src/tracked.py'); b=b'a'; i.size=1; t.addfile(i,io.BytesIO(b)); t.close()`]);
      expect(pack.status).toBe(0);
      const manifest = { schema: "agent-hub.cooperbench-run/v1", headless: true, upstream: { commit: "63b9d44d9f39a02fccf5bf0052db48a917a011fd" }, arms: ["solo-pi", "solo-qwen", "joint-pi-qwen"], versions: { pi: "1.0.1", qwen: "0.24.7" }, models: { pi: "dgx/coding", qwen: "dgx/coding" }, fixed_backend: "b", expected_served_model: "s", expected_provider: "p", cases: [{ repo: "sample_repo", task: 7, features: [1, 2], image_digest: "sample@sha256:" + "d".repeat(64), base_commit: "e".repeat(40), archive_sha256: sha(readFileSync(archive)), prompt_sha256: ["a".repeat(64), "b".repeat(64)], source_dirs: ["src"] }] };
      const manifestPath = join(root, "manifest.json");
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const run = spawnSync("python3", [script, "prepare", "--manifest", manifestPath, "--archives", root, "--output", join(root, "output")], { encoding: "utf8" });
      if (run.status !== 0) throw new Error(run.stderr);
      const prepared = JSON.parse(readFileSync(join(root, "output", "prepared.json"), "utf8"));
      expect(prepared.fixtures).toHaveLength(3);
      expect(prepared.fixtures[0].source_dirs).toEqual(["src"]);
      const rel = (f: string) => createHash("sha256").update(readFileSync(join(import.meta.dir, f))).digest("hex");
      expect(prepared.pi_qwen_runner_sha256).toBe(rel("../../scripts/benchmarks/native-pi-qwen.ts"));
      expect(prepared.peer_bus_sha256).toBe(rel("../../scripts/benchmarks/peer-bus-mcp.py"));
      expect(prepared.source_pins["src/models/relay.ts"]).toBe(rel("../../src/models/relay.ts"));
      const agents = readFileSync(join(root, "output", "fixtures", "00-solo-pi", "AGENTS.md"), "utf8");
      expect(agents).toContain("Source edits only under src/");
      // The instruction is part of the sealed baseline: grading's metadata hash binds it.
      expect(prepared.fixtures[0].baseline_paths).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the v3 request gate and outside-change check qualify attempts like the TS qualification", () => {
    const root = fixture();
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src/a.py"), "a\n");
      git(root, "init", "-q");
      git(root, "add", "-A");
      git(root, "-c", "user.name=B", "-c", "user.email=b@localhost", "commit", "-qm", "base");
      const code = `import importlib.util,json,pathlib,subprocess
s=importlib.util.spec_from_file_location('r',${JSON.stringify(script)});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
man={'fixed_backend':'b','expected_served_model':'s','expected_provider':'p'}
rec=lambda **kw: {'id':'1','requestedModel':'b','provider':'p','actualModel':'s','identitySource':'stream','outcome':'completed','identified':True,'durationMs':1,**kw}
assert m.v3_request_gate({'requests':[rec()]},man) is None
assert m.v3_request_gate({'requests':[]},man)=='generation requests unverified'
assert m.v3_request_gate(None,man)=='generation model identity missing'
can=rec(outcome='cancelled',identified=False,actualModel=None,provider=None)
assert m.v3_request_gate({'requests':[can]},man).startswith('no completed generation request')
assert m.v3_request_gate({'requests':[rec(),can]},man) is None  # cancelled-before-identification certifies nothing
canbad=rec(outcome='cancelled',mismatch=True,actualModel='other')
assert m.v3_request_gate({'requests':[rec(),canbad]},man)=='generation served model mismatch flagged'  # identified before the cancel: the mismatch stands (#146)
canwrong=rec(outcome='cancelled',actualModel='other')
assert m.v3_request_gate({'requests':[rec(),canwrong]},man)=='generation model identity unverified'
canprov=rec(outcome='cancelled',provider='q')
assert m.v3_request_gate({'requests':[rec(),canprov]},man)=='generation provider mismatch'
canok=rec(outcome='cancelled')
assert m.v3_request_gate({'requests':[rec(),canok]},man) is None  # a cleanly identified cancellation fails nothing
hb=rec(identified=False,actualModel=None)
assert m.v3_request_gate({'requests':[hb]},man)=='generation model identity unverified'
assert m.v3_request_gate({'requests':[rec(mismatch=True)]},man)=='generation served model mismatch flagged'
assert m.v3_request_gate({'requests':[rec(actualModel='other')]},man)=='generation model identity unverified'
assert m.v3_request_gate({'requests':[rec(provider='q')]},man)=='generation provider mismatch'
assert m.v3_request_gate({'requests':[rec(provider=None)]},man) is None
link=m.v3_linkage({'requests':[rec(),can]})
assert link=={'requests':2,'completed':1,'identified':1,'cancelledUnidentified':1,'mismatches':0,'providerMissing':0}
cwd=pathlib.Path(${JSON.stringify(root)})
assert m.v3_outside_changes(cwd,['src'])==[]
(cwd/'src'/'new.py').write_text('n')
assert m.v3_outside_changes(cwd,['src'])==[]  # a new file inside the guarded layout is the patch's business
(cwd/'notes.txt').write_text('x')
assert m.v3_outside_changes(cwd,['src'])==['notes.txt']
patch=m.collect_patch_v3(cwd,'HEAD',['src'])
assert b'new.py' in patch and b'notes.txt' not in patch
`;
      const r = spawnSync("python3", ["-B", "-c", code], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the v3 report keeps quality, model and request-linkage coverage separate with unavailable in the denominator", () => {
    const root = fixture();
    try {
      const manifest = { schema: "agent-hub.cooperbench-run/v1", headless: true, upstream: { commit: "63b9d44d9f39a02fccf5bf0052db48a917a011fd" }, arms: ["solo-pi", "solo-qwen", "joint-pi-qwen"], cases: [{ repo: "r", task: 1, features: [1, 2], image_digest: "i@sha256:" + "d".repeat(64), base_commit: "e".repeat(40), archive_sha256: "a".repeat(64), prompt_sha256: ["a".repeat(64), "b".repeat(64)], source_dirs: ["src"] }] };
      const bytes = JSON.stringify(manifest);
      writeFileSync(join(root, "manifest.json"), bytes);
      const arms = manifest.arms;
      writeFileSync(join(root, "cohort.json"), JSON.stringify({ manifest_sha256: sha(bytes), cases: [0], arms, runner_sha256: "r", native_runner_sha256: "n", teardown_sha256: "t" }));
      const linkage = { requests: 3, completed: 2, identified: 2, cancelledUnidentified: 1, mismatches: 0, providerMissing: 0 };
      const patch = join(root, "00-solo-pi.patch"), evaluation = join(root, "00-solo-pi.json");
      writeFileSync(patch, "diff\n");
      writeFileSync(evaluation, "{}\n");
      const rows = [
        { case: 0, arm: "solo-pi", status: "scored", pass: true, input_sha256: sha("diff\n"), patch_path: patch, evaluation_path: evaluation, evaluation_sha256: sha("{}\n"), native_usage: { pi: 100, qwen: null }, request_linkage: linkage, model_identity: { verified: true } },
        { case: 0, arm: "solo-qwen", status: "unavailable", reason: "generation model identity unverified", pass: null, request_linkage: linkage, model_identity: { verified: false } },
        { case: 0, arm: "joint-pi-qwen", status: "missing", pass: null },
      ];
      writeFileSync(join(root, "grade.json"), JSON.stringify({ manifest_sha256: sha(bytes), runner_sha256: "r", native_runner_sha256: "n", teardown_sha256: "t", cohort: [0], controls: {}, rows }));
      const run = spawnSync("python3", [script, "report", "--run", root], { encoding: "utf8" });
      if (run.status !== 0) throw new Error(run.stderr);
      const report = JSON.parse(readFileSync(join(root, "report.json"), "utf8"));
      const solo = report.arms["solo-pi"];
      expect(solo.planned).toBe(1);
      expect(solo.scored).toBe(1);
      expect(solo.both_passed).toBe(1);
      expect(solo.native_usage.pi_tokens).toBe(100);
      expect(solo.model_identity).toEqual({ verified: 1, attempts: 1 });
      expect(solo.request_linkage.completed).toBe(2);
      const qwen = report.arms["solo-qwen"];
      expect(qwen.unavailable).toBe(1); // unavailable stays in the planned denominator
      expect(qwen.scored).toBe(0);
      expect(qwen.model_identity.verified).toBe(0);
      expect(qwen.request_linkage.cancelledUnidentified).toBe(1);
      expect(report.arms["joint-pi-qwen"].request_linkage.attempts).toBe(0); // missing record: no evidence, never imputed
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("v3_participants names the actors that actually started, from the record itself (#152)", () => {
    const code = `import importlib.util
s=importlib.util.spec_from_file_location('r',${JSON.stringify(script)});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
started={'cwd':'/x','requestedModel':'dgx/coding','sessionId':'s1','sandboxProbe':{'checked':True,'result':'denied'}}
constructed={'cwd':'/x','requestedModel':'dgx/coding','sandboxProbe':{'checked':True,'result':'denied'}}  # built, never started: no sessionId
assert m.v3_participants({'kind':'solo-pi','readiness':{'pi':started}})==['pi']
assert m.v3_participants({'kind':'solo-qwen','readiness':{'qwen':started},'usage':{'pi':0,'qwen':42}})==['qwen']  # the initial pi counter is no participation
assert m.v3_participants({'kind':'joint-pi-qwen','readiness':{'pi':started,'qwen':started}})==['pi','qwen']
# Setup failure (elapsedMs 0, no active start): the constructed-but-never-started peer is absent
setup_failed={'kind':'joint-pi-qwen','readiness':{'pi':started,'qwen':constructed},'elapsedMs':0,'usage':{'pi':17,'qwen':None}}
assert m.v3_participants(setup_failed)==['pi']
assert m.v3_participants({'kind':'joint-pi-qwen','readiness':{'pi':constructed,'qwen':constructed},'elapsedMs':0})==[]
assert m.v3_participants({'kind':'solo-qwen','readiness':{}})==[]
assert m.v3_participants({'kind':'solo-pi'})==[]
`;
    const r = spawnSync("python3", ["-B", "-c", code], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
  });

  test("a peer-failure end joins the graded classes; old records without it read unchanged (#160)", () => {
    const code = `import importlib.util
s=importlib.util.spec_from_file_location('r',${JSON.stringify(script)});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
assert 'peer-failure' in m.GRADED_ENDS
# A peer-failed attempt passes the end-class gate to the identity/teardown gates, like a timeout: its preserved
# partial submission is gradeable, and never reads as completed.
failed={'end_reason':'peer-failure','end_reason_detail':'peer-failure','kind':'joint-pi-qwen'}
assert m.unavailable_reason('joint-pi-qwen',failed) is None
assert m.end_story(failed)=='peer-failure'
# A flag beside it still makes the runner's class an infrastructure error (endReasonOf's rule, applied by the driver).
flagged={'end_reason':'infrastructure-error','end_reason_detail':'peer-failure','end_flags':['metadata-modified']}
assert m.unavailable_reason('solo-pi',flagged)=='peer-failure, then metadata-modified'
# Old timeout records carry no peer_failure field and nothing about their reading changes.
old={'end_reason':'timeout','end_reason_detail':'wall-timeout','kind':'solo-pi'}
assert m.unavailable_reason('solo-pi',old) is None
assert m.end_story(old)=='wall-timeout'
# Every other end still refuses by its story.
assert m.unavailable_reason('solo-pi',{'end_reason':'interrupted','end_reason_detail':'interrupted'})=='interrupted'
`;
    const r = spawnSync("python3", ["-B", "-c", code], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
  });

  test("the v3 report counts a native actor's usage only where that actor participated (#152)", () => {
    const root = fixture();
    try {
      const manifest = { schema: "agent-hub.cooperbench-run/v1", headless: true, upstream: { commit: "63b9d44d9f39a02fccf5bf0052db48a917a011fd" }, arms: ["solo-pi", "solo-qwen", "joint-pi-qwen"], cases: [0, 1].map((i) => ({ repo: "r", task: i + 1, features: [1, 2], image_digest: "i@sha256:" + "d".repeat(64), base_commit: "e".repeat(40), archive_sha256: "a".repeat(64), prompt_sha256: ["a".repeat(64), "b".repeat(64)], source_dirs: ["src"] })) };
      const bytes = JSON.stringify(manifest);
      writeFileSync(join(root, "manifest.json"), bytes);
      writeFileSync(join(root, "cohort.json"), JSON.stringify({ manifest_sha256: sha(bytes), cases: [0, 1], arms: manifest.arms, runner_sha256: "r", native_runner_sha256: "n", teardown_sha256: "t" }));
      let n = 0;
      const scored = (caseIndex: number, arm: string, pass: boolean, usage: unknown, participants?: string[]) => {
        const patch = join(root, `p${n}.patch`), evaluation = join(root, `e${n}.json`);
        writeFileSync(patch, `diff${n}\n`); writeFileSync(evaluation, `{"both_passed":${pass}}\n`);
        n++;
        return { case: caseIndex, arm, status: "scored", pass, input_sha256: sha(`diff${n - 1}\n`), patch_path: patch, evaluation_path: evaluation, evaluation_sha256: sha(`{"both_passed":${pass}}\n`), native_usage: usage, ...(participants ? { native_participants: participants } : {}) };
      };
      const rows = [
        scored(0, "solo-pi", true, { pi: 100, qwen: null }, ["pi"]),
        scored(0, "solo-qwen", true, { pi: 0, qwen: 250 }), // historical row (no native_participants): the arm names the actors; the pi default 0 is not an observation (#149)
        scored(0, "joint-pi-qwen", true, { pi: 40, qwen: 70 }, ["pi", "qwen"]),
        scored(1, "solo-pi", false, { pi: 0, qwen: null }, ["pi"]), // a participant's genuinely observed zero stays counted
        scored(1, "solo-qwen", false, { pi: 0, qwen: null }, ["qwen"]), // a participant with a missing native reading stays unknown, not zero
        { case: 1, arm: "joint-pi-qwen", status: "unavailable", reason: "native identity/model/readiness/cleanup gate failed", pass: null, native_participants: ["pi"] }, // setup failure: qwen never started
      ];
      writeFileSync(join(root, "grade.json"), JSON.stringify({ manifest_sha256: sha(bytes), runner_sha256: "r", native_runner_sha256: "n", teardown_sha256: "t", cohort: [0, 1], controls: {}, rows }));
      const run = spawnSync("python3", [script, "report", "--run", root], { encoding: "utf8" });
      if (run.status !== 0) throw new Error(run.stderr);
      const report = JSON.parse(readFileSync(join(root, "report.json"), "utf8"));
      const soloPi = report.arms["solo-pi"].native_usage;
      expect(soloPi.pi_tokens_known).toBe(2);
      expect(soloPi.pi_tokens).toBe(100); // 100 plus the observed zero
      expect(soloPi.pi_participating).toBe(2);
      expect(soloPi.qwen_session_tokens_known).toBe(0); // solo-pi has no Qwen: not-applicable, never a measured zero
      expect(soloPi.qwen_session_tokens).toBeNull();
      expect(soloPi.qwen_participating).toBe(0);
      const soloQwen = report.arms["solo-qwen"].native_usage;
      expect(soloQwen.pi_tokens_known).toBe(0); // the defect: the initial Pi counter of 0 was counted as an observation
      expect(soloQwen.pi_tokens).toBeNull();
      expect(soloQwen.pi_participating).toBe(0);
      expect(soloQwen.qwen_session_tokens_known).toBe(1); // the missing reading is unknown, not zero
      expect(soloQwen.qwen_session_tokens).toBe(250);
      expect(soloQwen.qwen_participating).toBe(2);
      const joint = report.arms["joint-pi-qwen"].native_usage;
      expect(joint.pi_tokens_known).toBe(1);
      expect(joint.pi_tokens).toBe(40);
      expect(joint.pi_participating).toBe(2); // the setup-failed attempt still names Pi as a participant, with no usage attached
      expect(joint.qwen_session_tokens_known).toBe(1);
      expect(joint.qwen_session_tokens).toBe(70);
      expect(joint.qwen_participating).toBe(1); // the peer that never started counts as absent
      expect(report.arms["solo-pi"].both_passed).toBe(1); // pass/fail outcomes unchanged
      expect(report.arms["joint-pi-qwen"].unavailable).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
