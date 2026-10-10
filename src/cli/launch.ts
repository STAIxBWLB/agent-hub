// Launchers inject only the flags the hub owns and refuse user-supplied duplicates.
import { mkdirSync, writeFileSync, renameSync, unlinkSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { peerChildEnv } from "../hub/child-process.ts";
export const CLAUDE_CHANNEL = "plugin:agent-hub@agent-hub";

/** Launch identity belongs to the native child, never to the agent that invoked the wrapper. */
export function nativeLaunchEnv(tool: "claude" | "codex" | "pi", source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = peerChildEnv(tool, source);
  delete env.AGENTHUB_UNATTENDED;
  // Channel evidence for the plugin (issue #205): set beside the development-channel flag `buildLaunch` always passes.
  if (tool === "claude") env.AGENTHUB_CHANNEL = "1";
  return env;
}

/** A scoped candidate MCP server can be selected without promoting the installed plugin. */
function claudeChannel(userArgs: string[]): string {
  const bundle = resolve(import.meta.dir, "../../plugins/agent-hub/server.js");
  for (let i = 0; i < userArgs.length; i++) {
    const arg = userArgs[i]!;
    const path = arg === "--mcp-config" ? userArgs[i + 1] : arg.startsWith("--mcp-config=") ? arg.slice("--mcp-config=".length) : undefined;
    if (!path) continue;
    try {
      const server = JSON.parse(readFileSync(resolve(path), "utf8")).mcpServers?.["agent-hub"];
      if (server?.command === "bun" && Array.isArray(server.args) && server.args.some((value: unknown) => typeof value === "string" && resolve(value) === bundle)) return "server:agent-hub";
    } catch { /* The native CLI reports invalid user-supplied MCP configuration. */ }
  }
  return CLAUDE_CHANNEL;
}

const OWNED: Record<"claude" | "codex", string[]> = {
  claude: ["--dangerously-load-development-channels", "--dangerously-skip-permissions"],
  codex: ["--remote", "--yolo", "--dangerously-bypass-approvals-and-sandbox"],
};

export const UNATTENDED_WARNING =
  "WARNING: --unattended disables permission prompts. Other agents' messages are untrusted input and this agent will act on its own judgment without asking you.";

export interface Launch {
  cmd: string;
  args: string[];
  warning?: string;
  permissionHook?: boolean;
  hookPurpose?: FactsHook["purpose"];
  unattended?: boolean;
}

export interface StatusLineTee {
  /** absolute path of src/cli/statusline-tee.ts */
  script: string;
  stateDir: string;
  /** the user's own statusLine setting, wrapped so the status line looks the same */
  original?: { command?: string; refreshInterval?: number; padding?: number };
}

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Settings for one session that put the tee in front of the user's status line command. Claude Code's status line
 * input carries `rate_limits`; this is the hub's Claude quota source. `~/.claude/settings.json` is never edited.
 */
export function statusLineSettings(tee: StatusLineTee): string {
  const command = `AGENTHUB_STATE_DIR=${sh(tee.stateDir)} AGENTHUB_STATUSLINE_CMD=${sh(tee.original?.command ?? "")} bun ${sh(tee.script)}`;
  return JSON.stringify({ statusLine: { type: "command", command, refreshInterval: tee.original?.refreshInterval ?? 10, ...(tee.original?.padding !== undefined ? { padding: tee.original.padding } : {}) } });
}

/** Shared facts, native observation and permission hook transport. */
export interface FactsHook {
  script: string;
  stateDir: string;
  /** The same hook transport can observe native turns without injecting facts. */
  purpose?: "facts" | "idle" | "facts-and-idle" | "permission";
  /** Observe native sessions/turns for every enabled facts, idle or conductor hook configuration. */
  observeNative?: boolean;
}

/** Shared by actual launch and preview; permissions are always enabled, advisory facts remain disabled. */
export function claudeObservationHooks(config: { coordination?: string; task_sweep?: { enabled: boolean }; roles?: Record<string, string[]> }, paths: Pick<FactsHook, "script" | "stateDir">): FactsHook {
  const facts = config.coordination === "turn-free";
  const idle = config.task_sweep?.enabled === true;
  const observeNative = facts || idle || config.roles?.claude?.includes("conductor") === true;
  return { ...paths, purpose: facts ? (idle ? "facts-and-idle" : "facts") : idle || observeNative ? "idle" : "permission", ...(observeNative ? { observeNative: true } : {}) };
}

/**
 * The one `--settings` value of a hub-launched Claude session: the status line tee, and in a turn-free project the
 * facts hook before and after every tool call and at the end of each turn (issue #108; the turn end is the quiescence
 * evidence of issue #107).
 */
export function sessionSettings(tee?: StatusLineTee, facts?: FactsHook): string {
  const settings = (tee ? JSON.parse(statusLineSettings(tee)) : {}) as Record<string, unknown>;
  if (facts) {
    const hooks = [{ type: "command", command: `AGENTHUB_STATE_DIR=${sh(facts.stateDir)} AGENTHUB_HOOK_PURPOSE=${sh(facts.purpose ?? "facts")} bun ${sh(facts.script)}`, timeout: 5 }];
    settings.hooks = { PreToolUse: [{ matcher: "*", hooks }], ...(facts.purpose !== "permission" ? { PostToolUse: [{ matcher: "*", hooks }], Stop: [{ hooks }] } : {}) };
    if (facts.observeNative) Object.assign(settings.hooks as object, { SessionStart: [{ matcher: "*", hooks }], UserPromptSubmit: [{ hooks }] });
  }
  return JSON.stringify(settings);
}

export function buildLaunch(
  tool: "claude" | "codex",
  userArgs: string[],
  ctx: { unattended: boolean; proxyUrl?: string; codexBin?: string; statusLine?: StatusLineTee; facts?: FactsHook; preview?: boolean },
): Launch {
  // Hub-level switches are consumed here; everything else passes through to the tool.
  const passthrough = userArgs.filter((a) => !["--unattended", "--safe", "--new"].includes(a));
  const dup = passthrough.find((a) => OWNED[tool].some((flag) => a === flag || a.startsWith(`${flag}=`)));
  if (dup) throw new Error(`${dup} is managed by the hub; use "hub ${tool} --unattended" or drop the flag`);

  const unattended = ctx.unattended || userArgs.includes("--unattended");
  const warning = unattended ? { warning: UNATTENDED_WARNING } : {};
  if (tool === "claude") {
    // `--settings` takes one value, so a user-supplied one wins and Claude has no quota source for that session.
    const own = passthrough.some((a) => a === "--settings" || a.startsWith("--settings="));
    let settingsArgs = ctx.statusLine && !own ? ["--settings", sessionSettings(ctx.statusLine, ctx.facts)] : [];
    let nativeArgs = passthrough;
    if (own) {
      if (passthrough.filter(a => a === "--settings" || a.startsWith("--settings=")).length > 1) throw new Error("pass --settings only once so the hub permission hook stays installed");
      const index = passthrough.findIndex(a => a === "--settings" || a.startsWith("--settings="));
      const arg = passthrough[index]!;
      const value = arg === "--settings" ? passthrough[index + 1] : arg.slice("--settings=".length);
      if (!value) throw new Error("--settings requires a JSON object or readable file so the hub permission hook can be installed");
      let caller: Record<string, unknown>;
      try {
        caller = JSON.parse(value.trim().startsWith("{") ? value : readFileSync(resolve(value), "utf8"));
        if (!caller || typeof caller !== "object" || Array.isArray(caller)) throw new Error("not an object");
      } catch { throw new Error("cannot read --settings as a JSON object; the hub permission hook must be installed"); }
      if (ctx.facts && caller.disableAllHooks === true) throw new Error("--settings disableAllHooks prevents the required hub permission hook; enable hooks to launch");
      const injected = JSON.parse(sessionSettings(undefined, ctx.facts));
      const callerHooks = caller.hooks;
      if (callerHooks !== undefined && (!callerHooks || typeof callerHooks !== "object" || Array.isArray(callerHooks))) throw new Error("--settings hooks must be an object");
      const hooks = { ...(callerHooks as Record<string, unknown> | undefined) };
      for (const [event, entries] of Object.entries(injected.hooks ?? {})) {
        const existing = hooks[event];
        if (existing !== undefined && !Array.isArray(existing)) throw new Error(`--settings ${event} hooks must be an array`);
        hooks[event] = [...(existing as unknown[] | undefined ?? []), ...(entries as unknown[])];
      }
      settingsArgs = ["--settings", JSON.stringify({ ...caller, ...(ctx.facts ? { hooks } : {}) })];
      nativeArgs = passthrough.filter((_, i) => i !== index && (arg !== "--settings" || i !== index + 1));
    } else if (ctx.facts && !ctx.statusLine) {
      const injected = JSON.parse(sessionSettings(undefined, ctx.facts));
      settingsArgs = ["--settings", JSON.stringify({ hooks: injected.hooks })];
    }
    if (settingsArgs.length && !ctx.preview) {
      const stateDir = ctx.facts?.stateDir ?? ctx.statusLine?.stateDir;
      if (!stateDir) throw new Error("Claude session settings require the hub state directory");
      const file = join(stateDir, `claude-settings-${randomUUID()}.json`);
      try {
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        writeFileSync(`${file}.tmp`, settingsArgs[1]!, { mode: 0o600, flag: "wx" });
        renameSync(`${file}.tmp`, file);
      } catch {
        try { unlinkSync(`${file}.tmp`); } catch { /* no temp file was written */ }
        throw new Error("cannot write private Claude session settings in the hub state directory");
      }
      settingsArgs[1] = file;
    }
    const notes = [
      unattended ? UNATTENDED_WARNING : "",
      ctx.statusLine && own ? "note: you passed --settings, so the hub's status line tee is off and the budget coordinator cannot see Claude's quota (ahub budget set claude <0..1> still works)." : "",
    ].filter(Boolean);
    return {
      cmd: "claude",
      args: ["--dangerously-load-development-channels", claudeChannel(passthrough), ...(unattended ? ["--dangerously-skip-permissions"] : []), ...settingsArgs, ...nativeArgs],
      permissionHook: !!ctx.facts,
      ...(ctx.facts ? { hookPurpose: ctx.facts.purpose ?? "facts" } : {}),
      unattended,
      ...(notes.length ? { warning: notes.join("\n") } : {}),
    };
  }
  if (!ctx.proxyUrl) throw new Error("codex proxy url is missing");
  return {
    cmd: ctx.codexBin ?? "codex",
    args: ["--enable", "tui_app_server", "--remote", ctx.proxyUrl, ...(unattended ? ["--dangerously-bypass-approvals-and-sandbox"] : []), ...passthrough],
    unattended,
    ...warning,
  };
}


/** The daemon and preview use exactly the same ACP command insertion. */
export function buildKimiLaunch(command: string[], model?: string): Launch {
  const [cmd, ...args] = command;
  return { cmd: cmd!, args: model ? ["--model", model, ...args] : args };
}
