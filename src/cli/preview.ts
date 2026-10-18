import { definitionOf, builtinPreviewOf } from "../adapters/registry.ts";
import { loadConfig } from "../hub/daemon.ts";
import { childEnv } from "../hub/child-process.ts";
import { startModeOf } from "../hub/start-mode.ts";
import { buildLaunch, buildKimiLaunch, buildKimiTuiLaunch, nativeLaunchEnv, claudeObservationHooks } from "./launch.ts";
import { kimiMcpPlan } from "./kimi-mcp.ts";
import { jcodeCommand } from "../adapters/jcode.ts";
import { qwenSessionId } from "../hub/crash.ts";
import { relayModelIds } from "../models/relay.ts";
import { buildPiLaunch } from "../pi/launch.ts";

/** Read-only builtin preview. Native redaction uses the same launch builders as actual startup. */
export function launcherPreview(tool: "claude" | "codex" | "kimi" | "pi" | "qwen" | "jcode", raw: string[], cwd: string, stateDir: string, unattended: boolean) {
  const args = raw.filter(arg => !["--print-command", "--dry-run", "--json"].includes(arg));
  const config = loadConfig(cwd);
  const definition = definitionOf(tool), preview = builtinPreviewOf(tool);
  if (!definition || !preview) throw new Error("native preview definition unavailable");
  return preview({ tool, args, cwd, stateDir, cliDir: import.meta.dir, unattended, config, definition,
    baseEnvNames: Object.keys(childEnv()).concat(["AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR"]),
    helpers: { buildLaunch, claudeObservationHooks, buildKimiLaunch, buildKimiTuiLaunch, nativeLaunchEnv, childEnv,
      startModeOf, kimiMcpPlan, jcodeCommand, qwenSessionId, relayModelIds, buildPiLaunch },
  });
}
