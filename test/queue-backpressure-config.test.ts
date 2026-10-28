import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/hub/daemon.ts";
import { configApply, validateRawConfig } from "../src/hub/config-apply.ts";
import { queueBackpressurePolicy } from "../src/hub/queue-backpressure.ts";
import { settingDef, checkSettingValue } from "../src/hub/settings.ts";
import { operationalSetting } from "../src/hub/operational-authority.ts";
import { renderStatus } from "../src/cli/output.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-queue-policy-")); roots.push(root);
  expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0); mkdirSync(join(root, ".agenthub")); return root;
}
function config(root: string, name: string, value: unknown) { writeFileSync(join(root, ".agenthub", name), JSON.stringify(value)); }
test("queue backpressure is bounded, live, person-editable and cannot inherit conductor setting authority", () => {
  for (const [field, max] of [["max_queued", 10000], ["max_oldest_s", 604800]] as const) {
    const key = `tasks.queue_backpressure.${field}`, def = settingDef(key);
    if (typeof def === "string") throw new Error(def);
    expect(def.store).toBe("config"); expect(def.applies).toBe("live"); expect(def.floor).toBeUndefined();
    expect(operationalSetting(def)).toBe(false);
    expect(checkSettingValue(def, max)).toBe(max);
    expect(() => checkSettingValue(def, max + 1)).toThrow();
    expect(configApply(key).applies).toBe("live");
  }
  expect(() => validateRawConfig({ tasks: { queue_backpressure: { max_queued: 2, max_oldest_s: 60 } } })).not.toThrow();
  expect(() => validateRawConfig({ tasks: { queue_backpressure: { max_queued: -1 } } })).toThrow();
});
test("trusted machine-local queue policy fields merge without silently disabling a sibling threshold", () => {
  const root = fixture();
  config(root, "config.json", { tasks: { queue_backpressure: { max_queued: 4 } } });
  config(root, "config.local.json", { tasks: { queue_backpressure: { max_oldest_s: 120 } } });
  expect(queueBackpressurePolicy(loadConfig(root).tasks.queue_backpressure)).toEqual({ max_queued: 4, max_oldest_s: 120 });
});
test("a committed repository cannot enable machine-local queue backpressure", () => {
  const root = fixture(); config(root, "config.json", { tasks: { queue_backpressure: { max_queued: 1, max_oldest_s: 1 } } });
  expect(Bun.spawnSync(["git", "-C", root, "add", "-f", ".agenthub/config.json"]).exitCode).toBe(0);
  expect(queueBackpressurePolicy(loadConfig(root).tasks.queue_backpressure)).toEqual({ max_queued: 0, max_oldest_s: 0 });
});
test("status shows queue and WIP separately, and unknown pending age never becomes zero or fresh", () => {
  const status = { peers: { codex: { state: "idle", queued: 2 } }, taskWip: { codex: { wip: 1, wipLimit: 2, active: 1, reviewWait: 0, reserved: 0 } } };
  const plain = (rows: ReturnType<typeof renderStatus>) => rows.map(row => row.map(span => span.text).join("")).join("\n");
  const off = plain(renderStatus(status, 200, 100000));
  expect(off).not.toContain("queue backpressure");
  const on = plain(renderStatus({ ...status, queueBackpressure: { policy: { max_queued: 3, max_oldest_s: 60 }, peers: { codex: { queued: 2, oldestQueuedAt: null, oldestAgeMs: null, blocked: true, code: "queue-age-unknown", reason: "queue backpressure: oldest queued age unknown" } } } }, 200, 100000));
  expect(on).toContain("oldest unknown"); expect(on).toContain("automatic offers held"); expect(on).toContain("reserved 0");
});
