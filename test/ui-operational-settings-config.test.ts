import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { configApply, validateOperationalConfig, validateRawConfig } from "../src/hub/config-apply.ts";
import { settingDef, writeConfigSetting, undoSetting, type SettingRow } from "../src/hub/settings.ts";
import { CONSOLE_POLL_SETTING, CONSOLE_NOTICE_SETTING, CONSOLE_HISTORY_SETTING, CONSOLE_PENDING_STREAM_SETTING, CONSOLE_ATTENTION_SETTING } from "../src/hub/operational-settings.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const rows = [CONSOLE_POLL_SETTING, CONSOLE_NOTICE_SETTING, CONSOLE_HISTORY_SETTING, CONSOLE_PENDING_STREAM_SETTING, CONSOLE_ATTENTION_SETTING];
const defaults = { poll_ms: 4000, notice_ms: 10_000, history_limit: 100, pending_stream_limit: 1000, attention_limit: 1000 };
const changed = { poll_ms: 5000, notice_ms: 20_000, history_limit: 42, pending_stream_limit: 17, attention_limit: 19 };
type Leaf = keyof typeof defaults;
const leafOf = (row: typeof rows[number]) => row.path[1] as Leaf;
const localJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
function project() {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-console-config-")));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true })); mkdirSync(join(cwd, ".agenthub"));
  return { cwd, shared: join(cwd, ".agenthub/config.json"), local: join(cwd, ".agenthub/config.local.json"), state: join(cwd, ".agenthub/state") };
}

test("#489 H7 console defaults and exact five closed schema leaves share H1 bounds", () => {
  const f = project();
  expect(DEFAULT_CONFIG.console).toEqual(defaults);
  expect(loadConfig(f.cwd).console).toEqual(defaults);
  expect(rows.map(row => [row.key, row.min, row.max])).toEqual([
    ["console.poll_ms", 2000, 60_000], ["console.notice_ms", 10_000, 60_000], ["console.history_limit", 1, 100],
    ["console.pending_stream_limit", 1, 1000], ["console.attention_limit", 1, 1000],
  ]);
  for (const row of rows) {
    expect(row.defaultValue).toBe(defaults[leafOf(row)]);
    expect(configApply(row.key)).toEqual({ applies: "next use" });
    const def = settingDef(row.key); if (typeof def === "string") throw new Error(def);
    expect(def).toMatchObject({ type: "integer", min: row.min, max: row.max, applies: "next use" });
    for (const value of [row.min, row.defaultValue, row.max]) {
      const raw = { console: { [leafOf(row)]: value } };
      expect(() => validateRawConfig(raw)).not.toThrow();
      expect(() => validateOperationalConfig(raw)).not.toThrow();
    }
  }
  for (const key of ["redraw_ms", "event_limit", "settings_authority_ms"]) expect(() => validateRawConfig({ console: { [key]: 1000 } })).toThrow();
});

test("#489 H7 both config layers validate every bound before local overrides can mask invalid shared input", () => {
  const f = project();
  for (const row of rows) {
    const leaf = leafOf(row);
    for (const file of [f.shared, f.local]) {
      rmSync(f.shared, { force: true }); rmSync(f.local, { force: true });
      for (const value of [row.min, row.defaultValue, row.max]) {
        writeFileSync(file, JSON.stringify({ console: { [leaf]: value } }));
        expect(loadConfig(f.cwd).console?.[leaf]).toBe(value);
      }
      for (const value of [row.min - 1, -1, row.max + 1, row.min + 0.5, "2", null, true, [], {}]) {
        writeFileSync(file, JSON.stringify({ console: { [leaf]: value } }));
        expect(() => loadConfig(f.cwd)).toThrow(row.key);
      }
    }
    writeFileSync(f.shared, JSON.stringify({ console: { [leaf]: row.max + 1 } }));
    writeFileSync(f.local, JSON.stringify({ console: defaults }));
    expect(() => loadConfig(f.cwd)).toThrow(row.key);
  }
});

test("#489 H7 local inherit and undo preserve all other console and unrelated config leaves", () => {
  const f = project(), sharedText = JSON.stringify({ console: defaults }); writeFileSync(f.shared, sharedText);
  writeFileSync(f.local, JSON.stringify({ batch_ms: 7, tasks: { groom_fyi_window_min: 19 }, console: defaults }));
  for (const row of rows) {
    const leaf = leafOf(row), before = localJson(f.local), def = settingDef(row.key);
    if (typeof def === "string") throw new Error(def);
    expect(writeConfigSetting(f.cwd, f.state, def, changed[leaf], loadConfig)).toBe(true);
    expect(loadConfig(f.cwd).console?.[leaf]).toBe(changed[leaf]);
    expect(writeConfigSetting(f.cwd, f.state, def, null, loadConfig)).toBe(true);
    expect(loadConfig(f.cwd).console?.[leaf]).toBe(defaults[leaf]);
    expect(localJson(f.local).console?.[leaf]).toBeUndefined();
    expect(undoSetting(f.cwd, f.state, loadConfig).key).toBe(row.key);
    expect(loadConfig(f.cwd).console?.[leaf]).toBe(changed[leaf]);
    expect(localJson(f.local)).toEqual({ ...before, console: { ...before.console, [leaf]: changed[leaf] } });
    expect(readFileSync(f.shared, "utf8")).toBe(sharedText);
  }
});

test("#489 H7 existing settings_get exposes accepted next-use values without a daemon restart", async () => {
  const f = project(), sharedText = JSON.stringify({ console: defaults, batch_ms: 0, memory: { enabled: false, native: false }, inference: { enabled: false, triage: false }, mlx: { enabled: false }, pi: { enabled: false, auto_start: false }, research: { enabled: false }, snapshots: { enabled: false } });
  writeFileSync(f.shared, sharedText); writeFileSync(f.local, JSON.stringify({ tasks: { groom_fyi_window_min: 19 } }));
  const daemon = await startDaemon({ cwd: f.cwd, stateDir: f.state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, agentDrift: false, snapshotClock: () => 0 });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(f.state, { role: "console", projectRoot: f.cwd }); cleanup.push(() => client.close());
  const settingRows = async () => (await client.request({ t: "settings_get" })).rows as SettingRow[];
  const set = (key: string, value: unknown) => client.request({ t: "settings_set", key, value, reason: "console preference config regression" });
  const instance = (await client.request({ t: "status" })).status.instanceId;
  for (const row of rows) {
    const leaf = leafOf(row);
    expect((await settingRows()).find(entry => entry.key === row.key)).toMatchObject({ value: defaults[leaf], applies: "next use" });
    expect((await set(row.key, changed[leaf])).ok).toBe(true);
    const accepted = (await settingRows()).find(entry => entry.key === row.key);
    expect(accepted).toMatchObject({ value: changed[leaf], fileValue: changed[leaf], applies: "next use" });
    expect(accepted?.pending).toBeUndefined();
    const saved = readFileSync(f.local, "utf8");
    expect((await set(row.key, row.min - 1)).ok).toBe(false);
    expect(readFileSync(f.local, "utf8")).toBe(saved);
    expect((await set(row.key, null)).ok).toBe(true);
    expect((await settingRows()).find(entry => entry.key === row.key)?.value).toBe(defaults[leaf]);
    expect((await client.request({ t: "settings_undo", reason: "restore console preference" })).ok).toBe(true);
    expect((await settingRows()).find(entry => entry.key === row.key)?.value).toBe(changed[leaf]);
  }
  const status = (await client.request({ t: "status" })).status;
  expect(status.instanceId).toBe(instance); expect(status.pendingRestart ?? []).toEqual([]);
  for (const peer of daemon.bus.peers.values()) expect(peer.state).toBe("offline");
  expect(localJson(f.local)).toMatchObject({ tasks: { groom_fyi_window_min: 19 }, console: changed });
  expect(readFileSync(f.shared, "utf8")).toBe(sharedText);
}, 20_000);
