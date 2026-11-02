import { expect, test } from "bun:test";
import { heldDeliveryHints, renderHeldHint } from "../src/hub/delivery-hints.ts";

test("held hint includes the observed revision and owner-only disposition guidance", () => {
  const held = heldDeliveryHints([{ id: "held-synthetic", revision: 7, createdAt: 1_000, senders: ["user"], kinds: ["task"] }]);
  const hint = renderHeldHint(held, 2_000, true);
  expect(hint).toContain("held-synthetic revision 7");
  expect(hint).toContain("hub_delivery_resolve");
  expect(hint).toContain("confirm completion or discard your own held row");
});

test("old hints without an observed revision remain display-only for owner disposition", () => {
  const hint = renderHeldHint({ count: 1, rows: [{ id: "legacy-held", createdAt: 1_000, senders: ["user"], kinds: ["task"] }], truncated: false }, 2_000, true);
  expect(hint).toContain("legacy-held");
  expect(hint).not.toContain("hub_delivery_resolve");
  expect(hint).toContain("no usable revision");
});

test("delivery-only hints allow owner settlement but keep retry person-only", () => {
  const held = heldDeliveryHints([{ id: "held-synthetic", revision: 3, createdAt: 1_000, senders: ["user"], kinds: ["task"] }]);
  const hint = renderHeldHint(held, 2_000, false);
  expect(hint).toContain("hub_delivery_resolve");
  expect(hint).toContain("Retry remains person-only");
});
