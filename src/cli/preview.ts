import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../hub/daemon.ts";
import { childEnv } from "../hub/child-process.ts";
import { relayModelIds } from "../models/relay.ts";
import { buildPiLaunch } from "../pi/launch.ts";
import { startModeOf } from "../hub/start-mode.ts";
import { buildLaunch, buildKimiLaunch, claudeObservationHooks, type Launch } from "./launch.ts";

const REDACTED = "[redacted]";
const UNRESOLVED = "[unresolved]";
/** Arbitrary native arguments can contain secrets even without a credential-looking key. */
function publicArg(arg: string): string {
  const flags = new Set(["--settings", "--model", "--mcp-config", "--session-id", "--session-file", "--resume", "--continue", "--print", "--safe", "--new"]);
  const key = arg.split("=", 1)[0]!;
  return flags.has(key) ? (arg.includes("=") ? key + "=" + REDACTED : key) : REDACTED;
}
function nativeCommand(command: string[], trusted: string[]): string[] {
  return command.map((value, i) => value === trusted[i] ? value : REDACTED);
}
/** Read-only preview. Inputs passed to shared native builders are redacted before serialization. */
export function launcherPreview(tool: "claude" | "codex" | "kimi" | "pi", raw: string[], cwd: string, stateDir: string, unattended: boolean) {
  const args = raw.filter(arg => !["--print-command", "--dry-run", "--json"].includes(arg));
  const config = loadConfig(cwd);
  const unresolved: { field: string; reason: string }[] = [];
  let launch: Launch;
  let envNames = Object.keys(childEnv()).concat(["AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR"]);
  const value = (flag: string) => {
    const at = args.indexOf(flag);
    if (at < 0) return undefined;
    const next = args[at + 1];
    if (!next || next.startsWith("--")) throw new Error("missing option value");
    return next;
  };
  if (tool === "claude") {
    let original: { command?: string; refreshInterval?: number; padding?: number } | undefined;
    for (const file of [join(cwd, ".claude/settings.local.json"), join(cwd, ".claude/settings.json"), join(process.env.HOME ?? "", ".claude/settings.json")]) {
      try { original ??= JSON.parse(readFileSync(file, "utf8")).statusLine; } catch { /* optional */ }
    }
    // Build with original inputs so channel selection and owned-flag validation match normal launch.
    const facts = claudeObservationHooks(config, { script: join(import.meta.dir, "facts-hook.ts"), stateDir });
    launch = buildLaunch(tool, args, { preview: true, unattended, statusLine: { script: join(import.meta.dir, "statusline-tee.ts"), stateDir, ...(original ? { original: { command: original.command ? REDACTED : "", ...(typeof original.refreshInterval === "number" && Number.isFinite(original.refreshInterval) ? { refreshInterval: original.refreshInterval } : {}), ...(typeof original.padding === "number" && Number.isFinite(original.padding) ? { padding: original.padding } : {}) } } : {}) }, ...(facts ? { facts } : {}) });
    // Merged caller settings change the native argument count. Rebuild a redacted preview,
    // retaining the managed hooks but never serializing caller settings or their file path.
    const safeArgs = args.map((arg, i) => {
      if (args[i - 1] === "--settings") return "{}";
      if (arg.startsWith("--settings=")) return "--settings={}";
      if (["--unattended", "--safe", "--new"].includes(arg)) return arg;
      return publicArg(arg);
    });
    const publicLaunch = buildLaunch(tool, safeArgs, { preview: true, unattended, statusLine: { script: join(import.meta.dir, "statusline-tee.ts"), stateDir,
      ...(original ? { original: { command: original.command ? REDACTED : "", ...(typeof original.refreshInterval === "number" && Number.isFinite(original.refreshInterval) ? { refreshInterval: original.refreshInterval } : {}), ...(typeof original.padding === "number" && Number.isFinite(original.padding) ? { padding: original.padding } : {}) } } : {}) }, facts });
    publicLaunch.args.splice(0, 2, ...launch.args.slice(0, 2)); // channel selection was verified against the original MCP config
    launch = publicLaunch;
  } else if (tool === "codex") {
    // A fresh native proxy is assigned by start, never guessed from an old status file.
    launch = buildLaunch(tool, args, { unattended, proxyUrl: UNRESOLVED, codexBin: config.codex_bin === "codex" ? "codex" : REDACTED });
    const passthrough = args.filter(arg => !["--unattended", "--safe", "--new"].includes(arg));
    launch.args = launch.args.slice(0, launch.args.length - passthrough.length).concat(passthrough.map(publicArg));
    unresolved.push({ field: "proxyUrl", reason: "assigned when the native adapter starts; preview does not start it" });
  } else if (tool === "kimi") {
    const model = value("--model");
    launch = buildKimiLaunch(nativeCommand(config.kimi_cmd, ["kimi", "acp"]), model ? REDACTED : undefined);
    unresolved.push({ field: "sessionId", reason: "ACP session identity is available only after native initialization" });
  } else {
    const mode = value("--mode") ?? startModeOf(config.peers, "pi"); // #269: the same default `ahub pi` takes
    const backend = value("--backend") ?? config.pi.backend;
    if (!["headless", "tui"].includes(mode) || !["auto", "dgx", "mlx"].includes(backend) || (value("--session-id") && value("--session-file"))) throw new Error("invalid Pi options");
    for (let i = 0; i < args.length; i += 2) if (!["--mode", "--backend", "--model", "--session-id", "--session-file"].includes(args[i]!)) throw new Error("unknown Pi option");
    const models = relayModelIds({ enableHubAuto: true, mlx: config.mlx.enabled === false ? undefined : config.mlx, mlxAlias: "mlx/fast", allowedDGXmodels: { "dgx/coding": config.pi.dgx_coding, "dgx/fast": config.pi.dgx_fast } });
    const pi = buildPiLaunch({
      stateDir, cmd: nativeCommand(config.pi.cmd, ["pi"]), mode: mode as "headless" | "tui", backend: backend as "auto" | "dgx" | "mlx",
      ...(value("--model") ? { model: REDACTED } : {}),
      ...(value("--session-id") ? { sessionId: REDACTED } : {}),
      ...(value("--session-file") ? { sessionFile: REDACTED } : {}),
      relay: { url: UNRESOLVED, token: UNRESOLVED, models: models.map(id => ({ id })) },
      tools: [], preamble: REDACTED, maxSteps: config.pi.max_steps,
    }, {}, resolve(join(import.meta.dir, "../pi/extension.ts")), UNRESOLVED, UNRESOLVED);
    launch = pi;
    envNames = Object.keys(pi.env).concat(["PATH", "HOME", "USER", "SHELL", "TMPDIR", "TERM", "TERM_PROGRAM", "LANG", "LC_ALL", "LC_CTYPE", "NO_COLOR", "CODEX_HOME"].filter(key => process.env[key] !== undefined));
    if (mode === "tui") envNames.push("AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR");
    unresolved.push({ field: "bridge/relay endpoints and owner credentials", reason: "assigned at runtime; preview does not bind a server or start a model" });
    if (!value("--session-id") && !value("--session-file")) unresolved.push({ field: "sessionId", reason: "new native session identity is not allocated by preview" });
  }
  if (tool === "claude") envNames.push("AGENTHUB_CHANNEL");
  if (tool === "claude" || tool === "codex") {
    envNames.push("AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID");
    unresolved.push({ field: "env.AGENTHUB_INSTANCE_ID", reason: tool === "claude" ? "injected when an existing daemon instance is read at launch; preview does not read runtime state" : "injected when a verified Orca terminal launch is recorded against the daemon; preview does not record it" });
    unresolved.push({ field: "env.AGENTHUB_LAUNCH_ID", reason: "allocated only for a verified Orca terminal launch; preview does not query Orca, allocate identity or write launch records" });
  }
  return { tool, cmd: launch.cmd, args: launch.args, settings: tool === "claude" && launch.args.includes("--settings") ? launch.args[launch.args.indexOf("--settings") + 1] : undefined, envNames: [...new Set(envNames)].sort(), ...(launch.warning ? { warning: launch.warning } : {}), unresolved, redaction: "Arbitrary user arguments, settings, commands and configured executable overrides are redacted. Environment values are never displayed.", needs: ["Native executable, accounts and runtime readiness are not checked."] };
}
