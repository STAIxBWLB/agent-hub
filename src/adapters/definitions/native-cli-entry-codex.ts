import type { NativeCliEntryContext } from "./native-cli-entry-types.ts";

export async function runCodexEntry(ctx: NativeCliEntryContext): Promise<void> {
  const peer = ctx.instance ?? "codex";
  const { args, cwd, stateDir, unattendedEnv, projectConfig, connect, fail, exec } = ctx;
  const { launcherPreview, buildLaunch, recoveryLock, readControl, recordTerminalLaunch } = ctx.helpers;
  if (args.includes("--print-command") || args.includes("--dry-run")) {
    try { return console.log(JSON.stringify(launcherPreview("codex", args, cwd, stateDir, unattendedEnv), null, 2)); }
    catch { fail("cannot preview launch: invalid arguments or configuration (details withheld to protect credentials)"); }
  }
  const launch0 = buildLaunch("codex", args, { unattended: unattendedEnv, instance: peer, proxyUrl: "pending" }); // refuse bad flags before starting anything
  // #215: a launch by a recovery operation records itself before the hub round trip, so the coordinator never takes
  // a launcher still starting for one that never ran. An ordinary launch records only once the hub accepted it: a
  // refused start must not replace the record of a Codex already running here (one row per peer and instance).
  const recovering = !!process.env.AGENTHUB_RECOVERY_OPERATION && process.env.AGENTHUB_RECOVERY_OPERATION === recoveryLock(); // not an id a restored session inherited
  const before = readControl(stateDir);
  // ponytail: recovering extras have no authenticated execution-root binding before start replies, so their row
  // is recorded afterward. The coordinator retains its pending creation/wait evidence; add pre-start recording
  // only when a future recovery receipt supplies independently verified exact-instance execution-root evidence.
  if (recovering && !ctx.instance && before?.instanceId) await recordTerminalLaunch(peer, cwd, stateDir, before.instanceId);
  const hub = await connect();
  const snapshot = (await hub.request({ t: "status" })).status;
  const warning = ctx.helpers.retainedLaunchWarning(snapshot, peer, ctx.definition); if (warning) console.error(warning);
  const res = await hub.request({ t: "start", peer, args: { unattended: launch0.unattended === true }, operationId: process.env.AGENTHUB_RECOVERY_OPERATION });
  hub.close();
  if (!res.ok) fail(res.error);
  if (ctx.instance) {
    if (typeof res.executionCwd !== "string" || !res.executionCwd.startsWith("/")) fail("instance execution directory was not verified");
    ctx.executionCwd = res.executionCwd;
  }
  const control = readControl(stateDir);
  if ((!recovering || ctx.instance) && control?.instanceId) await recordTerminalLaunch(peer, cwd, stateDir, control.instanceId, ctx.instance ? { executionCwd: ctx.executionCwd } : undefined);
  const runningCodexBin = res.retainedLaunchConfig?.codex_bin;
  const launch = buildLaunch("codex", args, { unattended: unattendedEnv, instance: peer, proxyUrl: res.proxyUrl, codexBin: typeof runningCodexBin === "string" ? runningCodexBin : projectConfig().codex_bin });
  if (launch0.warning) console.error(launch0.warning);
  exec(launch.cmd, launch.args, "codex");
}
