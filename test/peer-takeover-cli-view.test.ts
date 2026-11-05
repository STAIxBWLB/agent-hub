import { expect, test } from "bun:test";
import { initialConsoleState, reduceConsole, renderConsoleLines } from "../src/cli/console-state.ts";
import { runConsole, type ConsoleTerminal } from "../src/cli/console.ts";
import { renderStatus } from "../src/cli/output.ts";
import { LIVE_TEST_PERSON_REFUSAL } from "../src/cli/identity.ts";

const standbyId = "452ad7d7-3430-4b2c-b5be-56d96b54ea36";
const plain = (rows: { text: string }[][]) => rows.map(row => row.map(cell => cell.text).join("")).join("\n");

test("status shows standby process and session identity with takeover guidance", () => {
  const output = plain(renderStatus({ peers: { claude: { state: "busy", standbySessions: [{ id: standbyId, pid: 1234, since: 60_000 }] } } }, undefined, 120_000));
  expect(output).toContain("pid 1234");
  expect(output).toContain(standbyId);
  expect(output).toContain(`ahub peer takeover claude ${standbyId}`);
});

test("console takeover targets the displayed standby and status detail shows its identity", () => {
  const state = initialConsoleState(true);
  state.features = ["peer_takeover"];
  state.peers = { claude: { state: "busy", standbySessions: [{ id: standbyId, pid: 1234, since: 60_000 }] } };
  const selected = reduceConsole(state, "o", 120_000);
  expect(selected.effects).toEqual([{ type: "peer_takeover", peer: "claude", standbyId }]);
  const opened = reduceConsole({ ...state, peers: { ...state.peers } }, "\r", 120_000).state;
  expect(plain(renderConsoleLines(opened, 160, 24, 120_000))).toContain(standbyId);
  expect(plain(renderConsoleLines(state, 160, 24, 120_000))).toContain("+standby:1");
});

test("console does not offer or dispatch takeover without current feature and UUID", () => {
  const oldHub = initialConsoleState(true);
  oldHub.peers = { claude: { state: "busy", standbySessions: [{ id: standbyId }] } };
  const oldHubAction = reduceConsole(oldHub, "o", 120_000);
  expect(oldHubAction.effects).toEqual([]);
  expect(oldHubAction.state.notice).toContain("newer hub");
  const malformed = initialConsoleState(true);
  malformed.features = ["peer_takeover"];
  malformed.peers = { claude: { state: "busy", standbySessions: [{ id: "not-an-id" }] } };
  const malformedAction = reduceConsole(malformed, "o", 120_000);
  expect(malformedAction.effects).toEqual([]);
  expect(malformedAction.state.notice).toContain("refresh ahub status");
});

test("delegated console refuses peer takeover before sending the person-only request", async () => {
  let input = (_text: string) => {};
  const requests: any[] = [], output: string[] = [];
  const terminal: ConsoleTerminal = { columns: 120, rows: 30, isTTY: true, write: text => output.push(text), raw: () => {},
    onData: listener => { input = listener; return () => {}; }, onResize: () => () => {}, onSignal: () => () => {}, onError: () => () => {} };
  const client = { onPush: (_message: any) => {}, onClose: (_code: number, _reason: string) => {}, send: () => {}, close: () => {},
    request: async (message: any) => {
      requests.push(message);
      if (message.t === "status") return { ok: true, status: { features: ["peer_takeover"], peers: { claude: { state: "busy", standbySessions: [{ id: standbyId, pid: 1234, since: 60_000 }] } } } };
      return { ok: true, budget: {}, peers: [], status: { peers: {} }, text: "[]", deliveries: [] };
    } };
  const running = runConsole({ client: client as any, cwd: "/tmp", stateDir: "/tmp", terminal, panels: true, liveTest: true });
  const tick = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); await Bun.sleep(5); };
  try {
    await tick(); input("o"); await tick();
    expect(requests.some(message => message.t === "peer_takeover")).toBe(false);
    expect(output.join("")).toContain(LIVE_TEST_PERSON_REFUSAL);
  } finally { input("q"); await running; }
});

test("console handles the control client's resolved closed-socket reply as an unknown outcome", async () => {
  let input = (_text: string) => {};
  const requests: any[] = [], output: string[] = [];
  const terminal: ConsoleTerminal = { columns: 200, rows: 30, isTTY: true, write: text => output.push(text), raw: () => {},
    onData: listener => { input = listener; return () => {}; }, onResize: () => () => {}, onSignal: () => () => {}, onError: () => () => {} };
  const client = { onPush: (_message: any) => {}, onClose: (_code: number, _reason: string) => {}, send: () => {}, close: () => {},
    request: async (message: any) => {
      requests.push(message);
      if (message.t === "peer_takeover") return { ok: false, error: "hub connection closed" };
      if (message.t === "status") return { ok: true, status: { features: ["peer_takeover"], peers: { claude: { state: "busy", standbySessions: [{ id: standbyId, pid: 1234, since: 60_000 }] } } } };
      return { ok: true, budget: {}, peers: [], status: { peers: {} }, text: "[]", deliveries: [] };
    } };
  const running = runConsole({ client: client as any, cwd: "/tmp", stateDir: "/tmp", terminal, panels: true });
  const tick = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); await Bun.sleep(5); };
  try {
    await tick(); input("o"); await tick();
    expect(requests.filter(message => message.t === "peer_takeover")).toHaveLength(1);
    expect(output.join("")).toContain("inspect ahub status before retrying; takeover may already have started");
    expect(output.join("")).not.toContain("Console error:");
  } finally { input("q"); await running; }
});
