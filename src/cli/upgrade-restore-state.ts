import { definitionOf } from "../adapters/registry.ts";
import { readInstanceConfig } from "../hub/instance-config.ts";
import type { TerminalBinding } from "./terminal-recovery.ts";

export type RestoreReceipt =
  | { state: "pending" }
  | { state: "waiting"; origin: "pending" | "failed"; binding: TerminalBinding }
  | { state: "done"; binding: TerminalBinding }
  | { state: "failed" };
export interface RestoreEvidence {
  target: "running" | "stopped" | "changed";
  launcher: "live" | "gone" | "unknown" | "no-record-yet" | "replaced" | "older-instance";
  session: "planned" | "other" | "none";
  allowOther: boolean;
  /** Positive classification of the saved terminal, independent of launcher/session evidence. */
  terminal?: "present" | "gone" | "changed" | "unknown";
  /** The original or verified selected terminal when a bare receipt first acquires a binding. */
  binding?: TerminalBinding;
}
export type RestoreAction = "poll" | "settle" | "revalidate" | "block" | "fail" | "create" | "reattach";
export interface RestoreTransition { next: RestoreReceipt; action: RestoreAction }
export type RestoreReceiptStatus = "unstarted" | "pending" | "waiting:pending" | "waiting:failed" | "done" | "failed";

function malformed(): never { throw new Error("invalid restore receipt"); }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
function terminalBinding(value: unknown): TerminalBinding {
  if (!object(value) || typeof value.peer !== "string") malformed();
  for (const key of ["handle", "incarnationId", "worktreeId", "projectRoot", "sessionId"]) if (!text(value[key])) malformed();
  try {
    const adapter = definitionOf(value.peer) ?? definitionOf(value.peer, readInstanceConfig(value.projectRoot as string).instances);
    if (!adapter?.session.launchRecord) malformed();
  } catch { malformed(); }
  for (const key of ["sessionFile", "backend", "model", "executionCwd", "terminalRoot"]) if (value[key] !== undefined && typeof value[key] !== "string") malformed();
  const launch = value.launch;
  const validLaunch = (v: unknown) => object(v) && text(v.packageEntrypoint) && text(v.command)
    && Array.isArray(v.argv) && v.argv.every(arg => typeof arg === "string")
    && object(v.env) && Object.values(v.env).every(entry => typeof entry === "string");
  if (!validLaunch(launch) || value.launchMetadata !== undefined && !validLaunch(value.launchMetadata)) malformed();
  return { ...value, launchMetadata: value.launchMetadata ?? launch } as unknown as TerminalBinding;
}

/** Decode legacy representations only here. Absence is unstarted, never pending or failed. */
export function decodeRestoreReceipt(value: unknown): RestoreReceipt | undefined {
  if (value === undefined) return undefined;
  if (value === "pending" || value === "failed") return { state: value };
  if (!object(value)) malformed();
  if (Object.hasOwn(value, "state")) {
    const allowed = value.state === "waiting" ? ["state", "origin", "binding"] : value.state === "done" ? ["state", "binding"] : ["state"];
    if (Object.keys(value).some(key => !allowed.includes(key))) malformed();
    switch (value.state) {
      case "pending": case "failed": return { state: value.state };
      case "waiting": {
        if (value.origin !== "pending" && value.origin !== "failed") malformed();
        return { state: "waiting", origin: value.origin, binding: terminalBinding(value.binding) };
      }
      case "done": return { state: "done", binding: terminalBinding(value.binding) };
      default: return malformed();
    }
  }
  if (Object.hasOwn(value, "attachmentReceipt")) malformed();
  return { state: "done", binding: terminalBinding(value) };
}

export function restoreReceiptStatus(value: unknown): RestoreReceiptStatus {
  const receipt = decodeRestoreReceipt(value);
  return !receipt ? "unstarted" : receipt.state === "waiting" ? `waiting:${receipt.origin}` : receipt.state;
}
export function canChooseFresh(value: unknown): boolean {
  const receipt = decodeRestoreReceipt(value);
  return receipt?.state === "failed" || receipt?.state === "waiting" && receipt.origin === "failed";
}

/** Pure decision only: settlement/revalidation must succeed before the runtime persists its proposed next receipt. */
export function restoreTransition(receipt: RestoreReceipt, evidence: RestoreEvidence): RestoreTransition {
  const keep = (action: RestoreAction): RestoreTransition => ({ next: receipt, action });
  if (evidence.target !== "running") return keep("block");
  // A chosen waiting terminal cannot be replaced by another identity, even if a session has attached meanwhile.
  if (receipt.state === "waiting" && ["unknown", "replaced", "older-instance"].includes(evidence.launcher)) return keep("block");
  if (evidence.session === "other" && (!evidence.allowOther || receipt.state === "done")) return keep("block");
  if (evidence.session === "planned" || evidence.session === "other" && evidence.allowOther) {
    if (receipt.state === "done") return keep("revalidate");
    const binding = receipt.state === "waiting" ? receipt.binding : evidence.binding;
    return binding ? { next: { state: "done", binding }, action: "settle" } : keep("block");
  }
  if (receipt.state === "done") return evidence.terminal === "gone" && evidence.launcher === "gone"
    ? { next: { state: "failed" }, action: "reattach" } : keep("block");
  if (evidence.launcher === "unknown" || evidence.launcher === "replaced" || evidence.launcher === "older-instance") return keep("block");
  if (receipt.state === "waiting" && (evidence.launcher === "live" || evidence.launcher === "no-record-yet")) return keep("poll");
  const origin = receipt.state === "waiting" ? receipt.origin : receipt.state;
  if (evidence.launcher === "live") return evidence.binding
    ? { next: { state: "waiting", origin, binding: evidence.binding }, action: "poll" }
    : keep("block");
  // Bare pending/failed have no chosen saved terminal: never infer that an absent record is an outstanding bound wait.
  return { next: { state: "failed" }, action: origin === "pending" ? "fail" : "create" };
}

/** Checkable compact documentation, enumerated through the same pure decision function. */
export function renderRestoreTransitionTable(): string {
  const launch = { packageEntrypoint: "table", command: "table", argv: [], env: {} };
  const binding: TerminalBinding = { peer: "codex", handle: "selected", incarnationId: "selected", worktreeId: "selected", projectRoot: "table", sessionId: "planned", launch, launchMetadata: launch };
  const receipts: RestoreReceipt[] = [{ state: "pending" }, { state: "waiting", origin: "pending", binding }, { state: "waiting", origin: "failed", binding }, { state: "done", binding }, { state: "failed" }];
  const launchers: RestoreEvidence["launcher"][] = ["live", "gone", "unknown", "no-record-yet", "replaced", "older-instance"];
  const result = (receipt: RestoreReceipt, evidence: RestoreEvidence, unchanged = false) => {
    const next = restoreTransition(receipt, evidence);
    const status = restoreReceiptStatus(next.next);
    return `${next.action} -> ${unchanged && status === restoreReceiptStatus(receipt) ? "unchanged" : status}${canChooseFresh(next.next) && !(unchanged && status === restoreReceiptStatus(receipt)) ? "; fresh" : ""}`;
  };
  const table = (title: string, sessions: readonly { session: RestoreEvidence["session"]; allowOther: boolean }[]) => [
    title,
    "",
    `| Receipt | ${launchers.join(" | ")} |`,
    `|---|${launchers.map(() => "---").join("|")}|`,
    ...receipts.map(receipt => `| ${restoreReceiptStatus(receipt)} | ${launchers.map(launcher => {
      const variants = sessions.map(session => ({ session: session.session, result: result(receipt, { target: "running", launcher, ...session, binding }) }));
      const outcomes = [...new Set(variants.map(value => value.result))];
      return outcomes.length === 1 ? outcomes[0]! : [...new Set(variants.map(value => `${value.session}: ${value.result}`))].join("; ");
    }).join(" | ")} |`),
  ].join("\n");
  const priority = (targets: readonly RestoreEvidence["target"][], sessions: readonly { session: RestoreEvidence["session"]; allowOther: boolean }[]) => {
    const outcomes = new Set<string>();
    for (const receipt of receipts) for (const target of targets) for (const launcher of launchers) for (const session of sessions) {
      outcomes.add(result(receipt, { target, launcher, ...session, binding }, true));
    }
    return [...outcomes].join(" / ");
  };
  const allSessions = (["planned", "other", "none"] as const).flatMap(session => [false, true].map(allowOther => ({ session, allowOther })));
  return [
    "Cells show action -> next receipt status. Fresh-session eligibility is marked fresh; peer/operation-specific restrictions still apply. Exact terminal revalidation and settlement must succeed before persisting a proposed done receipt.",
    "",
    "| Priority condition | Decision |",
    "|---|---|",
    `| Target stopped or changed | ${priority(["stopped", "changed"], allSessions)} |`,
    `| Running target, other session not allowed | ${priority(["running"], [{ session: "other", allowOther: false }])} |`,
    "| Absent receipt | unstarted; initial launch is handled by the runtime outside this receipt table |",
    "| Done, running target, no attached session, gone launchers and positively gone saved terminal (#463 supplemental evidence) | reattach -> failed; one recorded-session repair, no fresh-session choice |",
    "",
    table("Running target, no attached session (either allowOther value):", [{ session: "none", allowOther: false }, { session: "none", allowOther: true }]),
    "",
    table("Running target, planned session or explicitly allowed other session (different decisions are labeled):", [{ session: "planned", allowOther: false }, { session: "planned", allowOther: true }, { session: "other", allowOther: true }]),
  ].join("\n");
}
export const RESTORE_TRANSITION_TABLE = renderRestoreTransitionTable();
