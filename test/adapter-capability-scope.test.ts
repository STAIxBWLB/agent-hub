import { expect, test } from "bun:test";
import { ADAPTERS, assertDaemonEngine, assertNativeCapabilityScope, definitionOf, isFixedBuiltinDefinition, type AdapterDefinition } from "../src/adapters/registry.ts";

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
  ["session.nativeRevert", (definition: AdapterDefinition) => { definition.session.nativeRevert = true; }],
  ["session.crashIdentity", (definition: AdapterDefinition) => { definition.session.crashIdentity = () => ({ sessionId: "fixture" }); }],
  ["start.daemonPort pi-rpc", (definition: AdapterDefinition) => { definition.start.daemonPort = "pi-rpc"; }],
  ["routing", (definition: AdapterDefinition) => { definition.routing = { preferredTier: true }; }],
  ["reviewerVariant", (definition: AdapterDefinition) => { definition.reviewerVariant = { ...definition }; }],
  ["instances.nativeHome", (definition: AdapterDefinition) => { definition.instances = { mode: "headless", nativeHome: true }; }],
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


test("#625 fixed builtin proof authority uses object identity including reviewer and implementer variants", () => {
  for (const definition of ADAPTERS) {
    expect(isFixedBuiltinDefinition(definition)).toBe(true);
    if (definition.reviewerVariant) expect(isFixedBuiltinDefinition(definition.reviewerVariant)).toBe(true);
    if (definition.headlessVariant) expect(isFixedBuiltinDefinition(definition.headlessVariant)).toBe(true);
    expect(isFixedBuiltinDefinition({ ...definition })).toBe(false);
  }
  expect(isFixedBuiltinDefinition(undefined)).toBe(false);
  const forged = external(); forged.kind = "codex";
  expect(isFixedBuiltinDefinition(forged)).toBe(false);
});

test("#625 a configured nativeRevert declaration is refused even when explicitly false or undefined", () => {
  for (const value of [true, false, undefined]) {
    const definition = external(); definition.session.nativeRevert = value;
    expect(() => assertNativeCapabilityScope(definition)).toThrow("session.nativeRevert is restricted");
  }
});
