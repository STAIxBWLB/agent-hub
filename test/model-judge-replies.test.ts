import { describe, expect, test } from "bun:test";
import { parseAdvisorReply, parseEscalationReply } from "../src/models/route/judge-replies.ts";

describe("owned host judge replies", () => {
  test("requires an anchored advisor word, with case-insensitive affirmative replies", () => {
    expect(parseAdvisorReply("APPROVE")).toEqual({ kind: "approve" });
    expect(parseAdvisorReply("  approve\n")).toEqual({ kind: "approve" });
    expect(parseAdvisorReply("fixture note: APPROVE")).toBeUndefined();
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

  test("accepts the documented escalation fields and closed category only", () => {
    const value = { escalate: true, category: "repetition", new_evidence: true, reason: "synthetic distinct observations" };
    expect(parseEscalationReply(JSON.stringify(value))).toEqual({ escalate: true, category: "repetition", newEvidence: true, reason: value.reason });
    expect(parseEscalationReply(JSON.stringify({ ...value, category: "unsupported_fixture" }))).toBeUndefined();
    expect(parseEscalationReply(JSON.stringify({ ...value, new_evidence: "true" }))).toBeUndefined();
    expect(parseEscalationReply(JSON.stringify({ ...value, reason: null }))).toBeUndefined();
    expect(parseEscalationReply("```json\n" + JSON.stringify(value) + "\n```" )).toBeUndefined();
    expect(parseEscalationReply("[]")).toBeUndefined();
    expect(parseEscalationReply("null")).toBeUndefined();
  });

  test("negative escalation remains a negative reply, never model-selection authority", () => {
    expect(parseEscalationReply('{"escalate":false,"category":"none","new_evidence":false,"reason":"insufficient evidence"}'))
      .toEqual({ escalate: false, category: "none", newEvidence: false, reason: "insufficient evidence" });
  });
});
