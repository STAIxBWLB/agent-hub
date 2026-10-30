import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AcpPeer, ACTIVITY_BATCH_MS, TOOL_CEILING_MS } from "../src/adapters/acp.ts";
import { JcodePeer, STEER_TIMEOUT_MS } from "../src/adapters/jcode.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { realPath } from "../src/hub/project.ts";
import { OPERATIONAL_NUMBERS, adapterOperationalReaders, type AdapterTimingConfig } from "../src/hub/operational-settings.ts";
import { configApply, validateOperationalConfig, validateRawConfig } from "../src/hub/config-apply.ts";
import { checkSettingValue, settingDef, settingRefusal, SETTINGS } from "../src/hub/settings.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const fakeAcp = [process.execPath, join(import.meta.dir, "fakes/acp-server.ts")];
const rows = OPERATIONAL_NUMBERS.filter(row => row.key.startsWith("adapter_timing."));
const until = async (condition: () => boolean) => {
  for (let n = 0; n < 400 && !condition(); n++) await Bun.sleep(10);
  expect(condition()).toBe(true);
};
const acpSnapshot = (read: ReturnType<typeof adapterOperationalReaders>) => ({ toolCeilingMs: read.acpToolCeilingMs(), activityBatchMs: read.acpActivityBatchMs() });

test("#489 H5 pins exactly three legacy defaults and keeps the fixed H1 bounds/apply path", () => {
  expect([TOOL_CEILING_MS, ACTIVITY_BATCH_MS, STEER_TIMEOUT_MS]).toEqual([1_800_000, 50, 5000]);
  const pins: Record<string, { legacy: number; scale: number }> = {
    "adapter_timing.acp_tool_ceiling_min": { legacy: TOOL_CEILING_MS, scale: 60_000 },
    "adapter_timing.acp_activity_batch_ms": { legacy: ACTIVITY_BATCH_MS, scale: 1 },
    "adapter_timing.jcode_steer_timeout_s": { legacy: STEER_TIMEOUT_MS, scale: 1000 },
  };
  expect(rows.map(row => row.key).sort()).toEqual(Object.keys(pins).sort());
  for (const row of rows) {
    expect(row.defaultValue * pins[row.key]!.scale).toBe(pins[row.key]!.legacy);
    expect(configApply(row.key)).toEqual({ applies: "next use" });
    const def = settingDef(row.key); if (typeof def === "string") throw new Error(def);
    expect(def).toMatchObject({ min: row.min, max: row.max, type: "integer", store: "config", applies: "next use" });
    expect(SETTINGS.filter(def => def.key === row.key)).toHaveLength(1);
    expect(settingRefusal(def, row.defaultValue, "conductor")).toContain("not an operational conductor setting");
    for (const value of [row.min, row.defaultValue, row.max]) {
      expect(checkSettingValue(def, value)).toBe(value);
      expect(() => validateRawConfig({ adapter_timing: { [row.path[1]!]: value } })).not.toThrow();
      expect(() => validateOperationalConfig({ adapter_timing: { [row.path[1]!]: value } })).not.toThrow();
    }
    for (const value of [row.min - 1, row.max + 1, 1.5, NaN, Infinity, "30", true, null]) {
      if (value === null) expect(checkSettingValue(def, value)).toBeNull();
      else expect(() => checkSettingValue(def, value)).toThrow();
      expect(() => validateRawConfig({ adapter_timing: { [row.path[1]!]: value } })).toThrow(row.key);
      expect(() => validateOperationalConfig({ adapter_timing: { [row.path[1]!]: value } })).toThrow(row.key);
    }
  }
  expect(() => validateRawConfig({ adapter_timing: { acp_handshake_s: 1 } })).toThrow();
  expect(() => validateRawConfig({ adapter_timing: { channel_reconnect_max_s: 1 } })).toThrow();
});

test("#489 unset adapter readers equal legacy options and new snapshots capture accepted values", () => {
  let config: AdapterTimingConfig = {};
  const read = adapterOperationalReaders(() => config);
  const first = { ...acpSnapshot(read), steerTimeoutMs: read.jcodeSteerTimeoutMs() };
  expect(first).toEqual({ toolCeilingMs: 1_800_000, activityBatchMs: 50, steerTimeoutMs: 5000 });
  config = { adapter_timing: { acp_tool_ceiling_min: 4, acp_activity_batch_ms: 17, jcode_steer_timeout_s: 12 } };
  expect(first).toEqual({ toolCeilingMs: 1_800_000, activityBatchMs: 50, steerTimeoutMs: 5000 });
  expect({ ...acpSnapshot(read), steerTimeoutMs: read.jcodeSteerTimeoutMs() }).toEqual({ toolCeilingMs: 240_000, activityBatchMs: 17, steerTimeoutMs: 12_000 });
});

class ToolPeer extends AcpPeer {
  nativeActivity = false;
  armed: number[] = [];
  protected override touch(ms?: number) { super.touch(ms); if (ms !== undefined) this.armed.push(ms); if (this.state === "busy") this.nativeActivity = true; }
  expire() { this.onWatchdog(); }
}

for (const ceilingMin of [1, 5]) test(`#489 configured ACP ceiling ${ceilingMin} min preserves watchdog floor and remaining-only rearm`, async () => {
  let config: AdapterTimingConfig = { adapter_timing: { acp_tool_ceiling_min: ceilingMin } };
  const read = adapterOperationalReaders(() => config), receipts: { state: string }[] = [];
  const peer = new ToolPeer("kimi", { cmd: [...fakeAcp, "--mode-after-cancel"], cwd: process.cwd(), watchdogMs: 120_000, ...acpSnapshot(read) });
  cleanup.push(() => peer.stop()); peer.onDelivery = receipt => receipts.push(receipt);
  await peer.start(); await peer.deliver([newEnvelope("user", "TOOL_SLOW", { to: ["kimi"] })], "ceiling");
  await until(() => peer.nativeActivity);
  const now = Date.now, start = (peer as unknown as { lastSignAt: number }).lastSignAt, effective = Math.max(120_000, ceilingMin * 60_000);
  try {
    config = { adapter_timing: { acp_tool_ceiling_min: 1 } }; // never retroactively retime this peer
    Date.now = () => start + effective - 30_000;
    peer.expire();
    expect(peer.state).toBe("busy");
    expect(peer.armed.at(-1)).toBe(30_000);
    expect(receipts.some(receipt => receipt.state === "needs_review")).toBe(false);
    Date.now = () => start + effective + 1000;
    peer.expire();
    expect(receipts.at(-1)?.state).toBe("needs_review");
    expect(peer.state).toBe("offline");
  } finally { Date.now = now; await peer.stop(); }
});

test("#489 ACP flush delay is captured at start, uses the new value on a new peer, and preserves private activity", async () => {
  let config: AdapterTimingConfig = { adapter_timing: { acp_activity_batch_ms: 17 } };
  const read = adapterOperationalReaders(() => config);
  for (const expected of [17, 10]) {
    const activity: { kind: string; text: string }[] = [], delays: number[] = [];
    const peer = new AcpPeer("kimi", { cmd: [process.execPath, join(import.meta.dir, "fakes/watch-acp.ts")], cwd: process.cwd(), ...acpSnapshot(read), isPrivateTurn: () => true, onActivity: item => activity.push(item), onPermission: async () => "no" });
    cleanup.push(() => peer.stop()); await peer.start();
    const realSet = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: (...args: any[]) => void, delay?: number, ...args: any[]) => {
      if (delay !== undefined && [10, 17, 50].includes(delay)) {
        delays.push(delay); config = { adapter_timing: { acp_activity_batch_ms: 10 } };
      }
      return realSet(handler, delay, ...args);
    }) as typeof setTimeout;
    try {
      await peer.deliver([newEnvelope("user", "watch fixture", { to: ["kimi"] })], "activity");
      await until(() => peer.state === "idle");
      expect(delays.length).toBeGreaterThan(0);
      expect(new Set(delays)).toEqual(new Set([expected]));
      expect(activity.some(item => item.kind === "private")).toBe(true);
      expect(activity.some(item => item.text.includes("WATCH_ONLY_MARKER"))).toBe(false);
    } finally { globalThis.setTimeout = realSet; await peer.stop(); }
  }
});

test("#489 configured Jcode steer uses one captured absolute deadline and never sends after pre-send expiry", async () => {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-adapter-steer-"))), home = join(dir, "home"), gate = join(dir, "gate"), stateGate = join(dir, "state"), record = join(dir, "record");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true })); mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}");
  let config: AdapterTimingConfig = { adapter_timing: { jcode_steer_timeout_s: 12 } };
  const read = adapterOperationalReaders(() => config);
  const peer = new JcodePeer({ command: [process.execPath, join(import.meta.dir, "fakes/jcode-agent.ts"), "--record", record, "--steer-file", gate, "--state-reply-gate", stateGate], cwd: dir, home, ...acpSnapshot(read), steerTimeoutMs: read.jcodeSteerTimeoutMs() });
  cleanup.push(() => peer.stop()); await peer.start();
  await peer.deliver([newEnvelope("user", "long fixture", { to: ["jcode"] })], "first");
  await until(() => existsSync(`${gate}.busy`));
  const timers: { fire: () => void; handle: ReturnType<typeof setTimeout> }[] = [], realSet = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay !== 12_000) return realSet(handler, delay, ...args);
    const handle = realSet(() => {}, 60_000);
    timers.push({ handle, fire: () => { clearTimeout(handle); handler(...args); } });
    return handle;
  }) as typeof setTimeout;
  let pending: Promise<boolean> | undefined;
  try {
    pending = peer.steer!([newEnvelope("claude", "steer fixture", { to: ["jcode"], priority: "important" })], "steer").then(() => true, () => false);
    await until(() => existsSync(`${stateGate}.waiting`));
    expect(timers).toHaveLength(1);
    config = { adapter_timing: { jcode_steer_timeout_s: 60 } };
    expect(read.jcodeSteerTimeoutMs()).toBe(60_000);
    expect(timers).toHaveLength(1);
    timers[0]!.fire();
    expect(await pending).toBe(false);
    const records = readFileSync(record, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records.some(row => row.kind === "soft_interrupt")).toBe(false);
  } finally {
    globalThis.setTimeout = realSet;
    for (const timer of timers) clearTimeout(timer.handle);
    await peer.stop(); await pending;
  }
});
