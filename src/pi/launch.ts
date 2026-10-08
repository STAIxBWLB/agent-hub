import { join } from "node:path";
import { peerChildEnv } from "../hub/child-process.ts";
import type { PiOptions, PiModelDescriptor, PiTuiLaunch } from "../adapters/pi.ts";

const modelFor = (backend: PiOptions["backend"], models: PiModelDescriptor[]): string => {
  const ids = models.map((m) => m.id);
  const find = (needle: string) => ids.find((id) => id === needle) ?? needle;
  if (backend === "mlx") return find("mlx/fast");
  if (backend === "dgx") return find("dgx/coding");
  if (ids.includes("hub/auto")) return "hub/auto";
  return find(ids.find((id) => id === "dgx/coding") ? "dgx/coding" : ids.find((id) => id === "mlx/fast") ?? "dgx/coding");
};

/** Pure native launch; bridge/relay setup and session validation remain with the adapter. */
export function buildPiLaunch(opts: Pick<PiOptions, "stateDir" | "cmd" | "mode" | "backend" | "model" | "relay" | "tools" | "preamble" | "maxSteps" | "sessionFile" | "sessionId">, inherited: NodeJS.ProcessEnv, extension: string, bridgePort: number | string, bridgeToken: string): PiTuiLaunch {
  const env: NodeJS.ProcessEnv = { ...peerChildEnv("pi", inherited), PI_CODING_AGENT_DIR: join(opts.stateDir, "pi"), AGENTHUB_PI_BRIDGE_URL: `http://127.0.0.1:${bridgePort}`, AGENTHUB_PI_BRIDGE_TOKEN: bridgeToken, AGENTHUB_PI_OWNER_TOKEN: bridgeToken, AGENTHUB_PI_RELAY_URL: opts.relay.url, AGENTHUB_PI_RELAY_TOKEN: opts.relay.token, AGENTHUB_PI_MODELS: JSON.stringify(opts.relay.models), AGENTHUB_PI_TOOLS: JSON.stringify(opts.tools), AGENTHUB_PI_MAX_STEPS: String(opts.maxSteps ?? 30) };
  const args = [ ...(opts.mode === "headless" ? ["--mode", "rpc"] : []), "--provider", "agent-hub-local", "--model", opts.model ?? modelFor(opts.backend, opts.relay.models), "--models", opts.relay.models.map((model) => `agent-hub-local/${model.id}`).join(","), "--no-builtin-tools", "--no-skills", "--no-prompt-templates", "--no-extensions", "--extension", extension, ...(opts.preamble ? ["--append-system-prompt", opts.preamble] : []), "--session-dir", join(opts.stateDir, "pi-sessions")];
  if (opts.sessionFile) args.push("--session", opts.sessionFile); else if (opts.sessionId) args.push("--session-id", opts.sessionId);
  const command = opts.cmd ?? ["pi"];
  return { cmd: command[0]!, args: [...command.slice(1), ...args], env };
}
