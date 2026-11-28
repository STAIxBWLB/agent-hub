import { Report, terminalText, type Span } from "./console-state.ts";
import { resetLines, type ResetPlan } from "./reset.ts";

export const RESET_KEPT = "kept: the board, logs and audit, recovery records, execution budgets, configuration and pi-sessions/";
export const RESET_MEMORY = "claude-mem is not touched: notes saved with hub_remember stay in shared memory";

const exactLines = (lines: readonly string[]): Span[][] =>
  lines.flatMap(line => line.split("\n").map(text => [{ text }]));

/** Paths and instructions keep their line breaks so the dry run can be read or copied verbatim. */
export function renderResetPlan(view: {
  all: boolean; state: string; stateDir: string; archive: string; projectId: string;
  plan?: ResetPlan; unread?: string; stale: readonly string[];
}, _columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const report = new Report(undefined, ascii)
    .titled("ahub", `reset${view.all ? " --all" : ""}, dry run: the hub is ${view.state}${view.state === "stopped" ? "" : "; --yes stops it first, as ahub kill does"}`)
    .section("What --yes does");
  if (view.all) {
    report.note(`move ${view.stateDir}${view.plan ? ` (${view.plan.entries} entries)` : ""} to ${view.archive}/state-<UTC time>/ (0700), then start an empty state directory holding only project.json; project ${view.projectId} keeps its id and registration`, "value");
    report.note(view.unread ? `could not read the state (${view.unread}); it is archived as it is` : "archived as they are:", "value");
  } else report.note('settle as discard with reason "reset", clear and drop:', "value");
  if (view.plan) report.append(exactLines(resetLines(view.plan).map(line => `    ${line}`)));
  if (view.stale.length) report.note(`remove the manifest a hub left when it did not stop cleanly: ${view.stale.join(", ")}`, "value");
  report.note(view.all ? ".agenthub/config.json, config.local.json and routing.toml are outside the state directory and stay" : RESET_KEPT);
  report.note(RESET_MEMORY);
  return report.append(exactLines(["nothing was changed; add --yes to apply"])).lines();
}

export function renderUndoPlan(view: { id: string; restore: readonly string[]; unobserved: readonly string[]; undone: boolean },
  _columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const { id, restore, unobserved, undone } = view;
  const report = new Report(undefined, ascii).titled("ahub", "Undo", terminalText(id)).section("Changes");
  if (undone && !unobserved.length) return report.note(`turn ${id} is already undone: its files are as they were before it started`, "value").lines();
  if (undone) report.note(`turn ${id}: its files are as they were before it started`, "value");
  else if (restore.length) report.note(`turn ${id} changed:`, "value").append(exactLines(restore.map(path => `  ${path}`)));
  else report.note(`turn ${id} changed no files${unobserved.length ? " the hub can restore" : ""}`, "value");
  if (unobserved.length) {
    report.note("these submodules were changed during the turn and their contents cannot be restored (the hub does not observe inside a submodule); undo them in the submodule itself:");
    report.append(exactLines(unobserved.map(path => `  ${path}`)));
  }
  if (!undone) report.note("(every change made in the project during the turn counts as its own, including any by Claude or by you)");
  return report.lines();
}

/** Stream status and effect receipts in their original order. Continuations keep their exact line boundaries. */
export function renderLifecycleReceipt(view: { title?: string; lines: readonly string[] }, _columns?: number, _now = Date.now(), ascii = false): Span[][] {
  const report = new Report(undefined, ascii);
  if (view.title) report.titled("ahub", view.title).section("Result");
  return report.append(exactLines(view.lines)).lines();
}
