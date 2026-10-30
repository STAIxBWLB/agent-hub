import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { settingDef, undoSetting, writeConfigSetting, type SettingRow } from "../src/hub/settings.ts";
import { configApply, validateOperationalConfig, validateRawConfig } from "../src/hub/config-apply.ts";
import {
  ACP_TOOL_CEILING_SETTING, ACP_ACTIVITY_BATCH_SETTING, JCODE_STEER_TIMEOUT_SETTING,
  adapterOperationalReaders, type AdapterTimingConfig,
} from "../src/hub/operational-settings.ts";
import { configureJcodeMcp } from "../src/cli/jcode-mcp.ts";
import type { AcpOptions } from "../src/adapters/acp.ts";
import type { JcodeOptions } from "../src/adapters/jcode.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const settings = [ACP_TOOL_CEILING_SETTING, ACP_ACTIVITY_BATCH_SETTING, JCODE_STEER_TIMEOUT_SETTING];
const leaves = ["acp_tool_ceiling_min", "acp_activity_batch_ms", "jcode_steer_timeout_s"] as const;
const defaults = { acp_tool_ceiling_min: 30, acp_activity_batch_ms: 50, jcode_steer_timeout_s: 5 };
const changed = { acp_tool_ceiling_min: 2, acp_activity_batch_ms: 10, jcode_steer_timeout_s: 12 };
function project() {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-adapter-config-")));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".agenthub"));
  return { cwd, state: join(cwd, ".agenthub/state"), shared: join(cwd, ".agenthub/config.json"), local: join(cwd, ".agenthub/config.local.json") };
}
const timing = (cwd: string) => (loadConfig(cwd) as unknown as { adapter_timing: Record<string, number> }).adapter_timing;
const localJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

test("#489 H5 three accepted settings share bounds/apply metadata and preserve default units", () => {
  expect(settings.map(row => row.key)).toEqual(leaves.map(leaf => `adapter_timing.${leaf}`));
  expect(settings.map(row => [row.defaultValue, row.min, row.max])).toEqual([[30, 1, 30], [50, 10, 50], [5, 5, 60]]);
  const unset: AdapterTimingConfig = { adapter_timing: {} };
  const readers = adapterOperationalReaders(() => unset);
  expect([readers.acpToolCeilingMs(), readers.acpActivityBatchMs(), readers.jcodeSteerTimeoutMs()]).toEqual([1_800_000, 50, 5000]);
  const custom = adapterOperationalReaders(() => ({ adapter_timing: changed }));
  expect([custom.acpToolCeilingMs(), custom.acpActivityBatchMs(), custom.jcodeSteerTimeoutMs()]).toEqual([120_000, 10, 12_000]);
  for (const row of settings) {
    expect(configApply(row.key)).toEqual({ applies: "next use" });
    const def = settingDef(row.key); if (typeof def === "string") throw new Error(def);
    expect(def).toMatchObject({ min: row.min, max: row.max, applies: "next use" });
    for (const value of [row.min, row.defaultValue, row.max]) {
      const raw = { adapter_timing: { [row.path[1]!]: value } };
      expect(() => validateRawConfig(raw)).not.toThrow();
      expect(() => validateOperationalConfig(raw)).not.toThrow();
    }
  }
});

test("#489 H5 loader validates each file before merge, including an invalid shared value masked locally", () => {
  const f = project();
  expect(timing(f.cwd)).toMatchObject(defaults);
  for (const [index, row] of settings.entries()) {
    const leaf = leaves[index]!;
    for (const file of [f.shared, f.local]) {
      rmSync(f.shared, { force: true }); rmSync(f.local, { force: true });
      for (const value of [row.min, row.defaultValue, row.max]) {
        writeFileSync(file, JSON.stringify({ adapter_timing: { [leaf]: value } }));
        expect(timing(f.cwd)[leaf]).toBe(value);
      }
      for (const value of [row.min - 1, -1, row.max + 1, "2", null, true, [], {}]) {
        writeFileSync(file, JSON.stringify({ adapter_timing: { [leaf]: value } }));
        expect(() => loadConfig(f.cwd)).toThrow(row.key);
      }
    }
    writeFileSync(f.shared, JSON.stringify({ adapter_timing: { [leaf]: row.max + 1 } }));
    writeFileSync(f.local, JSON.stringify({ adapter_timing: defaults }));
    expect(() => loadConfig(f.cwd)).toThrow(row.key);
  }
});

test("#489 H5 local inherit and undo preserve sibling settings and unrelated local keys", () => {
  const f = project(), shared = JSON.stringify({ adapter_timing: defaults });
  writeFileSync(f.shared, shared);
  writeFileSync(f.local, JSON.stringify({ adapter_timing: defaults, batch_ms: 7, tasks: { groom_fyi_window_min: 19 } }));
  for (const [index, row] of settings.entries()) {
    const leaf = leaves[index]!, before = localJson(f.local), def = settingDef(row.key);
    if (typeof def === "string") throw new Error(def);
    const value = changed[leaf];
    expect(writeConfigSetting(f.cwd, f.state, def, value, loadConfig)).toBe(true);
    expect(timing(f.cwd)[leaf]).toBe(value);
    expect(writeConfigSetting(f.cwd, f.state, def, null, loadConfig)).toBe(true);
    expect(timing(f.cwd)[leaf]).toBe(defaults[leaf]);
    expect(localJson(f.local).adapter_timing?.[leaf]).toBeUndefined();
    expect(undoSetting(f.cwd, f.state, loadConfig).key).toBe(row.key);
    expect(timing(f.cwd)[leaf]).toBe(value);
    const after = localJson(f.local);
    expect(after).toEqual({ ...before, adapter_timing: { ...before.adapter_timing, [leaf]: value } });
    expect(readFileSync(f.shared, "utf8")).toBe(shared);
  }
});

async function host(peer: "kimi" | "jcode") {
  const f = project(), nativeHome = join(f.cwd, `${peer}-home`);
  mkdirSync(nativeHome); writeFileSync(join(nativeHome, "mcp.json"), "{}");
  const shared = JSON.stringify({ batch_ms: 0, adapter_timing: defaults, roster: { [peer]: true },
    memory: { enabled: false, native: false }, inference: { enabled: false }, mlx: { enabled: false },
    pi: { auto_start: false, enabled: false }, research: { enabled: false }, snapshots: { enabled: false } });
  const ownedLocal = peer === "kimi"
    ? { peers: { kimi: { start_mode: "headless" } }, kimi_cmd: [process.execPath, join(import.meta.dir, "fakes/acp-server.ts")] }
    : { jcode_cmd: [process.execPath, join(import.meta.dir, "fakes/jcode-agent.ts")], jcode_home: nativeHome };
  writeFileSync(f.shared, shared);
  writeFileSync(f.local, JSON.stringify({ ...ownedLocal, tasks: { groom_fyi_window_min: 19 } }));
  const daemon = await startDaemon({ cwd: f.cwd, stateDir: f.state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    kimiHome: nativeHome, configWatch: false, agentDrift: false, snapshotClock: () => 0 });
  cleanup.push(() => daemon.stop());
  // The project MCP entry is prepared through the person's writer, not by weakening admission or editing native home.
  if (peer === "jcode") configureJcodeMcp(f.cwd, f.state, join(import.meta.dir, "../plugins/agent-hub/server.js"));
  const client = await ControlClient.connect(f.state, { role: "console", projectRoot: f.cwd });
  cleanup.push(() => client.close());
  const set = (key: string, value: unknown) => client.request({ t: "settings_set", key, value, reason: "adapter timing regression" });
  const rows = async () => (await client.request({ t: "settings_get" })).rows as SettingRow[];
  const start = async () => {
    const reply = await client.request({ t: "start", peer, args: { mode: "headless" } });
    expect(reply.ok, JSON.stringify(reply)).toBe(true);
    const owner = daemon.bus.peers.get(peer);
    expect(owner?.state).not.toBe("offline");
    return owner!;
  };
  return { ...f, daemon, client, ownedLocal, sharedText: shared, set, rows, start };
}

// Host wiring assertions inspect only already-existing constructor options. Adapter behavior/timing is covered separately.
type CapturedOptions = { opts: Pick<AcpOptions, "toolCeilingMs" | "activityBatchMs">; jcode: Pick<JcodeOptions, "steerTimeoutMs"> };
for (const peer of ["kimi", "jcode"] as const) test(`#489 H5 ${peer} snapshots accepted timing at a new peer start, not an active session`, async () => {
  const f = await host(peer), first = await f.start(), old = first as unknown as CapturedOptions;
  expect(old.opts).toMatchObject({ toolCeilingMs: 1_800_000, activityBatchMs: 50 });
  if (peer === "jcode") expect(old.jcode.steerTimeoutMs).toBe(5000);
  const instance = (await f.client.request({ t: "status" })).status.instanceId;
  for (const [index, row] of settings.entries()) {
    const leaf = leaves[index]!, value = changed[leaf];
    expect((await f.rows()).find(entry => entry.key === row.key)).toMatchObject({ value: defaults[leaf], applies: "next use", min: row.min, max: row.max });
    expect((await f.set(row.key, value)).ok).toBe(true);
    expect((await f.rows()).find(entry => entry.key === row.key)).toMatchObject({ value, fileValue: value, applies: "next use" });
    const saved = readFileSync(f.local, "utf8");
    expect((await f.set(row.key, row.max + 1)).ok).toBe(false);
    expect(readFileSync(f.local, "utf8")).toBe(saved);
    expect((await f.set(row.key, null)).ok).toBe(true);
    expect((await f.rows()).find(entry => entry.key === row.key)?.value).toBe(defaults[leaf]);
    expect((await f.client.request({ t: "settings_undo", reason: "restore adapter override" })).ok).toBe(true);
    expect((await f.rows()).find(entry => entry.key === row.key)?.value).toBe(value);
    expect(f.daemon.bus.peers.get(peer)).toBe(first);
    expect(old.opts).toMatchObject({ toolCeilingMs: 1_800_000, activityBatchMs: 50 });
    if (peer === "jcode") expect(old.jcode.steerTimeoutMs).toBe(5000);
  }
  expect((await f.client.request({ t: "peer_stop", peer })).ok).toBe(true);
  expect(first.state).toBe("offline");
  const next = await f.start();
  expect(next).not.toBe(first);
  expect((next as unknown as CapturedOptions).opts).toMatchObject({ toolCeilingMs: 120_000, activityBatchMs: 10 });
  if (peer === "jcode") expect((next as unknown as CapturedOptions).jcode.steerTimeoutMs).toBe(12_000);
  expect((await f.client.request({ t: "status" })).status.instanceId).toBe(instance);
  expect(localJson(f.local)).toMatchObject({ ...f.ownedLocal, tasks: { groom_fyi_window_min: 19 }, adapter_timing: changed });
  expect(readFileSync(f.shared, "utf8")).toBe(f.sharedText);
}, 20_000);
