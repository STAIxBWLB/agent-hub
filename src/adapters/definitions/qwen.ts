import { QWEN_DISPLAY } from "./native-display.ts";
import { QWEN_RECOVERY_SESSION } from "./native-recovery.ts";
import { AcpPeer } from "../acp.ts";
import type { AdapterDefinition } from "../registry-types.ts";
import { buildQwenLaunch, qwenNativeIdentity, qwenSessionId, QWEN_MODE_IDS } from "./qwen-native.ts";
import { shellQuote } from "../../cli/shell-quote.ts";

/** Production Qwen policy. Legacy AcpPeer callers opt in separately through qwen025. */
export const QWEN_DEFINITION: AdapterDefinition = {
  api: 1,
  kind: "qwen",
  displayName: "Qwen Code",
  family: "qwen",
  transport: "acp",
  roles: ["implementer", "verifier"],
  optional: true,
  defaultOnRoster: false,
  trust: { onPrem: false, hubSandboxed: false },
  start: {
    daemonPort: "acp",
    forms: ["headless"],
    defaultForm: "headless",
    ownsTerminal: () => false,
    conductorStartable: true,
    hubSwitches: [],
    ownedFlags: [],
    preflight: request => request.form !== undefined && request.form !== "headless"
      ? "Qwen TUI is not offered before its native verification; use ahub qwen --mode headless" : undefined,
    launch: context => {
      if (context.form !== "headless") throw new Error("Qwen TUI is not offered before its native verification; use ahub qwen --mode headless");
      const launch = buildQwenLaunch(context.nativeCommand ?? ["qwen", "--acp"], context.model);
      const argv = [launch.cmd, ...launch.args];
      return { ...launch, metadata: { packageEntrypoint: context.entrypoint, argv, command: argv.map(shellQuote).join(" "), env: {} } };
    },
    create: context => {
      if (!("acp" in context.daemon)) throw new Error("Qwen requires its ACP transport options");
      if (context.permission === "read-only") throw new Error("Qwen has no verified read-only permission mapping");
      return new AcpPeer(context.instance, { ...context.daemon.acp, qwen025: true, permissionMode: context.permission, mcpServers: context.mcpServers });
    },
    conductorStartArgs: args => args.length ? new Error("Qwen start takes no conductor overrides") : {},
  },
  identity: { mcp: "acp-session" },
  permission: {
    modes: {
      ask: { kind: "acp-mode", modeId: QWEN_MODE_IDS.ask },
      "ask-when-needed": { kind: "acp-mode", modeId: QWEN_MODE_IDS["ask-when-needed"] },
      "never-ask": { kind: "acp-mode", modeId: QWEN_MODE_IDS["never-ask"] },
    },
    grants: {
      ask: "every write, edit and shell command asks",
      "ask-when-needed": "Qwen auto-edit approves file edits; shell commands ask; NO hub sandbox",
      "never-ask": "Qwen yolo approves every tool; NO hub sandbox",
    },
  },
  session: {
    idField: "sessionId",
    currentId: peer => {
      const sessionId = peer.recoveryMetadata?.().sessionId;
      return typeof sessionId === "string" ? sessionId : undefined;
    },
    ...QWEN_RECOVERY_SESSION,
    launchKind: "acp",
    resumeById: true,
    crashIdentity: row => {
      const sessionId = row && typeof row === "object" ? (row as { sessionId?: unknown }).sessionId : undefined;
      return qwenSessionId(sessionId) ? { sessionId } : {};
    },
  },
  turnEnd: "adapter",
  budget: { account: "qwen" },
  capabilities: { watch: true },
  cli: { command: "qwen", startWords: () => ["qwen"] },
  display: QWEN_DISPLAY,
  hooks: { agentIdentity: init => { qwenNativeIdentity("qwen", true, init); }, recallPlatform: "qwen" },
};
