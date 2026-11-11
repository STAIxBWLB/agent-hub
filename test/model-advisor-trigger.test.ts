import { describe, expect, test } from "bun:test";
import { AdvisorTrigger } from "../src/models/route/advisor-trigger.ts";
import { captureJudgeConversation } from "../src/models/route/conversation-view.ts";

const record = captureJudgeConversation([{ role: "assistant", content: "first" }, { role: "assistant", content: "second" }]);
const active = { hasToolUse: true, visibleText: "working" };
const final = { hasToolUse: false, visibleText: "finished" };

describe("owned advisor review policy", () => {
  test("omitted minimum permits zero results and successful budget defaults to one", () => {
    const gate = new AdvisorTrigger();
    expect(gate.eligible(record, final, "scope")).toBe(true);
    expect(gate.reserve("scope")).toBe(true);
    gate.settle("scope", "success");
    expect(gate.eligible(record, final, "scope")).toBe(false);
    expect(new AdvisorTrigger({ gateMinToolResults: 1 }).eligible(record, final)).toBe(false);
    expect(gate.eligible(undefined, final, "other")).toBe(false);
  });

  test("stall is disabled by default and one checkpoint does not rearm on later turns", () => {
    expect(new AdvisorTrigger().eligible(record, active)).toBe(false);
    const gate = new AdvisorTrigger({ gateStallTurns: 2, maxReviews: 3 });
    expect(gate.eligible(record, active, "scope")).toBe(true);
    expect(gate.reserve("scope")).toBe(true);
    gate.settle("scope", "success");
    expect(gate.eligible(record, active, "scope")).toBe(false);
    const later = captureJudgeConversation(Array.from({ length: 20 }, () => ({ role: "assistant", content: "later" })));
    expect(gate.eligible(later, active, "scope")).toBe(false);
  });

  test("primary firing does not consume the optional stall checkpoint", () => {
    const gate = new AdvisorTrigger({ gateStallTurns: 2, maxReviews: 3 });
    expect(gate.eligible(record, final, "scope")).toBe(true);
    expect(gate.eligible(record, active, "scope")).toBe(true);
    expect(gate.eligible(record, active, "scope")).toBe(false);
  });

  test("pending reservations are charged; failures refund and stop after three", () => {
    const pending = new AdvisorTrigger({ maxReviews: 2 });
    expect(pending.reserve("scope")).toBe(true);
    expect(pending.reserve("scope")).toBe(true);
    expect(pending.reserve("scope")).toBe(false);
    const gate = new AdvisorTrigger({ gateStallTurns: 2, maxReviews: 3 });
    for (let count = 0; count < 3; count++) {
      expect(gate.eligible(record, active, "scope")).toBe(true);
      expect(gate.reserve("scope")).toBe(true);
      gate.settle("scope", "failure");
    }
    expect(gate.eligible(record, final, "scope")).toBe(false);
    expect(gate.reserve("scope")).toBe(false);
  });

  test("automatic ledger eviction retains a stall marker, explicit eviction clears it", () => {
    const gate = new AdvisorTrigger({ gateStallTurns: 2, maxReviews: 3 });
    expect(gate.eligible(record, active, "checkpoint")).toBe(true);
    gate.reserve("checkpoint"); gate.settle("checkpoint", "success");
    for (let index = 0; index < 1024; index++) gate.reserve(`ledger-${index}`);
    expect(gate.eligible(record, active, "checkpoint")).toBe(false);
    gate.evict("checkpoint");
    expect(gate.eligible(record, active, "checkpoint")).toBe(true);
  });

  test("stalled FIFO is independent and instance budget is never evicted", () => {
    const gate = new AdvisorTrigger({ gateStallTurns: 2 });
    expect(gate.reserve("instance")).toBe(true);
    for (let index = 0; index < 1025; index++) {
      gate.reserve(`ledger-${index}`);
      gate.eligible(record, active, `checkpoint-${index}`);
    }
    expect(gate.reserve("instance")).toBe(false);
    gate.evict("instance");
    expect(gate.reserve("instance")).toBe(false);
    expect(gate.eligible(record, active, "checkpoint-0")).toBe(true);
  });

  test("a full stall ledger is unchanged by an unrelated reservation", () => {
    const gate = new AdvisorTrigger({ gateStallTurns: 2 });
    for (let index = 0; index < 1024; index++) expect(gate.eligible(record, active, `stall-${index}`)).toBe(true);
    expect(gate.reserve("unrelated")).toBe(true);
    expect(gate.eligible(record, active, "stall-0")).toBe(false);
    expect(gate.eligible(record, active, "stall-1023")).toBe(false);
  });

  test("inserting a stall checkpoint cannot erase a full charged budget ledger", () => {
    const gate = new AdvisorTrigger({ gateStallTurns: 2 });
    for (let index = 0; index < 1024; index++) {
      expect(gate.reserve(`budget-${index}`)).toBe(true);
      gate.settle(`budget-${index}`, "success");
    }
    expect(gate.eligible(record, active, "new-stall")).toBe(true);
    expect(gate.reserve("budget-0")).toBe(false);
    expect(gate.eligible(record, final, "budget-0")).toBe(false);
  });

  test("same-key reservation and failure updates do not evict another budget", () => {
    const gate = new AdvisorTrigger({ maxReviews: 2 });
    for (let index = 0; index < 1024; index++) expect(gate.reserve(`budget-${index}`)).toBe(true);
    expect(gate.reserve("budget-1")).toBe(true);
    gate.settle("budget-2", "failure");
    expect(gate.reserve("budget-0")).toBe(true);
    expect(gate.reserve("budget-0")).toBe(false);
    expect(gate.reserve("budget-1")).toBe(false);
  });

  test("pattern is an independent primary trigger and invalid gates refuse", () => {
    const gate = new AdvisorTrigger({ trigger: "pattern", pattern: "^CHECK$" });
    expect(gate.eligible(record, { hasToolUse: true, visibleText: "CHECK" })).toBe(true);
    expect(gate.eligible(record, final)).toBe(false);
    expect(() => new AdvisorTrigger({ trigger: "pattern" })).toThrow();
    expect(() => new AdvisorTrigger({ gateStallTurns: 200_001 })).toThrow();
    expect(() => new AdvisorTrigger({ maxReviews: 0 })).toThrow();
  });
});
