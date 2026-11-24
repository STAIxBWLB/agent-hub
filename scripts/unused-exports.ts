// #1649: an export of `src/` that nothing imports is dead weight, and the agent that removed the feature which used it tends to leave the helper behind for the next agent to build on. This
// collects every exported declaration under `src/` and marks each one referenced from another source file, from a test only, or from nowhere. "Nowhere" and "tests only" are findings, and they are
// kept against a shrink-only baseline (`scripts/unused-exports.baseline.json`, the rule in `scripts/lib/inventory-check.ts`): an export outside the baseline fails the check, and a baseline entry
// that is gone, or used now, must leave it, so a cleanup cannot be undone and new dead code cannot hide among the old.
//
// Modes: no argument reports the counts (what T1 measures), `--check` is the gate `scripts/check.sh` runs, and `--write-baseline` freezes the first run and afterwards only prunes: it never adds a
// key, because a new unused export is deleted or connected, not baselined.
//
// Entry points are a contract, not a use: an export of a file `package.json` names in `bin` or `exports`, or that `scripts/build.mjs` bundles by name, is reachable without an import. Dynamic use (a
// name reached only through a string) is declared with a `// used-by: <repo-relative file>` comment above the declaration, and the file it names must exist.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { checkShrinkOnly } from "./lib/inventory-check.ts";

export type Reach = "nowhere" | "tests-only";
export interface UnusedExport { file: string; name: string; reach: Reach }
/** A `// used-by:` comment that names a file this repository does not have: a declaration of a use that cannot be checked. */
export interface MissingUsedBy { file: string; name: string; target: string }
export interface ScanResult { exports: number; findings: UnusedExport[]; missingUsedBy: MissingUsedBy[] }

const BASELINE = "scripts/unused-exports.baseline.json";
const SOURCE_ROOT = "src/";
// A test is not a user: a helper only a test imports is code the product does not run.
const TEST_ROOTS = ["test/", "src/adapters/conformance/"];
// `scripts/build.mjs` builds these by name, so nothing imports them and the import graph cannot see that they are entry points.
const BUNDLED = ["src/adapters/claude-channel.ts", "src/cli/kimi-facts-hook.ts", "src/adapters/kimi-review-policy-worker.ts"];
const USED_BY = /^\/\/\s*used-by:\s*(\S+)/;

const posix = (path: string) => path.replaceAll("\\", "/");
const repoPath = (root: string, file: string) => posix(relative(root, file));
export const keyOf = (finding: { file: string; name: string }) => `${finding.file}#${finding.name}`;
const isTest = (file: string) => TEST_ROOTS.some(root => file.startsWith(root));

/** The files that are reachable without an import: `package.json` `bin` and `exports` (a `.js` target is the TypeScript source), plus the bundles `scripts/build.mjs` builds. */
export function loadEntryPoints(root: string): Set<string> {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bin?: Record<string, string>; exports?: unknown };
  const files = new Set<string>();
  const add = (target: string): void => {
    const clean = target.replace(/^\.\//, "");
    files.add(clean.endsWith(".js") ? `${clean.replace(/\.js$/, "")}.ts` : clean);
  };
  for (const target of Object.values(pkg.bin ?? {})) add(target);
  const walk = (value: unknown): void => {
    if (typeof value === "string") add(value);
    else if (value && typeof value === "object") for (const nested of Object.values(value)) walk(nested);
  };
  walk(pkg.exports);
  for (const file of BUNDLED) files.add(file);
  return files;
}

function loadProgram(root: string): ts.Program {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error(`no tsconfig.json under ${root}`);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  // `types: []` and `skipLibCheck` keep the build inside the shard's added-cost budget (#1649 AC5): this check needs the import graph, not type inference across packages.
  return ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, types: [], skipLibCheck: true, noEmit: true } });
}

/** The statement a declaration belongs to, so a `// used-by:` written above `export const x` is found even though the declaration is the inner node. */
function statementOf(node: ts.Node): ts.Node {
  return ts.isVariableDeclaration(node) ? node.parent.parent : node;
}

function usedByTargets(declaration: ts.Node): string[] {
  const sourceFile = declaration.getSourceFile();
  const text = sourceFile.getFullText();
  const statement = statementOf(declaration);
  const targets: string[] = [];
  for (const range of ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? []) {
    const match = USED_BY.exec(text.slice(range.pos, range.end).trim());
    if (match?.[1]) targets.push(match[1]);
  }
  return targets;
}

interface Declared { file: string; name: string; declaration: ts.Node }

/** Every exported declaration of a `src/` file that is not itself an entry point, keyed `file#name`. A symbol reached through a barrel or an `as` alias is the declaration it ends at. */
function declaredExports(program: ts.Program, checker: ts.TypeChecker, root: string, entryPoints: ReadonlySet<string>): Map<string, Declared> {
  const declared = new Map<string, Declared>();
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const file = repoPath(root, sourceFile.fileName);
    if (!file.startsWith(SOURCE_ROOT) || entryPoints.has(file)) continue;
    const module = checker.getSymbolAtLocation(sourceFile);
    if (!module) continue;
    for (const exported of checker.getExportsOfModule(module)) {
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const declaration = symbol.declarations?.find(node => !node.getSourceFile().isDeclarationFile);
      if (!declaration) continue;
      const owner = repoPath(root, declaration.getSourceFile().fileName);
      if (!owner.startsWith(SOURCE_ROOT) || entryPoints.has(owner)) continue;
      if (!symbol.name || symbol.name === "__export" || symbol.name === "unknown") continue;
      const key = `${owner}#${symbol.name}`;
      if (!declared.has(key)) declared.set(key, { file: owner, name: symbol.name, declaration });
    }
  }
  return declared;
}

/** How each declared export is reached: by a source file, by a test only, or by nothing. */
function collectUses(program: ts.Program, checker: ts.TypeChecker, root: string): Map<string, Set<"source" | "test">> {
  const uses = new Map<string, Set<"source" | "test">>();
  const mark = (symbol: ts.Symbol, reach: "source" | "test"): void => {
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const declaration = target.declarations?.find(node => !node.getSourceFile().isDeclarationFile);
    if (!declaration) return;
    const file = repoPath(root, declaration.getSourceFile().fileName);
    const key = `${file}#${target.name}`;
    const seen = uses.get(key) ?? new Set<"source" | "test">();
    seen.add(reach);
    uses.set(key, seen);
  };
  // A module reached as a whole (`import * as ns`, `export * from`, `import("./x.ts")`) uses whatever it exports, and the string path is no proof of which name it takes.
  const markModule = (specifier: ts.StringLiteralLike, from: ts.SourceFile, reach: "source" | "test"): void => {
    const resolved = ts.resolveModuleName(specifier.text, from.fileName, program.getCompilerOptions(), ts.sys).resolvedModule;
    const target = resolved ? program.getSourceFile(resolved.resolvedFileName) : undefined;
    if (!target || target.isDeclarationFile) return;
    const module = checker.getSymbolAtLocation(target);
    if (!module) return;
    for (const exported of checker.getExportsOfModule(module)) mark(exported, reach);
  };
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const reach = isTest(repoPath(root, sourceFile.fileName)) ? "test" : "source";
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && node.importClause) {
        const bindings = node.importClause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings) && ts.isStringLiteralLike(node.moduleSpecifier)) markModule(node.moduleSpecifier, sourceFile, reach);
        if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
          const symbol = checker.getSymbolAtLocation(element.name);
          if (symbol) mark(symbol, reach);
        }
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        if (!node.exportClause) markModule(node.moduleSpecifier, sourceFile, reach);
        else if (ts.isNamedExports(node.exportClause)) for (const element of node.exportClause.elements) {
          const symbol = checker.getSymbolAtLocation(element.name);
          if (symbol) mark(symbol, reach);
        }
      } else if (ts.isImportTypeNode(node)) {
        // `import("./x.ts").Name` in a type position is a use with no import statement: `src/hub/daemon.ts` names an adapter config that way.
        const argument = node.argument;
        const specifier = ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal) ? argument.literal : undefined;
        if (specifier) {
          const symbol = node.qualifier ? checker.getSymbolAtLocation(node.qualifier) : undefined;
          if (symbol) mark(symbol, reach);
          else markModule(specifier, sourceFile, reach);
        }
      } else if (ts.isCallExpression(node)) {
        const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require");
        const argument = node.arguments[0];
        if (dynamic && argument && ts.isStringLiteralLike(argument)) markModule(argument, sourceFile, reach);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return uses;
}

export function scan(root: string): ScanResult {
  const entryPoints = loadEntryPoints(root);
  const program = loadProgram(root);
  const checker = program.getTypeChecker();
  const declared = declaredExports(program, checker, root, entryPoints);
  const uses = collectUses(program, checker, root);
  const findings: UnusedExport[] = [];
  const missingUsedBy: MissingUsedBy[] = [];
  for (const [key, entry] of declared) {
    const targets = usedByTargets(entry.declaration);
    const missing = targets.find(target => !existsSync(join(root, target)));
    if (missing) missingUsedBy.push({ file: entry.file, name: entry.name, target: missing });
    else if (targets.length) continue;
    else {
      const reach = uses.get(key);
      if (!reach?.size) findings.push({ file: entry.file, name: entry.name, reach: "nowhere" });
      else if ([...reach].every(one => one === "test")) findings.push({ file: entry.file, name: entry.name, reach: "tests-only" });
    }
  }
  const order = (a: UnusedExport, b: UnusedExport) => a.file === b.file ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : (a.file < b.file ? -1 : 1);
  findings.sort(order);
  missingUsedBy.sort((a, b) => a.file === b.file ? (a.name < b.name ? -1 : 1) : (a.file < b.file ? -1 : 1));
  return { exports: declared.size, findings, missingUsedBy };
}

/** The lines a failing check prints, each group with its cause and the next step. Empty when the check passes. */
export function checkReport(result: ScanResult, fresh: readonly string[], gone: readonly string[]): string[] {
  const lines: string[] = [];
  const s = (n: number) => n === 1 ? "" : "s";
  const it = (n: number) => n === 1 ? "it" : "them";
  const byKey = new Map(result.findings.map(finding => [keyOf(finding), finding]));
  if (result.missingUsedBy.length) {
    lines.push(`${result.missingUsedBy.length} // used-by: comment${s(result.missingUsedBy.length)} name${result.missingUsedBy.length === 1 ? "s" : ""} a file this repository does not have:`,
      ...result.missingUsedBy.map(entry => `  ${entry.file}#${entry.name} -> ${entry.target}`),
      "Name the file that reaches the export through a string, or delete the comment.");
  }
  if (fresh.length) {
    lines.push(`${fresh.length} unused export${s(fresh.length)} not in ${BASELINE}:`,
      ...fresh.map(key => {
        const finding = byKey.get(key);
        return `  ${key}${finding ? `   [${finding.reach === "nowhere" ? "nothing imports it" : "imported by tests only"}]` : ""}`;
      }),
      "Delete the export, connect it, or declare the string that reaches it with a `// used-by: <file>` comment above the declaration.",
      "Never add a key to the baseline: it only shrinks.");
  }
  if (gone.length) {
    lines.push(`${gone.length} baseline key${s(gone.length)} match no unused export any more (the export was deleted or is used now); remove ${it(gone.length)} from ${BASELINE}:`,
      ...gone.map(key => `  ${key}`));
  }
  return lines;
}

function readBaseline(root: string): Set<string> {
  const path = join(root, BASELINE);
  if (!existsSync(path)) return new Set();
  return new Set(JSON.parse(readFileSync(path, "utf8")) as string[]);
}

function writeBaseline(root: string, keys: readonly string[]): void {
  writeFileSync(join(root, BASELINE), `${JSON.stringify([...keys].sort((a, b) => a < b ? -1 : a > b ? 1 : 0), null, 2)}\n`);
}

function main(args: readonly string[]): void {
  const root = process.cwd();
  const result = scan(root);
  const nowhere = result.findings.filter(finding => finding.reach === "nowhere").length;
  const summary = `${result.exports} exported declarations, ${result.findings.length} unused (${nowhere} nowhere, ${result.findings.length - nowhere} tests only)`;
  if (args.includes("--write-baseline")) {
    const current = new Set(result.findings.map(keyOf));
    const baseline = readBaseline(root);
    const { fresh, gone } = checkShrinkOnly(current, baseline);
    // The missing file is the freeze of a first run (#1649). Once it is there, the writer only prunes: a new finding is deleted or connected, never made permanent by a command.
    if (existsSync(join(root, BASELINE))) {
      if (fresh.length) {
        console.error([`${fresh.length} unused export${fresh.length === 1 ? "" : "s"} would enter ${BASELINE}, which only shrinks:`, ...fresh.map(key => `  ${key}`),
          "Delete the export, connect it, or declare the string that reaches it with a `// used-by: <file>` comment above the declaration."].join("\n"));
        process.exit(1);
      }
      writeBaseline(root, [...current]);
      console.log(`unused exports: baseline pruned by ${gone.length} (${current.size} key${current.size === 1 ? "" : "s"} left; ${summary})`);
      return;
    }
    writeBaseline(root, [...current]);
    console.log(`unused exports: baseline frozen with ${current.size} key${current.size === 1 ? "" : "s"} (${summary})`);
    return;
  }
  const baseline = readBaseline(root);
  const current = new Set(result.findings.map(keyOf));
  const { fresh, gone } = checkShrinkOnly(current, baseline);
  if (args.includes("--check")) {
    const lines = checkReport(result, fresh, gone);
    if (lines.length) {
      console.error(lines.join("\n"));
      process.exit(1);
    }
    console.log(`unused exports: OK (${summary}, ${baseline.size} in the baseline of known-unused)`);
    return;
  }
  console.log(`unused exports: ${summary}`);
  for (const finding of result.findings) console.log(`  ${keyOf(finding)}   [${finding.reach === "nowhere" ? "nothing imports it" : "imported by tests only"}]`);
  for (const entry of result.missingUsedBy) console.log(`  ${entry.file}#${entry.name} -> ${entry.target}   [// used-by: names a file that does not exist]`);
}

if (import.meta.main) main(process.argv.slice(2));
