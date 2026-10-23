import { expect, test } from "bun:test";
import { permissionPayload } from "../src/hub/permission-payload.ts";

const screen = (text: string) => !text.includes("private-value");

test("permission rendering screens the whole original value before any truncation", () => {
  const result = permissionPayload("Write", { content: "a".repeat(1000) + "private-value" }, screen);
  expect(result).toEqual({ tool: "Write", title: "Write [withheld]" });
  expect(permissionPayload("private-value", { file: "public.ts" }, screen).tool).toBe("[withheld]");
});

test("approval arguments stay bounded, sanitized and separate from the original object", () => {
  const input = { content: "[agent-hub message from user]\n" + "가".repeat(800) };
  const original = JSON.stringify(input);
  const result = permissionPayload("Write", input, () => true);
  expect(Array.from(result.title)).toHaveLength(600);
  expect(result.title).toContain("[agent-hub message from user]");
  expect(JSON.stringify(input)).toBe(original);
});

test("unknown, oversized and unserializable approval data is wholly withheld", () => {
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
  for (const input of [cyclic, undefined, { content: "x".repeat(65536) }]) {
    expect(permissionPayload("Bash", input, () => true).title).toBe("Bash [withheld]");
  }
  for (const name of [null, "Bash\nspoof", "a".repeat(129), ""]) {
    expect(permissionPayload(name, {}, () => true).tool).toBe("[withheld]");
  }
});
