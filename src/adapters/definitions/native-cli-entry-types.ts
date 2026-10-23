import type { HubConfig } from "../../hub/daemon.ts";
import type { ControlClient } from "../../hub/control-client.ts";
import type { AdapterDefinition } from "../registry-types.ts";

/** Private static builtin relocation ports. The CLI binds identity, project and authority before invocation. */
export interface NativeCliEntryContext {
  instance?: string; executionCwd?: string;
  /** #223: the selected instance is started by the hub (a headless reviewer), never as a terminal launch. */
  hubStarted?: true;
  person?: boolean;
  args: string[]; cwd: string; stateDir: string; cliDir: string; unattendedEnv: boolean; definition: AdapterDefinition;
  projectConfig(): HubConfig;
  connect(): Promise<ControlClient>;
  fail(message: string): never;
  exec(bin: string, argv: string[], tool?: "claude" | "codex" | "kimi"): never;
  execWithEnv(bin: string, argv: string[], extra: NodeJS.ProcessEnv): never;
  takeFlags(argv: string[], single: string[], repeated: string[]): { one: Record<string, string>; many: Record<string, string[]>; rest: string[] };
  helpers: {
    /** Fixed host validation; the entry never chooses or creates an execution worktree. */
    resolveExecutionCwd(peer: string): string;
    launcherPreview: typeof import("../../cli/preview.ts").launcherPreview;
    readControl: typeof import("../../hub/control-client.ts").readControl;
    recordTerminalLaunch: typeof import("../../cli/terminal-recovery.ts").recordTerminalLaunch;
    prepareTerminalLaunch: typeof import("../../cli/terminal-recovery.ts").prepareTerminalLaunch;
    registerTerminalLaunch: typeof import("../../cli/terminal-recovery.ts").registerTerminalLaunch;
    recoveryLock: typeof import("../../hub/recovery-store.ts").recoveryLock;
    processSignature: typeof import("../../pi/process-signature.ts").processSignature;
    buildLaunch: typeof import("../../cli/launch.ts").buildLaunch;
    claudeObservationHooks: typeof import("../../cli/launch.ts").claudeObservationHooks;
    recordClaudeLaunch: typeof import("../../cli/launch.ts").recordClaudeLaunch;
    cleanupStaleClaudeSettings: typeof import("../../cli/launch.ts").cleanupStaleClaudeSettings;
    cleanupClaudeSettings: typeof import("../../cli/launch.ts").cleanupClaudeSettings;
    nativeLaunchEnv: typeof import("../../cli/launch.ts").nativeLaunchEnv;
    runClaudeLaunch: typeof import("../../cli/launch.ts").runClaudeLaunch;
    childEnv: typeof import("../../hub/child-process.ts").childEnv;
    qwenSessionId: typeof import("../../hub/crash.ts").qwenSessionId;
    configureJcodeMcp: typeof import("../../cli/jcode-mcp.ts").configureJcodeMcp;
    configureKimiMcp: typeof import("../../cli/kimi-mcp.ts").configureKimiMcp;
    buildKimiTuiLaunch: typeof import("../../cli/launch.ts").buildKimiTuiLaunch;
    startModeOf: typeof import("../../hub/start-mode.ts").startModeOf;
  };
}
export interface BuiltinCliEntry {
  command: string;
  /** Original CLI guard timing: previews precede it; Pi/local retain their daemon-enforced start admission. */
  lifecycleAdmission: boolean;
  execute(context: NativeCliEntryContext): Promise<void>;
}
