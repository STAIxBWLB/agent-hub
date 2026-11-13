// Regenerate scripts/test-timings.json (the per-file times `bun test --shard --timings` balances the shards by, #548) from green macOS CI shard logs.
// Usage: bun scripts/make-test-timings.ts <macOS shard log>...   (one log per shard, or one unsharded leg's log)
// Fetching the four logs of one green run is `bun scripts/refresh-test-timings.ts [run id]` (#1257 item 4), which calls this; by hand:
//   gh api --allow-escape-sequences repos/<owner>/<repo>/actions/jobs/<macOS shard job id>/logs > shard-1.log
// A file's time is the wall time from its `##[group]test/x.test.ts:` header to the next header (or to bun's `Ran N tests` line). A shard log holds only its own files, so the rows of
// several logs are merged (a file in two logs keeps the larger time). The shards need only be roughly balanced: a file missing here still runs (Bun gives it the median time), so an
// old file is stale advice, never a missing test.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface TimingRow { file: string; ms: number }

/** The per-file wall times of one log, or undefined when it is not a bun test leg log (no file header or no `Ran N tests` line). */
export function timingsFromLog(text: string): TimingRow[] | undefined {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  const heads: { at: number; file: string }[] = [];
  let end = 0;
  for (const line of lines) {
    const head = /^(\d{4}-\d\d-\d\dT[\d:.]+)Z ##\[group\](test\/.*\.test\.ts):$/.exec(line);
    if (head) heads.push({ at: Date.parse(`${head[1]}Z`), file: head[2]! });
    const ran = /^(\d{4}-\d\d-\d\dT[\d:.]+)Z Ran \d+ tests/.exec(line);
    if (ran) end = Date.parse(`${ran[1]}Z`);
  }
  if (!heads.length || !end) return undefined;
  return heads.map((head, index) => ({ file: head.file, ms: Math.max(1, Math.round((heads[index + 1]?.at ?? end) - head.at)) }));
}

/** Rows of several logs as one sorted `files` table: slowest first, a file in two logs keeps the larger time, a file that no longer exists is dropped. */
export function mergeTimings(logs: readonly (readonly TimingRow[])[], exists: (file: string) => boolean): Record<string, number> {
  const best = new Map<string, number>();
  for (const row of logs.flat()) if (exists(row.file)) best.set(row.file, Math.max(best.get(row.file) ?? 0, row.ms));
  const files: Record<string, number> = {};
  for (const [file, ms] of [...best.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) files[file] = ms;
  return files;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const paths = process.argv.slice(2);
  if (!paths.length) { console.error("usage: bun scripts/make-test-timings.ts <macOS shard log>..."); process.exit(2); }
  const logs: TimingRow[][] = [];
  for (const path of paths) {
    const rows = timingsFromLog(readFileSync(path, "utf8"));
    if (!rows) { console.error(`${path}: no test file headers or no \`Ran N tests\` line: not a macOS leg log`); process.exit(1); }
    logs.push(rows);
  }
  const files = mergeTimings(logs, (file) => existsSync(resolve(root, file)));
  const entries = Object.entries(files);
  writeFileSync(resolve(root, "scripts/test-timings.json"), `${JSON.stringify({ version: 1, files }, null, 1)}\n`);
  console.log(`wrote ${entries.length} files from ${paths.length} log${paths.length === 1 ? "" : "s"}, ${(entries.reduce((sum, [, ms]) => sum + ms, 0) / 1000).toFixed(0)} s total, slowest ${entries[0]![0]} ${entries[0]![1]} ms`);
}
