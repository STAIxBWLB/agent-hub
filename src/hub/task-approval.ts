import type { Task } from "./board.ts";

export interface ApprovalBinding { head?: string; latestHead?: string; mismatch: boolean; current: boolean }
const fullHead = (value: unknown): string | undefined => typeof value === "string" && /^[a-f0-9]{40}$/.test(value) ? value : undefined;

/** The last approval remains historical evidence after a new delivery or a withdrawal. Unknown legacy heads stay unknown. */
export function approvalBinding(task: Task): ApprovalBinding | undefined {
  const verdict = task.history.findLast(entry => entry.event === "approved");
  if (!verdict) return undefined;
  const head = fullHead(verdict.reviewedHead) ?? fullHead(verdict.reviewFindings?.head)
    ?? (task.state === "approved" ? fullHead(task.sdlc?.reviewedHead) : undefined);
  const latestHead = fullHead(task.refs.commit ?? task.sdlc?.head ?? task.sdlc?.localHead);
  const mismatch = !!head && !!latestHead && head !== latestHead;
  return { ...(head ? { head } : {}), ...(latestHead ? { latestHead } : {}), mismatch,
    current: task.state === "approved" && !!head && head === latestHead };
}

export function approvalText(binding: ApprovalBinding | undefined): string {
  if (!binding) return "";
  return `Approval bound to head ${binding.head ?? "unknown"}; latest reported head ${binding.latestHead ?? "unknown"}. ${binding.mismatch
    ? "HEAD MISMATCH: earlier approval does not approve the latest reported head."
    : binding.current ? "Approval is current at this head." : "Earlier approval is not current; review is required."}`;
}
