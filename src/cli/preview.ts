import { definitionOf, builtinPreviewOf } from "../adapters/registry.ts";
import { loadConfig } from "../hub/daemon.ts";
import { childEnv } from "../hub/child-process.ts";
import { startModeOf } from "../hub/start-mode.ts";
import { instanceLaunchArguments, buildLaunch, buildKimiLaunch, buildKimiTuiLaunch, nativeLaunchEnv, claudeObservationHooks } from "./launch.ts";
import { kimiMcpPlan } from "./kimi-mcp.ts";
import { jcodeCommand, jcodeTuiCommand } from "../adapters/jcode.ts";
import { qwenSessionId } from "../hub/crash.ts";
import { relayModelIds } from "../models/relay.ts";
import { buildPiLaunch } from "../pi/launch.ts";

/** Read-only builtin preview. Native redaction uses the same launch builders as actual startup. */
export function launcherPreview(tool: "claude" | "codex" | "kimi" | "pi" | "qwen" | "jcode", raw: string[], cwd: string, stateDir: string, unattended: boolean, requestedInstance?: string) {
  const config = loadConfig(cwd);
  const selected = instanceLaunchArguments(tool, requestedInstance ? ["--as", requestedInstance, ...raw] : raw, config.instances);
  const args = selected.args.filter(arg => !["--print-command", "--dry-run", "--json"].includes(arg));
  const definition = definitionOf(tool), preview = builtinPreviewOf(tool);
  if (!definition || !preview) throw new Error("native preview definition unavailable");
  if (selected.instance && definition.start.explicitHeadlessMode) {
    const mode = args.indexOf("--mode");
    if (mode >= 0 && args[mode + 1] !== "headless") throw new Error("extra instances require headless mode");
    if (mode < 0 && !args.includes("--headless")) args.push("--mode", "headless");
  }
  const result = preview({ tool, args, cwd, stateDir, cliDir: import.meta.dir, unattended, config, definition,
    baseEnvNames: Object.keys(childEnv()).concat(["AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR"]),
    helpers: { buildLaunch: (native, argv, ctx) => buildLaunch(native, argv, { ...ctx, ...(selected.instance ? { instance: selected.instance } : {}) }), claudeObservationHooks, buildKimiLaunch, buildKimiTuiLaunch, nativeLaunchEnv, childEnv,
      startModeOf, kimiMcpPlan, jcodeCommand, jcodeTuiCommand, qwenSessionId, relayModelIds, buildPiLaunch },
  });
  if (!selected.instance) return result;
  return { ...result, instance: selected.instance,
    ...(result.mcp ? { mcp: { ...result.mcp, action: "session-scoped MCP identity; shared project file unchanged", changed: false } } : {}),
    unresolved: [...result.unresolved, { field: "executionCwd", reason: "verified by the daemon at instance start; preview does not start or authorize a worktree" }],
  };
}
