import type { LaunchContext, LaunchPlan } from "../registry-types.ts";
import { nativeLaunchArguments, nativeLaunchPlan } from "./native-cli-launch-common.ts";

export const CODEX_LAUNCH_POLICY = Object.freeze({ hubSwitches: Object.freeze(["--unattended", "--safe", "--new"]), ownedFlags: Object.freeze(["--remote", "--remote-auth-token-env", "--yolo", "--dangerously-bypass-approvals-and-sandbox"]), unattended: true, passthrough: true });
export function codexNativeLaunch(ctx: LaunchContext): LaunchPlan {
  const { passthrough, unattended, warning } = nativeLaunchArguments("codex", ctx, CODEX_LAUNCH_POLICY);
  if (!ctx.proxyUrl) throw new Error("codex proxy url is missing");
  return nativeLaunchPlan({
    cmd: ctx.codexBin ?? "codex",
    args: ["--enable", "tui_app_server", "--remote", ctx.proxyUrl, ...(ctx.launchTokenEnv ? ["--remote-auth-token-env", ctx.launchTokenEnv] : []), ...(unattended ? ["--dangerously-bypass-approvals-and-sandbox"] : []), ...passthrough],
    unattended,
    ...warning,
  }, ctx);
}
