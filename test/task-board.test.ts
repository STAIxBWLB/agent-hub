import { expect, test } from "bun:test";
import { boardColumns } from "../src/ui/task-board.ts";
import { PEER_PALETTE, peerStyle, peerPaletteCss } from "../src/ui/peer-palette.ts";
import { PALETTE, paint } from "../src/cli/console-state.ts";

test("board columns cover every task state and preserve unknown states without reading text (#263)", () => {
  const states = ["backlog", "proposed", "in_progress", "changes_requested", "in_review", "approved", "future"];
  const tasks = states.map((state, i) => ({ id: i + 1, state, started: !["backlog", "proposed"].includes(state), get title() { throw new Error("private text read"); }, get detail() { throw new Error("private text read"); }, get history() { throw new Error("private text read"); } }));
  const model = boardColumns(tasks, {});
  expect(model.columns.map(column => column.label)).toEqual(["Backlog", "To Do", "In Progress", "Review / QA", "Done"]);
  expect(model.columns.map(column => column.ready.map(card => card.id))).toEqual([[1], [2], [3, 4], [5], [6]]);
  expect(model.unknown).toEqual([7]);
  expect(model.columns.flatMap(column => column.ready).filter(card => card.assignable).map(card => card.id)).toEqual([2, 3, 4]);
  expect(model.columns[0]?.ready[0]?.pull).toBe(true);
  expect(model.columns[1]?.ready[0]?.returnable).toBe(true);
  expect(model.columns[3]?.ready[0]?.assignable).toBe(false);
  expect(model.columns[4]?.ready[0]?.assignable).toBe(false);
});

test("To Do separates dependency reservation hold offline and unknown waits from ready work (#263)", () => {
  const tasks = [
    { id: 1, state: "approved" }, { id: 2, state: "proposed", owner: "codex", deps: [1] },
    { id: 3, state: "proposed", deps: [99] }, { id: 4, state: "proposed", reserved: "kimi" },
    { id: 5, state: "proposed", owner: "paused" }, { id: 6, state: "proposed", owner: "offline" },
    { id: 7, state: "proposed", owner: "missing" }, { id: 8, state: "proposed", owner: "held" },
    { id: 9, state: "proposed", owner: "incomplete" }, { id: 10, state: "proposed", owner: "constructor" },
  ];
  const model = boardColumns(tasks, { codex: { state: "idle" }, paused: { state: "paused" }, offline: { state: "offline" }, held: { state: "idle", needsReview: 1 }, incomplete: {} });
  expect(model.columns[1]?.ready.map(card => card.id)).toEqual([2]);
  expect(model.columns[1]?.waiting.map(card => card.waiting[0])).toEqual(["dependencies not approved", "reserved owner not assigned", "owner delivery held", "owner unavailable", "owner status unknown", "owner delivery held", "owner status unknown", "owner status unknown"]);
});

test("priority stars and backlog controls never invent flow moves (#263)", () => {
  const tasks = [
    { id: 1, state: "backlog", urgent: true }, { id: 2, state: "proposed", priority: 1 },
    { id: 3, state: "in_review", priority: 3 }, { id: 4, state: "approved" },
    { id: 5, state: "proposed", owner: "codex", priority: 99 },
  ];
  const cards = boardColumns(tasks, { codex: { state: "busy" } }).columns.flatMap(column => [...column.ready, ...column.waiting]);
  expect(cards.map(card => [card.priority, card.starred])).toEqual([[0, true], [1, true], [2, false], [3, false], [2, false]]);
  expect(cards.find(card => card.id === 5)?.returnable).toBe(false);
  expect(cards.filter(card => card.pull).map(card => card.id)).toEqual([1]);
  expect(cards.filter(card => card.assignable).map(card => card.id)).toEqual([2, 5]);
});

test("peer palette is shared with terminal output and CSS and handles prototype-like ids (#263)", () => {
  for (const [peer, style] of Object.entries(PEER_PALETTE)) {
    expect(peerStyle(peer)).toBe(style);
    expect(PALETTE[style.tone]).toBe(style.ansi);
    expect(peerPaletteCss()).toContain(`.peer-${peer}{--peer-color:${style.css}}`);
    expect(paint([{ text: peer, tone: style.tone }], false)).toBe(peer);
  }
  for (const peer of ["constructor", "__proto__", "qwen", "jcode", "custom"]) expect(peerStyle(peer)).toBe(PEER_PALETTE.other);
});


test("board return controls refuse started and unknown-history ownerless proposals (#263)", () => {
  const model = boardColumns([{ id: 1, state: "proposed", started: false }, { id: 2, state: "proposed", started: true }, { id: 3, state: "proposed" }], {});
  expect(model.columns[1]?.ready.map(card => card.returnable)).toEqual([true, false, false]);
});
