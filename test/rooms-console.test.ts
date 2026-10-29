import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialConsoleState, panelRows, reduceConsole, renderConsole, selectedPanelRow } from "../src/cli/console-state.ts";
import { runConsole, type ConsoleTerminal } from "../src/cli/console.ts";
import { encodeBase64url } from "../src/rooms/crypto.ts";
import { projectRoomStatus } from "../src/rooms/status.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const roomId = encodeBase64url(new Uint8Array(32).fill(4));
const owner = "a".repeat(64), member = "b".repeat(64);
const row = (name: string, overrides: Record<string, unknown> = {}) => ({ name, room: roomId, owner, member, epoch: "4", state: "online", ...overrides });
const NOW = 1_798_000_000_000;

async function consoleRig(status: Record<string, unknown>) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-room-console-")), output: string[] = [], requests: Record<string, unknown>[] = [];
  let data: (text: string) => void = () => {};
  const terminal: ConsoleTerminal = {
    columns: 120, rows: 40, isTTY: true,
    write: text => { output.push(text); }, raw: () => {},
    onData: listener => { data = listener; return () => {}; },
    onResize: () => () => {}, onSignal: () => () => {}, onError: () => () => {},
  };
  const client = {
    onPush: (_message: unknown) => {}, onClose: (_code: number, _reason: string) => {},
    send: (_message: unknown) => {}, close: () => {},
    request: async (message: any) => {
      requests.push(message);
      if (message.t === "status") return { ok: true, status };
      if (message.t === "budget") return { ok: true, budget: {} };
      if (message.t === "task") return { ok: true, text: "[]" };
      if (message.t === "queue") return { ok: true, deliveries: [] };
      if (message.t === "settings_get") return { ok: true, rows: [] };
      return { ok: true };
    },
  };
  const running = runConsole({ client, cwd, stateDir: cwd, terminal, panels: true, color: false, noPet: true, pollMs: 1_000_000 });
  cleanups.push(async () => { data("q"); await running; rmSync(cwd, { recursive: true, force: true }); });
  for (let attempt = 0; attempt < 100 && !requests.some(request => request.t === "status"); attempt++) await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
  return { input: (text: string) => data(text), frame: () => output.join(""), clear: () => { output.length = 0; }, requests };
}

test("the read-only Rooms panel shows canonical metadata and wrapped relay labels at 80 and 120 columns", () => {
  const rooms = projectRoomStatus([row("work", {
    members: 2,
    remotePeers: [{ id: "codex@hub-b", state: "idle", body: "REMOTE_BODY_CANARY", title: "REMOTE_TITLE_CANARY" }],
    relays: { since: NOW, outbound: 0, inbound: 3, withheld: 0, body: "REMOTE_BODY_CANARY", title: "REMOTE_TITLE_CANARY" },
    body: "REMOTE_BODY_CANARY", title: "REMOTE_TITLE_CANARY",
  })]);
  const state = reduceConsole({ ...initialConsoleState(true), rooms }, "8", NOW).state;
  expect(state.panel).toBe(8); expect(panelRows(state)).toHaveLength(1); expect(selectedPanelRow(state)?.name).toBe("work");
  const detail = reduceConsole(state, "\r", NOW).state;
  for (const columns of [80, 120]) {
    const lines = renderConsole(detail, columns, 40, NOW);
    expect(lines.every(line => Bun.stringWidth(line) <= columns)).toBe(true);
    const text = lines.join("\n");
    expect(text).toContain("out handoff"); expect(text).toContain("in admitted"); expect(text).toContain("withheld");
    expect(text).toContain("since daemon start"); expect(text).toContain(new Date(NOW).toISOString());
    expect(text).toMatch(/out handoff +0/); expect(text).not.toContain("REMOTE_");
  }
});

test("old hubs and hubs with no rooms remain quiet; explicit null is a fixed unavailable state", async () => {
  for (const rooms of [undefined, []] as const) {
    const status = { peers: {}, ...(rooms === undefined ? {} : { rooms }) };
    const terminal = await consoleRig(status);
    terminal.clear(); terminal.input("8");
    expect(terminal.frame()).not.toContain("8 Rooms"); expect(terminal.frame()).not.toContain("Room status unavailable");
    expect(terminal.requests.some(request => request.t === "status")).toBe(true);
  }
  const terminal = await consoleRig({ peers: {}, rooms: null });
  terminal.clear(); terminal.input("8");
  expect(terminal.frame()).toContain("Room status unavailable");
});

test("Rooms rows scroll independently and never turn peer mutation keys into room actions", () => {
  const rooms = projectRoomStatus(Array.from({ length: 40 }, (_, index) => row(`room-${String(index).padStart(2, "0")}`, { members: index + 1 })));
  let state = reduceConsole({ ...initialConsoleState(true), peers: { codex: { state: "idle" } }, rooms }, "8", NOW).state;
  expect(panelRows(state)).toHaveLength(40); expect(selectedPanelRow(state)?.name).toBe("room-00");
  state = reduceConsole(state, ">", NOW).state;
  expect(selectedPanelRow(state)?.name).toBe("room-39");
  for (const key of ["p", "r", "m"]) {
    const result = reduceConsole(state, key, NOW);
    expect(result.effects).toEqual([]); expect(result.state.panel).toBe(8); expect(result.state.peers.codex.state).toBe("idle");
    state = result.state;
  }
  const web = reduceConsole(state, "w", NOW);
  expect(web.effects).toEqual([{ type: "command", args: ["ui"] }]); // Global dashboard shortcut, not a peer WIP edit.
  expect(web.state.settingsEdit).toBeUndefined(); expect(web.state.panel).toBe(8);
});

test("room relay counters stay unknown rather than becoming zero", () => {
  const rooms = projectRoomStatus([row("work", { relays: null })]);
  const state = reduceConsole({ ...initialConsoleState(true), rooms }, "8", NOW).state;
  const detail = reduceConsole(state, "\r", NOW).state;
  const text = renderConsole(detail, 120, 40, NOW).join("\n");
  expect(text).toContain("out handoff"); expect(text).toContain("unknown");
  expect(text).not.toContain("out handoff 0"); expect(text).not.toContain("in admitted 0"); expect(text).not.toContain("withheld 0");
});
