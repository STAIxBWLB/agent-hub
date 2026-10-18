import { paint, quoted, terminalText, wrap, type Tone } from "./console-state.ts";
import { operationLines, stepLabel } from "./upgrade-labels.ts";
import { recordedPeerGuidance, stopAndArchiveSummary, type RecordedPeerGuidance } from "./recovery-guidance.ts";
import { restoreReceiptStatus } from "./upgrade-restore-state.ts";
import { recoveryCommand } from "../hub/recovery-store.ts";
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

/** Human output only. Raw receipt JSON must bypass this module.
 * ponytail: long command previews wrap as prose; raw JSON retains the copyable command.
 * A shell-token continuation formatter can replace this if copying wrapped commands is required.
 */
function lines(value: string, tone: Tone, options: RecoveryPresentationOptions): string[] {
  const columns = Number.isFinite(options.columns) ? Math.max(2, Math.floor(options.columns)) : 80;
  // A logical renderer line must stay one logical line: receipt text cannot introduce another hub heading.
  // Quote only control-containing values so ordinary text and command previews retain their exact spelling.
  const logical = /\p{Cc}/u.test(value) ? quoted(value) : value;
  return wrap(logical, columns).map(text => paint([{ text, tone }], options.color));
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

/** Policy rows come from the existing plan helper; this renderer adds no peer-kind policy. */
export function renderPlan(plan: UpgradePlan, current: string, options: RecoveryPresentationOptions, rows: readonly string[]): string[] {
  return [
    ...lines(`${plan.kind} to ${plan.version}: plan`, "strong", options),
    ...lines(`Coordinator version ${current}`, "muted", options),
    ...rows.slice(1).flatMap(line => lines(line, line.trimStart().startsWith("blocker:") ? "failure" : line.trimStart().startsWith("in progress:") ? "attention" : "info", options)),
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
const nativeRecovery = {
  terminal_unverified: { happened: "terminal could not be verified", action: "Review the recorded terminal before retrying; keep its recorded conversation." },
  session_changed: { happened: "different conversation was observed", action: "Return to the recorded conversation; do not accept the different one as its replacement." },
  launcher_unverified: { happened: "launcher could not be verified", action: "Review launcher ownership before retrying; unknown ownership does not authorize another launch." },
  target_unavailable: { happened: "target hub is unavailable", action: "Use an offered coordinator action for this target; do not start a replacement daemon by hand." },
  attachment_timeout: { happened: "attachment timed out", action: "Check the recorded launch and its attachment state, then use an offered coordinator action." },
} as const;
const launcherEvidence: Readonly<Record<string, string>> = {
  unknown: "launcher ownership is unknown",
  "older-instance": "an older target's launcher may still run",
  replaced: "the launcher identity differs from the saved binding",
  gone: "no current launcher was confirmed",
  "no-record-yet": "no current launch record was available",
  live: "a launcher was live, but its saved binding was not verified",
};

/** Preserve coordinator guidance verbatim except for its exact retained status command in ordinary human output. */
export function choiceInstruction(op: RecoveryOperation, choice: NextChoice, options: RecoveryPresentationOptions): string {
  return choice.kind === "wait" && !options.verbose
    ? choice.text.split(recoveryCommand(op, "status")).join(`ahub recovery status ${op.id}`) : choice.text;
}

export function renderBlocked(op: RecoveryOperation, choices: readonly NextChoice[], options: RecoveryPresentationOptions): string[] {
  let happened = "The recovery coordinator blocked this operation.";
  let why = "The detailed cause is unknown in this receipt; no missing evidence is treated as success.";
  let action = "read [j] or use --verbose for the recorded error, then choose an action offered by the coordinator.";
  let guidance: RecordedPeerGuidance | undefined;
  const cause = op.presentationCause;
  if (cause?.kind === "preservation" && Object.hasOwn(preservation, cause.check)) {
    happened = `The ${preservation[cause.check]} preservation check did not pass.`;
    why = `${cause.projectId ? `${cause.projectId}: ` : ""}the recorded expected state and the target's readback did not match, or the comparison was unavailable.`;
  } else if (cause?.kind === "native_recovery") {
    if (Object.hasOwn(nativeRecovery, cause.reason)) {
      const description = nativeRecovery[cause.reason];
      happened = `${cause.peer}: ${description.happened}.`;
      action = `${description.action} Read [j] or use --verbose for the recorded error.`;
      const terminal = cause.handle ? ` Recorded terminal: ${cause.handle}.` : "";
      const session = cause.expectedSession ? ` Expected conversation: ${cause.expectedSession}.` : "";
      switch (cause.reason) {
        case "terminal_unverified":
          why = `The coordinator could not confirm that the recorded terminal was valid and ready.${terminal}${session}`;
          break;
        case "session_changed":
          if (!cause.expectedSession || !cause.observedSession || cause.expectedSession === cause.observedSession) {
            happened = `${cause.peer}: the recorded session identity could not be verified.`;
            action = "Review the recorded conversation and session-file identity before retrying; do not substitute a new conversation. Read [j] or use --verbose for the recorded error.";
          }
          why = `Expected conversation: ${cause.expectedSession ?? "unknown"}; observed conversation: ${cause.observedSession ?? "unknown"}.${terminal}`;
          break;
        case "launcher_unverified":
          why = `${cause.launcherState && Object.hasOwn(launcherEvidence, cause.launcherState) ? launcherEvidence[cause.launcherState] : "launcher evidence is unknown"}.${terminal}${session}`;
          break;
        case "target_unavailable":
          if (cause.targetState === "running") happened = `${cause.peer}: the recorded target identity could not be verified.`;
          why = `The recorded target state was ${cause.targetState ?? "unknown"}; this is the coordinator's observation, not a new live check.${terminal}`;
          break;
        case "attachment_timeout":
          why = `The recorded attachment wait ended${typeof cause.timeoutMs === "number" && Number.isFinite(cause.timeoutMs) && cause.timeoutMs > 0 ? ` after ${elapsed(cause.timeoutMs)}` : "; its exact duration is unknown"}.${terminal}${session}`;
          break;
      }
      const planned = op.plan.projects.find(project => project.project.id === cause.projectId);
      const progress = op.projects.find(project => project.id === cause.projectId);
      if (planned && progress) guidance = recordedPeerGuidance(planned, progress, {
        recorded: Object.fromEntries(Object.entries(progress.reattachments ?? {}).flatMap(([peer, marker]) => marker ? [[peer, marker.binding]] : [])),
      }).find(row => row.peer === cause.peer);
    }
  } else if (op.blockedReattachment) {
    const { projectId, peer } = op.blockedReattachment;
    const marker = op.projects.find(project => project.id === projectId)?.reattachments?.[peer];
    happened = `${peer}'s recorded session needs reattachment.`;
    why = marker ? `${projectId}: the session detached after restoration; its recorded terminal is ${marker.binding.handle} and its accepted conversation is ${marker.binding.sessionId}.` : "The terminal and session evidence is unknown in this receipt.";
  } else if (op.failure?.code === "database_busy") {
    happened = "The recovery database could not complete this step yet.";
    why = "The coordinator recorded database contention as retryable; its saved recovery state is retained.";
  } else if (!cause && op.error) {
    // A recorded error is evidence to show, not a typed classification. Reuse the console's
    // terminal sanitizer before the normal renderer; discard later lines and bound by code point.
    const first = terminalText(op.error.split(/[\r\n\p{Zl}\p{Zp}]/u, 1)[0] ?? "").replace(/\p{Cc}/gu, "").trim();
    if (first) {
      const points = Array.from(first);
      const recorded = points.length > 512 ? `${points.slice(0, 509).join("")}...` : first;
      why = `recorded error: ${recorded} (typed cause unknown).`;
      action = "Resolve the recorded error before retrying; read [j] or use --verbose for details, then choose an action offered by the coordinator.";
      if (/\btarget lacks task_cancel\b/.test(first)) action = "Choose a target release that supports task_cancel; keep cancelled task records and use only the coordinator actions offered below.";
    }
  }
  const output = [...lines(`What happened: ${happened}`, "failure", options), ...lines(`Why: ${why}`, "muted", options), ...lines(`What to do: ${action}`, "attention", options)];
  for (const choice of choices) {
    const instruction = choiceInstruction(op, choice, options);
    output.push(...lines(`  ${instruction}`, choice.kind === "stop" || choice.kind === "fresh" ? "failure" : "info", options));
  }
  if (guidance) {
    if (guidance.command) output.push(...lines(`Recorded conversation command, for use when permitted by the recovery hold: ${guidance.command}`, "info", options));
    output.push(...lines(guidance.note, "muted", options));
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
  // These are coordinator step categories, never classifications inferred from a reason or error string.
  const category = step.split(":")[0];
  const action = category === "restore" || category === "restore-claude"
    ? "Check the recorded native launch and session attachment; keep the recorded conversation and use an offered coordinator action if attachment does not complete."
    : category === "prepare" || category === "reprepare"
      ? "If an approval is pending, answer it in ahub console. Active turns must finish or be cancelled in their own terminal."
      : "Review the recorded waiting condition and use an offered coordinator action; the action needed for this step is unknown.";
  return [
    ...lines(`[waiting] ${stepLabel(step)} (${clock})`, "attention", options),
    ...(waiting.length ? waiting.flatMap(reason => lines(`  Waiting for: ${reason}`, "attention", options)) : lines("The hub has not provided a waiting reason.", "muted", options)),
    ...lines(action, "info", options),
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
