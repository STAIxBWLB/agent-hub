import { restoreReceiptStatus } from "./upgrade-restore-state.ts";
import type { Inspection, PlannedProject, RecoveryOperation, RecoveryPeer, UpgradePlan } from "./upgrade.ts";

/**
 * How an attached peer runs, which decides how it can be ended: a TUI agent in a terminal the plan could bind, a
 * headless agent the hub owns, or `unmanaged` (shown as `own`): a session the hub did not launch, or one it launched
 * whose terminal the plan could not bind (a person ends that one where it runs).
 */
export function peerKind(planned: PlannedProject, peer: RecoveryPeer): "tui" | "headless" | "unmanaged" | "offline" {
  if (peer.state === "offline") return "offline";
  if ((planned.terminals as { peer: string }[]).some((t) => t.peer === peer.id)) return "tui";
  if (peer.id === "claude" || peer.id === "codex" || (peer.id === "pi" && peer.args?.mode === "tui")) return "unmanaged";
  return "headless";
}

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

function peerAction(planned: PlannedProject, peer: RecoveryPeer): string {
  if (peer.state === "offline") return "offline, left as it is";
  if (planned.reconnectOnly?.includes(peer.id)) return "reconnects by itself (unmanaged session; its terminal is left alone)";
  if (planned.freshStart?.includes(peer.id)) return "restarts as a new session (no turn to lose)";
  const terminal = (planned.terminals as { peer: string; handle: string }[]).find((t) => t.peer === peer.id);
  if (terminal) return `resumes its session in a new terminal (replaces ${terminal.handle})`;
  return peer.id === "pi" ? "restarts headless on its recorded session" : "restarts headless as a new session";
}

const KINDS = { tui: "TUI", headless: "headless", unmanaged: "own", offline: "-" } as const;

/** What the source says keeps it from being quiet; an older hub names only its busy peers. */
const inProgress = (source: Inspection): string[] => source.recovery?.waiting ?? source.peers.filter((p) => p.state === "busy").map((p) => `${p.id} is busy`);

export function planLines(plan: UpgradePlan, current: string): string[] {
  const lines = [plan.kind === "upgrade" ? `upgrade to ${plan.version} (coordinator ${current})` : `restart on ${plan.version}`];
  for (const p of plan.projects) {
    lines.push("", `${p.project.id}  ${p.project.root}  hub ${p.source.version ?? "unknown"} (${p.source.state})`);
    const width = Math.max(0, ...p.source.peers.map((peer) => peer.id.length));
    for (const peer of p.source.peers) lines.push(`  ${peer.id.padEnd(width)}  ${peer.state.padEnd(7)}  ${KINDS[peerKind(p, peer)].padEnd(8)}  ${peerAction(p, peer)}`);
    const waiting = inProgress(p.source);
    if (waiting.length) lines.push(`  in progress: ${waiting.join(", ")} (apply waits up to 10 minutes for it, then leaves this hub running)`);
    for (const blocker of p.blockers) lines.push(`  blocker: ${blocker}`);
  }
  if (plan.blockers.length) lines.push("");
  for (const blocker of plan.blockers) lines.push(`blocker: ${blocker}`);
  return lines;
}

const ago = (ms: number): string => ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : ms < 5_400_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`;

export function operationLines(op: RecoveryOperation, runner: number | "unknown" | undefined, now: number): string[] {
  const held = runner === "unknown" ? "; whether a runner holds it cannot be read" : runner ? `; runner ${runner} is working` : op.phase === "running" ? "; no runner holds it (the last one stopped mid-step)" : "";
  const lines = [`${op.plan.kind} to ${op.plan.version}: operation ${op.id}`, `  ${op.phase} at "${stepLabel(op.step)}", updated ${ago(now - op.updatedAt)} ago${held}`];
  for (const p of op.projects) {
    const effects = Object.entries(p.terminals).map(([key, value]) => key.startsWith("restored:") ? `${key} ${restoreReceiptStatus(value)}` : value === "pending" || value === "failed" ? `${key} ${value}` : key);
    lines.push(`  ${p.id}  ${p.phase}${effects.length ? `  (${effects.join(", ")})` : ""}${p.restarts?.length ? `  restarts ${p.restarts.length}` : ""}`);
  }
  // The error ends with the commands status would print; the menu below offers them instead.
  if (op.error) lines.push(`  error: ${op.error.split("; next actions: ")[0]}`);
  return lines;
}

