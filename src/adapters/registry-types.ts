import type { RecoveryPeer } from "../cli/upgrade.ts";
import type { Launch, StatusLineTee, FactsHook } from "../cli/launch.ts";
import type { LaunchMetadata, TerminalBinding, SessionRef } from "../cli/terminal-recovery.ts";
import type { UsageWindow } from "../hub/budget.ts";
import type { ContextReading } from "../hub/context-window.ts";
import type { PeerAdapter } from "../hub/peers.ts";
import type { PermissionMode } from "../hub/permission-mode.ts";
import type { AcpOptions } from "./acp.ts";
import type { CodexOptions } from "./codex-appserver.ts";
import type { JcodeOptions } from "./jcode.ts";
import type { LocalOptions } from "./local-worker.ts";
import type { PiOptions } from "./pi.ts";

export type StartForm = "tui" | "headless";
export type DaemonEngine = "codex-appserver" | "acp" | "owned-acp" | "pi-rpc" | "local-worker";

/** Existing buildLaunch inputs plus the startup-bound instance and project identity. */
export interface LaunchContext {
  instance: string;
  form: StartForm;
  projectRoot: string;
  stateDir: string;
  entrypoint: string;
  userArgs: string[];
  unattended: boolean;
  proxyUrl?: string;
  codexBin?: string;
  statusLine?: StatusLineTee;
  facts?: FactsHook;
  preview?: boolean;
  model?: string;
  fresh?: boolean;
  env: Readonly<Record<string, string>>;
  /** Existing validated config argv (or the existing redacted preview), never model input. */
  nativeCommand?: readonly string[];
  /** Existing trusted Pi builder inputs; never populated from a request or model. */
  pi?: {
    options: Pick<PiOptions, "stateDir" | "cmd" | "mode" | "backend" | "model" | "relay" | "tools" | "preamble" | "maxSteps" | "sessionFile" | "sessionId">;
    extension: string;
    bridgePort: number | string;
    bridgeToken: string;
  };
}

export type LaunchPlan = Launch & { env?: NodeJS.ProcessEnv; metadata: LaunchMetadata; mcpFile?: { path: string; entry: unknown } };

/** A factory receives exactly its existing transport options, with no cross-transport callback widening. */
export type DaemonPorts =
  | { codex: CodexOptions }
  | { acp: AcpOptions }
  | { jcode: JcodeOptions }
  | { pi: PiOptions }
  | { local: LocalOptions };

export interface CreateContext<Ports extends DaemonPorts = DaemonPorts> {
  instance: string;
  projectRoot: string;
  stateDir: string;
  kindConfig: unknown;
  permission: PermissionMode | "read-only";
  mcpServers: NonNullable<AcpOptions["mcpServers"]>;
  daemon: Ports;
}

export interface StartRequest {
  instance: string;
  form?: StartForm;
  model?: string;
  route?: string;
  unattended?: boolean;
  replaceSession?: boolean;
  existing?: PeerAdapter;
}

export interface VersionContext {
  instance: string;
  observedVersion?: string;
  nativeCommand?: readonly string[];
  projectRoot?: string;
  peer?: PeerAdapter;
  env: Readonly<Record<string, string>>;
}

export type NativeModeSpec =
  | { kind: "acp-mode"; modeId: string }
  | { kind: "codex-approval"; policy: string }
  | { kind: "launch-flag"; argv: string[] }
  | { kind: "hub-gate"; allow: readonly ("read" | "search" | "think")[] }
  | { kind: "native-only"; note: string };

export interface QuotaReader {
  source: string;
  read(value: unknown): UsageWindow[];
  resetOnWindow?: boolean;
}

export interface ContextReader {
  source: ContextReading["source"];
  read(value: unknown, sessionId: string, measuredAt: number): ContextReading;
}

export interface CapabilityManifest {
  capabilities: {
    id: string;
    kind: "command" | "skill" | "mcp_tool";
    name: string;
    description: string;
    inputSchema?: unknown;
    sideEffect: "read" | "write" | "exec" | "external";
  }[];
}

/** Only the frozen native seams are extensible; a definition cannot add an arbitrary daemon callback. */
export interface NativeHooks {
  agentIdentity(init: unknown): void;
  onAttach(instance: string): void;
  onDetach(instance: string): void;
  factsHook: (msg: unknown) => unknown;
  conversationRevert(turnId: string): Promise<void>;
  replaceSession(req: StartRequest): Promise<unknown>;
  pluginInventory(env: Readonly<Record<string, string>>): string[];
  recallPlatform: string;
}

/** Adapter API 1, including the merged revision-3 members frozen in issue #451. */
export interface AdapterDefinition {
  api: 1;
  kind: string;
  displayName: string;
  family: string;
  transport: "acp" | "codex-appserver" | "claude-channel" | "ws-pull" | "hub-native";
  roles: readonly string[];
  optional?: boolean;
  defaultOnRoster?: boolean;
  trust: { onPrem: boolean; hubSandboxed: boolean };
  start: {
    forms: readonly StartForm[];
    defaultForm: StartForm;
    ownsTerminal(form: StartForm): boolean;
    launch(ctx: LaunchContext): LaunchPlan;
    create?(ctx: CreateContext): PeerAdapter;
    daemonPort?: DaemonEngine;
    preflight?(ctx: StartRequest): string | undefined;
    version?(ctx: VersionContext): string | undefined;
    conductorStartable: boolean;
    passthrough?: boolean;
    autoStart?: "pi.auto_start";
    unattended?: boolean;
    hubSwitches: readonly string[];
    ownedFlags: readonly string[];
    conductorStartArgs?(args: string[]): { mode?: StartForm } | Error;
  };
  identity: { mcp: "acp-session" | "project-file" | "env" | "channel-plugin" };
  attach?: { pullOnlyForms?: readonly StartForm[] };
  permission: {
    modes: Partial<Record<PermissionMode, NativeModeSpec>>;
    grants?: Partial<Record<PermissionMode, string>>;
    readOnly?: NativeModeSpec;
    unmanaged?: string;
    unmanagedForms?: readonly StartForm[];
    unmanagedNote?: string;
  };
  session: {
    idField: "sessionId" | "threadId";
    currentId(peer: PeerAdapter): string | undefined;
    configDirEnv?: "CODEX_HOME" | "CLAUDE_CONFIG_DIR";
    resumeArgv?(binding: SessionRef, fresh: boolean): string[];
    transcriptPath?(binding: TerminalBinding): string | undefined;
    transcriptExists?(binding: TerminalBinding): boolean | "unknown";
    zeroTurnFresh?: boolean;
    zeroTurn?(ctx: { stateDir: string; binding: TerminalBinding; phase: "plan" | "attach" | "verify" }): boolean;
    restoreArgs?(peer: RecoveryPeer): Record<string, string>;
    recoveryRefusal?(peer: RecoveryPeer, phase?: "plan" | "restore"): string | undefined;
    personFresh?: boolean;
    missingEvidence?: "rollout" | "transcript";
    /** Fixed source-only compatibility reads used by released recovery coordinators. */
    legacyTargetSupport?: { file: "src/hub/peer-catalog.ts"; exportName: "OPTIONAL_PEERS"; refusal: string };
    legacyHeadlessArgv?: { file: "src/hub/start-mode.ts"; exportName: "START_MODE_PEERS"; argv: readonly string[] };
    freshOnRestore?: boolean;
    /** The daemon restores recorded startup options before auto-starting this kind. */
    restoreOnStart?: boolean;
    /** Recovery passes the verified native session id to this kind's start command. */
    resumeById?: boolean;
    launchKind?: string;
    launchRecord?: boolean;
    crashIdentity?(row: unknown): { sessionId?: string; sessionFile?: string };
  };
  turnEnd: "adapter" | "native-hook";
  budget?: { account: string; reader?: QuotaReader; context?: ContextReader; checkpoint?: boolean };
  capabilities?: { manifest?(peer: PeerAdapter): Promise<CapabilityManifest>; watch?: boolean };
  init?: {
    templateFragment?: string;
    mcpFile?: string;
    /** Pure planner; the CLI host owns every write and cleanup. */
    mcpPlan?(ctx: { projectRoot: string; stateDir: string; entrypoint: string; form: StartForm }): { file: string; tracked: boolean; changed: boolean; action: string };
  };
  cli: {
    command: string;
    /** Restrictions only; core identity remains authoritative. */
    authority?: "person" | "conductor";
    personOnlyFlags?: readonly string[];
    startWords(form: StartForm): string[];
    stopNotice?(form: StartForm, owner: PeerAdapter | undefined): string;
  };
  display: { palette: { fg: string; bg: string; tone?: string; ansi?: string } };
  hooks?: Partial<NativeHooks>;
}
