import { existsSync, readFileSync } from "node:fs";

// #1263: a fake CLI appends one JSON record per line to a trace file while the test runs. The hub recording a verdict proves the hub is done, not that the fake finished writing its last record: a
// reader that parses every line can meet a record that is half written ("SyntaxError: JSON Parse error: Unterminated string"), seen in #765's full gate. These helpers read a trace the way a
// writer that appends whole lines allows: only newline-terminated lines are records, and a tail without its newline is a write still in progress, never a record and never silently dropped.

/** The trace's records, from its newline-terminated lines only. A terminated line that is not JSON still throws: that is a real corruption, not a write in progress. */
export function completeRows(file: string): any[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line));
}

/** The text after the last newline: empty when the file ends on a record boundary, otherwise the start of a record still being written. */
export function unfinishedTail(file: string): string {
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf8");
  return text.slice(text.lastIndexOf("\n") + 1);
}

/**
 * Waits, bounded by time, until a COMPLETE record of the trace satisfies `done`, then returns every complete record. On timeout it fails naming what was seen, including a record still unfinished,
 * so a fake that never finishes reads differently from a test that looked too early.
 */
export async function untilRecord(file: string, done: (row: any) => boolean, label: string, timeoutMs = 10_000): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = completeRows(file);
    if (found.some(done)) return found;
    if (Date.now() >= deadline) {
      const tail = unfinishedTail(file);
      throw new Error(`${label}: no complete trace record matched within ${timeoutMs} ms (${found.length} complete record(s)${tail ? `, and an unfinished one of ${tail.length} bytes starting ${JSON.stringify(tail.slice(0, 60))}` : ", no unfinished tail"})`);
    }
    await Bun.sleep(5);
  }
}
