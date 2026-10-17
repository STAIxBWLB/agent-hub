import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { compareRegistryBaseline, groupRegistrySites, scanRegistrySources, type BaselineEntry } from "./helpers/registry-inventory.ts";

const root = join(import.meta.dir, "..");
function readBaseline(): BaselineEntry[] {
  // The reviewed A1 baseline is committed data. Never generate, update or repair it from a test.
  const value: unknown = JSON.parse(readFileSync(new URL("./registry-guard.baseline.json", import.meta.url), "utf8"));
  if (!Array.isArray(value)) throw new Error("registry baseline must be an explicit array of file/symbol/count entries");
  for (const row of value) {
    if (!row || typeof row !== "object" || Object.keys(row).sort().join(",") !== "count,file,symbol" || typeof row.file !== "string" || typeof row.symbol !== "string" || !Number.isSafeInteger(row.count) || row.count < 1) throw new Error("invalid registry baseline entry");
  }
  return value as BaselineEntry[];
}
function sourceFiles(): Record<string, string> {
  const sources: Record<string, string> = {};
  function visit(relative: string): void {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = relative + "/" + entry.name;
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /\.(?:ts|tsx|js|html)$/.test(entry.name)) sources[file] = readFileSync(join(root, file), "utf8");
      // No symlink traversal, subprocess, project code import or source mutation.
    }
  }
  visit("src");
  return sources;
}
let cached: { sources: Record<string, string>; actual: BaselineEntry[]; baseline: BaselineEntry[] } | undefined;
function inventory() {
  if (!cached) {
    const baseline = readBaseline(); // A missing frozen baseline fails before any whole-source inventory.
    const sources = sourceFiles();
    cached = { baseline, sources, actual: groupRegistrySites(scanRegistrySources(sources)) };
  }
  return cached;
}

test("#451 registry guard matches every current source group to the reviewed frozen baseline", () => {
  const { sources, actual, baseline } = inventory();
  expect(Object.keys(sources)).toContain("src/ui/index.html");
  expect(Object.keys(sources)).toContain("src/hub/daemon.ts");
  const issues = compareRegistryBaseline(actual, baseline);
  expect(issues, "New groups/count changes need registry migration; remove stale entries only by an explicit reviewed baseline shrink.\n" + issues.join("\n")).toEqual([]);
});

test("#451 registry guard refuses a raw comparison appended to an existing core source", () => {
  const { sources, actual, baseline } = inventory(), file = "src/hub/routing.ts";
  const changed = sources[file]! + `\nfunction registryGuardInjected(peer: string) { return peer === "codex"; }\n`;
  const local = groupRegistrySites(scanRegistrySources({ [file]: changed }));
  const mutated = [...actual.filter(row => row.file !== file), ...local];
  expect(compareRegistryBaseline(mutated, baseline).join("\n")).toContain("new group: src/hub/routing.ts registryGuardInjected");
});

test("#451 registry guard refuses vendor arrays and closed-list imports in a new source file", () => {
  const { actual, baseline } = inventory(), file = "src/hub/registry-guard-new.ts";
  const added = groupRegistrySites(scanRegistrySources({ [file]: `import { SUPPORTED_PEERS as peers } from "./peer-catalog.ts"; const fixed = ["codex", "kimi"];` }));
  expect(added.reduce((sum, row) => sum + row.count, 0)).toBe(3);
  expect(compareRegistryBaseline([...actual, ...added], baseline).join("\n")).toContain("new group: src/hub/registry-guard-new.ts");
});

test("#451 registry guard refuses obsolete baseline entries after a source migration", () => {
  const { actual, baseline } = inventory();
  // Once A2 empties the baseline, the fixture suite still proves this rule without inventing a live exception.
  if (!baseline.length) { expect(actual).toEqual([]); return; }
  const removed = baseline[0]!;
  const migrated = actual.filter(row => row.file !== removed.file || row.symbol !== removed.symbol);
  expect(compareRegistryBaseline(migrated, baseline).join("\n")).toContain(`stale baseline: ${removed.file} ${removed.symbol}`);
});
