import { expect, test } from "bun:test";
import { InboxPolling } from "../src/hub/inbox-polling.ts";

test("three empty reads advise once per streak, scoped by peer and ten-minute window (#681)", () => {
  const polling = new InboxPolling();
  expect(polling.read("reader", true, false, 0)).toBeUndefined();
  expect(polling.read("reader", true, false, 60_000)).toBeUndefined();
  expect(polling.read("other", true, false, 60_000)).toBeUndefined();
  expect(polling.read("reader", true, false, 120_000)).toEqual({ count: 3, minutes: 2, notice: true });
  expect(polling.read("reader", true, false, 180_000)).toEqual({ count: 4, minutes: 3, notice: false });
  expect(polling.read("reader", true, false, 800_001)).toBeUndefined();
  expect(polling.read("reader", true, false, 800_002)).toBeUndefined();
  expect(polling.read("reader", true, false, 800_003)?.notice).toBe(true);
});

test("a delivery, assignment, explicit reset or restart breaks the streak (#681)", () => {
  for (const reset of ["delivery", "assignment", "explicit", "restart"]) {
    let polling = new InboxPolling();
    polling.read("reader", true, false, 0); polling.read("reader", true, false, 1);
    if (reset === "explicit") polling.reset("reader");
    else if (reset === "restart") polling = new InboxPolling();
    else expect(polling.read("reader", reset !== "delivery", reset === "assignment", 2)).toBeUndefined();
    expect(polling.read("reader", true, false, 3)).toBeUndefined();
    expect(polling.read("reader", true, false, 4)).toBeUndefined();
    expect(polling.read("reader", true, false, 5)?.notice).toBe(true);
  }
});

test("a rolling ten-minute window catches three reads spanning the original window boundary (#681)", () => {
  const polling = new InboxPolling();
  for (const minute of [0, 9, 11]) expect(polling.read("reader", true, false, minute * 60_000)).toBeUndefined();
  expect(polling.read("reader", true, false, 12 * 60_000)).toEqual({ count: 3, minutes: 3, notice: true });
});

test("high-rate empty reads retain a bounded recent window and one notice (#681)", () => {
  const polling = new InboxPolling();
  let notices = 0;
  let result: ReturnType<InboxPolling["read"]>;
  for (let i = 0; i < 1000; i++) {
    result = polling.read("reader", true, false, i);
    if (result?.notice) notices++;
  }
  expect(result!).toEqual({ count: 64, minutes: 0, notice: false });
  expect(notices).toBe(1);
});
