import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Launch } from "../../cli/launch.ts";
import { REDACTED, publicArg, previewState, finishPreview, type NativePreviewContext } from "./native-cli-preview-common.ts";

export function previewClaude(ctx: NativePreviewContext) {
  const { args, cwd, stateDir, cliDir, unattended, config } = ctx;
  const { buildLaunch, claudeObservationHooks } = ctx.helpers;
  const state = previewState(args, ctx.baseEnvNames), { unresolved } = state;
  let envNames = state.envNames;
  let launch: Launch;
  let original: { command?: string; refreshInterval?: number; padding?: number } | undefined;
  for (const file of [join(cwd, ".claude/settings.local.json"), join(cwd, ".claude/settings.json"), join(process.env.HOME ?? "", ".claude/settings.json")]) {
    try { original ??= JSON.parse(readFileSync(file, "utf8")).statusLine; } catch { /* optional */ }
  }
  // Build with original inputs so channel selection and owned-flag validation match normal launch.
  const facts = claudeObservationHooks(config, { script: join(cliDir, "facts-hook.ts"), stateDir });
  launch = buildLaunch("claude", args, { preview: true, unattended, statusLine: { script: join(cliDir, "statusline-tee.ts"), stateDir, ...(original ? { original: { command: original.command ? REDACTED : "", ...(typeof original.refreshInterval === "number" && Number.isFinite(original.refreshInterval) ? { refreshInterval: original.refreshInterval } : {}), ...(typeof original.padding === "number" && Number.isFinite(original.padding) ? { padding: original.padding } : {}) } } : {}) }, ...(facts ? { facts } : {}) });
  // Merged caller settings change the native argument count. Rebuild a redacted preview,
  // retaining the managed hooks but never serializing caller settings or their file path.
  const safeArgs = args.map((arg, i) => {
    if (args[i - 1] === "--settings") return "{}";
    if (arg.startsWith("--settings=")) return "--settings={}";
    if (["--unattended", "--safe", "--new"].includes(arg)) return arg;
    return publicArg(arg);
  });
  const publicLaunch = buildLaunch("claude", safeArgs, { preview: true, unattended, statusLine: { script: join(cliDir, "statusline-tee.ts"), stateDir,
    ...(original ? { original: { command: original.command ? REDACTED : "", ...(typeof original.refreshInterval === "number" && Number.isFinite(original.refreshInterval) ? { refreshInterval: original.refreshInterval } : {}), ...(typeof original.padding === "number" && Number.isFinite(original.padding) ? { padding: original.padding } : {}) } } : {}) }, facts });
  publicLaunch.args.splice(0, 2, ...launch.args.slice(0, 2)); // channel selection was verified against the original MCP config
  launch = publicLaunch;

  envNames.push("AGENTHUB_CHANNEL");
  envNames.push("AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID");
  unresolved.push({ field: "env.AGENTHUB_INSTANCE_ID", reason: "injected when an existing daemon instance is read at launch; preview does not read runtime state" });
  unresolved.push({ field: "env.AGENTHUB_LAUNCH_ID", reason: "allocated only for a verified Orca terminal launch; preview does not query Orca, allocate identity or write launch records" });
  return finishPreview(ctx, launch, envNames, unresolved, undefined, launch.args.includes("--settings") ? launch.args[launch.args.indexOf("--settings") + 1] : undefined);
}
