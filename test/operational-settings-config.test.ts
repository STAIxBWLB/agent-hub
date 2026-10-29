import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG, loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { GROOM_FYI_WINDOW_SETTING } from "../src/hub/operational-settings.ts";
import { realPath } from "../src/hub/project.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { settingDef, writeConfigSetting, undoSetting } from "../src/hub/settings.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const key = GROOM_FYI_WINDOW_SETTING.key;
function project() {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-operational-config-")));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".agenthub"));
  return { cwd, file: join(cwd, ".agenthub/config.local.json"), shared: join(cwd, ".agenthub/config.json"), state: join(cwd, ".agenthub/state") };
}

test("#489 startup validates operational bounds in both files before merging", () => {
  for (const filename of ["config.json", "config.local.json"]) {
    const f = project(), target = join(f.cwd, ".agenthub", filename);
    expect(loadConfig(f.cwd).tasks.groom_fyi_window_min).toBe(DEFAULT_CONFIG.tasks.groom_fyi_window_min);
    for (const value of [0, -1, 1441, "bad", null, true, []]) {
      writeFileSync(target, JSON.stringify({ tasks: { groom_fyi_window_min: value } }));
      expect(() => loadConfig(f.cwd)).toThrow(key);
    }
    for (const value of [1, 1.5, 10, 1440]) {
      writeFileSync(target, JSON.stringify({ tasks: { groom_fyi_window_min: value } }));
      expect(loadConfig(f.cwd).tasks.groom_fyi_window_min).toBe(value);
    }
  }
  const f = project();
  writeFileSync(f.shared, JSON.stringify({ tasks: { groom_fyi_window_min: 0 } }));
  writeFileSync(f.file, JSON.stringify({ tasks: { groom_fyi_window_min: 10 } }));
  expect(() => loadConfig(f.cwd)).toThrow(key); // A good local override never masks invalid shared input.
});

test("#489 settings inherit and undo use the existing local file and loader", () => {
  const f = project(), shared = JSON.stringify({ tasks: { groom_fyi_window_min: 15 } });
  writeFileSync(f.shared, shared);
  const def = settingDef(key); if (typeof def === "string") throw new Error(def);
  expect(writeConfigSetting(f.cwd, f.state, def, 2, loadConfig)).toBe(true);
  expect(loadConfig(f.cwd).tasks.groom_fyi_window_min).toBe(2);
  expect(writeConfigSetting(f.cwd, f.state, def, null, loadConfig)).toBe(true);
  expect(loadConfig(f.cwd).tasks.groom_fyi_window_min).toBe(15);
  expect(undoSetting(f.cwd, f.state, loadConfig).key).toBe(key);
  expect(loadConfig(f.cwd).tasks.groom_fyi_window_min).toBe(2);
  expect(readFileSync(f.shared, "utf8")).toBe(shared);
});

test("#489 real daemon numeric row writes, inherits and undoes live without a restart", async () => {
  const f = project();
  const shared = JSON.stringify({ memory: { enabled: false, native: false }, inference: { enabled: false }, mlx: { enabled: false }, pi: { auto_start: false }, research: { enabled: false }, snapshots: { enabled: false }, tasks: { groom_fyi_window_min: 15 } });
  writeFileSync(f.shared, shared);
  const daemon = await startDaemon({ cwd: f.cwd, stateDir: f.state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, agentDrift: false, snapshotClock: () => 0 });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(f.state, { role: "console", projectRoot: f.cwd });
  cleanup.push(() => client.close());
  const row = async () => (await client.request({ t: "settings_get" })).rows.find((entry: { key: string }) => entry.key === key);
  const initial = await row();
  expect(initial).toMatchObject({ key, type: "number", min: 1, max: 1440, applies: "live", value: 15 });
  expect(initial.inventory).toBeUndefined();
  const instance = (await client.request({ t: "status" })).status.instanceId;
  const set = (value: unknown) => client.request({ t: "settings_set", key, value, reason: "operational setting regression" });
  expect((await set(2)).ok).toBe(true);
  expect(await row()).toMatchObject({ value: 2, fileValue: 2, applies: "live" });
  const saved = readFileSync(f.file, "utf8");
  expect((await set(0)).ok).toBe(false);
  expect(readFileSync(f.file, "utf8")).toBe(saved);
  expect((await set(null)).ok).toBe(true);
  expect((await row()).value).toBe(15);
  expect((await client.request({ t: "settings_undo", reason: "restore local interval" })).ok).toBe(true);
  expect((await row()).value).toBe(2);
  expect((await client.request({ t: "status" })).status.instanceId).toBe(instance);
  expect(readFileSync(f.shared, "utf8")).toBe(shared);
}, 20_000);
