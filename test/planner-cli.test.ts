import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { HELP } from "../src/cli/help.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";

function source() {
  const text = readFileSync(new URL("../src/cli/main.ts", import.meta.url), "utf8"), ast = ts.createSourceFile("main.ts", text, ts.ScriptTarget.Latest, true);
  let task: ts.ArrowFunction | undefined, flags: ts.FunctionDeclaration | undefined, splitter: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === "task" && ts.isArrowFunction(node.initializer)) task = node.initializer;
    if (ts.isFunctionDeclaration(node) && node.name?.text === "takeFlags") flags = node;
    if (ts.isFunctionDeclaration(node) && node.name?.text === "splitPresentation") splitter = node;
    ts.forEachChild(node, visit);
  };
  visit(ast); expect(task).toBeDefined(); expect(flags).toBeDefined(); expect(splitter).toBeDefined();
  // main.ts dispatches at import. Run its real command and flag parser against a recording control port.
  return ts.transpileModule(`${flags!.getText(ast)}\n${splitter!.getText(ast)}\nconst execute=${task!.getText(ast)};execute();`, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
}
async function execute(args: string[]) {
  const calls: { op: string; args: unknown }[] = []; let error: string | undefined;
  try {
    await runInNewContext(source(), { args, console: { log: () => {} }, outputOptions: () => ({ json: false, color: false, full: false, columns: undefined }), showToolText: () => {}, fail: (message: string): never => { throw new Error(message); },
      taskOp: async (op: string, input: unknown) => { calls.push({ op, args: JSON.parse(JSON.stringify(input)) }); return "fixture"; },
    });
  } catch (failure) { error = (failure as Error).message; }
  return { calls, error };
}

test("#525 the person task-assign parser accepts the documented planner role and revision", async () => {
  const result = await execute(["assign", "7", "claude", "--role", "planner", "--revision", "12"]);
  expect(result.error).toBeUndefined(); expect(result.calls).toEqual([{ op: "task_assign_checked", args: { id: "7", peer: "claude", role: "planner", revision: 12 } }]);
  expect(classifyPeerCommand("task", ["assign", "7", "claude", "--role", "planner", "--as-user"])).toBe("console");
  const help = HELP.find(entry => entry.usage.startsWith("ahub task assign "));
  expect(help?.usage).toContain("--role owner|reviewer|planner"); expect(help?.description).toContain("person-only planner");
});

test("#525 planner CLI flags reject unknown roles and invalid revisions before sending a task mutation", async () => {
  for (const args of [
    ["assign", "7", "claude", "--role", "unknown"],
    ["assign", "7", "claude", "--role", "planner", "--revision", "-1"],
    ["assign", "7", "claude", "--role", "planner", "--revision", "9007199254740992"],
  ]) { const result = await execute(args); expect(result.error).toContain("--role owner|reviewer|planner"); expect(result.calls).toEqual([]); }
});
