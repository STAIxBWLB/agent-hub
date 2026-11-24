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
  marker?: string;
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
  const lines = text.split(/\r?\n/);

  function walk(node: ts.Node): void {
    if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression)) {
      const { text: name } = node.expression;
      const carrier = ts.isNewExpression(node) && (name === "PreEffectToolRefusal" || name === "HandoffRefusal")
        ? name : ts.isCallExpression(node) && name === "fail" && file === "src/cli/main.ts" ? name : undefined;
      if (carrier) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const [, marker] = lines[line - 2]?.match(/^\s*\/\/\s*refusal:by-design\b(.*)$/) ?? [];
        const [first, second, , next] = node.arguments ?? [];
        const message = carrier === "HandoffRefusal" ? second : first;
        sites.push({ file, line, carrier, message: textShape(message), ...(marker === undefined ? {} : { marker: marker.trim() }),
          ...(carrier === "fail" && next ? { next: textShape(next) } : {}) });
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(source);
  return sites;
}

type ContinuationSurface = {
  commandFlags: ReadonlyMap<string, ReadonlySet<string>>;
  tools: ReadonlySet<string>;
};

export function inspectContinuations(fragments: readonly string[], surface: ContinuationSurface): { found: boolean; errors: string[] } {
  const text = fragments.join(" <value> ");
  const errors: string[] = [];
  let found = false;
  for (const match of text.matchAll(/\bhub_[a-z][a-z0-9_]*\b/g)) {
    found = true;
    if (!surface.tools.has(match[0])) errors.push("unknown tool " + match[0]);
  }
  for (const match of text.matchAll(/\bahub[ \t]+([a-z][a-z0-9-]*|--[a-z][a-z0-9-]*)([^;\n`"()]*?)(?=[;\n`"()]|\bahub\b|$)/g)) {
    found = true;
    const [, command, tail = ""] = match;
    const flags = surface.commandFlags.get(command!);
    if (!flags) {
      errors.push("unknown command ahub " + command);
      continue;
    }
    for (const flag of tail.matchAll(/(?<![-\w])--[a-z][a-z0-9-]*/g)) {
      if (!flags.has(flag[0])) errors.push("unknown flag " + flag[0] + " for ahub " + command);
    }
  }
  return { found, errors: [...new Set(errors)] };
}
