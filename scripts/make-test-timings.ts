// Regenerate scripts/test-timings.json (the per-file times `bun test --shard --timings` balances the macOS shards by, #548) from a green macOS CI leg's log.
// Usage: gh api --allow-escape-sequences repos/<owner>/<repo>/actions/jobs/<macOS check job id>/logs > leg.log && bun scripts/make-test-timings.ts leg.log
// A file's time is the wall time from its `##[group]test/x.test.ts:` header to the next header (or to bun's `Ran N tests` line). The shards need only be roughly balanced: a file
// missing here still runs (Bun gives it the median time), so an old file is stale advice, never a missing test.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const log = process.argv[2];
if (!log) { console.error("usage: bun scripts/make-test-timings.ts <macOS leg log>"); process.exit(2); }
const lines = readFileSync(log, "utf8").replace(/\x1b\[[0-9;]*m/g, "").split("\n");
const heads: { at: number; file: string }[] = [];
let end = 0;
for (const line of lines) {
  const head = /^(\d{4}-\d\d-\d\dT[\d:.]+)Z ##\[group\](test\/.*\.test\.ts):$/.exec(line);
  if (head) heads.push({ at: Date.parse(`${head[1]}Z`), file: head[2]! });
  const ran = /^(\d{4}-\d\d-\d\dT[\d:.]+)Z Ran \d+ tests/.exec(line);
  if (ran) end = Date.parse(`${ran[1]}Z`);
}
if (!heads.length || !end) { console.error("no test file headers or no `Ran N tests` line: not a macOS leg log"); process.exit(1); }
const rows = heads.map((head, index) => ({ file: head.file, ms: Math.max(1, Math.round((heads[index + 1]?.at ?? end) - head.at)) }))
  .filter(row => existsSync(resolve(root, row.file)))
  .sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file));
const files: Record<string, number> = {};
for (const row of rows) files[row.file] = row.ms;
writeFileSync(resolve(root, "scripts/test-timings.json"), `${JSON.stringify({ version: 1, files }, null, 1)}\n`);
console.log(`wrote ${rows.length} files, ${(rows.reduce((sum, row) => sum + row.ms, 0) / 1000).toFixed(0)} s total, slowest ${rows[0]!.file} ${rows[0]!.ms} ms`);
