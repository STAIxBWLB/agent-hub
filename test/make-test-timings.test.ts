import { expect, test } from "bun:test";
import { mergeTimings, timingsFromLog } from "../scripts/make-test-timings.ts";

// #1257 item 4: a shard log holds only its own files, so the weights file is the merge of the four shard logs.
const leg = (files: [string, string][], end: string) => [
  ...files.map(([file, at]) => `2026-11-07T00:${at}Z ##[group]${file}:`),
  `2026-11-07T00:${end}Z Ran 9 tests across ${files.length} files. [1s]`,
].join("\n");

test("#1257 timingsFromLog times a file from its header to the next header, and the last to the Ran line", () => {
  const rows = timingsFromLog(leg([["test/a.test.ts", "00:00.000"], ["test/b.test.ts", "00:10.500"]], "01:00.000"));
  expect(rows).toEqual([{ file: "test/a.test.ts", ms: 10_500 }, { file: "test/b.test.ts", ms: 49_500 }]);
  expect(timingsFromLog("no headers here")).toBeUndefined();
  expect(timingsFromLog("2026-11-07T00:00:00.000Z ##[group]test/a.test.ts:")).toBeUndefined();
});

test("#1257 mergeTimings merges shard logs slowest first, keeps the larger time of a repeated file and drops a file that no longer exists", () => {
  const one = timingsFromLog(leg([["test/a.test.ts", "00:00.000"], ["test/gone.test.ts", "00:05.000"]], "00:20.000"))!;
  const two = timingsFromLog(leg([["test/b.test.ts", "00:00.000"], ["test/a.test.ts", "00:30.000"]], "00:40.000"))!;
  const files = mergeTimings([one, two], (file) => file !== "test/gone.test.ts");
  expect(Object.entries(files)).toEqual([["test/b.test.ts", 30_000], ["test/a.test.ts", 10_000]]);
  expect(mergeTimings([], () => true)).toEqual({});
});
