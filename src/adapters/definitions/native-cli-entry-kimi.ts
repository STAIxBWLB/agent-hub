import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { NativeCliEntryContext } from "./native-cli-entry-types.ts";
import { rosterInStatus } from "../../hub/status-roster.ts";

export async function runKimiEntry(ctx: NativeCliEntryContext): Promise<void> {
  const { args, cwd, stateDir, cliDir, unattendedEnv, projectConfig, connect, fail, takeFlags } = ctx;
  const { launcherPreview, startModeOf, buildKimiTuiLaunch, configureKimiMcp, nativeLaunchEnv, childEnv } = ctx.helpers;
  if (args.includes("--print-command") || args.includes("--dry-run")) {
    try { return console.log(JSON.stringify(launcherPreview("kimi", args, cwd, stateDir, unattendedEnv), null, 2)); }
    catch { fail("cannot preview launch: invalid arguments or configuration (details withheld to protect credentials)"); }
  }
  const { one, rest } = takeFlags(args, ["--mode", "--model"], []);
  const mode = one["--mode"] ?? startModeOf(projectConfig().peers, "kimi"), model = one["--model"];
  if (rest.length || !["tui", "headless"].includes(mode)) fail("usage: ahub kimi [--mode tui|headless] [--model <alias>]");
  if (mode === "tui" && one["--mode"] === undefined && !(process.stdin.isTTY && process.stdout.isTTY)) {
    if (model) fail("Kimi's TUI needs a terminal for these options; run in a terminal or add --mode headless");
    const hub = await connect();
    try {
      const reply = await hub.request({ t: "peer_start", peer: "kimi" }, 35_000);
      if (!reply.ok) fail(reply.error);
      return console.log(reply.already ? "kimi is already attached" : `kimi: opened a terminal running ${reply.command}; it attaches pull-only when its TUI is ready`);
    } finally { hub.close(); }
  }
  const hub = await connect();
  try {
    if (mode === "tui") {
      const launch = buildKimiTuiLaunch(projectConfig().kimi_cmd, model);
      const snapshot = (await hub.request({ t: "status" })).status;
      const rostered = rosterInStatus(snapshot, "kimi");
      if (rostered === undefined) fail("cannot read kimi's roster membership from the running hub; upgrade or restart it, then retry (nothing was started)");
      if (!rostered) fail("kimi is off roster; add it with ahub roster add kimi");
      const peer = snapshot?.peers?.kimi;
      if (peer && !["offline"].includes(peer.state) && !peer.pullOnly) fail("Kimi is running headless; run ahub stop kimi before starting its TUI");
      const admission = await hub.request({ t: "start", peer: "kimi", args: { mode: "tui" }, operationId: process.env.AGENTHUB_RECOVERY_OPERATION });
      if (!admission.ok) fail(admission.error);
      let result: ReturnType<typeof spawnSync>;
      try {
        const written = configureKimiMcp(cwd, stateDir, resolve(cliDir, "../../plugins/agent-hub/server.js"), "tui");
        if (written.tracked) console.error(".kimi-code/mcp.json is tracked; the agent-hub entry contains machine paths. Review this local change before committing it.");
        result = spawnSync(launch.cmd, launch.args, { cwd, stdio: "inherit", env: { ...nativeLaunchEnv("kimi", childEnv()), AGENTHUB_STATE_DIR: stateDir, AGENTHUB_PROJECT_DIR: cwd } });
      } finally {
        if (admission.admissionId) await hub.request({ t: "kimi_launch_end", admissionId: admission.admissionId }).catch(() => {});
      }
      if (result.error) fail(`cannot run ${launch.cmd}: ${result.error.message}`);
      process.exit(result.status ?? 1);
    }
    const peer = (await hub.request({ t: "status" })).status?.peers?.kimi;
    if (peer?.pullOnly && peer.state !== "offline") fail("Kimi runs in a terminal; end it there before starting a headless one");
    configureKimiMcp(cwd, stateDir, resolve(cliDir, "../../plugins/agent-hub/server.js"), "headless");
    const res = await hub.request({ t: "start", peer: "kimi", args: { mode: "headless", model }, operationId: process.env.AGENTHUB_RECOVERY_OPERATION });
    if (!res.ok) fail(res.error);
    console.log(res.already ? "kimi is already attached" : 'kimi attached (headless). Talk to it with: ahub say @kimi "..."');
  } finally { hub.close(); }
}
