// Dev tooling only. These are lexical source locations, never resolved call edges.
import ts from "typescript";

export interface SymbolSpan {
  name: string;
  start: number;
  end: number;
  line: number;
  node: ts.Node;
}

export function parseSource(file: string, text: string): ts.SourceFile {
  // Inline HTML scripts keep original UTF-16 offsets and line numbers; markup is not TypeScript.
  if (/\.html?$/i.test(file)) {
    let masked = text.replace(/[^\r\n]/g, " ");
    for (const match of text.matchAll(/<script\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi)) {
      const attributes = match[1]!, script = match[2]!;
      const names = [...attributes.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g)].map(attribute => attribute[1]!.toLowerCase());
      if (names.includes("src")) continue;
      const start = match.index + "<script".length + attributes.length + 1;
      masked = masked.slice(0, start) + script + masked.slice(start + script.length);
    }
    text = masked;
  }
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

/** Named declarations, including variable-bound closures and class/object members. */
export function symbolSpans(source: ts.SourceFile): SymbolSpan[] {
  const spans: SymbolSpan[] = [];
  function visit(node: ts.Node, parents: string[]): void {
    const named = ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)
      || ts.isVariableDeclaration(node) || ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)
      || ts.isPropertyAssignment(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
      || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)
      || ts.isModuleDeclaration(node);
    // Computed keys can contain arbitrary expressions or sensitive literals; diagnostics name only their shape.
    const name = ts.isConstructorDeclaration(node) ? "constructor"
      : named && node.name && !ts.isObjectBindingPattern(node.name) && !ts.isArrayBindingPattern(node.name)
        ? ts.isComputedPropertyName(node.name) ? "[computed]" : node.name.getText(source).replace(/^['"]|['"]$/g, "") : undefined;
    const names = name ? [...parents, name] : parents;
    if (name) {
      const start = node.getStart(source);
      spans.push({ name: names.join("."), start, end: node.end, line: source.getLineAndCharacterOfPosition(start).line + 1, node });
    }
    ts.forEachChild(node, child => visit(child, names));
  }
  visit(source, []);
  return spans;
}

export function enclosingSymbol(source: ts.SourceFile, offset: number): SymbolSpan | undefined {
  return symbolSpans(source).filter(span => span.start <= offset && offset < span.end)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
}

/**
 * Nearest named function scope, ignoring ordinary local variables. Anonymous callbacks inherit their nearest
 * named enclosing function; variable/property-bound closures supply their binding's name instead.
 */
export function enclosingFunction(source: ts.SourceFile, offset: number): SymbolSpan | undefined {
  const functionScope = (node: ts.Node): boolean => {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)
      || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node)) return true;
    if (!ts.isVariableDeclaration(node) && !ts.isPropertyDeclaration(node) && !ts.isPropertyAssignment(node)) return false;
    let initializer = node.initializer;
    while (initializer && (ts.isParenthesizedExpression(initializer) || ts.isAsExpression(initializer)
      || ts.isTypeAssertionExpression(initializer) || ts.isNonNullExpression(initializer) || ts.isSatisfiesExpression(initializer))) initializer = initializer.expression;
    return !!initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer));
  };
  return symbolSpans(source).filter(span => span.start <= offset && offset < span.end && functionScope(span.node))
    .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
}

/** Return every lexical match; duplicate declarations must not silently bind to one. */
export function findSymbol(source: ts.SourceFile, name: string): SymbolSpan[] {
  return symbolSpans(source).filter(span => span.name === name);
}

/** Optional filter matches the written callee (e.g. test or object.method), without resolution. */
export function callSites(source: ts.SourceFile, name?: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && (name === undefined || node.expression.getText(source) === name)) calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return calls;
}
