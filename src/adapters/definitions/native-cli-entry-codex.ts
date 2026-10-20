import { retainedLaunchWarning } from "./native-cli-retained.ts";
import type { NativeCliEntryContext } from "./native-cli-entry-types.ts";

export async function runCodexEntry(ctx: NativeCliEntryContext): Promise<void> {
  const peer = ctx.instance ?? "codex";
  const { args, cwd, stateDir, unattendedEnv, projectConfig, connect, fail, exec } = ctx;
  const { launcherPreview, buildLaunch, readControl, prepareTerminalLaunch, registerTerminalLaunch } = ctx.helpers;
  if (args.includes("--print-command") || args.includes("--dry-run")) {
    try { return console.log(JSON.stringify(launcherPreview("codex", args, cwd, stateDir, unattendedEnv), null, 2)); }
    catch { fail("cannot preview launch: invalid arguments or configuration (details withheld to protect credentials)"); }
  }
  const launch0 = buildLaunch("codex", args, { unattended: unattendedEnv, instance: peer, proxyUrl: "pending" }); // refuse bad flags before starting anything
  const hub = await connect();
  const snapshot = (await hub.request({ t: "status" })).status;
  const warning = retainedLaunchWarning(snapshot, peer, ctx.definition); if (warning) console.error(warning);
  const res = await hub.request({ t: "start", peer, args: { unattended: launch0.unattended === true }, operationId: process.env.AGENTHUB_RECOVERY_OPERATION });
  if (!res.ok) { hub.close(); fail(res.error); }
  if (ctx.instance) {
    if (typeof res.executionCwd !== "string" || !res.executionCwd.startsWith("/")) fail("instance execution directory was not verified");
    ctx.executionCwd = res.executionCwd;
  }
  const control = readControl(stateDir);
  let proxyUrl = res.proxyUrl;
  try {
    if (control?.instanceId) {
      const terminal = await prepareTerminalLaunch(peer, cwd, stateDir, control.instanceId, ctx.instance ? { executionCwd: ctx.executionCwd } : undefined);
      if (terminal) {
        await registerTerminalLaunch(hub, terminal, process.env.AGENTHUB_RECOVERY_OPERATION);
        const url = new URL(proxyUrl); url.searchParams.set("launchId", terminal.launchId); proxyUrl = url.toString();
      }
    }
  } finally { hub.close(); }
  const runningCodexBin = res.retainedLaunchConfig?.codex_bin;
  const launch = buildLaunch("codex", args, { unattended: unattendedEnv, instance: peer, proxyUrl, codexBin: typeof runningCodexBin === "string" ? runningCodexBin : projectConfig().codex_bin });
  if (launch0.warning) console.error(launch0.warning);
  exec(launch.cmd, launch.args, "codex");
}
