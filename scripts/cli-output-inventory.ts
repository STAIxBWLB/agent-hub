import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { BUILTIN_CLI_ENTRIES } from "../src/adapters/registry.ts";
import { HELP, INTERNAL_COMMANDS, helpCommands, helpFlags, helpOverviewRows, renderHelp } from "../src/cli/help.ts";

import { paint } from "../src/cli/console-state.ts";
import { renderDoctor, renderProjects, renderReport, renderStatus, renderStatusDefault } from "../src/cli/output.ts";
import { summarize, summarizeByTask } from "../src/hub/report.ts";

const root = join(import.meta.dir, "..");
const parse = (path: string) => ts.createSourceFile(path, readFileSync(join(root, path), "utf8"), ts.ScriptTarget.Latest, true);
const columns = 80;
const width = (text: string) => Math.max(0, ...text.split("\n").map(line => Bun.stringWidth(line)));
const cell = (text: string) => text.replaceAll("|", "&#124;").replaceAll("\n", " ");
const row = (...cells: string[]) => "| " + cells.map(cell).join(" | ") + " |";

const main = parse("src/cli/main.ts");
const declaration = main.statements.flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])
  .find(item => item.name.getText(main) === "commands");
if (!declaration?.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) throw new Error("CLI commands declaration not found");

const dispatch = new Map<string, { source: string; handler?: ts.Node }>();
for (const property of declaration.initializer.properties) {
  if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
    dispatch.set(property.name.text, { source: "main.ts", handler: property.initializer });
  } else if (ts.isSpreadAssignment(property) && property.expression.getText(main).includes("BUILTIN_CLI_ENTRIES")) {
    for (const entry of BUILTIN_CLI_ENTRIES) dispatch.set(entry.command, { source: "adapter", handler: property.expression });
  } else throw new Error("Unhandled command declaration: " + property.getText(main).slice(0, 80));
}

const overview = helpOverviewRows();
const documented = new Set(HELP.flatMap(helpCommands));
const commandRows = [...new Set([...dispatch.keys(), ...documented])].sort().map(name => {
  const help = renderHelp(columns, false, name);
  const entries = HELP.filter(entry => helpCommands(entry).includes(name));
  const summaries = overview.filter(item => item.name.split("|").includes(name));
  const notes = [
    summaries.length > 1 ? "Duplicate overview" : "",
    INTERNAL_COMMANDS.includes(name) || entries.some(entry => /^(?:internal|hook):/i.test(entry.description)) ? "Internal" : "",
    /▸ Details\b/.test(help) ? "Repeated forms" : "",
    /\[[^\]\n]*\n\s+[^\]\n]*\]/.test(help) ? "Bracket wraps" : "",
    /\b(?:[A-Z][A-Z]+|N)\b/.test(entries.map(item => item.usage.replace(/<[^>]+>/g, "")).join(" ")) ? "Uppercase operand" : "",
    width(help) > columns ? "Over 80 cells" : "",
  ].filter(Boolean);
  return row(name, dispatch.get(name)?.source ?? "Help only", String(width(help)),
    summaries.map(item => item.section + " / " + item.summary + " (" + Bun.stringWidth(item.summary) + ")").join(" · ") || "-",
    /▸ Examples\b/.test(help) ? "Yes" : "No",
    helpFlags(name).map(item => item.flag).join(" ") || "-", notes.join(", ") || "-");
});

const outputRows: string[] = [];
const matchOutput = /^(?:console\.(?:log|error|warn)|process\.(?:stdout|stderr)\.write|printOutput|showToolText|fail|render[A-Z]\w*|format[A-Z]\w*)$/;
for (const [command, { handler }] of dispatch) {
  if (!handler) continue;
  const sites = new Map<string, number>();
  function walk(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const called = node.expression.getText(main);
      if (matchOutput.test(called)) sites.set(called, (sites.get(called) ?? 0) + 1);
    }
    ts.forEachChild(node, walk);
  }
  walk(handler);
  outputRows.push(row(command, [...sites].map(([name, count]) => name + " (" + count + ")").join(", ") || "Delegated / no direct output call"));
}

const now = Date.UTC(2026, 10, 24);
const status = { pid: 1234, version: "0.46.1", controlPort: 4600, cwd: "/project", peers: {} };
const fixtures = {
  renderDoctor: renderDoctor([{ section: "Tools", level: "ok", name: "bun", detail: "1.4.4" }], columns, now),
  renderStatusDefault: renderStatusDefault(status, columns, now),
  renderStatus: renderStatus(status, columns, now, true),
  renderProjects: renderProjects([{ id: "p_example", root: "/project", state: "stopped" }], columns, now),
  renderReport: renderReport(summarize([]), columns, now),
};
const reportByTask = renderReport(summarizeByTask([]), columns, now, true);
const rendererRows: string[] = [];
const layout = /\b(Report|LayoutReport|heading|pair|grid|table|blank|moment|printOutput|errorLines|paint|wrap)\b/g;
for (const dir of ["src/cli", "src/hub"]) {
  for (const name of readdirSync(join(root, dir)).filter(file => file.endsWith(".ts")).sort()) {
    const path = dir + "/" + name;
    const source = parse(path);
    for (const statement of source.statements) {
      if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body || !/^(?:render|format)[A-Z]/.test(statement.name.text)) continue;
      const symbol = statement.name.text;
      const elements = [...new Set(statement.body.getText(source).match(layout) ?? [])].sort();
      const fixture = Object.hasOwn(fixtures, symbol) && path === "src/cli/output.ts" ? fixtures[symbol as keyof typeof fixtures] : undefined;
      const measure = fixture ? String(width(fixture.map(line => paint(line, false)).join("\n"))) : "Unmeasured";
      rendererRows.push(row(path + ":" + symbol, elements.some(element => element === "Report" || element === "LayoutReport") ? "Direct" : "-", elements.join(", ") || "Inline / indirect", measure));
    }
  }
}
const taskReportWidth = width(reportByTask.map(line => paint(line, false)).join("\n"));

const output = [
  "# CLI output inventory", "",
  "Generated from the built-in dispatch table, adapter entries and HELP. Width is measured in terminal cells on color-off help at 80 columns.",
  "Overview summaries are recorded verbatim for the T2 grammar pass. Help-only entries include global forms.", "",
  "Overview width: " + width(renderHelp(columns, false)) + " cells. Dispatch entries: " + dispatch.size + ". Help command words: " + documented.size + ".", "",
  "| Command | Dispatch | Help width | Overview summary (cells) | Example | Flags | Observed help deviations |",
  "| --- | --- | ---: | --- | --- | --- | --- |", ...commandRows, "",
  "## Direct output call sites", "",
  "Counts come from each handler body in src/cli/main.ts. The adapter entries share one handler. These counts include machine and diagnostic branches.",
  "A delegated call needs its own renderer or a fixture before the human-view width can be measured.", "",
  "| Command | Direct output calls |", "| --- | --- |", ...outputRows, "",
  "## Renderer candidates", "",
  "Source scan for top-level render and format functions. The file shows where the text originates. Layout references are direct, and indirect composition needs manual review.",
  "Fixture widths are color-off at 80 columns. Unmeasured entries need fixtures before T3 or T4 makes a conformance claim.",
  "The separate report-by-task fixture measures " + taskReportWidth + " cells.", "",
  "| File and renderer | Report | Direct layout references | Fixture width |", "| --- | --- | --- | ---: |", ...rendererRows, "",
].join("\n");
const file = "docs/design/cli-output-inventory.md";
switch (process.argv[2]) {
  case "--write": await Bun.write(join(root, file), output); break;
  case "--check": if (readFileSync(join(root, file), "utf8") !== output) throw new Error(file + " is stale. Run bun scripts/cli-output-inventory.ts --write"); break;
  case undefined: process.stdout.write(output); break;
  default: throw new Error("usage: bun scripts/cli-output-inventory.ts [--write|--check]");
}
