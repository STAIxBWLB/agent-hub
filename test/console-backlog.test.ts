import { expect, test } from "bun:test";
import { initialConsoleState, reduceConsole, renderConsole, panelRows, parseConsoleCommand, commandNeedsConfirmation, type ConsoleState } from "../src/cli/console-state.ts";
import { runConsole, type ConsoleTerminal } from "../src/cli/console.ts";

const NOW = 1_800_000_000_000;
type BacklogState = ConsoleState & { backlogView?: boolean };
const task = (id = 17, overrides: Record<string, unknown> = {}) => ({
  id, title: `backlog ${id}`, state: "backlog", class: "implement", created: NOW - 60_000, updated: NOW,
  planningRevision: 4, flowRevision: 7, priority: 2, rank: 3, reserved: "codex", deps: [] as number[], ...overrides,
});
function state(backlog = true, rows = [task()]): BacklogState {
  return { ...initialConsoleState(true), panel: 3, tasksKnown: true, tasks: rows, backlogView: backlog, features: ["task_cancel"] };
}
const step = (s: BacklogState, key: string) => reduceConsole(s, key, NOW);
function prepared(key: string, row = task()) {
  const result = step(state(true, [row]), key);
  expect(result.effects).toEqual([]);
  expect(result.state.editing).toBe(true);
  return result.state as BacklogState;
}
function confirmed(s: BacklogState, suffix: string) {
  const result = step({ ...s, input: s.input + suffix }, "\r");
  expect(result.effects).toEqual([]);
  expect(result.state.confirm?.type).toBe("command");
  if (result.state.confirm?.type !== "command") throw new Error("missing command confirmation");
  return { result, args: result.state.confirm.args };
}

test("#532 B1 toggles backlog rank/id ordering and resets selection without changing open-task view", () => {
  const s = state(false, [task(19, { rank: 2 }), task(7, { state: "proposed" }), task(12, { rank: 1 }), task(11, { rank: 1 }), task(9, { rank: undefined })]);
  s.selection = 3; s.taskSelection = 7; s.detail = { id: 7 };
  const result = step(s, "b");
  expect(result.effects).toEqual([]);
  expect((result.state as BacklogState).backlogView).toBe(true);
  expect(result.state.selection).toBe(0);
  expect(result.state.taskSelection).toBeUndefined();
  expect(result.state.detail).toBeUndefined();
  expect(panelRows(result.state).map(row => row.id)).toEqual([11, 12, 19, 9]);
  const back = step(result.state, "b");
  expect((back.state as BacklogState).backlogView).toBe(false);
  expect(panelRows(back.state).map(row => row.id)).toEqual([7]);
});

test("#532 B1 backlog table shows count, priority/rank, reservation, approved deps and public PII stub", () => {
  const s = state(true, [
    task(17, { rank: 1, deps: [91, 92] }), task(18, { rank: 2, deps: [91], reserved: null }),
    task(19, { rank: 3, title: "[pii]", signals: ["pii"] }),
    task(91, { state: "approved" }), task(92, { state: "cancelled" }),
  ]);
  const lines = renderConsole(s, 200, 30, NOW), view = lines.join("\n");
  const header = lines.find(line => /\bID\s+PRI\b/.test(line));
  expect(header).toBeDefined();
  expect(header!.match(/\b(?:ID|PRI|RESERVED|DEPS|CLASS|AGE|TITLE)\b/g)).toEqual(["ID", "PRI", "RESERVED", "DEPS", "CLASS", "AGE", "TITLE"]);
  expect(view).toMatch(/backlog[^\n]*3|3[^\n]*backlog/i);
  expect(lines.find(line => line.includes("backlog 17"))).toContain("92");
  expect(lines.find(line => line.includes("backlog 17"))).not.toContain("91");
  expect(lines.find(line => line.includes("backlog 18"))).toContain("ready");
  expect(view).toContain("[pii]");
  expect(view).not.toContain("backlog 91");
  expect(view).not.toContain("backlog 92");
});

test("#532 B1 backlog table keeps ID RESERVED TITLE and row widths bounded on a narrow terminal", () => {
  const s = state(true, [task(17, { reserved: "codex-implementation-instance", priority: 32, rank: 123456789, deps: [1001, 1002, 1003, 1004, 1005], title: "A long backlog title that still identifies the selected work" })]);
  for (const width of [80, 100]) {
    const lines = renderConsole(s, width, 24, NOW);
    expect(lines).toHaveLength(24);
    for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
    const header = lines.find(line => /\bID\b.*\bRESERVED\b.*\bTITLE\b/.test(line));
    expect(header).toBeDefined();
    if (width === 80) expect(header!.match(/\b(?:PRI|DEPS|CLASS|AGE)\b/g)?.length ?? 0).toBeLessThan(4);
  }
});

test("#532 B1 hints offer backlog actions and omit open-task-only actions", () => {
  const hint = renderConsole(state(), 260, 30, NOW).at(-1)!;
  for (const key of ["b ", "p ", "a ", "e ", "c ", "n "]) expect(hint).toContain(key);
  for (const key of ["u unassign", "r review", "R return"]) expect(hint).not.toContain(key);
  const empty = renderConsole(state(true, []), 200, 30, NOW).at(-1)!;
  expect(empty).toContain("n "); expect(empty).toContain("b ");
  for (const key of ["p ", "a ", "e ", "c "]) expect(empty).not.toContain(key);
});

for (const key of ["p", "a", "e", "c"]) test(`#532 B2 ${key} prefills the selected row's expected command and requires confirmation`, () => {
  const s = prepared(key);
  const args = parseConsoleCommand(s.input + "'operator reason'");
  if (key === "p") expect(args).toEqual(["backlog", "pull-ready", "17", "4", "operator reason"]);
  if (key === "a") { expect(args.slice(0, 4)).toEqual(["backlog", "plan", "17", "4"]); expect(JSON.parse(args[4]!)).toEqual({ reserved: "codex" }); }
  if (key === "e") { expect(args.slice(0, 4)).toEqual(["backlog", "plan", "17", "4"]); expect(JSON.parse(args[4]!)).toEqual({ priority: 2, rank: 3, deps: [] }); }
  if (key === "c") expect(args).toEqual(["task", "cancel", "17", "--revision", "7", "--reason", "operator reason"]);
  const pending = confirmed(s, "'operator reason'");
  expect(pending.args).toEqual(args);
  expect(step(pending.result.state, "y").effects).toEqual([{ type: "command", args }]);
});

test("#532 B2 reservation without a current peer is editable as an empty reservation field", () => {
  const s = prepared("a", task(17, { reserved: null }));
  expect(JSON.parse(parseConsoleCommand(s.input + "reason")[4]!).reserved).toBe("");
});

for (const key of ["p", "a", "e", "c"]) test(`#532 B2 ${key} Esc in editor or confirmation sends nothing`, () => {
  const s = prepared(key);
  const editCancel = step(s, "\x1b");
  expect(editCancel.effects).toEqual([]); expect(editCancel.state.editing).toBe(false); expect(editCancel.state.input).toBe("");
  const pending = confirmed(s, "reason");
  const confirmCancel = step(pending.result.state, "\x1b");
  expect(confirmCancel.effects).toEqual([]); expect(confirmCancel.state.confirm).toBeUndefined();
});

for (const mutation of ["id", "revision"]) test(`#532 B2 selected backlog ${mutation} cannot be edited in a prefilled action`, () => {
  const s = prepared("p");
  s.input = mutation === "id" ? "backlog pull-ready 99 4 reason" : "backlog pull-ready 17 99 reason";
  const result = step(s, "\r");
  expect(result.effects).toEqual([]); expect(result.state.confirm).toBeUndefined();
  expect(result.state.notice).toMatch(/id|revision|selected/i);
});

for (const when of ["enter", "confirm"]) test(`#532 B2 a stale planning revision before ${when} refuses without a command`, () => {
  let s = prepared("p");
  if (when === "confirm") s = confirmed(s, "reason").result.state;
  else s.input += "reason";
  s.tasks = s.tasks.map(row => ({ ...row, planningRevision: row.planningRevision + 1 }));
  const result = step(s, when === "confirm" ? "y" : "\r");
  expect(result.effects).toEqual([]); expect(result.state.confirm).toBeUndefined();
  expect(result.state.notice).toMatch(/changed|revision|stale|refresh/i);
});

for (const backlog of [false, true]) test(`#532 B3 n adds to backlog in ${backlog ? "backlog" : "open-task"} view with the pet enabled`, () => {
  const s = state(backlog); s.petEnabled = true;
  const result = step(s, "n");
  expect(result.effects).toEqual([]); expect(result.state.editing).toBe(true);
  expect(result.state.input).toBe("backlog add implement ");
  const pending = confirmed(result.state, "a new task");
  expect(pending.args).toEqual(["backlog", "add", "implement", "a", "new", "task"]);
  expect(step(pending.result.state, "\x1b").effects).toEqual([]);
});

for (const [name, row, prefix] of [
  ["ownerless proposed", task(17, { state: "proposed", owner: null }), ["backlog", "return", "17"]],
  ["accepted", task(17, { state: "in_progress", owner: "codex" }), ["backlog", "return", "17", "4"]],
] as const) test(`#532 B4 R prefills ${name} return through the existing confirmed command`, () => {
  const result = step(state(false, [row]), "R");
  expect(result.effects).toEqual([]); expect(result.state.editing).toBe(true);
  expect(parseConsoleCommand(result.state.input)).toEqual([...prefix]);
  const pending = confirmed(result.state, prefix.length === 4 ? "reason" : "");
  expect(pending.args.slice(0, prefix.length)).toEqual([...prefix]);
  expect(step(pending.result.state, "\x1b").effects).toEqual([]);
});

test("#532 B4 in-review work offers no return action", () => {
  const s = state(false, [task(17, { state: "in_review", owner: "codex", reviewer: "claude" })]);
  const result = step(s, "R");
  expect(result.effects).toEqual([]); expect(result.state.editing).toBe(false);
  expect(renderConsole(s, 240, 30, NOW).at(-1)).not.toContain("R return");
});

for (const operation of ["add", "pull", "pull-ready", "return", "plan", "split", "undo"]) test(`#532 B5 backlog ${operation} is allowlisted and requires person confirmation`, () => {
  expect(parseConsoleCommand(`backlog ${operation} 17`)).toEqual(["backlog", operation, "17"]);
  expect(commandNeedsConfirmation(["backlog", operation, "17"])).toBe(true);
});

test("#532 B5 read-only backlog list bypasses confirmation while task propose --backlog does not", () => {
  expect(parseConsoleCommand("backlog list")).toEqual(["backlog", "list"]);
  expect(commandNeedsConfirmation(["backlog", "list"])).toBe(false);
  const list = step({ ...state(), editing: true, input: "backlog list" }, "\r");
  expect(list.effects).toEqual([{ type: "command", args: ["backlog", "list"] }]);
  const proposal = step({ ...state(), editing: true, input: "task propose --backlog implement new task" }, "\r");
  expect(proposal.effects).toEqual([]); expect(proposal.state.confirm?.type).toBe("command");
});


test("#532 B2 a missing planningRevision uses the board's initial zero revision", () => {
  const s = prepared("p", task(17, { planningRevision: undefined }));
  expect(parseConsoleCommand(s.input + "reason")).toEqual(["backlog", "pull-ready", "17", "0", "reason"]);
  expect(confirmed(s, "reason").args).toEqual(["backlog", "pull-ready", "17", "0", "reason"]);
});

for (const when of ["enter", "confirm"]) test(`#532 B4 ownerless return checks its flow revision before ${when}`, () => {
  let s = step(state(false, [task(17, { state: "proposed", owner: null })]), "R").state;
  expect(s.editing).toBe(true);
  if (when === "confirm") s = confirmed(s, "").result.state;
  s.tasks = s.tasks.map(row => ({ ...row, flowRevision: row.flowRevision + 1 }));
  const result = step(s, when === "confirm" ? "y" : "\r");
  expect(result.effects).toEqual([]); expect(result.state.confirm).toBeUndefined();
  expect(result.state.notice).toMatch(/changed|revision|stale|refresh/i);
});

const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function runtimeFixture(rows = [task()], refusal?: string) {
  let data = (_text: string) => {};
  const output: string[] = [], commands: string[][] = [], requests: any[] = [];
  const terminal: ConsoleTerminal = {
    columns: 180, rows: 30, isTTY: true, write: text => { output.push(text); }, raw: () => {},
    onData: listener => { data = listener; return () => {}; }, onResize: () => () => {}, onSignal: () => () => {},
  };
  const client = {
    onPush: (_message: any) => {}, onClose: (_code: number, _reason: string) => {}, send: (_message: any) => {}, close: () => {},
    request: async (message: any) => {
      requests.push(message);
      if (message.t === "task" && message.op === "hub_task_list") return { ok: true, text: JSON.stringify(message.args?.ready ? [] : rows) };
      if (message.t === "settings_get") return { ok: true, rows: [] };
      return { ok: true, status: { peers: {}, features: ["task_cancel"], tasks: { backlog: rows.filter(row => row.state === "backlog").length } }, budget: {}, text: "[]", deliveries: [] };
    },
  };
  const running = runConsole({ client, cwd: "/tmp/fixture-only", stateDir: "/tmp/fixture-only", terminal, panels: true, color: false, noPet: true, pollMs: 1_000_000,
    runCommand: (args, write, finished) => {
      commands.push(args);
      if (refusal) write(`${refusal}\n`);
      (finished as (code?: number) => void)(refusal ? 1 : 0);
      return () => {};
    },
  });
  const input = (value: string) => data(value);
  const type = (value: string) => { for (const character of value) input(character); };
  return { output, commands, requests, input, type, stop: async () => { input("\x03"); await running; } };
}

test("#532 B2 runtime pull-ready sends only the confirmed argv through the injected CLI runner", async () => {
  const f = runtimeFixture();
  try {
    await tick(); f.input("3"); await tick(); f.input("b"); f.input("p"); f.type("'operator reason'"); f.input("\r");
    expect(f.commands).toEqual([]);
    f.input("y"); await tick();
    expect(f.commands).toEqual([["backlog", "pull-ready", "17", "4", "operator reason"]]);
    expect(f.requests.some(message => message.op === "hub_backlog_list")).toBe(false);
    expect(f.requests.some(message => message.op === "hub_task_list")).toBe(true);
  } finally { await f.stop(); }
});

for (const refusal of ["planning revision changed", "reserved peer codex is at WIP limit 2/2"]) test(`#532 B2 runtime surfaces hub refusal as a visible notice: ${refusal}`, async () => {
  const f = runtimeFixture([task()], refusal);
  try {
    await tick(); f.input("3"); await tick(); f.input("b"); f.input("p"); f.type("reason"); f.input("\r");
    f.output.length = 0; f.input("y"); await tick();
    expect(f.commands).toHaveLength(1);
    // Panels do not display the Events stream: the refused CLI text must survive as an operator notice.
    const visible = f.output.filter(text => !text.startsWith("    ")).join("");
    expect(visible).toContain(refusal);
    expect(visible).not.toContain("Console error:");
  } finally { await f.stop(); }
});

test("#532 B5 runtime backlog list runs without mutation confirmation, while pull Esc spawns nothing", async () => {
  const f = runtimeFixture();
  try {
    await tick(); f.input("3"); await tick(); f.input(":"); f.type("backlog list"); f.input("\r"); await tick();
    expect(f.commands).toEqual([["backlog", "list"]]);
    f.input("b"); f.input("p"); f.type("reason"); f.input("\r"); f.input("\x1b"); await tick();
    expect(f.commands).toEqual([["backlog", "list"]]);
  } finally { await f.stop(); }
});
