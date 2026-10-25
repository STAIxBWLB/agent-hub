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
  // Not in #814 Context: both predate it or were added after it was verified. Listed so the guard passes now; #814 should name them.
  "main.ts :: commands.sdlc :: console.log(JSON.stringify({ task: reply.task, mode: reply.mode, ran: reply.ran, decision: #1": "sdlc merge (#786, after #814's Context was verified): a result to convert in a later #814 task",
  "main.ts :: commands.doctor :: console.log(JSON.stringify(result,null,2)) #1": "doctor --orphans --kill for a conductor shell: not listed in #814 Context",
};

const JSON_CONDITION = /--json|\bjson\b|\.json\b|jsonApply/i;
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

interface Site { key: Key; line: number; guarded: boolean }
export function sitesOf(file: string, text: string): Site[] {
  const source = parseSource(file, text), sites: Site[] = [], seen = new Map<string, number>();
  for (const call of callSites(source, "console.log")) {
    const arg = call.arguments[0];
    if (!arg || !ts.isCallExpression(arg) || arg.expression.getText(source) !== "JSON.stringify") continue;
    let guarded = false, child: ts.Node = call, node: ts.Node | undefined = call.parent;
    while (node && !guarded) {
      if (ts.isIfStatement(node) && node.thenStatement === child) guarded = isJson(node.expression, source);
      else if (ts.isConditionalExpression(node) && node.whenTrue === child) guarded = isJson(node.condition, source);
      else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && node.right === child) guarded = isJson(node.left, source);
      child = node; node = node.parent;
    }
    const fn = enclosingFunction(source, call.getStart(source))?.name ?? "(top level)";
    const base = `${file} :: ${fn} :: ${flat(call.getText(source)).slice(0, 90)}`, ordinal = (seen.get(base) ?? 0) + 1;
    seen.set(base, ordinal);
    sites.push({ key: `${base} #${ordinal}`, line: source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1, guarded });
  }
  return sites;
}
/** The condition selects `--json` on its true side: it names json and is not a bare negation of it. */
function isJson(condition: ts.Expression, source: ts.SourceFile): boolean {
  const text = condition.getText(source);
  if (!JSON_CONDITION.test(text)) return false;
  return !(ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken);
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

test("AC2 the guard itself: guarded forms pass, unguarded and negated forms fail, a rewritten site no longer matches its key", () => {
  const sites = (code: string) => sitesOf("fixture.ts", `function f(options: any, display: any) { ${code} }`);
  const guarded = ["if (options.json) console.log(JSON.stringify(x));", "if (options.json) { console.log(JSON.stringify(x, null, 2)); }", "options.json ? console.log(JSON.stringify(x)) : print(x);",
    "options.json && console.log(JSON.stringify(x));", "if (display.json && code === 0) console.log(JSON.stringify(x));", "if (args.includes(\"--json\")) return console.log(JSON.stringify(x));", "if (jsonApply) console.log(JSON.stringify(x));"];
  for (const code of guarded) expect(sites(code).map(site => site.guarded), code).toEqual([true]);
  const unguarded = ["console.log(JSON.stringify(x));", "if (!options.json) console.log(JSON.stringify(x));", "if (options.json) print(x); else console.log(JSON.stringify(x));", "options.json ? print(x) : console.log(JSON.stringify(x));",
    "if (options.full) console.log(JSON.stringify(x));", "console.error(JSON.stringify(x));"];
  expect(unguarded.map(code => sites(code).some(site => site.guarded))).toEqual(unguarded.map(() => false));
  expect(sites("console.error(JSON.stringify(x));")).toEqual([]);
  expect(sites("console.log(JSON.stringify(x))")[0]!.key).not.toBe(sites("console.log(JSON.stringify(y))")[0]!.key);
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
