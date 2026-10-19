import type { Launch } from "../../cli/launch.ts";
import { REDACTED, UNRESOLVED, nativeCommand, previewState, finishPreview, type NativePreviewContext, type NativePreview } from "./native-cli-preview-common.ts";

export function previewJcode(ctx: NativePreviewContext): NativePreview {
  const { args, config } = ctx;
  const { jcodeCommand, jcodeTuiCommand, qwenSessionId, startModeOf } = ctx.helpers;
  const state = previewState(args, ctx.baseEnvNames), { unresolved, value } = state;
  let envNames = state.envNames;
  let launch: Launch;
  const mode = value("--mode") ?? startModeOf(config.peers, "jcode"), model = value("--model"), profile = value("--provider-profile"), session = value("--session-id");
  if (mode !== "headless" && mode !== "tui") throw new Error("invalid Jcode start mode");
  for (let i = 0; i < args.length; i += 2) if (!["--model", "--mode", "--provider-profile", "--session-id"].includes(args[i]!) || !args[i + 1]) throw new Error("unknown Jcode option");
  if (session !== undefined && !qwenSessionId(session)) throw new Error("invalid Jcode session identity");
  const cmd = mode === "tui" ? jcodeTuiCommand(nativeCommand(config.jcode_cmd, ["jcode"]), UNRESOLVED, UNRESOLVED, model ? REDACTED : undefined, profile || config.jcode_provider_profile ? REDACTED : undefined) : jcodeCommand(nativeCommand(config.jcode_cmd, ["jcode"]), "acp", UNRESOLVED, UNRESOLVED, model ? REDACTED : undefined, profile || config.jcode_provider_profile ? REDACTED : undefined);
  launch = { cmd: cmd[0]!, args: cmd.slice(1) };
  unresolved.push({ field: "ownedDaemon", reason: "private daemon/socket and source-pinned native identity verified at start; preview starts nothing" });
  unresolved.push({ field: "hubTools", reason: "project MCP bridge required; native tool-call receipt remains unverified" });

  return { ...finishPreview(ctx, launch, envNames, unresolved), mode };
}
