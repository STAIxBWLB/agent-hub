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
  renderLimits,
  renderTotal,
  renderUsage,
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
import { formatPerson, formatReport, formatTaskReport, summarize, summarizeByTask } from "../src/hub/report.ts";

import { renderRoadmap } from "../src/cli/roadmap.ts";
import { renderBudgetResult, renderRecoveryStatus, renderStoppedPlan, renderStoppedResults, renderUpgradePlan } from "../src/cli/upgrade-output.ts";

import { renderAutonomyStatus } from "../src/cli/autonomy.ts";
import { renderEditPreview } from "../src/cli/settings-edit.ts";
import { renderTailEvent } from "../src/cli/tail-render.ts";
import { benchCompare, benchReport, formatCompare, formatReport as formatBenchReport, formatRuns } from "../src/hub/bench.ts";
import { renderCheckpoint } from "../src/hub/checkpoint-fields.ts";
import { renderHeldHint } from "../src/hub/delivery-hints.ts";
import { renderHeldInbox } from "../src/hub/delivery-public.ts";
import { formatAddons, formatResearch, researchReport } from "../src/hub/research.ts";

import { renderPet } from "../src/cli/pet.ts";
import { renderBlocked, renderMenu, renderOperation, renderPlan, renderStep, renderSummary, renderWait } from "../src/cli/upgrade-presentation.ts";
import { formatClaudeFailure } from "../src/hub/claude-failure-stage.ts";
import { renderDigest } from "../src/hub/envelope.ts";
import { renderInvocationResult } from "../src/hub/invocations.ts";

import type { RecoveryOperation, UpgradePlan } from "../src/cli/upgrade.ts";
import { renderRestoreTransitionTable } from "../src/cli/upgrade-restore-state.ts";
import { renderActivity } from "../src/cli/watch.ts";
import { dogfoodScorecard, formatDogfood } from "../src/hub/dogfood.ts";
import { formatMemoryProfileCheck } from "../src/hub/memory-profile-check.ts";
import { formatMemoryStaleAnchors } from "../src/hub/memory-stale-anchors.ts";
import { renderFindingAnchor, renderReviewBrief, renderSpecTaskReport } from "../src/hub/review-brief.ts";
import { formatInZone } from "../src/hub/schedules.ts";

import { UNKNOWN_PERSON_FIGURES } from "../src/hub/person-figures.ts";

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
const literalRows: string[] = [];
const literalOutput = /^(?:console\.(?:log|error|warn)|process\.(?:stdout|stderr)\.write)$/;
const matchOutput = /^(?:console\.(?:log|error|warn)|process\.(?:stdout|stderr)\.write|printOutput|showToolText|fail|render[A-Z]\w*|format[A-Z]\w*)$/;
for (const [command, { handler }] of dispatch) {
  if (!handler) continue;
  const sites = new Map<string, number>();
  function walk(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const called = node.expression.getText(main);
      if (matchOutput.test(called)) sites.set(called, (sites.get(called) ?? 0) + 1);
      const [literal, ...otherArgs] = node.arguments;
      if (literalOutput.test(called) && literal && !otherArgs.length && ts.isStringLiteralLike(literal)) {
        const line = main.getLineAndCharacterOfPosition(node.getStart(main)).line + 1;
        const stream = called === "console.log" || called === "process.stdout.write" ? "stdout" : "stderr";
        literalRows.push(row(command, "src/cli/main.ts:" + line, stream, String(width(literal.text))));
      }
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
const missingUsage = { value: null, source: "unknown" } as const;
const presentation = { columns, color: false, now: () => now };
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
  renderUsage: renderUsage({ by: "peer", rows: [], coverage: { records: 0, withUsage: 0, withoutUsage: 0 }, throughOffset: 0 }, columns),
  renderLimits: renderLimits({ history: [], total: 0, shown: 0, truncated: false, omitted: 0, limit: 1, maxLimit: 1, open: [], endedUnknown: [] }, undefined, columns),
  renderTotal: renderTotal({ since: null, peers: [], overall: { tokens: missingUsage, withoutCache: missingUsage, cacheRead: missingUsage },
    unknownPeers: { tokens: [], withoutCache: [], cacheRead: [] } }, columns),
  renderCapabilities: renderCapabilities({}, columns),
};
const reportByTask = renderReport(summarizeByTask([]), columns, now, true);
const upgradePlan: UpgradePlan = {
  schema: 1, kind: "restart", version: status.version, sourceRoot: project.root,
  sourceDigest: "fixture", projects: [], fingerprint: "example", blockers: [],
};
const recovery: RecoveryOperation = {
  schema: 1, id: "recovery-fixture", plan: upgradePlan, createdAt: now, updatedAt: now,
  phase: "pending", step: "stage", sourceRoot: project.root, projects: [],
};
const reviewHead = "a".repeat(40);
const noSource = { available: false, complete: false, data: [] };
const textWidths = new Map([
  ["src/cli/help.ts:renderHelp", width(renderHelp(columns, false))],
  ["src/cli/help.ts:renderOverview", width(renderHelp(columns, false))],
  ["src/cli/help.ts:renderCommandHelp", Math.max(...[...documented].map(name => width(renderHelp(columns, false, name))))],
  ["src/cli/roadmap.ts:renderRoadmap", width(renderRoadmap({ milestones: [] }, columns))],
  ["src/cli/autonomy.ts:renderAutonomyStatus", width(renderAutonomyStatus({ environment: "dev", runtime: "stopped", peers: [] }, "/fixture-home")!.join("\n"))],
  ["src/cli/settings-edit.ts:renderEditPreview", width(renderEditPreview({ lines: ["Project configuration preview"], confirm: "example" }).join("\n"))],
  ["src/cli/tail-render.ts:renderTailEvent", width(renderTailEvent({ t: "state", peer: "codex", state: "idle" }))],
  ["src/hub/bench.ts:formatRuns", width(formatRuns([]).join("\n"))],
  ["src/hub/checkpoint-fields.ts:renderCheckpoint", width(renderCheckpoint("Review ready", { done: "Verified the change" }))],
  ["src/hub/delivery-hints.ts:renderHeldHint", width(renderHeldHint({ count: 1, rows: [], truncated: true }, now))],
  ["src/hub/delivery-public.ts:renderHeldInbox", width(renderHeldInbox({ count: 1, rows: [], truncated: true }))],
  ["src/hub/report.ts:formatReport", width(formatReport(summarize([])).join("\n"))],
  ["src/hub/report.ts:formatTaskReport", width(formatTaskReport(summarizeByTask([])).join("\n"))],
  ["src/hub/research.ts:formatAddons", width(formatAddons([]).join("\n"))],
  ["src/cli/pet.ts:renderPet", width(renderPet({ unavailable: true }))],
  ["src/cli/upgrade-output.ts:renderStoppedResults", width(renderStoppedResults([{ id: project.id, root: project.root, outcome: "retargeted", to: status.version }], presentation).join("\n"))],
  ["src/cli/upgrade-presentation.ts:renderStep", width(renderStep("Verify restored runtime", "waiting", undefined, presentation).join("\n"))],
  ["src/cli/upgrade-presentation.ts:renderMenu", width(renderMenu([{ key: "q", label: "Quit recovery" }], presentation).join("\n"))],
  ["src/hub/claude-failure-stage.ts:formatClaudeFailure", width(formatClaudeFailure({}, false))],
  ["src/hub/envelope.ts:renderDigest", width(renderDigest([], false))],
  ["src/hub/invocations.ts:renderInvocationResult", width(renderInvocationResult({ target: "codex", capabilityId: "review", id: "invocation-a", outcome: "completed", body: "Review complete" }).body)],
  ["src/cli/upgrade-output.ts:renderUpgradePlan", width(renderUpgradePlan(upgradePlan, status.version, presentation).join("\n"))],
  ["src/cli/upgrade-output.ts:renderStoppedPlan", width(renderStoppedPlan({ schema: 1, kind: "upgrade", mode: "runtime-selection", scope: "all-stopped", version: status.version, rows: [], blockers: [], fingerprint: "example" }, status.version, presentation).join("\n"))],
  ["src/cli/upgrade-output.ts:renderRecoveryStatus", width(renderRecoveryStatus(recovery, undefined, [], presentation).join("\n"))],
  ["src/cli/upgrade-presentation.ts:renderPlan", width(renderPlan(upgradePlan, status.version, presentation, ["Restart plan"]).join("\n"))],
  ["src/cli/upgrade-presentation.ts:renderOperation", width(renderOperation(recovery, undefined, presentation).join("\n"))],
  ["src/cli/upgrade-presentation.ts:renderBlocked", width(renderBlocked({ ...recovery, phase: "blocked" }, [], presentation).join("\n"))],
  ["src/cli/upgrade-presentation.ts:renderWait", width(renderWait(recovery, "prepare", ["Active turn"], presentation).join("\n"))],
  ["src/cli/upgrade-presentation.ts:renderSummary", width(renderSummary(recovery, undefined, presentation).join("\n"))],
  ["src/cli/upgrade-restore-state.ts:renderRestoreTransitionTable", width(renderRestoreTransitionTable())],
  ["src/cli/watch.ts:renderActivity", width(renderActivity("codex", { kind: "message", text: "Review ready", at: now, turn: 1 }, columns, false).join("\n"))],
  ["src/hub/bench.ts:formatReport", width(formatBenchReport(benchReport([])).join("\n"))],
  ["src/hub/bench.ts:formatCompare", width(formatCompare(benchCompare([])).join("\n"))],
  ["src/hub/dogfood.ts:formatDogfood", width(formatDogfood(dogfoodScorecard({ since: now, until: now, events: noSource, tasks: noSource, prs: noSource, log: noSource, features: noSource })).join("\n"))],
  ["src/hub/memory-profile-check.ts:formatMemoryProfileCheck", width(formatMemoryProfileCheck({ ready: true, expected: { home: "/fixture-home", profile: "shared-v1", selectorRevision: "absent" }, daemons: [] }))],
  ["src/hub/memory-stale-anchors.ts:formatMemoryStaleAnchors", width(formatMemoryStaleAnchors({ state: "unknown", rows: [], scanned: 0, queried: 0, stale: 0, unknown: null, truncated: false, limit: 1, scanLimit: 1 }))],
  ["src/hub/research.ts:formatResearch", width(formatResearch(researchReport([], now)).join("\n"))],
  ["src/hub/review-brief.ts:renderSpecTaskReport", width(renderSpecTaskReport({ head: reviewHead, complete: true, errors: 0, unchanged: [], changed: [] }))],
  ["src/hub/review-brief.ts:renderReviewBrief", width(renderReviewBrief({ head: reviewHead, base: "origin/main", mergeBase: reviewHead, reviewable: [], symbols: { state: "unknown", files: [], planned: [], unplanned: [], unseen: [] }, excluded: [], withheld: 0, rules: [], rulesMissing: [], ruleGroups: [], unlisted: [] }))],
  ["src/hub/schedules.ts:formatInZone", width(formatInZone(now, "UTC"))],
  ["src/hub/report.ts:formatPerson", width(formatPerson(UNKNOWN_PERSON_FIGURES))],
  ["src/hub/review-brief.ts:renderFindingAnchor", width(renderFindingAnchor({ id: "bugs:fixture", pass: "bugs", severity: "important",
    disposition: "open", anchor: { path: "report.md", selectors: [{ kind: "lineRange", startLine: 1, endLine: 1 }] } }, { status: "anchored" }))],
]);
const scopeNotes = new Map([
  ["src/cli/console-state.ts:renderConsole", "Full-screen console"],
  ["src/cli/console-state.ts:renderConsoleLines", "Full-screen console"],
  ["src/hub/ui.ts:renderDashboard", "Web dashboard"],
  ["src/hub/guidance-variants.ts:renderGuidanceVariantV1", "Guidance payload for agents"],
  ["src/hub/report.ts:formatUsage", "Internal report section, no separate view"],
  ["src/hub/review-brief.ts:renderCodeSymbols", "Measured within review brief"],
  ["src/hub/review-comments.ts:renderReviewComment", "Owner-facing hub delivery"],

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
        : scopeNotes.get(location) ?? "Unmeasured";
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
  "## Inline literal output", "",
  "Widths for single literal strings emitted directly from CLI handlers. No wrapping is applied by these call sites.",
  "Interpolated and daemon-supplied strings require runtime fixtures. They are counted above but have no width here.", "",
  "| Command | Text source | Stream | Literal width |", "| --- | --- | --- | ---: |", ...literalRows, "",
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
