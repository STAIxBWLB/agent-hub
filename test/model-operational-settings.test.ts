import { afterEach, expect, test } from "bun:test";
import { BackendCooldowns, COOLDOWN_FAILURES, COOLDOWN_MS, COOLDOWN_CAP_MS, RELAY_TERMINAL_HISTORY_LIMIT, startModelRelay, type RelayCooldownEvent } from "../src/models/relay.ts";
import { BACKOFF_MS, DEFAULT_INFERENCE, Inference } from "../src/hub/inference.ts";
import { MODEL_COOLDOWN_FAILURES_SETTING, MODEL_COOLDOWN_SETTING, MODEL_COOLDOWN_CAP_SETTING, MODEL_TERMINAL_HISTORY_SETTING, INFERENCE_BACKOFF_SETTING, INFERENCE_DIGEST_ITEMS_SETTING, INFERENCE_DIGEST_CHARS_SETTING, modelOperationalReaders, OPERATIONAL_NUMBERS } from "../src/hub/operational-settings.ts";
import { configApply, validateOperationalConfig, validateRawConfig } from "../src/hub/config-apply.ts";
import { settingDef, checkSettingValue, settingRefusal } from "../src/hub/settings.ts";
import type { OmniRoute } from "../src/omniroute/client.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const rows = [MODEL_COOLDOWN_FAILURES_SETTING, MODEL_COOLDOWN_SETTING, MODEL_COOLDOWN_CAP_SETTING, MODEL_TERMINAL_HISTORY_SETTING, INFERENCE_BACKOFF_SETTING, INFERENCE_DIGEST_ITEMS_SETTING, INFERENCE_DIGEST_CHARS_SETTING];
const raw = (key: string, value: unknown) => { const [block, leaf] = key.split("."); return { [block!]: { [leaf!]: value } }; };

test("#489 H6 fixed rows pin every shipped default independently and share schema/UI/apply bounds", () => {
  expect([COOLDOWN_FAILURES, COOLDOWN_MS, COOLDOWN_CAP_MS, RELAY_TERMINAL_HISTORY_LIMIT, BACKOFF_MS]).toEqual([3, 30_000, 300_000, 1000, 300_000]);
  expect([DEFAULT_INFERENCE.digest_min_items, DEFAULT_INFERENCE.digest_min_chars, DEFAULT_INFERENCE.backoff_min]).toEqual([5, 8000, 5]);
  expect(rows.map(row => [row.defaultValue, row.min, row.max])).toEqual([[3, 1, 100], [30, 1, 300], [300, 300, 3600], [1000, 1, 1000], [5, 1, 60], [5, 1, 100_000], [8000, 1, 10_000_000]]);
  expect(OPERATIONAL_NUMBERS.filter(row => /^(model_relay|inference)\./.test(row.key)).map(row => row.key)).toEqual(rows.map(row => row.key));
  const readers = modelOperationalReaders(() => ({}));
  expect([readers.cooldownFailures(), readers.cooldownMs(), readers.cooldownCapMs(), readers.terminalHistoryLimit()]).toEqual([3, 30_000, 300_000, 1000]);
  for (const row of rows) {
    const def = settingDef(row.key); if (typeof def === "string") throw new Error(def);
    expect(def).toMatchObject({ min: row.min, max: row.max, applies: row.applies });
    expect(configApply(row.key).applies).toBe(row.applies);
    expect(settingRefusal(def, row.defaultValue, "conductor")).toContain("not an operational conductor setting");
    for (const value of [row.min, row.defaultValue, row.max]) {
      expect(checkSettingValue(def, value)).toBe(value);
      expect(() => validateRawConfig(raw(row.key, value))).not.toThrow();
      expect(() => validateOperationalConfig(raw(row.key, value))).not.toThrow();
    }
    for (const value of [row.min - 1, row.max + 1, 1.5, NaN, Infinity, "3", null, [], true]) {
      expect(() => validateRawConfig(raw(row.key, value))).toThrow(row.key);
      expect(() => validateOperationalConfig(raw(row.key, value))).toThrow(row.key);
    }
  }
  expect(() => validateRawConfig({ model_relay: { request_deadline_s: 240 } })).toThrow();
  expect(() => validateRawConfig({ inference: { screen_timeout_s: 10 } })).toThrow();
});

test("#489 H6 custom cooldown snapshots preserve doubling, failing window, cap, expiry and answer reset", () => {
  let now = 0;
  const events: RelayCooldownEvent[] = [], policy = { failures: 2, cooldownMs: 2000, capMs: 300_000 };
  const cooldowns = new BackendCooldowns(() => now, event => events.push(event), policy);
  policy.failures = 99; policy.cooldownMs = 90_000; // the existing relay keeps its captured policy
  cooldowns.failed("alias");
  expect(cooldowns.cooling("alias")).toBeUndefined();
  expect(cooldowns.failing("alias")).toBe(2000);
  cooldowns.failed("alias");
  expect(cooldowns.cooling("alias")).toEqual({ until: 2000, failures: 2 });
  cooldowns.failed("alias"); // no count or rearm while cooling
  expect(cooldowns.cooling("alias")).toEqual({ until: 2000, failures: 2 });
  now = 2000; expect(cooldowns.cooling("alias")).toBeUndefined();
  cooldowns.failed("alias"); expect(cooldowns.cooling("alias")?.until).toBe(6000);
  for (let i = 0; i < 10; i++) { now = cooldowns.cooling("alias")!.until; cooldowns.failed("alias"); }
  expect(cooldowns.cooling("alias")!.until - now).toBe(300_000);
  cooldowns.answered("alias", true);
  expect(cooldowns.cooling("alias")).toBeUndefined(); expect(cooldowns.failing("alias")).toBeUndefined();
  cooldowns.failed("alias");
  now += 600_001; cooldowns.failed("alias"); // old streak is forgotten after twice the configured cap
  expect(cooldowns.cooling("alias")).toBeUndefined();
  expect(events[0]).toMatchObject({ event: "start", failures: 2, ms: 2000 });
});

test("#489 H6 inference uses the configured backoff without retiming an existing deadline or interactive calls", async () => {
  let now = 1000, calls = 0;
  const dateNow = Date.now; Date.now = () => now;
  try {
    const omni = { base: async () => "http://fixture.invalid", chat: async () => { calls++; throw new Error("fixture unavailable"); } } as unknown as OmniRoute;
    const config = { ...DEFAULT_INFERENCE, backoff_min: 1 }, logs: string[] = [];
    const inference = new Inference(config, { omni, fixedModel: () => "fixture", log: line => logs.push(line) });
    expect(await inference.complete("s", "u", 1)).toBeUndefined(); expect(calls).toBe(1);
    config.backoff_min = 60; // an already-established offUntil is unchanged
    now = 60_999; expect(await inference.complete("s", "u", 1)).toBeUndefined(); expect(calls).toBe(1);
    expect(await inference.complete("s", "u", 1, { interactive: true })).toBeUndefined(); expect(calls).toBe(2);
    now = 61_000; expect(await inference.complete("s", "u", 1)).toBeUndefined(); expect(calls).toBe(3);
    expect(logs[0]).toContain("off for 1 min"); expect(logs[1]).toContain("off for 1 min");
    const restarted = new Inference(config, { omni, fixedModel: () => "fixture", log: line => logs.push(line) });
    expect(await restarted.complete("s", "u", 1)).toBeUndefined();
    expect(logs[2]).toContain("off for 60 min");
  } finally { Date.now = dateNow; }
});

test("#489 H6 terminal history ceiling retains only closed records and does not suppress request observers", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] }) });
  cleanup.push(() => upstream.stop(true));
  const observed: string[] = [], options = { omni: { base: async () => `http://127.0.0.1:${upstream.port}/v1`, apiKey: () => "fixture", accessHeaders: () => ({}) } as unknown as OmniRoute, allowedDGXmodels: { "dgx/fast": "fixture" }, token: "fixture-token", terminalHistoryLimit: 1, onRequest: (record: { id: string }) => { observed.push(record.id); } };
  const relay = await startModelRelay(options); cleanup.push(relay.close);
  options.terminalHistoryLimit = 1000; // captured at construction, no later rewrite
  for (let i = 0; i < 3; i++) {
    const response = await fetch(`${relay.url}/chat/completions`, { method: "POST", headers: { authorization: "Bearer fixture-token", "content-type": "application/json" }, body: JSON.stringify({ model: "dgx/fast", messages: [{ role: "user", content: "fixture" }] }) });
    expect(response.status).toBe(200); await response.text();
  }
  expect(observed).toHaveLength(3);
  expect(relay.requests()).toHaveLength(1);
  expect(relay.requests()[0]?.id).toBe(observed[2]);
  expect(relay.requests()[0]?.outcome).toBe("completed");
});

test("#489 H6 the relay consumes configured cooldown primitives on startup failures", async () => {
  let now = 0;
  const events: RelayCooldownEvent[] = [];
  const read = modelOperationalReaders(() => ({ model_relay: { cooldown_failures: 2, cooldown_s: 2, cooldown_cap_s: 300, terminal_history_limit: 1 } }));
  const relay = await startModelRelay({ omni: { base: async () => undefined, apiKey: () => "fixture", accessHeaders: () => ({}) } as unknown as OmniRoute, allowedDGXmodels: { "dgx/fast": "fixture" }, token: "fixture-token", now: () => now, onCooldown: event => events.push(event), cooldownFailures: read.cooldownFailures(), cooldownMs: read.cooldownMs(), cooldownCapMs: read.cooldownCapMs(), terminalHistoryLimit: read.terminalHistoryLimit() });
  cleanup.push(relay.close);
  const request = async () => {
    const response = await fetch(`${relay.url}/chat/completions`, { method: "POST", headers: { authorization: "Bearer fixture-token", "content-type": "application/json" }, body: JSON.stringify({ model: "dgx/fast", messages: [{ role: "user", content: "fixture" }] }) });
    expect(response.status).toBe(502); await response.text();
  };
  await request(); expect(events).toHaveLength(0);
  await request(); expect(events).toEqual([{ alias: "dgx/fast", event: "start", failures: 2, ms: 2000 }]);
  now = 2000; await request();
  expect(events.at(-1)).toMatchObject({ event: "start", failures: 3, ms: 4000 });
});

test("#489 H6 existing digest leaves retain the strict greater-than trigger with configured thresholds", async () => {
  const { newEnvelope } = await import("../src/hub/envelope.ts");
  let calls = 0;
  const omni = { base: async () => "fixture", chat: async () => { calls++; return { message: { content: "codex: fixture status" } }; } } as unknown as OmniRoute;
  const inference = new Inference({ ...DEFAULT_INFERENCE, digest_min_items: 2, digest_min_chars: 100 }, { omni, fixedModel: () => "fixture", log: () => {} });
  const small = [newEnvelope("codex", "one"), newEnvelope("codex", "two")];
  expect(await inference.condense(small)).toBe(small); expect(calls).toBe(0);
  const count = await inference.condense([...small, newEnvelope("codex", "three")]);
  expect(count).toHaveLength(1); expect(calls).toBe(1);
  const boundary = [newEnvelope("codex", "x".repeat(100))];
  expect(await inference.condense(boundary)).toBe(boundary); expect(calls).toBe(1);
  expect(await inference.condense([newEnvelope("codex", "x".repeat(101))])).toHaveLength(1); expect(calls).toBe(2);
});
