import { describe, expect, test } from "bun:test";
import { normalizeClaudeObservation, normalizeCodexObservation, ProgressObserver } from "../src/hub/progress.ts";
import type { Task } from "../src/hub/board.ts";
import type { HubEvent } from "../src/hub/events.ts";

const task: Task = {
  id: 7, owner: "codex", title: "Implement parser", detail: "Add parser handling", class: "implement", reviewer: null,
  state: "in_progress", refs: {}, signals: [], rejections: 0, history: [], created: 0, updated: 0,
};
const verdict = { escalate: true, category: "repetition" as const, newEvidence: true, reason: "same failure" };

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
    f.observer.observe("codex", 7, { name: "commandExecution", command: "npm test", resultText: "AssertionError: private-looking output" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.observer.observe("codex", 7, { name: "commandExecution", command: "npm test", resultText: "AssertionError: private-looking output" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(f.events).toContainEqual({ type: "stuck", peer: "codex", task: 7, category: "repetition", streak: 2, latched: true });
    expect(f.notices).toEqual(["Task #7 assigned to codex appears stuck (repetition); consider reassignment."]);
    expect(JSON.stringify(f.events)).not.toContain("npm test");
    expect(JSON.stringify(f.events)).not.toContain("private-looking output");
    expect(JSON.stringify(f.events)).not.toContain("same failure");
    expect(f.calls).toHaveLength(2);
  });

  test("a pending judge schedules the latest failing generation and never confirms identical evidence twice", async () => {
    const events: HubEvent[] = [];
    const pending: Array<(value: typeof verdict) => void> = [];
    const observer = new ProgressObserver({ tasks: () => [task], isPrivate: () => false,
      inference: { escalate: () => new Promise(resolve => pending.push(resolve)) }, emit: e => events.push(e), notify: () => {} });
    observer.observe("codex", 7, { name: "bash", resultText: "AssertionError: first" });
    observer.observe("codex", 7, { name: "bash", resultText: "AssertionError: second" });
    expect(pending).toHaveLength(1);
    pending.shift()!(verdict); await Bun.sleep(0);
    expect(pending).toHaveLength(1);
    pending.shift()!(verdict); await Bun.sleep(0);
    expect(events.at(-1)).toMatchObject({ type: "stuck", streak: 1, latched: false });
    await observer.evaluate("codex", 7); expect(pending).toHaveLength(0);
    observer.observe("codex", 7, { name: "bash", resultText: "AssertionError: third" });
    pending.shift()!(verdict); await Bun.sleep(0);
    expect(events.at(-1)).toMatchObject({ type: "stuck", streak: 2, latched: true });
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
    observer.observe("codex", 7, { name: "commandExecution", resultText: "AssertionError" });
    changingTask.owner = "pi";
    resolve(verdict);
    await new Promise((done) => setTimeout(done, 0));
    expect(events.some((event) => event.type === "stuck")).toBe(false);
  });
});
