import { restoreReceiptStatus } from "./upgrade-restore-state.ts";
import type { RecoveryOperation } from "./upgrade.ts";

const STEPS: Record<string, string> = {
  stage: "staging the release", prepare: "holding deliveries and waiting until the hub is quiet", reprepare: "preparing the source again after an expired hold",
  commit: "closing terminals and stopping the old hub", restart: "restarting a target that stopped", start: "starting the new hub", restore: "restoring Codex and Pi sessions",
  "install-plugin": "installing the Claude plugin", "restore-claude": "restoring the Claude session and verifying the hub", release: "releasing held deliveries",
  "refresh-manager": "refreshing the dashboard manager", "install-global": "installing the global CLI", completed: "completed", cancelled: "cancelled",
};

/** A receipt step (`commit:<project>`) in a person's words; a step this release does not know is shown as it is. */
export function stepLabel(step: string): string {
  const at = step.indexOf(":"), name = at < 0 ? step : step.slice(0, at);
  return STEPS[name] ? `${at < 0 ? "" : `${step.slice(at + 1)}: `}${STEPS[name]}` : step;
}

const ago = (ms: number): string => ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : ms < 5_400_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`;

export function operationLines(op: RecoveryOperation, runner: number | "unknown" | undefined, now: number): string[] {
  const held = runner === "unknown" ? "; whether a runner holds it cannot be read" : runner ? `; runner ${runner} is working` : op.phase === "running" ? "; no runner holds it (the last one stopped mid-step)" : "";
  const lines = [`${op.plan.kind} to ${op.plan.version}: operation ${op.id}`, `  ${op.phase} at "${stepLabel(op.step)}", updated ${ago(now - op.updatedAt)} ago${held}`];
  for (const p of op.projects) {
    const effects = Object.entries(p.terminals).map(([key, value]) => key.startsWith("restored:") ? `${key} ${restoreReceiptStatus(value, { authority: "historical" })}` : value === "pending" || value === "failed" ? `${key} ${value}` : key);
    lines.push(`  ${p.id}  ${p.phase}${effects.length ? `  (${effects.join(", ")})` : ""}${p.restarts?.length ? `  restarts ${p.restarts.length}` : ""}`);
  }
  // The error ends with the commands status would print; the menu below offers them instead.
  if (op.error) lines.push(`  error: ${op.error.split("; next actions: ")[0]}`);
  return lines;
}

