// Human output for the commands #814 T3 converts: the non-interactive restart/upgrade plan, `recovery status`, and
// `budget execution configure|disable`. Pure: data in, lines out. It only composes the renderers the interactive
// screens already use (`planLines`, `renderPlan`, `renderOperation`, `renderBlocked`, `choiceInstruction`), so the
// non-interactive text never says something the screens would not. `--json` is the caller's branch and prints the
// document exactly as before.
import { planLines } from "./upgrade-interactive.ts";
import { choiceInstruction, renderBlocked, renderOperation, renderPlan, type RecoveryPresentationOptions } from "./upgrade-presentation.ts";
import { paint, terminalText, wrap, type Span, type Tone } from "./console-state.ts";
import { renderExecutionBudgetStatus } from "./output.ts";
import type { NextChoice, RecoveryOperation, UpgradePlan } from "./upgrade.ts";

const columnsOf = (options: RecoveryPresentationOptions) => Number.isFinite(options.columns) ? Math.max(2, Math.floor(options.columns)) : 80;
const text = (value: string, tone: Tone, options: RecoveryPresentationOptions): string[] =>
  wrap(terminalText(value), columnsOf(options)).map(line => paint([{ text: line, tone }], options.color));

/**
 * The plan `restart` or `upgrade` would apply, for a person reading a pipe or a `--dry-run`: the same rows the plan
 * screen shows (a peer per line with how it runs and what happens to it), every blocker, and what the plan will not do.
 * Blockers, reconnect-only sessions and fresh starts are part of the rows, so none of them is stderr-only any more.
 */
export function renderUpgradePlan(plan: UpgradePlan, current: string, options: RecoveryPresentationOptions): string[] {
  const out = renderPlan(plan, current, options, planLines(plan, current));
  const blocked = plan.blockers.length > 0 || plan.projects.some(project => project.blockers.length > 0);
  if (!plan.projects.length) out.push(...text(plan.kind === "upgrade"
    ? `No hub is running, so nothing is carried over: install with \`bun add -g @staix/agent-hub@${plan.version}\`, then \`ahub setup\`.`
    : "This project's hub is not running: `ahub up` starts it.", "muted", options));
  out.push(...text(blocked
    ? "Blocked: take the next action each blocker names, then run this again. Nothing was changed."
    : "Nothing was changed. Apply with `--yes`.", blocked ? "failure" : "muted", options));
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
