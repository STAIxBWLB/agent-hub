import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { callSites, enclosingFunction, parseSource } from "../scripts/lib/ts-ast.ts";

interface NativeBranch { predicate: string; function: string; count: number }
interface RatchetRow extends NativeBranch { reason: string }
const SOURCE_FILES = ["src/hub/daemon.ts", "src/hub/claude-launch-proof.ts"] as const;

/** Source text only. The daemon, launch proof and adapter implementations are never imported or executed. */
function nativeBranchCounts(inputs: Readonly<Record<string, string>>): NativeBranch[] {
  const rows = new Map<string, NativeBranch>();
  for (const [file, text] of Object.entries(inputs)) {
    const source = parseSource(file, text), native = new Map<string, string>(), generic = new Set<string>(), namespaces = new Map<string, string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const module = statement.moduleSpecifier.text, bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, module);
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const binding of bindings.elements) {
        const name = (binding.propertyName ?? binding.name).text;
        if (!/^is[A-Z]\w*Peer$/.test(name)) continue;
        if (/\/adapters\/registry\.ts$/.test(module)) { generic.add(binding.name.text); generic.add(name); }
        else if (/\/adapters\//.test(module)) native.set(binding.name.text, name);
      }
    }
    const aliases = new Map<string, ts.VariableDeclaration[]>();
    function collect(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const declarations = aliases.get(node.name.text) ?? [];
        declarations.push(node); aliases.set(node.name.text, declarations);
      }
      ts.forEachChild(node, collect);
    }
    collect(source);
    type Callee = { kind: "native"; predicate: string } | { kind: "namespace"; module: string } | { kind: "generic" };
    // Bounded lexical aliases only. Ambiguous/shadowed or mutable native aliases refuse instead of inventing a binding.
    function resolveCallee(expression: ts.Expression, seen = new Set<string>()): Callee | undefined {
      while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
        || ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression;
      if (ts.isIdentifier(expression)) {
        const name = expression.text, predicate = native.get(name), module = namespaces.get(name);
        if (predicate) return { kind: "native", predicate };
        if (generic.has(name)) return { kind: "generic" };
        if (module) return { kind: "namespace", module };
        if (seen.has(name)) return undefined;
        if (seen.size >= 8) throw new Error(`${file}: callee alias resolution exceeds 8 bindings`);
        const next = new Set(seen); next.add(name);
        const declarations = aliases.get(name) ?? [];
        const matches = declarations.flatMap(declaration => {
          const value = resolveCallee(declaration.initializer!, next);
          if (value && value.kind !== "generic" && (!ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const))) throw new Error(`${file}: native callee alias ${name} must be const`);
          return value ? [value] : [];
        });
        if (matches.length && declarations.length !== 1) throw new Error(`${file}: ambiguous callee alias ${name}`);
        return matches[0];
      }
      if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return undefined;
      const owner = resolveCallee(expression.expression, seen);
      const member = ts.isPropertyAccessExpression(expression) ? expression.name.text
        : ts.isStringLiteralLike(expression.argumentExpression) ? expression.argumentExpression.text : undefined;
      if (owner?.kind === "namespace" && /\/adapters\/registry\.ts$/.test(owner.module)) return { kind: "generic" };
      if (owner?.kind === "namespace" && /\/adapters\//.test(owner.module)) {
        if (member === undefined) throw new Error(`${file}: dynamic adapter namespace callee must be classified explicitly`);
        return /^is[A-Z]\w*Peer$/.test(member) ? { kind: "native", predicate: member } : undefined;
      }
      if (member && /^is[A-Z]\w*Peer$/.test(member) && !generic.has(member)) throw new Error(`${file}: unclassified peer predicate ${member}`);
      return undefined;
    }
    for (const call of callSites(source)) {
      const resolved = resolveCallee(call.expression), predicate = resolved?.kind === "native" ? resolved.predicate : undefined;
      if (!predicate) {
        if (ts.isIdentifier(call.expression) && /^is[A-Z]\w*Peer$/.test(call.expression.text) && !generic.has(call.expression.text)) throw new Error(`${file}: unclassified peer predicate ${call.expression.text}`);
        continue;
      }
      const owner = enclosingFunction(source, call.getStart(source))?.name ?? "<module>";
      const key = `${predicate}\n${file}:${owner}`, row = rows.get(key);
      if (row) row.count++;
      else rows.set(key, { predicate, function: `${file}:${owner}`, count: 1 });
    }
  }
  return [...rows.values()].sort((a, b) => a.function.localeCompare(b.function) || a.predicate.localeCompare(b.predicate));
}
function readRatchet(value: unknown): RatchetRow[] {
  if (!Array.isArray(value)) throw new Error("native branch ratchet must be an array");
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object" || Object.keys(row).sort().join(",") !== "count,function,predicate,reason"
      || typeof row.predicate !== "string" || !/^is[A-Z]\w*Peer$/.test(row.predicate) || typeof row.function !== "string" || !row.function.trim()
      || !Number.isSafeInteger(row.count) || row.count < 1 || typeof row.reason !== "string" || !row.reason.trim()) throw new Error("invalid native branch row: predicate, function, positive count and concrete reason required");
    const key = `${row.predicate}\n${row.function}`;
    if (seen.has(key)) throw new Error("duplicate native branch ratchet row");
    seen.add(key);
  }
  return value as RatchetRow[];
}
function ratchetDifferences(actual: NativeBranch[], reviewed: RatchetRow[]): string[] {
  const key = (row: NativeBranch) => `${row.function} ${row.predicate}`;
  const expected = new Map(reviewed.map(row => [key(row), row.count])), current = new Map(actual.map(row => [key(row), row.count]));
  const issues: string[] = [];
  for (const [name, count] of current) if (expected.get(name) !== count) issues.push(`${name}: expected ${expected.get(name) ?? 0}, found ${count}`);
  for (const [name, count] of expected) if (!current.has(name)) issues.push(`${name}: removed ${count} calls, shrink the reviewed table`);
  return issues;
}
const liveSources = () => Object.fromEntries(SOURCE_FILES.map(file => [file, readFileSync(new URL(`../${file}`, import.meta.url), "utf8")]));
const reviewedRows = () => readRatchet(JSON.parse(readFileSync(new URL("./daemon-native-branches.json", import.meta.url), "utf8")));

test("#625 native predicate/function counts equal the explicit reviewed ratchet and reasons", () => {
  const differences = ratchetDifferences(nativeBranchCounts(liveSources()), reviewedRows());
  expect(differences, differences.join("\n")).toEqual([]);
});

test("#625 native branch ratchet rejects an extra call and requires an explicit table shrink after removal", () => {
  const file = "src/hub/fixture.ts", imports = 'import { isCodexPeer } from "../adapters/codex-appserver.ts";\n';
  const original = imports + 'function run(peer) { const result = isCodexPeer(peer); return result; }';
  const rows = nativeBranchCounts({ [file]: original }).map(row => ({ ...row, reason: "Native frontend proof remains in the host until slice 2d." }));
  expect(rows).toEqual([{ predicate: "isCodexPeer", function: `${file}:run`, count: 1, reason: "Native frontend proof remains in the host until slice 2d." }]);
  expect(ratchetDifferences(nativeBranchCounts({ [file]: original.replace("return result", "return isCodexPeer(peer)") }), rows)).toEqual([`${file}:run isCodexPeer: expected 1, found 2`]);
  const removed = nativeBranchCounts({ [file]: imports + 'function run(peer) { return false; }' });
  expect(ratchetDifferences(removed, rows)).toEqual([`${file}:run isCodexPeer: removed 1 calls, shrink the reviewed table`]);
  expect(ratchetDifferences(removed, [])).toEqual([]);
  expect(() => readRatchet(rows.map(row => ({ ...row, reason: "  " })))).toThrow("concrete reason");
});

test("#625 native predicate discovery includes future imports and aliases without counting comments or text", () => {
  const file = "src/hub/fixture.ts", text = `import { isFuturePeer as checkNative } from "../adapters/future.ts";
import { isSupportedPeer } from "../adapters/registry.ts";
import * as future from "../adapters/future.ts";
function run(peer) { const result = checkNative(peer); [peer].filter(p => checkNative(p)); future.isFuturePeer(peer); isSupportedPeer(peer); }
// checkNative(peer)
const text = "checkNative(peer)";`;
  expect(nativeBranchCounts({ [file]: text })).toEqual([{ predicate: "isFuturePeer", function: `${file}:run`, count: 3 }]);
  expect(() => nativeBranchCounts({ [file]: "function run(p) { return isFuturePeer(p); }" })).toThrow("unclassified peer predicate isFuturePeer");
});

test("#625 literal namespace brackets and local const predicate aliases cannot add uncounted calls", () => {
  const file = "src/hub/fixture.ts", prefix = `import { isFuturePeer } from "../adapters/future.ts";
import * as future from "../adapters/future.ts";\n`;
  const original = prefix + "function run(peer) { return isFuturePeer(peer); }";
  const reviewed = nativeBranchCounts({ [file]: original }).map(row => ({ ...row, reason: "Reviewed native owner proof." }));
  for (const extra of [
    "future['isFuturePeer'](peer);",
    "const check = isFuturePeer; check(peer);",
    "const check = future['isFuturePeer']; const next = check; next(peer);",
    "const adapter = future; adapter['isFuturePeer'](peer);",
  ]) {
    const changed = original.replace("return isFuturePeer(peer)", extra + " return isFuturePeer(peer)");
    expect(ratchetDifferences(nativeBranchCounts({ [file]: changed }), reviewed)).toEqual([`${file}:run isFuturePeer: expected 1, found 2`]);
  }
  for (const expression of ["future[key](peer)", "const alias = future; alias[key](peer)"]) {
    expect(() => nativeBranchCounts({ [file]: prefix + `function run(peer, key) { ${expression}; }` })).toThrow("dynamic adapter namespace callee");
  }
  expect(() => nativeBranchCounts({ [file]: prefix + "function run(peer) { let check = isFuturePeer; check(peer); }" })).toThrow("must be const");
});
