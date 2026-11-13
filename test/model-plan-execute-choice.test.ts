import { describe, expect, test } from "bun:test";
import { captureRouteView } from "../src/models/route/conversation-view.ts";
import { PlanPhase } from "../src/models/route/plan-execute-choice.ts";

const mutation = (content = "fixture saved", error = false) => [
  { role: "assistant", content: null, tool_calls: [{ id: "mutation", function: { name: "write_file", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "mutation", content, is_error: error },
];

describe("owned plan/execute fallback", () => {
  test("plans capable until a complete successful mutation and latches only its scope", () => {
    const phase = new PlanPhase({ now: () => 0 });
    expect(phase.observe(undefined, "one")).toEqual({ phase: "planning", fallbackTier: "capable", addPlanningInstruction: true });
    expect(phase.observe(captureRouteView(mutation()), "one")).toEqual({ phase: "executing", fallbackTier: "efficient", addPlanningInstruction: false });
    expect(phase.observe(undefined, "one").phase).toBe("executing");
    expect(phase.observe(undefined, "two").phase).toBe("planning");
  });

  test("complete current mutation qualifies with clipped old history", () => {
    const messages = [...Array.from({ length: 70 }, () => ({ role: "assistant", content: "old fixture" })), ...mutation()];
    const view = captureRouteView(messages);
    expect(view?.stageInput.incomplete).toBe(true);
    expect(new PlanPhase().observe(view, "scope").phase).toBe("executing");
  });

  test("clipped current mutation cannot establish execution", () => {
    const view = captureRouteView(mutation("x".repeat(65_537)));
    expect(view?.stageInput.incomplete).toBe(true);
    expect(new PlanPhase().observe(view, "scope").phase).toBe("planning");
  });

  test("failed and denied mutation results do not attest success", () => {
    for (const [text, error] of [["fixture failed", true], ["Error: fixture failure", false], ["Permission denied", false], ["Operation not permitted", false], ["Request refused", false], ["Action cancelled", false]] as const) {
      expect(new PlanPhase().observe(captureRouteView(mutation(text, error)), "scope").phase).toBe("planning");
    }
  });

  test("orphaned or duplicate results and an incomplete no-mutation view keep planning", () => {
    expect(new PlanPhase().observe(captureRouteView([{ role: "tool", tool_call_id: "missing", content: "saved" }]), "scope").phase).toBe("planning");
    const repeated = mutation(); repeated.push({ role: "tool", tool_call_id: "mutation", content: "saved", is_error: false });
    expect(new PlanPhase().observe(captureRouteView(repeated), "scope").phase).toBe("planning");
    const old = Array.from({ length: 70 }, () => ({ role: "assistant", content: "old" }));
    expect(new PlanPhase().observe(captureRouteView(old), "scope").phase).toBe("planning");
  });
});
