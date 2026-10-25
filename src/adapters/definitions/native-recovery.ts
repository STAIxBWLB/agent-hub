import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { readEvents } from "../../hub/events.ts";
import { checkedSessionPath, recordedFileState } from "../../cli/recovery-session-file.ts";
import type { AdapterDefinition } from "../registry-types.ts";
import type { TerminalBinding } from "../../cli/terminal-recovery.ts";
import type { RecoveryPeer } from "../../cli/upgrade.ts";

type SessionPolicy = Partial<AdapterDefinition["session"]>;
const rolloutState = (binding: TerminalBinding): boolean | "unknown" => {
  try { return readdirSync(checkedSessionPath(binding, "rollout"), { recursive: true }).some(name => String(name).endsWith(".jsonl") && basename(String(name)).includes(binding.sessionId)); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : "unknown"; }
};
const transcriptState = (binding: TerminalBinding): boolean | "unknown" => {
  const state = recordedFileState(checkedSessionPath(binding, "transcript"));
  return state === "unknown" ? "unknown" : state === "found";
};
/** Preserve the driver's explicit evidence-kind dispatch, including historical typed receipt reads. */
export function nativeRecordedSessionState(binding: TerminalBinding, kind: "rollout" | "transcript"): "found" | "missing" | "unknown" {
  const state = kind === "rollout" ? rolloutState(binding) : transcriptState(binding);
  return state === "unknown" ? "unknown" : state ? "found" : "missing";
}
const startupArgs = (peer: RecoveryPeer): Record<string, string> => Object.fromEntries(["mode", "backend", "model", "route"]
  .flatMap(key => typeof peer.args?.[key] === "string" ? [[key, peer.args[key]!]] : []));
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export const CODEX_RECOVERY_SESSION: SessionPolicy = {
  resumeArgv: (binding, fresh) => ["codex", ...(fresh ? [] : ["resume", binding.sessionId])],
  transcriptPath: binding => checkedSessionPath(binding, "rollout"), transcriptExists: rolloutState,
  personFresh: true, missingEvidence: "rollout",
  zeroTurn: ({ stateDir, binding, phase }) => {
    if (phase !== "plan") return false;
    let current: string | undefined, started = false, turned = false;
    for (const e of readEvents(join(stateDir, "events.jsonl"))) {
      if (e.type === "native_thread" && e.peer === binding.peer) {
        current = e.thread;
        if (e.thread === binding.sessionId && e.fresh) started = true;
      } else if (e.type === "turn_start" && e.peer === binding.peer && current === binding.sessionId) turned = true;
    }
    return started && !turned;
  },
};
export const CLAUDE_RECOVERY_SESSION: SessionPolicy = {
  resumeArgv: (binding, fresh) => ["claude", ...(fresh ? [] : ["--resume", binding.sessionId])],
  transcriptPath: binding => checkedSessionPath(binding, "transcript"), transcriptExists: transcriptState,
  zeroTurn: ({ binding, phase }) => phase !== "plan" && transcriptState(binding) !== true,
  personFresh: true, missingEvidence: "transcript",
};
export const PI_RECOVERY_SESSION: SessionPolicy = {
  resumeArgv: binding => ["pi", "--mode", "tui", ...(binding.backend ? ["--backend", binding.backend] : []), ...(binding.model ? ["--model", binding.model] : []),
    ...(binding.sessionFile ? ["--session-file", binding.sessionFile] : ["--session-id", binding.sessionId])],
  personFresh: false,
  restoreArgs: peer => {
    const args = startupArgs(peer);
    if (typeof peer.args?.mode !== "string") args.mode = "headless";
    const file = peer.sessionFile ?? peer.args?.sessionFile;
    if (typeof file === "string") args["session-file"] = file;
    else if (peer.sessionId) args["session-id"] = peer.sessionId;
    return args;
  },
  crashIdentity: row => {
    const value = object(row), args = object(value.args), session = object(value.session);
    const sessionId = [value.sessionId, value.agentSessionId, value.resumeSessionId, session.id, session.sessionId].find(text);
    const sessionFile = [value.sessionFile, value.sessionPath, args.sessionFile, session.file, session.path].find(text);
    return { ...(sessionId ? { sessionId } : {}), ...(sessionFile ? { sessionFile } : {}) };
  },
};
export const KIMI_RECOVERY_SESSION: SessionPolicy = {
  legacyHeadlessArgv: { file: "src/hub/start-mode.ts", exportName: "START_MODE_PEERS", argv: ["--mode", "headless"] },
  restoreArgs: peer => { const args = startupArgs(peer); delete args.mode; return args; },
  recoveryRefusal: (peer, phase = "plan") => peer.args?.mode === "tui"
    ? phase === "restore" ? "Kimi's pull-only terminal cannot be restored as a headless worker; end it in that terminal and make a new recovery plan"
      : "kimi: its pull-only terminal has no automatic restore; end it in that terminal, then make a new recovery plan (its session is not resumed by the hub)" : undefined,
};
export const LOCAL_RECOVERY_SESSION: SessionPolicy = { restoreArgs: startupArgs };
export const JCODE_RECOVERY_SESSION: SessionPolicy = {
  legacyTargetSupport: { file: "src/hub/peer-catalog.ts", exportName: "OPTIONAL_PEERS", refusal: "target does not support Jcode; end it and make a new plan, or choose a supporting target; runtimes unchanged" },
  recoveryRefusal: (_peer, phase = "plan") => phase === "restore" ? undefined : "jcode: source-pinned native load cannot prove conversation identity; end the peer and make a new recovery plan before effects",
  restoreArgs: peer => ({ ...startupArgs(peer), ...(peer.sessionId ? { "session-id": peer.sessionId } : {}), ...(peer.args?.providerProfile ? { "provider-profile": peer.args.providerProfile } : {}) }),
};
export const QWEN_RECOVERY_SESSION: SessionPolicy = {
  legacyTargetSupport: { file: "src/hub/peer-catalog.ts", exportName: "OPTIONAL_PEERS", refusal: "target does not support Qwen; end Qwen and make a new plan, or choose a supporting target; runtimes unchanged" },
  restoreArgs: peer => ({ ...startupArgs(peer), ...(peer.sessionId ? { "session-id": peer.sessionId } : {}) }),
  // #286 Part 3: the Qwen TUI belongs to the person's terminal. It is never restored as a headless worker; `ahub qwen --mode tui` resumes it (qwen -r <session>) from its saved offset.
  recoveryRefusal: (peer, phase = "plan") => peer.args?.mode === "tui"
    ? phase === "restore" ? "Qwen's own terminal cannot be restored as a headless worker; end it in that terminal and make a new recovery plan"
      : "qwen: its own terminal has no automatic restore; end it in that terminal, then make a new recovery plan (restart it with ahub qwen --mode tui, which resumes its session)" : undefined,
};

/** Fixed legacy native probes: callers retain their existing source-text capability checks. */
export const SHARED_CHANNEL_VERSION_ARGV = ["claude", "--version"] as const;
