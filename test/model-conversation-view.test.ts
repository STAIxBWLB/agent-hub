import { describe, expect, test } from "bun:test";
import { captureJudgeConversation, captureRouteView } from "../src/models/route/conversation-view.ts";

const call = (id: string, name = "write_file") => ({ id, type: "function", function: { name, arguments: "{}" } });
const written = () => [
  { role: "assistant", content: null, tool_calls: [call("write")] },
  { role: "tool", tool_call_id: "write", content: "fixture saved" },
];

describe("individual route-result completeness", () => {
  test("clipped old history does not erase a complete observed current result", () => {
    const messages = [...Array.from({ length: 70 }, () => ({ role: "assistant", content: "old fixture" })), ...written()];
    const view = captureRouteView(messages);
    expect(view?.stageInput.incomplete).toBe(true);
    expect(view?.results.length).toBe(1);
    expect(view?.results[0]?.sourceTextComplete).toBe(true);
    expect(view?.results[0]?.input.associated).toBe(true);
  });

  test("clipped current text and aggregate-budget clipping remain unknown", () => {
    const messages = written();
    messages[1]!.content = "x".repeat(65_537);
    expect(captureRouteView(messages)?.results[0]?.sourceTextComplete).toBe(false);
    const view = captureRouteView([
      { role: "assistant", content: null, tool_calls: [call("write"), call("read", "read_file")] },
      { role: "tool", tool_call_id: "write", content: "a".repeat(20_000) },
      { role: "tool", tool_call_id: "read", content: "b".repeat(60_000) },
    ]);
    expect(view?.stageInput.incomplete).toBe(true);
    expect(view?.results.map(result => result.sourceTextComplete)).toEqual([false, true]);
  });

  test("ordinal mapping keeps native flags and duplicate-ID association intact", () => {
    const view = captureRouteView([
      { role: "assistant", content: null, tool_calls: [call("same")] },
      { role: "tool", tool_call_id: "same", content: "first fixture", is_error: true },
      { role: "tool", tool_call_id: "same", content: "second fixture" },
    ]);
    expect(view?.results.map(result => result.input.text)).toEqual(["first fixture", "second fixture"]);
    expect(view?.results.map(result => result.input.error)).toEqual([true, false]);
    expect(view?.results.every(result => !result.input.associated)).toBe(true);
  });

  test("does not invoke getters, proxy traps or inherited field getters", () => {
    let touched = 0;
    const getter = { role: "tool", get content() { touched++; return "saved"; } };
    expect(captureRouteView([getter])).toBeUndefined();
    const proxy = new Proxy({ role: "tool" }, { getOwnPropertyDescriptor() { touched++; return undefined; }, get() { touched++; return undefined; } });
    expect(captureRouteView([proxy])).toBeUndefined();
    const inherited = Object.create({ get role() { touched++; return "tool"; } });
    expect(captureRouteView([inherited])).toBeUndefined();
    expect(touched).toBe(0);
  });

  test("does not inspect tool arguments or old records beyond the window", () => {
    let touched = 0;
    const entry = { id: "write", function: { name: "write_file", get arguments() { touched++; return "secret fixture"; } } };
    const ancient = { get role() { touched++; return "user"; } };
    const messages = [ancient, ...Array.from({ length: 64 }, () => ({ role: "assistant", content: "old" })),
      { role: "assistant", content: null, tool_calls: [entry] }, { role: "tool", tool_call_id: "write", content: "saved" }];
    expect(captureRouteView(messages)?.results[0]?.sourceTextComplete).toBe(true);
    expect(touched).toBe(0);
  });

  test("non-string result representations and malformed native flags cannot prove completion", () => {
    const part = captureRouteView([{ role: "tool", content: [{ type: "text", text: "saved" }] }]);
    expect(part?.results[0]?.sourceTextComplete).toBe(false);
    const malformed = captureRouteView([{ role: "tool", content: "saved", is_error: "false" }]);
    expect(malformed?.results[0]?.sourceTextComplete).toBe(false);
    expect(captureRouteView([{ role: "unsupported", content: "fixture" }])).toBeUndefined();
  });
});

describe("full inert local judge conversation", () => {
  test("keeps instructions first and counts complete native history beyond stage caps", () => {
    const source: unknown[] = [{ role: "user", content: "task" }];
    for (let index = 0; index < 40; index++) source.push(
      { role: "assistant", content: null, tool_calls: [call(`call-${index}`)] },
      { role: "tool", content: "saved", tool_call_id: `call-${index}`, is_error: false },
    );
    source.push({ role: "system", content: "instruction fixture" }, { role: "assistant", content: "done" });
    const full = captureJudgeConversation(source);
    expect(full?.assistantTurns).toBe(41);
    expect(full?.resultCount).toBe(40);
    expect(JSON.parse(full?.transcript ?? "[]")[0]).toEqual({ role: "system", content: "instruction fixture" });
    expect(full?.terminal).toEqual({ hasToolUse: false, visibleText: "done" });
  });

  test("inert cloning never invokes source serialization hooks or unknown getters", () => {
    let invoked = 0;
    const source = [{ role: "assistant", content: "done", get toJSON() { invoked++; throw new Error("not data"); } }];
    expect(captureJudgeConversation(source)?.messages).toEqual([{ role: "assistant", content: "done" }]);
    expect(invoked).toBe(0);
    const invalid = [{ role: "assistant", get content() { invoked++; return "not data"; } }];
    expect(captureJudgeConversation(invalid)).toBeUndefined();
    expect(invoked).toBe(0);
  });

  test("malformed or explicitly unknown fields are unavailable rather than partial", () => {
    expect(captureJudgeConversation([{ role: "assistant", content: undefined }])).toBeUndefined();
    expect(captureJudgeConversation([{ role: "tool", content: "saved", tool_call_id: "one", is_error: undefined }])).toBeUndefined();
    expect(captureJudgeConversation([{ role: "tool", content: "saved" }])).toBeUndefined();
    expect(captureJudgeConversation([{ role: "assistant", content: "done", tool_calls: undefined }])).toBeUndefined();
    expect(captureJudgeConversation([{ role: "assistant", content: "done", tool_calls: [{ id: "one", function: { name: "write_file", arguments: undefined } }] }])).toBeUndefined();
  });

  test("every valid 200000-point Unicode fixture fits the existing wire ceiling", () => {
    for (const text of ["😀".repeat(200_000), "\n".repeat(200_000)]) {
      const full = captureJudgeConversation([{ role: "assistant", content: text }]);
      expect(full?.messages[0]?.content).toBe(text);
    }
    expect(captureJudgeConversation([{ role: "assistant", content: "a".repeat(2_000_001) }])).toBeUndefined();
  });
});
