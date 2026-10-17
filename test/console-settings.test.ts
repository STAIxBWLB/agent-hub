import { expect, test } from "bun:test";
import { initialConsoleState, reduceConsole, renderConsole } from "../src/cli/console-state.ts";
import { runConsole, type ConsoleTerminal } from "../src/cli/console.ts";

const row = { key: "approvals.notify", group: "Switches", label: "Desktop notice", type: "boolean", file: "config.local.json", applies: "restart", restartReason: "Notifier is created at startup", risk: "safe", value: false, fileValue: true, source: "config.local.json", pending: true };
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(preview?: (msg: any) => Promise<any>, selectedRow: Record<string, unknown> = row) {
  let data = (_text: string) => {};
  const output: string[] = [], requests: any[] = [];
  const terminal: ConsoleTerminal = { columns: 160, rows: 30, isTTY: true, write: text => { output.push(text); }, raw: () => {}, onData: listener => { data = listener; return () => {}; }, onResize: () => () => {}, onSignal: () => () => {} };
  const client = { onPush: (_msg: any) => {}, onClose: (_code: number, _reason: string) => {}, send: (_msg: any) => {}, close: () => {}, request: async (msg: any) => {
    requests.push(msg);
    if (msg.t === "settings_get") return { ok: true, rows: [selectedRow], undo: selectedRow.key, pendingRestart: [{ key: row.key, reason: row.restartReason }] };
    if (msg.t === "settings_preview") return preview ? preview(msg) : { ok: true, key: row.key, lines: ["preview only, notifier restarts"], confirm: "approved-setting-token" };
    if (msg.t === "settings_set" || msg.t === "settings_undo") return { ok: true, text: "saved" };
    return { ok: true, status: { peers: {}, pendingRestart: [{ key: row.key, reason: row.restartReason }] }, budget: {}, text: "[]", deliveries: [] };
  } };
  const running = runConsole({ client, cwd: "/tmp/fixture-only", stateDir: "/tmp/fixture-only", terminal, panels: true, color: false, noPet: true });
  return { output, requests, input: (text: string) => data(text), stop: async () => { data("\x03"); await running; } };
}
const writes = (f: ReturnType<typeof fixture>) => f.requests.filter(msg => msg.t === "settings_set" || msg.t === "settings_undo");
async function edit(f: ReturnType<typeof fixture>, value: string) { f.input("6"); await tick(); f.input("e"); f.input("\x15"); for (const c of value) f.input(c); f.input("\r"); await tick(); }
function reason(f: ReturnType<typeof fixture>) { for (const c of "test reason") f.input(c); f.input("\r"); }

test("#439 sixth Settings tab preserves old tab numbers and renders daemon values, sources and pending restart", async () => {
  for (let panel = 1; panel <= 5; panel++) expect(reduceConsole(initialConsoleState(true), String(panel)).state.panel).toBe(panel);
  expect(reduceConsole(initialConsoleState(true), "6").state.panel).toBe(6);
  const f = fixture();
  try { f.input("6"); await tick(); const text = f.output.join(""); for (const expected of ["Settings", "Switches", row.key, "false", "config.local.json", "restart", row.restartReason]) expect(text).toContain(expected); expect(writes(f)).toEqual([]); }
  finally { await f.stop(); }
});

test("#439 Settings set uses preview, a reason and explicit y through the existing client", async () => {
  const f = fixture();
  try {
    await edit(f, "true"); expect(f.requests.find(msg => msg.t === "settings_preview")).toEqual({ t: "settings_preview", key: row.key, value: true }); expect(writes(f)).toEqual([]);
    f.input("\r"); expect(writes(f)).toEqual([]); // empty reason is never a write
    reason(f); expect(writes(f)).toEqual([]); f.input("y"); await tick();
    expect(writes(f)).toEqual([{ t: "settings_set", key: row.key, value: true, reason: "test reason", confirm: "approved-setting-token" }]);
  } finally { await f.stop(); }
});

test("#439 Settings undo previews and requires its own reason and explicit y", async () => {
  const f = fixture();
  try { f.input("6"); await tick(); f.input("u"); await tick(); expect(f.requests.find(msg => msg.t === "settings_preview")).toEqual({ t: "settings_preview", undo: true }); reason(f); expect(writes(f)).toEqual([]); f.input("y"); await tick(); expect(writes(f)).toEqual([{ t: "settings_undo", reason: "test reason", confirm: "approved-setting-token" }]); }
  finally { await f.stop(); }
});

test("#439 stale Settings preview cannot arm a write after cancellation or tab change", async () => {
  let finish!: (reply: any) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  try { await edit(f, "true"); expect(typeof finish).toBe("function"); f.input("\x1b"); f.input("1"); finish({ ok: true, lines: ["stale preview"], confirm: "stale" }); await tick(); f.input("y"); expect(writes(f)).toEqual([]); }
  finally { await f.stop(); }
});

test("#439 pasted y never confirms a Settings write", async () => {
  const f = fixture();
  try { await edit(f, "true"); expect(f.requests.some(msg => msg.t === "settings_preview")).toBe(true); reason(f); expect(f.output.join("")).toContain("y/N"); f.input("\x1b[200~y\x1b[201~"); f.input("\r"); await tick(); expect(writes(f)).toEqual([]); }
  finally { await f.stop(); }
});

test("#439 Settings render stays bounded in the minimum panel size", () => {
  const state: any = { ...initialConsoleState(true), panel: 6, settingsRows: [row], settingsKnown: true, pendingRestart: [{ key: row.key, reason: row.restartReason }] };
  const lines = renderConsole(state, 80, 24); expect(lines).toHaveLength(24); for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
});


test("#439 console submits a fractional sweep duration as a number", async () => {
  const f = fixture(undefined, { ...row, key: "task_sweep.interval_s", type: "number", value: 300, fileValue: 300, applies: "live" });
  try { await edit(f, "1.5"); expect(f.requests.find(msg => msg.t === "settings_preview")?.value).toBe(1.5); reason(f); f.input("y"); await tick(); expect(writes(f)[0]?.value).toBe(1.5); }
  finally { await f.stop(); }
});
