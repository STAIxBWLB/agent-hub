import { expect, test } from "bun:test";
import { RoomLink } from "../src/rooms/link.ts";
import { RoomStoreError, type RoomStore } from "../src/rooms/store.ts";

function link(get: () => undefined = () => undefined) {
  return new RoomLink({ store: { get } as unknown as RoomStore, name: "work" });
}

test("room link store diagnostics name clock rollback without rendering raw error text", () => {
  const error = new RoomStoreError("clock_rollback"); error.message = "private path and body canary";
  const subject = link(() => { throw error; });
  expect(subject.status()).toEqual({ state: "offline", members: 0, cause: "clock_rollback", nextStep: "Correct the system clock to the last recorded room time; room links retry automatically." });
  expect(JSON.stringify(subject.status())).not.toContain(error.message);
});

test("unknown link read failures stay unavailable and name the next check", () => {
  const subject = link(() => { throw new Error("private filesystem canary"); });
  expect(subject.status().cause).toBe("unavailable");
  expect(subject.status().nextStep).toContain("Check room storage permissions");
  expect(JSON.stringify(subject.status())).not.toContain("canary");
});

test("link retries preserve the closed clock rollback cause and status reads are observational", async () => {
  const subject = link();
  const internal = subject as unknown as { retry(session: undefined, error: unknown): void; observationTime(): number | undefined };
  internal.retry(undefined, new RoomStoreError("clock_rollback"));
  const before = subject.status();
  expect(before.cause).toBe("clock_rollback");
  internal.retry(undefined, new Error("later transport failure"));
  expect(subject.status()).toEqual(before);
  expect(subject.status()).toEqual(before);
  await subject.stop();
});

test("a backwards observation clock names rollback without taking the live transport offline", () => {
  let now = 2000;
  const subject = new RoomLink({ store: { get: () => undefined } as unknown as RoomStore, name: "work", now: () => now });
  const internal = subject as unknown as { observationTime(): number | undefined };
  expect(internal.observationTime()).toBe(2000);
  now = 1000;
  expect(internal.observationTime()).toBeUndefined();
  expect(subject.status().cause).toBe("clock_rollback");
  now = 2000;
  expect(internal.observationTime()).toBe(2000);
  expect(subject.status().cause).toBe("clock_rollback"); // A reading alone is not transport/store recovery proof.
});
