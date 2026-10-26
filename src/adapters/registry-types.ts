import type { ClaudeImplementerOptions } from "./claude-implementer.ts";
import type { ReviewerBackend, ReviewerPrintOptions } from "./reviewer-print.ts";
import type { SettingDef } from "../hub/settings.ts";
import type { Addon } from "../hub/tooling.ts";
import type { RecoveryContinuityBookmark } from "../hub/recovery-continuity.ts";
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
import type { QwenDualOptions } from "./qwen-dual.ts";
import type { ClaudePrintOptions } from "./claude-print.ts";

import type { BuiltinCliEntry } from "./definitions/native-cli-entry-types.ts";
import type { NativePreviewBuilder } from "./definitions/native-cli-preview-common.ts";

export type StartForm = "tui" | "headless";
export type DaemonEngine = "codex-appserver" | "acp" | "qwen-dual" | "owned-acp" | "pi-rpc" | "local-worker" | "claude-print" | "reviewer-print" | "claude-implementer";

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
  /** Env var holding the terminal launch id; Codex sends it as the proxy upgrade's bearer token (#586). */
  launchTokenEnv?: string;
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
  | { qwenDual: QwenDualOptions }
  | { jcode: JcodeOptions }
  | { pi: PiOptions }
  | { local: LocalOptions }
  | { claudePrint: ClaudePrintOptions }
  | { reviewerPrint: ReviewerPrintOptions }
  | { claudeImplementer: ClaudeImplementerOptions };

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

/** Compatibility type for frozen A1 permission metadata, not a runtime permission port. */
export type NativeModeSpec =
  | { kind: "acp-mode"; modeId: string }
  | { kind: "codex-approval"; policy: string }
  | { kind: "launch-flag"; argv: string[] }
  | { kind: "hub-gate"; allow: readonly ("read" | "search" | "think")[] }
  | { kind: "native-only"; note: string };

export interface QuotaReader {
  source: string;
  read(value: unknown): UsageWindow[];
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

export interface NativeFactsInput {
  event: "SessionStart" | "PreInvocation" | "PostInvocation" | "PreToolUse" | "PostToolUse" | "Stop";
  phase: "session" | "start" | "pre" | "post" | "stop";
  sessionId: string;
  transcriptPath: string;
  workspacePaths: string[];
  tool: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  invocation?: number;
  fullyIdle?: boolean;
  terminationReason?: string;
}
export interface NativeFactsTranscript {
  completion?: { id: string; index: number };
  factIds: string[];
}
/** Fixed native codec and bounded readback, never supplied by project configuration. */
export interface NativeFactsPort {
  decode(event: string, input: unknown): NativeFactsInput | undefined;
  encode(event: string, text?: string): Record<string, unknown> | undefined;
  read(session: string, transcript: string): NativeFactsTranscript;
}

/** Only the frozen native seams are extensible; a definition cannot add an arbitrary daemon callback. */
export interface NativeHooks {
  factsHook: NativeFactsPort;
  pluginInventory(ctx: { home: string; cwd?: string; env: Readonly<Record<string, string | undefined>> }): Addon[];
  recallSource: string;
  recallInjected: boolean;
  classifyTool(name: string, command?: string): "edit" | undefined;
  recallPlatform: string;
}

export type NativeConfigCheck = (value: unknown, key: string) => void;
export interface NativeConfigValidators {
  bool: NativeConfigCheck; text: NativeConfigCheck; strings: NativeConfigCheck; argv: NativeConfigCheck;
  number(min?: number, max?: number, integer?: boolean): NativeConfigCheck;
  words(values: readonly string[]): NativeConfigCheck;
  block(fields: Record<string, NativeConfigCheck>): NativeConfigCheck;
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
  /** A legacy enable switch gates new starts, not retained sockets or queues. */
  enabledSwitchStartOnly?: boolean;
  trust: { onPrem: boolean; hubSandboxed: boolean };
  start: {
    forms: readonly StartForm[];
    defaultForm: StartForm;
    /** A real native argv planner; absent when startup belongs to a separate verified host port. */
    launch?(ctx: LaunchContext): LaunchPlan;
    create?(ctx: CreateContext): PeerAdapter;
    /** A second, explicit-only TUI driver for a kind whose default form stays headless (Qwen's dual-output TUI, #286 Part 3). Fixed builtins only; never an extra start mode. */
    createTui?(ctx: CreateContext): PeerAdapter;
    daemonPort?: DaemonEngine;
    preflight?(ctx: StartRequest): string | undefined;
    version?(ctx: VersionContext): string | undefined;
    conductorStartable: boolean;
    passthrough?: boolean;
    autoStart?: "pi.auto_start";
    exclusiveStartRefusal?: string;
    refreshTools?: boolean;
    explicitHeadlessMode?: boolean;
    planCommand?(form: StartForm): string;
    acpCommand?(command: readonly string[], model?: string): string[];
    reconfigureWhileAttached?: boolean;
    unattended?: boolean;
    hubSwitches: readonly string[];
    ownedFlags: readonly string[];
    conductorStartArgs?(args: string[]): { mode?: StartForm } | Error;
  };
  identity: { mcp: "acp-session" | "project-file" | "env" | "channel-plugin"; currentChild?: true };
  /** Declaration admission only; execution-root and runtime owner proof remain host responsibilities. */
  instances?: { mode: "external" | "headless"; roles?: readonly string[];
    /** Each declared instance runs its own native data home (`jcode_home`) and may pass its own provider, model and profile names (#685). Fixed builtins only. */
    nativeHome?: true;
    /** A declared headless instance of this definition may pass one validated `model` word to its native child (#844). Fixed builtins only. */
    modelSelect?: true };
  attach?: {
    /** The authenticated external hello may claim this id; independent of MCP configuration shape. */
    externalHello?: boolean;
    pullOnlyForms?: readonly StartForm[];
    recoveryLaunch?(instance: string): Record<string, unknown>;
    pullOnlyNotice?: string;
    admission?: { reservedRefusal: string; watchRefusal: string };
  };
  permission: {
    /** Consumed configured-ACP mode capability; native runtime and instance ceiling use the same validated mapping. */
    genericAcp?: { modes?: Partial<Record<PermissionMode, string>>; readOnly?: string };
    grants?: Partial<Record<PermissionMode, string>>;
    unmanaged?: string;
    unmanagedForms?: readonly StartForm[];
    unmanagedNote?: string;
    unmanagedStatusNote?: string;
    trackUnattended?: boolean;
  };
  session: {
    nativeRevert?: boolean;
    crashPlan?(meta: Record<string, unknown>): { resume?: Record<string, string>; how: string; fresh?: Record<string, string>; tui?: true };
    unrecordedTerminal?: "always" | "tui";
    continuityBookmark?(peer: RecoveryPeer, binding?: TerminalBinding): Pick<RecoveryContinuityBookmark, "pi">;
    continuity?: { key: string; parse(value: unknown): unknown | undefined };
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
  reporting?: { tokensNotReported?: boolean };
  /** Legacy native routing policy; external definitions cannot claim these host-specific policies. */
  routing?: {
    /** Takes reviews only: never chosen or nominated as a task owner, for any class. */
    reviewOnly?: true;
    /** Fixed role ceiling; project roles cannot turn an unmanaged implementer into a planner/reviewer. */
    allowedRoles?: readonly string[];
    localAllowedRefusal?: string;
    longContext?: "backend-limit" | "skip-owner";
    preferredTier?: boolean;
    handoffPriority?: number;
    trace?: "route" | "backend";
    backendLabel?: string;
  };
  budget?: { account: string; quotaExempt?: boolean; /** Why this peer has no provider quota, shown by `ahub budget` and the dashboard (#285 AC6). */ noQuotaReason?: string; instrumented?: boolean; reader?: QuotaReader; context?: ContextReader; checkpoint?: boolean; resetSoftTokensOnResume?: boolean };
  configuration?: {
    schema?(ports: NativeConfigValidators): Record<string, NativeConfigCheck>;
    routingSchema?(ports: NativeConfigValidators): Record<string, NativeConfigCheck>;
    settings?: readonly SettingDef[];
    restartReasons?: Readonly<Record<string, string>>;
    validateEffective?(raw: Record<string, unknown>, fail: (key: string, reason: string) => never): void;
  };
  capabilities?: { manifest?(peer: PeerAdapter): Promise<CapabilityManifest>; watch?: boolean };
  /** Stable host projection order and planner eligibility, independent of default task roles. */
  projection?: { roleRank?: number; startRank?: number; helpRank?: number; plannerEligible?: boolean };
  cli: {
    command: string;
    /** Fixed builtin CLI ports; project definitions cannot supply these callbacks. */
    entry?: Readonly<Omit<BuiltinCliEntry, "command">>;
    preview?: NativePreviewBuilder;
    usage?: readonly (readonly [usage: string, description: string])[];
    /** Configuration leaves that select this peer's next native launch command or provider profile. */
    launchConfigKeys?: readonly string[];
    /** Restrictions only; core identity remains authoritative. */
    authority?: "person" | "conductor";
    personOnlyFlags?: readonly string[];
    startWords(form: StartForm): string[];
    stopNotice?(form: StartForm, owner: PeerAdapter | undefined): string;
    previewArgs?: readonly string[];
    retainedTerminalNotice?(instance: string, form: StartForm | undefined, resumeCommand: string): string | undefined;
    rosterReturnNotice?(resumeCommand: string): string;
  };
  display: { palette: { fg: string; bg: string; tone?: string; ansi?: string } };
  hooks?: Partial<NativeHooks>;
  /** #223: what a declared headless reviewer-only instance of this kind runs as. Fixed builtins only. */
  reviewerVariant?: AdapterDefinition;
  /** #525: fixed builtin variant for declared headless implementer instances. */
  headlessVariant?: AdapterDefinition;
  /** Fixed host backend; runtime isolation proof is required before bus admission. */
  reviewer?: { backend?: ReviewerBackend; defaultPool: boolean; unavailable?: string; declaration: "automatic" | "explicit" };
}

/** Explicit project declarations, passed by the bound host. No process-global instance registration. */
export type KindMap = Readonly<Record<string, { readonly kind: string; readonly roles?: readonly string[]; readonly start_mode?: "tui" | "headless"; readonly review_mode?: "fresh" }>>;

/** Immutable per-project resolver; exported globals remain builtin-only. */
export interface ProjectAdapterCatalog {
  readonly definitions: readonly AdapterDefinition[];
  readonly externalDefinitions: readonly AdapterDefinition[];
  definitionOf(id: string, instances?: KindMap): AdapterDefinition | undefined;
  kindOf(id: string, instances?: KindMap): string | undefined;
  familyOf(id: string, instances?: KindMap): string | undefined;
  isSupportedPeer(id: unknown, instances?: KindMap): id is string;
}
