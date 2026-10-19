import { claudeReviewerBackend, CODEX_REVIEWER_VARIANT, KIMI_REVIEWER_VARIANT } from "./reviewer-variants.ts";
import { kimiAcpCommand } from "./native-daemon-kimi.ts";
import { claudeRecoveryLaunch, kimiRecoveryLaunch, claudeRetainedTerminalNotice, piRetainedTerminalNotice, codexRetainedTerminalNotice, codexRosterReturnNotice, jcodeStartPreflight, claudeObservedVersion, codexObservedVersion } from "./native-daemon-policy.ts";
import { piConfigSchema, localConfigSchema, piRoutingSchema, localRoutingSchema, PI_SETTINGS, PI_RESTART_REASONS, LOCAL_RESTART_REASONS, piEffectiveConfig } from "./native-config-policy.ts";
import { claudeCrashPlan, codexCrashPlan, kimiCrashPlan, piCrashPlan, localCrashPlan, jcodeCrashPlan, claudePluginInventory, codexPluginInventory, parsePiContinuity, codexToolSemantic } from "./native-policy-aux.ts";
import { piRecoveryContinuity } from "./native-recovery-continuity.ts";
import { piConductorStartArgs } from "./native-cli-pi.ts";
import { claudeNativeLaunch, CLAUDE_LAUNCH_POLICY } from "./native-cli-claude-launch.ts";
import { codexNativeLaunch, CODEX_LAUNCH_POLICY } from "./native-cli-codex-launch.ts";
import { createCodex, createKimi, createJcode, createPi, createLocal, createClaudeReviewer } from "./native-factories.ts";
import { CLAUDE_DISPLAY, CODEX_DISPLAY, KIMI_DISPLAY, PI_DISPLAY, LOCAL_DISPLAY, JCODE_DISPLAY } from "./native-display.ts";
import { CLAUDE_RECOVERY_SESSION, CODEX_RECOVERY_SESSION, KIMI_RECOVERY_SESSION, PI_RECOVERY_SESSION, LOCAL_RECOVERY_SESSION, JCODE_RECOVERY_SESSION } from "./native-recovery.ts";
import { claudeWindows, codexWindows } from "./native-quota.ts";
import { claudeContext, codexContext, acpContextValue } from "./native-context.ts";
import type { AdapterDefinition, LaunchContext, LaunchPlan, StartForm } from "../registry-types.ts";
import type { PeerAdapter } from "../../hub/peers.ts";
import { shellQuote } from "../../cli/shell-quote.ts";

type CompatibilityKind = "claude" | "codex" | "kimi" | "pi" | "local" | "jcode";

/**
 * Preserve CLI-wrapper argv plans for definitions that still declare them and the frozen A1 compatibility export.
 * Native startup and daemon factories are supplied separately by the runtime definitions.
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

/**
 * #223: a declared `claude-*` instance with `start_mode: "headless"` and roles exactly ["reviewer"]. The hub runs one
 * fresh `claude -p` session per review request (src/adapters/claude-print.ts); it never owns a terminal or a session.
 */
const CLAUDE_REVIEWER_VARIANT: AdapterDefinition = {
  api: 1, kind: "claude", displayName: "Claude Code reviewer", family: "claude", transport: "hub-native",
  roles: Object.freeze(["reviewer"]), defaultOnRoster: true, trust: { onPrem: false, hubSandboxed: false },
  start: { create: createClaudeReviewer, daemonPort: "claude-print", forms: headlessForms, defaultForm: "headless", ownsTerminal: headless, launch: ctx => compatibilityLaunch("claude", ctx), conductorStartable: true, hubSwitches: [], ownedFlags: [] },
  identity: { mcp: "env" },
  permission: { modes: {}, unmanaged: "each review runs read-only (Read, Grep, Glob) and may call only hub_review and hub_task_show" },
  session: { idField: "sessionId", currentId: () => undefined, freshOnRestore: true, launchKind: "claude-print", crashPlan: () => ({ resume: {}, how: "claude reviewer: starts again; every review runs in a new session" }) },
  turnEnd: "adapter", budget: { account: "claude" }, routing: { reviewOnly: true }, reviewer: { backend: claudeReviewerBackend, defaultPool: true, declaration: "automatic" },
  cli: { command: "claude", startWords: () => ["claude"] }, display: CLAUDE_DISPLAY,
};

// Sources: peer-catalog.ts roles, roster.ts defaults, start-mode.ts forms, permission-mode.ts grants,
// daemon.ts runtime mappings/stop policy, budget.ts exemptions, and ui/peer-palette.ts CSS foregrounds.
export const NATIVE_BUILTIN_DEFINITIONS_WITHOUT_QWEN: readonly AdapterDefinition[] = Object.freeze([
  {
    api: 1, kind: "claude", displayName: "Claude Code", family: "claude", transport: "claude-channel",
    roles: Object.freeze(["planner", "reviewer"]), defaultOnRoster: true, trust: { onPrem: false, hubSandboxed: false },
    start: { forms: Object.freeze(["tui"] as const), defaultForm: "tui", ownsTerminal: terminal, launch: claudeNativeLaunch, version: claudeObservedVersion, ...CLAUDE_LAUNCH_POLICY, conductorStartable: true,
      unattended: true, hubSwitches: switches, ownedFlags: Object.freeze(["--dangerously-load-development-channels", "--dangerously-skip-permissions"]) },
    identity: { mcp: "channel-plugin" }, attach: { recoveryLaunch: claudeRecoveryLaunch },
    // Existing daemon permission hooks enforce these grants; an empty native mode map is neither unmanaged nor a refusal.
    permission: { modes: {}, grants: { ask: "Claude's own permission rules decide",
      "ask-when-needed": "file tools on project files run without asking, outside .agenthub, .git and agent configuration; other tools keep Claude's own rules",
      "never-ask": "every tool runs without asking" } },
    session: { idField: "sessionId", currentId: sessionId("sessionId"), configDirEnv: "CLAUDE_CONFIG_DIR", zeroTurnFresh: true, launchKind: "claude-channel", launchRecord: true, ...CLAUDE_RECOVERY_SESSION, crashPlan: claudeCrashPlan, unrecordedTerminal: "always" },
    turnEnd: "native-hook", budget: { account: "claude", checkpoint: true, reader: { source: "claude status line", read: claudeWindows }, context: { source: "claude_statusline", read: claudeContext } },
    cli: { command: "claude", retainedTerminalNotice: claudeRetainedTerminalNotice, stopNotice: () => "this peer belongs to a native terminal; end it in its terminal", startWords: () => ["claude"] }, display: CLAUDE_DISPLAY, hooks: { recallPlatform: "claude", recallSource: "claude", recallInjected: true, pluginInventory: claudePluginInventory },
    reviewerVariant: CLAUDE_REVIEWER_VARIANT,
  },
  {
    reviewerVariant: CODEX_REVIEWER_VARIANT,
    api: 1, kind: "codex", displayName: "Codex", family: "codex", transport: "codex-appserver",
    roles: Object.freeze(["implementer"]), defaultOnRoster: true, trust: { onPrem: false, hubSandboxed: false },
    start: { create: createCodex, daemonPort: "codex-appserver", forms: dualForms, defaultForm: "tui", ownsTerminal: terminal, launch: codexNativeLaunch, version: codexObservedVersion, ...CODEX_LAUNCH_POLICY, conductorStartable: true,
      unattended: true, hubSwitches: switches, ownedFlags: Object.freeze(["--remote", "--yolo", "--dangerously-bypass-approvals-and-sandbox"]) },
    identity: { mcp: "env" },
    permission: { trackUnattended: true, modes: { ask: { kind: "native-only", note: "restore the session's captured native approval policy" },
      "ask-when-needed": { kind: "codex-approval", policy: "on-request" }, "never-ask": { kind: "codex-approval", policy: "never" } },
      grants: { ask: "the session's own approval policy applies again", "ask-when-needed": "approval policy on-request on every turn", "never-ask": "approval policy never on every turn: nothing asks" } },
    session: { nativeRevert: true, idField: "threadId", currentId: sessionId("threadId"), configDirEnv: "CODEX_HOME", zeroTurnFresh: true, launchKind: "codex", launchRecord: true, ...CODEX_RECOVERY_SESSION, crashPlan: codexCrashPlan, unrecordedTerminal: "always" },
    turnEnd: "adapter", budget: { account: "codex", checkpoint: true, reader: { source: "codex rateLimits", read: codexWindows }, context: { source: "codex_token_usage", read: codexContext } },
    cli: { command: "codex", retainedTerminalNotice: codexRetainedTerminalNotice, rosterReturnNotice: codexRosterReturnNotice, stopNotice: () => "this peer belongs to a native terminal; end it in its terminal", startWords: () => ["codex"] }, display: CODEX_DISPLAY, hooks: { recallPlatform: "codex", recallSource: "codex", recallInjected: true, pluginInventory: codexPluginInventory, classifyTool: codexToolSemantic },
  },
  {
    reviewerVariant: KIMI_REVIEWER_VARIANT,
    api: 1, kind: "kimi", displayName: "Kimi Code", family: "kimi", transport: "acp",
    roles: implementerRoles, defaultOnRoster: true, trust: { onPrem: false, hubSandboxed: false },
    start: { create: createKimi, acpCommand: kimiAcpCommand, explicitHeadlessMode: true, planCommand: () => "ahub kimi", daemonPort: "acp", forms: dualForms, defaultForm: "tui", ownsTerminal: terminal, launch: ctx => compatibilityLaunch("kimi", ctx), conductorStartable: true, hubSwitches: [], ownedFlags: [] },
    // ACP sessions carry headless identity; the existing CLI alone owns the TUI's project MCP entry.
    identity: { mcp: "acp-session" }, attach: { pullOnlyForms: Object.freeze(["tui"] as const), recoveryLaunch: kimiRecoveryLaunch,
      pullOnlyNotice: "pull-only: messages wait for hub_inbox; no push, steer, watchdog or automatic quota handoff",
      admission: { reservedRefusal: "Kimi attaches pull-only in TUI mode; run ahub kimi", watchRefusal: "Kimi is in pull-only TUI mode; use its native terminal or start headless" } },
    permission: { modes: { ask: { kind: "acp-mode", modeId: "default" }, "ask-when-needed": { kind: "acp-mode", modeId: "yolo" }, "never-ask": { kind: "acp-mode", modeId: "auto" } },
      grants: { ask: "Kimi asks as it does on its own", "ask-when-needed": "Kimi's yolo mode: it asks only where it judges it must", "never-ask": "Kimi's auto mode: nothing asks" },
      unmanagedForms: Object.freeze(["tui"] as const), unmanagedStatusNote: "Kimi approves tools in its own TUI; no hub permission mode", unmanagedNote: "Kimi approves tools and selects its permission mode in its own TUI; no hub permission mode" },
    session: { idField: "sessionId", currentId: sessionId("sessionId"), freshOnRestore: true, launchKind: "acp", ...KIMI_RECOVERY_SESSION, crashPlan: kimiCrashPlan },
    turnEnd: "adapter", budget: { account: "kimi", resetSoftTokensOnResume: true, context: { source: "acp_usage_update", read: acpContextValue } }, capabilities: { watch: true }, init: { mcpFile: ".kimi-code/mcp.json" }, hooks: { recallPlatform: "kimi", recallSource: "kimi" },
    cli: { command: "kimi", stopNotice: form => form === "tui" ? "Kimi belongs to its own TUI terminal; end it in that terminal" : "", startWords: form => ["kimi", "--mode", form] }, display: KIMI_DISPLAY,
  },
  {
    api: 1, kind: "pi", enabledSwitchStartOnly: true, displayName: "Pi", family: "pi", transport: "hub-native",
    roles: implementerRoles, defaultOnRoster: false, trust: { onPrem: false, hubSandboxed: true },
    start: { create: createPi, exclusiveStartRefusal: "Pi start is in progress; inspect status before retrying", refreshTools: true, explicitHeadlessMode: true, daemonPort: "pi-rpc", forms: dualForms, defaultForm: "tui", ownsTerminal: terminal, launch: ctx => compatibilityLaunch("pi", ctx), conductorStartable: true, autoStart: "pi.auto_start", conductorStartArgs: piConductorStartArgs, hubSwitches: [], ownedFlags: [] },
    identity: { mcp: "env" },
    // Existing daemon permission hooks enforce these grants; an empty native mode map is neither unmanaged nor a refusal.
    permission: { modes: {}, grants: { ...hubGrants } },
    session: { idField: "sessionId", currentId: sessionId("sessionId"), restoreOnStart: true, launchKind: "pi", launchRecord: true, ...PI_RECOVERY_SESSION, crashPlan: piCrashPlan, unrecordedTerminal: "tui", continuityBookmark: piRecoveryContinuity, continuity: { key: "pi", parse: parsePiContinuity } },
    turnEnd: "adapter", budget: { account: "pi", instrumented: true }, reporting: { tokensNotReported: true }, configuration: { schema: piConfigSchema, routingSchema: piRoutingSchema, settings: PI_SETTINGS, restartReasons: PI_RESTART_REASONS, validateEffective: piEffectiveConfig },
    routing: { localAllowedRefusal: "local_allowed = false also excludes pi for this class", longContext: "backend-limit", preferredTier: true, handoffPriority: 0, trace: "backend", backendLabel: "pi" },
    cli: { command: "pi", previewArgs: ["--mode", "tui"], retainedTerminalNotice: piRetainedTerminalNotice, personOnlyFlags: ["--replace-session"], startWords: form => ["pi", "--mode", form] }, display: PI_DISPLAY,
  },
  {
    api: 1, kind: "local", displayName: "Local worker", family: "local", transport: "hub-native",
    roles: implementerRoles, defaultOnRoster: true, trust: { onPrem: true, hubSandboxed: true },
    start: { create: createLocal, reconfigureWhileAttached: true, refreshTools: true, daemonPort: "local-worker", forms: headlessForms, defaultForm: "headless", ownsTerminal: headless, launch: ctx => compatibilityLaunch("local", ctx), conductorStartable: true, hubSwitches: [], ownedFlags: [] },
    identity: { mcp: "env" },
    // Existing daemon permission hooks enforce these grants; an empty native mode map is neither unmanaged nor a refusal.
    permission: { modes: {}, grants: { ...hubGrants } },
    session: { idField: "sessionId", currentId: sessionId("sessionId"), freshOnRestore: true, launchKind: "local", ...LOCAL_RECOVERY_SESSION, crashPlan: localCrashPlan },
    turnEnd: "adapter", budget: { account: "local", quotaExempt: true, instrumented: true }, configuration: { schema: localConfigSchema, routingSchema: localRoutingSchema, restartReasons: LOCAL_RESTART_REASONS },
    routing: { localAllowedRefusal: "local_allowed = false for this class", longContext: "skip-owner", preferredTier: true, handoffPriority: 1, trace: "route" },
    cli: { command: "local", startWords: () => ["local"] }, display: LOCAL_DISPLAY,
  },
  {
    api: 1, kind: "jcode", displayName: "Jcode", family: "jcode", transport: "acp",
    roles: implementerRoles, optional: true, defaultOnRoster: false, trust: { onPrem: false, hubSandboxed: false },
    start: { create: createJcode, preflight: jcodeStartPreflight, daemonPort: "owned-acp", forms: headlessForms, defaultForm: "headless", ownsTerminal: headless, launch: ctx => compatibilityLaunch("jcode", ctx), conductorStartable: true, hubSwitches: [], ownedFlags: [] },
    identity: { mcp: "project-file" },
    permission: { modes: {}, unmanaged: "Jcode native policy is unmanaged; no hub mode mapping", grants: {
      ask: "no verified hub mode mapping; native policy only", "ask-when-needed": "no verified hub mode mapping; native policy only", "never-ask": "no verified hub mode mapping; native policy only" } },
    session: { idField: "sessionId", currentId: sessionId("sessionId"), launchKind: "jcode", ...JCODE_RECOVERY_SESSION, crashPlan: jcodeCrashPlan }, turnEnd: "adapter", budget: { account: "jcode" },
    // Jcode has no dedicated CSS swatch today: retain peer-palette.ts's existing 'other' fallback.
    cli: { command: "jcode", authority: "person", startWords: () => ["jcode"] }, display: JCODE_DISPLAY, hooks: { recallPlatform: "jcode" },
  },
] satisfies AdapterDefinition[]);

/**
 * ponytail: retain the released A1 metadata export for source/library compatibility until A4 retires it.
 * Core runtime consumers use NATIVE_BUILTIN_DEFINITIONS_WITHOUT_QWEN through the registry exclusively.
 */
const palette = (fg: string) => ({ palette: { fg, bg: "transparent" } });
export const BUILTIN_DEFINITIONS_WITHOUT_QWEN: readonly AdapterDefinition[] = Object.freeze([
  {
    api: 1, kind: "claude", displayName: "Claude Code", family: "claude", transport: "claude-channel",
    roles: Object.freeze(["planner", "reviewer"]), defaultOnRoster: true, trust: { onPrem: false, hubSandboxed: false },
    start: { forms: Object.freeze(["tui"] as const), defaultForm: "tui", ownsTerminal: terminal, launch: ctx => compatibilityLaunch("claude", ctx), conductorStartable: true,
      unattended: true, hubSwitches: switches, ownedFlags: Object.freeze(["--dangerously-load-development-channels", "--dangerously-skip-permissions"]) },
    identity: { mcp: "channel-plugin" },
    permission: { modes: {}, grants: { ask: "Claude's own permission rules decide",
      "ask-when-needed": "file tools on project files run without asking, outside .agenthub, .git and agent configuration; other tools keep Claude's own rules",
      "never-ask": "every tool runs without asking" } },
    session: { idField: "sessionId", currentId: sessionId("sessionId"), configDirEnv: "CLAUDE_CONFIG_DIR", zeroTurnFresh: true, launchKind: "claude-channel", launchRecord: true },
    turnEnd: "native-hook", budget: { account: "claude", checkpoint: true },
    cli: { command: "claude", startWords: () => ["claude"] }, display: palette("#6495ed"), hooks: { recallPlatform: "claude" },
  },
  {
    api: 1, kind: "codex", displayName: "Codex", family: "codex", transport: "codex-appserver",
    roles: Object.freeze(["implementer"]), defaultOnRoster: true, trust: { onPrem: false, hubSandboxed: false },
    start: { forms: dualForms, defaultForm: "tui", ownsTerminal: terminal, launch: ctx => compatibilityLaunch("codex", ctx), conductorStartable: true,
      unattended: true, hubSwitches: switches, ownedFlags: Object.freeze(["--remote", "--yolo", "--dangerously-bypass-approvals-and-sandbox"]) },
    identity: { mcp: "env" },
    permission: { modes: { ask: { kind: "native-only", note: "restore the session's captured native approval policy" },
      "ask-when-needed": { kind: "codex-approval", policy: "on-request" }, "never-ask": { kind: "codex-approval", policy: "never" } },
      grants: { ask: "the session's own approval policy applies again", "ask-when-needed": "approval policy on-request on every turn", "never-ask": "approval policy never on every turn: nothing asks" } },
    session: { idField: "threadId", currentId: sessionId("threadId"), configDirEnv: "CODEX_HOME", zeroTurnFresh: true, launchKind: "codex", launchRecord: true },
    turnEnd: "adapter", budget: { account: "codex", checkpoint: true },
    cli: { command: "codex", startWords: () => ["codex"] }, display: palette("#22b8cf"), hooks: { recallPlatform: "codex" },
  },
  {
    api: 1, kind: "kimi", displayName: "Kimi Code", family: "kimi", transport: "acp",
    roles: implementerRoles, defaultOnRoster: true, trust: { onPrem: false, hubSandboxed: false },
    start: { forms: dualForms, defaultForm: "tui", ownsTerminal: terminal, launch: ctx => compatibilityLaunch("kimi", ctx), conductorStartable: true, hubSwitches: [], ownedFlags: [] },
    // ACP sessions carry headless identity; the existing CLI alone owns the TUI's project MCP entry.
    identity: { mcp: "acp-session" }, attach: { pullOnlyForms: Object.freeze(["tui"] as const) },
    permission: { modes: { ask: { kind: "acp-mode", modeId: "default" }, "ask-when-needed": { kind: "acp-mode", modeId: "yolo" }, "never-ask": { kind: "acp-mode", modeId: "auto" } },
      grants: { ask: "Kimi asks as it does on its own", "ask-when-needed": "Kimi's yolo mode: it asks only where it judges it must", "never-ask": "Kimi's auto mode: nothing asks" },
      unmanagedForms: Object.freeze(["tui"] as const), unmanagedNote: "Kimi approves tools and selects its permission mode in its own TUI; no hub permission mode" },
    session: { idField: "sessionId", currentId: sessionId("sessionId"), freshOnRestore: true, launchKind: "acp" },
    turnEnd: "adapter", budget: { account: "kimi" }, capabilities: { watch: true }, init: { mcpFile: ".kimi-code/mcp.json" },
    cli: { command: "kimi", startWords: form => ["kimi", "--mode", form] }, display: palette("#bc73ca"),
  },
  {
    api: 1, kind: "pi", displayName: "Pi", family: "pi", transport: "hub-native",
    roles: implementerRoles, defaultOnRoster: false, trust: { onPrem: false, hubSandboxed: true },
    start: { forms: dualForms, defaultForm: "tui", ownsTerminal: terminal, launch: ctx => compatibilityLaunch("pi", ctx), conductorStartable: true, autoStart: "pi.auto_start", hubSwitches: [], ownedFlags: [] },
    identity: { mcp: "env" },
    permission: { modes: {}, grants: { ...hubGrants } },
    session: { idField: "sessionId", currentId: sessionId("sessionId"), launchKind: "pi", launchRecord: true },
    turnEnd: "adapter", budget: { account: "pi" },
    cli: { command: "pi", startWords: form => ["pi", "--mode", form] }, display: palette("#c79936"),
  },
  {
    api: 1, kind: "local", displayName: "Local worker", family: "local", transport: "hub-native",
    roles: implementerRoles, defaultOnRoster: true, trust: { onPrem: true, hubSandboxed: true },
    start: { forms: headlessForms, defaultForm: "headless", ownsTerminal: headless, launch: ctx => compatibilityLaunch("local", ctx), conductorStartable: true, hubSwitches: [], ownedFlags: [] },
    identity: { mcp: "env" },
    permission: { modes: {}, grants: { ...hubGrants } },
    session: { idField: "sessionId", currentId: sessionId("sessionId"), freshOnRestore: true, launchKind: "local" },
    turnEnd: "adapter",
    cli: { command: "local", startWords: () => ["local"] }, display: palette("#4caa77"),
  },
  {
    api: 1, kind: "jcode", displayName: "Jcode", family: "jcode", transport: "acp",
    roles: implementerRoles, optional: true, defaultOnRoster: false, trust: { onPrem: false, hubSandboxed: false },
    start: { forms: headlessForms, defaultForm: "headless", ownsTerminal: headless, launch: ctx => compatibilityLaunch("jcode", ctx), conductorStartable: true, hubSwitches: [], ownedFlags: [] },
    identity: { mcp: "project-file" },
    permission: { modes: {}, unmanaged: "Jcode native policy is unmanaged; no hub mode mapping", grants: {
      ask: "no verified hub mode mapping; native policy only", "ask-when-needed": "no verified hub mode mapping; native policy only", "never-ask": "no verified hub mode mapping; native policy only" } },
    session: { idField: "sessionId", currentId: sessionId("sessionId"), launchKind: "jcode" }, turnEnd: "adapter", budget: { account: "jcode" },
    // Jcode has no dedicated CSS swatch today: retain peer-palette.ts's existing 'other' fallback.
    cli: { command: "jcode", startWords: () => ["jcode"] }, display: palette("#8a8f99"),
  },
] satisfies AdapterDefinition[]);
