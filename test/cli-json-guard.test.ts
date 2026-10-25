import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { callSites, enclosingFunction, parseSource } from "../scripts/lib/ts-ast.ts";

// #814 AC2: a CLI path never prints a JSON document by default. `console.log(JSON.stringify(...))` is allowed only
// - inside a branch that `--json` selected (an `if`, `?:` or `&&` whose condition names json, taken on its true side),
// - at a named data-format site, which is JSON by purpose, or
// - at a site in NOT_YET_CONVERTED, the debt #814 lists. Each later #814 task deletes the entries it converts;
//   an entry that no longer matches a site fails too, so the list can only shrink.
const CLI_DIR = join(import.meta.dir, "../src/cli");

/** `file :: enclosing function :: first 90 characters of the call #n`, n counting identical calls in the file: an entry survives line drift but not a rewrite of the call, and a new identical call is not covered by its twin. */
type Key = string;
const DATA_FORMAT: Record<Key, string> = {
  "main.ts :: commands.sdlc :: console.log(JSON.stringify(reply, null, 2)) #2": "sdlc export: a data format by purpose (#814)",
  "main.ts :: commands.export :: console.log(JSON.stringify(row)) #1": "export through the conductor: JSON lines, a data format by purpose (#814)",
  "main.ts :: commands.export :: console.log(JSON.stringify(e)) #1": "export: JSON lines, a data format by purpose (#814)",
  "main.ts :: commands.bench :: console.log(JSON.stringify(record)) #1": "bench export: JSON lines, a data format by purpose (#814)",
  "main.ts :: commands.check-path :: console.log(JSON.stringify({ systemMessage: text.split(\"\\n\")[0], hookSpecificOutput: { hoo #1": "check-path --hook: the PreToolUse reply Claude Code parses; a hook payload, like the facts hook (#814)",
};
/** Today's not-yet-converted sites from #814 Context. Remove an entry in the PR that converts it. */
const NOT_YET_CONVERTED: Record<Key, string> = {
  "main.ts :: upgrade :: console.log(JSON.stringify(plan, null, 2)) #1": "#814 task 3: restart/upgrade non-interactive plan",
  "main.ts :: commands.recovery :: console.log(JSON.stringify(publicOperation(result), null, 2)) #1": "#814 task 3: recovery non-interactive result",
  "main.ts :: commands.recovery :: console.log(JSON.stringify(publicOperation(operation, runner, live), null, 2)) #1": "#814 task 3: recovery status",
  "main.ts :: commands.recovery :: console.log(JSON.stringify(publicOperation(result), null, 2)) #3": "#814 task 3: recovery non-interactive result",
  "main.ts :: commands.models :: console.log(JSON.stringify(handle.status(), null, 2)) #1": "#814 task 3: models start",
  "main.ts :: commands.models :: console.log(JSON.stringify(handle.status(), null, 2)) #2": "#814 task 3: models setup",
  "main.ts :: commands.queue :: console.log(JSON.stringify(result.delivery, null, 2)) #1": "#814 task 3: queue resolve",
  "main.ts :: commands.budget :: console.log(JSON.stringify(data, null, 2)) #1": "#814 task 3: budget execution configure|disable (`op !== \"status\" || options.json` prints JSON for them by default)",
  // Not in #814 Context: both predate it or were added after it was verified. Listed so the guard passes now; #814 should name them.
  "main.ts :: commands.sdlc :: console.log(JSON.stringify({ task: reply.task, mode: reply.mode, ran: reply.ran, decision: #1": "sdlc merge (#786, after #814's Context was verified): a result to convert in a later #814 task",
  "main.ts :: commands.doctor :: console.log(JSON.stringify(result,null,2)) #1": "doctor --orphans --kill for a conductor shell: not listed in #814 Context",
};

/** Names that hold the parsed `--json` flag: the option objects of `outputOptions()`, the recovery display options and the sdlc `present`. */
const OPTION_HOLDERS = new Set(["options", "display", "present"]);
/** Argument lists a bare `--json` is looked for in. */
const ARGUMENT_LISTS = new Set(["args", "flags"]);
/** Local aliases defined as a conjunction that includes `display.json` (`const jsonApply = display.json && yes && !dry`). */
const JSON_ALIASES = new Set(["jsonApply"]);
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

interface Site { key: Key; line: number; guarded: boolean }
export function sitesOf(file: string, text: string): Site[] {
  const source = parseSource(file, text), sites: Site[] = [], seen = new Map<string, number>();
  for (const call of callSites(source, "console.log")) {
    const arg = call.arguments[0];
    if (!arg || !ts.isCallExpression(arg) || arg.expression.getText(source) !== "JSON.stringify") continue;
    let guarded = false, child: ts.Node = call, node: ts.Node | undefined = call.parent;
    while (node && !guarded) {
      if (ts.isIfStatement(node) && node.thenStatement === child) guarded = selectsJson(node.expression, source);
      else if (ts.isConditionalExpression(node) && node.whenTrue === child) guarded = selectsJson(node.condition, source);
      else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && node.right === child) guarded = selectsJson(node.left, source);
      child = node; node = node.parent;
    }
    const fn = enclosingFunction(source, call.getStart(source))?.name ?? "(top level)";
    const base = `${file} :: ${fn} :: ${flat(call.getText(source)).slice(0, 90)}`, ordinal = (seen.get(base) ?? 0) + 1;
    seen.set(base, ordinal);
    sites.push({ key: `${base} #${ordinal}`, line: source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1, guarded });
  }
  return sites;
}
/**
 * True only when the condition being truthy PROVES `--json` was given. Conservative by construction: a form this does not
 * recognise is not a guard, so a new shape fails the test until it is written one of these ways or named in a list.
 *   X.json, X!.json (X an option holder)   args.includes("--json")   a known alias
 *   A && B  proves json if either side does        A || B  only if both sides do
 *   (A)  !!A  A === true  A == true
 * Never a guard: !A, A === false, A !== false, A ?? B, A ? B : C, comparisons, calls other than includes("--json"), any other name.
 */
export function selectsJson(node: ts.Expression, source: ts.SourceFile): boolean {
  if (ts.isParenthesizedExpression(node)) return selectsJson(node.expression, source);
  if (ts.isNonNullExpression(node)) return selectsJson(node.expression, source);
  if (ts.isIdentifier(node)) return JSON_ALIASES.has(node.text);
  if (ts.isPropertyAccessExpression(node)) {
    let base: ts.Expression = node.expression;
    while (ts.isNonNullExpression(base) || ts.isParenthesizedExpression(base)) base = base.expression;
    return node.name.text === "json" && ts.isIdentifier(base) && OPTION_HOLDERS.has(base.text);
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    return ts.isPropertyAccessExpression(callee) && callee.name.text === "includes" && ts.isIdentifier(callee.expression) && ARGUMENT_LISTS.has(callee.expression.text)
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!) && (node.arguments[0] as ts.StringLiteral).text === "--json";
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = ts.isParenthesizedExpression(node.operand) ? node.operand.expression : node.operand;
    return ts.isPrefixUnaryExpression(inner) && inner.operator === ts.SyntaxKind.ExclamationToken && selectsJson(inner.operand, source);
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return selectsJson(node.left, source) || selectsJson(node.right, source);
    if (op === ts.SyntaxKind.BarBarToken) return selectsJson(node.left, source) && selectsJson(node.right, source);
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken)
      return node.right.kind === ts.SyntaxKind.TrueKeyword && selectsJson(node.left, source);
  }
  return false;
}
const allSites = () => readdirSync(CLI_DIR).filter(name => name.endsWith(".ts")).sort().flatMap(name => sitesOf(name, readFileSync(join(CLI_DIR, name), "utf8")));

test("AC2 every JSON print in src/cli is behind --json, a named data format or the not-yet-converted list", () => {
  const unlisted = allSites().filter(site => !site.guarded && !(site.key in DATA_FORMAT) && !(site.key in NOT_YET_CONVERTED));
  expect(unlisted.map(site => `${site.key} (line ${site.line})`), "print JSON only behind --json, or convert the command to a renderer").toEqual([]);
});

test("AC2 the exception and debt lists hold only sites that exist, so each task's removal is forced", () => {
  const present = new Set(allSites().filter(site => !site.guarded).map(site => site.key));
  for (const [list, name] of [[DATA_FORMAT, "DATA_FORMAT"], [NOT_YET_CONVERTED, "NOT_YET_CONVERTED"]] as const) {
    expect(Object.keys(list).filter(key => !present.has(key)), `${name} entries that no longer match an unguarded site: delete them`).toEqual([]);
  }
  for (const [key, reason] of [...Object.entries(DATA_FORMAT), ...Object.entries(NOT_YET_CONVERTED)]) expect(reason.length, key).toBeGreaterThan(10);
});

test("AC2 the guard itself: only a condition that PROVES --json guards; negated, equal-to-false, OR-bypass and unrelated forms do not", () => {
  const sites = (code: string) => sitesOf("fixture.ts", `function f(options: any, display: any, present: any, args: string[], flags: string[]) { ${code} }`);
  const print = "console.log(JSON.stringify(x))";
  const guarded = [
    `if (options.json) ${print};`, `if (options.json) { ${print}; }`, `options.json ? ${print} : show(x);`, `options.json && ${print};`, `if (display.json && code === 0) ${print};`,
    `if (args.includes("--json")) return ${print};`, `if (flags.includes("--json")) ${print};`, `if (jsonApply) ${print};`, `if (present!.json) ${print};`, `if ((options.json)) ${print};`,
    `if (!!options.json) ${print};`, `if (options.json === true) ${print};`, `if (options.json && !byColumn) ${print};`, `if (ready && options.json) ${print};`, `if (options.json || display.json) ${print};`,
  ];
  for (const code of guarded) expect(sites(code).map(site => site.guarded), code).toEqual([true]);
  const unguarded = [
    `${print};`, `if (!options.json) ${print};`, `if ((!options.json)) ${print};`, `if (!(options.json)) ${print};`, `if (options.json === false) ${print};`, `if (options.json !== true) ${print};`,
    `if (options.json || true) ${print};`, `if (options.json || other) ${print};`, `if (other || options.json) ${print};`, `if (options.json ?? true) ${print};`, `if (op !== "status" || options.json) ${print};`,
    `if (options.json) show(x); else ${print};`, `options.json ? show(x) : ${print};`, `if (options.full) ${print};`, `if (args.includes("--full")) ${print};`, `if (args.includes("--json", 1)) ${print};`,
    `if (somethingElse.json) ${print};`, `if (jsonish) ${print};`, `if (options.jsonApply) ${print};`, `if (options.json == false) ${print};`, `if (!!!options.json) ${print};`,
    `if (options.json && false || other) ${print};`, `options.json || ${print};`,
  ];
  for (const code of unguarded) expect(sites(code).some(site => site.guarded), code).toBe(false);
  expect(sites("console.error(JSON.stringify(x));")).toEqual([]);
  expect(sites("console.log(JSON.stringify(x))")[0]!.key).not.toBe(sites("console.log(JSON.stringify(y))")[0]!.key);
  expect(sites(`${print}; ${print};`).map(site => site.key.split(" #")[1])).toEqual(["1", "2"]);
});

test("AC2 the scanner sees the real CLI: it finds the converted sdlc sites guarded and at least one site per guarded family", () => {
  const sites = allSites();
  expect(sites.length).toBeGreaterThan(10);
  expect(sites.filter(site => site.guarded).length).toBeGreaterThan(5);
  const sdlc = sites.filter(site => site.key.includes("commands.sdlc"));
  expect(sdlc.length).toBeGreaterThan(0);
  // the converted read commands (status, explain, queue, release, authorize-release) print JSON only through --json: what stays unguarded in sdlc is
  // `export` (a data format) and `merge` (a result a later task converts), both named
  const named = [...Object.keys(DATA_FORMAT), ...Object.keys(NOT_YET_CONVERTED)].filter(key => key.includes("commands.sdlc")).sort();
  expect(sdlc.filter(site => !site.guarded).map(site => site.key).sort()).toEqual(named);
  expect(sdlc.filter(site => site.guarded).length).toBeGreaterThanOrEqual(3);
});
