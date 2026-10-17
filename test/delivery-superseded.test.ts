import { expect, test } from "bun:test";
import { newEnvelope } from "../src/hub/envelope.ts";
import { supersededDeliveryReason } from "../src/hub/delivery-superseded.ts";

const task = { id: 42, owner: "codex", reviewer: "claude", state: "approved" as const };
const board = { get: (id: number) => id === 42 ? task : undefined };
const notice = (kind: "task" | "review" = "task", from = "hub") => newEnvelope(from, "private title must never appear", { kind, refs: { task: "42" } });
test("AC2: only wholly moot hub notices settle, reasons are ids-only", () => {
  const presence = newEnvelope("hub", "private memory", { kind: "presence" });
  expect(supersededDeliveryReason([notice(), notice("review"), presence], board, "claude")).toBe("superseded: task #42 approved; presence");
  expect(supersededDeliveryReason([notice(), newEnvelope("pi", "chat")], board, "claude")).toBeUndefined();
  expect(supersededDeliveryReason([notice("task", "user")], board, "claude")).toBeUndefined();
  expect(supersededDeliveryReason([], board, "claude")).toBeUndefined();
});
test("AC2: live recipient assignments/reviews and unknown references stay held", () => {
  const live = { get: () => ({ ...task, state: "in_review" as const }) };
  expect(supersededDeliveryReason([notice("review")], live, "claude")).toBeUndefined();
  expect(supersededDeliveryReason([notice()], live, "codex")).toBeUndefined();
  expect(supersededDeliveryReason([notice()], { get: () => undefined }, "codex")).toBeUndefined();
  expect(supersededDeliveryReason([notice("review")], live, "pi")).toBe("superseded: task #42 review moved");
  expect(supersededDeliveryReason([notice()], live, "pi")).toBe("superseded: task #42 no live recipient role");
  expect(supersededDeliveryReason([notice("review")], { get: () => ({ ...task, state: "in_progress" as const }) }, "claude")).toBe("superseded: task #42 review moved");
});

test("a kind task reminder remains live for the current in_review reviewer (#434 review)", () => {
  const current = { get: () => ({ ...task, state: "in_review" as const }) };
  expect(supersededDeliveryReason([notice()], current, "claude")).toBeUndefined();
  expect(supersededDeliveryReason([notice()], board, "claude")).toBe("superseded: task #42 approved");
  expect(supersededDeliveryReason([notice()], { get: () => ({ ...task, reviewer: "pi", state: "in_review" as const }) }, "claude")).toBe("superseded: task #42 no live recipient role");
});
