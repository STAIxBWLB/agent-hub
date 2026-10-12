import { expect, test } from "bun:test";
import { initialConsoleState, paint, reduceConsole, renderConsoleLines } from "../src/cli/console-state.ts";
import { consoleNeeds } from "../src/cli/attention.ts";
import type { ConsoleState } from "../src/cli/console-state.ts";

const now = 1000;
const approval = (id: string, expiresAt: number) => ({ id, expiresAt, peer: "codex", title: "PRIVATE_MARKER", options: [] });

test("attention next selects requests by expiry, wraps, and never answers them", () => {
  for (const panels of [false, true]) {
    let state: ConsoleState = { ...initialConsoleState(panels), petEnabled: true, approvals: [approval("late", 3000), approval("early", 2000)] };
    for (const id of ["early", "late", "early"]) {
      const next = reduceConsole(state, "n", now);
      expect(next.effects).toEqual([]);
      expect(next.state.approvalId).toBe(id);
      expect(next.state.approvals).toHaveLength(2);
      if (panels) expect(next.state.panel).toBe(2);
      state = { ...next.state, petEnabled: true };
    }
  }
});

test("attention next selects queue rows or prints trusted commands without acting", () => {
  for (const panels of [false, true]) {
    const state = { ...initialConsoleState(panels), petEnabled: true, peers: { codex: { state: "idle", heldBy: "delivery-1", needsReview: 1 } }, queue: [{ id: "other", state: "needs_review" }, { id: "delivery-1", state: "needs_review" }] };
    const next = reduceConsole(state, "n", now);
    if (panels) {
      expect(next.state.panel).toBe(4);
      expect(next.state.selection).toBe(1);
      expect(next.effects).toEqual([]);
    } else {
      expect(next.effects).toEqual([{ type: "print", text: "delivery codex delivery-1: ahub queue list; ahub queue show delivery-1", kind: "attention", tone: "attention" }]);
    }
  }
});

test("attention respects editing, choice, help and confirmation keyboard ownership", () => {
  const base = { ...initialConsoleState(true), petEnabled: true, approvals: [approval("request", 2000)] };
  for (const modal of [{ editing: true }, { optionChoice: "request" }, { modeChoice: "codex" }, { help: true }, { confirm: { type: "permission" as const, id: "request", option: "allow", peer: "codex" } }]) {
    const next = reduceConsole({ ...base, ...modal }, "n", now);
    expect(next.state.attentionSelection).toBeUndefined();
    expect(next.effects).toEqual([]);
  }
  expect(reduceConsole({ ...base, editing: true }, "n", now).state.input).toBe("n");
});

test("attention rule preserves footer and cursor cells without source text or escapes", () => {
  for (const panels of [false, true]) for (const columns of [80, 99, 100, 120]) for (const rows of [24, 40]) {
    const state = { ...initialConsoleState(panels), approvals: [approval("request", 2000)] };
    const off = renderConsoleLines(state, columns, rows, now);
    const on = renderConsoleLines({ ...state, petEnabled: true }, columns, rows, now);
    expect(on).toHaveLength(off.length);
    expect(on.slice(-3)).toEqual(off.slice(-3));
    const rule = paint(on[on.length - 4]!, false);
    expect(rule).toContain("(O O) ! 1 need you");
    expect(rule).not.toContain("PRIVATE_MARKER");
    expect(rule).toMatch(/^[ -~]*$/);
    for (const line of on) expect(Bun.stringWidth(paint(line, false))).toBeLessThanOrEqual(columns);
  }
});

test("console attention projects structural fields without reading private text", () => {
  const state = initialConsoleState();
  const row = approval("request", 2000);
  Object.defineProperty(row, "title", { get() { throw new Error("private title read"); } });
  Object.defineProperty(row, "options", { get() { throw new Error("private options read"); } });
  state.approvals = [row];
  expect(consoleNeeds(state, now).items).toEqual([{ kind: "approval", level: "act", peer: "codex", id: "request", until: 2000 }]);
});

test("attention navigation visits every held delivery and session toggle grants no authority", () => {
  let state: ConsoleState = { ...initialConsoleState(true), petEnabled: true,
    peers: { codex: { state: "idle", heldBy: "first", needsReview: 2 } },
    queue: [{ id: "first", peer: "codex", state: "needs_review" }, { id: "second", peer: "codex", state: "needs_review" }] };
  for (const selection of [0, 1, 0]) {
    const next = reduceConsole(state, "n", now);
    expect(next.effects).toEqual([]);
    expect(next.state.selection).toBe(selection);
    state = next.state;
  }
  const off = reduceConsole(state, "P", now);
  expect(off.effects).toEqual([]);
  expect(off.state.petEnabled).toBe(false);
  expect(reduceConsole(off.state, "P", now).state.petEnabled).toBe(true);
});
