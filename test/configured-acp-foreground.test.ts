import { expect, test } from "bun:test";
import { configuredAcpDefinitions } from "../src/adapters/configured-acp.ts";

const config = () => ({ transport: "acp", command: "fixture-agent", args: ["stdio"], displayName: "Fixture ACP", roles: ["implementer"] });
const compile = (declarations: unknown) => configuredAcpDefinitions(declarations, []);

for (const [label, kind, command, identity] of [
  ["declared kind", "grok", "native-wrapper", undefined],
  ["native command", "fixture", "grok", undefined],
  ["absolute command", "fixture", "/opt/native/grok", undefined],
  ["native identity", "fixture", "native-wrapper", { name: "Grok", version: "1" }],
] as const) test(`Grok ${label} requires explicit --no-leader before argv termination`, () => {
  for (const args of [["agent", "stdio"], ["agent", "--no-leader=false", "stdio"], ["agent", "--no-leader", "--no-leader=false", "stdio"], ["agent", "--", "--no-leader", "stdio"]]) {
    expect(() => compile({ [kind]: { ...config(), command, ...(identity ? { identity } : {}), args } })).toThrow(/explicit --no-leader/);
  }
  const args = ["agent", "--no-leader", "stdio"];
  expect(compile({ [kind]: { ...config(), command, ...(identity ? { identity } : {}), args } })).toHaveLength(1);
});

for (const selector of ["--leader", "--leader=other", "--leader-socket", "--leader-socket=/tmp/leader.sock"]) test(`Grok refuses ${selector} even with --no-leader`, () => {
  expect(() => compile({ grok: { ...config(), command: "grok", args: ["agent", "--no-leader", selector, "stdio"] } })).toThrow(/attach\/leader/);
});

test("an empty permission map compiles exactly like an omitted one (unmanaged)", () => {
  const [omitted] = compile({ fixture: config() }), [empty] = compile({ fixture: { ...config(), permission: {} } });
  expect(empty!.permission.genericAcp).toEqual(omitted!.permission.genericAcp);
  expect(empty!.permission.genericAcp).not.toHaveProperty("modes");
});
