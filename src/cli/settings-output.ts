import { settingText, type SettingRow } from "../hub/settings.ts";
import { Report, terminalText, type Span } from "./console-state.ts";

function acceptedValues(row: SettingRow): string {
  if (row.type === "boolean") return "true, false";
  const range = `from ${row.min ?? 0} to ${row.max ?? "the configured bound"}`;
  if (row.type === "number-or-off") return `off or a number ${range}`;
  if (row.type === "integer" || row.type === "number") return `a number ${range}`;
  if (row.type === "peers") return "a comma list of peer ids";
  if (row.type === "roles") return "up to two comma-separated catalog ids";
  return (row.values ?? []).join(", ");
}

export function renderSettingsRows(view: { rows: readonly SettingRow[]; detail?: boolean; pendingRestart?: readonly { key: string }[]; undo?: string }, columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const report = new Report(columns, ascii).titled("ahub", "Settings");
  let group: string | undefined;
  for (const row of view.rows) {
    if (row.group !== group) report.section(group = row.group);
    report.kv([[row.key, settingText(row.value)]]);
    const applies = row.applies === "live" ? "applies at once" : row.applies === "next use" ? "applies at next use" : "pending restart";
    const file = settingText(row.fileValue === undefined ? row.pending ?? row.value : row.fileValue);
    report.note([`from ${row.source}`, `file: ${file}`, applies, row.restartReason, row.note].filter(Boolean).join("; "));
    if (view.detail) {
      const inherit = row.file === "this hub run" || row.key === "instructed.mode" ? "" : ", or inherit to remove the machine-local value";
      report.note(`${row.label}; written to ${row.file}; takes ${acceptedValues(row)}${inherit}`);
      if (row.risk === "raises") report.note("a dashboard needs a settings session (ahub ui --settings) to raise it");
    }
  }
  if (!view.rows.length) report.section("Settings").note("no settings found");
  if (view.pendingRestart?.length) report.section("Pending restart").note(view.pendingRestart.map(row => row.key).join(", "));
  if (view.undo) report.section("Undo").note(`ahub settings undo puts back the last write (${view.undo})`);
  return report.lines();
}

export function renderSdlcSetting(view: { key: string; value: unknown; fileValue: unknown; problem?: unknown }, columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const report = new Report(columns, ascii).titled("ahub", "Settings", terminalText(view.key))
    .section("Values").kv([["running", JSON.stringify(view.value)], ["file", JSON.stringify(view.fileValue)]]);
  if (view.problem) report.bullet("warn", "file unavailable");
  return report.lines();
}

export function renderSettingsConfirmation(changes: readonly { key: string; before: string; after: string; effect?: string }[], columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const report = new Report(columns, ascii).titled("ahub", "Guarded settings");
  for (const change of changes) {
    // The key can be longer than the section width. Keep it in a wrapped value.
    report.section("Change").kv([["setting", terminalText(change.key)], ["before", terminalText(change.before)], ["after", terminalText(change.after)]]);
    if (change.effect !== undefined) report.note(terminalText(change.effect));
  }
  return report.lines();
}

export function renderSettingsPreview(view: { lines?: readonly string[]; tasks?: readonly { before: readonly string[]; after: readonly string[] }[]; hidden?: number }, columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const report = new Report(columns, ascii).titled("ahub", "Settings preview");
  if (view.lines?.length) {
    report.section("Changes");
    for (const line of view.lines) report.note(line, "value");
  }
  // Route explain contributes a task title, a heading, then its trace.
  for (const task of view.tasks ?? []) {
    report.section("Routing").note(task.before[0] ?? "", "value").note("before:");
    for (const line of task.before.slice(2)) report.note(line);
    report.note("after:");
    for (const line of task.after.slice(2)) report.note(line);
  }
  report.section("Result");
  if (view.hidden) report.note(`${view.hidden} more open tasks are not shown`);
  return report.note("preview only; nothing was changed").lines();
}

export function renderSettingsReceipt(view: { title: string; lines: readonly string[] }, columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const report = new Report(columns, ascii).titled("ahub", view.title).section("Result");
  for (const line of view.lines) report.note(line, "value");
  return report.lines();
}

export function renderSettingsRejected(rows: readonly { key: unknown; reason: unknown }[], columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const report = new Report(columns, ascii).titled("ahub", "Settings reload").section("Rejected");
  for (const row of rows.slice(0, 100)) report.bullet("warn", terminalText(`${String(row.key).slice(0, 160)}: ${String(row.reason).slice(0, 1000)}`));
  return report.lines();
}
