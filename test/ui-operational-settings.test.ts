import { expect, test } from "bun:test";
import { CONSOLE_POLL_SETTING, CONSOLE_NOTICE_SETTING, CONSOLE_HISTORY_SETTING, CONSOLE_PENDING_STREAM_SETTING, CONSOLE_ATTENTION_SETTING, consoleOperationalSnapshot, OPERATIONAL_NUMBERS } from "../src/hub/operational-settings.ts";
import { configApply, validateRawConfig, validateOperationalConfig } from "../src/hub/config-apply.ts";
import { settingDef, settingRefusal } from "../src/hub/settings.ts";
import { runConsole, CONSOLE_POLL_MS, CONSOLE_PENDING_STREAM_LIMIT, CONSOLE_ATTENTION_LIMIT, type ConsoleTerminal } from "../src/cli/console.ts";
import { activeNotice, initialConsoleState, reduceConsole, NOTICE_MS, CONSOLE_HISTORY_LIMIT } from "../src/cli/console-state.ts";
import { newEnvelope } from "../src/hub/envelope.ts";

const rows = [CONSOLE_POLL_SETTING, CONSOLE_NOTICE_SETTING, CONSOLE_HISTORY_SETTING, CONSOLE_PENDING_STREAM_SETTING, CONSOLE_ATTENTION_SETTING];
const defaults = { pollMs: 4000, noticeMs: 10_000, historyLimit: 100, pendingStreamLimit: 1000, attentionLimit: 1000 };
const values = (changes: Record<string, number> = {}) => rows.map(row => ({ key: row.key, value: changes[row.key] ?? row.defaultValue }));
const tick = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };

test("#489 H7 five rows independently pin legacy values and keep the fixed bounds and apply path", () => {
  expect([CONSOLE_POLL_MS, NOTICE_MS, CONSOLE_HISTORY_LIMIT, CONSOLE_PENDING_STREAM_LIMIT, CONSOLE_ATTENTION_LIMIT]).toEqual([4000, 10_000, 100, 1000, 1000]);
  expect(OPERATIONAL_NUMBERS.filter(row => row.key.startsWith("console.")).map(row => row.key)).toEqual(rows.map(row => row.key));
  expect(rows.map(row => [row.defaultValue, row.min, row.max])).toEqual([[4000, 2000, 60_000], [10_000, 10_000, 60_000], [100, 1, 100], [1000, 1, 1000], [1000, 1, 1000]]);
  expect(consoleOperationalSnapshot(undefined)).toEqual(defaults);
  for (const row of rows) {
    expect(configApply(row.key)).toEqual({ applies: "next use" });
    const def = settingDef(row.key); if (typeof def === "string") throw new Error(def);
    expect(def).toMatchObject({ type: "integer", min: row.min, max: row.max, applies: "next use" });
    expect(settingRefusal(def, row.defaultValue, "conductor")).toContain("not an operational conductor setting");
    for (const value of [row.min, row.defaultValue, row.max]) {
      expect(() => validateRawConfig({ console: { [row.path[1]!]: value } })).not.toThrow();
      expect(() => validateOperationalConfig({ console: { [row.path[1]!]: value } })).not.toThrow();
    }
    for (const value of [row.min - 1, row.max + 1, 2.5, NaN, Infinity, "2", null, true, []]) {
      expect(() => validateRawConfig({ console: { [row.path[1]!]: value } })).toThrow(row.key);
      expect(() => validateOperationalConfig({ console: { [row.path[1]!]: value } })).toThrow(row.key);
    }
  }
  expect(() => validateRawConfig({ console: { redraw_ms: 500 } })).toThrow();
});

test("#489 H7 snapshots accepted row.value only, uses fixed bounds and falls back on missing/duplicate/invalid rows", () => {
  const accepted = values({ "console.poll_ms": 8000, "console.notice_ms": 20_000, "console.history_limit": 1, "console.pending_stream_limit": 2, "console.attention_limit": 3 });
  const first = consoleOperationalSnapshot(accepted);
  expect(first).toEqual({ pollMs: 8000, noticeMs: 20_000, historyLimit: 1, pendingStreamLimit: 2, attentionLimit: 3 });
  accepted[0]!.value = 12_000; expect(first.pollMs).toBe(8000);
  expect(consoleOperationalSnapshot([{ key: "console.poll_ms", value: 4000, fileValue: 60_000, pending: 60_000 }]).pollMs).toBe(4000);
  for (const input of [null, {}, [], [{ key: "console.poll_ms", fileValue: 8000 }], [{ key: "console.poll_ms", value: 8000 }, { key: "console.poll_ms", value: 9000 }], [{ key: "console.poll_ms", value: 1, min: 0 }], [{ key: "console.poll_ms", value: "8000" }]]) expect(consoleOperationalSnapshot(input)).toEqual(defaults);
});

test("#489 H7 both history paths tighten locally and notices preserve their captured visibility boundary", () => {
  for (const input of ["status", "queue discard --peer pi --reason fixture"]) {
    const state = initialConsoleState(); state.historyLimit = 1; state.history = ["old"]; state.editing = true; state.input = input;
    const result = reduceConsole(state, "\r", 1000), next = result.state;
    if (input.startsWith("queue")) { expect(result.effects).toEqual([]); expect(next.confirm?.type).toBe("command"); }
    expect(next.history).toEqual([input]); expect(next.historyIndex).toBe(1);
  }
  const state = initialConsoleState(); state.notice = "fixture"; state.noticeAt = 1000;
  expect(activeNotice(state, 10_999)).toBe(true); expect(activeNotice(state, 11_000)).toBe(false);
  state.noticeMs = 20_000;
  expect(activeNotice(state, 20_999)).toBe(true); expect(activeNotice(state, 21_000)).toBe(false);
});

function fixture(startup: () => Promise<any>, options: { pollMs?: number; noPet?: boolean } = {}) {
  let input = (_text: string) => {}, signal = () => {}, closed = 0;
  const output: string[] = [], requests: { msg: any; timeout?: number }[] = [], sent: any[] = [], intervals: { fn: () => void; ms: number; id: ReturnType<typeof setInterval>; active: boolean }[] = [];
  const interval = globalThis.setInterval, clear = globalThis.clearInterval;
  globalThis.setInterval = ((fn: () => void, ms: number) => { const id = interval(() => {}, 60_000); intervals.push({ fn, ms, id, active: true }); return id; }) as typeof setInterval;
  globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => { const timer = intervals.find(item => item.id === id); if (timer) timer.active = false; clear(id); }) as typeof clearInterval;
  const terminal: ConsoleTerminal = { columns: 160, rows: 30, isTTY: true, write: text => { output.push(text); }, raw: () => {}, onData: listener => { input = listener; return () => {}; }, onResize: () => () => {}, onSignal: listener => { signal = listener; return () => {}; } };
  const client = { onPush: (_message: any) => {}, onClose: (_code: number, _reason: string) => {}, send: (msg: any) => { sent.push(msg); }, close: () => { closed++; }, request: async (msg: any, timeout?: number) => {
    requests.push({ msg, timeout });
    if (msg.t === "settings_get") return startup();
    return { ok: true, status: { peers: {} }, budget: {}, text: "[]", deliveries: [] };
  } };
  const running = runConsole({ client, cwd: "/tmp/ahub-presentation-fixture-does-not-exist", stateDir: "/tmp/ahub-presentation-fixture-does-not-exist", terminal, panels: true, color: false, noPet: options.noPet ?? true, ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }) });
  return { output, requests, sent, intervals, client, input: (text: string) => input(text), signal: () => signal(), closed: () => closed, stop: async () => { signal(); try { await running; } finally { globalThis.setInterval = interval; globalThis.clearInterval = clear; } } };
}

test("#489 H7 console captures once, preserves initial tail subscription and keeps the poll seam and floor", async () => {
  for (const override of [undefined, 3000, 1]) {
    let rows = values({ "console.poll_ms": 8000 });
    const f = fixture(async () => ({ ok: true, rows }), { pollMs: override });
    try {
      expect(f.sent).toEqual([{ t: "tail" }]); await tick();
      expect(f.intervals.filter(item => item.active).map(item => item.ms)).toEqual([1000, override === undefined ? 8000 : Math.max(2000, override)]);
      expect(f.requests.some(item => item.msg.t === "settings_get" && item.timeout === 3000)).toBe(true);
      const count = f.intervals.length, poll = f.intervals.find(item => item.active && item.ms !== 1000)!;
      rows = values({ "console.poll_ms": 12_000 }); poll.fn(); await tick();
      expect(f.intervals).toHaveLength(count); expect(poll.ms).toBe(override === undefined ? 8000 : Math.max(2000, override));
    } finally { await f.stop(); }
  }
});

test("#489 H7 old, refusing and unavailable hubs keep legacy timing", async () => {
  for (const response of [async () => ({ ok: true }), async () => ({ ok: false, rows: values({ "console.poll_ms": 8000 }) }), async () => { throw new Error("fixture unavailable"); }]) {
    const f = fixture(response);
    try { await tick(); expect(f.intervals.map(item => item.ms)).toEqual([1000, 4000]); }
    finally { await f.stop(); }
  }
});

test("#489 H7 a held startup settings read preserves permission handling and counted cold-start trimming", async () => {
  let release!: (value: any) => void;
  const held = new Promise(resolve => { release = resolve; });
  const f = fixture(() => held);
  try {
    for (let i = 0; i < 4; i++) f.client.onPush({ t: "notice", line: `cold${i}` });
    f.client.onPush({ t: "permission", id: "held-permission", peer: "pi", title: "fixture approval", expiresAt: Date.now() + 60_000, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] });
    release({ ok: true, rows: values({ "console.pending_stream_limit": 1 }) }); await tick();
    f.input("2"); expect(f.output.join("")).toContain("fixture approval");
    f.input("\t"); const text = f.output.join("");
    expect(text).toContain("4 older panel-mode events omitted"); expect(text).toContain("fixture approval");
    expect(f.sent.filter(msg => msg.t === "permit")).toEqual([]);
  } finally { release({ ok: false }); await f.stop(); }
});

test("#489 H7 close during startup clears both legacy timers and prevents late configured poll startup", async () => {
  let release!: (value: any) => void;
  const held = new Promise(resolve => { release = resolve; });
  const f = fixture(() => held);
  try {
    expect(f.intervals.map(item => item.ms)).toEqual([1000, 4000]);
    f.signal(); await f.stop(); expect(f.closed()).toBe(1); expect(f.intervals.filter(item => item.active)).toEqual([]);
    release({ ok: true, rows: values() }); await tick(); expect(f.intervals).toHaveLength(2); expect(f.intervals.filter(item => item.active)).toEqual([]);
  } finally { release?.({ ok: false }); await f.stop(); }
});

test("#489 H7 attention retention keeps only the newest local message without changing delivery", async () => {
  const f = fixture(async () => ({ ok: true, rows: values({ "console.attention_limit": 1 }) }), { noPet: false });
  try {
    await tick();
    const older = newEnvelope("codex", "old fixture", { to: ["user"] }), newer = newEnvelope("codex", "new fixture", { to: ["user"] });
    f.client.onPush({ t: "event", e: { t: "envelope", env: older } });
    f.client.onPush({ t: "event", e: { t: "envelope", env: newer } });
    f.output.length = 0; f.input("n"); const text = f.output.join("");
    expect(text).toContain(newer.id); expect(text).not.toContain(older.id);
    expect(f.sent).toEqual([{ t: "tail" }]);
  } finally { await f.stop(); }
});
