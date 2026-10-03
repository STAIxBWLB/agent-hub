import { expect, test } from "bun:test";
import { extractToolSignals } from "../src/models/route/signals.ts";
import { normalizeConversation } from "../src/models/route/normalize.ts";
import { DEFAULT_PLANNING_PROMPT, planExecutePhase, type PlanExecuteState } from "../src/models/route/plan-execute.ts";

const calls = (name: string, args: unknown = {}) => extractToolSignals(normalizeConversation({ messages: [{ role: "assistant", tool_calls: [{ id: "c", function: { name, arguments: JSON.stringify(args) } }] }] }));

test("plans on a read-only conversation and prepends the default planning instruction", () => {
  const decision = planExecutePhase(calls("exec_command", { cmd: "rg parser src" }), "task-1");
  expect(decision).toMatchObject({ phase: "plan", tier: "capable", planningPrompt: DEFAULT_PLANNING_PROMPT, state: { executingSessions: [] } });
});

test("first edit hands execution to efficient and latches the session", () => {
  const first = planExecutePhase(calls("apply_patch"), "task-1", undefined, { handoffPrompt: "Continue from the plan." });
  expect(first).toMatchObject({ phase: "handoff", tier: "efficient", handoffPrompt: "Continue from the plan.", state: { executingSessions: ["task-1"] } });
  const next = planExecutePhase(extractToolSignals(normalizeConversation({ messages: [{ role: "user", content: "continue" }] })), "task-1", first.state);
  expect(next).toMatchObject({ phase: "execute", tier: "efficient", state: { executingSessions: ["task-1"] } });
});

test("mutation without a session gets a one-turn handoff but cannot latch", () => {
  expect(planExecutePhase(calls("exec_command", { cmd: "printf done > file" }), undefined)).toMatchObject({ phase: "handoff", tier: "efficient", state: { executingSessions: [] } });
});

test("final-session cleanup and bounded eviction match the upstream state machine", () => {
  const seeded: PlanExecuteState = { executingSessions: ["old", "active"] };
  const evicted = planExecutePhase(calls("write_file"), "new", seeded, { maxSessions: 2 });
  expect(evicted.state.executingSessions).toEqual(["active", "new"]);
  const final = planExecutePhase(calls("read"), "active", evicted.state, { sessionFinal: true });
  expect(final.phase).toBe("execute");
  expect(final.state.executingSessions).toEqual(["new"]);
});
