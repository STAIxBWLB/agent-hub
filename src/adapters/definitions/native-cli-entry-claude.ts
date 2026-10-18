import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ClaudeLaunchRecord } from "../../cli/launch.ts";
import type { NativeCliEntryContext } from "./native-cli-entry-types.ts";
import { claudeStateFile } from "../../hub/claude-state.ts";

export async function runClaudeEntry(ctx: NativeCliEntryContext): Promise<void> {
  const { args, cwd, stateDir, cliDir, unattendedEnv, projectConfig, fail } = ctx;
  // #450 I3: a claude-<name> instance keeps its own identity, launch and recovery records; it never owns a worktree.
  const peer = ctx.instance ?? "claude";
  if (ctx.hubStarted) {
    // #223: the hub starts a headless reviewer and runs one `claude -p` per review; nothing runs in this terminal.
    if (args.includes("--print-command") || args.includes("--dry-run")) return console.log(JSON.stringify({ peer, start: "hub", note: "a headless reviewer the hub runs per review" }, null, 2));
    const hub = await ctx.connect();
    try {
      const res = await hub.request({ t: "start", peer, operationId: process.env.AGENTHUB_RECOVERY_OPERATION });
      if (res.ok !== true) fail(String(res.error ?? `${peer} was not started`));
    } finally { hub.close(); }
    return console.log(`${peer} started: a headless reviewer the hub runs per review (stop it with ahub stop ${peer})`);
  }
  const { launcherPreview, readControl, recordTerminalLaunch, claudeObservationHooks, buildLaunch, runClaudeLaunch, processSignature, recordClaudeLaunch, cleanupStaleClaudeSettings, nativeLaunchEnv, childEnv, cleanupClaudeSettings } = ctx.helpers;
  if (args.includes("--print-command") || args.includes("--dry-run")) {
    try { return console.log(JSON.stringify(launcherPreview("claude", args, cwd, stateDir, unattendedEnv), null, 2)); }
    catch { fail("cannot preview launch: invalid arguments or configuration (details withheld to protect credentials)"); }
  }
  const control = readControl(stateDir);
  if (control?.instanceId) {
    process.env.AGENTHUB_INSTANCE_ID = control.instanceId;
    const terminal = await recordTerminalLaunch(peer, cwd, stateDir, control.instanceId, ctx.instance ? { executionCwd: cwd } : undefined);
    if (!terminal) process.env.AGENTHUB_LAUNCH_ID = randomUUID();
  }
  // `--settings` outranks project and user settings, so the tee has to wrap whichever status line would have won:
  // project local, then project, then user.
  let original: { command?: string; refreshInterval?: number; padding?: number } | undefined;
  for (const file of [join(cwd, ".claude", "settings.local.json"), join(cwd, ".claude", "settings.json"), join(process.env.HOME ?? "", ".claude", "settings.json")]) {
    try {
      original ??= JSON.parse(readFileSync(file, "utf8")).statusLine;
    } catch {
      // no such file, or no status line in it
    }
  }
  // Turn-free facts and opted-in task sweeps share native PreToolUse/PostToolUse/Stop observations.
  const facts = claudeObservationHooks(projectConfig(), { script: join(cliDir, "facts-hook.ts"), stateDir });
  let previousLaunch: unknown;
  try { previousLaunch = JSON.parse(readFileSync(join(stateDir, claudeStateFile("claude-launch", peer)), "utf8")); } catch { /* no previous managed launch */ }
  const launch = buildLaunch("claude", args, { unattended: unattendedEnv, statusLine: { script: join(cliDir, "statusline-tee.ts"), stateDir, ...(original ? { original } : {}) }, ...(facts ? { facts } : {}) });
  let result: Awaited<ReturnType<typeof runClaudeLaunch>>;
  try {
    let launchRecord: ClaudeLaunchRecord | undefined;
    if (control?.instanceId) {
      // Publish only the final launch's installed hook and effective permission flags.
      launchRecord = { ...(ctx.instance ? { peer } : {}), instanceId: control.instanceId, launchId: process.env.AGENTHUB_LAUNCH_ID!, permissionHook: launch.permissionHook === true, hookPurpose: launch.hookPurpose, settingsFile: launch.settingsFile, launcherPid: process.pid, launcherSignature: processSignature(process.pid), unattended: launch.unattended === true };
      recordClaudeLaunch(stateDir, launchRecord);
      cleanupStaleClaudeSettings(stateDir, previousLaunch);
    }
    if (launch.warning) console.error(launch.warning);
    const env = nativeLaunchEnv("claude", childEnv());
    if (ctx.instance) env.AGENTHUB_PEER_ID = peer; // the channel plugin and the statusline tee write for this instance
    result = await runClaudeLaunch(launch, { cwd, stateDir, env: { ...env, AGENTHUB_STATE_DIR: stateDir, AGENTHUB_PROJECT_DIR: cwd }, ...(launchRecord ? { record: launchRecord } : {}) });
  } finally {
    cleanupClaudeSettings(stateDir, launch.settingsFile);
  }
  if (result.error) fail(`cannot run ${launch.cmd}: ${result.error.message}`);
  process.exit(result.status ?? 1);
}
