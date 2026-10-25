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
    const name = named && node.name && !ts.isObjectBindingPattern(node.name) && !ts.isArrayBindingPattern(node.name)
      ? node.name.getText(source).replace(/^['"]|['"]$/g, "") : undefined;
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
