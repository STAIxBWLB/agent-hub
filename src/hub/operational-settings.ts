import type { SettingDef } from "./settings.ts";

/** Numeric operational metadata only: existing schema, settings and reload retain all authority. */
export interface OperationalNumberSetting extends Pick<SettingDef, "key" | "group" | "label" | "path" | "applies" | "restartReason"> {
  type: "number" | "integer";
  store: "config";
  risk: "raises";
  min: number;
  max: number;
  defaultValue: number;
  unit: string;
  /** The independently classified H0 item, not a safety floor or wire/storage contract. */
  inventory: string;
}

export const GROOM_FYI_WINDOW_SETTING = {
  key: "tasks.groom_fyi_window_min",
  path: ["tasks", "groom_fyi_window_min"],
  group: "Routing",
  label: "Planner state-update FYI interval (minutes)",
  type: "number",
  store: "config",
  risk: "raises",
  applies: "live",
  min: 1,
  max: 1440,
  defaultValue: 10,
  unit: "minutes",
  inventory: "src/hub/tasks.ts:GROOM_FYI_WINDOW_MS",
} as const satisfies OperationalNumberSetting;

const taskNumber = <const T extends Omit<OperationalNumberSetting, "group" | "store" | "risk" | "applies">>(def: T) => ({ group: "Routing", store: "config", risk: "raises", applies: "live", ...def }) as const satisfies OperationalNumberSetting;

/** #489 H2, tasks and routing. Each default equals the constant it replaces (pinned in test/operational-settings.test.ts); none is a safety floor or a contract. */
export const DEMOTE_AT_SETTING = taskNumber({
  key: "tasks.demote_at", path: ["tasks", "demote_at"], label: "Peer demotion threshold (decayed recent failures)",
  type: "number", min: 0.5, max: 20, defaultValue: 1.5, unit: "failures", inventory: "src/hub/tasks.ts:DEMOTE_AT",
});
export const DEMOTION_HALF_LIFE_SETTING = taskNumber({
  key: "tasks.demotion_half_life_h", path: ["tasks", "demotion_half_life_h"], label: "Demotion half-life: a failure counts half after (hours)",
  type: "number", min: 1, max: 168, defaultValue: 24, unit: "hours", inventory: "src/hub/tasks.ts:DEMOTION_HALF_LIFE_MS",
});
export const CONTRADICTION_WINDOW_SETTING = taskNumber({
  key: "tasks.contradiction_window_days", path: ["tasks", "contradiction_window_days"], label: "Approval contradiction window (days)",
  type: "number", min: 1, max: 90, defaultValue: 7, unit: "days", inventory: "src/hub/tasks.ts:CONTRADICTION_WINDOW_MS",
});
export const RESCREEN_MAX_SETTING = taskNumber({
  key: "tasks.rescreen_max", path: ["tasks", "rescreen_max"], label: "PII re-screen attempts per task in a hub run",
  type: "integer", min: 1, max: 100, defaultValue: 10, unit: "attempts", inventory: "src/hub/tasks.ts:RESCREEN_MAX",
});
export const SPLIT_MIN_SETTING = taskNumber({
  key: "tasks.split_min_observations", path: ["tasks", "split_min_observations"], label: "Shadow split prediction: measured tasks a peer needs",
  type: "integer", min: 3, max: 100, defaultValue: 5, unit: "tasks", inventory: "src/hub/routing.ts:SPLIT_MIN",
});
export const SPLIT_FAILURE_SHARE_SETTING = taskNumber({
  key: "tasks.split_max_failure_share", path: ["tasks", "split_max_failure_share"], label: "Shadow split prediction: failed share a history may hold",
  type: "number", min: 0, max: 1, defaultValue: 0.3, unit: "share", inventory: "src/hub/routing.ts:SPLIT_FAILURE_SHARE",
});

const busNumber = <const T extends Omit<OperationalNumberSetting, "group" | "store" | "risk" | "applies" | "type" | "min">>(def: T) => ({ group: "Routing", store: "config", risk: "raises", applies: "live", type: "integer", min: 1, ...def }) as const satisfies OperationalNumberSetting;

export const BUS_MAX_ATTEMPTS_SETTING = busNumber({
  key: "bus.max_attempts", path: ["bus", "max_attempts"], label: "Safe-failure delivery attempts",
  max: 100, defaultValue: 3, unit: "attempts", inventory: "src/hub/bus.ts:MAX_ATTEMPTS",
});
export const BUS_DIGEST_MAX_SETTING = busNumber({
  key: "bus.digest_max", path: ["bus", "digest_max"], label: "Maximum originals in a push digest",
  max: 10, defaultValue: 10, unit: "envelopes", inventory: "src/hub/bus.ts:DIGEST_MAX",
});
export const BUS_PULL_BUDGET_BYTES_SETTING = busNumber({
  key: "bus.pull_budget_bytes", path: ["bus", "pull_budget_bytes"], label: "Pull rendered-text budget (bytes)",
  max: 65_536, defaultValue: 65_536, unit: "bytes", inventory: "src/hub/bus.ts:PULL_BUDGET_BYTES",
});
export const BUS_NOTES_KEPT_SETTING = busNumber({
  key: "bus.notes_kept", path: ["bus", "notes_kept"], label: "Shared notes retained in a merged preface",
  max: 10, defaultValue: 10, unit: "notes", inventory: "src/hub/bus.ts:NOTES_KEPT",
});
export const BUS_TERMINAL_HISTORY_LIMIT_SETTING = busNumber({
  key: "bus.terminal_history_limit", path: ["bus", "terminal_history_limit"], label: "Unprotected terminal delivery history target",
  max: 2048, defaultValue: 2048, unit: "rows", inventory: "src/hub/delivery-journal.ts:TERMINAL_CAP",
});

/**
 * #489 H4, recovery and upgrade waits. These are read by the upgrade coordinator (a CLI process) from the project's own config at the START of each wait, so a change applies at the next wait and a wait
 * already running keeps its deadline. Every row's minimum is today's constant: a person-visible wait can be raised, never cut below what ships (a request that times out may already have applied, and a
 * shorter reconnect wait fails a recovery earlier than the person was told). The one row that may shorten, `recovery.terminal_idle_wait_s`, only ends a wait in manual-required, which retains the terminal.
 */
const recoveryNumber = <const T extends Omit<OperationalNumberSetting, "group" | "store" | "risk" | "applies" | "type">>(def: T) => ({ group: "Routing", store: "config", risk: "raises", applies: "next use", type: "integer", ...def }) as const satisfies OperationalNumberSetting;
export const RECOVERY_RECONNECT_WAIT_SETTING = recoveryNumber({
  key: "recovery.reconnect_wait_s", path: ["recovery", "reconnect_wait_s"], label: "Upgrade recovery: wait for a managed terminal to attach (seconds)",
  min: 600, max: 3600, defaultValue: 600, unit: "seconds", inventory: "src/cli/upgrade-runtime.ts:RECONNECT_WAIT_MS",
});
export const RECOVERY_UNMANAGED_RECONNECT_WAIT_SETTING = recoveryNumber({
  key: "recovery.unmanaged_reconnect_wait_s", path: ["recovery", "unmanaged_reconnect_wait_s"], label: "Upgrade recovery: wait for an unmanaged Claude to reconnect (seconds)",
  min: 90, max: 900, defaultValue: 90, unit: "seconds", inventory: "src/cli/upgrade-runtime.ts:UNMANAGED_RECONNECT_WAIT_MS",
});
export const RECOVERY_CONTROL_TIMEOUT_SETTING = recoveryNumber({
  key: "recovery.control_timeout_s", path: ["recovery", "control_timeout_s"], label: "Upgrade recovery: wait for one control request to a hub (seconds)",
  min: 30, max: 300, defaultValue: 30, unit: "seconds", inventory: "src/cli/upgrade-runtime.ts:RECOVERY_CONTROL_TIMEOUT_MS",
});
export const RECOVERY_SHUTDOWN_WAIT_SETTING = recoveryNumber({
  key: "recovery.shutdown_wait_s", path: ["recovery", "shutdown_wait_s"], label: "Upgrade recovery: wait for the old hub to stop after commit (seconds)",
  min: 30, max: 300, defaultValue: 30, unit: "seconds", inventory: "src/cli/upgrade.ts:deadline",
});
export const RECOVERY_TERMINAL_IDLE_WAIT_SETTING = recoveryNumber({
  key: "recovery.terminal_idle_wait_s", path: ["recovery", "terminal_idle_wait_s"], label: "Upgrade recovery: wait for a terminal to go idle before closing it (seconds)",
  min: 30, max: 600, defaultValue: 120, unit: "seconds", inventory: "src/cli/upgrade-runtime.ts:waitForIdle",
});

const adapterNumber = <const T extends Omit<OperationalNumberSetting, "group" | "store" | "risk" | "applies" | "type">>(def: T) => ({ group: "Start", store: "config", risk: "raises", applies: "next use", type: "integer", ...def }) as const satisfies OperationalNumberSetting;
export const ACP_TOOL_CEILING_SETTING = adapterNumber({
  key: "adapter_timing.acp_tool_ceiling_min", path: ["adapter_timing", "acp_tool_ceiling_min"], label: "Next ACP launch: open-tool ceiling (minutes, at least the watchdog)",
  min: 1, max: 30, defaultValue: 30, unit: "minutes", inventory: "src/adapters/acp.ts:TOOL_CEILING_MS",
});
export const ACP_ACTIVITY_BATCH_SETTING = adapterNumber({
  key: "adapter_timing.acp_activity_batch_ms", path: ["adapter_timing", "acp_activity_batch_ms"], label: "Next ACP launch: activity display batch delay (milliseconds)",
  min: 10, max: 50, defaultValue: 50, unit: "milliseconds", inventory: "src/adapters/acp.ts:setTimeout",
});
export const JCODE_STEER_TIMEOUT_SETTING = adapterNumber({
  key: "adapter_timing.jcode_steer_timeout_s", path: ["adapter_timing", "jcode_steer_timeout_s"], label: "Next Jcode launch: total native steer deadline (seconds)",
  min: 5, max: 60, defaultValue: 5, unit: "seconds", inventory: "src/adapters/jcode.ts:STEER_TIMEOUT_MS",
});

/** Fixed metadata; never registration from a file, request, adapter or environment variable. */
export const OPERATIONAL_NUMBERS: readonly OperationalNumberSetting[] = [GROOM_FYI_WINDOW_SETTING, DEMOTE_AT_SETTING, DEMOTION_HALF_LIFE_SETTING, CONTRADICTION_WINDOW_SETTING, RESCREEN_MAX_SETTING, SPLIT_MIN_SETTING, SPLIT_FAILURE_SHARE_SETTING,
  BUS_MAX_ATTEMPTS_SETTING, BUS_DIGEST_MAX_SETTING, BUS_PULL_BUDGET_BYTES_SETTING, BUS_NOTES_KEPT_SETTING, BUS_TERMINAL_HISTORY_LIMIT_SETTING,
  RECOVERY_RECONNECT_WAIT_SETTING, RECOVERY_UNMANAGED_RECONNECT_WAIT_SETTING, RECOVERY_CONTROL_TIMEOUT_SETTING, RECOVERY_SHUTDOWN_WAIT_SETTING, RECOVERY_TERMINAL_IDLE_WAIT_SETTING,
  ACP_TOOL_CEILING_SETTING, ACP_ACTIVITY_BATCH_SETTING, JCODE_STEER_TIMEOUT_SETTING];
/** The `tasks` leaves the six #489 H2 readers need; `HubConfig.tasks` has them all. */
export interface TaskOperationalConfig { tasks: { demote_at?: number; demotion_half_life_h?: number; contradiction_window_days?: number; rescreen_max?: number; split_min_observations?: number; split_max_failure_share?: number } }
/**
 * The one place the daemon turns the six task settings into `TasksDeps` readers. `config` is asked at every use, so a reload applies at the next demotion read, verdict, re-screen or prediction; an unset leaf is the row's default,
 * which is the constant it replaced.
 */
export const taskOperationalReaders = (config: () => TaskOperationalConfig) => ({
  demoteAt: () => config().tasks.demote_at ?? DEMOTE_AT_SETTING.defaultValue,
  demotionHalfLifeH: () => config().tasks.demotion_half_life_h ?? DEMOTION_HALF_LIFE_SETTING.defaultValue,
  contradictionWindowDays: () => config().tasks.contradiction_window_days ?? CONTRADICTION_WINDOW_SETTING.defaultValue,
  rescreenMax: () => config().tasks.rescreen_max ?? RESCREEN_MAX_SETTING.defaultValue,
  splitMinObservations: () => config().tasks.split_min_observations ?? SPLIT_MIN_SETTING.defaultValue,
  splitMaxFailureShare: () => config().tasks.split_max_failure_share ?? SPLIT_FAILURE_SHARE_SETTING.defaultValue,
});
export interface BusOperationalConfig { bus?: { max_attempts?: number; digest_max?: number; pull_budget_bytes?: number; notes_kept?: number; terminal_history_limit?: number } }
/** Read accepted configuration at the next operation; a reload itself never trims or retries work. */
export const busOperationalReaders = (config: () => BusOperationalConfig) => ({
  maxAttempts: () => config().bus?.max_attempts ?? BUS_MAX_ATTEMPTS_SETTING.defaultValue,
  digestMax: () => config().bus?.digest_max ?? BUS_DIGEST_MAX_SETTING.defaultValue,
  pullBudgetBytes: () => config().bus?.pull_budget_bytes ?? BUS_PULL_BUDGET_BYTES_SETTING.defaultValue,
  notesKept: () => config().bus?.notes_kept ?? BUS_NOTES_KEPT_SETTING.defaultValue,
  terminalHistoryLimit: () => config().bus?.terminal_history_limit ?? BUS_TERMINAL_HISTORY_LIMIT_SETTING.defaultValue,
});
export interface RecoveryOperationalConfig { recovery?: { reconnect_wait_s?: unknown; unmanaged_reconnect_wait_s?: unknown; control_timeout_s?: unknown; shutdown_wait_s?: unknown; terminal_idle_wait_s?: unknown } }
export interface RecoveryWaits { reconnectWaitMs: number; unmanagedReconnectWaitMs: number; controlTimeoutMs: number; shutdownWaitMs: number; terminalIdleWaitMs: number }
const recoveryMs = (def: OperationalNumberSetting, raw: unknown): number => {
  // A value outside the row's bounds, a non-integer or a non-number is the default, never an error inside a recovery: the file was validated when it was written, and a recovery must not fail on a later edit.
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= def.min && raw <= def.max ? raw * 1000 : def.defaultValue * 1000;
};
/** The one place the coordinator turns the five recovery settings into milliseconds. `config` is asked at each wait, so the next wait reads the file as it is then. */
export const recoveryWaits = (config: () => RecoveryOperationalConfig | undefined): RecoveryWaits => {
  const leaf = config()?.recovery;
  return {
    reconnectWaitMs: recoveryMs(RECOVERY_RECONNECT_WAIT_SETTING, leaf?.reconnect_wait_s),
    unmanagedReconnectWaitMs: recoveryMs(RECOVERY_UNMANAGED_RECONNECT_WAIT_SETTING, leaf?.unmanaged_reconnect_wait_s),
    controlTimeoutMs: recoveryMs(RECOVERY_CONTROL_TIMEOUT_SETTING, leaf?.control_timeout_s),
    shutdownWaitMs: recoveryMs(RECOVERY_SHUTDOWN_WAIT_SETTING, leaf?.shutdown_wait_s),
    terminalIdleWaitMs: recoveryMs(RECOVERY_TERMINAL_IDLE_WAIT_SETTING, leaf?.terminal_idle_wait_s),
  };
};
export interface AdapterTimingConfig { adapter_timing?: { acp_tool_ceiling_min?: number; acp_activity_batch_ms?: number; jcode_steer_timeout_s?: number } }
/** The host captures primitive option values for a new adapter; an accepted edit never retimes an existing launch. */
export const adapterOperationalReaders = (config: () => AdapterTimingConfig) => ({
  acpToolCeilingMs: () => (config().adapter_timing?.acp_tool_ceiling_min ?? ACP_TOOL_CEILING_SETTING.defaultValue) * 60_000,
  acpActivityBatchMs: () => config().adapter_timing?.acp_activity_batch_ms ?? ACP_ACTIVITY_BATCH_SETTING.defaultValue,
  jcodeSteerTimeoutMs: () => (config().adapter_timing?.jcode_steer_timeout_s ?? JCODE_STEER_TIMEOUT_SETTING.defaultValue) * 1000,
});
export const operationalNumber = (key: string): OperationalNumberSetting | undefined => OPERATIONAL_NUMBERS.find(def => def.key === key);
