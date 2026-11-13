import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStartupEventSeeds } from "../src/hub/startup-event-seeds.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const row = (outcome: string) => JSON.stringify({ v: 1, at: "2026-11-14T00:00:00Z", type: "reviewer_accounting", peer: "kimi-review", attempt: "a".repeat(32), outcome });
test("startup accounting retains starts and terminals and distinguishes damaged replay", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-startup-accounting-")); roots.push(root); const file = join(root, "events.jsonl");
  expect(readStartupEventSeeds(file).complete).toBe(true);
  writeFileSync(file, row("started") + "\n" + row("complete") + "\n");
  expect(readStartupEventSeeds(file, { bufferBytes: 7 })).toMatchObject({ complete: true, readPasses: 1 });
  expect(readStartupEventSeeds(file).events).toHaveLength(2);
  writeFileSync(file, row("started") + "\n" + '{"broken":');
  expect(readStartupEventSeeds(file)).toMatchObject({ complete: false });
  expect(readStartupEventSeeds(file).events).toHaveLength(1);
  writeFileSync(file, row("complete")); // Preserve legacy accepted final rows, but don't certify complete accounting.
  expect(readStartupEventSeeds(file)).toMatchObject({ complete: false });
  expect(readStartupEventSeeds(file).events).toHaveLength(1);
  writeFileSync(file, "not JSON\n" + row("started") + "\n");
  expect(readStartupEventSeeds(file).complete).toBe(false);
});
