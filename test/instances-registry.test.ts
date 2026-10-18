import { expect, test } from "bun:test";
import { ADAPTERS, kindOf, definitionOf, familyOf } from "../src/adapters/registry.ts";

test("#450 explicit project declarations resolve to their native kind without global registration", () => {
  const a = { "codex-worker": { kind: "codex" } }, b = { "kimi-worker": { kind: "kimi" } };
  expect(kindOf("codex-worker")).toBeUndefined();
  expect(kindOf("codex-worker", a)).toBe("codex");
  expect(definitionOf("codex-worker", a)).toBe(definitionOf("codex"));
  expect(familyOf("codex-worker", a)).toBe(familyOf("codex"));
  expect(kindOf("codex-worker", b)).toBeUndefined();
  expect(kindOf("codex-worker")).toBeUndefined();
  expect(kindOf("codex-undeclared", a)).toBeUndefined();
});

test("#450 registry declarations cannot override builtins, invent prefixes or execute getters", () => {
  for (const definition of ADAPTERS) expect(definitionOf(definition.kind)).toBe(definition);
  expect(kindOf("codex", { codex: { kind: "kimi" } })).toBe("codex");
  expect(kindOf("unprefixed", { unprefixed: { kind: "codex" } })).toBeUndefined();
  expect(kindOf("codex-worker", { "codex-worker": { kind: "missing" } })).toBeUndefined();
  let executed = 0;
  const declarations = Object.defineProperty({}, "codex-worker", { enumerable: true, get() { executed++; return { kind: "codex" }; } });
  expect(kindOf("codex-worker", declarations as never)).toBeUndefined();
  expect(kindOf("codex-worker", Object.create({ "codex-worker": { kind: "codex" } }))).toBeUndefined();
  expect(executed).toBe(0);
});
