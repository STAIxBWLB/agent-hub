import { expect, test } from "bun:test";
import { callSites, enclosingSymbol, findSymbol, parseSource, symbolSpans } from "../scripts/lib/ts-ast.ts";

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
