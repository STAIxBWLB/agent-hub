import { retainedLaunchWarning } from "./native-cli-retained.ts";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { assessVersion, COMPAT } from "../compat.ts";
import type { NativeCliEntryContext } from "./native-cli-entry-types.ts";
import { bundleInStatus, rosterInStatus } from "../../hub/status-roster.ts";
import { cleanupKimiPlugin, ensureKimiPlugin, type KimiPluginOptions } from "../../cli/kimi-plugin.ts";

export function kimiTuiVersionGate(stdout: string): { ok: true; message?: string } | { ok: false; message: string } {
  const verdict = assessVersion("kimi-tui", COMPAT["kimi-tui"].parse(stdout));
  if (!verdict.ok) return { ok: false, message: verdict.reason };
  return verdict.note ? { ok: true, message: verdict.note } : { ok: true };
}

export function kimiTuiSpawnOptions(cwd: string, env: NodeJS.ProcessEnv) {
  return { cwd, env, stdio: "inherit" as const };
}

function runKimiTui(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ error?: Error; status: number | null }> {
  const child = spawn(cmd, args, kimiTuiSpawnOptions(cwd, env));
  return new Promise((resolveExit, reject) => {
    const forward = (signal: NodeJS.Signals) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill(signal); } catch { /* the native child may exit as the signal arrives */ }
    };
    const onInterrupt = () => forward("SIGINT"), onTerminate = () => forward("SIGTERM"), onHangup = () => forward("SIGHUP");
    const cleanup = () => { process.off("SIGINT", onInterrupt); process.off("SIGTERM", onTerminate); process.off("SIGHUP", onHangup); };
    process.on("SIGINT", onInterrupt); process.on("SIGTERM", onTerminate); process.on("SIGHUP", onHangup);
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", code => { cleanup(); resolveExit({ status: code }); });
  });
}

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
      let launch: ReturnType<typeof buildKimiTuiLaunch>;
      let result: { error?: Error; status: number | null };
      try {
        // Inside the try: a kimi_cmd with no TUI form throws here, and the admission must still be released (#549).
        // The running hub's value wins over the file's while a reload is retained (#654): when it has no TUI form, say whose it is, so the
        // error is not read as a fault in the file. The words themselves are never echoed.
        const running = Array.isArray(runningCommand) && runningCommand.every((arg: unknown) => typeof arg === "string");
        try { launch = buildKimiTuiLaunch(running ? runningCommand : projectConfig().kimi_cmd, model); }
        catch (error) {
          throw running ? new Error(`${(error as Error).message} (the command is the running hub's kimi_cmd: the value in the config file is retained until ahub settings reload)`) : error;
        }
        const version = spawnSync(launch.cmd, ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 4096, env: nativeLaunchEnv("kimi", childEnv()) });
        const gate = kimiTuiVersionGate(version.status === 0 ? version.stdout : "");
        if (!gate.ok) fail(gate.message);
        if (gate.message) console.error(gate.message);
        // The daemon's own bundles, so the MCP server and native hook match the hub they talk to (#502, #1282).
        const serverBundle = bundleInStatus(snapshot) ?? resolve(cliDir, "../../plugins/agent-hub/server.js");
        const written = configureKimiMcp(cwd, stateDir, serverBundle, "tui");
        if (written.tracked) console.error(".kimi-code/mcp.json is tracked; the agent-hub entry contains machine paths. Review this local change before committing it.");
        const nativeEnv: NodeJS.ProcessEnv = { ...nativeLaunchEnv("kimi", childEnv()), AGENTHUB_STATE_DIR: stateDir, AGENTHUB_PROJECT_DIR: cwd };
        const nativeHome = nativeEnv.KIMI_CODE_HOME ?? join(nativeEnv.HOME ?? homedir(), ".kimi-code");
        mkdirSync(nativeHome, { recursive: true, mode: 0o700 });
        const native = await hub.request({ t: "native_hook_launch", op: "begin", peer, nativeHome });
        if (!native.ok || typeof native.launchId !== "string" || typeof native.instanceId !== "string") fail(native.error ?? "native hook launch was not admitted");
        const plugin: KimiPluginOptions = { home: nativeHome, hookScript: resolve(serverBundle, "../kimi-hook.js"), launchId: native.launchId, replaceStale: true };
        let pluginReady = false;
        try {
          console.error("Kimi TUI completion facts: installing a launch-scoped native plugin; it will be removed after this TUI exits");
          ensureKimiPlugin(plugin);
          pluginReady = true;
          result = await runKimiTui(launch.cmd, launch.args, cwd, { ...nativeEnv, AGENTHUB_INSTANCE_ID: native.instanceId, AGENTHUB_LAUNCH_ID: native.launchId, AGENTHUB_HOOK_PURPOSE: "facts" });
        } finally {
          await hub.request({ t: "native_hook_launch", op: "end", peer, launchId: native.launchId }).catch(() => {});
          if (pluginReady) try { cleanupKimiPlugin(plugin); } catch { console.error("Managed Kimi plugin cleanup refused: files or ownership changed; inspect the launch-scoped plugin before removing it"); }
        }
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
