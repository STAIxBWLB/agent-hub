import { createCodex, createKimi, createJcode, createPi, createLocal } from "./native-factories.ts";
import { CLAUDE_DISPLAY, CODEX_DISPLAY, KIMI_DISPLAY, PI_DISPLAY, LOCAL_DISPLAY, JCODE_DISPLAY } from "./native-display.ts";
import { CLAUDE_RECOVERY_SESSION, CODEX_RECOVERY_SESSION, KIMI_RECOVERY_SESSION, PI_RECOVERY_SESSION, LOCAL_RECOVERY_SESSION, JCODE_RECOVERY_SESSION } from "./native-recovery.ts";
import { claudeWindows, codexWindows } from "./native-quota.ts";
import { claudeContext, codexContext, acpContextValue } from "./native-context.ts";
import type { AdapterDefinition, LaunchContext, LaunchPlan, StartForm } from "../registry-types.ts";
import type { PeerAdapter } from "../../hub/peers.ts";
import { shellQuote } from "../../cli/shell-quote.ts";

type CompatibilityKind = "claude" | "codex" | "kimi" | "pi" | "local" | "jcode";

/**
 * ponytail: A1 compatibility definitions delegate to the existing CLI; the existing daemon remains their runtime
 * authority until A2 migrates each native path. These launch methods are not a second native launcher or factory.
 */
function compatibilityLaunch(kind: CompatibilityKind, ctx: LaunchContext): LaunchPlan {
  const mode = kind === "kimi" || kind === "pi" ? ["--mode", ctx.form] : [];
  const unattended = ctx.unattended && (kind === "claude" || kind === "codex") ? ["--unattended"] : [];
  const args = [ctx.entrypoint, "--project", ctx.projectRoot, kind, ...mode, ...unattended,
    ...(ctx.model && !ctx.userArgs.includes("--model") ? ["--model", ctx.model] : []), ...ctx.userArgs];
  const argv = [process.execPath, ...args];
  const env = {
    ...(ctx.env.CODEX_HOME !== undefined ? { CODEX_HOME: ctx.env.CODEX_HOME } : {}),
    ...(ctx.env.CLAUDE_CONFIG_DIR !== undefined ? { CLAUDE_CONFIG_DIR: ctx.env.CLAUDE_CONFIG_DIR } : {}),
  };
  const prefix = Object.entries(env).map(([name, value]) => `${name}=${shellQuote(value)}`);
  return { cmd: process.execPath, args, ...(unattended.length ? { unattended: true } : {}),
    metadata: { packageEntrypoint: ctx.entrypoint, argv, env, command: [...prefix, ...argv.map(shellQuote)].join(" ") } };
}

function sessionId(field: "sessionId" | "threadId"): (peer: PeerAdapter) => string | undefined {
  return peer => {
    const value = peer.recoveryMetadata?.()[field];
    return typeof value === "string" && value ? value : undefined;
  };
}
const terminal = (form: StartForm) => form === "tui";
const headless = () => false;
const switches = Object.freeze(["--unattended", "--safe", "--new"]);
const implementerRoles = Object.freeze(["implementer", "verifier"]);
const dualForms = Object.freeze(["tui", "headless"] as const);
const headlessForms = Object.freeze(["headless"] as const);
const hubGrants = {
  ask: "every write, edit and shell command asks",
  "ask-when-needed": "write and edit inside the project run without asking; shell and git writes still ask",
  "never-ask": "every tool runs without asking, inside the hub sandbox and path guard",
};

// Sources: peer-catalog.ts roles, roster.ts defaults, start-mode.ts forms, permission-mode.ts grants,
// daemon.ts runtime mappings/stop policy, budget.ts exemptions, and ui/peer-palette.ts CSS foregrounds.
export const BUILTIN_DEFINITIONS_WITHOUT_QWEN: readonly AdapterDefinition[] = Object.freeze([
  {
    api: 1, kind: "claude", displayName: "Claude Code", family: "claude", transport: "claude-channel",
    roles: Object.freeze(["planner", "reviewer"]), defaultOnRoster: true, trust: { onPrem: false, hubSandboxed: false },
    start: { forms: Object.freeze(["tui"] as const), defaultForm: "tui", ownsTerminal: terminal, launch: ctx => compatibilityLaunch("claude", ctx), conductorStartable: true,
      unattended: true, hubSwitches: switches, ownedFlags: Object.freeze(["--dangerously-load-development-channels", "--dangerously-skip-permissions"]) },
    identity: { mcp: "channel-plugin" },
    // ponytail: A1 compatibility, existing daemon permission hooks remain authority until A2; absence is not unmanaged or a refusal.
    permission: { modes: {}, grants: { ask: "Claude's own permission rules decide",
      "ask-when-needed": "file tools on project files run without asking, outside .agenthub, .git and agent configuration; other tools keep Claude's own rules",
      "never-ask": "every tool runs without asking" } },
    session: { idField: "sessionId", currentId: sessionId("sessionId"), configDirEnv: "CLAUDE_CONFIG_DIR", zeroTurnFresh: true, launchKind: "claude-channel", launchRecord: true, ...CLAUDE_RECOVERY_SESSION },
    turnEnd: "native-hook", budget: { account: "claude", checkpoint: true, reader: { source: "claude status line", read: claudeWindows }, context: { source: "claude_statusline", read: claudeContext } },
    cli: { command: "claude", startWords: () => ["claude"] }, display: CLAUDE_DISPLAY, hooks: { recallPlatform: "claude" },
  },
  {
    api: 1, kind: "codex", displayName: "Codex", family: "codex", transport: "codex-appserver",
    roles: Object.freeze(["implementer"]), defaultOnRoster: true, trust: { onPrem: false, hubSandboxed: false },
    start: { create: createCodex, daemonPort: "codex-appserver", forms: dualForms, defaultForm: "tui", ownsTerminal: terminal, launch: ctx => compatibilityLaunch("codex", ctx), conductorStartable: true,
      unattended: true, hubSwitches: switches, ownedFlags: Object.freeze(["--remote", "--yolo", "--dangerously-bypass-approvals-and-sandbox"]) },
    identity: { mcp: "env" },
    permission: { modes: { ask: { kind: "native-only", note: "restore the session's captured native approval policy" },
      "ask-when-needed": { kind: "codex-approval", policy: "on-request" }, "never-ask": { kind: "codex-approval", policy: "never" } },
      grants: { ask: "the session's own approval policy applies again", "ask-when-needed": "approval policy on-request on every turn", "never-ask": "approval policy never on every turn: nothing asks" } },
    session: { idField: "threadId", currentId: sessionId("threadId"), configDirEnv: "CODEX_HOME", zeroTurnFresh: true, launchKind: "codex", launchRecord: true, ...CODEX_RECOVERY_SESSION },
    turnEnd: "adapter", budget: { account: "codex", checkpoint: true, reader: { source: "codex rateLimits", read: codexWindows }, context: { source: "codex_token_usage", read: codexContext } },
    cli: { command: "codex", startWords: () => ["codex"] }, display: CODEX_DISPLAY, hooks: { recallPlatform: "codex" },
  },
  {
    api: 1, kind: "kimi", displayName: "Kimi Code", family: "kimi", transport: "acp",
    roles: implementerRoles, defaultOnRoster: true, trust: { onPrem: false, hubSandboxed: false },
    start: { create: createKimi, daemonPort: "acp", forms: dualForms, defaultForm: "tui", ownsTerminal: terminal, launch: ctx => compatibilityLaunch("kimi", ctx), conductorStartable: true, hubSwitches: [], ownedFlags: [] },
    // ACP sessions carry headless identity; the existing CLI alone owns the TUI's project MCP entry.
    identity: { mcp: "acp-session" }, attach: { pullOnlyForms: Object.freeze(["tui"] as const) },
    permission: { modes: { ask: { kind: "acp-mode", modeId: "default" }, "ask-when-needed": { kind: "acp-mode", modeId: "yolo" }, "never-ask": { kind: "acp-mode", modeId: "auto" } },
      grants: { ask: "Kimi asks as it does on its own", "ask-when-needed": "Kimi's yolo mode: it asks only where it judges it must", "never-ask": "Kimi's auto mode: nothing asks" },
      unmanagedForms: Object.freeze(["tui"] as const), unmanagedNote: "Kimi approves tools and selects its permission mode in its own TUI; no hub permission mode" },
    session: { idField: "sessionId", currentId: sessionId("sessionId"), freshOnRestore: true, launchKind: "acp", ...KIMI_RECOVERY_SESSION },
    turnEnd: "adapter", budget: { account: "kimi", context: { source: "acp_usage_update", read: acpContextValue } }, capabilities: { watch: true }, init: { mcpFile: ".kimi-code/mcp.json" },
    cli: { command: "kimi", startWords: form => ["kimi", "--mode", form] }, display: KIMI_DISPLAY,
  },
  {
    api: 1, kind: "pi", displayName: "Pi", family: "pi", transport: "hub-native",
    roles: implementerRoles, defaultOnRoster: false, trust: { onPrem: false, hubSandboxed: true },
    start: { create: createPi, daemonPort: "pi-rpc", forms: dualForms, defaultForm: "tui", ownsTerminal: terminal, launch: ctx => compatibilityLaunch("pi", ctx), conductorStartable: true, autoStart: "pi.auto_start", hubSwitches: [], ownedFlags: [] },
    identity: { mcp: "env" },
    // ponytail: A1 compatibility, existing daemon permission hooks remain authority until A2; absence is not unmanaged or a refusal.
    permission: { modes: {}, grants: { ...hubGrants } },
    session: { idField: "sessionId", currentId: sessionId("sessionId"), restoreOnStart: true, launchKind: "pi", launchRecord: true, ...PI_RECOVERY_SESSION },
    turnEnd: "adapter", budget: { account: "pi" },
    cli: { command: "pi", startWords: form => ["pi", "--mode", form] }, display: PI_DISPLAY,
  },
  {
    api: 1, kind: "local", displayName: "Local worker", family: "local", transport: "hub-native",
    roles: implementerRoles, defaultOnRoster: true, trust: { onPrem: true, hubSandboxed: true },
    start: { create: createLocal, daemonPort: "local-worker", forms: headlessForms, defaultForm: "headless", ownsTerminal: headless, launch: ctx => compatibilityLaunch("local", ctx), conductorStartable: true, hubSwitches: [], ownedFlags: [] },
    identity: { mcp: "env" },
    // ponytail: A1 compatibility, existing daemon permission hooks remain authority until A2; absence is not unmanaged or a refusal.
    permission: { modes: {}, grants: { ...hubGrants } },
    session: { idField: "sessionId", currentId: sessionId("sessionId"), freshOnRestore: true, launchKind: "local", ...LOCAL_RECOVERY_SESSION },
    turnEnd: "adapter",
    cli: { command: "local", startWords: () => ["local"] }, display: LOCAL_DISPLAY,
  },
  {
    api: 1, kind: "jcode", displayName: "Jcode", family: "jcode", transport: "acp",
    roles: implementerRoles, optional: true, defaultOnRoster: false, trust: { onPrem: false, hubSandboxed: false },
    start: { create: createJcode, daemonPort: "owned-acp", forms: headlessForms, defaultForm: "headless", ownsTerminal: headless, launch: ctx => compatibilityLaunch("jcode", ctx), conductorStartable: true, hubSwitches: [], ownedFlags: [] },
    identity: { mcp: "project-file" },
    permission: { modes: {}, unmanaged: "Jcode native policy is unmanaged; no hub mode mapping", grants: {
      ask: "no verified hub mode mapping; native policy only", "ask-when-needed": "no verified hub mode mapping; native policy only", "never-ask": "no verified hub mode mapping; native policy only" } },
    session: { idField: "sessionId", currentId: sessionId("sessionId"), launchKind: "jcode", ...JCODE_RECOVERY_SESSION }, turnEnd: "adapter", budget: { account: "jcode" },
    // Jcode has no dedicated CSS swatch today: retain peer-palette.ts's existing 'other' fallback.
    cli: { command: "jcode", startWords: () => ["jcode"] }, display: JCODE_DISPLAY,
  },
] satisfies AdapterDefinition[]);
