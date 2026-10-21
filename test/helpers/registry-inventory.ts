import ts from "typescript";
import { posix } from "node:path";

// #451 A0's 265 sites were double-quote grep matches at 71253098. This inventory counts AST nodes,
// includes inline dashboard scripts, and attributes stable lexical symbols on the reviewed A1 base.
// Reconcile that explicit drift when freezing the baseline; do not regenerate it during a test.
// A2 has no policy baseline entries; the three cross-release literal probes are classified separately.

export interface InventorySite {
  file: string;
  symbol: string;
  line: number;
  pattern: "comparison" | "kind-aware-comparison" | "closed-list-import" | "vendor-literal" | "vendor-default" | "vendor-argument" | "peer-id-predicate" | "vendor-regex" | "native-instanceof";
  text: string;
}
export interface BaselineEntry { file: string; symbol: string; count: number }
const VENDORS = new Set(["claude", "codex", "kimi", "pi", "local", "qwen", "jcode", "agy"]);
const CLOSED_EXPORTS = new Set([
  "KNOWN_PEERS", "OPTIONAL_PEERS", "SUPPORTED_PEERS", "PLANNER_PEERS", "KnownPeer", "isKnownPeer", "isSupportedPeer",
  "START_MODE_PEERS", "STARTABLE_PEERS", "StartablePeer", "isStartablePeer", "KIMI_MODE_IDS", "QWEN_MODE_IDS",
]);
const CLOSED_MODULE = /(?:^|\/)(?:peer-catalog|start-mode|permission-mode)(?:\.ts)?$/;
const equality = new Set([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken]);
const peerName = (name: string) => /^(?:peer(?:Id)?|kind|owner|reviewer|sender|recipient|targetPeer|sourcePeer|peerIds|peers)$/i.test(name);
const peerValue = (value: string | undefined) => value !== undefined && (VENDORS.has(value) || value.endsWith("-") && VENDORS.has(value.slice(0, -1)));
function vendorRegex(pattern: string): boolean {
  // Exact native identities (including optional instance suffixes), never vendor prose or a filename prefix.
  if (!pattern.startsWith("^") || !pattern.endsWith("$")) return false;
  const body = pattern.slice(1, -1);
  const alternatives = body.replace(/^\(\?:([^()]*)\)$/, "$1").split("|");
  if (alternatives.every(value => VENDORS.has(value))) return true;
  return [...VENDORS].some(kind => body === `${kind}(?:-[a-z0-9-]+)?`);
}
function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}
function literal(node: ts.Expression): string | undefined {
  node = unwrap(node);
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}
/** Bind only the supplied source strings. No library, filesystem or executable evaluation participates. */
function sourceBindings(inputs: Readonly<Record<string, string>>) {
  const canonical = (file: string) => posix.resolve("/", file.replaceAll("\\", "/"));
  const texts = new Map(Object.entries(inputs).map(([file, source]) => [canonical(file), source]));
  const parsed = new Map([...texts].map(([file, source]) => [file, ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS)]));
  const options: ts.CompilerOptions = { noLib: true, allowJs: true, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
  const host: ts.CompilerHost = {
    getSourceFile: file => parsed.get(canonical(file)),
    getDefaultLibFileName: () => "", writeFile: () => {}, getCurrentDirectory: () => "/",
    getDirectories: () => [], getCanonicalFileName: file => canonical(file), useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
    fileExists: file => texts.has(canonical(file)), readFile: file => texts.get(canonical(file)), realpath: file => canonical(file),
    directoryExists: directory => { const prefix = canonical(directory).replace(/\/$/, "") + "/"; return [...texts.keys()].some(file => file.startsWith(prefix)); },
  };
  host.resolveModuleNames = (names, containingFile) => names.map(name => name.startsWith(".") ? ts.resolveModuleName(name, containingFile, options, host).resolvedModule : undefined);
  const program = ts.createProgram([...parsed.keys()], options, host), checker = program.getTypeChecker();
  const valueOf = (expression: ts.Expression, seen = new Set<ts.Symbol>()): string | undefined => {
    const node = unwrap(expression), direct = literal(node);
    if (direct !== undefined) return direct;
    if (!ts.isIdentifier(node) || seen.size >= 32) return undefined;
    let symbol = checker.getSymbolAtLocation(node);
    if (!symbol || seen.has(symbol)) return undefined;
    seen.add(symbol);
    const imported = !!(symbol.flags & ts.SymbolFlags.Alias);
    if (imported) {
      symbol = checker.getAliasedSymbol(symbol);
      if (seen.has(symbol)) return undefined;
      seen.add(symbol);
    }
    // Script files share TypeScript's global symbol table; only an actual import may cross a supplied file boundary.
    const declaration = imported ? symbol.valueDeclaration : symbol.declarations?.find(declaration => declaration.getSourceFile() === node.getSourceFile());
    if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name) || !declaration.initializer
      || !ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)) return undefined;
    return valueOf(declaration.initializer, seen);
  };
  const member = (expression: ts.Expression): { owner: ts.Expression; name: string } | undefined => {
    const node = unwrap(expression);
    if (ts.isPropertyAccessExpression(node)) return { owner: unwrap(node.expression), name: node.name.text };
    if (ts.isElementAccessExpression(node) && node.argumentExpression) {
      const name = valueOf(node.argumentExpression);
      if (name !== undefined) return { owner: unwrap(node.expression), name };
    }
    return undefined;
  };
  const peerBinding = (declaration: ts.Node | undefined): boolean => {
    if (!declaration || !ts.isParameter(declaration) && !ts.isVariableDeclaration(declaration) && !ts.isBindingElement(declaration)) return false;
    if (ts.isIdentifier(declaration.name) && peerName(declaration.name.text)) return true;
    const type = "type" in declaration ? declaration.type as ts.TypeNode | undefined : undefined;
    return !!type && /\b(?:PeerId|KnownPeer|StartablePeer|AdapterKind)\b/.test(type.getText());
  };
  const peerExpression = (expression: ts.Expression, seen = new Set<ts.Symbol>()): boolean => {
    const node = unwrap(expression);
    const access = member(node);
    if (access) return peerName(access.name);
    if (!ts.isIdentifier(node)) return false;
    const symbol = checker.getSymbolAtLocation(node);
    if (peerName(node.text) || symbol?.declarations?.some(peerBinding)) return true;
    if (!symbol || seen.has(symbol) || seen.size >= 32) return false;
    seen.add(symbol);
    return !!symbol.declarations?.some(declaration => ts.isVariableDeclaration(declaration) && declaration.initializer
      && ts.isVariableDeclarationList(declaration.parent) && !!(declaration.parent.flags & ts.NodeFlags.Const)
      && peerExpression(declaration.initializer, seen));
  };
  const peerArgument = (call: ts.CallExpression | ts.NewExpression, index: number): boolean => {
    const declaration = checker.getResolvedSignature(call)?.declaration;
    if (!declaration?.parameters.length) return false;
    const parameter = declaration.parameters[Math.min(index, declaration.parameters.length - 1)];
    if (!parameter || !ts.isParameter(parameter) || index >= declaration.parameters.length && !parameter.dotDotDotToken) return false;
    return peerBinding(parameter);
  };
  const adapterImport = (declaration: ts.Node): boolean => {
    let node: ts.Node | undefined = declaration;
    while (node && !ts.isImportDeclaration(node)) node = node.parent;
    if (!node || !ts.isStringLiteral(node.moduleSpecifier)) return false;
    const target = posix.normalize(posix.join(posix.dirname(node.getSourceFile().fileName), node.moduleSpecifier.text));
    return target.startsWith("/src/adapters/");
  };
  const nativeConstructor = (expression: ts.Expression, seen = new Set<ts.Symbol>()): boolean => {
    const node = unwrap(expression);
    const access = member(node);
    if (access && /Peer$/.test(access.name)) {
      const owner = access.owner;
      if (ts.isIdentifier(owner) && checker.getSymbolAtLocation(owner)?.declarations?.some(declaration => ts.isNamespaceImport(declaration) && adapterImport(declaration))) return true;
    }
    const symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node);
    if (!symbol || seen.has(symbol) || seen.size >= 32) return false;
    seen.add(symbol);
    const nativeClass = (declaration: ts.Declaration): boolean => {
      if (!ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration)) return false;
      if (declaration.getSourceFile().fileName.startsWith("/src/adapters/") && /Peer$/.test(declaration.name?.text ?? "")) return true;
      return !!declaration.heritageClauses?.some(clause => clause.token === ts.SyntaxKind.ExtendsKeyword
        && clause.types.some(type => nativeConstructor(type.expression, seen)));
    };
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isImportSpecifier(declaration) && !declaration.isTypeOnly && /Peer$/.test((declaration.propertyName ?? declaration.name).text) && adapterImport(declaration)) return true;
      if (nativeClass(declaration)) return true;
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isVariableDeclarationList(declaration.parent)
        && declaration.parent.flags & ts.NodeFlags.Const && nativeConstructor(declaration.initializer, seen)) return true;
    }
    if (symbol.flags & ts.SymbolFlags.Alias) {
      const target = checker.getAliasedSymbol(symbol);
      return target !== symbol && !!target.declarations?.some(nativeClass);
    }
    return false;
  };
  return { parsed: (file: string) => parsed.get(canonical(file))!, valueOf, member, peerBinding, peerExpression, peerArgument, nativeConstructor };
}
function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isComputedPropertyName(node)) return literal(node.expression);
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
}
/** Resolve only actual registry import bindings; a same-spelled local or parameter is not registry evidence. */
function trustedResolvers(file: string, parsed: ts.SourceFile): (call: ts.CallExpression) => "kindOf" | "definitionOf" | undefined {
  const imports = new Map<string, "kindOf" | "definitionOf">();
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
    if (posix.normalize(posix.join(posix.dirname(file), statement.moduleSpecifier.text)) !== "src/adapters/registry.ts") continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const entry of bindings.elements) {
      const imported = (entry.propertyName ?? entry.name).text;
      if (!entry.isTypeOnly && (imported === "kindOf" || imported === "definitionOf")) imports.set(entry.name.text, imported);
    }
  }
  const scopes = new Map<ts.Node, Set<string>>();
  const binding = (scope: ts.Node, name: ts.BindingName) => {
    if (ts.isIdentifier(name)) {
      let names = scopes.get(scope); if (!names) { names = new Set(); scopes.set(scope, names); } names.add(name.text);
    } else for (const element of name.elements) if (ts.isBindingElement(element)) binding(scope, element.name);
  };
  const isFunction = (node: ts.Node): boolean => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
  const scopeOf = (node: ts.Node, functionScoped = false): ts.Node => {
    let scope = node.parent;
    while (!ts.isSourceFile(scope) && !isFunction(scope) && (functionScoped || !ts.isBlock(scope) && !ts.isCaseBlock(scope) && !ts.isForStatement(scope) && !ts.isForInStatement(scope) && !ts.isForOfStatement(scope) && !ts.isCatchClause(scope))) scope = scope.parent;
    return scope;
  };
  const collect = (node: ts.Node): void => {
    if (ts.isParameter(node)) binding(node.parent, node.name);
    else if (ts.isVariableDeclaration(node)) {
      if (ts.isCatchClause(node.parent)) binding(node.parent, node.name);
      else binding(scopeOf(node, ts.isVariableDeclarationList(node.parent) && !(node.parent.flags & ts.NodeFlags.BlockScoped)), node.name);
    } else if (ts.isFunctionDeclaration(node) && node.name) binding(scopeOf(node), node.name);
    else if (ts.isFunctionExpression(node) && node.name) binding(node, node.name);
    else if (ts.isClassDeclaration(node) && node.name) binding(scopeOf(node), node.name);
    else if (ts.isClassExpression(node) && node.name) binding(node, node.name);
    ts.forEachChild(node, collect);
  };
  collect(parsed);
  return call => {
    const callee = unwrap(call.expression);
    if (!ts.isIdentifier(callee)) return undefined;
    const imported = imports.get(callee.text); if (!imported) return undefined;
    for (let scope: ts.Node | undefined = call; scope; scope = scope.parent) if (scopes.get(scope)?.has(callee.text)) return undefined;
    return imported;
  };
}
function kindAware(node: ts.Expression, resolver: ReturnType<typeof trustedResolvers>): boolean {
  node = unwrap(node);
  if (ts.isCallExpression(node) && resolver(node) === "kindOf") return true;
  if (ts.isPropertyAccessExpression(node) && node.name.text === "kind") {
    const owner = unwrap(node.expression);
    return ts.isCallExpression(owner) && resolver(owner) === "definitionOf";
  }
  return false;
}
/** A lexical scope name, never an unstable line number or a nearby textual variable. */
function enclosingSymbol(node: ts.Node, prefix: string): string {
  const names: string[] = [];
  for (let current: ts.Node | undefined = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
    let name: string | undefined;
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) name = current.name?.text;
    else if (ts.isMethodDeclaration(current) || ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current)) name = propertyName(current.name);
    else if (ts.isConstructorDeclaration(current)) name = "constructor";
    else if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) name = current.name?.text;
    else if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) name = current.name.text;
    else if ((ts.isPropertyAssignment(current) || ts.isPropertyDeclaration(current)) && current.initializer && (ts.isArrowFunction(unwrap(current.initializer)) || ts.isFunctionExpression(unwrap(current.initializer)))) name = propertyName(current.name);
    if (name && names[0] !== name) names.unshift(name);
  }
  return [...(prefix ? [prefix] : []), ...(names.length ? names : ["(module)"])].join(".");
}
/** Named non-peer semantics frozen by #451 A0. No whole core module is exempted. */
function falsePositive(file: string, symbol: string, node: ts.Node, valueOf: (node: ts.Expression) => string | undefined): boolean {
  if (ts.isBinaryExpression(node) && (file === "src/hub/routing.ts" || file === "src/hub/tasks.ts")) {
    const other = valueOf(node.left) === "local" ? unwrap(node.right) : valueOf(node.right) === "local" ? unwrap(node.left) : undefined;
    if (other && ts.isPropertyAccessExpression(other) && other.name.text === "pii_screen") return true;
  }
  // These exact local values name a screening provider or lifecycle gate, never a peer.
  if (file === "src/hub/config-apply.ts" && symbol === "authorizeConfigLeaf" && ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    && ts.isIdentifier(node.left) && node.left.text === "after" && valueOf(node.right) === "local") {
    const hasScreenKey = (part: ts.Node): boolean => ts.isBinaryExpression(part) && part.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      ? hasScreenKey(part.left) || hasScreenKey(part.right)
      : ts.isBinaryExpression(part) && part.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && ts.isIdentifier(part.left)
        && part.left.text === "key" && valueOf(part.right) === "routing.signals.pii_screen";
    let owner: ts.Node = node;
    while (owner.parent && !ts.isIfStatement(owner.parent) && !ts.isBlock(owner.parent)) owner = owner.parent;
    if (ts.isIfStatement(owner.parent) && owner.parent.expression === owner && hasScreenKey(owner)) return true;
  }
  if (ts.isStringLiteralLike(node) && ts.isArrayLiteralExpression(node.parent)) {
    const array = node.parent;
    const values = array.elements.map(value => valueOf(value));
    if (file === "src/hub/config-reload.ts" && symbol === "validateRoutingRaw.signals.pii_screen"
      && values.length === 2 && values[0] === "off" && values[1] === "local"
      && ts.isCallExpression(array.parent) && ts.isIdentifier(array.parent.expression) && array.parent.expression.text === "choice") return true;
    if (file === "src/hub/sdlc.ts" && symbol === "STAGE_GATES"
      && values.length === 6 && values.join(",") === "issue,pr,local,review,checks,phase") return true;
  }
  if (file === "src/hub/sdlc.ts" && symbol === "stageGates.select.matching" && ts.isBinaryExpression(node)) {
    return ts.isIdentifier(node.left) && node.left.text === "gate" && valueOf(node.right) === "local";
  }
  if (file === "src/hub/routing.ts" && symbol === "parseRouting") {
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === "local") {
      const value = unwrap(node.initializer);
      return ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === "raw" && value.name.text === "local";
    }
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === "pi") return true;
  }
  return false;
}
function scanScript(file: string, parsed: ts.SourceFile, prefix: string, lineOffset: number, bindings: ReturnType<typeof sourceBindings>): InventorySite[] {
  const sites: InventorySite[] = [];
  const { valueOf, member, peerBinding, peerExpression, peerArgument, nativeConstructor } = bindings;
  const resolver = trustedResolvers(file, parsed);
  const add = (node: ts.Node, pattern: InventorySite["pattern"]) => {
    const symbol = enclosingSymbol(node, prefix);
    if (falsePositive(file, symbol, node, valueOf)) return;
    sites.push({ file, symbol, line: lineOffset + parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1, pattern, text: node.getText(parsed) });
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isParameter(node) || ts.isBindingElement(node)) && node.initializer && peerBinding(node) && VENDORS.has(valueOf(node.initializer) ?? "")) {
      add(node.initializer, "vendor-default");
    } else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(node.operatorToken.kind)
      && VENDORS.has(valueOf(node.right) ?? "")) {
      const parent = node.parent;
      const inPeerPosition = peerExpression(node.left) || peerBinding(parent)
        || (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && peerArgument(parent, parent.arguments?.indexOf(node) ?? -1);
      if (inPeerPosition) add(node.right, "vendor-default");
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && nativeConstructor(node.right)) {
      add(node, "native-instanceof");
    } else if (ts.isRegularExpressionLiteral(node)) {
      if (vendorRegex(node.text.slice(1, node.text.lastIndexOf("/")))) add(node, "vendor-regex");
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = unwrap(node.expression), args = node.arguments ?? [];
      if (ts.isIdentifier(callee) && callee.text === "RegExp" && args[0] && vendorRegex(valueOf(args[0]) ?? "")) add(args[0], "vendor-regex");
      const access = member(callee), method = access?.name, receiver = access?.owner;
      for (let index = 0; index < args.length; index++) {
        const arg = args[index]!, value = valueOf(arg);
        if (!peerValue(value)) continue;
        const membership = method === "startsWith" && index === 0 && !!receiver && peerExpression(receiver)
          || method === "includes" && index === 0 && !!receiver && peerExpression(receiver)
          || method === "hasOwnProperty" && index === 0 && !!receiver && peerExpression(receiver)
          || method === "hasOwn" && index === 1 && !!args[0] && peerExpression(args[0])
          || method === "call" && index === 1 && !!receiver && member(receiver)?.name === "hasOwnProperty"
            && !!args[0] && peerExpression(args[0]);
        if (membership) add(arg, "peer-id-predicate");
        else if (VENDORS.has(value!) && (peerArgument(node, index) || ts.isCallExpression(node) && index === 0 && !!resolver(node))) add(arg, "vendor-argument");
      }
      if (method === "includes" && receiver && VENDORS.has(valueOf(receiver) ?? "") && args[0] && peerExpression(args[0])) add(receiver, "peer-id-predicate");
    } else if (ts.isBinaryExpression(node) && equality.has(node.operatorToken.kind)) {
      const left = valueOf(node.left), right = valueOf(node.right);
      if (left !== undefined && VENDORS.has(left) || right !== undefined && VENDORS.has(right)) add(node, kindAware(left !== undefined && VENDORS.has(left) ? node.right : node.left, resolver) ? "kind-aware-comparison" : "comparison");
    } else if (ts.isCaseClause(node) && VENDORS.has(valueOf(node.expression) ?? "")) {
      const owner = node.parent.parent;
      add(node, ts.isSwitchStatement(owner) && kindAware(owner.expression, resolver) ? "kind-aware-comparison" : "comparison");
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && CLOSED_MODULE.test(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) add(node, "closed-list-import");
      else if (bindings && ts.isNamedImports(bindings)) for (const entry of bindings.elements) if (CLOSED_EXPORTS.has((entry.propertyName ?? entry.name).text)) add(entry, "closed-list-import");
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const entry of node.elements) if (VENDORS.has(literal(entry) ?? "")) add(entry, "vendor-literal");
    } else if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isMethodDeclaration(node)) {
      if (ts.isObjectLiteralExpression(node.parent) && VENDORS.has(propertyName(node.name) ?? "")) add(node, "vendor-literal");
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return sites;
}
/** Pure scanner: callers supply bounded fixtures or the explicit src inventory. It never reads or writes a baseline. */
export function scanRegistrySources(sources: Readonly<Record<string, string>>): InventorySite[] {
  const sites: InventorySite[] = [], inputs: Record<string, string> = {};
  const scripts: { file: string; input: string; prefix: string; offset: number }[] = [];
  for (const [rawFile, source] of Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))) {
    const file = rawFile.replaceAll("\\", "/");
    if (!/^src\/.*\.(?:ts|tsx|js|html)$/.test(file)) continue;
    if (file.endsWith(".html")) {
      let index = 0;
      for (const match of source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi)) {
        index++;
        if (/\bsrc\s*=/i.test(match[0].slice(0, match[0].indexOf(">")))) continue;
        const input = `${file}.script${index}.js`, offset = match.index! + match[0].indexOf(">") + 1;
        inputs[input] = match[1]!;
        scripts.push({ file, input, prefix: `script[${index}]`, offset: source.slice(0, offset).split("\n").length - 1 });
      }
    } else { inputs[file] = source; scripts.push({ file, input: file, prefix: "", offset: 0 }); }
  }
  const bindings = sourceBindings(inputs);
  for (const script of scripts) {
    // Native definitions remain exempt from policy inventory, but their exported constants can bind imports.
    if (script.file.startsWith("src/adapters/")) continue;
    sites.push(...scanScript(script.file, bindings.parsed(script.input), script.prefix, script.offset, bindings));
  }
  return sites;
}
export function groupRegistrySites(sites: readonly InventorySite[]): BaselineEntry[] {
  const groups = new Map<string, BaselineEntry>();
  for (const { file, symbol } of sites) {
    const key = JSON.stringify([file, symbol]), previous = groups.get(key);
    if (previous) previous.count++; else groups.set(key, { file, symbol, count: 1 });
  }
  return [...groups.values()].sort((a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol));
}
export function compareRegistryBaseline(actual: readonly BaselineEntry[], baseline: readonly BaselineEntry[]): string[] {
  const issues: string[] = [], expected = new Map<string, BaselineEntry>(), seen = new Set<string>();
  const keyOf = (row: BaselineEntry) => JSON.stringify([row.file, row.symbol]);
  for (const entry of baseline) {
    const key = keyOf(entry);
    if (expected.has(key)) issues.push(`duplicate baseline: ${entry.file} ${entry.symbol}`);
    if (!Number.isSafeInteger(entry.count) || entry.count < 1) issues.push(`invalid baseline count: ${entry.file} ${entry.symbol}`);
    expected.set(key, entry);
  }
  for (const entry of actual) {
    const key = keyOf(entry), previous = expected.get(key); seen.add(key);
    if (!previous) issues.push(`new group: ${entry.file} ${entry.symbol} count ${entry.count}`);
    else if (entry.count !== previous.count) issues.push(`count changed: ${entry.file} ${entry.symbol} ${previous.count} -> ${entry.count}`);
  }
  for (const [key, entry] of expected) if (!seen.has(key)) issues.push(`stale baseline: ${entry.file} ${entry.symbol}`);
  return issues;
}

/** Released coordinators read these exact top-level literal exports before any effects. */
export const REGISTRY_COMPATIBILITY_PROBES = [
  { file: "src/hub/peer-catalog.ts", symbol: "KNOWN_PEERS", count: 5, reason: "cross-release source probe" },
  { file: "src/hub/peer-catalog.ts", symbol: "OPTIONAL_PEERS", count: 3, reason: "cross-release source probe" },
  { file: "src/hub/start-mode.ts", symbol: "START_MODE_PEERS", count: 4, reason: "cross-release source probe" },
] as const;

/** Keep compatibility evidence visible and separate from the native policy baseline. */
export function splitRegistryInventory(sources: Readonly<Record<string, string>>) {
  const sites = scanRegistrySources(sources), accepted = new Set<InventorySite>();
  const compatibility: { file: string; symbol: string; count: number; reason: string; values: string[] }[] = [];
  const issues: string[] = [];
  for (const probe of REGISTRY_COMPATIBILITY_PROBES) {
    const text = sources[probe.file];
    const parsed = text === undefined ? undefined : ts.createSourceFile(probe.file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declarations: ts.VariableDeclaration[] = [];
    for (const statement of parsed?.statements ?? []) {
      if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const) || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.name.text === probe.symbol) declarations.push(declaration);
    }
    const initializer = declarations.length === 1 && declarations[0]!.initializer ? unwrap(declarations[0]!.initializer!) : undefined;
    const values = initializer && ts.isArrayLiteralExpression(initializer) && initializer.elements.every(ts.isStringLiteral)
      ? initializer.elements.map(element => (element as ts.StringLiteral).text) : undefined;
    const matches = sites.filter(site => site.file === probe.file && site.symbol === probe.symbol && site.pattern === "vendor-literal");
    if (!values || values.length !== probe.count || matches.length !== probe.count || values.some(value => !VENDORS.has(value))) {
      issues.push(`invalid compatibility probe: ${probe.file} ${probe.symbol}`);
      continue;
    }
    for (const site of matches) accepted.add(site);
    compatibility.push({ ...probe, count: matches.length, values });
  }
  return { policy: sites.filter(site => !accepted.has(site)), compatibility, issues };
}
