import { publicArg } from "../definitions/native-cli-preview-common.ts";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { NativeCliEntryContext } from "../definitions/native-cli-entry-types.ts";
import { bundleInStatus, rosterInStatus } from "../../hub/status-roster.ts";
import { ensureAgyMcp, cleanupAgyMcp, type AgyMcpOptions } from "../../cli/agy-mcp.ts";
import { peerChildEnv, stopOwnedProcess, trackGroup } from "../../hub/child-process.ts";

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
  if (version.status !== 0 || version.stdout.trim() !== "1.4.2") fail("agy P1 requires the verified Antigravity CLI 1.4.2");
  const hub = await connect();
  let options: AgyMcpOptions | undefined;
  try {
    if (!hub.features.includes("native_hook_launch")) fail("running hub lacks the verified native hook launcher; upgrade or restart it before launching agy");
    const status = (await hub.request({ t: "status" })).status;
    if (rosterInStatus(status, "agy") !== true) fail("agy is off roster; add it with ahub roster add agy");
    const admitted = await hub.request({ t: "native_hook_launch", op: "begin", peer: "agy" });
    if (!admitted.ok || typeof admitted.launchId !== "string" || typeof admitted.instanceId !== "string") fail(admitted.error ?? "native hook launch was not admitted");
    options = { projectRoot: cwd, stateDir, serverJs: bundleInStatus(status) ?? resolve(cliDir, "../../plugins/agent-hub/server.js"),
      hookScript: resolve(cliDir, "facts-hook.ts"), peer: "agy", launchId: admitted.launchId, instanceId: admitted.instanceId };
    const written = ensureAgyMcp(options);
    if (written.tracked) console.error("The managed agy plugin is tracked; review its local machine paths before committing");
    console.error("Antigravity: pull-only TUI; native permissions unmanaged, no hub sandbox");
    const env: NodeJS.ProcessEnv = { ...ctx.helpers.nativeLaunchEnv("agy", ctx.helpers.childEnv()), AGENTHUB_STATE_DIR: stateDir, AGENTHUB_PROJECT_DIR: cwd };
    delete env.AGENTHUB_CHANNEL;
    const code = await new Promise<number>((resolveExit, reject) => {
      const child = spawn("agy", argv, { cwd, env, stdio: "inherit", detached: true });
      child.once("spawn", () => trackGroup(child));
      const interrupt = () => { void stopOwnedProcess(child, { group: true }).catch(reject); };
      process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt); process.on("SIGHUP", interrupt);
      child.once("error", error => { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); process.off("SIGHUP", interrupt); reject(error); });
      child.once("close", code => {
        process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); process.off("SIGHUP", interrupt);
        void stopOwnedProcess(child, { group: true }).then(() => resolveExit(code ?? 1), reject);
      });
    });
    if (code) process.exitCode = code;
  } finally {
    if (options) {
      // Revoke launcher authority before cleanup; stale cleanup never removes a newer managed launch.
      await hub.request({ t: "native_hook_launch", op: "end", peer: "agy", launchId: options.launchId }).catch(() => {});
      try { cleanupAgyMcp(options); } catch { console.error("Managed agy plugin cleanup refused: files changed or ownership could not be verified"); }
    }
    hub.close();
  }
}
