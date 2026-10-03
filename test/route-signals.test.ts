import { expect, test } from "bun:test";
import { normalizeConversation } from "../src/models/route/normalize.ts";
import { extractToolSignals, extractToolSignalsFromObservations, fingerprint } from "../src/models/route/signals.ts";

function signalFor(name: string, args: unknown = {}) {
  return extractToolSignals(normalizeConversation({ messages: [{ role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }] }));
}

test("Switchyard built-in tool vocabulary maps the same names to their buckets", () => {
  const cases: Array<[string, unknown, "write" | "edit" | "read" | "plan" | "unknown"]> = [
    ["write", {}, "write"], ["create_file", {}, "write"], ["new_file", {}, "write"], ["write_file", {}, "write"],
    ["edit", {}, "edit"], ["MultiEdit", {}, "edit"], ["NotebookEdit", {}, "edit"], ["str_replace", {}, "edit"],
    ["str_replace_based_edit_tool", { command: "replace" }, "edit"], ["apply_patch", {}, "edit"], ["text_editor", { command: "edit" }, "edit"], ["patch", {}, "edit"],
    ["str_replace_based_edit_tool", { command: "view" }, "read"], ["text_editor", { command: "view" }, "read"],
    ["read", {}, "read"], ["view", {}, "read"], ["read_file", {}, "read"], ["search_files", {}, "read"], ["glob", {}, "read"], ["grep", {}, "read"], ["find", {}, "read"], ["ls", {}, "read"],
    ["todowrite", {}, "plan"], ["todo_write", {}, "plan"], ["todo", {}, "plan"], ["update_plan", {}, "plan"], ["todo_list", {}, "plan"],
    ["unknown_tool", {}, "unknown"],
  ];
  for (const [name, args, expected] of cases) {
    const signal = signalFor(name, args);
    expect({ write: signal.writeCount, edit: signal.editCount, read: signal.readCount, plan: signal.todowriteCount }).toEqual({
      write: expected === "write" ? 1 : 0, edit: expected === "edit" ? 1 : 0, read: expected === "read" ? 1 : 0, plan: expected === "plan" ? 1 : 0,
    });
  }
});

test("Switchyard shell write, edit, and inspection vocabulary is preserved", () => {
  const cases: Array<[string, "write" | "edit" | "read" | "unknown"]> = [
    ["cat > /tmp/a", "write"], ["cat >> /tmp/a", "write"], ["echo x > /tmp/a", "write"], ["echo x >> /tmp/a", "write"],
    ["printf x > /tmp/a", "write"], ["tee /tmp/a", "write"], ["cp a b", "write"], ["mkdir -p a", "write"], ["touch a", "write"], ["install a b", "write"],
    ["python -c 'Path(\"a\").write_text(\"x\")'", "write"], ["node -e 'writeFileSync(\"a\", \"x\")'", "write"],
    ["sed -i s/a/b/ f", "edit"], ["sed --in-place s/a/b/ f", "edit"], ["awk -i inplace '{x}' f", "edit"], ["patch -p1 < x.patch", "edit"],
    ["perl -pi -e s/a/b/ f", "edit"], ["mv a b", "edit"], ["rm a", "edit"], ["git apply change.patch", "edit"], ["gofmt -w a.go", "edit"],
    ["cargo fmt", "edit"], ["cargo fmt --check", "unknown"], ["ruff format a.py", "edit"], ["ruff format --check a.py", "unknown"],
    ["prettier --write a.ts", "edit"], ["black a.py", "edit"], ["black --check a.py", "unknown"],
    ["cat /etc/passwd", "read"], ["grep foo bar.txt", "read"], ["ls /app", "read"], ["find . -name '*.py'", "read"],
    ["sed -n '1,80p' src/lib.rs", "read"], ["rg -n 'needle' src", "read"], ["nl -ba src/lib.rs", "read"], ["cat package.json", "read"],
    ["jq '.scripts' package.json", "read"], ["git status --short", "read"], ["git log --oneline -5", "read"],
    ["git show HEAD:src/lib.rs", "read"], ["git branch --show-current", "read"], ["git remote -v", "read"], ["git config --get remote.origin.url", "read"],
    ["rg 'foo|rm obsolete.rs'", "read"], ["rg \"foo; rm obsolete.rs\"", "read"],
    ["cp source.rs destination.rs", "write"], ["mkdir -p src/generated", "write"], ["touch src/generated/mod.rs", "write"],
    ["git show HEAD:file.rs > file.rs", "write"], ["node <<'node'\nfs.writefilesync('file.js', text)\nnode", "write"],
    ["mv old.rs new.rs", "edit"], ["rm obsolete.rs", "edit"], ["gofmt -w main.go", "edit"], ["ruff check --fix src", "edit"],
    ["perl -0pi -e 's/old/new/' src/lib.rs", "edit"], ["npx prettier --write src/lib.ts", "edit"], ["uv run ruff format src", "edit"], ["git apply fix.patch", "edit"],
    ["cargo fmt --check", "unknown"], ["ruff format --check src", "unknown"], ["black --check src", "unknown"],
    ["node <<'node'\nif (index > 0) console.log(index)\nnode", "unknown"], ["cat /etc/hosts > /tmp/out", "write"],
  ];
  for (const [command, expected] of cases) {
    const signal = signalFor("exec_command", { cmd: command });
    const actual = signal.writeCount ? "write" : signal.editCount ? "edit" : signal.readCount ? "read" : "unknown";
    expect(actual).toBe(expected);
  }
});

test("normalization extracts system instructions, OpenAI calls, JSON arguments, and tool results", () => {
  const conversation = normalizeConversation({ messages: [
    { role: "system", content: "route carefully" },
    { role: "assistant", tool_calls: [{ id: "r", function: { name: "read", arguments: "{\"path\":\"a\"}" } }] },
    { role: "tool", tool_call_id: "r", content: "File contents: traceback (most recent call last)" },
    { role: "assistant", tool_calls: [{ id: "w", function: { name: "write_file", arguments: "not JSON" } }] },
    { role: "tool", tool_call_id: "w", content: "done", is_error: true },
  ] });
  expect(conversation.instructions).toEqual(["route carefully"]);
  expect(conversation.messages[0]?.toolCalls[0]?.arguments).toEqual({ path: "a" });
  expect(conversation.messages[1]?.toolResults[0]).toEqual({ toolCallId: "r", content: "File contents: traceback (most recent call last)" });
  expect(conversation.messages[2]?.toolCalls[0]?.arguments).toEqual({ raw: "not JSON" });
  expect(extractToolSignals(conversation)).toMatchObject({ readCount: 1, writeCount: 1, severity: 0.7 });
});

test("retrieved file contents do not masquerade as execution failures", () => {
  const conversation = normalizeConversation({ messages: [
    { role: "assistant", tool_calls: [{ id: "r", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "r", content: "Traceback (most recent call last)" },
  ] });
  expect(extractToolSignals(conversation).severity).toBe(0);
});

test("failure severities and critical phrases follow the upstream table", () => {
  const cases: Array<[string, number]> = [
    ["out of memory", 1], ["MemoryError", 1], ["cannot allocate memory", 1],
    ["connection refused", 0.7], ["ConnectionRefusedError", 0.7], ["ECONNREFUSED", 0.7],
    ["Traceback (most recent call last)", 0.7], ["ModuleNotFoundError: x", 0.7], ["ImportError: x", 0.7], ["No module named x", 0.7],
    ["command not found", 0.7], ["/usr/bin/env: python", 0.7], ["AssertionError", 0.7], ["ValueError: x", 0.7], ["SyntaxError: x", 0.7],
    ["timed out", 0.7], ["TimeoutError", 0.7], ["timeout expired", 0.7], ["deadline exceeded", 0.7],
    ["FileNotFoundError: x", 0.7], ["No such file or directory", 0.7], ["File does not exist", 0.7], ["returned non-zero", 0.3],
    ["ordinary output", 0], ["the source mentions AssertionError", 0.7],
  ];
  for (const [text, severity] of cases) expect(extractToolSignalsFromObservations([{ name: "bash", resultText: text }]).severity).toBe(severity);
  expect(extractToolSignalsFromObservations([{ name: "bash", isError: true }]).severity).toBe(0.7);
});

test("repeat, recovery streak, test-pass, and recent-window signals are stable", () => {
  const repeated = extractToolSignalsFromObservations([
    { name: "bash", resultText: "ModuleNotFoundError: No module named x" },
    { name: "bash", resultText: "ModuleNotFoundError: No module named x" },
  ]);
  expect(repeated.repeatedFailure).toBe(true);
  expect(extractToolSignalsFromObservations([{ name: "bash", resultText: "x" }, { name: "bash", resultText: "done" }]).noErrorStreak).toBe(2);
  expect(extractToolSignalsFromObservations([{ name: "bash", resultText: "Error: failed" }, { name: "bash", resultText: "2 passed" }]).testsPassed).toBe(true);
  expect(extractToolSignalsFromObservations([{ name: "bash", resultText: "Error: failed" }, { name: "bash", resultText: "2 passed\n1 failed" }]).testsPassed).toBe(false);
  const windowed = extractToolSignalsFromObservations([{ name: "bash", resultText: "out of memory" }, { name: "bash", resultText: "ok" }, { name: "bash", resultText: "ok" }, { name: "bash", resultText: "ok" }]);
  expect(windowed.severity).toBe(0);
});

test("empty and assistant-only conversations have neutral signals", () => {
  expect(extractToolSignals(normalizeConversation({ messages: [{ role: "assistant", content: "thinking" }] }))).toMatchObject({ severity: 0, toolResultCount: 0, assistantTurnCount: 1, turnDepth: 1 });
});

test("source failure separator and indentation spellings retain their severity", () => {
  expect(extractToolSignalsFromObservations([{ name: "bash", resultText: "Process exited with code: 1" }]).severity).toBe(0.3);
  expect(extractToolSignalsFromObservations([{ name: "bash", resultText: "  error: patch failed: src/x:1" }]).severity).toBe(0.7);
  expect(extractToolSignalsFromObservations([{ name: "read", resultText: "AssertionError in source fixture" }, { name: "read", resultText: "AssertionError in source fixture" }]).severity).toBe(0);
  expect(extractToolSignalsFromObservations([{ name: "read", resultText: "AssertionError", isError: true }]).severity).toBe(0.7);
});

test("successful shell reads are retrieval results in Chat IR and peer observations", () => {
  for (const command of ["cat failing.ts", "rg AssertionError src"]) {
    const conversation = normalizeConversation({ messages: [
      { role: "assistant", tool_calls: [{ id: command, function: { name: "exec_command", arguments: JSON.stringify({ cmd: command }) } }] },
      { role: "tool", tool_call_id: command, content: "AssertionError: text found in source" },
    ] });
    expect(extractToolSignals(conversation).severity).toBe(0);
    expect(extractToolSignalsFromObservations([{ name: "exec_command", command, resultText: "AssertionError: text found in source" }]).severity).toBe(0);
  }

  const failedRead = normalizeConversation({ messages: [
    { role: "assistant", tool_calls: [{ id: "read", function: { name: "exec_command", arguments: JSON.stringify({ cmd: "cat missing.ts" }) } }] },
    { role: "tool", tool_call_id: "read", content: "AssertionError: command failed", is_error: true },
  ] });
  expect(extractToolSignals(failedRead).severity).toBe(0.7);
  expect(extractToolSignalsFromObservations([{ name: "exec_command", command: "cat missing.ts", resultText: "AssertionError: command failed", isError: true }]).severity).toBe(0.7);
});

test("attached shell redirection destinations classify as writes", () => {
  for (const command of ["printf result >result.txt", "printf result >>result.txt", "cat source.txt >result.txt", "cat source.txt >>result.txt"]) {
    const signal = signalFor("exec_command", { cmd: command });
    expect(signal.writeCount).toBe(1);
    expect(signal.readCount).toBe(0);
  }
});

test("failure fingerprints cap at 240 Unicode scalar values", () => {
  const diagnostic = `AssertionError: ${"😀".repeat(300)}`;
  const value = fingerprint(diagnostic, false);
  expect(value).toBeDefined();
  expect(value!.split("|").at(-1)).toBe([...diagnostic.toLowerCase()].slice(0, 240).join(""));
});
