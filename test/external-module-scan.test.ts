import { expect, test } from "bun:test";

const scanner = () => import("../src/adapters/external-module-scan.ts");

test("A4 source scanner ignores code-like words in messages, comments and regex literals", async () => {
  const { scanModuleSource } = await scanner();
  const source = [
    'export const message = "Function not supported; require and eval are words here";',
    "const quoted = 'import(other); require(thing)';",
    "// eval('not code'); import(dynamic);",
    "/* const load = require; new Function('no'); */",
    "const pattern = /Function|require|eval|import\\(/;",
    "if (true) /Function/.test(message);",
  ].join("\n");
  expect(scanModuleSource(source)).toEqual([]);
});

test("A4 source scanner returns immutable static import records without imposing the host allowlist", async () => {
  const { scanModuleSource } = await scanner();
  const imports = scanModuleSource('import {readFileSync} from "node:fs"; import {ADAPTER_API} from "@staix/agent-hub/adapter"; export {x} from "./root-still-validates-this.js";');
  expect(imports.map(record => [record.path, record.kind])).toEqual([
    ["node:fs", "import-statement"], ["@staix/agent-hub/adapter", "import-statement"], ["./root-still-validates-this.js", "import-statement"],
  ]);
  expect(Object.isFrozen(imports)).toBe(true);
  expect(imports.every(record => Object.isFrozen(record))).toBe(true);
});

for (const source of [
  'await import("node:fs");',
  "const name = 'node:fs'; await import(name);",
  "const name = 'node:fs'; await import /* interposed */ (name);",
  'require("node:fs");',
  "const name = 'node:fs'; require(name);",
  'require.resolve("node:fs");',
  "const load = require; load('node:fs');",
  "const {createRequire: load} = await import('node:module');",
  'import {createRequire} from "node:module"; const load=createRequire(import.meta.url);',
  'import.meta.require("node:fs");',
  "const load=import.meta.require; load('node:fs');",
  "import.meta['require']('node:fs');",
  "eval('1');",
  "const ratio = 1 / eval('1');",
  "const run=eval; run('1');",
  "(0, eval)('1');",
  "globalThis['eval']('1');",
  "new Function('return 1')();",
  "const Compile=Function; Compile('return 1')();",
  "globalThis['Function']('return 1')();",
]) test("A4 source scanner refuses detectable dynamic or CJS execution: " + source, async () => {
  const { scanModuleSource } = await scanner();
  expect(() => scanModuleSource(source)).toThrow("external adapter:");
});

test("A4 source scanner inspects template expressions while ignoring template text", async () => {
  const { scanModuleSource } = await scanner();
  const tick = String.fromCharCode(96);
  expect(scanModuleSource("const text = " + tick + "Function require eval import(x)" + tick + ";")).toEqual([]);
  expect(() => scanModuleSource("const text = " + tick + "message " + "$" + "{eval('1')}" + tick + ";")).toThrow("external adapter:");
  expect(() => scanModuleSource("const text = " + tick + "outer " + "$" + "{" + tick + "inner " + "$" + "{require(name)}" + tick + "}" + tick + ";")).toThrow("external adapter:");
});

test("A4 source scanner syntax failures withhold the original diagnostic body", async () => {
  const { scanModuleSource } = await scanner();
  let message = "";
  try { scanModuleSource('export const PRIVATE_SCAN_CANARY = ;'); } catch (error) { message = (error as Error).message; }
  expect(message).toContain("external adapter:");
  expect(message).not.toContain("PRIVATE_SCAN_CANARY");
});
