import { paint, wrap, type Tone } from "./console-state.ts";
import { operationLines, planLines, stepLabel } from "./upgrade-labels.ts";
import { stopAndArchiveSummary } from "./recovery-guidance.ts";
import { restoreReceiptStatus } from "./upgrade-restore-state.ts";
import type { Inspection, NextChoice, RecoveryOperation, UpgradePlan } from "./upgrade.ts";

export interface RecoveryPresentationOptions {
  columns: number;
  color: boolean;
  verbose?: boolean;
  now(): number;
}
export type StepPresentationStatus = "done" | "running" | "waiting" | "blocked";
export interface MenuPresentationItem {
  key: string;
  label: string;
  disabledReason?: string;
  recommended?: boolean;
  destructive?: boolean;
}

/** Human output only. Raw receipt JSON must bypass this module. */
function lines(value: string, tone: Tone, options: RecoveryPresentationOptions): string[] {
  const columns = Number.isFinite(options.columns) ? Math.max(2, Math.floor(options.columns)) : 80;
  return wrap(value, columns).map(text => paint([{ text, tone }], options.color));
}
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60), remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m${remainder ? `${String(remainder).padStart(2, "0")}s` : ""}`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? `${String(minutes % 60).padStart(2, "0")}m` : ""}`;
}
const tones: Record<StepPresentationStatus, Tone> = { done: "success", running: "info", waiting: "attention", blocked: "failure" };

export function renderStep(label: string, status: StepPresentationStatus, elapsedMs: number | undefined, options: RecoveryPresentationOptions): string[] {
  const time = elapsedMs !== undefined && Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsed(elapsedMs) : "timing unknown";
  return lines(`[${status}] ${label} (${time})`, tones[status], options);
}

export function renderPlan(plan: UpgradePlan, current: string, options: RecoveryPresentationOptions): string[] {
  return [
    ...lines(`${plan.kind} to ${plan.version}: plan`, "strong", options),
    ...lines(`Coordinator version ${current}`, "muted", options),
    ...planLines(plan, current).slice(1).flatMap(line => lines(line, line.trimStart().startsWith("blocker:") ? "failure" : line.trimStart().startsWith("in progress:") ? "attention" : "info", options)),
  ];
}

const projectPhases = {
  pending: "waiting to begin",
  prepared: "source held for recovery",
  stopped: "source stopped; target start remains",
  started: "target started; session restoration remains",
  "peers-restored": "sessions restored; final verification remains",
  verified: "verified and released",
} as const;

export function renderOperation(op: RecoveryOperation, runner: number | "unknown" | undefined, options: RecoveryPresentationOptions): string[] {
  const status: StepPresentationStatus = op.phase === "completed" ? "done" : op.phase === "blocked" ? "blocked" : op.phase === "running" ? "running" : "waiting";
  const label = op.step === "stage" && op.targetRoot && op.targetDigest ? "checking retained release" : stepLabel(op.step);
  const output = [...lines(`${op.plan.kind} to ${op.plan.version}: operation ${op.id}`, "strong", options), ...renderStep(label, status, undefined, options)];
  if (runner === "unknown") output.push(...lines("Whether the recovery runner is active is unknown.", "attention", options));
  else if (runner !== undefined) output.push(...lines(`Recovery runner ${runner} is active.`, "muted", options));
  else if (op.phase === "running") output.push(...lines("No active runner was observed; review the coordinator's current actions.", "attention", options));
  for (const progress of op.projects) {
    output.push(...lines(`${progress.id}: ${projectPhases[progress.phase]}`, progress.phase === "verified" ? "success" : "info", options));
    for (const [key, value] of Object.entries(progress.terminals)) {
      if (key.startsWith("restored:")) {
        let outcome = "recorded outcome unavailable";
        try {
          const state = restoreReceiptStatus(value);
          outcome = state === "done" ? "session restored" : state === "failed" ? "session restoration needs attention" : state.startsWith("waiting:") ? "waiting for the recorded session to attach" : "session restoration is pending";
        } catch { /* Malformed historical metadata is unknown, never successful. */ }
        output.push(...lines(`  ${key.slice("restored:".length)}: ${outcome}`, "muted", options));
      } else if (key.startsWith("closed:") && value === true) output.push(...lines(`  ${key.slice("closed:".length)}: previous terminal closed`, "muted", options));
    }
  }
  if (options.verbose) output.push(...lines("Receipt details:", "muted", options), ...operationLines(op, runner, options.now()).flatMap(line => lines(line, "muted", options)));
  return output;
}

const preservation = { queues: "message queues", manualPaused: "manual pauses", boardDigest: "task board", budgetDigest: "budget records" } as const;

export function renderBlocked(op: RecoveryOperation, choices: readonly NextChoice[], options: RecoveryPresentationOptions): string[] {
  let happened = "The recovery coordinator blocked this operation.";
  let why = "The detailed cause is unknown in this receipt; no missing evidence is treated as success.";
  const cause = op.presentationCause;
  if (cause?.kind === "preservation" && Object.hasOwn(preservation, cause.check)) {
    happened = `The ${preservation[cause.check]} preservation check did not pass.`;
    why = `${cause.projectId ? `${cause.projectId}: ` : ""}the recorded expected state and the target's readback did not match, or the comparison was unavailable.`;
  } else if (op.blockedReattachment) {
    const { projectId, peer } = op.blockedReattachment;
    const marker = op.projects.find(project => project.id === projectId)?.reattachments?.[peer];
    happened = `${peer}'s recorded session needs reattachment.`;
    why = marker ? `${projectId}: the session detached after restoration; its recorded terminal is ${marker.binding.handle} and its accepted conversation is ${marker.binding.sessionId}.` : "The terminal and session evidence is unknown in this receipt.";
  } else if (op.failure?.code === "database_busy") {
    happened = "The recovery database could not complete this step yet.";
    why = "The coordinator recorded database contention as retryable; its saved recovery state is retained.";
  }
  const output = [...lines(`What happened: ${happened}`, "failure", options), ...lines(`Why: ${why}`, "muted", options), ...lines("What to do: read [j] or use --verbose for the recorded error, then choose an action offered by the coordinator.", "attention", options)];
  for (const choice of choices) {
    const instruction = choice.kind === "wait" && !options.verbose ? `Check ahub recovery status ${op.id} again after the reported condition changes.` : choice.text;
    output.push(...lines(`  ${instruction}`, choice.kind === "stop" || choice.kind === "fresh" ? "failure" : "info", options));
  }
  if (options.verbose && op.error) output.push(...lines(`Recorded error: ${op.error}`, "muted", options));
  return output;
}

export function renderMenu(items: readonly MenuPresentationItem[], options: RecoveryPresentationOptions): string[] {
  return items.flatMap(item => lines(`[${item.key}] ${item.label}${item.disabledReason ? ` (disabled: ${item.disabledReason})` : ""}${item.recommended ? " (recommended; Enter)" : ""}${item.destructive ? " [warning]" : ""}`,
    item.destructive ? "failure" : item.disabledReason ? "muted" : item.recommended ? "strong" : "info", options));
}

export function renderWait(op: RecoveryOperation, step: string, waiting: readonly string[], options: RecoveryPresentationOptions): string[] {
  const timing = op.waits?.[step];
  const start = timing ? Date.parse(timing.waitStartedAt) : NaN, deadline = timing ? Date.parse(timing.deadlineAt) : NaN;
  const end = timing?.waitEndedAt === undefined ? options.now() : Date.parse(timing.waitEndedAt);
  const known = Number.isFinite(start) && Number.isFinite(deadline) && Number.isFinite(end) && deadline >= start && end >= start;
  const clock = known ? `waiting ${elapsed(end - start)} of ${elapsed(deadline - start)}` : "timing unknown";
  return [
    ...lines(`[waiting] ${stepLabel(step)} (${clock})`, "attention", options),
    ...(waiting.length ? waiting.flatMap(reason => lines(`  Waiting for: ${reason}`, "attention", options)) : lines("The hub has not provided a waiting reason.", "muted", options)),
    ...lines("If an approval is pending, answer it in ahub console. Active turns must finish or be cancelled in their own terminal.", "info", options),
  ];
}

export function renderSummary(op: RecoveryOperation, live: Readonly<Record<string, Inspection | undefined>> | undefined, options: RecoveryPresentationOptions): string[] {
  const outcome = op.disposition ? "abandoned, not completed" : op.phase === "completed" ? "completed" : op.phase === "blocked" ? "blocked" : op.phase === "cancelled" ? "cancelled" : "not completed";
  const output = lines(`${op.plan.kind} ${outcome}`, op.phase === "completed" ? "success" : op.phase === "blocked" ? "failure" : "attention", options);
  for (const progress of op.projects) {
    const observed = live?.[progress.id];
    if (!observed || !["running", "stopped", "missing"].includes(observed.state)) output.push(...lines(`${progress.id}: current runtime unknown; no confirmed current hub reading is available.`, "attention", options));
    else if (observed.state === "running") output.push(...lines(`${progress.id}: running on ${observed.version ?? "an unknown version"} (fresh readback).`, "info", options));
    else output.push(...lines(`${progress.id}: ${observed.state === "stopped" ? "hub stopped" : "project directory missing; runtime state unknown"} (fresh readback).`, "info", options));
  }
  const recorded = stopAndArchiveSummary(op);
  if (!op.disposition) recorded.shift();
  output.push(...recorded.flatMap(line => lines(line, "muted", options)));
  return output;
}
