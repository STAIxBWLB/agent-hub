import { join, resolve } from "node:path";
import type { Launch } from "../../cli/launch.ts";
import { REDACTED, UNRESOLVED, nativeCommand, previewState, finishPreview, type NativePreviewContext } from "./native-cli-preview-common.ts";

export function previewPi(ctx: NativePreviewContext) {
  const { args, stateDir, cliDir, config } = ctx;
  const { relayModelIds, buildPiLaunch, startModeOf } = ctx.helpers;
  const state = previewState(args, ctx.baseEnvNames), { unresolved, value } = state;
  let envNames = state.envNames;
  let launch: Launch;
  const mode = value("--mode") ?? startModeOf(config.peers, "pi"); // #269: the same default `ahub pi` takes
  const backend = value("--backend") ?? config.pi.backend;
  if (!["headless", "tui"].includes(mode) || !["auto", "dgx", "mlx"].includes(backend) || (value("--session-id") && value("--session-file"))) throw new Error("invalid Pi options");
  if (args.includes("--replace-session") && (!value("--session-file") || value("--session-id"))) throw new Error("--replace-session requires --session-file, without --session-id");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--replace-session") continue;
    if (!["--mode", "--backend", "--model", "--session-id", "--session-file"].includes(args[i]!) || !value(args[i]!)) throw new Error("unknown Pi option");
    i++;
  }
  if (args.includes("--replace-session")) unresolved.push({ field: "session replacement", reason: "requires a person, a validated managed file and an offline settled owner at runtime; preview changes nothing" });
  const models = relayModelIds({ enableHubAuto: true, mlx: config.mlx.enabled === false ? undefined : config.mlx, mlxAlias: "mlx/fast", allowedDGXmodels: { "dgx/coding": config.pi.dgx_coding, "dgx/fast": config.pi.dgx_fast } });
  const pi = buildPiLaunch({
    stateDir, cmd: nativeCommand(config.pi.cmd, ["pi"]), mode: mode as "headless" | "tui", backend: backend as "auto" | "dgx" | "mlx",
    ...(value("--model") ? { model: REDACTED } : {}),
    ...(value("--session-id") ? { sessionId: REDACTED } : {}),
    ...(value("--session-file") ? { sessionFile: REDACTED } : {}),
    relay: { url: UNRESOLVED, token: UNRESOLVED, models: models.map(id => ({ id })) },
    tools: [], preamble: REDACTED, maxSteps: config.pi.max_steps,
  }, {}, resolve(join(cliDir, "../pi/extension.ts")), UNRESOLVED, UNRESOLVED);
  launch = pi;
  envNames = Object.keys(pi.env).concat(["PATH", "HOME", "USER", "SHELL", "TMPDIR", "TERM", "TERM_PROGRAM", "LANG", "LC_ALL", "LC_CTYPE", "NO_COLOR", "CODEX_HOME"].filter(key => process.env[key] !== undefined));
  if (mode === "tui") envNames.push("AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR");
  unresolved.push({ field: "bridge/relay endpoints and owner credentials", reason: "assigned at runtime; preview does not bind a server or start a model" });
  if (!value("--session-id") && !value("--session-file")) unresolved.push({ field: "sessionId", reason: "new native session identity is not allocated by preview" });
  return finishPreview(ctx, launch, envNames, unresolved, undefined);
}
