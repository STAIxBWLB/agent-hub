import { expect, test } from "bun:test";
import { composeRememberText, REMEMBER_TEXT_MAX_BYTES } from "../src/hub/memory-fail.ts";
import { TASK_TOOLS } from "../src/hub/hub-tools.ts";

test("structured fail composes fixed labels in fixed order without inventing omitted fields", () => {
  expect(composeRememberText({ kind: "fail", retry_when: " a corrected fixture passes ", evidence: " test:retained-regression ", cause: " wrong invariant ", symptom: " refusal ", approach: " old method " })).toBe([
    "Approach: old method", "Symptom: refusal", "Cause: wrong invariant", "Evidence: test:retained-regression", "Retry when: a corrected fixture passes",
  ].join("\n"));
  expect(composeRememberText({ kind: "fail", cause: "specific cause" })).toBe("Cause: specific cause");
  expect(composeRememberText({ kind: "fail", text: " context ", cause: " a cause " })).toBe("context\n\nCause: a cause");
});

test("plain text notes retain their content including legacy plain fail notes", () => {
  for (const kind of [undefined, "fail", "decision", "finding", "contract", "legacy-unknown", null, false, {}]) expect(composeRememberText({ kind, text: "  plain note\nwith detail  " })).toBe("plain note\nwith detail");
  expect(composeRememberText({ kind: "fail", text: "x".repeat(REMEMBER_TEXT_MAX_BYTES) })).toHaveLength(REMEMBER_TEXT_MAX_BYTES);
});

test("UTF-8 byte cap is checked before any truncation, including labels and optional text", () => {
  const multibyte = "가".repeat(1334);
  expect(multibyte.length).toBeLessThan(REMEMBER_TEXT_MAX_BYTES);
  expect(() => composeRememberText({ kind: "fail", text: multibyte })).toThrow("4002 UTF-8 bytes; maximum is 4000 bytes");
  expect(composeRememberText({ kind: "fail", text: "가".repeat(1333) })).toBe("가".repeat(1333));
  const base = Buffer.byteLength(composeRememberText({ kind: "fail", approach: "x" }), "utf8");
  const field = "x".repeat(REMEMBER_TEXT_MAX_BYTES - base + 1);
  expect(Buffer.byteLength(composeRememberText({ kind: "fail", approach: field }), "utf8")).toBe(REMEMBER_TEXT_MAX_BYTES);
  const input = { kind: "fail", approach: `${field}x` };
  expect(() => composeRememberText(input)).toThrow("4001 UTF-8 bytes; maximum is 4000 bytes");
  expect(input.approach).toBe(`${field}x`);
  expect(() => composeRememberText({ kind: "fail", text: "prefix", evidence: "x".repeat(4000) })).toThrow("refused without truncation");
});

test("unenforced schema input is validated before composing a memory note", () => {
  for (const input of [undefined, null, [], "text", 12]) expect(() => composeRememberText(input)).toThrow("must be an object");
  for (const text of [12, false, {}, ["plain"]]) expect(() => composeRememberText({ text })).toThrow("text must be a string");
  for (const field of ["approach", "symptom", "cause", "evidence", "retry_when"]) {
    for (const kind of [undefined, "decision", "finding", "contract", "unknown", null, false, 12, {}]) expect(() => composeRememberText({ kind, text: "plain", [field]: "detail" })).toThrow("only available for kind fail");
    for (const value of [null, [], ["evidence"], {}, 3, false, "", "  "]) expect(() => composeRememberText({ kind: "fail", [field]: value })).toThrow("must be a nonempty string");
  }
  expect(() => composeRememberText({})).toThrow("text is required");
  expect(() => composeRememberText({ kind: "fail", text: "  " })).toThrow("text is required");
});

test("hub_remember schema publishes optional structured strings while runtime owns conditional requirements", () => {
  const remember = TASK_TOOLS.find(tool => tool.name === "hub_remember")!;
  const schema = remember.inputSchema as { required?: string[]; properties: Record<string, { type: string }> };
  expect(schema.required ?? []).not.toContain("text");
  for (const key of ["text", "approach", "symptom", "cause", "evidence", "retry_when"]) expect(schema.properties[key]?.type).toBe("string");
  expect(remember.description).toContain("4000 UTF-8 bytes");
});
