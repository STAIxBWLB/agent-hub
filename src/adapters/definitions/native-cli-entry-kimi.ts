import { retainedLaunchWarning } from "./native-cli-retained.ts";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { NativeCliEntryContext } from "./native-cli-entry-types.ts";
import { bundleInStatus, rosterInStatus } from "../../hub/status-roster.ts";

export async function runKimiEntry(ctx: NativeCliEntryContext): Promise<void> {
  const peer = ctx.instance ?? "kimi";
  const { args, cwd, stateDir, cliDir, unattendedEnv, projectConfig, connect, fail, takeFlags } = ctx;
  const { launcherPreview, readControl, startModeOf, buildKimiTuiLaunch, configureKimiMcp, nativeLaunchEnv, childEnv } = ctx.helpers;
  if (args.includes("--print-command") || args.includes("--dry-run")) {
    try { return console.log(JSON.stringify(launcherPreview("kimi", args, cwd, stateDir, unattendedEnv), null, 2)); }
    catch { fail("cannot preview launch: invalid arguments or configuration (details withheld to protect credentials)"); }
  }
  const { one, rest } = takeFlags(args, ["--mode", "--model"], []);
  const acceptedMode = readControl(stateDir)?.startModes?.[peer];
  const mode = one["--mode"] ?? (ctx.instance ? "headless" : acceptedMode ?? startModeOf(projectConfig().peers, "kimi")), model = one["--model"];
  if (ctx.instance && mode !== "headless") fail("extra Kimi instances require headless mode");
  if (rest.length || !["tui", "headless"].includes(mode)) fail("usage: ahub kimi [--mode tui|headless] [--model <alias>]");
  if (mode === "tui" && one["--mode"] === undefined && !(process.stdin.isTTY && process.stdout.isTTY)) {
    if (model) fail("Kimi's TUI needs a terminal for these options; run in a terminal or add --mode headless");
    const hub = await connect();
    try {
      const snapshot = (await hub.request({ t: "status" })).status;
      const warning = retainedLaunchWarning(snapshot, peer, ctx.definition); if (warning) console.error(warning);
      const reply = await hub.request({ t: "peer_start", peer }, 35_000);
      if (!reply.ok) fail(reply.error);
      return console.log(reply.already ? "kimi is already attached" : `kimi: opened a terminal running ${reply.command}; it attaches pull-only when its TUI is ready`);
    } finally { hub.close(); }
  }
  const hub = await connect();
  try {
    if (mode === "tui") {
      const snapshot = (await hub.request({ t: "status" })).status;
      const rostered = rosterInStatus(snapshot, peer);
      if (rostered === undefined) fail("cannot read kimi's roster membership from the running hub; upgrade or restart it, then retry (nothing was started)");
      if (!rostered) fail("kimi is off roster; add it with ahub roster add kimi");
      const warning = retainedLaunchWarning(snapshot, peer, ctx.definition); if (warning) console.error(warning);
      const owner = snapshot?.peers?.[peer];
      if (owner && !["offline"].includes(owner.state) && !owner.pullOnly) fail("Kimi is running headless; run ahub stop kimi before starting its TUI");
      const admission = await hub.request({ t: "start", peer, args: { mode: "tui" }, operationId: process.env.AGENTHUB_RECOVERY_OPERATION });
      if (!admission.ok) fail(admission.error);
      const runningCommand = admission.retainedLaunchConfig?.kimi_cmd;
      const launch = buildKimiTuiLaunch(Array.isArray(runningCommand) && runningCommand.every((arg: unknown) => typeof arg === "string") ? runningCommand : projectConfig().kimi_cmd, model);
      let result: ReturnType<typeof spawnSync>;
      try {
        // The daemon's own bundle, so the MCP server matches the hub it talks to (#502); this CLI's copy only for an older hub.
        const written = configureKimiMcp(cwd, stateDir, bundleInStatus(snapshot) ?? resolve(cliDir, "../../plugins/agent-hub/server.js"), "tui");
        if (written.tracked) console.error(".kimi-code/mcp.json is tracked; the agent-hub entry contains machine paths. Review this local change before committing it.");
        result = spawnSync(launch.cmd, launch.args, { cwd, stdio: "inherit", env: { ...nativeLaunchEnv("kimi", childEnv()), AGENTHUB_STATE_DIR: stateDir, AGENTHUB_PROJECT_DIR: cwd } });
      } finally {
        if (admission.admissionId) await hub.request({ t: "kimi_launch_end", admissionId: admission.admissionId }).catch(() => {});
      }
      if (result.error) fail(`cannot run ${launch.cmd}: ${result.error.message}`);
      process.exit(result.status ?? 1);
    }
    const snapshot = (await hub.request({ t: "status" })).status;
    const warning = retainedLaunchWarning(snapshot, peer, ctx.definition); if (warning) console.error(warning);
    const owner = snapshot?.peers?.[peer];
    if (owner?.pullOnly && owner.state !== "offline") fail("Kimi runs in a terminal; end it there before starting a headless one");
    if (!ctx.instance) configureKimiMcp(cwd, stateDir, resolve(cliDir, "../../plugins/agent-hub/server.js"), "headless");
    const res = await hub.request({ t: "start", peer, args: { mode: "headless", model }, operationId: process.env.AGENTHUB_RECOVERY_OPERATION });
    if (!res.ok) fail(res.error);
    console.log(res.already ? `${peer} is already attached` : `${peer} attached (headless). Talk to it with: ahub say @${peer} "..."`);
  } finally { hub.close(); }
}
