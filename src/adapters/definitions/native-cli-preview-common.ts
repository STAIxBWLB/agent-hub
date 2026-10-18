import type { loadConfig } from "../../hub/daemon.ts";
import type { AdapterDefinition } from "../registry-types.ts";
import type { Launch } from "../../cli/launch.ts";

export const REDACTED = "[redacted]";
export const UNRESOLVED = "[unresolved]";
/** Fixed, pure/read-only CLI planning helpers. No command executor, control client or writer enters this port. */
export interface NativePreviewHelpers {
  buildLaunch: typeof import("../../cli/launch.ts").buildLaunch;
  claudeObservationHooks: typeof import("../../cli/launch.ts").claudeObservationHooks;
  buildKimiLaunch: typeof import("../../cli/launch.ts").buildKimiLaunch;
  buildKimiTuiLaunch: typeof import("../../cli/launch.ts").buildKimiTuiLaunch;
  nativeLaunchEnv: typeof import("../../cli/launch.ts").nativeLaunchEnv;
  childEnv: typeof import("../../hub/child-process.ts").childEnv;
  startModeOf: typeof import("../../hub/start-mode.ts").startModeOf;
  kimiMcpPlan: typeof import("../../cli/kimi-mcp.ts").kimiMcpPlan;
  jcodeCommand: typeof import("../jcode.ts").jcodeCommand;
  qwenSessionId: typeof import("../../hub/crash.ts").qwenSessionId;
  relayModelIds: typeof import("../../models/relay.ts").relayModelIds;
  buildPiLaunch: typeof import("../../pi/launch.ts").buildPiLaunch;
}
export interface NativePreviewContext {
  tool: string; args: string[]; cwd: string; stateDir: string; cliDir: string; unattended: boolean;
  config: ReturnType<typeof loadConfig>; definition: AdapterDefinition; baseEnvNames: string[]; helpers: NativePreviewHelpers;
}
export interface NativePreviewMetadata { mode: "tui" | "headless"; mcp: { file: string; action: string; changed: boolean; tracked: boolean } }
export type NativePreviewBuilder = (ctx: NativePreviewContext) => NativePreview;
export interface NativePreview {
  tool: string; mode?: "tui" | "headless"; mcp?: NativePreviewMetadata["mcp"];
  cmd: string; args: string[]; settings: string | undefined; envNames: string[]; warning?: string;
  unresolved: { field: string; reason: string }[]; redaction: string; needs: string[];
}
/** Arbitrary native arguments can contain secrets even without a credential-looking key. */
export function publicArg(arg: string): string {
  const flags = new Set(["--settings", "--model", "--mcp-config", "--session-id", "--session-file", "--resume", "--continue", "--print", "--safe", "--new"]);
  const key = arg.split("=", 1)[0]!;
  return flags.has(key) ? (arg.includes("=") ? key + "=" + REDACTED : key) : REDACTED;
}
export function nativeCommand(command: string[], trusted: string[]): string[] {
  return command.map((value, i) => value === trusted[i] ? value : REDACTED);
}

export function previewState(args: readonly string[], baseEnvNames: readonly string[]) {
  const unresolved: { field: string; reason: string }[] = [];
  const envNames = [...baseEnvNames];
  const value = (flag: string) => {
    const at = args.indexOf(flag);
    if (at < 0) return undefined;
    const next = args[at + 1];
    if (!next || next.startsWith("--")) throw new Error("missing option value");
    return next;
  };
  return { unresolved, envNames, value };
}
export function finishPreview(ctx: NativePreviewContext, launch: Launch, envNames: string[], unresolved: NativePreview["unresolved"], metadata?: NativePreviewMetadata, settings?: string): NativePreview {
  return { tool: ctx.tool, ...(metadata ?? {}), cmd: launch.cmd, args: launch.args, settings, envNames: [...new Set(envNames)].sort(), ...(launch.warning ? { warning: launch.warning } : {}), unresolved, redaction: "Arbitrary user arguments, settings, commands and configured executable overrides are redacted. Environment values are never displayed.", needs: ["Native executable, accounts and runtime readiness are not checked."] };
}
