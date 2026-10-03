import { expect, test } from "bun:test";
import { RouteLabelTracker } from "../src/models/route/labels.ts";
import type { ChatMessage } from "../src/omniroute/client.ts";

const dims = { severity: 0.7, spinning: 1, exploring: 0, production: 0.25 };

test("labels one decision once with compact results and clears turn state", () => {
  const tracker = new RouteLabelTracker();
  const emitted: unknown[] = [];
  tracker.beginTurn({ turn: "turn-1", task: 42, pii: true });
  const id = tracker.addDecision(tracker.captureTurn(), dims)!;
  const assistant: ChatMessage = { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{\"command\":\"bun test\"}" } }] };
  const tools: ChatMessage[] = [{ role: "tool", tool_call_id: "c1", content: "2 tests failed: assertionerror: private detail" }];
  tracker.observeResults(id, assistant, tools);
  tracker.observeAdvisor(id, "redo");
  tracker.endTurn("turn-1", "completed", event => emitted.push(event));
  tracker.endTurn("turn-1", "failed", event => emitted.push(event));
  expect(emitted).toEqual([{ decision: id, turnId: "turn-1", turn: "completed", pii: true, task: 42, latched: false, next: { severity: 0.7, tests: "fail", repeat: false }, advisor: "redo" }]);
  expect(JSON.stringify(emitted)).not.toContain("private detail");
  expect(tracker.captureTurn()).toBeUndefined();
});

test("repeat is measured against the prior batch without retaining diagnostic text", () => {
  const tracker = new RouteLabelTracker(), emitted: any[] = [];
  tracker.beginTurn({ turn: "turn-2", pii: false });
  const first = tracker.addDecision(tracker.captureTurn(), dims)!;
  const assistant: ChatMessage = { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{\"command\":\"npm test\"}" } }] };
  const result = (id: string): ChatMessage[] => [{ role: "tool", tool_call_id: id, content: "AssertionError: /private/customer-17/file.ts" }];
  const second = tracker.addDecision(tracker.captureTurn(), dims, [assistant, ...result("c1")])!;
  tracker.observeResults(first, assistant, result("c1"));
  tracker.observeResults(second, { ...assistant, tool_calls: [{ ...assistant.tool_calls![0]!, id: "c2" }] }, result("c2"));
  tracker.setLatched(tracker.captureTurn(), true);
  tracker.endTurn("turn-2", "failed", event => emitted.push(event));
  expect(emitted.map(e => e.next?.repeat)).toEqual([false, true]);
  expect(emitted.every(e => e.latched)).toBe(true);
  expect(JSON.stringify(emitted)).not.toContain("customer-17");
});

test("late completion from a closed generation cannot change or duplicate its labels", () => {
  const tracker = new RouteLabelTracker(), emitted: any[] = [];
  tracker.beginTurn({ turn: "old", pii: false });
  const old = tracker.captureTurn();
  const oldDecision = tracker.addDecision(old, dims)!;
  tracker.endTurn("old", "failed", event => emitted.push(event));
  tracker.beginTurn({ turn: "new", pii: true });
  const newDecision = tracker.addDecision(tracker.captureTurn(), dims)!;
  tracker.observeResults(oldDecision, { role: "assistant", content: null }, [{ role: "tool", content: "secret failure" }]);
  tracker.observeAdvisor(oldDecision, "approve");
  tracker.endTurn("new", "completed", event => emitted.push(event));
  expect(emitted).toHaveLength(2);
  expect(emitted[0]).toMatchObject({ decision: oldDecision, turnId: "old", turn: "failed" });
  expect(emitted[0]).not.toHaveProperty("next");
  expect(emitted[0]).not.toHaveProperty("advisor");
  expect(emitted[1]).toMatchObject({ decision: newDecision, turnId: "new", pii: true });
});

test("sink exceptions are isolated while every decision still settles", () => {
  const tracker = new RouteLabelTracker();
  tracker.beginTurn({ turn: "turn-3", pii: false });
  tracker.addDecision(tracker.captureTurn(), dims);
  expect(() => tracker.endTurn("turn-3", "completed", () => { throw new Error("sink failed"); })).not.toThrow();
  expect(tracker.captureTurn()).toBeUndefined();
});

test("severity includes failures anywhere in a tool batch larger than the signal window", () => {
  const tracker = new RouteLabelTracker(), emitted: any[] = [];
  tracker.beginTurn({ turn: "wide-batch", pii: false });
  const id = tracker.addDecision(tracker.captureTurn(), dims)!;
  const tool_calls = Array.from({ length: 4 }, (_, index) => ({
    id: `c${index}`, type: "function" as const,
    function: { name: "bash", arguments: "{\"command\":\"bun test\"}" },
  }));
  const assistant: ChatMessage = { role: "assistant", content: null, tool_calls };
  const tools: ChatMessage[] = [
    { role: "tool", tool_call_id: "c0", content: "AssertionError: first result" },
    { role: "tool", tool_call_id: "c1", content: "ok" },
    { role: "tool", tool_call_id: "c2", content: "ok" },
    { role: "tool", tool_call_id: "c3", content: "ok" },
  ];
  tracker.observeResults(id, assistant, tools);
  tracker.endTurn("wide-batch", "completed", event => emitted.push(event));
  expect(emitted[0]?.next).toEqual({ severity: 0.7, tests: "fail", repeat: false });
});

test("test failure counts survive a zero exit status from a wrapped test command", () => {
  const tracker = new RouteLabelTracker(), emitted: any[] = [];
  tracker.beginTurn({ turn: "wrapped-test", pii: false });
  const id = tracker.addDecision(tracker.captureTurn(), dims)!;
  const assistant: ChatMessage = { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{\"command\":\"./wrapper.sh bun test\"}" } }] };
  tracker.observeResults(id, assistant, [{ role: "tool", tool_call_id: "c1", content: "2 failed, 8 passed (exit code 0)" }]);
  tracker.endTurn("wrapped-test", "completed", event => emitted.push(event));
  expect(emitted[0]?.next?.severity).toBe(0);
  expect(emitted[0]?.next?.tests).toBe("fail");
});

test("a successful read containing test-failure text cannot label unrelated command failure as a test failure", () => {
  const tracker = new RouteLabelTracker(), emitted: any[] = [];
  tracker.beginTurn({ turn: "read-fixture", pii: false });
  const id = tracker.addDecision(tracker.captureTurn(), dims)!;
  const assistant: ChatMessage = { role: "assistant", content: null, tool_calls: [
    { id: "c1", type: "function", function: { name: "bash", arguments: "{\"command\":\"git status\"}" } },
    { id: "c2", type: "function", function: { name: "read", arguments: "{}" } },
  ] };
  tracker.observeResults(id, assistant, [
    { role: "tool", tool_call_id: "c1", content: "command failed: exit code 1", is_error: true },
    { role: "tool", tool_call_id: "c2", content: "2 tests failed" },
  ]);
  tracker.endTurn("read-fixture", "completed", event => emitted.push(event));
  expect(emitted[0]?.next?.severity).toBe(0.7);
  expect(emitted[0]?.next?.tests).toBe("none");
});

test("editor view output is retrieval evidence and does not seed a repeated failure", () => {
  const tracker = new RouteLabelTracker(), emitted: any[] = [];
  const prior: ChatMessage[] = [
    { role: "assistant", content: null, tool_calls: [{ id: "read1", type: "function", function: { name: "text_editor", arguments: "{\"command\":\"view\"}" } }] },
    { role: "tool", tool_call_id: "read1", content: "AssertionError: example in fixture" },
  ];
  tracker.beginTurn({ turn: "editor-view", pii: false });
  const id = tracker.addDecision(tracker.captureTurn(), dims, prior)!;
  const assistant: ChatMessage = { role: "assistant", content: null, tool_calls: [{ id: "test1", type: "function", function: { name: "bash", arguments: "{\"command\":\"bun test\"}" } }] };
  tracker.observeResults(id, assistant, [{ role: "tool", tool_call_id: "test1", content: "AssertionError: example in fixture" }]);
  tracker.endTurn("editor-view", "completed", event => emitted.push(event));
  expect(emitted[0]?.next?.repeat).toBe(false);
});
