import { expect, test } from "bun:test";
import { retryLaunchConnect } from "../src/hub/control-client.ts";

function clock() {
  let at = 0;
  const waits: number[] = [];
  return { waits, now: () => at, advance: (ms: number) => { at += ms; }, sleep: async (ms: number) => { waits.push(ms); at += ms; } };
}

test("launch retries transient timeouts and announces busy once within its total budget", async () => {
  const time = clock(), limits: number[] = []; let notices = 0;
  const result = await retryLaunchConnect(async timeout => {
    limits.push(timeout);
    if (limits.length === 3) return "connected";
    time.advance(timeout); throw Object.assign(new Error("timeout"), { code: "AHUB_CONNECT_TIMEOUT" });
  }, () => { notices++; }, time);
  expect(result).toBe("connected"); expect(limits).toEqual([3000, 3000, 3000]);
  expect(time.waits).toEqual([250, 500]); expect(notices).toBe(1); expect(time.now()).toBe(6750);
});

test("a perpetually busy launch exhausts 15 seconds without another attempt", async () => {
  const time = clock(), limits: number[] = [];
  const failure = Object.assign(new Error("unreachable"), { code: "AHUB_CONNECT_UNREACHABLE" });
  await expect(retryLaunchConnect(async timeout => { limits.push(timeout); time.advance(timeout); throw failure; }, () => {}, time)).rejects.toBe(failure);
  expect(time.now()).toBe(15_000); expect(limits).toEqual([3000, 3000, 3000, 3000, 250]);
  expect(time.waits).toEqual([250, 500, 1000, 1000]);
});

for (const code of [4401, 4404, 4426, 4000, undefined]) test(`launch never retries a refusal or unclassified error: ${code}`, async () => {
  const time = clock(), failure = Object.assign(new Error("refused"), { code }); let attempts = 0, notices = 0;
  await expect(retryLaunchConnect(async () => { attempts++; throw failure; }, () => { notices++; }, time)).rejects.toBe(failure);
  expect(attempts).toBe(1); expect(notices).toBe(0); expect(time.waits).toEqual([]);
});
