import { expect, test } from "bun:test";
import { initialConsoleState, paint, reduceConsole, renderConsole } from "../src/cli/console-state.ts";
import { renderStatus } from "../src/cli/output.ts";
import { renderTaskShow } from "../src/cli/task-output.ts";
import { ownerIsolationText, taskHolderText } from "../src/cli/role-holders.ts";

const NOW = 1_000_000;
const task = {
  id: 345, title: "Stage holders", detail: "An ordinary public task", class: "implement", state: "in_review",
  planner: "codex-plan", plannerReason: "kept", owner: "claude-impl", reviewer: "codex-review", reserved: "claude-impl",
  reviewerReason: "unavailable skip", sameFamilyFallback: true, refs: {}, plan: {}, deps: [], created: NOW - 2000, updated: NOW - 1000,
  history: [{ at: NOW - 2000, by: "user", event: "reassigned", owner: "claude-impl", reason: "manual", note: "never parse this prose as another holder" }],
};
const text = (lines: { text: string; tone?: any }[][], color = false) => lines.map(line => paint(line, color)).join("\n");
const flat = (value: string) => value.replace(/\s+/g, " ");
const stripColor = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");
const holders = ["codex-plan (kept)", "claude-impl (named; reserved)", "codex-review (unavailable skip; same-family fallback)"];

test("#345 holder reasons use structured current metadata, never assignment prose", () => {
  expect(taskHolderText(task, "planner")).toBe(holders[0]!);
  expect(taskHolderText(task, "owner")).toBe(holders[1]!);
  expect(taskHolderText(task, "reviewer")).toBe(holders[2]!);
  expect(taskHolderText({ planner: "codex-plan", history: [{ planner: "codex-plan", plannerReason: "named" }] }, "planner")).toBe("codex-plan (named)");
  expect(taskHolderText({ reviewer: "codex-review", history: [{ event: "reviewer changed", reason: "manual" }] }, "reviewer")).toBe("codex-review (named)");
  expect(taskHolderText({ owner: "claude-impl", reviewer: "codex-review", history: [{ event: "reassigned", owner: "claude-impl", reason: "manual", reviewerReason: "rotation" }] }, "reviewer")).toBe("codex-review (rotation)");
  expect(taskHolderText({ owner: "claude-impl", history: [{ event: "assigned", owner: "claude-impl", note: "named; rotation; secret old text" }] }, "owner")).toBe("claude-impl");
  expect(taskHolderText({ reserved: "claude-impl" }, "owner")).toBe("claude-impl (reserved)");
});

test("#345 escalated holder choices supersede earlier reasons", () => {
  const changed = { owner: "new-owner", reviewer: "new-reviewer", history: [
    { event: "assigned", owner: "old-owner", reason: "manual", reviewerReason: "rotation" },
    { event: "escalated", owner: "new-owner", reason: "rejections", reviewerReason: "same-family fallback" },
  ] };
  expect(taskHolderText(changed, "owner")).toBe("new-owner (rejections)");
  expect(taskHolderText(changed, "reviewer")).toBe("new-reviewer (same-family fallback)");
  expect(taskHolderText({ owner: "new-owner", history: [{ event: "reassigned", by: "hub", owner: "new-owner", reason: "manual" }] }, "owner")).toBe("new-owner (manual)");
  expect(taskHolderText({ owner: "new-owner", history: [{ event: "escalated", by: "user", owner: "new-owner", reason: "manual" }] }, "owner")).toBe("new-owner (manual)");
});

for (const columns of [80, 200]) test(`#345 task show and console holders retain reasons within ${columns} columns`, () => {
  const shown = renderTaskShow(task, columns, NOW);
  const plain = text(shown);
  for (const value of holders) expect(flat(plain)).toContain(value);
  expect(stripColor(text(shown, true))).toBe(plain);
  for (const line of plain.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);

  const state = initialConsoleState(true); state.panel = 3; state.tasksKnown = true; state.tasks = [task];
  const panel = renderConsole(state, columns, 30, NOW);
  for (const value of holders) expect(flat(panel.join("\n"))).toContain(value);
  for (const line of panel) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
  state.detail = task;
  const detail = renderConsole(state, columns, 40, NOW).join("\n");
  for (const value of holders) expect(flat(detail)).toContain(value);
});

for (const columns of [80, 200]) test(`#345 status shows form, role ceiling and every extra's isolation at ${columns} columns`, () => {
  const shown = renderStatus({ pid: 1, controlPort: 2, peers: { "codex-plan": { state: "idle", queued: 0 } },
    roleInfo: { "codex-plan": { flowRoles: ["planner"], catalogRoles: { value: ["planner"] }, form: "headless", capableRoles: ["planner", "implementer", "verifier", "reviewer", "conductor"] } },
    ownerIsolation: { "codex-plan": false, "claude-impl": true }, ownerIsolationNotes: { "codex-plan": "planner uses the project checkout" } }, columns, NOW);
  const plain = text(shown);
  for (const value of ["codex-plan form", "headless", "codex-plan capable roles", "planner, implementer, verifier, reviewer, conductor", "codex-plan owner isolation", "not isolated: planner uses the project checkout", "claude-impl owner isolation", "isolated"]) expect(flat(plain)).toContain(value);
  expect(stripColor(text(shown, true))).toBe(plain);
  for (const line of plain.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
});

test("#345 console peer detail renders the boolean isolation proof without changing it", () => {
  const state = initialConsoleState(true); state.panel = 1;
  state.peers = { "codex-plan": { state: "idle", queued: 0, ownerIsolation: false, ownerIsolationNote: "planner uses the project checkout", form: "headless", capableRoles: ["planner"] } };
  const opened = reduceConsole(state, "\r", NOW).state;
  expect(renderConsole(opened, 80, 30, NOW).join("\n")).toContain("not isolated: planner uses the project checkout");
  expect(state.peers["codex-plan"].ownerIsolation).toBe(false);
  expect(ownerIsolationText(undefined)).toBeUndefined();
  expect(ownerIsolationText("unknown")).toBeUndefined();
  expect(ownerIsolationText(false)).toBe("not isolated: execution root not verified");
});

test("#345 holder text stays terminal-safe and private task stubs need no withheld fields", () => {
  const hostile = { ...task, planner: "codex-plan\x1b[31m", plannerReason: "named\nforged label" };
  const shown = text(renderTaskShow(hostile, 80, NOW));
  expect(shown).not.toContain("\x1b");
  for (const line of shown.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  const stub = text(renderTaskShow({ id: 1, title: "[pii]", detail: "[pii]", state: "in_progress", owner: "local", reviewer: "user", planner: null, refs: {}, plan: {}, history: [] }, 80, NOW));
  expect(stub).toContain("[pii]"); expect(stub).not.toContain("never parse"); expect(stub).not.toContain("codex-plan");
});
