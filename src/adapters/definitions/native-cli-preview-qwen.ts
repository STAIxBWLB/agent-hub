import { describe } from "../compat.ts";
import { join } from "node:path";
import type { Launch } from "../../cli/launch.ts";
import { REDACTED, UNRESOLVED, nativeCommand, previewState, finishPreview, type NativePreviewContext } from "./native-cli-preview-common.ts";

export function previewQwen(ctx: NativePreviewContext) {
  const { tool, args, cwd, stateDir, cliDir, config } = ctx;
  const state = previewState(args, ctx.baseEnvNames), { unresolved, value } = state;
  let envNames = state.envNames;
  let launch: Launch;
  const mode = value("--mode") ?? "headless", model = value("--model");
  const adapter = ctx.definition;
  if (!["headless", "tui"].includes(mode)) throw new Error("unknown Qwen mode");
  for (let i = 0; i < args.length; i += 2) if (!["--model", "--mode", "--session-id"].includes(args[i]!) || !args[i + 1]) throw new Error("unknown Qwen option");
  const sessionId = value("--session-id");
  if (sessionId !== undefined && !adapter.session.crashIdentity?.({ sessionId }).sessionId) throw new Error("invalid Qwen session identity");
  if (sessionId) unresolved.push({ field: "sessionId", reason: "requested through ACP session/load at start; preview does not load or expose it" });
  if (mode === "tui") {
    // The TUI's argv is built by the daemon from the files it prepares; the preview names the shape and the compat entry, never a path or the MCP config contents.
    const [bin = "qwen", ...prefix] = nativeCommand(config.qwen_cmd, ["qwen"]).filter(word => word !== "--acp");
    launch = { cmd: bin, args: [...prefix, "--input-file", "<state dir>/qwen/qwen-dual/input.jsonl", "--json-file", "<state dir>/qwen/qwen-dual/events.jsonl", "--mcp-config", "<state dir>/qwen/qwen-dual/mcp.json", "--approval-mode", "default", ...(model ? ["--model", REDACTED] : []), ...(sessionId ? ["-r", REDACTED] : [])] };
    unresolved.push({ field: "files", reason: "the daemon prepares the input and event files (0600) when the start is admitted; preview creates nothing" });
    unresolved.push({ field: "nativeIdentity", reason: `Qwen Code (${describe("qwen-dual")}) is checked before the start and again from its session_start event; preview starts nothing` });
    return finishPreview(ctx, launch, envNames, unresolved, undefined);
  }
  launch = adapter.start.launch!({ instance: tool, form: "headless", projectRoot: cwd, stateDir, entrypoint: join(cliDir, "main.js"),
    userArgs: [], unattended: false, env: {}, preview: true, nativeCommand: nativeCommand(config.qwen_cmd, ["qwen", "--acp"]), model: model ? REDACTED : undefined });
  unresolved.push({ field: "nativeIdentity", reason: `Qwen Code (${describe("qwen")}) identity and permission modes are checked at ACP initialization; preview starts nothing` });

  return finishPreview(ctx, launch, envNames, unresolved, undefined);
}
