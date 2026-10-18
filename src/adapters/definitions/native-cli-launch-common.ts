import type { LaunchContext, LaunchPlan } from "../registry-types.ts";
import type { Launch } from "../../cli/launch.ts";
import { UNATTENDED_WARNING } from "../../cli/launch.ts";
import { shellQuote } from "../../cli/shell-quote.ts";

export interface NativeLaunchPolicy { hubSwitches: readonly string[]; ownedFlags: readonly string[] }
export function nativeLaunchArguments(tool: string, ctx: LaunchContext, policy: NativeLaunchPolicy) {
  const passthrough = ctx.userArgs.filter(arg => !policy.hubSwitches.includes(arg));
  const dup = passthrough.find(arg => policy.ownedFlags.some(flag => arg === flag || arg.startsWith(`${flag}=`)));
  if (dup) throw new Error(`${dup} is managed by the hub; use "hub ${tool} --unattended" or drop the flag`);
  const unattended = ctx.unattended || ctx.userArgs.includes("--unattended");
  return { passthrough, unattended, warning: unattended ? { warning: UNATTENDED_WARNING } : {} };
}
export function nativeLaunchPlan(launch: Launch, ctx: LaunchContext): LaunchPlan {
  const argv = [launch.cmd, ...launch.args];
  return { ...launch, metadata: { packageEntrypoint: ctx.entrypoint, argv, env: {}, command: argv.map(shellQuote).join(" ") } };
}
