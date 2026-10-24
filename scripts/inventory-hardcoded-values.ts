import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

type Area = "tasks/routing" | "bus/delivery" | "recovery/upgrade waits" | "adapters/handshakes" | "model relay/inference" | "UI/console";
type Classification = "operational" | "safety floor" | "contract" | "test seam" | "unknown";
type Entry = {
  file: string;
  line: number;
  column: number;
  name: string;
  value: string;
  unit: string;
  control: string;
  area: Area;
  classification: Classification;
  kind: "constant" | "inline";
};

const thresholdName = /(timeout|deadline|delay|wait|interval|duration|cooldown|backoff|retry|retries|attempt|max|min|limit|cap|budget|quota|window|ttl|size|bytes|tokens|count|lines|depth|hop|port|concurr|parallel|batch|page|tail|head|threshold|capacity|stall|idle|period|sigma|samples|drift|floor|severity|share|days?\b|ms\b|seconds?\b|minutes?\b)/i;
const timerCall = /^(?:setTimeout|setInterval|Bun\.sleep|sleep|delay|wait|timeout|deadline|retry|backoff)$/i;
const boundedCall = /(?:slice|substring|substr|readPage|truncate|cap|clamp|limit|take|head|tail)$/i;
const classifications = new Map<string, Classification>(Object.entries(JSON.parse(readFileSync(new URL("./inventory-hardcoded-values.classifications.json", import.meta.url), "utf8")) as Record<string, Classification>));

function numericValue(node: ts.Expression): string | null {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return numericValue(node.expression);
  if (ts.isNumericLiteral(node)) return node.text;
  if (ts.isPrefixUnaryExpression(node) && (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken)) {
    const value = numericValue(node.operand);
    return value === null ? null : `${node.operator === ts.SyntaxKind.MinusToken ? "-" : "+"}${value}`;
  }
  if (ts.isBinaryExpression(node)) {
    const left = numericValue(node.left);
    const right = numericValue(node.right);
    if (left !== null && right !== null && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken].includes(node.operatorToken.kind)) return `${left} ${node.operatorToken.getText()} ${right}`;
  }
  return null;
}

function durationValue(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) && /^\d+(?:\.\d+)?(?:ms|s|m|h|d)$/.test(node.text)) return node.text;
  return null;
}

function areaFor(file: string): Area {
  if (/^src\/(models|omniroute)\//.test(file) || /\/(inference|facts|code-facts|execution-budget)\.ts$/.test(file)) return "model relay/inference";
  if (/^src\/(adapters|pi|local)\//.test(file) || /\/(child-process|native-[^/]+|peer-catalog|permission-[^/]+|action-enforce|tool-refusal|start-mode|terminal-open|instance-execution|instance-config)\.ts$/.test(file)) return "adapters/handshakes";
  if (/\/(upgrade[^/]*|terminal-recovery|recovery[^/]*|restart|manager|lifecycle|snapshots|control-client|ports)\.ts$/.test(file)) return "recovery/upgrade waits";
  if (/\/(bus|envelope|limits|delivery[^/]*|deferred-hub|peers|delivery-journal|delivery-superseded)\.ts$/.test(file)) return "bus/delivery";
  if (/\/(tasks?|routing|task-[^/]*|board|checks|conductor|supervision|planning|release[^/]*|review[^/]*|reviewer[^/]*|sdlc[^/]*|deliverables?|workflow|settled-roles|main-checkout|no-writes)\.ts$/.test(file)) return "tasks/routing";
  return "UI/console";
}

function contextName(node: ts.Node): string {
  let current: ts.Node | undefined = node;
  for (let depth = 0; current && depth < 7; depth++, current = current.parent) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
    if (ts.isPropertyAssignment(current)) return current.name.getText();
    if (ts.isParameter(current) && ts.isIdentifier(current.name)) return current.name.text;
    if (ts.isBinaryExpression(current) && ![ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken].includes(current.operatorToken.kind)) return current.getText();
    if (ts.isCallExpression(current)) return current.expression.getText();
    if (ts.isPropertyAccessExpression(current)) return current.name.text;
  }
  return node.parent?.getText().slice(0, 100) ?? "numeric literal";
}

function assignedName(node: ts.Node): string {
  let current: ts.Node | undefined = node;
  for (let depth = 0; current && depth < 10; depth++, current = current.parent) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
    if (ts.isPropertyAssignment(current) || ts.isPropertyDeclaration(current)) return current.name.getText();
    if (ts.isParameter(current) && ts.isIdentifier(current.name)) return current.name.text;
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(current.left)) return current.left.text;
  }
  return "";
}

const strictThresholdName = /(timeout|deadline|delay|wait|interval|duration|cooldown|backoff|retry|retries|attempt|tries|max|min|limit|cap|budget|quota|window|ttl|depth|hop|concurr|parallel|batch|threshold|stall|idle|sigma|samples|drift)/i;

function inlineThreshold(node: ts.NumericLiteral): boolean {
  if (node.getSourceFile().fileName.includes("/conformance/fakes/")) return false;
  const value = Number(node.text.replaceAll("_", ""));
  if (!Number.isFinite(value)) return false;
  let current: ts.Node | undefined = node;
  for (let depth = 0; current && depth < 10; depth++, current = current.parent) {
    if (ts.isParameter(current)) return thresholdName.test(assignedName(current));
    if (ts.isVariableDeclaration(current) || ts.isPropertyAssignment(current) || ts.isPropertyDeclaration(current)) {
      if (thresholdName.test(assignedName(current)) || thresholdName.test(assignedName(current.parent))) return true;
    }
    if (ts.isCallExpression(current)) {
      const name = current.expression.getText();
      if (name === "Number" || name === "parseInt" || name.endsWith("toFixed")) return false;
      if (timerCall.test(name)) {
        const expression = inlineExpression(node);
        const argument = current.arguments[name === "setTimeout" || name === "setInterval" ? 1 : 0];
        return argument !== undefined && expression.pos >= argument.pos && expression.end <= argument.end;
      }
      if (/^Math\.(?:min|max)$/.test(name)) return thresholdName.test(assignedName(current));
      if (/(?:slice|substring|substr)$/.test(name)) {
        const args = current.arguments;
        const expression = inlineExpression(node);
        const second = args.length > 1 && expression.pos >= args[1]!.pos && expression.end <= args[1]!.end;
        const tail = args.length === 1 && ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.MinusToken;
        return second || tail;
      }
      if (boundedCall.test(name) || thresholdName.test(name)) return true;
    }
    if (ts.isBinaryExpression(current)) {
      if ([ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken].includes(current.operatorToken.kind)) {
        const comparison = current.getText();
        if ((value > 1 && (thresholdName.test(comparison) || /\.(?:length|size)\b/.test(comparison))) || strictThresholdName.test(comparison)) return true;
      }
      if ([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(current.operatorToken.kind)) {
        const expression = current.getText();
        if ((value > 1 && thresholdName.test(expression)) || strictThresholdName.test(expression)) return true;
      }
    }
    if (ts.isReturnStatement(current) || ts.isExpressionStatement(current) || ts.isIfStatement(current)) break;
  }
  return false;
}

function durationExpression(node: ts.BinaryExpression): boolean {
  if (![ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken].includes(node.operatorToken.kind)) return false;
  return /(?:\b(?:ms|s|min|hour|day|days|HOUR|DAY)\b|_ms\b|_s\b|Ms\b|Seconds\b|Minutes\b|Hours\b|Days\b|COOLDOWN|TIMEOUT|DELAY|WINDOW)/i.test(node.getText());
}

function inlineExpression(node: ts.NumericLiteral): ts.Expression {
  let expression: ts.Expression = node;
  while (ts.isBinaryExpression(expression.parent) || ts.isPrefixUnaryExpression(expression.parent) || ts.isParenthesizedExpression(expression.parent)) {
    if (!ts.isExpression(expression.parent)) break;
    if (numericValue(expression.parent) === null && (!ts.isBinaryExpression(expression.parent) || !durationExpression(expression.parent))) break;
    expression = expression.parent;
  }
  return expression;
}

function unitFor(name: string, value: string): string {
  if (/^\d+(?:\.\d+)?(?:ms|s|m|h|d)$/.test(value)) return value.replace(/^\d+(?:\.\d+)?/, "");
  if (name.endsWith(".slice")) return "characters";
  if (/interval_s/.test(value) && /(?:1000|60_000)/.test(value)) return "ms";
  if (/[*\/]/.test(value) && /(?:interval_s|_MS\b|Ms\b|\bHOUR\b|\bDAY\b|\bdays\b|delay|deadline|timeout)/.test(value)) return "ms";
  if (/(_MS\b|MILLISECONDS|_MILLIS\b)/i.test(name) || /Ms\b/.test(name) || timerCall.test(name) || /^(?:Atomics\.wait|AbortSignal\.timeout|timeout|deadline|DAY|DAY_MS|HOUR)$/.test(name)) return "ms";
  if (/(_SECONDS?\b|_SECS?\b|_S\b)/.test(name) || /_s\b/.test(name) || name === "idleTimeout") return "seconds";
  if (/(?:_MINUTES\b|_MINS\b)/.test(name) || /_min\b|Mins?\b/.test(name)) return "minutes";
  if (/(_HOURS?\b)/i.test(name) || /_h\b/.test(name)) return "hours";
  if (/(_DAYS?\b)/i.test(name) || /_d\b/.test(name) || name === "days") return "days";
  if (/(bytes|byteLength|maxBuffer|content-length|_KB\b|_MB\b|_MIB\b|_KIB\b)/i.test(name) || /^(?:MAX_OUTPUT|MAX_JSON|RESULT_CAP|INDEX_CAP|LINE_CAP|DEFAULT_CHUNK|CHUNK|BODY_LIMIT|RESULT_LIMIT|STDOUT_LIMIT|MAX_PROJECTION_INPUT|maxRequestBodySize)$/.test(name)) return "bytes";
  if (/(?:count|retries|attempts|failures|depth|hops|concurrency|parallel|batch|size|page)$/i.test(name)) return "count";
  if (/(?:timeout|deadline|wait|delay|interval|cooldown|backoff)/i.test(name)) return "ms";
  if (/tokens/i.test(name)) return "tokens";
  if (/lines/i.test(name)) return "lines";
  if (/ports?/i.test(name)) return "port";
  if (/(?:paths|keys|rows|items|args|declarations|names|segments|entries|owners|files|nodes|edges|commits|classes|modules|ids|waiters|commands|parts|values|attempts|failures)\.length/i.test(name)) return "count";
  if (/\.length(?:\s|$)/i.test(name)) return "characters";
  if (/(?:text|string|message|title|detail|path|id|key|body|line|input|output|reason|diff|content|value|slice|truncate|chars).*?(?:length|slice|truncate|cap|max)|^(?:maxLength|slice|truncate)/i.test(name)) return "characters";
  if (name === "len") return "count";
  if (/(count|retries|attempts|max|min|limit|cap|depth|hops|concurrency|parallel|batch|size|page)/i.test(name)) return "count";
  return "unitless";
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:ts|js|mjs|html|sh|py)$/.test(name) && !name.endsWith(".d.ts") && !name.endsWith(".test.ts") && name !== "inventory-hardcoded-values.ts") files.push(path);
  }
  return files;
}

function htmlScripts(text: string): string {
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const before = text.slice(cursor, match.index);
    result += before.replace(/[^\n]/g, "") + match[1];
    cursor = (match.index ?? 0) + match[0].length;
  }
  return result;
}

function keyFor(file: string, line: number, column: number, name: string, kind: string, value: string): string {
  return `${file}:${line}:${column}:${kind}:${name}=${value}`;
}

function extractShell(root: string, path: string): Entry[] {
  const file = relative(root, path).replaceAll("\\", "/");
  const entries: Entry[] = [];
  const patterns: [RegExp, string, string][] = [
    [/\$\{([A-Z_][A-Z0-9_]*):-(\d+)\}/g, "$1", "seconds"],
    [/\bsleep\s+(\d+)\b/g, "sleep", "seconds"],
    [/\bbun\s+test\s+--timeout\s+(\d+)\b/g, "bun test --timeout", "ms"],
    [/\bsample\s+\"?\$?\w+\"?\s+(\d+)\b/g, "sample", "seconds"],
    [/\bhead\s+-(\d+)\b/g, "head", "lines"],
    [/\bfor\s+\w+\s+in\s+1\s+2\s+3\s+4\s+5\s+6\s+7\s+8\s+9\s+(\d+)\b/g, "termination attempts", "count"],
  ];
  readFileSync(path, "utf8").split("\n").forEach((text, index) => {
    if (text.trimStart().startsWith("#")) return;
    for (const [pattern, label, defaultUnit] of patterns) {
      for (const match of text.matchAll(pattern)) {
        const value = label === "$1" ? match[2] : match[1];
        if (!value) continue;
        const name = label === "$1" ? (match[1] ?? label) : label;
        const unit = label === "$1" && !name.endsWith("_S") ? "unitless" : defaultUnit;
        const line = index + 1;
        const column = (match.index ?? 0) + match[0].indexOf(value) + 1;
        const key = keyFor(file, line, column, name, "inline", value);
        entries.push({ file, line, column, name, value, unit, control: text.trim(), area: areaFor(file), classification: classifications.get(key) ?? "unknown", kind: "inline" });
      }
    }
  });
  return entries;
}

function extractPython(root: string, path: string): Entry[] {
  const file = relative(root, path).replaceAll("\\", "/");
  const entries: Entry[] = [];
  const number = String.raw`-?\d[\d_]*(?:\.\d[\d_]*)?`;
  const arithmetic = String.raw`${number}(?:\s*[*+/]\s*${number})*`;
  const constant = new RegExp(String.raw`^([A-Z_][A-Z0-9_]*)\s*=\s*(${arithmetic})(?=\s*(?:#.*)?$)`);
  const keyword = new RegExp(String.raw`\b([A-Za-z_]\w*)\s*=\s*(${arithmetic})(?=\s*[,)\]])`, "g");
  const sleeper = new RegExp(String.raw`\b(?:time\.)?(sleep|wait)\(\s*(${number})`, "g");
  const comparison = new RegExp(String.raw`\b([A-Za-z_]\w*)\s*(?:>=|<=|>|<)\s*(${number})`, "g");
  const range = new RegExp(String.raw`\bfor\s+([A-Za-z_]\w*)\s+in\s+range\(\s*(${number})`, "g");
  const clamp = new RegExp(String.raw`\b([A-Za-z_]\w*)\s*=\s*(?:min|max)\(\s*(${number})`, "g");
  const slice = new RegExp(String.raw`\[\s*:\s*(${number})\s*\]`, "g");
  const lenComparison = new RegExp(String.raw`\b(len)\(\s*[A-Za-z_]\w*(?:\.\w+)*\s*\)\s*(?:>=|<=|>|<|==|!=)\s*(${number})`, "g");
  readFileSync(path, "utf8").split("\n").forEach((text, index) => {
    const trimmed = text.trimStart();
    if (trimmed.startsWith("#")) return;
    const line = index + 1;
    const add = (kind: "constant" | "inline", name: string, value: string, column: number) => {
      const key = keyFor(file, line, column, name, kind, value);
      let unit = unitFor(name, value);
      if (name === "limit" && value.includes("1024")) unit = "bytes";
      else if (unit === "ms" && !/(?:_MS\b|Ms\b)/.test(name)) unit = "seconds";
      entries.push({ file, line, column, name, value, unit, control: trimmed, area: areaFor(file), classification: classifications.get(key) ?? "unknown", kind });
    };
    const moduleConstant = text.match(constant);
    if (moduleConstant?.[1] && moduleConstant[2]) {
      add("constant", moduleConstant[1], moduleConstant[2], text.indexOf(moduleConstant[1]) + 1);
      return;
    }
    for (const [pattern, nameRequired, label] of [[keyword, true], [sleeper, false], [comparison, true], [range, true], [clamp, true], [slice, false, "slice"], [lenComparison, false]] as const) {
      for (const match of text.matchAll(pattern)) {
        const name = label ?? match[1];
        const value = label ? match[1] : match[2];
        if (!name || !value || (nameRequired && !thresholdName.test(name))) continue;
        add("inline", name, value, (match.index ?? 0) + match[0].lastIndexOf(value) + 1);
      }
    }
  });
  return entries;
}

function extractFile(root: string, path: string): Entry[] {
  const file = relative(root, path).replaceAll("\\", "/");
  if (file.endsWith(".sh")) return extractShell(root, path);
  if (file.endsWith(".py")) return extractPython(root, path);
  const raw = readFileSync(path, "utf8");
  const text = file.endsWith(".html") ? htmlScripts(raw) : raw;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const entries: Entry[] = [];
  const constantNodes = new Set<ts.Node>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
      const value = numericValue(declaration.initializer) ?? durationValue(declaration.initializer);
      if (value === null) continue;
      constantNodes.add(declaration.initializer);
      const name = declaration.name.text;
      const position = source.getLineAndCharacterOfPosition(declaration.name.getStart());
      const line = position.line + 1;
      const column = position.character + 1;
      const key = keyFor(file, line, column, name, "constant", value);
      entries.push({ file, line, column, name, value, unit: unitFor(name, value), control: name, area: areaFor(file), classification: classifications.get(key) ?? "unknown", kind: "constant" });
    }
  }
  const seen = new Set<number>();
  function withinConstant(node: ts.Node): boolean {
    for (const constant of constantNodes) if (node.pos >= constant.pos && node.end <= constant.end) return true;
    return false;
  }
  function visit(node: ts.Node) {
    if (ts.isNumericLiteral(node) && !withinConstant(node) && inlineThreshold(node)) {
      const expression = inlineExpression(node);
      if (!seen.has(expression.getStart())) {
        seen.add(expression.getStart());
        const name = contextName(expression).replace(/["'`]/g, "").replaceAll(/\s+/g, " ");
        const value = expression.getText().replaceAll(/\s+/g, " ");
        const position = source.getLineAndCharacterOfPosition(expression.getStart());
        const line = position.line + 1;
        const column = position.character + 1;
        const key = keyFor(file, line, column, name, "inline", value);
        const assigned = assignedName(expression);
        const explicitUnit = /(?:_MS\b|Ms\b|_SECONDS?\b|_SECS?\b|_S\b|_s\b|_MINUTES\b|_MINS\b|_min\b|Mins?\b|_HOURS?\b|_DAYS?\b|_d\b|days\b)/.test(name);
        const unitName = explicitUnit || !assigned || !thresholdName.test(assigned) ? name : assigned;
        entries.push({ file, line, column, name, value, unit: unitFor(unitName, value), control: name, area: areaFor(file), classification: classifications.get(key) ?? "unknown", kind: "inline" });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return entries;
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function renderInventory(entries: Entry[]): string {
  const counts = new Map<Classification, number>();
  const areas = new Map<Area, number>();
  const operationalAreas = new Map<Area, number>();
  for (const entry of entries) {
    counts.set(entry.classification, (counts.get(entry.classification) ?? 0) + 1);
    areas.set(entry.area, (areas.get(entry.area) ?? 0) + 1);
    if (entry.classification === "operational") operationalAreas.set(entry.area, (operationalAreas.get(entry.area) ?? 0) + 1);
  }
  const lines = ["# Hardcoded operational constants inventory", "", "Generated by `bun scripts/inventory-hardcoded-values.ts`. Re-run from the repository root; do not edit the tables by hand.", "", "Scope: module-level numeric and duration constants, plus inline numeric thresholds, in `src/` and executable TypeScript, JavaScript, Python and shell files under `scripts/`. The generator reports candidates mechanically; `scripts/inventory-hardcoded-values.classifications.json` records the code-reviewed decision for every item and any missing key fails the run. `operational` items are candidates for the later area PRs. Safety floors and contracts stay fixed; test seams remain injectable.", "", "## Counts", "", "| Classification | Items |", "| --- | ---: |"];
  for (const classification of ["operational", "safety floor", "contract", "test seam"] as const) lines.push(`| ${classification} | ${counts.get(classification) ?? 0} |`);
  lines.push(`| **total** | **${entries.length}** |`, "", "## Follow-up areas", "", "| Area | Operational items | All items |", "| --- | ---: | ---: |");
  for (const area of ["tasks/routing", "bus/delivery", "recovery/upgrade waits", "adapters/handshakes", "model relay/inference", "UI/console"] as const) lines.push(`| ${area} | ${operationalAreas.get(area) ?? 0} | ${areas.get(area) ?? 0} |`);
  lines.push("", "## Inventory", "", "| Location | Kind | Name | Value | Unit | Controls | Area | Classification |", "| --- | --- | --- | ---: | --- | --- | --- | --- |");
  for (const entry of [...entries].sort((a, b) => compareText(a.file, b.file) || a.line - b.line || a.column - b.column || compareText(a.name, b.name))) {
    const cell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");
    lines.push(`| ${entry.file}:${entry.line}:${entry.column} | ${entry.kind} | \`${cell(entry.name)}\` | \`${cell(entry.value)}\` | ${entry.unit} | ${cell(entry.control)} | ${entry.area} | ${entry.classification} |`);
  }
  lines.push("");
  return lines.join("\n");
}

const args = process.argv.slice(2);
if (args.length > 0) throw new Error("usage: bun scripts/inventory-hardcoded-values.ts");
const root = process.cwd();
const files = [...sourceFiles(join(root, "src")), ...sourceFiles(join(root, "scripts"))];
const entries = files.flatMap((path) => extractFile(root, path));
const unknown = entries.filter((entry) => entry.classification === "unknown");
if (unknown.length) {
  for (const entry of unknown) console.error(`${entry.file}:${entry.line}:${entry.column} ${entry.kind} ${entry.name} = ${entry.value}`);
  throw new Error(`${unknown.length} inventory entries need classification`);
}
process.stdout.write(renderInventory(entries));
