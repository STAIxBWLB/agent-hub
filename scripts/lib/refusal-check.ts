import ts from "typescript";
import { parseSource } from "./ts-ast.ts";

type Carrier = "PreEffectToolRefusal" | "HandoffRefusal" | "fail";
type TextShape = { fragments: string[]; dynamic: boolean };
type RefusalSite = {
  file: string;
  line: number;
  carrier: Carrier;
  message: TextShape;
  next?: TextShape;
};

function textShape(node: ts.Expression | undefined): TextShape {
  if (!node) return { fragments: [], dynamic: true };
  if (ts.isParenthesizedExpression(node)) return textShape(node.expression);
  if (ts.isStringLiteralLike(node)) return { fragments: [node.text], dynamic: false };
  if (ts.isTemplateExpression(node)) {
    return { fragments: [node.head.text, ...node.templateSpans.map(span => span.literal.text)], dynamic: true };
  }
  return { fragments: [], dynamic: true };
}

export function collectRefusals(file: string, text: string): RefusalSite[] {
  const source = parseSource(file, text);
  const sites: RefusalSite[] = [];

  function walk(node: ts.Node): void {
    if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression)) {
      const { text: name } = node.expression;
      const carrier = ts.isNewExpression(node) && (name === "PreEffectToolRefusal" || name === "HandoffRefusal")
        ? name : ts.isCallExpression(node) && name === "fail" && file === "src/cli/main.ts" ? name : undefined;
      if (carrier) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const [message, , , next] = node.arguments ?? [];
        sites.push({ file, line, carrier, message: textShape(message),
          ...(carrier === "fail" && next ? { next: textShape(next) } : {}) });
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(source);
  return sites;
}
