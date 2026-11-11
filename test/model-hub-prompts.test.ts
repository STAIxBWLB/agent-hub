import { describe, expect, test } from "bun:test";
import { captureJudgeConversation } from "../src/models/route/conversation-view.ts";
import { buildAdvisorRequest, buildEscalationRequest, planningInstruction, redoFeedback } from "../src/models/route/hub-prompts.ts";

describe("new host judge request wording and preserved transcript envelope", () => {
  test("an exact-cap transcript stays unchanged without a marker", () => {
    const conversation = captureJudgeConversation([{ role: "assistant", content: "a".repeat(300) }]);
    const cap = Array.from(conversation!.transcript).length;
    const request = buildAdvisorRequest(conversation, undefined, cap);
    expect(request?.messages[0]?.content).toBe(`Work record:\n${conversation!.transcript}`);
    expect(request?.discardedChars).toBe(0);
    expect(buildAdvisorRequest(conversation, undefined, cap + 1)?.messages[0]?.content).toBe(request?.messages[0]?.content);
    expect(buildAdvisorRequest(conversation, undefined, cap - 1)?.messages[0]?.content).toContain("...<middle of the conversation truncated>...");
  });

  test("preserves the explicit codepoint middle-drop marker/rounding before latest suffix", () => {
    const conversation = captureJudgeConversation([{ role: "assistant", content: "😀".repeat(400) }]);
    expect(conversation).toBeDefined();
    const request = buildAdvisorRequest(conversation, "LATEST-FIXTURE", 257);
    const points = Array.from(conversation!.transcript);
    const expected = points.slice(0, 64).join("") + "\n...<middle of the conversation truncated>...\n" + points.slice(-193).join("");
    expect(request?.messages[0]?.content).toBe(`Work record:\n${expected}\n\nLatest executor turn:\nLATEST-FIXTURE`);
    expect(request?.discardedChars).toBe(points.length - 257);
    expect(request?.maxOutputTokens).toBe(2048);
  });

  test("does not add a suffix when omitted or byte-truncate an explicit latest turn", () => {
    const conversation = captureJudgeConversation([{ role: "assistant", content: "small fixture" }]);
    expect(buildAdvisorRequest(conversation)?.messages[0]?.content).toBe(`Work record:\n${conversation?.transcript}`);
    const latest = "😀".repeat(200_000);
    expect(buildAdvisorRequest(conversation, latest)?.messages[0]?.content?.endsWith(latest)).toBe(true);
  });

  test("uses the default 200000-point cap without counting its marker against it", () => {
    const conversation = captureJudgeConversation([{ role: "assistant", content: "😀".repeat(200_000) }]);
    const request = buildAdvisorRequest(conversation);
    expect(request?.discardedChars).toBe(Array.from(conversation!.transcript).length - 200_000);
    expect(request?.messages[0]?.content?.includes("...<middle of the conversation truncated>...")).toBe(true);
    expect(buildAdvisorRequest(conversation, undefined, 255)).toBeUndefined();
    expect(buildAdvisorRequest(conversation, undefined, 200_001)).toBeUndefined();
  });

  test("escalation bounds each serialized message and truthfully counts omitted source points", () => {
    const conversation = captureJudgeConversation([{ role: "assistant", content: "x".repeat(250_000) }]);
    const request = buildEscalationRequest(conversation, 1);
    const transcript = request!.messages[0]!.content!.split("Work record:\n")[1]!;
    const marker = "\n...<middle of the conversation truncated>...\n";
    expect(Array.from(transcript)).toHaveLength(1502);
    expect(transcript).toContain(marker);
    expect(request?.maxOutputTokens).toBe(256);
    expect(request?.discardedChars).toBe(Array.from(conversation!.transcript).length - (Array.from(transcript).length - Array.from(marker).length));
    expect(buildEscalationRequest(undefined, 1)).toBeUndefined();
    expect(buildEscalationRequest(conversation, Number.NaN)).toBeUndefined();
  });

  test("escalation retains twelve assistant turns, following tools and the closest user within the whole cap", () => {
    const rows: unknown[] = [{ role: "system", content: "SYSTEM_POLICY" }, { role: "developer", content: "DEVELOPER_POLICY" },
      { role: "user", content: "OLD_TASK" }];
    for (let index = 0; index < 24; index++) {
      if (index === 12) rows.push({ role: "user", content: "CURRENT_TASK" });
      rows.push({ role: "assistant", content: `TURN_${index}_END`, tool_calls: [{ id: `call-${index}`, type: "function",
        function: { name: "execute", arguments: "{}" } }] },
      { role: "tool", tool_call_id: `call-${index}`, content: `RESULT_${index}_START ` + "😀".repeat(2000) + ` RESULT_${index}_END` });
    }
    const conversation = captureJudgeConversation(rows)!, request = buildEscalationRequest(conversation, 24)!;
    const transcript = request.messages[0]!.content!.split("Work record:\n")[1]!;
    expect(Array.from(transcript).length).toBeLessThanOrEqual(16000);
    expect(transcript).toContain("SYSTEM_POLICY"); expect(transcript).toContain("DEVELOPER_POLICY"); expect(transcript).toContain("CURRENT_TASK");
    expect(transcript).not.toContain("OLD_TASK"); expect(transcript).not.toContain("TURN_11_END");
    expect(transcript).toContain("TURN_23_END"); expect(transcript).toContain("RESULT_23_END");
    expect(request.discardedChars).toBeGreaterThanOrEqual(Array.from(conversation.transcript).length - 16000);
    expect(request.discardedChars).toBeLessThanOrEqual(Array.from(conversation.transcript).length);
    expect(request.maxOutputTokens).toBe(256);
  });

  test("new prompts keep semantic verdicts/feedback in the host", () => {
    const conversation = captureJudgeConversation([{ role: "assistant", content: "fixture" }]);
    expect(buildAdvisorRequest(conversation)?.systemPrompt).toContain("APPROVE");
    expect(buildAdvisorRequest(conversation)?.systemPrompt).toContain("REDO:");
    expect(buildEscalationRequest(conversation, 1)?.systemPrompt).toContain("new_evidence");
    expect(planningInstruction).toContain("before changing files");
    const feedback = redoFeedback({ kind: "redo", feedback: "check the fixture" }, "held answer");
    expect(feedback.user).toContain("senior reviewer");
    expect(feedback.user).toContain("check the fixture");
    expect(feedback.user).toContain("held answer");
  });
});
