import { describe, expect, test } from "bun:test";
import { parseAdvisorReply, parseEscalationReply, type EscalationReply } from "../src/models/route/judge-replies.ts";

describe("owned host judge replies", () => {
  test("requires an anchored advisor word, with case-insensitive affirmative replies", () => {
    expect(parseAdvisorReply("APPROVE")).toEqual({ kind: "approve" });
    expect(parseAdvisorReply("  approve\n")).toEqual({ kind: "approve" });
    expect(parseAdvisorReply("> **Verdict:** REDO: inspect the synthetic result")).toEqual({ kind: "redo", feedback: "inspect the synthetic result" });
    expect(parseAdvisorReply("### `Verdict: REDO` : add the missing test")).toEqual({ kind: "redo", feedback: "add the missing test" });
    expect(parseAdvisorReply("- **REDO**: correct the claim")).toEqual({ kind: "redo", feedback: "correct the claim" });
    expect(parseAdvisorReply("> **Verdict: REDO**: keep the host boundary")).toEqual({ kind: "redo", feedback: "keep the host boundary" });
    expect(parseAdvisorReply("__Verdict:__ __APPROVE__")).toEqual({ kind: "approve" });
    expect(parseAdvisorReply('"APPROVE"')).toEqual({ kind: "approve" });
    expect(parseAdvisorReply("'REDO': add a check")).toEqual({ kind: "redo", feedback: "add a check" });
    expect(parseAdvisorReply("fixture note: APPROVE")).toBeUndefined();
    expect(parseAdvisorReply("> Reviewer says: REDO: do more work")).toBeUndefined();
    expect(parseAdvisorReply("**REDO: missing closing decoration")).toBeUndefined();
    expect(parseAdvisorReply("```text\nREDO: not an advisor verdict\n```")).toBeUndefined();
    expect(parseAdvisorReply("APPROVED")).toBeUndefined();
    expect(parseAdvisorReply("REDONE")).toBeUndefined();
    expect(parseAdvisorReply("REDO: inspect the synthetic result")).toEqual({ kind: "redo", feedback: "inspect the synthetic result" });
  });

  test("oversized input is unavailable before any verdict can be accepted", () => {
    expect(parseAdvisorReply("APPROVE " + "a".repeat(65_536))).toBeUndefined();
    expect(parseAdvisorReply("APPROVE " + "한".repeat(22_000))).toBeUndefined();
    expect(parseEscalationReply(" ".repeat(65_537))).toBeUndefined();
  });

  test("local redo feedback is bounded without splitting a UTF-8 character", () => {
    const result = parseAdvisorReply("REDO: " + "한".repeat(2000));
    expect(result?.kind).toBe("redo");
    if (result?.kind !== "redo") throw new Error("missing owned feedback");
    expect(Buffer.byteLength(result.feedback, "utf8")).toBe(4095);
    expect(result.feedback).toBe("한".repeat(1365));
  });

  test("accepts documented escalation fields from raw JSON or one surrounding JSON fence", () => {
    const value = { escalate: true, category: "repetition" as const, new_evidence: true, reason: "synthetic distinct observations" };
    const expected: EscalationReply = { escalate: true, category: "repetition", newEvidence: true, reason: value.reason };
    expect(parseEscalationReply(JSON.stringify(value))).toEqual(expected);
    expect(parseEscalationReply("```json\n" + JSON.stringify(value) + "\n``` ")).toEqual(expected);
    expect(parseEscalationReply("\n```\r\n" + JSON.stringify(value) + "\r\n```\n")).toEqual(expected);
    expect(parseEscalationReply("``` JSON \n" + JSON.stringify(value) + "\n```")).toEqual(expected);
    expect(parseEscalationReply(JSON.stringify({ ...value, confidence: 1 }))).toEqual(expected);
  });

  test("escalation JSON fences reject commentary, multiple objects and malformed consumed fields", () => {
    const value = { escalate: true, category: "repetition" as const, new_evidence: true, reason: "synthetic distinct observations" };
    expect(parseEscalationReply(JSON.stringify({ ...value, category: "unsupported_fixture" }))).toBeUndefined();
    expect(parseEscalationReply(JSON.stringify({ ...value, new_evidence: "true" }))).toBeUndefined();
    expect(parseEscalationReply(JSON.stringify({ ...value, reason: null }))).toBeUndefined();
    expect(parseEscalationReply("Before the verdict:\n```json\n" + JSON.stringify(value) + "\n```" )).toBeUndefined();
    expect(parseEscalationReply("```json\n" + JSON.stringify(value) + "\n```\nThe verdict is final.")).toBeUndefined();
    expect(parseEscalationReply("```json\n" + JSON.stringify(value) + "\n" + JSON.stringify(value) + "\n```" )).toBeUndefined();
    expect(parseEscalationReply("```typescript\n" + JSON.stringify(value) + "\n```" )).toBeUndefined();
    expect(parseEscalationReply("[]")).toBeUndefined();
    expect(parseEscalationReply("null")).toBeUndefined();
  });

  test("negative escalation remains a negative reply, never model-selection authority", () => {
    expect(parseEscalationReply('{"escalate":false,"category":"none","new_evidence":false,"reason":"insufficient evidence"}'))
      .toEqual({ escalate: false, category: "none", newEvidence: false, reason: "insufficient evidence" });
  });
});
