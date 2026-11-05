import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkInventory, checkReport, type CheckedEntry } from "../scripts/lib/inventory-check.ts";

// #719 (#1180): the hard-coded values inventory had no check after it was committed, so 22 unknown keys became 1438 without anyone seeing it. `--check` passes only when every unknown key is in the
// committed baseline of known-unclassified keys, and the baseline only shrinks. The pure decisions are pinned on plain data; the real generator is run against a scratch tree and against this checkout.
const ROOT = resolve(import.meta.dir, "..");
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

const entry = (key: string, classification: string, extra: Partial<CheckedEntry> = {}): CheckedEntry => ({ key, classification, file: key.split(":")[0]!, line: 1, kind: "inline", name: "limit", value: "5", ...extra });

test("an unknown key outside the baseline is new drift; a classified key, a baseline key and a missing key are not", () => {
  const baseline = new Set(["a.ts:f:inline:x=1#0", "b.ts:g:inline:y=2#0"]);
  const ok = checkInventory([entry("a.ts:f:inline:x=1#0", "unknown"), entry("b.ts:g:inline:y=2#0", "unknown"), entry("c.ts:h:inline:z=3#0", "contract")], baseline);
  expect({ fresh: ok.fresh, settled: ok.settled, gone: ok.gone, baselineUnknown: ok.baselineUnknown }).toEqual({ fresh: [], settled: [], gone: [], baselineUnknown: 2 });
  expect(checkReport(ok)).toEqual([]);
  const drift = checkInventory([entry("a.ts:f:inline:x=1#0", "unknown"), entry("new.ts:k:inline:n=9#0", "unknown")], new Set(["a.ts:f:inline:x=1#0"]));
  expect(drift.fresh.map(row => row.key)).toEqual(["new.ts:k:inline:n=9#0"]);
});

test("the baseline only shrinks: a baseline key that is classified now, or that matches nothing, fails the check", () => {
  const settled = checkInventory([entry("a.ts:f:inline:x=1#0", "operational")], new Set(["a.ts:f:inline:x=1#0"]));
  expect(settled.settled).toEqual(["a.ts:f:inline:x=1#0"]);
  expect(checkReport(settled).join("\n")).toContain("already classified; remove it from scripts/inventory-hardcoded-values.baseline.json");
  const gone = checkInventory([], new Set(["old.ts:f:inline:x=1#0"]));
  expect(gone.gone).toEqual(["old.ts:f:inline:x=1#0"]);
  expect(checkReport(gone).join("\n")).toContain("match no inventory entry any more (the code moved or changed); remove it from the baseline, and classify any new key that replaced it");
});

test("the report names every offending key with its place and the next step, never truncates, and never tells anyone to add to the baseline", () => {
  const many = Array.from({ length: 60 }, (_, n) => entry(`f${n}.ts:c:inline:v=${n}#0`, "unknown", { line: n + 1, name: `n${n}`, value: String(n) }));
  const lines = checkReport(checkInventory(many, new Set()));
  expect(lines[0]).toBe("60 inventory keys not in scripts/inventory-hardcoded-values.classifications.json and not in the baseline:");
  expect(lines.filter(line => line.startsWith("  f"))).toHaveLength(60);                       // all of them: a list that stops early makes the next run find more
  expect(lines[1]).toBe("  f0.ts:1 inline n0 = 0   [f0.ts:c:inline:v=0#0]");
  expect(lines.join("\n")).toContain("Never add a key to the baseline: it only shrinks.");
  expect(lines.join("\n")).toContain("docs/verification/2026-10-30-operational-settings-closure.md");
  expect(checkReport(checkInventory([entry("f.ts:c:inline:v=1#0", "unknown")], new Set()))[0]).toBe("1 inventory key not in scripts/inventory-hardcoded-values.classifications.json and not in the baseline:");
});

function scratchTree(source: string, classifications: Record<string, string>, baseline: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-inventory-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "src"), { recursive: true }); mkdirSync(join(dir, "scripts/lib"), { recursive: true });
  cpSync(join(ROOT, "scripts/inventory-hardcoded-values.ts"), join(dir, "scripts/inventory-hardcoded-values.ts"));
  cpSync(join(ROOT, "scripts/lib/inventory-check.ts"), join(dir, "scripts/lib/inventory-check.ts"));
  symlink(join(ROOT, "node_modules"), join(dir, "node_modules"));
  // the generator's self-check reads src/hub/tasks.ts, so the scratch tree carries a minimal one
  mkdirSync(join(dir, "src/hub"), { recursive: true });
  writeFileSync(join(dir, "src/hub/tasks.ts"), "export const unrelated = true;\n");
  writeFileSync(join(dir, "src/code.ts"), source);
  writeFileSync(join(dir, "scripts/inventory-hardcoded-values.classifications.json"), JSON.stringify(classifications, null, 2) + "\n");
  writeFileSync(join(dir, "scripts/inventory-hardcoded-values.baseline.json"), JSON.stringify(baseline, null, 2) + "\n");
  const check = () => {
    const run = Bun.spawnSync([process.execPath, "scripts/inventory-hardcoded-values.ts", "--check"], { cwd: dir, env: { ...process.env, NO_COLOR: "1" } });
    return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
  };
  return { dir, check };
}
function symlink(target: string, path: string): void { try { require("node:fs").symlinkSync(target, path); } catch { /* a copy would do as well */ } }

const SOURCE = "export const WAIT_MS = 5000;\nexport function f(list: string[]) { return list.slice(0, 40); }\n";
const KEYS = ["src/code.ts:WAIT_MS:constant:WAIT_MS=5000#0", "src/code.ts:f:inline:list.slice=40#0"];

test("the real generator: every key classified passes, and the output names the counts", () => {
  const t = scratchTree(SOURCE, { [KEYS[0]!]: "operational", [KEYS[1]!]: "safety floor" }, []);
  const run = t.check();
  expect({ code: run.code, out: run.out.trim() }).toEqual({ code: 0, out: "inventory: OK (2 entries, 2 classified, 0 in the baseline of known-unclassified keys)" });
}, 30_000);

test("the real generator: a new constant that nobody classified fails with its place, and adding the classification passes", () => {
  const t = scratchTree(SOURCE, { [KEYS[0]!]: "operational", [KEYS[1]!]: "safety floor" }, []);
  writeFileSync(join(t.dir, "src/code.ts"), SOURCE + "export const RETRY_LIMIT = 7;\n");
  const failed = t.check();
  expect(failed.code).not.toBe(0);
  expect(failed.err).toContain("1 inventory key not in scripts/inventory-hardcoded-values.classifications.json and not in the baseline:");
  expect(failed.err).toContain("src/code.ts:3 constant RETRY_LIMIT = 7");
  expect(failed.err).toContain("Never add a key to the baseline: it only shrinks.");
  writeFileSync(join(t.dir, "scripts/inventory-hardcoded-values.classifications.json"), JSON.stringify({ [KEYS[0]!]: "operational", [KEYS[1]!]: "safety floor", "src/code.ts:RETRY_LIMIT:constant:RETRY_LIMIT=7#0": "operational" }, null, 2) + "\n");
  expect(t.check().code).toBe(0);
}, 30_000);

test("the real generator: a key in the baseline stays tolerated, until it is classified or the code changes", () => {
  const t = scratchTree(SOURCE, { [KEYS[0]!]: "operational" }, [KEYS[1]!]);
  expect(t.check().out).toContain("inventory: OK (2 entries, 1 classified, 1 in the baseline of known-unclassified keys)");
  writeFileSync(join(t.dir, "scripts/inventory-hardcoded-values.classifications.json"), JSON.stringify({ [KEYS[0]!]: "operational", [KEYS[1]!]: "safety floor" }, null, 2) + "\n");
  const settled = t.check();
  expect(settled.code).not.toBe(0);
  expect(settled.err).toContain("1 baseline key already classified; remove it from scripts/inventory-hardcoded-values.baseline.json");
  // the code changed, so the baseline key matches nothing: the person is told to remove it and classify what replaced it
  const moved = scratchTree("export const WAIT_MS = 5000;\nexport function f(list: string[]) { return list.slice(0, 50); }\n", { [KEYS[0]!]: "operational" }, [KEYS[1]!]);
  const gone = moved.check();
  expect(gone.code).not.toBe(0);
  expect(gone.err).toContain("1 baseline key match no inventory entry any more");
  expect(gone.err).toContain("1 inventory key not in scripts/inventory-hardcoded-values.classifications.json and not in the baseline:");
  expect(gone.err).toContain("src/code.ts:2 inline list.slice = 50");
}, 60_000);

test("the real generator: moving a classified line down the file changes no key, so a refactor above it is no drift", () => {
  const t = scratchTree(SOURCE, { [KEYS[0]!]: "operational", [KEYS[1]!]: "safety floor" }, []);
  writeFileSync(join(t.dir, "src/code.ts"), "// a comment\n// another\n\n" + SOURCE);
  expect(t.check().code).toBe(0);
}, 30_000);

test("this checkout: the committed classifications and baseline pass the check, no key is in both, the baseline has no duplicates, and the classifications file stays sorted JSON", () => {
  const classifications = JSON.parse(readFileSync(join(ROOT, "scripts/inventory-hardcoded-values.classifications.json"), "utf8")) as Record<string, string>;
  const baseline = JSON.parse(readFileSync(join(ROOT, "scripts/inventory-hardcoded-values.baseline.json"), "utf8")) as string[];
  expect(new Set(baseline).size).toBe(baseline.length);
  expect(baseline.filter(key => Object.hasOwn(classifications, key))).toEqual([]);            // a key is classified or baselined, never both
  expect([...baseline].sort()).toEqual(baseline);
  const keys = Object.keys(classifications);
  expect([...keys].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)).toEqual(keys);
  expect(new Set(Object.values(classifications))).toEqual(new Set(["operational", "safety floor", "contract", "test seam"]));
  const run = Bun.spawnSync([process.execPath, "scripts/inventory-hardcoded-values.ts", "--check"], { cwd: ROOT, env: { ...process.env, NO_COLOR: "1" } });
  expect({ code: run.exitCode, err: run.stderr.toString().slice(0, 400) }).toEqual({ code: 0, err: "" });
  expect(run.stdout.toString()).toMatch(/^inventory: OK \(\d+ entries, \d+ classified, \d+ in the baseline of known-unclassified keys\)\n$/);
}, 60_000);
