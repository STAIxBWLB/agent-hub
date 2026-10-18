import { join } from "node:path";
import type { Launch } from "../../cli/launch.ts";
import { REDACTED, UNRESOLVED, nativeCommand, previewState, finishPreview, type NativePreviewContext } from "./native-cli-preview-common.ts";

export function previewQwen(ctx: NativePreviewContext) {
  const { tool, args, cwd, stateDir, cliDir, config } = ctx;
  const state = previewState(args, ctx.baseEnvNames), { unresolved, value } = state;
  let envNames = state.envNames;
  let launch: Launch;
  const mode = value("--mode") ?? "headless", model = value("--model");
  const adapter = ctx.definition;
  if (!(adapter.start.forms as readonly string[]).includes(mode)) throw new Error("Qwen TUI is not offered before verification");
  for (let i = 0; i < args.length; i += 2) if (!["--model", "--mode", "--session-id"].includes(args[i]!) || !args[i + 1]) throw new Error("unknown Qwen option");
  const sessionId = value("--session-id");
  if (sessionId !== undefined && !adapter.session.crashIdentity?.({ sessionId }).sessionId) throw new Error("invalid Qwen session identity");
  if (sessionId) unresolved.push({ field: "sessionId", reason: "requested through ACP session/load at start; preview does not load or expose it" });
  launch = adapter.start.launch({ instance: tool, form: "headless", projectRoot: cwd, stateDir, entrypoint: join(cliDir, "main.js"),
    userArgs: [], unattended: false, env: {}, preview: true, nativeCommand: nativeCommand(config.qwen_cmd, ["qwen", "--acp"]), model: model ? REDACTED : undefined });
  unresolved.push({ field: "nativeIdentity", reason: "Qwen Code 0.25.0 identity and permission modes are checked at ACP initialization; preview starts nothing" });

  return finishPreview(ctx, launch, envNames, unresolved, undefined);
}
