import { expect, test } from "bun:test";
import { SETTINGS, checkSettingValue, parseSettingText, settingDef } from "../src/hub/settings.ts";

const def = (key: string) => {
  const value = settingDef(key);
  expect(typeof value).toBe("object");
  if (typeof value === "string") throw new Error(value);
  return value;
};

test("#439 registry uses canonical apply classes and explains every restart", () => {
  for (const entry of SETTINGS) {
    expect(["live", "next use", "restart"]).toContain(entry.applies);
    if ((entry.applies as string) === "restart") expect(typeof (entry as unknown as { restartReason?: string }).restartReason).toBe("string");
  }
  for (const key of ["approvals.notify", "research.enabled", "snapshots.enabled", "tasks.wip_limits.codex"]) expect(def(key).applies).toBe("live");
  for (const key of ["permission_modes.codex", "catalog_roles.codex", "peers.codex.start_mode", "coordination", "pi.auto_start"]) expect(def(key).applies).toBe("next use");
});

test("#439 task sweep registry exposes boolean switches with guarded disabled floors", () => {
  for (const key of ["enabled", "auto_reassign"]) {
    const entry = def(`task_sweep.${key}`);
    expect(entry).toMatchObject({ type: "boolean", store: "config", applies: "live", risk: "raises", floor: false, path: ["task_sweep", key] });
    expect(checkSettingValue(entry, false)).toBe(false); expect(checkSettingValue(entry, true)).toBe(true);
    expect(() => checkSettingValue(entry, "true")).toThrow();
  }
});

test("#439 task sweep duration settings preserve bounded fractional values", () => {
  for (const key of ["interval_s", "unaccepted_min", "idle_min", "review_min", "ready_min", "ladder_min"]) {
    const entry = def(`task_sweep.${key}`), max = 2_147_483_647 / (key === "interval_s" ? 1000 : 60_000);
    expect(entry).toMatchObject({ type: "number", store: "config", applies: "live", min: 1, max, path: ["task_sweep", key] });
    expect(parseSettingText(entry, "1.5")).toBe(1.5); expect(checkSettingValue(entry, 1.5)).toBe(1.5);
    expect(checkSettingValue(entry, max)).toBe(max); expect(checkSettingValue(entry, null)).toBeNull();
    for (const value of [0, 0.5, max + 1, NaN, Infinity, "1.5"]) expect(() => checkSettingValue(entry, value)).toThrow();
  }
});
