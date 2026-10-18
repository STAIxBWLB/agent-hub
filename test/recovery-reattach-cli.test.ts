import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { classifyPeerCommand, cliCommandLabel, liveTestRefusal } from "../src/cli/identity.ts";
import { HELP, renderHelp } from "../src/cli/help.ts";
import { definitionOf } from "../src/adapters/registry.ts";
import { operationIdPattern } from "../src/hub/recovery-store.ts";

const id = "00000000-0000-4000-8000-000000000463";
function parse(args: readonly string[]) {
  // ponytail: main.ts dispatches at import time. Extract only its pure parser until CLI parsing has its own module.
  const source = readFileSync(new URL("../src/cli/main.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const parser = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "parseRecoveryReattach");
  expect(parser).toBeDefined();
  const js = ts.transpileModule(parser!.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  return runInNewContext(`${js}; parseRecoveryReattach(args);`, { args, operationIdPattern, definitionOf });
}

test("#463 recovery reattach accepts only explicit operation and recorded peer, with no identity overrides", () => {
  for (const peer of ["codex", "claude", "pi"]) expect(parse(["reattach", id, peer])).toEqual({ id, peer });
  for (const args of [
    [], ["reattach"], ["reattach", id], ["reattach", "latest", "pi"], ["reattach", "../receipt", "pi"],
    ["reattach", id, "kimi"], ["reattach", id, "local"], ["reattach", id, "PI"], ["resume", id, "pi"],
    ["reattach", id, "pi", "--session-file", "replacement.jsonl"], ["reattach", id, "pi", "--backend", "mlx"],
    ["reattach", id, "pi", "--fresh-session"], ["reattach", id, "pi", "--yes"],
  ]) expect(parse(args)).toBeUndefined();
});

test("#463 recovery reattach is person-only and cannot use live-test delegation", () => {
  const args = ["reattach", id, "pi"];
  expect(classifyPeerCommand("recovery", args)).toBe("console");
  expect(liveTestRefusal("recovery", args)).toBe(true);
  expect(cliCommandLabel("recovery", args)).toBe("recovery reattach");
  expect(liveTestRefusal("recovery", ["status", id])).toBe(false);
  expect(liveTestRefusal("recovery", ["resume", id])).toBe(false);
});

test("#463 help names exact reattach syntax and selected-peer repair without automatic resume", () => {
  const usage = "ahub recovery reattach <operation-id> codex|claude|pi";
  const entry = HELP.find(row => row.usage === usage);
  expect(entry?.description).toContain("person only");
  expect(entry?.description).toContain("recorded session");
  expect(entry?.description).toContain("leaves the rest for recovery resume");
  expect(renderHelp(100, false, "recovery").replace(/\s+/g, " ")).toContain(usage);
});
