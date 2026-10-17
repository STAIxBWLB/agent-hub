import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const processCalls = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]);
/** Syntactic guard for direct process APIs, their local aliases, and literal executable/argv aliases.
 * This is not interprocedural taint analysis: dynamically constructed commands and arbitrary wrappers need review.
 */
function ghSites(source: string): number[] {
  const file = ts.createSourceFile("guard.ts", source, ts.ScriptTarget.Latest, true);
  const bindings = new Map<string, ts.Expression>(), calls = new Set<string>(), namespaces = new Set(["Bun"]);
  const visit = (node: ts.Node, work: (node: ts.Node) => void) => { work(node); ts.forEachChild(node, child => visit(child, work)); };
  visit(file, node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && ["child_process", "node:child_process", "bun"].includes(node.moduleSpecifier.text)) {
      const imported = node.importClause?.namedBindings;
      if (imported && ts.isNamespaceImport(imported)) namespaces.add(imported.name.text);
      if (node.importClause?.name) namespaces.add(node.importClause.name.text);
      if (imported && ts.isNamedImports(imported)) for (const item of imported.elements) if (processCalls.has((item.propertyName ?? item.name).text)) calls.add(item.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) bindings.set(node.name.text, node.initializer);
  });
  const unwrap = (node: ts.Expression, seen = new Set<string>()): ts.Expression => {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return unwrap(node.expression, seen);
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      const value = bindings.get(node.text);
      if (value) return unwrap(value, new Set([...seen, node.text]));
    }
    return node;
  };
  const processMethod = (node: ts.Expression): boolean => {
    node = unwrap(node);
    if (ts.isIdentifier(node)) return calls.has(node.text);
    return ts.isPropertyAccessExpression(node) && processCalls.has(node.name.text) && ts.isIdentifier(unwrap(node.expression)) && namespaces.has(unwrap(node.expression).getText(file));
  };
  // Destructuring aliases from a process namespace, e.g. const { spawn: run } = Bun.
  visit(file, node => {
    if (!ts.isVariableDeclaration(node) || !ts.isObjectBindingPattern(node.name) || !node.initializer) return;
    const value = unwrap(node.initializer);
    if (!ts.isIdentifier(value) || !namespaces.has(value.text)) return;
    for (const item of node.name.elements) if (ts.isIdentifier(item.name) && processCalls.has(item.propertyName?.getText(file) ?? item.name.text)) calls.add(item.name.text);
  });
  const ghExecutable = (node: ts.Expression | undefined): boolean => {
    if (!node) return false;
    node = unwrap(node);
    if (ts.isStringLiteralLike(node)) return /^(?:.*\/)?gh(?:\s|$)/.test(node.text);
    if (ts.isArrayLiteralExpression(node)) return ghExecutable(node.elements[0] as ts.Expression | undefined);
    // spec-read resolves the fixed executable through hostExecutable("gh", ...).
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "hostExecutable") return ghExecutable(node.arguments[0]);
    return false;
  };
  const sites: number[] = [];
  visit(file, node => { if (ts.isCallExpression(node) && processMethod(node.expression) && ghExecutable(node.arguments[0])) sites.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1); });
  return sites;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(join(dir, entry.name)) : /\.(?:ts|tsx|js)$/.test(entry.name) ? [join(dir, entry.name)] : []);
}

test("gh boundary guard recognizes process aliases, Bun argv and exec helpers", () => {
  const examples = [
    'import { spawn as run } from "node:child_process"; run("gh", args);',
    'import * as cp from "node:child_process"; const run = cp.spawn; const exe = "/usr/bin/gh"; run(exe, args);',
    'const argv = ["gh", "api"]; Bun.spawn(argv);',
    'const { spawnSync: run } = Bun; run(["gh", "issue", "view", "1"]);',
    'import { execFile as execute } from "node:child_process"; const run = execute; run("gh", args);',
    'import { execSync } from "child_process"; execSync("gh issue list");',
    'import { spawn } from "node:child_process"; spawn(hostExecutable("gh", cwd), args);',
  ];
  for (const example of examples) expect(ghSites(example)).toHaveLength(1);
  expect(ghSites('import { spawn } from "node:child_process"; const label = "gh"; spawn("bun", [label]); unrelated("gh");')).toEqual([]);
});

test("authenticated gh subprocesses stay in spec-read except the tracked legacy SDLC witness", () => {
  const root = join(import.meta.dir, ".."), sites = sources(join(root, "src")).flatMap(path => ghSites(readFileSync(path, "utf8")).map(line => ({ path: relative(root, path), line })));
  expect(sites.filter(site => site.path === "src/hub/spec-read.ts")).toHaveLength(1);
  // Existing SDLC bypass is deliberately visible until FOLLOWUP #449 closes it:
  // https://github.com/STAIxBWLB/agent-hub/issues/449 . Removing this exception requires fixing that source.
  const legacy = sites.filter(site => site.path === "src/hub/sdlc.ts");
  expect(legacy).toHaveLength(1);
  expect(readFileSync(join(root, legacy[0]!.path), "utf8").split("\n")[legacy[0]!.line - 1]).toContain('spawn("gh", args');
  expect(sites.filter(site => !["src/hub/spec-read.ts", "src/hub/sdlc.ts"].includes(site.path))).toEqual([]);
});
