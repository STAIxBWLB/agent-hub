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

test("attention missing held rows print guidance without selecting unrelated queue rows", () => {
  for (const absentState of ["accepted", "dispatching", undefined]) {
    const state: ConsoleState = { ...initialConsoleState(true), petEnabled: true,
      peers: { codex: { state: "idle", heldBy: "missing", needsReview: 1 } },
      queue: [{ id: "unrelated", peer: "kimi", state: "needs_review" }, ...(absentState ? [{ id: "missing", peer: "codex", state: absentState }] : [])] };
    const next = reduceConsole(state, "n", now);
    expect(next.state.panel).toBe(1);
    expect(next.state.selection).toBe(state.selection);
    expect(next.effects.map(effect => effect.type)).toEqual(["print"]);
    expect(next.state.notice).toContain("ahub queue show missing");
  }
});

test("attention message guidance names a directed CLI recipient without sending", () => {
  const state: ConsoleState = { ...initialConsoleState(), petEnabled: true,
    attentionMessages: [{ id: "message-1", peer: "codex", important: true }] };
  const next = reduceConsole(state, "n", now);
  expect(next.effects).toEqual([{ type: "print", text: "message codex message-1: ahub say @codex <message>", kind: "attention", tone: "attention" }]);
  expect(next.state.input).toBe("");
  expect(next.state.mode).toBe("stream");
});

test("ID-less secondary delivery guidance never selects another queued row for that peer", () => {
  const state: ConsoleState = { ...initialConsoleState(true), petEnabled: true,
    peers: { codex: { state: "idle", heldBy: "first", needsReview: 2 } },
    queue: [{ id: "unrelated", peer: "codex", state: "queued" }, { id: "first", peer: "codex", state: "needs_review" }] };
  const first = reduceConsole(state, "n", now);
  expect(first.state.selection).toBe(1);
  const next = reduceConsole(first.state, "n", now);
  expect(next.state.selection).toBe(1);
  expect(next.effects).toEqual([{ type: "print", text: "delivery codex: ahub queue list", kind: "attention", tone: "attention" }]);
});

test("attention cursor restarts when needs are inserted removed or reordered", () => {
  const base: ConsoleState = { ...initialConsoleState(true), petEnabled: true, approvals: [approval("old", 3000), approval("last", 4000)] };
  const chosen = reduceConsole(base, "n", now).state;
  expect(chosen.approvalId).toBe("old");
  for (const approvals of [[approval("urgent", 2000), ...base.approvals], [approval("last", 4000)], [approval("old", 5000), approval("last", 4000)]]) {
    const next = reduceConsole({ ...chosen, approvals }, "n", now);
    expect(next.state.attentionSelection).toBe(0);
    expect(next.state.approvalId).toBe(approvals[0]!.id === "urgent" ? "urgent" : "last");
    expect(next.effects).toEqual([]);
  }
});

test("attention prefers an actual review row over a different in-flight held id", () => {
  const state: ConsoleState = { ...initialConsoleState(true), petEnabled: true,
    peers: { codex: { state: "idle", heldBy: "accepted-row", needsReview: 1 } },
    queue: [{ id: "accepted-row", peer: "codex", state: "accepted" }, { id: "review-row", peer: "codex", state: "needs_review" }] };
  expect(consoleNeeds(state, now).items[0]?.id).toBe("review-row");
  const next = reduceConsole(state, "n", now);
  expect(next.state.panel).toBe(4);
  expect(next.state.selection).toBe(0);
  expect(next.effects).toEqual([]);
});
