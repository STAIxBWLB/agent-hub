import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { configApply, validateOperationalConfig, validateRawConfig } from "../src/hub/config-apply.ts";
import { settingDef, undoSetting, writeConfigSetting, type SettingRow } from "../src/hub/settings.ts";
import {
  MODEL_COOLDOWN_FAILURES_SETTING, MODEL_COOLDOWN_SETTING, MODEL_COOLDOWN_CAP_SETTING, MODEL_TERMINAL_HISTORY_SETTING,
  INFERENCE_BACKOFF_SETTING, INFERENCE_DIGEST_ITEMS_SETTING, INFERENCE_DIGEST_CHARS_SETTING,
  modelOperationalReaders, type ModelOperationalConfig,
} from "../src/hub/operational-settings.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const rows = [MODEL_COOLDOWN_FAILURES_SETTING, MODEL_COOLDOWN_SETTING, MODEL_COOLDOWN_CAP_SETTING, MODEL_TERMINAL_HISTORY_SETTING,
  INFERENCE_BACKOFF_SETTING, INFERENCE_DIGEST_ITEMS_SETTING, INFERENCE_DIGEST_CHARS_SETTING];
const defaults = [3, 30, 300, 1000, 5, 5, 8000];
const changed = [2, 40, 600, 2, 2, 7, 9000];
const raw = (path: readonly string[], value: unknown) => ({ [path[0]!]: { [path[1]!]: value } });
const at = (value: unknown, path: readonly string[]) => path.reduce<unknown>((node, part) => node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined, value);
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
function project() {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-model-config-")));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true })); mkdirSync(join(cwd, ".agenthub"));
  return { cwd, shared: join(cwd, ".agenthub/config.json"), local: join(cwd, ".agenthub/config.local.json"), state: join(cwd, ".agenthub/state") };
}

test("#489 H6 config defaults, units and restart rows use the fixed H1 bounds", () => {
  const f = project();
  expect(rows.map(row => Number(row.defaultValue))).toEqual(defaults);
  for (const [index, row] of rows.entries()) {
    expect(at(DEFAULT_CONFIG, row.path)).toBe(defaults[index]!);
    expect(at(loadConfig(f.cwd), row.path)).toBe(defaults[index]!);
    expect(configApply(row.key)).toMatchObject({ applies: "restart", reason: row.restartReason });
    const def = settingDef(row.key); if (typeof def === "string") throw new Error(def);
    expect(def).toMatchObject({ type: "integer", min: row.min, max: row.max, applies: "restart", restartReason: row.restartReason });
    for (const value of [row.min, row.defaultValue, row.max]) {
      expect(() => validateOperationalConfig(raw(row.path, value))).not.toThrow();
      expect(() => validateRawConfig(raw(row.path, value))).not.toThrow();
    }
  }
  const config: ModelOperationalConfig = { model_relay: { cooldown_failures: 2, cooldown_s: 40, cooldown_cap_s: 600, terminal_history_limit: 2 } };
  const read = modelOperationalReaders(() => config);
  expect([read.cooldownFailures(), read.cooldownMs(), read.cooldownCapMs(), read.terminalHistoryLimit()]).toEqual([2, 40_000, 600_000, 2]);
  for (const leaf of ["request_deadline_s", "move_first_byte_s"]) expect(() => validateRawConfig({ model_relay: { [leaf]: 1 } })).toThrow();
});

test("#489 H6 validates all seven values in both files before a local override can mask invalid shared input", () => {
  const f = project();
  for (const row of rows) {
    for (const file of [f.shared, f.local]) {
      rmSync(f.shared, { force: true }); rmSync(f.local, { force: true });
      for (const value of [row.min, row.defaultValue, row.max]) {
        writeFileSync(file, JSON.stringify(raw(row.path, value)));
        expect(at(loadConfig(f.cwd), row.path)).toBe(value);
      }
      for (const value of [row.min - 1, -1, row.max + 1, row.min + 0.5, "2", null, true, [], {}]) {
        writeFileSync(file, JSON.stringify(raw(row.path, value)));
        expect(() => loadConfig(f.cwd)).toThrow(row.key);
      }
    }
    writeFileSync(f.shared, JSON.stringify(raw(row.path, row.max + 1)));
    writeFileSync(f.local, JSON.stringify(raw(row.path, row.defaultValue)));
    expect(() => loadConfig(f.cwd)).toThrow(row.key);
  }
});

test("#489 H6 inherit and undo preserve unrelated local leaves and the shared file for every setting", () => {
  const f = project(), shared: Record<string, Record<string, unknown>> = {};
  for (const row of rows) { shared[row.path[0]!] ??= {}; shared[row.path[0]!]![row.path[1]!] = row.defaultValue; }
  const sharedText = JSON.stringify(shared); writeFileSync(f.shared, sharedText);
  writeFileSync(f.local, JSON.stringify({ batch_ms: 7, tasks: { groom_fyi_window_min: 19 }, model_relay: { cooldown_failures: 3 }, inference: { triage: false } }));
  for (const [index, row] of rows.entries()) {
    const before = json(f.local), def = settingDef(row.key), top = row.path[0]!, leaf = row.path[1]!, value = changed[index]!;
    if (typeof def === "string") throw new Error(def);
    expect(writeConfigSetting(f.cwd, f.state, def, value, loadConfig)).toBe(true);
    expect(at(loadConfig(f.cwd), row.path)).toBe(value);
    expect(writeConfigSetting(f.cwd, f.state, def, null, loadConfig)).toBe(true);
    expect(at(loadConfig(f.cwd), row.path)).toBe(row.defaultValue);
    expect(at(json(f.local), row.path)).toBeUndefined();
    expect(undoSetting(f.cwd, f.state, loadConfig).key).toBe(row.key);
    expect(at(loadConfig(f.cwd), row.path)).toBe(value);
    expect(json(f.local)).toEqual({ ...before, [top]: { ...before[top], [leaf]: value } });
    expect(readFileSync(f.shared, "utf8")).toBe(sharedText);
  }
});

test("#489 H6 accepted settings remain pending with running values intact, then a daemon restart adopts all seven", async () => {
  const f = project(), sharedText = JSON.stringify({ batch_ms: 0, memory: { enabled: false, native: false }, inference: { enabled: false, triage: false }, mlx: { enabled: false }, pi: { enabled: false, auto_start: false }, research: { enabled: false }, snapshots: { enabled: false } });
  writeFileSync(f.shared, sharedText);
  writeFileSync(f.local, JSON.stringify({ tasks: { groom_fyi_window_min: 19 } }));
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: ControlClient | undefined;
  cleanup.push(async () => { client?.close(); await daemon?.stop(); });
  const boot = async () => {
    daemon = await startDaemon({ cwd: f.cwd, stateDir: f.state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, agentDrift: false, snapshotClock: () => 0 });
    client = await ControlClient.connect(f.state, { role: "console", projectRoot: f.cwd });
    return client;
  };
  const first = await boot(), originalInstance = (await first.request({ t: "status" })).status.instanceId;
  const settings = async (connection: ControlClient) => (await connection.request({ t: "settings_get" })).rows as SettingRow[];
  for (const [index, row] of rows.entries()) {
    expect((await settings(first)).find(entry => entry.key === row.key)).toMatchObject({ value: row.defaultValue, applies: "restart" });
    expect((await first.request({ t: "settings_set", key: row.key, value: changed[index]!, reason: "model setting restart regression" })).ok).toBe(true);
    expect((await settings(first)).find(entry => entry.key === row.key)).toMatchObject({ value: row.defaultValue, fileValue: changed[index]!, pending: changed[index]!, applies: "restart" });
    const saved = readFileSync(f.local, "utf8");
    expect((await first.request({ t: "settings_set", key: row.key, value: row.max + 1, reason: "invalid model timing" })).ok).toBe(false);
    expect(readFileSync(f.local, "utf8")).toBe(saved);
  }
  const running = (await first.request({ t: "status" })).status;
  expect(running.instanceId).toBe(originalInstance);
  expect(running.pendingRestart.map((entry: { key: string }) => entry.key).sort()).toEqual(rows.map(row => row.key).sort());
  for (const peer of daemon!.bus.peers.values()) expect(peer.state).toBe("offline");
  first.close(); client = undefined; await daemon!.stop(); daemon = undefined;
  const restarted = await boot();
  for (const [index, row] of rows.entries()) {
    const entry = (await settings(restarted)).find(entry => entry.key === row.key);
    expect(entry).toMatchObject({ value: changed[index]!, fileValue: changed[index]!, applies: "restart" });
    expect(entry?.pending).toBeUndefined();
  }
  expect((await restarted.request({ t: "status" })).status.pendingRestart ?? []).toEqual([]);
  expect(json(f.local).tasks).toEqual({ groom_fyi_window_min: 19 });
  expect(readFileSync(f.shared, "utf8")).toBe(sharedText);
}, 20_000);
