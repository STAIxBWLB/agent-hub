import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OPERATIONAL_NUMBERS, GROOM_FYI_WINDOW_SETTING, operationalNumber } from "../src/hub/operational-settings.ts";
import { configApply, validateRawConfig, validateOperationalConfig } from "../src/hub/config-apply.ts";
import { configTier } from "../src/hub/config-tier.ts";
import { checkSettingValue, settingDef, settingRefusal, SETTINGS } from "../src/hub/settings.ts";
import { DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Tasks, GROOM_FYI_WINDOW_MS } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import type { Envelope } from "../src/hub/envelope.ts";

const key = GROOM_FYI_WINDOW_SETTING.key;
const at = (value: unknown, path: readonly string[]): unknown => path.reduce<unknown>((node, part) => node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined, value);
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

test("#489 every operational row has an independent legacy default pin and an operational H0 source", () => {
  expect(GROOM_FYI_WINDOW_MS).toBe(600_000);
  // Independent literals: what each constant was before it became a setting, never imported from the module under test (H2 values: #489 group 1).
  const pins: Record<string, { legacy: number; scale: number }> = {
    [key]: { legacy: GROOM_FYI_WINDOW_MS, scale: 60_000 },
    "tasks.demote_at": { legacy: 1.5, scale: 1 },
    "tasks.demotion_half_life_h": { legacy: 86_400_000, scale: 3_600_000 },
    "tasks.contradiction_window_days": { legacy: 604_800_000, scale: 86_400_000 },
    "tasks.rescreen_max": { legacy: 10, scale: 1 },
    "tasks.split_min_observations": { legacy: 5, scale: 1 },
    "tasks.split_max_failure_share": { legacy: 0.3, scale: 1 },
    "bus.max_attempts": { legacy: 3, scale: 1 },
    "bus.digest_max": { legacy: 10, scale: 1 },
    "bus.pull_budget_bytes": { legacy: 65_536, scale: 1 },
    "bus.notes_kept": { legacy: 10, scale: 1 },
    "bus.terminal_history_limit": { legacy: 2048, scale: 1 },
    // #489 H4 (group 3): what each wait was before it became a setting, in milliseconds, written out here and never imported from the code under test.
    "recovery.reconnect_wait_s": { legacy: 600_000, scale: 1000 },
    "recovery.unmanaged_reconnect_wait_s": { legacy: 90_000, scale: 1000 },
    "recovery.control_timeout_s": { legacy: 30_000, scale: 1000 },
    "recovery.shutdown_wait_s": { legacy: 30_000, scale: 1000 },
    "recovery.terminal_idle_wait_s": { legacy: 120_000, scale: 1000 },
    "adapter_timing.acp_tool_ceiling_min": { legacy: 1_800_000, scale: 60_000 },
    "adapter_timing.acp_activity_batch_ms": { legacy: 50, scale: 1 },
    "adapter_timing.jcode_steer_timeout_s": { legacy: 5000, scale: 1000 },
    "model_relay.cooldown_failures": { legacy: 3, scale: 1 },
    "model_relay.cooldown_s": { legacy: 30_000, scale: 1000 },
    "model_relay.cooldown_cap_s": { legacy: 300_000, scale: 1000 },
    "model_relay.terminal_history_limit": { legacy: 1000, scale: 1 },
    "inference.backoff_min": { legacy: 300_000, scale: 60_000 },
    "inference.digest_min_items": { legacy: 5, scale: 1 },
    "inference.digest_min_chars": { legacy: 8000, scale: 1 },
  };
  const inventory = readFileSync(join(import.meta.dir, "../docs/verification/2026-10-24-hardcoded-values.md"), "utf8").split("\n");
  const docs = readFileSync(join(import.meta.dir, "../docs/operations.md"), "utf8");
  for (const def of OPERATIONAL_NUMBERS) {
    const pin = pins[def.key]; expect(pin).toBeDefined();
    expect(def.defaultValue * pin!.scale).toBe(pin!.legacy);
    expect(at(DEFAULT_CONFIG, def.path)).toBe(def.defaultValue);
    const [file, symbol] = def.inventory.split(":");
    const row = inventory.find(line => line.startsWith(`| ${file}:`) && line.includes(`| \`${symbol}\` |`));
    expect(row?.endsWith("| operational |")).toBe(true);
    expect(docs).toContain(`\`${def.key}\``);
    expect(SETTINGS.filter(row => row.key === def.key)).toHaveLength(1);
  }
  expect(operationalNumber("protocol")).toBeUndefined();
  expect(operationalNumber("constructor")).toBeUndefined();
});

test("#489 schema, startup validation, UI bounds and apply class consume the same fixed row", () => {
  const def = settingDef(key); if (typeof def === "string") throw new Error(def);
  expect(def).toMatchObject({ min: 1, max: 1440, type: "number", store: "config", applies: "live", risk: "raises" });
  expect(configApply(key)).toEqual({ applies: def.applies });
  for (const value of [1, 1.5, 10, 1440]) {
    expect(checkSettingValue(def, value)).toBe(value);
    expect(() => validateRawConfig({ tasks: { groom_fyi_window_min: value } })).not.toThrow();
    expect(() => validateOperationalConfig({ tasks: { groom_fyi_window_min: value } })).not.toThrow();
  }
  for (const value of [0, -1, 1441, NaN, Infinity, "10", true, []]) {
    expect(() => checkSettingValue(def, value)).toThrow();
    expect(() => validateRawConfig({ tasks: { groom_fyi_window_min: value } })).toThrow(key);
    expect(() => validateOperationalConfig({ tasks: { groom_fyi_window_min: value } })).toThrow(key);
  }
  expect(checkSettingValue(def, null)).toBeNull(); // UI inherit is not a raw JSON value.
  expect(() => validateRawConfig({ tasks: { groom_fyi_window_min: null } })).toThrow(key);
  expect(() => validateOperationalConfig({ tasks: { groom_fyi_window_min: null } })).toThrow(key);
  expect(() => configApply(`${key}.unexpected`)).toThrow();
  expect(() => validateRawConfig({ tasks: { unknown_operational: 10 } })).toThrow();
  expect(configTier("config.local.json", def.path)).toHaveProperty("refused");
  expect(settingRefusal(def, 2, "ordinary")).toContain("settings session");
  expect(settingRefusal(def, 2, "settings")).toBeUndefined();
  expect(settingRefusal(def, 2, "terminal")).toBeUndefined();
  expect(settingRefusal(def, 2, "conductor")).toContain("not an operational conductor setting");
});

class Planner extends BasePeer {
  async start() { this.setState("busy"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) {}
}
async function rig(configured?: number) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-operational-notices-"));
  const board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const clock = { now: 1_800_000_000_000 }, config = { minutes: configured };
  const tasks = new Tasks({ board, bus, cwd, project: "operational", routing: () => loadRouting(cwd), roles: { claude: ["planner"] }, notify: () => {}, now: () => clock.now,
    ...(configured === undefined ? {} : { groomFyiWindowMin: () => config.minutes! }),
    sdlc: { config: () => sdlcConfig({ mode: "advise" }), gh: async () => ({ code: 1, stdout: "" }) } });
  board.proposalPlanner = () => ({ planner: null, plannerReason: "none" });
  const peer = new Planner("claude"); bus.add(peer); await peer.start();
  const events: { at: number; body: string; priority: string; dropped?: string }[] = [];
  bus.tap(event => { if (event.t === "envelope" && event.env.body.startsWith("The board changed")) events.push({ at: clock.now, body: event.env.body, priority: event.env.priority, ...(event.dropped ? { dropped: event.dropped } : {}) }); });
  const row = board.propose("user", { title: "work", class: "implement", backlog: true });
  tasks.flushPlannerNotices();
  for (const env of bus.pendingEnvelopes("claude")) bus.withdraw(env.id);
  events.length = 0;
  let change = 0;
  const move = () => { board.update(row.id, "user", "assigned", { signals: [`change-${++change}`] }); tasks.flushPlannerNotices(); };
  cleanup.push(() => { tasks.stopCiWatchers(); tasks.stopQueuePressureRechecks(); bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  return { board, bus, tasks, clock, config, events, row, move };
}

test("#489 an unset notice interval is byte-equivalent to the legacy ten-minute runtime trace", async () => {
  const trace = async (configured?: number) => {
    const f = await rig(configured), first = f.clock.now; f.move();
    f.clock.now = first + GROOM_FYI_WINDOW_MS - 1; f.move();
    expect(f.events).toHaveLength(1);
    f.clock.now = first + GROOM_FYI_WINDOW_MS; f.move();
    expect(f.events).toHaveLength(2);
    return JSON.stringify(f.events);
  };
  expect(await trace()).toBe(await trace(GROOM_FYI_WINDOW_SETTING.defaultValue));
});

test("#489 custom and reloaded intervals apply at the next flush without touching task ownership", async () => {
  const f = await rig(2), first = f.clock.now; f.move();
  f.clock.now = first + 119_999; f.move(); expect(f.events).toHaveLength(1);
  f.clock.now = first + 120_000; f.move(); expect(f.events).toHaveLength(2);
  f.config.minutes = 1;
  f.clock.now = first + 180_000; f.move(); expect(f.events).toHaveLength(3);
  f.config.minutes = 20;
  f.clock.now = first + 240_000; f.move(); expect(f.events).toHaveLength(3);
  const before = f.board.get(f.row.id);
  f.tasks.flushPlannerNotices(); expect(f.board.get(f.row.id)).toEqual(before);
  f.board.plan(f.row.id, "user", { priority: 1 }, 0, "new planning input");
  f.tasks.flushPlannerNotices();
  expect(f.events).toHaveLength(4); expect(f.events.at(-1)?.priority).toBe("status");
  expect(f.board.get(f.row.id)?.owner).toBeNull();
  expect(f.bus.stateOf("claude")).toBe("busy");
});
