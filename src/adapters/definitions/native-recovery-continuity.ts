import type { RecoveryPeer } from "../../cli/upgrade.ts";
import type { TerminalBinding } from "../../cli/terminal-recovery.ts";
import type { RecoveryContinuityBookmark } from "../../hub/recovery-continuity.ts";

/** Native continuity payload only; archival evidence and persistence remain with the recovery coordinator. */
export function piRecoveryContinuity(peer: RecoveryPeer, binding?: TerminalBinding): Pick<RecoveryContinuityBookmark, "pi"> {
  const sessionId = binding?.sessionId ?? peer.sessionId;
  if (!sessionId) throw new Error("Pi recorded session unavailable; archive continuity bookmark was not written");
  const backend = binding?.backend ?? peer.args?.backend;
  return { pi: { sessionId, sessionFile: binding?.sessionFile ?? peer.sessionFile ?? peer.args?.sessionFile,
    ...(backend === "auto" || backend === "dgx" || backend === "mlx" ? { backend } : {}), model: binding?.model ?? peer.args?.model } };
}
