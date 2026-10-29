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

/** Fixed metadata; never registration from a file, request, adapter or environment variable. */
export const OPERATIONAL_NUMBERS: readonly OperationalNumberSetting[] = [GROOM_FYI_WINDOW_SETTING];
export const operationalNumber = (key: string): OperationalNumberSetting | undefined => OPERATIONAL_NUMBERS.find(def => def.key === key);
