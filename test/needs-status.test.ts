import { expect, test } from "bun:test";
import { needs, summarizeNeeds } from "../src/ui/needs.ts";
import { attentionFacts, consoleNeeds } from "../src/cli/attention.ts";
import { initialConsoleState, reduceConsole } from "../src/cli/console-state.ts";

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

test("console facts retain only valid review/offline metadata and never read source text", () => {
  const secret = () => { throw new Error("private text read"); };
  const rows = [{ kind: "review", level: "act", id: 7, get title() { return secret(); } },
    { kind: "offline", level: "watch", id: 8, peer: "codex", get body() { return secret(); } },
    { kind: "review", level: "watch", id: 9 }, { kind: "offline", level: "act", id: 10, peer: "kimi" }, { kind: "message", level: "act", id: 11 }];
  const facts = attentionFacts(rows);
  expect(facts).toEqual([{ kind: "review", id: 7 }, { kind: "offline", id: 8, peer: "codex" }]);
  expect(consoleNeeds({ ...initialConsoleState(), attentionFacts: facts }, 1000)).toEqual({ act: 1, watch: 1, state: "review", items: [{ kind: "review", level: "act", id: 7 }, { kind: "offline", level: "watch", id: 8, peer: "codex" }] });
});

test("review next selects an exact task or prints guidance without performing a review", () => {
  for (const panels of [false, true]) {
    const state = { ...initialConsoleState(panels), petEnabled: true, attentionFacts: [{ kind: "review" as const, id: 7 }], tasks: [{ id: 1, state: "proposed" }, { id: 7, state: "in_review" }] };
    const next = reduceConsole(state, "n", 1000);
    if (panels) { expect(next.state.panel).toBe(3); expect(next.state.selection).toBe(1); expect(next.effects).toEqual([]); }
    else { expect(next.effects.map(effect => effect.type)).toEqual(["print"]); expect((next.effects[0] as { text: string }).text).toContain("ahub task show 7; ahub review 7"); }
    const missing = reduceConsole({ ...state, tasks: [{ id: 1, state: "proposed" }] }, "n", 1000);
    expect(missing.effects.map(effect => effect.type)).toEqual(["print"]);
    expect(missing.state.panel).toBe(state.panel);
  }
});
