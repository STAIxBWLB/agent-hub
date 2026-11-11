import { describe, expect, test } from "bun:test";
import { EscalationControl } from "../src/models/route/escalation-control.ts";
import type { EscalationReply } from "../src/models/route/judge-replies.ts";

const positive = (category: EscalationReply["category"] = "repetition"): EscalationReply => ({ escalate: true, category, newEvidence: true, reason: "synthetic distinct observations" });

describe("owned whether-to escalation", () => {
  test("requires two fresh same-category replies and remains latched", () => {
    const control = new EscalationControl();
    expect(control.apply(positive()).latched).toBe(false);
    expect(control.apply(positive()).latched).toBe(true);
    expect(control.apply({ ...positive(), escalate: false }).latched).toBe(true);
    const external = control.snapshot(); external.streak = 0;
    expect(control.snapshot().streak).toBe(2);
  });

  test("explicitly old evidence breaks confirmation while unavailable replies preserve it", () => {
    const old = new EscalationControl();
    expect(old.apply(positive()).latched).toBe(false);
    expect(old.apply({ ...positive(), newEvidence: false }).latched).toBe(false);
    expect(old.apply(positive()).latched).toBe(false);
    const unavailable = new EscalationControl();
    expect(unavailable.apply(positive()).latched).toBe(false);
    expect(unavailable.apply(undefined).latched).toBe(false);
    expect(unavailable.apply(positive()).latched).toBe(true);
  });

  test("category change restarts confirmation and none cannot escalate", () => {
    const control = new EscalationControl();
    control.apply(positive());
    expect(control.apply(positive("drift"))).toEqual({ latched: false, streak: 1, category: "drift" });
    expect(control.apply(positive("drift")).latched).toBe(true);
    expect(new EscalationControl().apply(positive("none"))).toEqual({ latched: false, streak: 0 });
  });

  test("configured confirmations retain the published positive integer range", () => {
    expect(new EscalationControl().apply(positive(), 1).latched).toBe(true);
    expect(() => new EscalationControl().apply(positive(), 0)).toThrow();
    expect(() => new EscalationControl().apply(positive(), 200_001)).toThrow();
  });
});
