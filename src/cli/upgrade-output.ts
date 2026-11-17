import { globalCliUpdateStep } from "./install-paths.ts";
// Human output for the commands #814 T3 converts: the non-interactive restart/upgrade plan, `recovery status`, and
// `budget execution configure|disable`. Recovery rendering is data in, lines out; CLI update advice inspects the install path. It composes the renderers the interactive
// screens already use (`planLines`, `renderPlan`, `renderOperation`, `renderBlocked`, `choiceInstruction`), so the
// non-interactive text never says something the screens would not. `--json` is the caller's branch and prints the
// document exactly as before.
import { planLines } from "./upgrade-interactive.ts";
import { choiceInstruction, renderBlocked, renderOperation, renderPlan, type RecoveryPresentationOptions } from "./upgrade-presentation.ts";
import { paint, terminalText, wrap, type Span, type Tone } from "./console-state.ts";
import { renderExecutionBudgetStatus } from "./output.ts";
import type { NextChoice, RecoveryOperation, UpgradePlan } from "./upgrade.ts";
import type { StoppedPlan, StoppedResult, StoppedRow } from "./upgrade-stopped.ts";

const columnsOf = (options: RecoveryPresentationOptions) => Number.isFinite(options.columns) ? Math.max(2, Math.floor(options.columns)) : 80;
const text = (value: string, tone: Tone, options: RecoveryPresentationOptions): string[] =>
  wrap(terminalText(value), columnsOf(options)).map(line => paint([{ text: line, tone }], options.color));

/**
 * The plan `restart` or `upgrade` would apply, for a person reading a pipe or a `--dry-run`: the same rows the plan
 * screen shows (a peer per line with how it runs and what happens to it), every blocker, and what the plan will not do.
 * Blockers, reconnect-only sessions and fresh starts are part of the rows, so none of them is stderr-only any more.
 * `applying` (#1540 AC9): under `--yes` the plan is the first part of an apply, so the closing line that says nothing was changed and offers `--yes` is left out.
 */
export function renderUpgradePlan(plan: UpgradePlan, current: string, options: RecoveryPresentationOptions, applying = false): string[] {
  const out = renderPlan(plan, current, options, planLines(plan, current));
  const blocked = plan.blockers.length > 0 || plan.projects.some(project => project.blockers.length > 0);
  if (!plan.projects.length) out.push(...text(plan.kind === "upgrade"
    ? `No hub is running, so nothing is carried over: ${globalCliUpdateStep(plan.version)}, then \`ahub setup\`.`
    : "This project's hub is not running: `ahub up` starts it.", "muted", options));
  if (blocked || !applying) out.push(...text(blocked
    ? "Blocked: take the next action each blocker names, then run this again. Nothing was changed."
    : "Nothing was changed. Apply with `--yes`.", blocked ? "failure" : "muted", options));
  return out;
}

const stoppedRowText = (plan: StoppedPlan, row: StoppedRow): { text: string; tone: Tone; next?: string } => {
  const single = plan.scope === "project";
  switch (row.outcome) {
    case "retarget": return { text: `${single ? "stopped" : "retarget"}: runtime selection only (${row.from ? `${row.from} to ` : ""}${plan.version})`, tone: "info" };
    case "current": return { text: `already at ${row.from ?? plan.version}`, tone: "muted" };
    case "running": return { text: `skipped: running; its own plan is \`${row.command}\``, tone: "attention" };
    case "refused": return { text: `refused: ${row.cause}`, tone: "failure", ...(row.next ? { next: row.next } : {}) };
  }
};

/**
 * #1540: the plan of `ahub upgrade` for stopped projects (one, or `--all-stopped`): a row per project with its outcome, never a peer. It changes nothing and says what applying does:
 * a runtime selection is written, and no hub, terminal or recovery operation is started.
 */
export function renderStoppedPlan(plan: StoppedPlan, current: string, options: RecoveryPresentationOptions, applying = false): string[] {
  const out = [...text(`upgrade to ${plan.version}: runtime selection of ${plan.scope === "all-stopped" ? "stopped projects" : "a stopped project"}`, "strong", options), ...text(`Coordinator version ${current}`, "muted", options)];
  if (!plan.rows.length) out.push(...text(plan.scope === "all-stopped" ? "No project is registered." : "This project is not registered.", "muted", options));
  for (const row of plan.rows) {
    const view = stoppedRowText(plan, row);
    out.push(...text(`${row.project.id}  ${row.project.root}`, "info", options), ...text(`  ${view.text}`, view.tone, options));
    if (view.next) out.push(...text(`  next: ${view.next}`, "attention", options));
  }
  const retargets = plan.rows.filter(row => row.outcome === "retarget").length;
  if (retargets) out.push(...text(`Applying writes ${retargets === 1 ? "one runtime selection" : `${retargets} runtime selections`}: no hub is started, no terminal or peer is touched and no recovery operation is recorded.`, "muted", options));
  else if (plan.scope === "all-stopped") out.push(...text("Nothing to retarget.", "muted", options));
  const blocked = plan.blockers.length > 0;
  if (blocked || !applying) out.push(...text(blocked ? "Blocked: take the next action it names, then run this again. Nothing was changed." : retargets ? "Nothing was changed. Apply with `--yes`." : "Nothing was changed.", blocked ? "failure" : "muted", options));
  return out;
}

/** #1540: one line per project of an applied stopped retarget, with the cause of each failure. */
export function renderStoppedResults(results: readonly StoppedResult[], options: RecoveryPresentationOptions): string[] {
  const out: string[] = [];
  for (const result of results) out.push(...text(result.outcome === "retargeted"
    ? `${result.id}: runtime selection set to ${result.to}${result.from ? ` (was ${result.from})` : ""}; it stays stopped`
    : `${result.id}: not retargeted (${result.cause})`, result.outcome === "retargeted" ? "success" : "failure", options));
  return out;
}

/**
 * `ahub recovery status [<id>]`: the receipt's step and projects, then what the person can do about it. A blocked
 * operation also says what happened, why and what to do, exactly as the coordinator's screen does; the wait and
 * resume choices come from `nextChoices`, never from this module.
 */
export function renderRecoveryStatus(op: RecoveryOperation, runner: number | "unknown" | undefined, choices: readonly NextChoice[], options: RecoveryPresentationOptions): string[] {
  if (op.phase === "blocked") return [...renderOperation(op, runner, options), ...renderBlocked(op, choices, options)];
  const out = renderOperation(op, runner, options);
  if (op.phase !== "completed" && op.phase !== "cancelled") {
    if (op.error) out.push(...text(`Recorded error: ${op.error.split("; next actions: ")[0]}`, "attention", options));
    if (choices.length) out.push(...text("Next:", "strong", options));
    for (const choice of choices) out.push(...text(`  ${choiceInstruction(op, choice, options)}`, choice.kind === "stop" || choice.kind === "fresh" ? "failure" : "info", options));
  }
  return out;
}

/**
 * `ahub budget execution configure|disable`: the stored budget, or whether one was disabled. A configured budget is shown
 * by the same renderer `budget execution status` uses, so its fields read identically before and after a change.
 */
export function renderBudgetResult(op: "configure" | "disable", result: unknown, columns?: number, now = Date.now()): Span[][] {
  if (op === "configure") return [[{ text: "Execution budget configured", tone: "strong" }], ...renderExecutionBudgetStatus(result, columns, now).slice(1)];
  const disabled = (result as { disabled?: unknown } | undefined)?.disabled === true;
  return [[{ text: "Execution budget", tone: "strong" }], [{ text: disabled ? "Disabled: it no longer limits model calls." : "No matching execution budget; nothing was disabled.", tone: disabled ? "success" : "muted" }]];
}
