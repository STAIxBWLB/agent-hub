import { parsePiFlags } from "./native-cli-pi.ts";
import type { NativeCliEntryContext } from "./native-cli-entry-types.ts";

export async function runPiEntry(ctx: NativeCliEntryContext): Promise<void> {
  const peer = ctx.instance ?? "pi";
  const { args, cwd, stateDir, unattendedEnv, projectConfig, connect, fail, execWithEnv } = ctx;
  const { launcherPreview, startModeOf, recoveryLock, readControl, recordTerminalLaunch } = ctx.helpers;
  // --headless is --mode headless everywhere this command goes: the preview, the hub and the conductor path.
  if (args.includes("--headless") && !args.includes("--mode")) args.splice(args.indexOf("--headless"), 1, "--mode", "headless");
  if (args.includes("--print-command") || args.includes("--dry-run")) {
    try { return console.log(JSON.stringify(launcherPreview("pi", args, cwd, stateDir, unattendedEnv), null, 2)); }
    catch { fail("cannot preview launch: invalid arguments or configuration (details withheld to protect credentials)"); }
  }
  const flags = parsePiFlags(args, fail);
  // #269: with no flag, Pi's start mode decides, and that is its TUI unless a person set headless.
  const options = { ...flags, mode: flags.mode ?? (ctx.instance ? "headless" : startModeOf(projectConfig().peers, "pi")) };
  if (ctx.instance && options.mode !== "headless") fail("extra Pi instances require headless mode");
  if (flags.mode === undefined && options.mode === "tui" && !(process.stdin.isTTY && process.stdout.isTTY)) {
    // The default asked for the TUI and there is no terminal here (the console's command line, a script): the hub
    // opens one, or says how to. It is never downgraded to headless. The fixed command carries no option, so one
    // that was given needs a terminal of its own. An explicit --mode tui is taken at its word, as before.
    if (Object.keys(flags).length) fail("Pi's TUI needs a terminal, and these options are not passed to one the hub opens: run this in a terminal, or add --mode headless");
    const hub = await connect();
    try {
      const snapshot = (await hub.request({ t: "status" })).status;
      const warning = ctx.helpers.retainedLaunchWarning(snapshot, peer, ctx.definition); if (warning) console.error(warning);
      const reply = await hub.request({ t: "peer_start", peer }, 35_000);
      if (reply.ok !== true) {
        const error = String(reply.error ?? "pi start refused");
        fail(/unknown (?:control )?(?:message|request|command)(?:\b|:)|this hub does not know "peer_start"/i.test(error) ? `${error}; upgrade the running hub, or run ahub pi --mode headless` : error);
      }
      return console.log(reply.already ? "pi is already attached" : reply.opened ? `pi: opened a terminal running ${reply.command}; it attaches when its TUI is ready` : 'pi attached (headless). Talk to it with: ahub say @pi "..."');
    } finally { hub.close(); }
  }
  // #215: as for Codex, a TUI launch by the recovery operation holding the lock records itself before the hub round
  // trip, so a resume in that window never reads it as gone; an ordinary launch records only after the hub accepted it.
  const recovering = options.mode === "tui" && !!process.env.AGENTHUB_RECOVERY_OPERATION && process.env.AGENTHUB_RECOVERY_OPERATION === recoveryLock();
  const before = readControl(stateDir);
  if (recovering && before?.instanceId) await recordTerminalLaunch(peer, cwd, stateDir, before.instanceId);
  const hub = await connect();
  const snapshot = (await hub.request({ t: "status" })).status;
  const warning = ctx.helpers.retainedLaunchWarning(snapshot, peer, ctx.definition); if (warning) console.error(warning);
  const res = await hub.request({ t: "start", peer, args: options, operationId: process.env.AGENTHUB_RECOVERY_OPERATION });
  hub.close();
  if (!res.ok) fail(res.error);
  if (options.mode === "tui") {
    const launch = res.launch;
    if (!launch || typeof launch.cmd !== "string" || !Array.isArray(launch.args) || !launch.args.every((a: unknown) => typeof a === "string") || !launch.env || typeof launch.env !== "object") fail("Pi TUI launch metadata was not verified");
    const launchEnv = { ...(launch.env as NodeJS.ProcessEnv) };
    delete launchEnv.AGENTHUB_RECOVERY_OPERATION;
    delete launchEnv.AGENTHUB_UNATTENDED;
    const control = readControl(stateDir);
    if (!recovering && control?.instanceId) await recordTerminalLaunch(peer, cwd, stateDir, control.instanceId);
    return execWithEnv(launch.cmd, launch.args, launchEnv);
  }
  console.log(res.already ? `${peer} is already attached` : `${peer} attached (headless). Talk to it with: ahub say @${peer} "..."`);
}
