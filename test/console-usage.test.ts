import { expect, test } from "bun:test";
import { initialConsoleState, reduceConsole, renderConsole, type ConsoleState } from "../src/cli/console-state.ts";
import { runConsole, type ConsoleTerminal } from "../src/cli/console.ts";
import { counterText, rowTokens, usagePeers, usageTaskLines } from "../src/cli/console-usage.ts";

// #683 U3: the console Usage panel, driven from state fixtures (renderConsole, reduceConsole) and one runConsole round trip with a scripted client.
const NOW = Date.UTC(2026, 9, 22, 12);
const strip = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const c = (value: number | null, source: any = "native") => ({ value, source });
const unknown = c(null, "unknown");
const row = (key: string, total: any, counted: any, extra: Record<string, unknown> = {}) =>
  ({ key, records: 3, counted, input: c(10), output: c(5), cacheRead: unknown, cacheWrite: unknown, reasoning: unknown, total, totalWithoutCache: unknown, ...extra });
const result = (rows: any[], extra: Record<string, unknown> = {}) => ({ by: "peer", rows, coverage: { records: 0, withUsage: 0, withoutUsage: 0 }, throughOffset: 0, ...extra });

function usageState(over: Partial<ConsoleState> = {}): ConsoleState {
  const s = initialConsoleState(true); s.project = "agent-hub"; s.panel = 7;
  s.peers = { codex: { state: "online" }, jcode: { state: "online" }, claude: { state: "online" }, pi: { state: "offline" } };
  s.budget = { codex: { windows: [{ id: "5h", used: 0.42, resetsAt: NOW + 3 * 3600e3 }, { id: "week", used: 0.1, resetsAt: NOW + 4 * 86400e3 }] },
    claude: { windows: [{ id: "5h", used: 0.97, resetsAt: NOW + 3600e3 }], paused: { resetsAt: NOW + 3600e3 } } };
  s.usage = { at: NOW - 5000,
    today: result([row("codex", c(1_250_000), c(1_250_000, "count")), row("jcode", unknown, c(77, "count"))]) as any,
    week: result([row("codex", c(8_400_000), c(8_400_000, "count")), row("jcode", unknown, c(900, "count"))]) as any,
    life: result([row("codex", c(52_000_000), c(52_000_000, "count")), row("jcode", unknown, c(4000, "count")), row("claude", c(3_000_000), c(3_000_000, "count"))]) as any,
    limits: { history: [{ at: new Date(NOW - 2 * 86400e3).toISOString(), type: "quota_reset", peer: "codex", window: "5h", detail: {} },
      { at: new Date(NOW - 86400e3).toISOString(), type: "budget_pause", peer: "claude", window: "5h", detail: {} }], total: 2, shown: 2, truncated: false, omitted: 0, limit: 1000, maxLimit: 5000, open: [], endedUnknown: [] } as any };
  Object.assign(s, over);
  return s;
}
const screen = (s: ConsoleState, columns = 120) => strip(renderConsole(s, columns, 24, NOW));

test("the Usage panel is tab 7 and shows today, 7d and lifetime per peer, each number with its source (#683 U3)", () => {
  const out = screen(usageState());
  expect(out).toContain("[7 Usage]");
  expect(out).toMatch(/PEER\s+TODAY\s+7D\s+LIFETIME\s+PAUSE\s+QUOTA\s+LAST RESET/);
  expect(out).toMatch(/codex\s+1\.3M native\s+8\.4M native\s+52M native/);
  expect(out).toMatch(/jcode\s+77 hub\s+900 hub\s+4000 hub/);                           // a peer with no provider counters shows the hub's own count, labelled
});

test("an unknown counter reads unknown or no records, never 0, and a peer with nothing is not a zero row (#683 U3)", () => {
  const out = screen(usageState({ usage: { at: NOW, today: result([row("jcode", unknown, unknown)]) as any, week: result([]) as any, life: result([row("jcode", unknown, unknown)]) as any, limits: undefined } }));
  expect(out).toMatch(/jcode\s+unknown\s+no records\s+unknown/);
  expect(out).not.toMatch(/jcode[^\n]*\b0\b/);
  expect(counterText(unknown)).toBe("unknown"); expect(counterText(undefined)).toBe("unknown");
  expect(counterText(c(0))).toBe("0 native");                                              // a real zero from the provider is a number; only null is unknown
  expect(rowTokens(row("x", unknown, unknown))).toEqual(unknown);
});

test("quota windows with their reset time, the current pause and the last reset come from the budget and the limits history (#683 U3)", () => {
  const out = screen(usageState());
  expect(out).toMatch(/codex\s+[^\n]*-\s+5h 42% 3h00m, week 10% 4d00h\s+5h 2d00h ago/);
  expect(out).toMatch(/claude\s+[^\n]*1h00m\s+5h 97% 1h00m/);                            // the pause (resumes in 1h) and the window
  expect(out).toMatch(/jcode\s+[^\n]*-\s+-\s+-$/m);                                        // nothing known: dashes, never a made-up value
});

test("Enter opens a peer's detail with the token split, cache read and write separate, each with its source (#683 U3)", () => {
  const s = usageState();
  s.usage!.life = result([row("codex", c(52_000_000), c(52_000_000, "count"), { input: c(40_000_000), output: c(2_000_000), cacheRead: c(10_000_000), cacheWrite: unknown })]) as any;
  s.selection = 1;                                                                           // codex (claude, codex, jcode, pi)
  const opened = reduceConsole(s, "\r", NOW).state;
  const out = screen(opened);
  expect(out).toMatch(/^peer\s+codex/m);
  expect(out).toMatch(/quota\s+5h 42% in 3h00m, week 10% in 4d00h/);
  expect(out).toMatch(/pause\s+none/); expect(out).toMatch(/last resets\s+5h 2d00h ago/);
  expect(out).toContain("input 40000000 native"); expect(out).toContain("output 2000000 native");
  expect(out).toContain("cache read 10000000 native"); expect(out).toContain("cache write unknown");   // an unreported counter is unknown, not 0
  expect(strip(renderConsole(reduceConsole(opened, "\x1b", NOW).state, 120, 24, NOW))).toMatch(/PEER\s+TODAY/);   // Esc returns to the table
});

test("the task selected in Tasks shows its tokens per peer in the Usage panel, and a private task is [pii] with no title (#683 U3)", () => {
  let s = usageState({ panel: 3, tasks: [{ id: 41, state: "in_progress", title: "SECRET-TITLE-FOR-41", class: "implement" }, { id: 42, state: "in_progress", title: "SECRET-TITLE-FOR-42", class: "implement" }] });
  s = reduceConsole(s, "j", NOW).state;                                                      // select #42
  s = reduceConsole(s, "7", NOW).state;
  expect(s.panel).toBe(7); expect(s.usageTask).toBe(42);
  expect(screen(s)).toContain("task #42: loading...");                                      // asked for, not yet answered
  s.usage = { ...s.usage!, taskId: 42, task: result([row("codex", c(5000), c(5000, "count")), row("jcode", unknown, unknown)], { task: 42, taskPii: true }) as any };
  const out = screen(s);
  expect(out).toContain("task #42 [pii]: tokens per peer, all time");
  expect(out).toMatch(/codex\s+5000 native/); expect(out).toMatch(/jcode\s+unknown/);
  expect(out).not.toContain("SECRET-TITLE");
  const plain = usageTaskLines({ ...s.usage!, taskId: 42, task: result([], { task: 42 }) as any }, 42);
  expect(plain.map(l => l.text)).toEqual(["task #42: tokens per peer, all time", "  no usage recorded for this task"]);
  expect(usageTaskLines(undefined, undefined)[0]!.text).toContain("none selected");
  expect(usageTaskLines({ taskId: 7, task: result([]) as any }, 8)[0]!.text).toBe("task #8: loading...");  // an answer for another task is never shown as this one's
});

test("Left and Right reach the Usage panel with Settings' wrap, and the pinned 1..5 cycle is unchanged (#309, #683 U3)", () => {
  const s = usageState({ panel: 6 });
  expect(reduceConsole(s, "\x1b[C", NOW).state.panel).toBe(1);                              // Right from Settings wraps to Peers, as before
  expect(reduceConsole(usageState({ panel: 7 }), "\x1b[C", NOW).state.panel).toBe(1);
  expect(reduceConsole(usageState({ panel: 7 }), "\x1b[D", NOW).state.panel).toBe(5);
  expect(reduceConsole(usageState({ panel: 5 }), "\x1b[C", NOW).state.panel).toBe(1);
  expect(reduceConsole(usageState({ panel: 1 }), "7", NOW).state.panel).toBe(7);
  expect(reduceConsole(usageState({ panel: 1 }), "8", NOW).state.panel).toBe(1);
});

test("the panel says when usage is loading or unavailable, and stays within 80 columns with the pause, 7d and lifetime kept (#683 U3)", () => {
  expect(screen(usageState({ usage: undefined }))).toContain("usage loading...");
  expect(screen(usageState({ usage: { problem: "usage is read by the person and a configured planner" } }))).toContain("usage unavailable: usage is read by the person");
  const narrow = renderConsole(usageState(), 80, 24, NOW);
  for (const line of narrow) expect(Bun.stringWidth(line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""))).toBeLessThanOrEqual(80);
  const out = strip(narrow);
  expect(out).toMatch(/PEER\s+TODAY\s+7D\s+LIFETIME\s+PAUSE/); expect(out).toMatch(/claude\s+[^\n]*3\.0M native\s+1h00m/);
  expect(out).toContain("agent-hub");                                                         // the project name survives seven tabs
});

test("pressing 7 with nothing selected in Tasks clears the old task instead of keeping it (#683 U3, review)", () => {
  let s = usageState({ panel: 3, tasks: [{ id: 42, state: "in_progress", title: "t", class: "implement" }] });
  s = reduceConsole(s, "7", NOW).state; expect(s.usageTask).toBe(42);
  s = reduceConsole(s, "3", NOW).state;
  s.tasks = [];                                                                               // the task left the panel: no selected row
  s = reduceConsole(s, "7", NOW).state;
  expect(s.usageTask).toBeUndefined();
  expect(screen(s)).toContain("task: none selected");
  expect(screen(s)).not.toContain("task #42");
  // from another panel the selection is not read at all, so it is kept: only leaving Tasks with no row clears it
  s.usageTask = 9; s = reduceConsole(reduceConsole(s, "1", NOW).state, "7", NOW).state; expect(s.usageTask).toBe(9);
});

test("the selected-task lines stay on screen at 24 rows with 16 or more peers, and the table scrolls instead (#683 U3, review)", () => {
  const peers = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`peer${String(i).padStart(2, "0")}`, { state: "online" }]));
  const base = usageState({ peers, budget: {} });
  // only these peers: the fixture's own usage rows (codex, jcode, claude) would add peers to the list and move every index
  base.usage = { at: NOW, today: result([]) as any, week: result([]) as any, life: result([]) as any, taskId: 42, task: result([row("peer03", c(5000), c(5000, "count")), row("peer07", unknown, unknown)], { task: 42 }) as any };
  for (const count of [3, 15, 16, 20]) {
    const s = { ...base, peers: Object.fromEntries(Object.entries(peers).slice(0, count)), usageTask: 42 };
    for (const selection of [0, count - 1]) {
      const lines = renderConsole({ ...s, selection }, 100, 24, NOW);
      expect(lines).toHaveLength(24);
      const out = strip(lines);
      expect(out).toContain("task #42: tokens per peer, all time");                         // the heading and both rows, whatever the peer count
      expect(out).toMatch(/peer03\s+5000 native/); expect(out).toMatch(/peer07\s+unknown/);
      expect(out).toContain(`peer${String(selection === 0 ? 0 : count - 1).padStart(2, "0")}`);   // the selected peer row is still on screen
    }
  }
  // a very short terminal still keeps at least one table row and the task heading
  const tiny = strip(renderConsole({ ...base, usageTask: 42, selection: 5 }, 100, 12, NOW));
  expect(tiny).toContain("task #42: tokens per peer"); expect(tiny).toContain("peer05");
});

test("a roll-up that is still behind the event log says the numbers are partial (#683 U3)", () => {
  const s = usageState(); s.usage = { ...s.usage!, behind: true };
  const out = screen(s);
  expect(out).toContain("still catching up with the event log"); expect(out).not.toContain("usage through");
  expect(screen(usageState())).toContain("usage through");
});

test("usagePeers lists peers with usage or a quota even when they are not connected (#683 U3)", () => {
  expect(usagePeers(usageState().usage, {}, { codex: {} }).map(p => p.id)).toEqual(["claude", "codex", "jcode"]);
});

test("the key table lists the Usage panel (#683 U3)", () => {
  const s = usageState(); s.help = true;
  expect(screen(s, 100)).toContain("7 Usage panel");
});

// ---- a real runConsole round trip with a scripted client: only the Usage panel asks the usage op, and a reply for a stale task is dropped ----
function rig(answer: (msg: any) => any) {
  let data = (_text: string) => {};
  const requests: any[] = [], output: string[] = [];
  const terminal: ConsoleTerminal = { columns: 120, rows: 30, isTTY: true, write: text => { output.push(text); }, raw: () => {}, onData: listener => { data = listener; return () => {}; },
    onResize: () => () => {}, onSignal: () => () => {}, onError: () => () => {} };
  const client = { onPush: (_m: any) => {}, onClose: (_c: number, _r: string) => {}, send: () => {}, close: () => {},
    request: async (msg: any) => { requests.push(msg); return answer(msg); } };
  const running = runConsole({ client: client as any, cwd: "/tmp", stateDir: "/tmp", terminal, panels: true });
  return { requests, output, input: (text: string) => data(text), running };
}
const tick = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); await Bun.sleep(5); };

test("runConsole asks the usage op only while the Usage panel is open, with the day, the week, lifetime, limits and the selected task (#683 U3)", async () => {
  const tasks = [{ id: 42, state: "in_progress", title: "t", class: "implement", history: [] }];
  const f = rig(msg => msg.t === "usage" ? (msg.op === "limits" ? { ok: true, op: "limits", limits: usageState().usage!.limits, current: {} }
    : { ok: true, op: "query", usage: msg.task ? result([row("codex", c(5000), c(5000, "count"))], { task: msg.task }) : usageState().usage!.life })
    : msg.t === "task" ? { ok: true, text: JSON.stringify(tasks) } : { ok: true, status: { peers: { codex: { state: "online" } } }, budget: {}, text: "[]", deliveries: [] });
  await tick();
  expect(f.requests.filter(r => r.t === "usage")).toEqual([]);                              // panels 1 to 6 never ask
  f.input("3"); await tick(); f.input("7"); await tick();
  const asked = f.requests.filter(r => r.t === "usage");
  expect(asked.length).toBeGreaterThanOrEqual(5);
  expect(asked.filter(r => r.by === "peer" && r.since !== undefined && r.task === undefined).length).toBeGreaterThanOrEqual(2);   // today and 7 days
  expect(asked.some(r => r.by === "peer" && r.since === undefined && r.task === undefined)).toBe(true);                               // lifetime
  expect(asked.some(r => r.op === "limits" && r.limit === 1000)).toBe(true);
  expect(asked.some(r => r.task === 42)).toBe(true);                                       // the task selected in Tasks
  expect(strip(f.output)).toContain("task #42: tokens per peer, all time");                // the answered task line, which "loading..." cannot produce
  f.input("q"); await f.running;
});

test("a usage refusal is shown as unavailable, never as zero usage (#683 U3)", async () => {
  const f = rig(msg => msg.t === "usage" ? { ok: false, error: "usage is read by the person and a configured planner" } : { ok: true, status: { peers: {} }, budget: {}, text: "[]", deliveries: [] });
  await tick(); f.input("7"); await tick();
  expect(strip(f.output.join("").split("\x1b[r").slice(-1))).toContain("usage unavailable: usage is read by the person");
  f.input("q"); await f.running;
});
