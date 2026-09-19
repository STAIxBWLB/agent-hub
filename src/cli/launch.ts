// Launchers inject only the flags the hub owns and refuse user-supplied duplicates.
export const CLAUDE_CHANNEL = "plugin:agent-hub@agent-hub";

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

export function buildLaunch(
  tool: "claude" | "codex",
  userArgs: string[],
  ctx: { unattended: boolean; proxyUrl?: string; codexBin?: string },
): Launch {
  // Hub-level switches are consumed here; everything else passes through to the tool.
  const passthrough = userArgs.filter((a) => !["--unattended", "--safe", "--new"].includes(a));
  const dup = passthrough.find((a) => OWNED[tool].some((flag) => a === flag || a.startsWith(`${flag}=`)));
  if (dup) throw new Error(`${dup} is managed by the hub; use "hub ${tool} --unattended" or drop the flag`);

  const unattended = ctx.unattended || userArgs.includes("--unattended");
  const warning = unattended ? { warning: UNATTENDED_WARNING } : {};
  if (tool === "claude") {
    return {
      cmd: "claude",
      args: ["--dangerously-load-development-channels", CLAUDE_CHANNEL, ...(unattended ? ["--dangerously-skip-permissions"] : []), ...passthrough],
      ...warning,
    };
  }
  if (!ctx.proxyUrl) throw new Error("codex proxy url is missing");
  return {
    cmd: ctx.codexBin ?? "codex",
    args: ["--enable", "tui_app_server", "--remote", ctx.proxyUrl, ...(unattended ? ["--dangerously-bypass-approvals-and-sandbox"] : []), ...passthrough],
    ...warning,
  };
}
