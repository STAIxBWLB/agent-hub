import { expect, test } from "bun:test";
import { newEnvelope } from "../src/hub/envelope.ts";
import { supersededDeliveryReason } from "../src/hub/delivery-superseded.ts";

const task = { id: 42, owner: "codex", reviewer: "claude", state: "approved" as const };
const board = { get: (id: number) => id === 42 ? task : undefined };
const notice = (kind: "task" | "review" = "task", from = "hub", taskRecipient?: "owner" | "reviewer" | "planner") => newEnvelope(from, "private title must never appear", { kind, refs: { task: "42", ...(taskRecipient ? { taskRecipient } : {}) } });
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
  expect(supersededDeliveryReason([notice("task", "hub", "owner")], live, "pi")).toBe("superseded: task #42 owner moved");
  expect(supersededDeliveryReason([notice("review")], { get: () => ({ ...task, state: "in_progress" as const }) }, "claude")).toBe("superseded: task #42 review moved");
});

test("a kind task reminder remains live for the current in_review reviewer (#434 review)", () => {
  const current = { get: () => ({ ...task, state: "in_review" as const }) };
  expect(supersededDeliveryReason([notice("task", "hub", "reviewer")], current, "claude")).toBeUndefined();
  expect(supersededDeliveryReason([notice("task", "hub", "reviewer")], board, "claude")).toBe("superseded: task #42 approved");
  expect(supersededDeliveryReason([notice("task", "hub", "reviewer")], { get: () => ({ ...task, reviewer: "pi", state: "in_review" as const }) }, "claude")).toBe("superseded: task #42 review moved");
});


test("planner coordination and untagged legacy task notices remain held while open (#434 bot review)", () => {
  const live = { get: () => ({ ...task, state: "in_review" as const }) };
  expect(supersededDeliveryReason([notice("task", "hub", "planner")], live, "pi")).toBeUndefined();
  expect(supersededDeliveryReason([notice()], live, "pi")).toBeUndefined();
  expect(supersededDeliveryReason([notice("task", "hub", "planner")], board, "pi")).toBe("superseded: task #42 approved");
});

test("mixed and legacy row context never becomes automatic settlement authority (#434 follow-up)", async () => {
  const { deliveryTaskContext } = await import("../src/hub/delivery-superseded.ts");
  const peer = newEnvelope("pi", "private peer text", { refs: { task: "42" } });
  expect(deliveryTaskContext([notice(), peer], board, "pi")).toBe("task #42 approved");
  expect(supersededDeliveryReason([notice(), peer], board, "pi")).toBeUndefined();
  const live = { get: () => ({ ...task, state: "in_progress" as const }) };
  expect(deliveryTaskContext([peer], live, "pi")).toBe("task #42 moved");
  expect(supersededDeliveryReason([peer], live, "pi")).toBeUndefined();
  expect(deliveryTaskContext([notice()], live, "pi")).toBe("task #42 moved");
  expect(supersededDeliveryReason([notice()], live, "pi")).toBeUndefined();
});


for (const state of ["in_progress", "in_review", "changes_requested"] as const) test(`#434 an owner task offer is moot after its recipient accepted (${state})`, () => {
  const offer = notice("task", "hub", "owner"); offer.refs!.taskOffer = 2;
  const current = { get: () => ({ ...task, state, history: [{ at: 1, by: "user", event: "assigned", owner: "codex" }, { at: 2, by: "codex", event: "accepted" }] }) };
  expect(supersededDeliveryReason([offer], current, "codex")).toBe("superseded: task #42 accepted");
});

test("#434 accepted-offer settlement never consumes a live reminder, mixed row, or unaccepted offer", () => {
  const offer = notice("task", "hub", "owner"); offer.refs!.taskOffer = 2;
  const current = { get: () => ({ ...task, state: "in_progress" as const }) };
  expect(supersededDeliveryReason([offer, newEnvelope("pi", "private chat")], current, "codex")).toBeUndefined();
  expect(supersededDeliveryReason([offer], { get: () => ({ ...task, state: "proposed" as const }) }, "codex")).toBeUndefined();
  expect(supersededDeliveryReason([notice("task", "hub", "owner")], current, "codex")).toBeUndefined();
  for (const invalid of [0, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const bad = { ...offer, refs: { ...offer.refs, taskOffer: invalid } };
    expect(supersededDeliveryReason([bad], current, "codex")).toBeUndefined();
  }
  const review = notice("review", "hub", "reviewer"); review.refs!.taskOffer = 2;
  expect(supersededDeliveryReason([review], { get: () => ({ ...task, state: "in_review" as const }) }, "claude")).toBeUndefined();
});


test("#434 acceptance must be the recipient's own after its latest ownership boundary", () => {
  const offer = notice("task", "hub", "owner"); offer.refs!.taskOffer = 2;
  const ownAccept = { at: 1, by: "codex", event: "accepted" };
  const assigned = { at: 2, by: "user", event: "reassigned", owner: "codex" };
  const current = (history?: typeof ownAccept[]) => ({ get: () => ({ ...task, state: "in_review" as const, history }) });
  expect(supersededDeliveryReason([offer], current([ownAccept, assigned]), "codex")).toBeUndefined();
  expect(supersededDeliveryReason([offer], current([assigned, { at: 3, by: "user", event: "accepted" }]), "codex")).toBeUndefined();
  expect(supersededDeliveryReason([offer], current(undefined), "codex")).toBeUndefined();
  expect(supersededDeliveryReason([offer], current([assigned, { ...ownAccept, at: 3 }]), "codex")).toBe("superseded: task #42 accepted");
  const bounded = [ownAccept, ...Array.from({ length: 4096 }, () => ({ at: 2, by: "hub", event: "check result" }))];
  expect(supersededDeliveryReason([offer], current(bounded), "codex")).toBeUndefined();
});
