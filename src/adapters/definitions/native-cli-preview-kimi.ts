import { join } from "node:path";
import type { Launch } from "../../cli/launch.ts";
import { REDACTED, nativeCommand, previewState, finishPreview, type NativePreviewContext, type NativePreviewMetadata } from "./native-cli-preview-common.ts";

export function previewKimi(ctx: NativePreviewContext) {
  const { args, cwd, stateDir, cliDir, config } = ctx;
  const { childEnv, startModeOf, buildKimiLaunch, buildKimiTuiLaunch, nativeLaunchEnv, kimiMcpPlan } = ctx.helpers;
  const state = previewState(args, ctx.baseEnvNames), { unresolved, value } = state;
  let envNames = state.envNames;
  let launch: Launch;
  let kimiMetadata: NativePreviewMetadata | undefined;
  const model = value("--model");
  const mode = value("--mode") ?? startModeOf(config.peers, "kimi");
  if (mode !== "tui" && mode !== "headless") throw new Error("invalid Kimi mode");
  for (let i = 0; i < args.length; i += 2) if (!["--model", "--mode"].includes(args[i]!) || !args[i + 1]) throw new Error("unknown Kimi option");
  if (mode === "headless") {
    launch = buildKimiLaunch(nativeCommand(config.kimi_cmd, ["kimi", "acp"]), model ? REDACTED : undefined);
    unresolved.push({ field: "sessionId", reason: "ACP session identity is available only after native initialization" });
  } else {
    const native = buildKimiTuiLaunch(config.kimi_cmd, model ? REDACTED : undefined);
    launch = { ...native, cmd: native.cmd === "kimi" ? "kimi" : REDACTED, args: native.args.map(arg => arg === "--model" || arg === REDACTED ? arg : REDACTED) };
    envNames = Object.keys(nativeLaunchEnv("kimi", childEnv())).concat(["AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR"]);
  }
  const { file, action, changed, tracked } = kimiMcpPlan(cwd, stateDir, join(cliDir, "../../plugins/agent-hub/server.js"), mode);
  kimiMetadata = { mode, mcp: { file, action, changed, tracked } };

  return finishPreview(ctx, launch, envNames, unresolved, kimiMetadata);
}
