import { expect, test } from "bun:test";
import { createProjectAdapterCatalog } from "../src/adapters/registry.ts";
import { isPlannerOnly, validateInstances } from "../src/hub/instances.ts";
import { resolveInstanceExecutionCwd } from "../src/hub/instance-execution.ts";

test("#345 planner-only app-server declarations reject a worktree while writing multi-role instances retain it", () => {
  const catalog = createProjectAdapterCatalog();
  for (const roles of [["planner"], ["planner", "reviewer"], ["planner", "conductor"]]) {
    expect(isPlannerOnly(roles)).toBe(true);
    expect(validateInstances({ "codex-plan": { kind: "codex", roles } }, catalog)["codex-plan"]?.roles).toEqual(roles);
    expect(() => validateInstances({ "codex-plan": { kind: "codex", roles, worktree: ".worktrees/codex-plan" } }, catalog)).toThrow("project checkout");
  }
  for (const roles of [["planner", "implementer"], ["planner", "verifier"], ["reviewer"], ["implementer"]]) {
    expect(isPlannerOnly(roles)).toBe(false);
    expect(validateInstances({ "codex-worker": { kind: "codex", roles, worktree: ".worktrees/codex-worker" } }, catalog)["codex-worker"]?.worktree).toBe(".worktrees/codex-worker");
  }
});

test("#345 effective planner-only policy refuses an existing worktree before any Git execution", () => {
  const catalog = createProjectAdapterCatalog();
  const declarations = validateInstances({ "codex-plan": { kind: "codex", worktree: ".worktrees/codex-plan" } }, catalog);
  let calls = 0;
  const git = (() => { calls++; throw new Error("Git must not run for a refused planner workspace"); }) as never;
  expect(() => resolveInstanceExecutionCwd("/fixture", "codex-plan", declarations, ["planner"], catalog, 5000, () => 0, git)).toThrow("project checkout");
  expect(calls).toBe(0);
  expect(resolveInstanceExecutionCwd("/fixture", "codex-plan", { "codex-plan": { kind: "codex", roles: ["planner"] } }, ["planner"], catalog, 5000, () => 0, git)).toBe("/fixture");
  expect(calls).toBe(0);
});
