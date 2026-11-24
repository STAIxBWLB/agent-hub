import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { BUILTIN_CLI_ENTRIES } from "../src/adapters/registry.ts";
import { HELP, INTERNAL_COMMANDS, helpCommands, helpFlags, helpOverviewRows, renderHelp } from "../src/cli/help.ts";

import { paint } from "../src/cli/console-state.ts";
import {
  renderBacklog,
  renderBoard,
  renderBoardColumns,
  renderBudget,
  renderDoctor,
  renderExecutionBudgetStatus,
  renderModelsStatus,
  renderOrphanCleanup,
  renderOrphans,
  renderProjects,
  renderQueue,
  renderQueueShow,
  renderReport,
  renderRoles,
  renderRoster,
  renderRuntimeModels,
  renderStatus,
  renderStatusDefault,
  renderTurns,
} from "../src/cli/output.ts";
import {
  renderAuthorization,
  renderSdlcAudit,
  renderSdlcConfiguration,
  renderSdlcCosts,
  renderSdlcMerge,
  renderSdlcMetrics,
  renderSdlcQueue,
  renderSdlcRelease,
  renderSdlcSurvey,
} from "../src/cli/sdlc-output.ts";
import {
  renderExperiments,
  renderStudyEvidence,
  renderStudyList,
  renderStudyReceipt,
  renderStudyShow,
  renderSynthesisReadiness,
} from "../src/cli/study-output.ts";
import {
  renderBacklogResult,
  renderGroom,
  renderReleaseList,
  renderReleaseShow,
  renderTaskCancel,
  renderTaskShow,
} from "../src/cli/task-output.ts";
import { renderTidyPreview, renderTidyResult, renderWorktrees } from "../src/cli/worktrees-output.ts";
import { renderHandoffReceipt, renderHandoffs } from "../src/cli/handoff-output.ts";
import { renderIntake, renderIntakeChange } from "../src/cli/intake-output.ts";
import { renderLearnChange, renderLearnList } from "../src/cli/learn-output.ts";
import { renderScheduleChange, renderScheduleList, renderScheduleRun } from "../src/cli/schedule-output.ts";
import { renderSourceAdd, renderSourceList } from "../src/cli/source-output.ts";
import { renderCapabilities } from "../src/cli/capabilities-output.ts";
import { summarize, summarizeByTask } from "../src/hub/report.ts";

import { renderRoadmap } from "../src/cli/roadmap.ts";
import { renderBudgetResult } from "../src/cli/upgrade-output.ts";

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
const card = { id: 17, title: "Validate the project handoff before the release", state: "in_progress", class: "implement", created: now };
const release = { id: 7, name: "Small release", state: "active", tasks: [card] };
const project = { id: "p_example", root: "/project", state: "stopped" };
const finding = { name: "bun", detail: "1.4.4", level: "ok", section: "Tools" } as const;
const fixtures: Readonly<Record<string, ReturnType<typeof renderReport>>> = {
  renderDoctor: renderDoctor([finding], columns, now),
  renderStatusDefault: renderStatusDefault(status, columns, now),
  renderStatus: renderStatus(status, columns, now, true),
  renderProjects: renderProjects([project], columns, now),
  renderReport: renderReport(summarize([]), columns, now),
  renderBacklog: renderBacklog([card], columns, now),
  renderBoard: renderBoard([card], columns, now),
  renderBoardColumns: renderBoardColumns([card], {}, columns, now),
  renderBudget: renderBudget({ budget: {} }, columns, now),
  renderOrphans: renderOrphans([{ project, pids: [status.pid] }], columns, now),
  renderOrphanCleanup: renderOrphanCleanup({}, columns, now),
  renderQueue: renderQueue([], columns, now),
  renderQueueShow: renderQueueShow({ id: "delivery-a", state: "queued", peer: "codex" }, columns, now),
  renderTurns: renderTurns([], columns, now),
  renderModelsStatus: renderModelsStatus({}, columns, now),
  renderExecutionBudgetStatus: renderExecutionBudgetStatus({}, columns, now),
  renderRuntimeModels: renderRuntimeModels([], columns),
  renderRoster: renderRoster([], columns),
  renderRoles: renderRoles({ peers: [{ peer: "codex", roles: ["implementer"] }], planner: null, reviewFallback: null }, columns),
  renderBudgetResult: renderBudgetResult("configure", {}, columns, now),
  renderTaskShow: renderTaskShow(card, columns, now),
  renderTaskCancel: renderTaskCancel({ ...card, cancelled: { reason: "Superseded" } }, columns, now),
  renderBacklogResult: renderBacklogResult("plan", card, columns, now),
  renderGroom: renderGroom({ items: [{ task: card.id, kind: "stale" }] }, columns, now),
  renderReleaseList: renderReleaseList([release], columns, now),
  renderReleaseShow: renderReleaseShow(release, columns, now),
  renderWorktrees: renderWorktrees({ live: [{ path: project.root, branch: "feature" }] }, columns, now),
  renderTidyPreview: renderTidyPreview({ entries: [], removable: [] }, columns),
  renderTidyResult: renderTidyResult([], columns),
  renderSdlcConfiguration: renderSdlcConfiguration({ by: "user" }, columns),
  renderSdlcSurvey: renderSdlcSurvey({ task: card.id }, columns),
  renderSdlcQueue: renderSdlcQueue({}, columns, now),
  renderSdlcAudit: renderSdlcAudit({}, columns, now),
  renderSdlcRelease: renderSdlcRelease({}, columns, now),
  renderSdlcMetrics: renderSdlcMetrics({}, columns, now),
  renderSdlcCosts: renderSdlcCosts({}, columns, now),
  renderAuthorization: renderAuthorization({}, columns, now),
  renderSdlcMerge: renderSdlcMerge({}, columns, now),
  renderStudyList: renderStudyList({}, columns),
  renderStudyShow: renderStudyShow({}, columns),
  renderStudyReceipt: renderStudyReceipt("draft", {}, columns),
  renderExperiments: renderExperiments({}, columns),
  renderStudyEvidence: renderStudyEvidence({}, columns),
  renderSynthesisReadiness: renderSynthesisReadiness({}, columns),
  renderHandoffReceipt: renderHandoffReceipt({ project: project.id, task: card.id }, columns),
  renderHandoffs: renderHandoffs({ handoffs: [] }, columns),
  renderIntake: renderIntake({}, columns),
  renderIntakeChange: renderIntakeChange("approve", {}, columns),
  renderLearnList: renderLearnList({}, columns),
  renderLearnChange: renderLearnChange("accept", {}, columns),
  renderScheduleList: renderScheduleList([], columns, now),
  renderScheduleRun: renderScheduleRun({}, columns),
  renderScheduleChange: renderScheduleChange("pause", [], columns, now),
  renderSourceAdd: renderSourceAdd({}, columns),
  renderSourceList: renderSourceList([], columns, now),
  renderCapabilities: renderCapabilities({}, columns),
};
const reportByTask = renderReport(summarizeByTask([]), columns, now, true);
const textWidths = new Map([
  ["src/cli/help.ts:renderHelp", width(renderHelp(columns, false))],
  ["src/cli/help.ts:renderOverview", width(renderHelp(columns, false))],
  ["src/cli/help.ts:renderCommandHelp", Math.max(...[...documented].map(name => width(renderHelp(columns, false, name))))],
  ["src/cli/roadmap.ts:renderRoadmap", width(renderRoadmap({ milestones: [] }, columns))],
]);
const excluded = new Map([
  ["src/cli/console-state.ts:renderConsole", "Full-screen console"],
  ["src/cli/console-state.ts:renderConsoleLines", "Full-screen console"],
  ["src/hub/ui.ts:renderDashboard", "Web dashboard"],
]);
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
      const fixture = dir === "src/cli" ? fixtures[symbol] : undefined;
      const location = path + ":" + symbol;
      const measure = fixture ? String(width(fixture.map(line => paint(line, false)).join("\n")))
        : textWidths.has(location) ? String(textWidths.get(location))
        : excluded.get(location) ?? "Unmeasured";
      rendererRows.push(row(location, dir === "src/cli" ? "CLI" : "Hub", elements.some(element => element === "Report" || element === "LayoutReport") ? "Direct" : "-", elements.join(", ") || "Inline / indirect", measure));
    }
  }
}
const taskReportWidth = width(reportByTask.map(line => paint(line, false)).join("\n"));

const output = [
  "# CLI output inventory", "",
  "Snapshot recorded 2026-11-25 for #1654 T1.", "",
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
  "| File and renderer | Text source | Report | Direct layout references | Fixture width or scope |", "| --- | --- | --- | --- | --- |", ...rendererRows, "",
].join("\n");
const file = "docs/design/cli-output-inventory.md";
switch (process.argv[2]) {
  case "--write": await Bun.write(join(root, file), output); break;
  case "--check": if (readFileSync(join(root, file), "utf8") !== output) throw new Error(file + " is stale. Run bun scripts/cli-output-inventory.ts --write"); break;
  case undefined: process.stdout.write(output); break;
  default: throw new Error("usage: bun scripts/cli-output-inventory.ts [--write|--check]");
}
