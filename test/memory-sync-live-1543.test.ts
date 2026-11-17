import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { configApply } from "../src/hub/config-apply.ts";
import { checkSettingValue, settingDef } from "../src/hub/settings.ts";

test("#1543 live sync interval replaces both timers and lets a running pass finish", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-sync-live-")), stateDir = join(root, ".agenthub/state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ memory: { native: true, sync_interval_min: 10 } }));
  const oldHome = process.env.AMEM_HOME;
  process.env.AMEM_HOME = join(root, "memory");
  const originalInterval = globalThis.setInterval, originalTimeout = globalThis.setTimeout;
  const originalClearInterval = globalThis.clearInterval, originalClearTimeout = globalThis.clearTimeout;
  const active = new Map<ReturnType<typeof setInterval>, { ms: number; run: () => void }>();
  const wrap = (original: typeof setInterval, handler: Parameters<typeof setInterval>[0], ms?: number, ...args: unknown[]) => {
    const timer = Reflect.apply(original, globalThis, [handler, ms, ...args]) as ReturnType<typeof setInterval>;
    if (typeof handler === "function" && handler.toString().includes("syncNow()")) active.set(timer, { ms: ms!, run: () => Reflect.apply(handler, undefined, args) });
    return timer;
  };
  globalThis.setInterval = ((handler: Parameters<typeof setInterval>[0], ms?: number, ...args: unknown[]) => wrap(originalInterval, handler, ms, ...args)) as typeof setInterval;
  globalThis.setTimeout = ((handler: Parameters<typeof setInterval>[0], ms?: number, ...args: unknown[]) => wrap(originalTimeout as typeof setInterval, handler, ms, ...args)) as typeof setTimeout;
  globalThis.clearInterval = ((timer) => { active.delete(timer as ReturnType<typeof setInterval>); Reflect.apply(originalClearInterval, globalThis, [timer]); }) as typeof clearInterval;
  globalThis.clearTimeout = ((timer) => { active.delete(timer as ReturnType<typeof setInterval>); Reflect.apply(originalClearTimeout, globalThis, [timer]); }) as typeof clearTimeout;
  let finish!: (value: { ok: true; pushed: false; entries: number }) => void;
  const inFlight = new Promise<{ ok: true; pushed: false; entries: number }>(resolve => { finish = resolve; });
  let calls = 0;
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let client: ControlClient | undefined;
  try {
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
      memorySync: () => { calls++; return inFlight; },
      config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, native: true, sync_interval_min: 10 } } });
    client = await ControlClient.connect(stateDir, { role: "console" });
    const set = async (value: number) => client!.request({ t: "settings_set", key: "memory.sync_interval_min", value });
    expect([...active.values()].map(x => x.ms).sort((a, b) => a - b)).toEqual([5_000, 600_000]);
    [...active.values()].find(x => x.ms === 600_000)!.run();
    expect(calls).toBe(1);
    const off = await set(0);
    expect(off.ok, JSON.stringify(off)).toBe(true);
    expect(active.size).toBe(0);
    expect((await client.request({ t: "status" })).status.memoryProfile.sync.state).toBe("disabled");
    finish({ ok: true, pushed: false, entries: 0 });
    await inFlight;
    expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(join(root, ".agenthub/config.local.json"), "utf8")).memory.sync_interval_min).toBe(0);
    expect((await set(1)).ok).toBe(true);
    expect([...active.values()].map(x => x.ms).sort((a, b) => a - b)).toEqual([5_000, 60_000]);
    expect((await set(2)).ok).toBe(true);
    expect([...active.values()].map(x => x.ms)).toEqual([120_000]);
    active.values().next().value!.run();
    expect(calls).toBe(2);
    for (const value of [-1, 1.5, 1441]) expect((await set(value)).error).toContain("memory.sync_interval_min must be 0 (off) or a whole number of minutes up to 1440");
  } finally {
    finish({ ok: true, pushed: false, entries: 0 });
    client?.close();
    await daemon?.stop();
    globalThis.setInterval = originalInterval; globalThis.setTimeout = originalTimeout;
    globalThis.clearInterval = originalClearInterval; globalThis.clearTimeout = originalClearTimeout;
    if (oldHome === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1543 interval keeps its existing bounds and is the only newly live memory key", () => {
  const def = settingDef("memory.sync_interval_min");
  if (typeof def === "string") throw new Error(def);
  expect(configApply(def.key).applies).toBe("live");
  expect(checkSettingValue(def, 1440)).toBe(1440);
  expect(() => checkSettingValue(def, 1441)).toThrow("whole number of minutes up to 1440");
});
