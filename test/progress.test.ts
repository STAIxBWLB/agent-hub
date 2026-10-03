import { describe, expect, test } from "bun:test";
import { normalizeClaudeObservation, normalizeCodexObservation, ProgressObserver } from "../src/hub/progress.ts";
import type { Task } from "../src/hub/board.ts";
import type { HubEvent } from "../src/hub/events.ts";
import type { Conversation } from "../src/models/route/normalize.ts";

const task: Task = {
  id: 7, owner: "codex", title: "Implement parser", detail: "Add parser handling", class: "implement", reviewer: null,
  state: "in_progress", refs: {}, signals: [], rejections: 0, history: [], created: 0, updated: 0,
};
const verdict = { escalate: true, category: "repetition" as const, newEvidence: true, reason: "same failure" };
const failure = (turn: string, resultText = "AssertionError: repeated check failed") => ({ name: "exec_command", command: "bun test", resultText, isError: true, turn });

function setup(privateTask = false) {
  const events: HubEvent[] = [];
  const notices: string[] = [];
  const calls: unknown[] = [];
  const observer = new ProgressObserver({
    tasks: () => [task],
    isPrivate: () => privateTask,
    inference: { escalate: async (conversation) => { calls.push(conversation); return verdict; } },
    emit: (event) => events.push(event),
    notify: (line) => notices.push(line),
  });
  return { observer, events, notices, calls };
}

describe("ProgressObserver", () => {
  test("normalizes only Codex command/file items and Claude hook tool inputs", () => {
    expect(normalizeCodexObservation({ type: "commandExecution", command: "bun test", aggregatedOutput: "failed", exitCode: 1 })).toEqual({
      name: "exec_command", command: "bun test", resultText: "failed", isError: true, source: "codex",
    });
    expect(normalizeCodexObservation({ type: "fileChange", status: "completed", changes: [] })).toEqual({ name: "fileChange", source: "codex" });
    expect(normalizeCodexObservation({ type: "agentMessage", text: "not an observation" })).toBeUndefined();
    expect(normalizeClaudeObservation("Bash", { command: "bun test", description: "ignored" })).toEqual({
      name: "Bash", command: "bun test", source: "claude_hook",
    });
  });

  test("completed Codex file changes count as production and never trigger a spinning judge", async () => {
    const f = setup();
    for (let i = 0; i < 9; i++) f.observer.observe("codex", 7, normalizeCodexObservation({ type: "fileChange", status: "completed", changes: [{ path: `src/file${i}.ts` }] })!);
    await f.observer.evaluate("codex", 7);
    expect(f.calls).toHaveLength(0);
    expect(f.events.at(-1)).toMatchObject({ type: "progress", spinning: 0, production: 1 });
  });

  test("keeps tool and task text out of events and suggests reassignment only when latched", async () => {
    const f = setup();
    f.observer.observe("codex", 7, failure("turn-1", "AssertionError: private-looking output"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.observer.observe("codex", 7, failure("turn-1", "AssertionError: another tool result in the same turn"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.observer.observe("codex", 7, failure("turn-2", "AssertionError: private-looking output"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.observer.observe("codex", 7, failure("turn-3", "AssertionError: private-looking output"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(f.events).toContainEqual({ type: "stuck", peer: "codex", task: 7, category: "repetition", streak: 2, latched: true });
    expect(f.notices).toEqual(["Task #7 assigned to codex appears stuck (repetition); consider reassignment."]);
    expect(JSON.stringify(f.events)).not.toContain("npm test");
    expect(JSON.stringify(f.events)).not.toContain("private-looking output");
    expect(JSON.stringify(f.events)).not.toContain("same failure");
    expect(f.calls).toHaveLength(2);
    const first = f.calls[0] as Conversation;
    expect(first.messages[0]).toMatchObject({ role: "user", content: JSON.stringify({ task: 7, title: task.title, detail: task.detail }) });
    expect(first.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
    expect(first.messages[0]?.role === "user" ? first.messages.slice(1).map((message) => message.toolCalls.length) : []).toEqual([2, 1]);
  });

  test("does not judge one severe error without repeated failures", async () => {
    const f = setup();
    f.observer.observe("codex", 7, failure("turn-1"));
    await f.observer.evaluate("codex", 7);
    expect(f.calls).toHaveLength(0);
    expect(f.events.at(-1)).toMatchObject({ type: "progress", severity: 0.7 });
  });

  test("does not count several repeated failures in one native turn as multiple attempts", async () => {
    const f = setup();
    for (let i = 0; i < 5; i++) f.observer.observe("codex", 7, failure("same-turn", "AssertionError: same native turn"));
    f.observer.observe("codex", 7, failure("other-turn", "AssertionError: different failure"));
    await f.observer.evaluate("codex", 7);
    expect(f.calls).toHaveLength(0);
    expect(f.events.some((event) => event.type === "stuck")).toBe(false);
    f.observer.observe("codex", 7, failure("new-turn", "AssertionError: same native turn"));
    await Bun.sleep(0);
    expect(f.calls).toHaveLength(1);
    expect(f.events.at(-1)).toMatchObject({ type: "stuck", streak: 1, latched: false });
  });

  test("unknown turn IDs still emit progress but cannot create eight distinct turns", async () => {
    const f = setup();
    for (let i = 0; i < 12; i++) f.observer.observe("codex", 7, { ...failure(""), turn: undefined });
    expect(f.events.filter((event) => event.type === "progress")).toHaveLength(12);
    expect(f.events.at(-1)).toMatchObject({ type: "progress", spinning: 0 });
    expect(f.calls).toHaveLength(0);
  });

  test("does not judge when the latest observation has no native turn ID", async () => {
    const f = setup();
    f.observer.observe("codex", 7, failure("turn-1"));
    f.observer.observe("codex", 7, failure("turn-2"));
    await Bun.sleep(0);
    expect(f.calls).toHaveLength(1);
    f.observer.observe("codex", 7, { ...failure(""), turn: undefined });
    await f.observer.evaluate("codex", 7);
    expect(f.calls).toHaveLength(1);
  });

  test("a pending judge refreshes only for a newer native frame and never confirms one frame twice", async () => {
    const events: HubEvent[] = [];
    const pending: Array<(value: typeof verdict) => void> = [];
    const observer = new ProgressObserver({ tasks: () => [task], isPrivate: () => false,
      inference: { escalate: () => new Promise(resolve => pending.push(resolve)) }, emit: e => events.push(e), notify: () => {} });
    observer.observe("codex", 7, failure("turn-1", "AssertionError: repeated failure"));
    observer.observe("codex", 7, failure("turn-2", "AssertionError: repeated failure"));
    expect(pending).toHaveLength(1);
    observer.observe("codex", 7, failure("turn-2", "AssertionError: repeated failure"));
    expect(pending).toHaveLength(1);
    observer.observe("codex", 7, failure("turn-3", "AssertionError: repeated failure"));
    pending.shift()!(verdict); await Bun.sleep(0);
    expect(pending).toHaveLength(1);
    pending.shift()!(verdict); await Bun.sleep(0);
    expect(events.at(-1)).toMatchObject({ type: "stuck", streak: 1, latched: false });
    observer.observe("codex", 7, failure("turn-3", "AssertionError: repeated failure"));
    await observer.evaluate("codex", 7); expect(pending).toHaveLength(0);
    observer.observe("codex", 7, failure("turn-4", "AssertionError: repeated failure"));
    pending.shift()!(verdict); await Bun.sleep(0);
    expect(events.at(-1)).toMatchObject({ type: "stuck", streak: 2, latched: true });
    observer.observe("codex", 7, failure("turn-5", "AssertionError: after latch"));
    await observer.evaluate("codex", 7);
    expect(pending).toHaveLength(0);
  });

  test("does not retain, infer from, or emit observations while the project PII gate is active", async () => {
    const f = setup(true);
    f.observer.observe("codex", 7, { name: "write", command: "secret.txt", resultText: "sensitive" });
    await f.observer.evaluate("codex", 7);
    expect(f.events).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  test("drops a verdict when its task has changed owner before inference returns", async () => {
    let resolve!: (value: typeof verdict) => void;
    const events: HubEvent[] = [];
    const changingTask = { ...task };
    const observer = new ProgressObserver({
      tasks: () => [changingTask], isPrivate: () => false,
      inference: { escalate: () => new Promise((done) => { resolve = done; }) },
      emit: (event) => events.push(event), notify: () => {},
    });
    observer.observe("codex", 7, failure("turn-1", "AssertionError"));
    observer.observe("codex", 7, failure("turn-2", "AssertionError"));
    changingTask.owner = "pi";
    resolve(verdict);
    await new Promise((done) => setTimeout(done, 0));
    expect(events.some((event) => event.type === "stuck")).toBe(false);
  });
});
