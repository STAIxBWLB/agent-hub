import { expect, test } from "bun:test";
import { initialConsoleState, keyTable, panelRows, reduceConsole, renderConsole, type ConsoleMilestone, type ConsoleState } from "../src/cli/console-state.ts";
import { runConsole, type ConsoleTerminal } from "../src/cli/console.ts";
import { roadmapSummary } from "../src/hub/manager.ts";

// #1483 R5: the console's Roadmap panel (9) and the per-project summary `ahub ui --all` lists.
const NOW = Date.UTC(2026, 10, 22, 12);
const strip = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const milestone = (id: number, over: Partial<ConsoleMilestone> = {}): ConsoleMilestone =>
  ({ id, title: "milestone " + id, horizon: "now", state: "active", order: 0, approved: 0, total: 0, withheld: 0, ...over });
function roadmapState(over: Partial<ConsoleState> = {}): ConsoleState {
  const s = initialConsoleState(true); s.project = "agent-hub"; s.panel = 9; s.features = ["roadmap"];
  s.roadmap = [milestone(3, { horizon: "later", order: 1 }), milestone(1, { order: 2, approved: 1, total: 3 }),
    milestone(2, { order: 1, approved: 2, total: 2, withheld: 4 }), milestone(4, { horizon: "next" }), milestone(5, { horizon: "someday" })];
  s.roadmapKnown = true; s.roadmapDrift = { at: NOW - 4000, findings: 2, unknown: 1 };
  Object.assign(s, over);
  return s;
}
const screen = (s: ConsoleState, columns = 120) => strip(renderConsole(s, columns, 24, NOW));

test("the Roadmap panel is tab 9 and lists milestones in now/next/later order with progress and a private count (#1483)", () => {
  const out = screen(roadmapState());
  expect(out).toContain("[9 Roadmap]");
  expect(out).toMatch(/ID\s+HORIZON\s+STATE\s+PROGRESS\s+PRIVATE\s+TITLE/);
  expect(out).toMatch(/2\s+now\s+active\s+2\/2\s+4\s+milestone 2/);      // a withheld member is a count, never a name
  expect(out).toMatch(/1\s+now\s+active\s+1\/3\s+-\s+milestone 1/);
  expect(out).toMatch(/4\s+next\s+active\s+-\s+-\s+milestone 4/);         // no tasks is unknown, not 0%
  expect(out).toContain("drift 2 findings, 1 unknown, 4s ago; lanes now, next, later");
  const rows = panelRows(roadmapState()).map(row => row.id);
  expect(rows).toEqual([2, 1, 4, 3, 5]);                                  // lane order, then the milestone's own order; an unknown horizon trails
});

test("a hub that refuses the read says so, and an absent answer is loading, never an empty roadmap (#1483)", () => {
  expect(screen(roadmapState({ roadmapProblem: "roadmap is read by the person" }))).toContain("roadmap unavailable: roadmap is read by the person");
  expect(screen(roadmapState({ roadmapKnown: false, roadmap: undefined, roadmapDrift: undefined }))).toContain("roadmap loading...");
  const refused = roadmapState({ roadmapDrift: { at: NOW, findings: 0, problem: "roadmap drift was not read" } });
  expect(screen(refused)).toContain("drift: roadmap drift was not read");
});

test("key 9 opens the Roadmap panel only on a hub that advertises it, and Enter asks for one milestone (#1483)", () => {
  const opened = reduceConsole(roadmapState({ panel: 1 }), "9", NOW).state;
  expect(opened.panel).toBe(9);
  expect(reduceConsole({ ...roadmapState({ panel: 1 }), features: [] as string[] }, "9", NOW).state.panel).toBe(1);
  expect(keyTable(120, false, false, false, true).flat().map(span => span.text).join(" ")).toContain("9 Roadmap panel");
  expect(keyTable(120).flat().map(span => span.text).join(" ")).not.toContain("9 Roadmap panel");
  expect(reduceConsole(roadmapState(), "\r", NOW).effects).toContainEqual({ type: "show", panel: 9, id: "2" });
});

test("the per-project summary counts lanes and states, and an unknown value keeps its own name (#1483)", () => {
  const summary = roadmapSummary([{ horizon: "now", state: "active" }, { horizon: "now", state: "planned" }, { horizon: "later" }, { horizon: "someday", state: "dropped" }], 3);
  expect(summary.total).toBe(4);
  expect(summary.byHorizon).toEqual({ now: 2, later: 1, someday: 1 });
  expect(summary.byState).toEqual({ active: 1, planned: 1, proposed: 1, dropped: 1 });   // a row without a state reads proposed
  expect(summary.drift).toBe(3);
  expect(summary.partial).toBe(false);
  expect(roadmapSummary([])).toEqual({ total: 0, byHorizon: {}, byState: {}, drift: 0, partial: false });
});

// ---- a real runConsole round trip: only the Roadmap panel asks the roadmap ops, and the drift check is not repeated every poll ----
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

test("runConsole asks the roadmap list only while panel 9 is open, and the drift check is cached (#1483)", async () => {
  const views = { milestones: [{ id: 7, title: "Ship R5", horizon: "next", state: "active", order: 0, withheld: 2, rollup: { tasks: { approved: 1, total: 2 } } }] };
  const f = rig(msg => msg.op === "hub_roadmap_list" ? { ok: true, text: JSON.stringify(views) }
    : msg.op === "hub_roadmap_check" ? { ok: true, text: JSON.stringify({ findings: [{ rule: "unplaced" }], unknown: [] }) }
    : msg.t === "task" ? { ok: true, text: "[]" }
    : { ok: true, status: { peers: {}, features: ["roadmap"] }, budget: {}, text: "[]", deliveries: [] });
  await tick();
  expect(f.requests.filter(r => r.op === "hub_roadmap_list" || r.op === "hub_roadmap_check")).toEqual([]);   // panels 1 to 8 never ask
  f.input("9"); await tick();
  expect(f.requests.filter(r => r.op === "hub_roadmap_list").length).toBe(1);
  expect(f.requests.filter(r => r.op === "hub_roadmap_check").length).toBe(1);
  const tail = strip(f.output.join("").split("\x1b[r").slice(-1));
  expect(tail).toContain("Ship R5");
  expect(tail).toContain("1/2");
  expect(tail).toContain("1 finding");                                    // the check's own count, read once
  f.input("q"); await f.running;
});

test("a roadmap refusal is shown as unavailable, never as an empty roadmap (#1483)", async () => {
  const f = rig(msg => msg.op === "hub_roadmap_list" ? { ok: false, error: "roadmap is read by the person" }
    : msg.t === "task" ? { ok: true, text: "[]" }
    : { ok: true, status: { peers: {}, features: ["roadmap"] }, budget: {}, text: "[]", deliveries: [] });
  await tick(); f.input("9"); await tick();
  expect(strip(f.output.join("").split("\x1b[r").slice(-1))).toContain("roadmap unavailable: roadmap is read by the person");
  f.input("q"); await f.running;
});
