import type { Launch } from "../../cli/launch.ts";
import { REDACTED, UNRESOLVED, publicArg, previewState, finishPreview, type NativePreviewContext } from "./native-cli-preview-common.ts";

export function previewCodex(ctx: NativePreviewContext) {
  const { args, unattended, config } = ctx;
  const { buildLaunch } = ctx.helpers;
  const state = previewState(args, ctx.baseEnvNames), { unresolved } = state;
  let envNames = state.envNames;
  let launch: Launch;
  // A fresh native proxy is assigned by start, never guessed from an old status file.
  launch = buildLaunch("codex", args, { unattended, proxyUrl: UNRESOLVED, codexBin: config.codex_bin === "codex" ? "codex" : REDACTED });
  const passthrough = args.filter(arg => !["--unattended", "--safe", "--new"].includes(arg));
  launch.args = launch.args.slice(0, launch.args.length - passthrough.length).concat(passthrough.map(publicArg));
  unresolved.push({ field: "proxyUrl", reason: "assigned when the native adapter starts; preview does not start it" });

  envNames.push("AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID");
  unresolved.push({ field: "env.AGENTHUB_INSTANCE_ID", reason: "injected when a verified Orca terminal launch is recorded against the daemon; preview does not record it" });
  unresolved.push({ field: "env.AGENTHUB_LAUNCH_ID", reason: "allocated only for a verified Orca terminal launch; preview does not query Orca, allocate identity or write launch records" });
  return finishPreview(ctx, launch, envNames, unresolved, undefined);
}
