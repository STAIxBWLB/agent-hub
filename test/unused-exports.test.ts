import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkShrinkOnly } from "../scripts/lib/inventory-check.ts";

// #1649: an export of `src/` that nothing imports is dead weight. `--check` passes only when every finding is in the committed shrink-only baseline, and that baseline only shrinks: an export that
// nothing imports, or that only tests import, fails unless the baseline knows it, and a baseline entry that is gone or used now must leave it. The pure decisions are pinned on plain data; the real
// script is run against a scratch tree (AC1 to AC3) and against this checkout, which is what the seeded mutation in `scripts/seeds.json` turns red.
const ROOT = resolve(import.meta.dir, "..");
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

test("a shrink-only baseline: a key outside it is new drift, a baseline key with no finding must leave", () => {
  const current = new Set(["src/a.ts#x", "src/b.ts#y"]);
  const baseline = new Set(["src/b.ts#y", "src/c.ts#z"]);
  expect(checkShrinkOnly(current, baseline)).toEqual({ fresh: ["src/a.ts#x"], gone: ["src/c.ts#z"] });
  expect(checkShrinkOnly(new Set(["src/b.ts#y"]), new Set(["src/b.ts#y"]))).toEqual({ fresh: [], gone: [] });
});

const APP = "import { used } from \"./lib.ts\";\n\nexport function run(): string {\n  return used();\n}\n";
const LIB = "export const dead = \"dead\";\nexport function used(): string {\n  return \"used\";\n}\nexport const checked = \"checked\";\n";
const TEST_FILE = "import { expect, test } from \"bun:test\";\nimport { checked } from \"../src/lib.ts\";\n\ntest(\"checked is imported\", () => {\n  expect(checked).toBe(\"checked\");\n});\n";
const BASELINE = ["src/lib.ts#checked", "src/lib.ts#dead"];

function scratchTree(files: Record<string, string>, baseline: readonly string[]) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-unused-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", bin: { toy: "src/app.js" }, exports: { ".": { import: "./src/app.ts" } } }, null, 2) + "\n");
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ESNext", module: "Preserve", moduleResolution: "bundler", strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, verbatimModuleSyntax: true }, include: ["src", "test"] }, null, 2) + "\n");
  mkdirSync(join(dir, "scripts/lib"), { recursive: true });
  cpSync(join(ROOT, "scripts/unused-exports.ts"), join(dir, "scripts/unused-exports.ts"));
  cpSync(join(ROOT, "scripts/lib/inventory-check.ts"), join(dir, "scripts/lib/inventory-check.ts"));
  try { symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir"); } catch { /* a copy would do as well */ }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  writeFileSync(join(dir, "scripts/unused-exports.baseline.json"), JSON.stringify(baseline, null, 2) + "\n");
  const run = (...args: string[]) => {
    const child = Bun.spawnSync([process.execPath, "scripts/unused-exports.ts", ...args], { cwd: dir, env: { ...process.env, NO_COLOR: "1" } });
    return { code: child.exitCode, out: child.stdout.toString(), err: child.stderr.toString() };
  };
  return { dir, run, write: (path: string, text: string) => writeFileSync(join(dir, path), text) };
}

const FILES = { "src/app.ts": APP, "src/lib.ts": LIB, "test/lib.test.ts": TEST_FILE };

test("the real script: findings in the baseline pass, and the entry point named by package.json is no finding", () => {
  const t = scratchTree(FILES, BASELINE);
  const run = t.run("--check");
  expect({ code: run.code, err: run.err.trim() }).toEqual({ code: 0, err: "" });
  expect(run.out.trim()).toBe("unused exports: OK (3 exported declarations, 2 unused (1 nowhere, 1 tests only), 2 in the baseline of known-unused)");
}, 30_000);

test("AC1: an unreferenced export fails the check and is named, and baselining it is refused", () => {
  const t = scratchTree(FILES, BASELINE);
  t.write("src/lib.ts", `${LIB}export const brandNew = "nobody imports this";\n`);
  const failed = t.run("--check");
  expect(failed.code).not.toBe(0);
  expect(failed.err).toContain("1 unused export not in scripts/unused-exports.baseline.json:");
  expect(failed.err).toContain("src/lib.ts#brandNew   [nothing imports it]");
  expect(failed.err).toContain("Never add a key to the baseline: it only shrinks.");
  const grown = t.run("--write-baseline");
  expect(grown.code).not.toBe(0);
  expect(grown.err).toContain("would enter scripts/unused-exports.baseline.json, which only shrinks:");
  expect(JSON.parse(readFileSync(join(t.dir, "scripts/unused-exports.baseline.json"), "utf8"))).toEqual(BASELINE);
  // The freeze is the missing file: a first run writes what exists, and from then on the file only shrinks.
  rmSync(join(t.dir, "scripts/unused-exports.baseline.json"));
  const frozen = t.run("--write-baseline");
  expect({ code: frozen.code, out: frozen.out.trim() }).toEqual({ code: 0, out: "unused exports: baseline frozen with 3 keys (4 exported declarations, 3 unused (2 nowhere, 1 tests only))" });
  expect(t.run("--check").code).toBe(0);
}, 60_000);

test("AC2: deleting the last importer of an export the baseline does not hold fails the check", () => {
  const t = scratchTree(FILES, BASELINE);
  expect(t.run("--check").code).toBe(0);
  t.write("src/app.ts", "export function run(): string {\n  return \"used\";\n}\n");
  const failed = t.run("--check");
  expect(failed.code).not.toBe(0);
  expect(failed.err).toContain("src/lib.ts#used   [nothing imports it]");
}, 60_000);

test("AC3: removing a dead export without removing its baseline entry fails, and --write-baseline only prunes", () => {
  const t = scratchTree(FILES, BASELINE);
  t.write("src/lib.ts", LIB.replace("export const dead = \"dead\";\n", ""));
  const failed = t.run("--check");
  expect(failed.code).not.toBe(0);
  expect(failed.err).toContain("1 baseline key match no unused export any more (the export was deleted or is used now); remove it from scripts/unused-exports.baseline.json:");
  expect(failed.err).toContain("  src/lib.ts#dead");
  const pruned = t.run("--write-baseline");
  expect({ code: pruned.code, out: pruned.out.trim() }).toEqual({ code: 0, out: "unused exports: baseline pruned by 1 (1 key left; 2 exported declarations, 1 unused (0 nowhere, 1 tests only))" });
  expect(JSON.parse(readFileSync(join(t.dir, "scripts/unused-exports.baseline.json"), "utf8"))).toEqual(["src/lib.ts#checked"]);
}, 60_000);

test("a `// used-by:` comment declares a string use only when the file it names exists", () => {
  const declared = (target: string) => `// used-by: ${target}\nexport const reached = "by a string";\n`;
  const files = { ...FILES, "src/ui/index.html": "<!doctype html>\n" };
  const t = scratchTree({ ...files, "src/lib.ts": LIB.replace("export const dead", declared("src/ui/index.html") + "export const dead") }, BASELINE);
  const run = t.run("--check");
  expect({ code: run.code, err: run.err.trim() }).toEqual({ code: 0, err: "" });
  const broken = scratchTree({ ...files, "src/lib.ts": LIB.replace("export const dead", declared("src/ui/nowhere.html") + "export const dead") }, BASELINE);
  const failed = broken.run("--check");
  expect(failed.code).not.toBe(0);
  expect(failed.err).toContain("1 // used-by: comment names a file this repository does not have:");
  expect(failed.err).toContain("src/lib.ts#reached -> src/ui/nowhere.html");
}, 60_000);

test("this checkout: the committed baseline passes the check and is sorted with no duplicate", () => {
  const baseline = JSON.parse(readFileSync(join(ROOT, "scripts/unused-exports.baseline.json"), "utf8")) as string[];
  expect(new Set(baseline).size).toBe(baseline.length);
  expect([...baseline].sort()).toEqual(baseline);
  expect(baseline.every(key => key.includes("#"))).toBe(true);
  const run = Bun.spawnSync([process.execPath, "scripts/unused-exports.ts", "--check"], { cwd: ROOT, env: { ...process.env, NO_COLOR: "1" } });
  expect({ code: run.exitCode, err: run.stderr.toString().slice(0, 400) }).toEqual({ code: 0, err: "" });
  expect(run.stdout.toString()).toMatch(/^unused exports: OK \(\d+ exported declarations, \d+ unused \(\d+ nowhere, \d+ tests only\), \d+ in the baseline of known-unused\)\n$/);
}, 60_000);
