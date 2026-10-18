import type { StartForm, StartRequest, VersionContext } from "../registry-types.ts";

/** Native serialization and person-facing guidance only; the daemon retains every ownership decision. */
export const claudeRecoveryLaunch = (instance: string): Record<string, unknown> => ({ kind: "claude-channel", peer: instance });
export const kimiRecoveryLaunch = (instance: string): Record<string, unknown> => ({ kind: "kimi-tui", peer: instance, mode: "tui" });
export const claudeRetainedTerminalNotice = (instance: string): string =>
  `Stop ${instance}'s existing work in its retained terminal; removal detaches the hub connection and does not stop that terminal's work.`;
export const piRetainedTerminalNotice = (instance: string, form: StartForm | undefined): string | undefined =>
  form === "tui" ? claudeRetainedTerminalNotice(instance) : undefined;
export const codexRetainedTerminalNotice = (_instance: string, _form: StartForm | undefined, resumeCommand: string): string =>
  `Check codex's existing terminal and stop any remaining work. Its app-server and proxy stay available, but Codex 0.146.0 exits its TUI on disconnect and does not reconnect automatically; after ahub roster add codex, resume the previous session with ${resumeCommand}.`;
export const codexRosterReturnNotice = (resumeCommand: string): string =>
  `Codex 0.146.0 needs a manual return: resume the previous native session with ${resumeCommand}.`;
export const jcodeStartPreflight = (request: StartRequest): string | undefined =>
  request.form !== undefined && request.form !== "headless" ? "Jcode native TUI driving is unverified; use headless" : undefined;
export const claudeObservedVersion = (context: VersionContext): string | undefined => context.observedVersion;
export const codexObservedVersion = (context: VersionContext): string | undefined =>
  (context.peer as { version?: string } | undefined)?.version ?? context.observedVersion;
