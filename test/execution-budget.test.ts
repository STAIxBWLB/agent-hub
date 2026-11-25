import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionBudget } from "../src/hub/execution-budget.ts";
import { renderExecutionBudgetStatus } from "../src/cli/output.ts";

const dirs: string[] = [];
function open() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-execution-budget-")); dirs.push(dir);
  return { dir, meter: new ExecutionBudget(join(dir, "hub.db")) };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("shared execution budgets", () => {
  test("task meters persist across meter instances and turns", () => {
    const { dir, meter } = open();
    meter.configure({ id: "task:7", kind: "task", taskId: 7, peers: ["pi", "local"], limits: { model_calls: 2, tool_calls: 3 } });
    expect(meter.admitTask(7, "pi", "model_calls")[0]?.used).toBe(1);
    meter.close();
    const resumed = new ExecutionBudget(join(dir, "hub.db"));
    expect(resumed.admitTask(7, "local", "model_calls")[0]?.used).toBe(2);
    expect(resumed.admitTask(7, "pi", "model_calls")[0]).toMatchObject({ allowed: false, used: 2, limit: 2, remaining: 0, reason: "exhausted" });
    expect(resumed.status("task:7")).toMatchObject({ used: { model_calls: 2 }, units: { model_calls: { used: 2, limit: 2, remaining: 0, reason: "exhausted" } } });
    resumed.close();
  });

  test("#199 applies reads which scopes meter a peer's tasks without admitting or counting anything", () => {
    const { meter } = open();
    expect(meter.applies([3], "pi")).toBe(false);
    meter.configure({ id: "task:3", kind: "task", taskId: 3, peers: ["pi"], limits: { model_calls: 1 } });
    expect(meter.applies([3], "pi")).toBe(true);
    expect(meter.applies([4], "pi")).toBe(false);
    expect(meter.applies([3], "local")).toBe(false);
    meter.configure({ id: "run:r", kind: "run", peers: ["local"], limits: { elapsed_ms: 1000 } });
    expect(meter.applies([], "local")).toBe(true);
    expect(meter.status("task:3")).toMatchObject({ used: {} });
    expect(meter.admitTask(3, "pi", "model_calls")[0]).toMatchObject({ allowed: true, used: 1 });
    meter.close();
  });

  test("task and run scopes admit atomically and ignore unrelated peers", () => {
    const { meter } = open();
    meter.configure({ id: "task:2", kind: "task", taskId: 2, peers: ["pi"], limits: { tool_calls: 1 } });
    meter.configure({ id: "run:r1", kind: "run", peers: ["pi", "local"], limits: { tool_calls: 0 } });
    expect(meter.admitTask(2, "pi", "tool_calls").some((d) => !d.allowed)).toBe(true);
    expect(meter.status("task:2")).toMatchObject({ used: {} });
    expect(meter.admitTask(999, "other", "tool_calls")).toEqual([]);
    expect(meter.admitTask(999, "local", "tool_calls")[0]).toMatchObject({ allowed: false, scope: "run:r1", reason: "exhausted" });
    meter.close();
  });

  test("token caps report unknown usage instead of assuming zero", () => {
    const { meter } = open();
    meter.configure({ id: "task:3", kind: "task", taskId: 3, peers: ["pi"], limits: { tokens: 1000 } });
    expect(meter.admitTask(3, "pi", "tokens")[0]).toMatchObject({ allowed: false, used: 0, limit: 1000, reason: "unknown_usage" });
    meter.close();
  });

  test("#1513 AC3 an override reason is kept with its actor and time, and a configure without one still works", () => {
    const { meter } = open();
    const first = meter.configure({ id: "run:raised", kind: "run", peers: ["pi"], limits: { model_calls: 2 } }, { reason: "raised for the release run", by: "person" });
    expect(first.override).toMatchObject({ reason: "raised for the release run", by: "person" });
    expect(typeof first.override?.at).toBe("number");
    // `ahub budget execution status` shows the last override, its actor and its time, as operations.md says it does.
    const shown = JSON.stringify(renderExecutionBudgetStatus([first], 200, first.override!.at));
    expect(shown).toContain("override reason");
    expect(shown).toContain("raised for the release run");
    expect(shown).toContain("override by");
    expect(shown).toContain("person");
    expect(shown).toContain("override at");
    // A later configure without a reason keeps the reasoned override: the row answers why the limit is what it is.
    const second = meter.configure({ id: "run:raised", kind: "run", peers: ["pi"], limits: { model_calls: 4 } });
    expect(second.limits.model_calls).toBe(4);
    expect(second.override).toMatchObject({ reason: "raised for the release run", by: "person" });
    // A second reason replaces the first, and the bound is enforced rather than stored.
    expect(meter.configure({ id: "run:raised", kind: "run", peers: ["pi"], limits: { model_calls: 5 } }, { reason: "second raise" }).override?.reason).toBe("second raise");
    expect(() => meter.configure({ id: "run:raised", kind: "run", peers: ["pi"], limits: { model_calls: 6 } }, { reason: "x".repeat(281) })).toThrow("at most 280");
    meter.close();
  });

  test("elapsed limits gate the next admission and model calls with token caps fail closed", () => {
    const { meter } = open();
    meter.configure({ id: "run:timed", kind: "run", peers: ["local"], limits: { elapsed_ms: 0 } });
    expect(meter.admitTask(undefined, "local", "tool_calls")[0]).toMatchObject({ allowed: false, unit: "elapsed_ms", reason: "exhausted" });
    meter.configure({ id: "run:tokens", kind: "run", peers: ["pi"], limits: { model_calls: 3, tokens: 1000 } });
    expect(meter.admitTask(undefined, "pi", "model_calls")[0]).toMatchObject({ allowed: false, unit: "tokens", reason: "unknown_usage" });
    meter.close();
  });
});
