// Launchers inject only the flags the hub owns and refuse user-supplied duplicates.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
export const CLAUDE_CHANNEL = "plugin:agent-hub@agent-hub";

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

/** The turn-free facts hook (issue #108): absolute path of src/cli/facts-hook.ts and the hub's state dir. */
export interface FactsHook {
  script: string;
  stateDir: string;
}

/**
 * The one `--settings` value of a hub-launched Claude session: the status line tee, and in a turn-free project the
 * facts hook before and after every tool call and at the end of each turn (issue #108; the turn end is the quiescence
 * evidence of issue #107).
 */
export function sessionSettings(tee: StatusLineTee, facts?: FactsHook): string {
  const settings = JSON.parse(statusLineSettings(tee)) as Record<string, unknown>;
  if (facts) {
    const hooks = [{ type: "command", command: `AGENTHUB_STATE_DIR=${sh(facts.stateDir)} bun ${sh(facts.script)}`, timeout: 5 }];
    settings.hooks = { PreToolUse: [{ matcher: "*", hooks }], PostToolUse: [{ matcher: "*", hooks }], Stop: [{ hooks }] };
  }
  return JSON.stringify(settings);
}

export function buildLaunch(
  tool: "claude" | "codex",
  userArgs: string[],
  ctx: { unattended: boolean; proxyUrl?: string; codexBin?: string; statusLine?: StatusLineTee; facts?: FactsHook },
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
    const tee = ctx.statusLine && !own ? ["--settings", sessionSettings(ctx.statusLine, ctx.facts)] : [];
    const notes = [
      unattended ? UNATTENDED_WARNING : "",
      ctx.statusLine && own ? "note: you passed --settings, so the hub's status line tee is off and the budget coordinator cannot see Claude's quota (ahub budget set claude <0..1> still works)." : "",
      ctx.facts && own ? "note: you passed --settings, so the hub's turn-free facts hooks are off for this session: Claude will not see the other agents' changes at its tool calls." : "",
    ].filter(Boolean);
    return {
      cmd: "claude",
      args: ["--dangerously-load-development-channels", claudeChannel(passthrough), ...(unattended ? ["--dangerously-skip-permissions"] : []), ...tee, ...passthrough],
      ...(notes.length ? { warning: notes.join("\n") } : {}),
    };
  }
  if (!ctx.proxyUrl) throw new Error("codex proxy url is missing");
  return {
    cmd: ctx.codexBin ?? "codex",
    args: ["--enable", "tui_app_server", "--remote", ctx.proxyUrl, ...(unattended ? ["--dangerously-bypass-approvals-and-sandbox"] : []), ...passthrough],
    ...warning,
  };
}


/** The daemon and preview use exactly the same ACP command insertion. */
export function buildKimiLaunch(command: string[], model?: string): Launch {
  const [cmd, ...args] = command;
  return { cmd: cmd!, args: model ? ["--model", model, ...args] : args };
}
