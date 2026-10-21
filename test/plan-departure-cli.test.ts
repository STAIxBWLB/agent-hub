import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { classifyPeerCommand, liveTestRefusal } from "../src/cli/identity.ts";
import { HELP } from "../src/cli/help.ts";
const head = "a".repeat(40);
function handler() {
  // main.ts dispatches at import; run its actual SDLC command closure with a recording control port.
  const source = readFileSync(new URL("../src/cli/main.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  let body: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === "sdlc" && ts.isArrowFunction(node.initializer)) body = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(ast); expect(body).toBeDefined();
  return ts.transpileModule(`const execute = ${body!.getText(ast)}; execute();`, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
}
const source = handler();
async function run(args: string[], ok = true) {
  const requests: unknown[] = [], output: unknown[] = [];
  let connections = 0, closed = 0;
  let error: string | undefined;
  try {
    await runInNewContext(source, { args, Buffer, Number, console: { log: (value: unknown) => output.push(value) },
      fail: (message: string) => { throw new Error(message); },
      connect: async () => { connections++; return { request: async (body: unknown, timeout: number) => { requests.push({ body: JSON.parse(JSON.stringify(body)), timeout }); return { ok, error: "departure refused" }; }, close: () => { closed++; } }; },
    });
  } catch (failure) { error = (failure as Error).message; }
  return { requests, connections, closed, output, error };
}
test("#481 S2 accept-departure sends only validated structured console input", async () => {
  const result = await run(["accept-departure", "7", head, "reason", "with", "spaces"]);
  expect(result.error).toBeUndefined();
  expect(result.requests).toEqual([{ body: { t: "sdlc", op: "accept-departure", id: 7, head, reason: "reason with spaces" }, timeout: 30_000 }]);
  expect(result.connections).toBe(1); expect(result.closed).toBe(1);
  expect((await run(["accept-departure", "7", head, "x".repeat(2048)])).error).toBeUndefined();
});
test("#481 S2 accept-departure validates before opening a control connection", async () => {
  for (const args of [
    ["accept-departure"], ["accept-departure", "0", head, "reason"], ["accept-departure", "1.5", head, "reason"],
    ["accept-departure", "9007199254740992", head, "reason"], ["accept-departure", "1", "A".repeat(40), "reason"],
    ["accept-departure", "1", "short", "reason"], ["accept-departure", "1", head],
    ["accept-departure", "1", head, "   "], ["accept-departure", "1", head, "x".repeat(2049)],
  ]) { const result = await run(args); expect(result.error).toContain("usage: ahub sdlc accept-departure"); expect(result.connections).toBe(0); expect(result.requests).toEqual([]); }
});
test("#481 S2 accept-departure closes the control port after a refused write", async () => {
  const result = await run(["accept-departure", "1", head, "reviewed departure"], false);
  expect(result.error).toBe("departure refused"); expect(result.closed).toBe(1);
});
test("#481 S2 departure acceptance remains person-only including live-test delegation", () => {
  const args = ["accept-departure", "1", head, "reason"];
  expect(classifyPeerCommand("sdlc", args)).toBe("console");
  expect(liveTestRefusal("sdlc", args)).toBe(true);
  expect(liveTestRefusal("sdlc", ["status", "1"])).toBe(false);
});
test("#481 S2 help states exact person-only departure acceptance syntax", () => {
  expect(HELP.find(row => row.usage === "ahub sdlc accept-departure <task> <head> <reason...>")?.description).toContain("person only");
});
