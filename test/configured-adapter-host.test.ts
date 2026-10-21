import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createProjectAdapterCatalog, definitionOf } from "../src/adapters/registry.ts";
import { assign, parseRouting } from "../src/hub/routing.ts";
import { Budget, DEFAULT_BUDGET } from "../src/hub/budget.ts";
import { projectSettings, settingDef } from "../src/hub/settings.ts";
import { resolveInstanceExecutionCwd } from "../src/hub/instance-execution.ts";

const catalog = createProjectAdapterCatalog({ fixture: { transport: "acp", command: "fixture-acp", displayName: "Fixture", roles: ["implementer", "verifier"], permission: { ask: "prompt", "never-ask": "accept" }, readOnly: "read" }, observer: { transport: "acp", command: "fixture-acp", displayName: "Observer", roles: ["verifier"] } });
const instances = { "fixture-one": { kind: "fixture", start_mode: "headless" as const, roles: ["implementer"] }, "fixture-reader": { kind: "fixture", start_mode: "headless" as const, roles: ["verifier"], readOnly: true } };
const routing = parseRouting('[local]\nfixed_model="fixture"\n[classes.implement]\npeers=["fixture"]\n[classes.review]\npeers=[]\n');
const task = { class: "implement" as const, signals: [] };
const opts = { adapterCatalog: catalog, instances, roles: { "fixture-one": ["implementer"] }, ownerIsolation: { "fixture-one": true } };

test("configured kind preferences expand verified extras, but named ids and reservations stay exact", () => {
  expect(assign(task, { fixture: "busy", "fixture-one": "idle" }, routing, opts).owner).toBe("fixture-one");
  expect(assign(task, { fixture: "busy", "fixture-one": "idle" }, routing, { ...opts, namedOwner: "fixture" }).owner).toBe("fixture");
  expect(assign({ ...task, reserved: "fixture" }, { fixture: "busy", "fixture-one": "idle" }, routing, opts).owner).toBe("fixture");
  expect(assign(task, { "fixture-one": "idle" }, routing, { ...opts, ownerIsolation: {} }).owner).toBeUndefined();
  expect(definitionOf("fixture")).toBeUndefined();
});

test("configured canonical and extra cloud peers never receive PII work", () => {
  expect(assign({ ...task, signals: ["pii"] }, { fixture: "idle", "fixture-one": "idle" }, routing, opts).owner).toBeUndefined();
  expect(assign(task, { fixture: "idle" }, routing, { ...opts, offRoster: ["fixture"] }).owner).toBeUndefined();
});

test("configured settings stay project bound, headless, mapped-only, and never expose executable edits", () => {
  const rows = projectSettings(instances, catalog);
  expect(rows.find(row => row.key === "tasks.wip_limits.fixture")).toMatchObject({ min: 0, max: 32 });
  expect(rows.find(row => row.key === "roster.fixture-one")).toBeDefined();
  expect(rows.find(row => row.key === "peers.fixture.start_mode")?.values).toEqual(["headless"]);
  expect(rows.find(row => row.key === "permission.fixture")?.values).toEqual(["ask", "never-ask"]);
  expect(rows.find(row => row.key === "permission.observer")).toBeUndefined();
  expect(rows.find(row => row.key === "permission.fixture-reader")).toMatchObject({ values: ["read-only"], locked: expect.any(String) });
  expect(settingDef("adapters.fixture.command", instances, catalog)).toContain("never editable");
  expect(projectSettings().some(row => row.key === "roster.fixture")).toBe(false);
});

test("configured canonical execution uses the project root, an extra writer still requires its real worktree", () => {
  expect(resolveInstanceExecutionCwd("/fixture", "fixture", instances, ["implementer"], catalog)).toBe("/fixture");
  expect(() => resolveInstanceExecutionCwd("/fixture", "fixture-one", instances, ["implementer"], catalog)).toThrow("explicit managed worktree");
});

test("configured kinds without budget metadata are exempt, unknown external ids retain manual accounting", () => {
  const budget = new Budget(":memory:", DEFAULT_BUDGET, { definitionOf: peer => catalog.definitionOf(peer, instances), pause() {}, resume() {}, requestCheckpoint: async () => undefined, platformContext: async () => undefined, attached: () => false, canHandOff: () => false, handoff: async () => [], resumed() {}, notify() {} }, () => 1000);
  try {
    const reading = [{ id: "5h" as const, used: 0.1, source: "fixture" }];
    budget.report("fixture", reading); budget.report("fixture-one", reading); budget.report("external", reading);
    expect(budget.status()).not.toHaveProperty("fixture");
    expect(budget.status()).not.toHaveProperty("fixture-one");
    expect(budget.status()).toHaveProperty("external");
  } finally { budget.close(); }
});

test("Tasks forwards project catalog into its off-roster assignment projection without declarations", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-configured-host-"));
  const bus = new Bus({ batchMs: 0, rostered: peer => peer !== "fixture" });
  const board = new Board(":memory:");
  try {
    const tasks = new Tasks({ adapterCatalog: catalog, board, bus, routing: () => routing, cwd, project: "fixture", notify() {} });
    const proposed = await tasks.propose("user", { title: "Fixture work", class: "implement", owner: "fixture" });
    expect(proposed.owner).toBeNull();
    expect(board.stalls()).toContainEqual(expect.objectContaining({ task: proposed.id, cause: expect.objectContaining({ refusals: expect.arrayContaining([{ peer: "fixture", code: "roster" }]) }) }));
  } finally { board.close(); bus.closeJournal(); rmSync(cwd, { recursive: true, force: true }); }
});
