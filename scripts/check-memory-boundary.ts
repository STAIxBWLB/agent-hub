import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

export const MEMORY_CORE = ["store.ts", "sync.ts", "import.ts", "project.ts", "home.ts", "platform.ts", "commands.ts"];

/** Parse type-only and executable imports alike: the portable core cannot depend on a hub module or package. */
export function checkMemoryBoundary(root: string): string[] {
  const allowed = new Set(MEMORY_CORE.map(file => resolve(root, "src/memory", file)));
  const failures: string[] = [];
  for (const file of allowed) {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { failures.push(`${relative(root, file)}: missing core file`); continue; }
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const check = (node: ts.Node, value: ts.Node | undefined) => {
      const at = source.getLineAndCharacterOfPosition(node.getStart(source));
      const prefix = `${relative(root, file)}:${at.line + 1}`;
      if (!value || !ts.isStringLiteralLike(value)) { failures.push(`${prefix}: nonliteral module import`); return; }
      const spec = value.text;
      if (isBuiltin(spec) || spec === "bun:sqlite") return;
      if (spec.startsWith(".") && allowed.has(resolve(dirname(file), spec))) return;
      failures.push(`${prefix}: core import refused: ${spec}`);
    };
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) check(node, node.moduleSpecifier);
      } else if (ts.isImportTypeNode(node)) {
        check(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        check(node, node.moduleReference.expression);
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        check(node, node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return failures;
}

if (import.meta.main) {
  const failures = checkMemoryBoundary(resolve(import.meta.dir, ".."));
  if (failures.length) { console.error(failures.join("\n")); process.exitCode = 1; }
  else console.log(`memory-boundary: OK (${MEMORY_CORE.length} core modules; built-ins and core imports only)`);
}
