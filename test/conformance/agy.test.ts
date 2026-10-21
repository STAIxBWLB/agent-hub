import { expect, test } from "bun:test";
import { definitionOf } from "../../src/adapters/registry.ts";
import { UNSUPPORTED } from "./enrollment.ts";

test("P4 agy declares the native pull-only contract and refuses unverified permission/recovery legs", () => {
  const adapter = definitionOf("agy")!;
  expect(adapter.transport).toBe("ws-pull"); expect(adapter.attach?.pullOnlyForms).toEqual(["tui"]);
  expect(adapter.start.create).toBeUndefined(); expect("modes" in adapter.permission).toBe(false);
  expect(adapter.session.recoveryRefusal?.({} as any)).toContain("unavailable");
});
// The real daemon + fake pull channel round-trip and fenced native hooks run in test/agy-peer.test.ts.
// Calling the kit's driven deliver/settle path would invent native acceptance for a pull-only surface.
test("P4 agy unsupported: driven headless deliver/settle, native permission acknowledgements, quota and resume", () => {
  expect(UNSUPPORTED.agy).toContain("test/agy-peer.test.ts");
  expect(UNSUPPORTED["agy:reviewer"]).toContain("agy is an implementer peer (#485)");
});
