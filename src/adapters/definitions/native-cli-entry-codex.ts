import type { NativeCliEntryContext } from "./native-cli-entry-types.ts";

export async function runCodexEntry(ctx: NativeCliEntryContext): Promise<void> {
  const { args, cwd, stateDir, unattendedEnv, projectConfig, connect, fail, exec } = ctx;
  const { launcherPreview, buildLaunch, recoveryLock, readControl, recordTerminalLaunch } = ctx.helpers;
  if (args.includes("--print-command") || args.includes("--dry-run")) {
    try { return console.log(JSON.stringify(launcherPreview("codex", args, cwd, stateDir, unattendedEnv), null, 2)); }
    catch { fail("cannot preview launch: invalid arguments or configuration (details withheld to protect credentials)"); }
  }
  const launch0 = buildLaunch("codex", args, { unattended: unattendedEnv, proxyUrl: "pending" }); // refuse bad flags before starting anything
  // #215: a launch by a recovery operation records itself before the hub round trip, so the coordinator never takes
  // a launcher still starting for one that never ran. An ordinary launch records only once the hub accepted it: a
  // refused start must not replace the record of a Codex already running here (one row per peer and instance).
  const recovering = !!process.env.AGENTHUB_RECOVERY_OPERATION && process.env.AGENTHUB_RECOVERY_OPERATION === recoveryLock(); // not an id a restored session inherited
  const before = readControl(stateDir);
  if (recovering && before?.instanceId) await recordTerminalLaunch("codex", cwd, stateDir, before.instanceId);
  const hub = await connect();
  const res = await hub.request({ t: "start", peer: "codex", args: { unattended: launch0.unattended === true }, operationId: process.env.AGENTHUB_RECOVERY_OPERATION });
  hub.close();
  if (!res.ok) fail(res.error);
  const control = readControl(stateDir);
  if (!recovering && control?.instanceId) await recordTerminalLaunch("codex", cwd, stateDir, control.instanceId);
  const launch = buildLaunch("codex", args, { unattended: unattendedEnv, proxyUrl: res.proxyUrl, codexBin: projectConfig().codex_bin });
  if (launch0.warning) console.error(launch0.warning);
  exec(launch.cmd, launch.args, "codex");
}
