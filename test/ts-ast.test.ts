import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { callSites, enclosingFunction, enclosingSymbol, findSymbol, parseSource, symbolSpans } from "../scripts/lib/ts-ast.ts";

test("dev AST spans name nested closures and members without matching comments or strings (#684)", () => {
  const text = `// function phantom() {}
const prose = "function phantom() {}";
class Worker {
  run() { const guard = () => check(); return guard(); }
}
function other() { return check(); }
`;
  const source = parseSource("fixture.ts", text);
  expect(symbolSpans(source).map(span => span.name)).toEqual(["prose", "Worker", "Worker.run", "Worker.run.guard", "other"]);
  const guard = findSymbol(source, "Worker.run.guard")[0]!;
  expect(text.slice(guard.start, guard.end)).toBe("guard = () => check()");
  expect(guard.line).toBe(4);
  expect(enclosingSymbol(source, text.indexOf("check()"))?.name).toBe("Worker.run.guard");
  expect(enclosingSymbol(source, 0)).toBeUndefined();
  expect(findSymbol(source, "phantom")).toEqual([]);
});

test("dev AST reports all duplicate spans and syntactic calls without inventing resolution (#684)", () => {
  const source = parseSource("fixture.tsx", `function same() {}; function same() {};
test("literal", () => object.method()); it(\`template\`, () => test("nested", () => {}));
const view = <Button onClick={() => object.method()} />; // test("comment")
`);
  expect(findSymbol(source, "same")).toHaveLength(2);
  expect(callSites(source, "test").map(call => call.arguments[0]!.getText(source))).toEqual(['"literal"', '"nested"']);
  expect(callSites(source, "object.method")).toHaveLength(2);
  expect(callSites(source)).toHaveLength(5);
});

test("dev AST locates inline HTML functions at original offsets across script blocks (#684)", () => {
  const text = `<p>function fake() {} 한글</p>\n<script src="external.js">function ignored() {}</script>
<script>function first() { run(); }</script>\n<script type="module">const second = () => run();</script>`;
  const source = parseSource("fixture.html", text);
  expect(symbolSpans(source).map(span => span.name)).toEqual(["first", "second"]);
  expect(findSymbol(source, "first")[0]?.line).toBe(3);
  expect(enclosingSymbol(source, text.lastIndexOf("run()"))?.name).toBe("second");
  expect(callSites(source, "run")).toHaveLength(2);
});

test("the migrated registry checker recognizes literal and template test declarations (#684)", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-registry-ast-"));
  try {
    for (const directory of ["scripts/amem", "scripts/lib", "docs/plans", "test"]) mkdirSync(join(root, directory), { recursive: true });
    copyFileSync(new URL("../scripts/amem/check-registry.ts", import.meta.url), join(root, "scripts/amem/check-registry.ts"));
    copyFileSync(new URL("../scripts/lib/ts-ast.ts", import.meta.url), join(root, "scripts/lib/ts-ast.ts"));
    mkdirSync(join(root, "node_modules"));
    symlinkSync(fileURLToPath(new URL("../", import.meta.resolve("typescript"))), join(root, "node_modules/typescript"), "dir");
    const cases = Array.from({ length: 60 }, (_, index) => ({ id: `R${index}`, mode: "fixture", status: "covered" }));
    writeFileSync(join(root, "docs/plans/amem-cases.json"), JSON.stringify(cases));
    const registry = (name: string) => "## Table A\n| id | mode | status | owner | phase | evidence |\n"
      + cases.map(row => `| ${row.id} | fixture | covered | agent-hub: fixture | P1 | ` + "`test/fixture.ts` :: `" + name + "` |\n").join("") + "## Gaps\n";
    writeFileSync(join(root, "test/fixture.ts"), '/* test("comment") */ const fake = "test(ignored)"; test("literal", () => {}); it(`template ${value}`, () => {});');
    for (const name of ["literal", "template ${value}", "comment"]) {
      writeFileSync(join(root, "docs/plans/2026-10-16-amem-failure-registry.md"), registry(name));
      const result = Bun.spawnSync([process.execPath, "scripts/amem/check-registry.ts"], { cwd: root });
      expect(result.exitCode, result.stderr.toString()).toBe(name === "comment" ? 1 : 0);
      expect((name === "comment" ? result.stderr : result.stdout).toString()).toContain(name === "comment" ? "no literal test declaration" : "check-registry: OK (60 cases");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dev AST function attribution ignores scalar locals and counts predicates by named function scope (#684)", () => {
  const text = `check("module");
function run() {
  const result = check("scalar");
  [result].filter(value => check("anonymous"));
  const nested = (() => check("bound arrow"));
  const named = function inner() { return check("bound function"); };
}
class Worker {
  constructor() { check("constructor"); }
  get ready() { return check("getter"); }
  set ready(value) { check("setter"); }
  method() { const result = check("method local"); return result; }
  arrow = () => check("property arrow");
}
const object = { callback: function () { check("object callback"); } };`;
  const source = parseSource("fixture.ts", text), counts = new Map<string, number>();
  const owners = callSites(source, "check").map(call => enclosingFunction(source, call.getStart(source))?.name ?? "<module>");
  for (const owner of owners) counts.set(owner, (counts.get(owner) ?? 0) + 1);
  expect(owners).toEqual(["<module>", "run", "run", "run.nested", "run.named", "Worker.constructor", "Worker.ready", "Worker.ready", "Worker.method", "Worker.arrow", "object.callback"]);
  expect([...counts]).toEqual([["<module>", 1], ["run", 2], ["run.nested", 1], ["run.named", 1], ["Worker.constructor", 1], ["Worker.ready", 2], ["Worker.method", 1], ["Worker.arrow", 1], ["object.callback", 1]]);
  expect(enclosingSymbol(source, text.indexOf('check("scalar")'))?.name).toBe("run.result");
  expect(enclosingFunction(source, text.indexOf('check("scalar")'))?.name).toBe("run");
  expect(enclosingFunction(source, 0)).toBeUndefined();
});

test("dev AST computed declaration names never echo their expression text (#684)", () => {
  const text = `class Worker {
  [decrypt("private-expression-marker") + suffix]() { check(); }
  [lookup("private-field-marker")] = () => check();
}
const object = { [lookup("private-property-marker")]: function () { check(); } };`;
  const source = parseSource("fixture.ts", text), names = symbolSpans(source).map(span => span.name);
  expect(names).toEqual(["Worker", "Worker.[computed]", "Worker.[computed]", "object", "object.[computed]"]);
  expect(callSites(source, "check").map(call => enclosingFunction(source, call.getStart(source))?.name)).toEqual(["Worker.[computed]", "Worker.[computed]", "object.[computed]"]);
  for (const expression of ["decrypt", "lookup", "suffix", "private-expression-marker", "private-field-marker", "private-property-marker"]) expect(names.join("\n")).not.toContain(expression);
  expect(findSymbol(source, "Worker.[computed]")).toHaveLength(2);
});

test("dev AST HTML opening tags preserve offsets with quoted greater-than attributes and actual src detection (#684)", () => {
  const text = `<p>😀 한글 markup</p>\r\n<script data-note="x > y src=not-an-attribute">function first() { check(); }</script>
<script title='a > b' data-src="not-external.js">const second = () => check();</script>
<script data-note="quoted > marker" src="external>file.js">function ignored() { check(); }</script>`;
  const source = parseSource("fixture.html", text), first = findSymbol(source, "first")[0]!, second = findSymbol(source, "second")[0]!;
  expect(symbolSpans(source).map(span => span.name)).toEqual(["first", "second"]);
  expect(first.start).toBe(text.indexOf("function first")); expect(first.line).toBe(2);
  expect(second.start).toBe(text.indexOf("second =")); expect(second.line).toBe(3);
  expect(source.text.length).toBe(text.length);
  expect(source.text.slice(first.start, first.end)).toBe("function first() { check(); }");
  expect(callSites(source, "check").map(call => enclosingFunction(source, call.getStart(source))?.name)).toEqual(["first", "second"]);
  expect(findSymbol(source, "ignored")).toEqual([]);
});
