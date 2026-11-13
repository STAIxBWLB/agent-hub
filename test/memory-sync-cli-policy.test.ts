import { expect, test } from "bun:test";
import { composeMemorySyncOptions } from "../src/cli/memory.ts";

test("CLI sync preserves a caller veto and carries caller policy changes in the combined version", () => {
  let callerVersion = "caller-a";
  const callerRows: Record<string, unknown>[] = [];
  const options = composeMemorySyncOptions({ screen: () => true, policyVersion: () => "host" }, {
    screen: row => { callerRows.push(row); return false; },
    policyVersion: () => callerVersion,
  });
  expect(options.screen?.({ id: "private-id", machine: "private-machine", op: "note", text: "safe" })).toBe(false);
  expect(callerRows).toEqual([{ text: "safe" }]);
  const first = options.policyVersion?.();
  callerVersion = "caller-b";
  const second = options.policyVersion?.();
  expect(first).toBe(JSON.stringify(["host", "caller-a"]));
  expect(second).toBe(JSON.stringify(["host", "caller-b"]));
  expect(second).not.toBe(first);
});
