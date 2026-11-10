import { expect, test } from "bun:test";
import fixtures from "./fixtures/model-route-public-api-scalars-v1.json";
import { parseAdvisorReply, parseEscalationReply } from "../src/models/route/judge-replies.ts";
import { EscalationControl } from "../src/models/route/escalation-control.ts";
import { AdvisorTrigger } from "../src/models/route/advisor-trigger.ts";
import { captureJudgeConversation } from "../src/models/route/conversation-view.ts";
import { buildAdvisorRequest, buildEscalationRequest } from "../src/models/route/hub-prompts.ts";

function conversation(rounds = 1, answer = "Synthetic answer") {
  const messages: unknown[] = [{ role: "user", content: "Synthetic isolated fixture" }];
  for (let at = 0; at < rounds; at++) {
    const id = `fixture-${at}`;
    messages.push({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "bash", arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: id, content: "fixture completed" });
  }
  messages.push({ role: "assistant", content: answer });
  return captureJudgeConversation(messages);
}

function assertScalars(actual: readonly (boolean | number | undefined)[], expected: readonly (boolean | number)[]): void {
  expect(actual).toEqual(expected);
}

// Newly authored inputs and scalar observations only. No legacy implementation is imported.
for (const row of fixtures.cases) {
  if (row.kind === "advisor-eligible") test(`public scalar compatibility: ${row.id}`, () => {
    const gate = new AdvisorTrigger(row.config);
    const result = gate.eligible(conversation(row.rounds), { hasToolUse: false, visibleText: "Synthetic answer" }, "fixture");
    assertScalars([result], row.observed);
  });
  if (row.kind === "advisor-reserve") test(`public scalar compatibility: ${row.id}`, () => {
    const gate = new AdvisorTrigger(row.config), actual: boolean[] = [];
    if (row.outcome !== "success" && row.outcome !== "failure") throw new Error("invalid owned fixture outcome");
    for (let at = 0; at < 3; at++) {
      const answer = `Synthetic answer ${at}`;
      const eligible = gate.eligible(conversation(1, answer), { hasToolUse: false, visibleText: answer }, "fixture");
      const reserved = eligible && gate.reserve("fixture");
      actual.push(eligible, reserved);
      if (reserved) gate.settle("fixture", row.outcome);
    }
    assertScalars(actual, row.observed);
  });
  if (row.kind === "advisor-output") test(`public scalar compatibility: ${row.id}`, () => {
    assertScalars([buildAdvisorRequest(conversation(), "Synthetic answer", row.cap)?.maxOutputTokens], row.observed);
  });
  if (row.kind === "escalation-output") test(`public scalar compatibility: ${row.id}`, () => {
    assertScalars([buildEscalationRequest(conversation(), 2)?.maxOutputTokens], row.observed);
  });
  if (row.kind === "advisor-reply") test(`public scalar compatibility: ${row.id}`, () => {
    const result = parseAdvisorReply(row.text);
    assertScalars([result !== undefined, result?.kind === "approve", result?.kind === "redo"], row.observed);
  });
  if (row.kind === "escalation-reply") test(`public scalar compatibility: ${row.id}`, () => {
    const result = parseEscalationReply(row.text);
    assertScalars([result !== undefined, result?.escalate === true, result?.newEvidence === true], row.observed);
  });
  if (row.kind === "escalation-state") test(`public scalar compatibility: ${row.id}`, () => {
    const control = new EscalationControl();
    const actual = (row.sequence ?? []).map(input => {
      const result = input === "missing" ? undefined : parseEscalationReply(JSON.stringify({
        escalate: true, category: input === "different" ? "drift" : "repetition",
        new_evidence: input !== "old", reason: "synthetic distinct observations",
      }));
      return control.apply(result, 2).latched;
    });
    assertScalars(actual, row.observed);
  });
}
