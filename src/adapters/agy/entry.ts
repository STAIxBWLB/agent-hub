import { publicArg } from "../definitions/native-cli-preview-common.ts";
import { assessVersion, COMPAT } from "../compat.ts";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { NativeCliEntryContext } from "../definitions/native-cli-entry-types.ts";
import { bundleInStatus, rosterInStatus } from "../../hub/status-roster.ts";
import { ensureAgyMcp, cleanupAgyMcp, type AgyMcpOptions } from "../../cli/agy-mcp.ts";
import { peerChildEnv } from "../../hub/child-process.ts";

export function agyTuiSpawnOptions(cwd: string, env: NodeJS.ProcessEnv) {
  return { cwd, env, stdio: "inherit" as const };
}

function runAgyTui(argv: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn("agy", argv, agyTuiSpawnOptions(cwd, env));
  return new Promise((resolveExit, reject) => {
    const forward = (signal: NodeJS.Signals) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill(signal); } catch { /* The native child may exit as the signal arrives. */ }
    };
    const onInterrupt = () => forward("SIGINT");
    const onTerminate = () => forward("SIGTERM");
    const onHangup = () => forward("SIGHUP");
    const cleanup = () => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      process.off("SIGHUP", onHangup);
    };
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    process.on("SIGHUP", onHangup);
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", code => { cleanup(); resolveExit(code ?? 1); });
  });
}

/** #607: agy 1.4.x attaches the plugin MCP server at the first prompt, so the hub tools are listed from the second turn. */
export const AGY_LAUNCH_NOTICE = "Antigravity: pull-only TUI; native permissions unmanaged, no hub sandbox; hub tools appear from the second turn (send any first prompt, then ask for hub work)";

/** agy auto-updates, so the 1.4.x line launches; only 1.4.2 and 1.4.7 have a T0 receipt and other patches warn (#589). */
export function agyVersionGate(stdout: string): { ok: true; message?: string } | { ok: false; message: string } {
  // #691: the verified versions, the compatible line and the person's trust live in compat.ts.
  const verdict = assessVersion("agy", COMPAT.agy.parse(stdout));
  if (!verdict.ok) return { ok: false, message: verdict.reason };
  return verdict.note ? { ok: true, message: verdict.note } : { ok: true };
}

export async function runAgyEntry(ctx: NativeCliEntryContext): Promise<void> {
  const { args, cwd, stateDir, cliDir, connect, fail } = ctx;
  if (ctx.instance) fail("extra Antigravity TUI instances are not verified in P1");
  const preview = args.includes("--print-command") || args.includes("--dry-run");
  const unattended = ctx.unattendedEnv || args.includes("--unattended");
  const nativeArgs = args.filter(arg => !["--print-command", "--dry-run", "--unattended"].includes(arg));
  // Headless, resume and native approval overrides are not silently passed through an unverified hub mapping.
  if (nativeArgs.some(arg => ["--print", "-p", "--prompt", "--input-format", "--output-format", "--conversation", "--continue", "-c", "--new", "--mode", "--dangerously-skip-permissions"].some(flag => arg === flag || arg.startsWith(`${flag}=`)))) fail("agy P1 supports a fresh TUI only; headless, resume and permission flags need a verified mapping");
  if (unattended) fail("agy P1 native permissions are unmanaged; unattended mode has no verified prompt mapping");
  const argv = nativeArgs;
  if (preview) { console.log(JSON.stringify({ command: "agy", args: argv.map(publicArg), mode: "tui", permission: "unmanaged", mcp: ".agents/plugins/agent-hub/", writes: false })); return; }
  const version = spawnSync("agy", ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 4096, env: peerChildEnv("agy") });
  const gate = agyVersionGate(version.status === 0 ? version.stdout : "");
  if (!gate.ok) fail(gate.message);
  if (gate.message) console.error(gate.message);
  const hub = await connect();
  let options: AgyMcpOptions | undefined;
  let pluginWritten = false;
  try {
    if (!hub.features.includes("native_hook_launch")) fail("running hub lacks the verified native hook launcher; upgrade or restart it before launching agy");
    const status = (await hub.request({ t: "status" })).status;
    if (rosterInStatus(status, "agy") !== true) fail("agy is off roster; add it with ahub roster add agy");
    const admitted = await hub.request({ t: "native_hook_launch", op: "begin", peer: "agy" });
    if (!admitted.ok || typeof admitted.launchId !== "string" || typeof admitted.instanceId !== "string") fail(admitted.error ?? "native hook launch was not admitted");
    options = { projectRoot: cwd, stateDir, serverJs: bundleInStatus(status) ?? resolve(cliDir, "../../plugins/agent-hub/server.js"),
      hookScript: resolve(cliDir, "facts-hook.ts"), peer: "agy", launchId: admitted.launchId, instanceId: admitted.instanceId };
    const written = ensureAgyMcp(options);
    pluginWritten = written.changed;
    if (written.tracked) console.error("The managed agy plugin is tracked; review its local machine paths before committing");
    console.error(AGY_LAUNCH_NOTICE);
    const env: NodeJS.ProcessEnv = { ...ctx.helpers.nativeLaunchEnv("agy", ctx.helpers.childEnv()), AGENTHUB_STATE_DIR: stateDir, AGENTHUB_PROJECT_DIR: cwd };
    delete env.AGENTHUB_CHANNEL;
    const code = await runAgyTui(argv, cwd, env);
    if (code !== 0) process.exitCode = code;
  } finally {
    if (options) {
      // Revoke launcher authority before cleanup; stale cleanup never removes a newer managed launch.
      await hub.request({ t: "native_hook_launch", op: "end", peer: "agy", launchId: options.launchId }).catch(() => {});
      if (pluginWritten) try { cleanupAgyMcp(options); } catch { console.error("Managed agy plugin cleanup refused: files changed or ownership could not be verified"); }
    }
    hub.close();
  }
}
