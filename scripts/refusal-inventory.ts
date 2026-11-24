import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { BUILTIN_CLI_ENTRIES } from "../src/adapters/registry.ts";
import { checkShrinkOnly } from "./lib/inventory-check.ts";
import { parseSource } from "./lib/ts-ast.ts";
import { helpFlags } from "../src/cli/help.ts";
import { inspectContinuations, collectRefusals } from "./lib/refusal-check.ts";

const root = join(import.meta.dir, "..");

function* sourceFiles(folder: string): Generator<string> {
  for (const entry of readdirSync(join(root, folder), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = folder + "/" + entry.name;
    if (entry.isDirectory()) yield* sourceFiles(file);
    else if (entry.isFile() && entry.name.endsWith(".ts")) yield file;
  }
}

const sites = [...sourceFiles("src")].flatMap(file => collectRefusals(file, readFileSync(join(root, file), "utf8")));
const counts = new Map<string, { sites: number; dynamic: number }>();
for (const site of sites) {
  const count = counts.get(site.carrier) ?? { sites: 0, dynamic: 0 };
  count.sites++;
  if (!site.message.fragments.some(Boolean) && !site.next?.fragments.some(Boolean)) count.dynamic++;
  counts.set(site.carrier, count);
}

const mainPath = "src/cli/main.ts";
const main = parseSource(mainPath, readFileSync(join(root, mainPath), "utf8"));
const commands = main.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
  .find(node => ts.isIdentifier(node.name) && node.name.text === "commands")?.initializer;
if (!commands || !ts.isObjectLiteralExpression(commands)) throw new Error("ahub dispatch table not found");

const dispatch = new Set(BUILTIN_CLI_ENTRIES.map(entry => entry.command));
for (const property of commands.properties) {
  if (ts.isPropertyAssignment(property) && (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name)))
    dispatch.add(property.name.text);
}
for (const name of ["--project", "--live-test"]) dispatch.add(name); // processed before dispatch
const commandFlags = new Map([...dispatch].map(name => [name, new Set(helpFlags(name).map(item => item.flag))]));
const toolSources = ["src/hub/hub-tools.ts", "src/adapters/claude-channel.ts"]; // the channel also declares its own small set of tools
const tools = new Set(toolSources.flatMap(file => [...readFileSync(join(root, file), "utf8")
  .matchAll(/\b(?:tool\(\s*|name:\s*)"(hub_[a-z][a-z0-9_]*)"/g)].map(match => match[1]!)));
const checked = sites.map(site => {
  const fragments = [...site.message.fragments, ...(site.next?.fragments ?? [])];
  const dynamic = !fragments.some(fragment => fragment.trim());
  const result = inspectContinuations(fragments, { commandFlags, tools });
  const marker = site.marker !== undefined && /^(?:operator-knowledge|world-action|human-authority):\s*\S/.test(site.marker);
  const diagnostic = site.file + ":" + site.line;
  const errors = result.errors.map(error => diagnostic + " " + error);
  if (site.marker !== undefined && !marker) errors.push(diagnostic + " invalid refusal:by-design marker or missing reason");
  return { ...site, dynamic, fragments, found: result.found || marker, errors };
});
const invalid = checked.flatMap(site => site.errors);
const missing = checked.filter(site => !site.found && !site.dynamic);
const keyOf = (site: typeof checked[number]) => JSON.stringify([site.file, site.fragments]);
const keys = new Set(missing.map(keyOf));
const dynamic = checked.filter(site => site.dynamic);
const baselineFile = "scripts/refusal-inventory.baseline.json";

if (process.argv[2] === "--json") {
  process.stdout.write(JSON.stringify({ counts: Object.fromEntries(counts), sites: checked, invalid }, null, 2) + "\n");
} else if (process.argv[2] === "--check-continuations") {
  for (const error of invalid) console.error(error);
  if (invalid.length) process.exitCode = 1;
} else if (process.argv[2] === "--write-initial-baseline") {
  const baseline = { dynamicCeiling: dynamic.length, missing: [...keys].sort() };
  const file = Bun.file(join(root, baselineFile));
  if (await file.exists()) throw new Error("the committed refusal baseline only shrinks");
  await Bun.write(file, JSON.stringify(baseline, null, 2) + "\n");
} else if (process.argv[2] === "--check") {
  const baseline = JSON.parse(readFileSync(join(root, baselineFile), "utf8")) as { dynamicCeiling: number; missing: string[] };
  const delta = checkShrinkOnly(keys, new Set(baseline.missing));
  const fresh = new Set(delta.fresh);
  const errors = [...invalid,
    ...missing.filter(site => fresh.has(keyOf(site))).map(site => site.file + ":" + site.line + " missing continuation: " + site.fragments.join(" <value> ")),
    ...delta.gone.map(key => "remove stale refusal baseline key " + key),
  ];
  if (dynamic.length !== baseline.dynamicCeiling) {
    errors.push(dynamic.length > baseline.dynamicCeiling ? "fully dynamic refusal count grew" : "lower the fully dynamic refusal ceiling");
    errors.push(...dynamic.map(site => site.file + ":" + site.line + " fully dynamic refusal"));
  }
  for (const error of errors) console.error(error);
  if (errors.length) process.exitCode = 1;
} else if (process.argv[2] === undefined) {
  for (const [carrier, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(carrier + ": " + count.sites + " sites, " + count.dynamic + " fully dynamic");
  }
} else {
  throw new Error("usage: bun scripts/refusal-inventory.ts [--json|--check-continuations|--check]");
}
