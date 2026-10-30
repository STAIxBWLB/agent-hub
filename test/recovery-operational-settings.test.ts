import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATIONAL_NUMBERS, operationalNumber, recoveryWaits } from "../src/hub/operational-settings.ts";
import { configApply, validateOperationalConfig, validateRawConfig } from "../src/hub/config-apply.ts";
import { checkSettingValue, settingDef, settingRefusal, undoSetting, writeConfigSetting } from "../src/hub/settings.ts";
import { DEFAULT_CONFIG, loadConfig } from "../src/hub/daemon.ts";
import { readRecoveryWaits } from "../src/cli/recovery-waits.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

// What each wait was before it became a setting, in milliseconds, written out here: never imported from the code under test.
const LEGACY = { "recovery.reconnect_wait_s": 600_000, "recovery.unmanaged_reconnect_wait_s": 90_000, "recovery.control_timeout_s": 30_000, "recovery.shutdown_wait_s": 30_000, "recovery.terminal_idle_wait_s": 120_000 } as const;
const FIELD: Record<keyof typeof LEGACY, keyof ReturnType<typeof recoveryWaits>> = {
  "recovery.reconnect_wait_s": "reconnectWaitMs", "recovery.unmanaged_reconnect_wait_s": "unmanagedReconnectWaitMs", "recovery.control_timeout_s": "controlTimeoutMs",
  "recovery.shutdown_wait_s": "shutdownWaitMs", "recovery.terminal_idle_wait_s": "terminalIdleWaitMs",
};
const KEYS = Object.keys(LEGACY) as (keyof typeof LEGACY)[];
const leaf = (key: string) => key.slice("recovery.".length);
const block = (key: string, value: unknown) => ({ recovery: { [leaf(key)]: value } });
const def = (key: string) => { const d = settingDef(key); if (typeof d === "string") throw new Error(d); return d; };

/** A git repository: the machine-local file is read only when git confirms it is untracked, and a directory git cannot answer for is refused (the safe side). */
function project(git = true) {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-recovery-waits-")));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".agenthub"));
  if (git) expect(hubGitSync(["-C", cwd, "init", "-q"], { encoding: "utf8" }).status).toBe(0);
  return { cwd, shared: join(cwd, ".agenthub/config.json"), local: join(cwd, ".agenthub/config.local.json"), state: join(cwd, ".agenthub/state") };
}

test("#489 H4 unset is byte-identical: every default is the constant it replaced, the daemon default carries it, and the readers return it", () => {
  expect(KEYS.map(key => operationalNumber(key)?.defaultValue! * 1000)).toEqual(KEYS.map(key => LEGACY[key]));
  for (const key of KEYS) expect(DEFAULT_CONFIG.recovery[leaf(key) as keyof typeof DEFAULT_CONFIG.recovery], key).toBe(operationalNumber(key)!.defaultValue);
  const unset = recoveryWaits(() => undefined);
  for (const key of KEYS) expect(unset[FIELD[key]], key).toBe(LEGACY[key]);
  expect(recoveryWaits(() => ({ recovery: {} }))).toEqual(unset);
  expect(recoveryWaits(() => ({}))).toEqual(unset);
  expect(OPERATIONAL_NUMBERS.filter(row => row.key.startsWith("recovery."))).toHaveLength(5);
});

// the bounds each value may take: [key, accepted, refused]. A person-visible wait never goes below the constant that shipped.
const BOUNDS: [keyof typeof LEGACY, number[], unknown[]][] = [
  ["recovery.reconnect_wait_s", [600, 601, 3600], [0, 1, 599, 3601, 600.5, -1, NaN, Infinity, "600", true, null, []]],
  ["recovery.unmanaged_reconnect_wait_s", [90, 91, 900], [0, 1, 89, 901, 90.5, -1, NaN, Infinity, "90", true, null, []]],
  ["recovery.control_timeout_s", [30, 31, 300], [0, 1, 29, 301, 30.5, -1, NaN, Infinity, "30", true, null, []]],
  ["recovery.shutdown_wait_s", [30, 31, 300], [0, 1, 29, 301, 30.5, -1, NaN, Infinity, "30", true, null, []]],
  ["recovery.terminal_idle_wait_s", [30, 120, 600], [0, 1, 29, 601, 30.5, -1, NaN, Infinity, "120", true, null, []]],
];
for (const [key, accepted, refused] of BOUNDS) {
  test(`#489 H4 ${key}: schema, startup validation and the UI check share one set of bounds, and only a settings session or a terminal may set it`, () => {
    const d = def(key);
    expect(d).toMatchObject({ type: "integer", store: "config", applies: "next use", risk: "raises" });
    expect(configApply(key)).toEqual({ applies: "next use" });
    for (const value of accepted) {
      expect(checkSettingValue(d, value)).toBe(value);
      expect(() => validateRawConfig(block(key, value))).not.toThrow();
      expect(() => validateOperationalConfig(block(key, value))).not.toThrow();
    }
    for (const value of refused) {
      if (value !== null) expect(() => checkSettingValue(d, value), String(value)).toThrow();
      expect(() => validateRawConfig(block(key, value)), String(value)).toThrow(key);
      expect(() => validateOperationalConfig(block(key, value)), String(value)).toThrow(key);
    }
    expect(checkSettingValue(d, null)).toBeNull();
    expect(settingRefusal(d, accepted[1]!, "ordinary")).toContain("settings session");
    expect(settingRefusal(d, accepted[1]!, "settings")).toBeUndefined();
    expect(settingRefusal(d, accepted[1]!, "terminal")).toBeUndefined();
    expect(settingRefusal(d, accepted[1]!, "conductor")).toContain("not an operational conductor setting");
  });
}

test("#489 H4 the floors: every person-visible wait refuses a value below the constant that shipped, and the readers fall back to the default for one that slipped into a file", () => {
  for (const key of KEYS.filter(key => key !== "recovery.terminal_idle_wait_s")) {
    const floor = LEGACY[key] / 1000;
    expect(operationalNumber(key)!.min, key).toBe(floor);
    expect(() => checkSettingValue(def(key), floor - 1), key).toThrow();
    expect(recoveryWaits(() => ({ recovery: { [leaf(key)]: floor - 1 } }))[FIELD[key]], `${key} below its floor`).toBe(LEGACY[key]);
  }
  // the one row that may shorten ends a wait in manual-required, never a wrong effect
  expect(operationalNumber("recovery.terminal_idle_wait_s")!.min).toBe(30);
  expect(recoveryWaits(() => ({ recovery: { terminal_idle_wait_s: 30 } })).terminalIdleWaitMs).toBe(30_000);
});

test("#489 H4 a configured value reaches its own wait and no other, and bad values are the default, never an error inside a recovery", () => {
  for (const key of KEYS) {
    const raised = operationalNumber(key)!.max;
    const waits = recoveryWaits(() => ({ recovery: { [leaf(key)]: raised } }));
    for (const other of KEYS) expect(waits[FIELD[other]], `${key} -> ${other}`).toBe(other === key ? raised * 1000 : LEGACY[other]);
    for (const bad of [Number.NaN, Infinity, -1, 0, 0.5, "90", true, null, [], {}, 1e12, raised + 1]) {
      expect(recoveryWaits(() => ({ recovery: { [leaf(key)]: bad } }))[FIELD[key]], `${key}=${String(bad)}`).toBe(LEGACY[key]);
    }
  }
  expect(() => recoveryWaits(() => { throw new Error("config unreadable"); })).toThrow(); // the caller, not the converter, owns reading: readRecoveryWaits below absorbs it
});

test("#489 H4 the coordinator reads both layers, the machine-local file last, and the file as it is at each wait", () => {
  const f = project();
  expect(readRecoveryWaits(f.cwd)).toEqual(recoveryWaits(() => undefined)); // no file at all
  writeFileSync(f.shared, JSON.stringify({ recovery: { reconnect_wait_s: 700, shutdown_wait_s: 40 } }));
  expect(readRecoveryWaits(f.cwd)).toMatchObject({ reconnectWaitMs: 700_000, shutdownWaitMs: 40_000, unmanagedReconnectWaitMs: 90_000 });
  writeFileSync(f.local, JSON.stringify({ recovery: { reconnect_wait_s: 800 } }));
  expect(readRecoveryWaits(f.cwd)).toMatchObject({ reconnectWaitMs: 800_000, shutdownWaitMs: 40_000 }); // local wins per key, shared still supplies the rest
  writeFileSync(f.local, JSON.stringify({ recovery: { reconnect_wait_s: 900 } }));
  expect(readRecoveryWaits(f.cwd).reconnectWaitMs).toBe(900_000); // a later wait reads the new value
  rmSync(f.local);
  expect(readRecoveryWaits(f.cwd).reconnectWaitMs).toBe(700_000);
  expect(readRecoveryWaits(undefined)).toEqual(recoveryWaits(() => undefined));
});

test("#489 H4 an unreadable, non-object or refused config is the default and never throws", () => {
  const f = project();
  const defaults = recoveryWaits(() => undefined);
  writeFileSync(f.shared, "{ not json");
  expect(readRecoveryWaits(f.cwd)).toEqual(defaults);
  for (const bad of ["[]", "null", "7", '"x"', JSON.stringify({ recovery: [] }), JSON.stringify({ recovery: "300" }), JSON.stringify({ recovery: null })]) {
    writeFileSync(f.shared, bad);
    expect(readRecoveryWaits(f.cwd), bad).toEqual(defaults);
  }
  expect(readRecoveryWaits(join(f.cwd, "no-such-project"))).toEqual(defaults);
  // a machine-local file git tracks is refused like every other local policy: its value is not read
  writeFileSync(f.shared, JSON.stringify({ recovery: { reconnect_wait_s: 700 } }));
  writeFileSync(f.local, JSON.stringify({ recovery: { reconnect_wait_s: 900 } }));
  expect(readRecoveryWaits(f.cwd).reconnectWaitMs).toBe(900_000); // untracked: read
  expect(hubGitSync(["-C", f.cwd, "add", "-f", ".agenthub/config.local.json"], { encoding: "utf8" }).status).toBe(0);
  expect(readRecoveryWaits(f.cwd).reconnectWaitMs).toBe(700_000); // tracked: refused, the shared value stands
  // a directory git cannot answer for is the safe side too: the local value is not read, the shared one is
  const plain = project(false);
  writeFileSync(plain.shared, JSON.stringify({ recovery: { reconnect_wait_s: 700 } }));
  writeFileSync(plain.local, JSON.stringify({ recovery: { reconnect_wait_s: 900 } }));
  expect(readRecoveryWaits(plain.cwd).reconnectWaitMs).toBe(700_000);
});

test("#489 H4 startup rejects a bad value in either file, an unset block keeps the default, and inherit and undo go through the existing local file", () => {
  const f = project();
  for (const key of KEYS) expect(loadConfig(f.cwd).recovery[leaf(key) as keyof typeof DEFAULT_CONFIG.recovery], key).toBe(operationalNumber(key)!.defaultValue);
  for (const [key, accepted, refused] of BOUNDS) for (const filename of ["config.json", "config.local.json"]) {
    const target = join(f.cwd, ".agenthub", filename);
    for (const value of refused) { writeFileSync(target, JSON.stringify(block(key, value))); expect(() => loadConfig(f.cwd), `${key} ${String(value)}`).toThrow(key); }
    writeFileSync(target, JSON.stringify(block(key, accepted[1]))); expect(loadConfig(f.cwd).recovery[leaf(key) as keyof typeof DEFAULT_CONFIG.recovery]).toBe(accepted[1]);
    rmSync(target);
  }
  writeFileSync(f.shared, JSON.stringify({ recovery: { auto_resume_after_crash: true, reconnect_wait_s: 700, shutdown_wait_s: 40 } }));
  const d = def("recovery.reconnect_wait_s");
  expect(writeConfigSetting(f.cwd, f.state, d, 900, loadConfig)).toBe(true);
  expect(loadConfig(f.cwd).recovery.reconnect_wait_s).toBe(900);
  expect(readRecoveryWaits(f.cwd).reconnectWaitMs).toBe(900_000); // the coordinator sees the written value
  expect(writeConfigSetting(f.cwd, f.state, d, null, loadConfig)).toBe(true);
  expect(loadConfig(f.cwd).recovery.reconnect_wait_s).toBe(700); // inherit: the shared value
  expect(undoSetting(f.cwd, f.state, loadConfig).key).toBe("recovery.reconnect_wait_s");
  expect(loadConfig(f.cwd).recovery.reconnect_wait_s).toBe(900);
  const config = loadConfig(f.cwd).recovery;
  expect(config.auto_resume_after_crash).toBe(true); // the existing leaf is untouched by the new ones
  expect(config.shutdown_wait_s).toBe(40);
  expect(JSON.parse(readFileSync(f.shared, "utf8"))).toEqual({ recovery: { auto_resume_after_crash: true, reconnect_wait_s: 700, shutdown_wait_s: 40 } }); // the shared file was never rewritten
});

test("#489 H4 the settings are fixed rows, not registrations: no key outside the five resolves, and the existing recovery leaf is not a row", () => {
  for (const key of ["recovery.auto_resume_after_crash", "recovery.reconnect_wait", "recovery.reconnect_wait_s.x", "recovery.idle_wait_s", "recovery", "protocol", "constructor"]) {
    expect(operationalNumber(key), key).toBeUndefined();
  }
  expect(typeof settingDef("recovery.auto_resume_after_crash")).toBe("string");
  expect(typeof settingDef("recovery.reconnect_wait_s.x")).toBe("string");
});
