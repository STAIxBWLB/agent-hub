import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeRows, unfinishedTail, untilRecord } from "./helpers/jsonl-trace.ts";

// #1263: test/role-stage-daemon-345.test.ts parsed every line of the fake reviewer's trace as soon as the task read "approved", and met a record the fake was still writing
// ("SyntaxError: JSON Parse error: Unterminated string", #765's full gate). These tests pin the reading rules the fix relies on, and reproduce the race with a writer that is slow on purpose.
const dirs: string[] = [];
const file = () => { const dir = mkdtempSync(join(tmpdir(), "ahub-jsonl-trace-")); dirs.push(dir); return join(dir, "trace.jsonl"); };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
// The reader that failed: every line parsed, a tail included.
const oldRows = (path: string): any[] => require("node:fs").readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line: string) => JSON.parse(line));

test("completeRows reads only newline-terminated lines, so a record being written is not a record yet", () => {
  const path = file();
  expect(completeRows(path)).toEqual([]);                                     // no file yet
  writeFileSync(path, '{"a":1}\n{"b":2}\n{"c":"unterminat');
  expect(completeRows(path)).toEqual([{ a: 1 }, { b: 2 }]);
  expect(unfinishedTail(path)).toBe('{"c":"unterminat');
  appendFileSync(path, 'ed"}\n');
  expect(completeRows(path)).toEqual([{ a: 1 }, { b: 2 }, { c: "unterminated" }]);
  expect(unfinishedTail(path)).toBe("");
});

test("a terminated line that is not JSON still throws: only an unfinished tail is excused, a real corruption is never hidden", () => {
  const path = file();
  writeFileSync(path, '{"a":1}\nnot json at all\n{"b":2}\n');
  expect(() => completeRows(path)).toThrow();
  writeFileSync(path, '{"a":1}\n{"b":2\n');                                   // a terminated but truncated record is corruption too
  expect(() => completeRows(path)).toThrow();
});

test("the old reader fails on a half-written record, and untilRecord waits for the writer to finish it (the #1263 race)", async () => {
  const path = file();
  const record = JSON.stringify({ show: { ok: true }, review: { ok: true, note: "x".repeat(4000) } });
  writeFileSync(path, JSON.stringify({ argv: ["exec"], prompt: "p".repeat(4000), peer: "codex-review" }) + "\n");
  appendFileSync(path, record.slice(0, 2000));                                  // the fake is mid-write: the first half of its completion record
  expect(() => oldRows(path)).toThrow(/JSON Parse error/);                      // what the test used to do
  setTimeout(() => appendFileSync(path, record.slice(2000) + "\n"), 150);       // the writer finishes later
  const started = Date.now();
  const rows = await untilRecord(path, row => row.review !== undefined, "completion record");
  expect(Date.now() - started).toBeGreaterThanOrEqual(100);                     // it really waited
  expect(rows).toHaveLength(2);
  expect(rows.find(row => row.argv)?.peer).toBe("codex-review");                // and the assertion's data is intact
});

test("untilRecord returns at once when the record is already complete, and ignores complete rows that do not match", async () => {
  const path = file();
  writeFileSync(path, '{"argv":["exec"]}\n{"x":1}\n');
  const started = Date.now();
  expect(await untilRecord(path, row => row.argv !== undefined, "argv row")).toHaveLength(2);
  expect(Date.now() - started).toBeLessThan(100);
  await expect(untilRecord(path, row => row.review !== undefined, "completion record", 120)).rejects.toThrow(/completion record: no complete trace record matched within 120 ms \(2 complete record\(s\), no unfinished tail\)/);
});

test("a writer that never finishes is reported as an unfinished record, not as a missing one", async () => {
  const path = file();
  writeFileSync(path, '{"argv":["exec"]}\n{"show":{"ok":true},"revi');
  await expect(untilRecord(path, row => row.review !== undefined, "completion record", 120))
    .rejects.toThrow(/1 complete record\(s\), and an unfinished one of \d+ bytes starting "\{\\"show\\":\{\\"ok\\":true\},\\"revi"/);
});

test("the role-stage test waits on the trace through untilRecord and no longer parses the reviewer trace directly", () => {
  const source = require("node:fs").readFileSync(join(import.meta.dir, "role-stage-daemon-345.test.ts"), "utf8") as string;
  expect(source).toContain("untilRecord(f.reviewCalls");
  expect(source).toContain("untilRecord(f.claudeCalls");
  expect(source).not.toMatch(/rows\(f\.reviewCalls\)/);
  expect(source).not.toMatch(/rows\(f\.claudeCalls\)/);
});
