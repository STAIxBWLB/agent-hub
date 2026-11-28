import { expect, test } from "bun:test";
import { paint, type Span } from "../src/cli/console-state.ts";
import { renderLifecycleReceipt, renderResetPlan, renderUndoPlan } from "../src/cli/reset-output.ts";

const output = (lines: Span[][]) => lines.map(line => paint(line, false)).join("\n");
const plan = { queued: ["delivery-1"], needsReview: [], inFlight: [], manualHolds: [], budgetPauses: [],
  conductorHolds: [], sessionPointers: ["sessions.json"], entries: 7 };

test("reset dry runs preserve result text, paths and memory scope, including --all", () => {
  const stateDir = "/a long project path/.agenthub/state", archive = "/a long project path/.agenthub/archive";
  const base = { stateDir, archive, projectId: "project", plan, stale: ["status.json"] };
  const plain = output(renderResetPlan({ ...base, all: false, state: "stopped" }, 24, 0, true));
  expect(plain).toContain("ahub reset, dry run: the hub is stopped\n\n> What --yes does");
  expect(plain).toContain('settle as discard with reason "reset", clear and drop:');
  expect(plain).toContain("queued 1: delivery-1");
  expect(plain).toContain("remove the manifest a hub left when it did not stop cleanly: status.json");
  expect(plain).toContain("kept: the board, logs and audit, recovery records, execution budgets, configuration and pi-sessions/");
  expect(plain).toContain("claude-mem is not touched: notes saved with hub_remember stay in shared memory");
  expect(plain.endsWith("nothing was changed; add --yes to apply")).toBe(true);
  const all = output(renderResetPlan({ ...base, all: true, state: "running", stale: [] }, 24));
  expect(all).toContain("the hub is running; --yes stops it first, as ahub kill does");
  expect(all).toContain(`move ${stateDir} (7 entries) to ${archive}/state-<UTC time>/`);
  expect(all).toContain(".agenthub/config.json, config.local.json and routing.toml are outside the state directory and stay");
  expect(all).toContain("claude-mem is not touched");
  expect(all.endsWith("nothing was changed; add --yes to apply")).toBe(true);
});

test("undo reports exact paths and gives the unobserved submodule warning only when needed", () => {
  const base = { id: "turn-id", restore: ["dir with spaces/long file name"], undone: false };
  const plain = output(renderUndoPlan({ ...base, unobserved: [] }, 24));
  expect(plain).toContain("turn turn-id changed:\n  dir with spaces/long file name");
  expect(plain).not.toContain("cannot be restored");
  const withSubmodule = output(renderUndoPlan({ ...base, unobserved: ["sub module"] }, 24));
  expect(withSubmodule).toContain("these submodules were changed during the turn and their contents cannot be restored");
  expect(withSubmodule).toContain("\n  sub module\n");
  expect(withSubmodule).toContain("(every change made in the project during the turn counts as its own, including any by Claude or by you)");
});

test("kill receipts are one line and lifecycle continuations preserve exact text", () => {
  for (const line of ["hub stopped", "hub is not running"]) expect(output(renderLifecycleReceipt({ lines: [line] }))).toBe(line);
  const diff = "Undo preview (end snapshot to start snapshot):\n  - old\n  + new\n";
  expect(output(renderLifecycleReceipt({ lines: [diff] }, 24))).toBe(diff);
  expect(output(renderLifecycleReceipt({ title: "Reset", lines: ["hub stopped", "settled 0 deliveries"] })))
    .toContain("hub stopped\nsettled 0 deliveries");
});
