import { expect, test } from "bun:test";
import { definitionOf } from "../../src/adapters/registry.ts";

test("P4 agy declares the native pull-only contract and refuses unverified permission/recovery legs", () => {
  const adapter = definitionOf("agy")!;
  expect(adapter.transport).toBe("ws-pull"); expect(adapter.attach?.pullOnlyForms).toEqual(["tui"]);
  expect(adapter.start.create).toBeUndefined(); expect(adapter.permission.modes).toEqual({});
  expect(adapter.session.recoveryRefusal?.({} as any)).toContain("unavailable");
});
// The real daemon + fake pull channel round-trip and fenced native hooks run in test/agy-peer.test.ts.
// Calling the kit's driven deliver/settle path would invent native acceptance for a pull-only surface.
test.skip("P4 agy unsupported: driven headless deliver/settle, native permission acknowledgements, quota and resume", () => {});
