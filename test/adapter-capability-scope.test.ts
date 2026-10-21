import { expect, test } from "bun:test";
import { ADAPTERS, assertDaemonEngine, assertNativeCapabilityScope, definitionOf, type AdapterDefinition } from "../src/adapters/registry.ts";

function external(): AdapterDefinition {
  // A generic ACP fixture does not inherit the builtin-only catalog or native CLI projections.
  const { projection: _projection, cli, ...base } = definitionOf("qwen")!;
  const { entry: _entry, preview: _preview, usage: _usage, ...genericCli } = cli ?? {};
  return { ...base, cli: genericCli, kind: "fixture", family: "fixture", start: { ...base.start }, session: { idField: base.session.idField, currentId: base.session.currentId } };
}

for (const [field, set] of [
  ["start.acpCommand", (definition: AdapterDefinition) => { definition.start.acpCommand = () => ["fixture"]; }],
  ["attach.admission", (definition: AdapterDefinition) => { definition.attach = { admission: { reservedRefusal: "reserved", watchRefusal: "watch" } }; }],
  ["budget.resetSoftTokensOnResume", (definition: AdapterDefinition) => { definition.budget = { account: "fixture", resetSoftTokensOnResume: true }; }],
  ["session.crashIdentity", (definition: AdapterDefinition) => { definition.session.crashIdentity = () => ({ sessionId: "fixture" }); }],
  ["start.daemonPort pi-rpc", (definition: AdapterDefinition) => { definition.start.daemonPort = "pi-rpc"; }],
  ["routing", (definition: AdapterDefinition) => { definition.routing = { preferredTier: true }; }],
  ["reviewerVariant", (definition: AdapterDefinition) => { definition.reviewerVariant = { ...definition }; }],
] as const) test(`#451 R4 non-builtin definitions cannot claim ${field}`, () => {
  const definition = external();
  set(definition);
  expect(() => assertNativeCapabilityScope(definition)).toThrow(`${field} is restricted to fixed builtin adapter definitions`);
});

test("#451 R4 fixed builtins and ordinary generic ACP definitions retain valid metadata", () => {
  for (const definition of [...ADAPTERS, external()]) {
    expect(() => assertDaemonEngine(definition)).not.toThrow();
    expect(() => assertNativeCapabilityScope(definition)).not.toThrow();
  }
});

test("#451 R4 a builtin name cannot authorize a foreign definition's native quirk", () => {
  const definition = external(); definition.kind = "kimi";
  definition.start.acpCommand = () => ["fixture"];
  expect(() => assertNativeCapabilityScope(definition)).toThrow("start.acpCommand is restricted");
});
