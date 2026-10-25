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

// AC2, open-ended (second scan). The scan above covers console.log(JSON.stringify(...)); this one covers the sites that print the hub tool's TEXT, which is JSON
// for some ops and a sentence for others. Every bare `console.log(await taskOp(<op>))` in main.ts must be named here, and the name is checked
// against what the daemon's case for that op actually returns, so a new op that returns JSON is not silently ignored and a sentence op that
// starts returning JSON is caught.
const SENTENCE_OPS = new Set(["hub_task_propose", "backlog_pull", "backlog_return", "task_escalate", "task_assign", "task_assign_checked", "task_unassign", "hub_sdlc_record", "review_brief", "hub_review", "hub_remember", "route_explain"]);
/** Bare prints of JSON text that no #814 task has converted yet. Remove an entry in the PR that converts it; an entry with no bare print fails. */
const TEXT_DEBT: Record<string, string> = {
  github_import: "board import github: the import report, not in #814 Context",
  hub_release_report: "sdlc train report: the release-train report (an sdlc subcommand, not ahub release)",
  hub_release_configure: "sdlc train configure",
  hub_release_cut: "sdlc train cut",
  hub_release_assign: "sdlc release-assign",
  hub_plan_review: "sdlc plan-review",
  turn_revert: "undo --context: not in #814 Context",
};
/** Conductor-role agent-shell commands (`ahub <peer>`, pause, resume, task assign|escalate): conductor.ts returns an object, not a person's text. Not in #814 Context; named so a new one is noticed. */
const CONDUCTOR_DEBT: Record<string, string> = {
  hub_peer_start: "conductor start of a peer", hub_peer_hold: "conductor pause", hub_peer_release: "conductor resume",
  hub_task_assign: "conductor assign", hub_task_escalate: "conductor escalate",
};
/** Only the tool-op switch (from the first op this file converts to the last it names), never a control-message switch that also has words like "assign". */
const daemonToolCase = (daemon: string, op: string): string | undefined => {
  const first = daemon.indexOf('case "hub_backlog_list":');
  return first < 0 ? undefined : daemonCase(daemon.slice(first), op);
};
const daemonCase = (daemon: string, op: string): string | undefined => {
  const label = `case "${op}":`, start = daemon.indexOf(label);
  if (start < 0) return undefined;
  let from = start + label.length;
  // fall-through labels share the next body
  for (let m = /^\s*case "[a-z_]+":/.exec(daemon.slice(from)); m; m = /^\s*case "[a-z_]+":/.exec(daemon.slice(from))) from += m[0].length;
  const end = daemon.indexOf('\n      case "', from);
  return daemon.slice(from, end < 0 ? from + 4000 : end);
};
interface TaskPrint { ops: string[]; where: string; site: string; guarded: boolean }
/** A print of text that is not the op's JSON: reached only after the same text failed to parse as the JSON the table renders, so it is the hub's refusal sentence printed as it came. Keyed `op in file :: function`. */
const REFUSAL_FALLBACK: Record<string, string> = {
  "hub_backlog_list in main.ts :: commands.backlog": "backlog list: a reply that is not a JSON array (a refusal) is printed as it came, after --json and the table were handled",
};
/** True when the call sits on the true side of a condition that proves `--json` (the same walk the JSON.stringify scan uses). */
function underJson(call: ts.Node, source: ts.SourceFile): boolean {
  let child: ts.Node = call, node: ts.Node | undefined = call.parent;
  while (node) {
    if (ts.isIfStatement(node) && node.thenStatement === child && selectsJson(node.expression, source)) return true;
    if (ts.isConditionalExpression(node) && node.whenTrue === child && selectsJson(node.condition, source)) return true;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && node.right === child && selectsJson(node.left, source)) return true;
    child = node; node = node.parent;
  }
  return false;
}
/**
 * Every print of a hub tool's text in `text`: `console.log(await taskOp(<op>))` and `console.log(x)` where `x` is bound from
 * `await taskOp(<op>)` in the same function. The ops are the string values the first argument can produce (a conditional is its
 * two branches, a variable is its assignments), kept only when they name a hub tool.
 */
export function taskOpPrints(file: string, text: string): TaskPrint[] {
  const source = parseSource(file, text), found: TaskPrint[] = [];
  const hubTools = readFileSync(join(import.meta.dir, "../src/hub/hub-tools.ts"), "utf8"), daemon = readFileSync(join(import.meta.dir, "../src/hub/daemon.ts"), "utf8");
  const produced = (node: ts.Expression): string[] => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? [node.text]
    : ts.isConditionalExpression(node) ? [...produced(node.whenTrue), ...produced(node.whenFalse)] : ts.isParenthesizedExpression(node) ? produced(node.expression) : [];
  const opsOf = (call: ts.CallExpression): string[] => {
    const first = call.arguments[0];
    if (!first) return [];
    let values = produced(first);
    if (ts.isIdentifier(first)) {
      const scope = enclosingFunction(source, call.getStart(source))?.node ?? source;
      values = [];
      const visit = (node: ts.Node) => { if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText(source) === first.text) values.push(...produced(node.right)); ts.forEachChild(node, visit); };
      visit(scope);
    }
    return values.filter(op => /^[a-z_]+$/.test(op) && (daemonToolCase(daemon, op) !== undefined || hubTools.includes(`tool("${op}"`)));
  };
  const siteOf = (node: ts.Node) => `${file} :: ${enclosingFunction(source, node.getStart(source))?.name ?? "(top level)"}`;
  const where = (node: ts.Node) => `${siteOf(node)} (line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1})`;
  for (const print of callSites(source, "console.log")) {
    const arg = print.arguments[0];
    if (!arg) continue;
    if (ts.isAwaitExpression(arg) && ts.isCallExpression(arg.expression) && arg.expression.expression.getText(source) === "taskOp") {
      found.push({ ops: opsOf(arg.expression), where: where(print), site: siteOf(print), guarded: underJson(print, source) });
    } else if (ts.isIdentifier(arg)) {
      const scope = enclosingFunction(source, print.getStart(source))?.node ?? source;
      const bound: ts.CallExpression[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === arg.text && node.initializer && ts.isAwaitExpression(node.initializer)
          && ts.isCallExpression(node.initializer.expression) && node.initializer.expression.expression.getText(source) === "taskOp") bound.push(node.initializer.expression);
        ts.forEachChild(node, visit);
      };
      visit(scope);
      if (bound.length) found.push({ ops: bound.flatMap(opsOf), where: where(print), site: siteOf(print), guarded: underJson(print, source) });
    }
  }
  return found;
}
const allTaskPrints = () => readdirSync(CLI_DIR).filter(name => name.endsWith(".ts")).sort().flatMap(name => taskOpPrints(name, readFileSync(join(CLI_DIR, name), "utf8")));

test("AC2 every print of a hub tool's text in src/cli is behind --json, a named sentence op, or named debt, checked against the daemon", () => {
  const prints = allTaskPrints(), daemon = readFileSync(join(import.meta.dir, "../src/hub/daemon.ts"), "utf8");
  const unnamed = prints.filter(print => !print.guarded).flatMap(print => print.ops.length
    ? print.ops.filter(op => !SENTENCE_OPS.has(op) && !(op in TEXT_DEBT) && !(op in CONDUCTOR_DEBT) && !(`${op} in ${print.site}` in REFUSAL_FALLBACK)).map(op => `${op} in ${print.where}`) : [`an op the hub has no tool for in ${print.where}`]);
  expect(unnamed, "print it through showToolText with a renderer, behind --json, or name it with its reason").toEqual([]);
  const printed = new Set(prints.filter(print => !print.guarded).flatMap(print => print.ops));
  expect([...SENTENCE_OPS, ...Object.keys(TEXT_DEBT), ...Object.keys(CONDUCTOR_DEBT)].filter(op => !printed.has(op)), "entries with no unguarded print any more: delete them").toEqual([]);
  const sites = new Set(prints.filter(print => !print.guarded).flatMap(print => print.ops.map(op => `${op} in ${print.site}`)));
  expect(Object.keys(REFUSAL_FALLBACK).filter(key => !sites.has(key)), "REFUSAL_FALLBACK entries with no print any more: delete them").toEqual([]);
  // the names are true: a sentence op never returns JSON text, and a debt op does
  for (const op of SENTENCE_OPS) expect(daemonCase(daemon, op), `${op} is named a sentence op but the daemon returns JSON.stringify`).not.toMatch(/return\s+JSON\.stringify|return\s+line\(\s*JSON/);
  for (const op of Object.keys(TEXT_DEBT)) expect(daemonCase(daemon, op), `${op} is named JSON debt but the daemon does not return JSON.stringify`).toMatch(/JSON\.stringify/);
  const conductor = readFileSync(join(import.meta.dir, "../src/hub/conductor.ts"), "utf8"), defined = readFileSync(join(import.meta.dir, "../src/hub/hub-tools.ts"), "utf8");
  for (const op of Object.keys(CONDUCTOR_DEBT)) {
    expect(defined, `${op} is named conductor debt but is not a hub tool`).toContain(`tool("${op}"`);
    expect(conductor, `${op} is named conductor debt but conductor.ts does not serve it`).toMatch(/hub_peer_release/.test(op) ? /\.release\(peer\)/ : new RegExp(`"${op}"`));
    expect(daemonToolCase(daemon, op), `${op} is conductor debt but the daemon's tool switch serves it as a sentence`).toBeUndefined();
  }
  // the converted ops (#814 T2) are still called, and never printed bare
  const converted = ["task_show", "hub_task_cancel", "hub_backlog_plan", "hub_backlog_return_untouched", "hub_backlog_pull", "hub_backlog_split", "hub_backlog_undo", "hub_planner_groom", "hub_release_list", "release_show", "release_new", "release_change"];
  const source = parseSource("main.ts", readFileSync(join(CLI_DIR, "main.ts"), "utf8"));
  expect(converted.filter(op => !callSites(source, "taskOp").some(call => call.arguments[0]?.getText(source) === `"${op}"`))).toEqual([]);
  expect(converted.filter(op => printed.has(op))).toEqual([]);
});

test("AC2 the print scanner itself: a new unlisted JSON-returning op fails, a --json branch passes, and a sentence claim is checked", () => {
  const unlisted = (code: string) => taskOpPrints("fixture.ts", code).filter(print => !print.guarded).flatMap(print => print.ops.map(op => ({ op, site: print.site }))).filter(({ op, site }) => !SENTENCE_OPS.has(op) && !(op in TEXT_DEBT) && !(op in CONDUCTOR_DEBT) && !(`${op} in ${site}` in REFUSAL_FALLBACK)).map(({ op }) => op);
  // a converted JSON op printed bare is unlisted, directly or through a variable
  expect(unlisted(`async function f() { console.log(await taskOp("hub_backlog_plan", {})); }`)).toEqual(["hub_backlog_plan"]);
  expect(unlisted(`async function f() { const text = await taskOp("hub_backlog_plan", {}); console.log(text); }`)).toEqual(["hub_backlog_plan"]);
  // behind --json it is the hub's text untouched: allowed
  expect(unlisted(`async function f(options: any) { const text = await taskOp("hub_backlog_plan", {}); if (options.json) console.log(text); }`)).toEqual([]);
  expect(unlisted(`async function f(args: string[]) { args.includes("--json") && console.log(await taskOp("hub_backlog_plan", {})); }`)).toEqual([]);
  // the negated branch is not a guard
  expect(unlisted(`async function f(options: any) { if (!options.json) console.log(await taskOp("hub_backlog_plan", {})); }`)).toEqual(["hub_backlog_plan"]);
  // a named sentence op is allowed bare; a name that is not a hub tool is reported as having none
  expect(unlisted(`async function f() { console.log(await taskOp("task_escalate", {})); }`)).toEqual([]);
  expect(taskOpPrints("fixture.ts", `async function f() { console.log(await taskOp("no_such_op_anywhere", {})); }`).map(print => print.ops)).toEqual([[]]);
  // printing something that is not a taskOp result is not a print of hub text
  expect(taskOpPrints("fixture.ts", `async function f() { const x = 1; console.log(x); console.log(await other("task_show")); }`)).toEqual([]);
  // a variable op resolves through its assignments, a conditional through both branches
  expect(taskOpPrints("fixture.ts", `async function f(c: string) { let op: string; op = c === "a" ? "hub_peer_hold" : "hub_peer_release"; console.log(await taskOp(op, {})); }`).map(print => print.ops)).toEqual([["hub_peer_hold", "hub_peer_release"]]);
  expect(taskOpPrints("fixture.ts", `async function f(sub: string) { console.log(await taskOp(sub === "a" ? "task_assign" : "task_unassign", {})); }`).map(print => print.ops)).toEqual([["task_assign", "task_unassign"]]);
});
