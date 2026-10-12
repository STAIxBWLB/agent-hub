import { expect, test } from "bun:test";
import { needs, summarizeNeeds } from "../src/ui/needs.ts";

test("person review and offline ownership use ids and count each offline peer once", () => {
  const input = { peers: { codex: { state: "offline" }, kimi: { state: "idle" } }, tasks: [
    { id: 20, state: "in_progress", owner: "codex" }, { id: 10, state: "proposed", owner: "codex" },
    { id: 3, state: "in_review", reviewer: "user" }, { id: 4, state: "in_review", reviewer: "kimi" },
    { id: 1, state: "approved", owner: "codex" }, { id: 2, state: "changes_requested", owner: "kimi" },
  ] };
  expect(needs(input, 1000)).toEqual({ act: 1, watch: 1, state: "review", items: [
    { kind: "review", level: "act", id: 3 }, { kind: "offline", level: "watch", peer: "codex", id: 10 },
  ] });
  expect(needs({ peers: input.peers, tasks: input.tasks.filter(task => task.reviewer !== "user") }, 1000).state).toBe("idle");
});

test("only an observed absent recovery runner creates a blocked action", () => {
  const peers = { codex: { state: "busy" } };
  for (const running of [true, undefined]) {
    expect(needs({ peers, recovery: { id: "operation", running } }, 1000)).toEqual({ act: 0, watch: 1, state: "working", items: [{ kind: "recovery", level: "watch", id: "operation" }] });
  }
  expect(needs({ peers, recovery: { id: "operation", running: false } }, 1000).state).toBe("blocked");
  expect(needs({ peers, recovery: { id: "operation", running: false }, approvals: [{ id: "request", expiresAt: 2000 }] }, 1000).state).toBe("waiting");
});

test("status summary excludes unread messages and never reads task text", () => {
  const secret = () => { throw new Error("private source text read"); };
  const input = { tasks: [{ id: 1, state: "in_review", reviewer: "user", get title() { return secret(); }, get detail() { return secret(); } }], get messages() { return secret(); }, get paths() { return secret(); } };
  expect(summarizeNeeds(input, 1000)).toEqual({ act: 1, watch: 0, state: "review", first: { kind: "review", level: "act", id: 1 } });
});
