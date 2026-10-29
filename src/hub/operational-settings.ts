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

/** Fixed metadata; never registration from a file, request, adapter or environment variable. */
export const OPERATIONAL_NUMBERS: readonly OperationalNumberSetting[] = [GROOM_FYI_WINDOW_SETTING, DEMOTE_AT_SETTING, DEMOTION_HALF_LIFE_SETTING, CONTRADICTION_WINDOW_SETTING, RESCREEN_MAX_SETTING, SPLIT_MIN_SETTING, SPLIT_FAILURE_SHARE_SETTING];
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
export const operationalNumber = (key: string): OperationalNumberSetting | undefined => OPERATIONAL_NUMBERS.find(def => def.key === key);
