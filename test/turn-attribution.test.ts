import { expect, test } from "bun:test";
import { HUB, newEnvelope } from "../src/hub/envelope.ts";
import { applyTurnAttribution, turnAttribution } from "../src/hub/turn-attribution.ts";

test("turn hints are bounded, host-selected and removed from inherited configuration", () => {
  const offer = newEnvelope(HUB, "title never belongs in env", { kind: "task", refs: { task: "12", taskOffer: 1 } });
  const forged = { AGENTHUB_TASK_ID: "secret", AGENTHUB_ATTEMPT_ID: "forged", AGENTHUB_TRIGGER: "forged", SAFE: "yes" };
  expect(applyTurnAttribution(forged, turnAttribution([offer], { task: 12, scheduled: () => false }))).toEqual({ SAFE: "yes", AGENTHUB_TASK_ID: "12", AGENTHUB_TRIGGER: "assign" });
  expect(applyTurnAttribution(forged, turnAttribution([offer], { task: 12, scheduled: () => true }))).toEqual({ SAFE: "yes", AGENTHUB_TASK_ID: "12", AGENTHUB_TRIGGER: "schedule" });
  expect(applyTurnAttribution(forged, turnAttribution([offer], { task: 12, scheduled: () => undefined }))).toEqual({ SAFE: "yes", AGENTHUB_TASK_ID: "12" });
  expect(applyTurnAttribution(forged, turnAttribution([offer]))).toEqual({ SAFE: "yes" });
  expect(applyTurnAttribution(forged, { task: 12, attempt: "ra-0123456789ab", trigger: "review", private: true, cloud: true })).toEqual({ SAFE: "yes", AGENTHUB_TRIGGER: "review" });
  expect(applyTurnAttribution(forged, { task: 12, attempt: "ra-0123456789ab", trigger: "review" })).toEqual({ SAFE: "yes", AGENTHUB_TASK_ID: "12", AGENTHUB_ATTEMPT_ID: "ra-0123456789ab", AGENTHUB_TRIGGER: "review" });
  expect(applyTurnAttribution(forged, { attempt: "ra-0123456789ab" })).toEqual({ SAFE: "yes" });
  expect(applyTurnAttribution(forged, { attempt: "delivery-id" })).toEqual({ SAFE: "yes" });
  const other = newEnvelope(HUB, "other", { kind: "task", refs: { task: "13", taskOffer: 2 } });
  expect(turnAttribution([offer, other], { scheduled: () => false }).task).toBeUndefined();
  expect(turnAttribution([offer], { task: 12, scheduled: () => { throw new Error("unavailable"); } }).trigger).toBeUndefined();
  const malformed = newEnvelope(HUB, "invalid", { kind: "task", refs: { task: "0", taskOffer: 1 } });
  expect(turnAttribution([offer, malformed], { task: 12, scheduled: () => false }).task).toBeUndefined();
  const privateTask = newEnvelope("user", "private", { kind: "task", private: true, refs: { task: "12" } });
  expect(applyTurnAttribution(forged, turnAttribution([privateTask], { task: 12, cloud: true }))).toEqual({ SAFE: "yes", AGENTHUB_TRIGGER: "manual" });
  expect(turnAttribution([offer, newEnvelope("user", "mixed")], { task: 12 }).trigger).toBeUndefined();
  expect(turnAttribution([newEnvelope("user", "hello")]).trigger).toBe("manual");
  expect(turnAttribution([newEnvelope("peer", "hello")]).trigger).toBe("message");
});
