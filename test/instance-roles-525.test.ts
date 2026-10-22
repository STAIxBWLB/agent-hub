import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectAdapterCatalog as builtinProjectCatalog } from "../src/adapters/registry.ts";
import { loadConductorPolicy } from "../src/hub/daemon.ts";
import { validateInstances } from "../src/hub/instances.ts";

// #525-1 (R1): roles capability per kind and form.
const validate = (raw: object) => validateInstances(raw, builtinProjectCatalog());

test("a Claude channel instance may implement or verify in its own worktree, and plans or reviews only in the project checkout (#525 R1)", () => {
  expect(validate({ "claude-impl": { kind: "claude", roles: ["implementer"], worktree: ".worktrees/impl" } })["claude-impl"]?.roles).toEqual(["implementer"]);
  expect(validate({ "claude-verify": { kind: "claude", roles: ["implementer", "verifier"], worktree: ".worktrees/verify" } })["claude-verify"]?.roles).toEqual(["implementer", "verifier"]);
  expect(() => validate({ "claude-impl": { kind: "claude", roles: ["implementer"] } })).toThrow("needs its own worktree");
  expect(() => validate({ "claude-plan": { kind: "claude", roles: ["planner"], worktree: ".worktrees/plan" } })).toThrow("reads the project checkout");
  expect(validate({ "claude-plan": { kind: "claude", roles: ["planner", "reviewer"] } })["claude-plan"]?.roles).toEqual(["planner", "reviewer"]);
  expect(() => validate({ "claude-x": { kind: "claude", roles: ["conductor"] } })).toThrow("roles within");
});

test("a headless Claude instance stays a fresh reviewer; a headless implementer is refused until 525-4 (#525 R1)", () => {
  expect(validate({ "claude-review": { kind: "claude", roles: ["reviewer"], start_mode: "headless" } })["claude-review"]?.start_mode).toBe("headless");
  expect(() => validate({ "claude-w": { kind: "claude", roles: ["implementer"], start_mode: "headless", worktree: ".worktrees/w" } })).toThrow("headless Claude implementer is not available in this release");
  expect(() => validate({ "claude-p": { kind: "claude", roles: ["planner"], start_mode: "headless" } })).toThrow("exactly [\"reviewer\"]");
  expect(() => validate({ "claude-rw": { kind: "claude", roles: ["reviewer", "implementer"], start_mode: "headless" } })).toThrow("exactly [\"reviewer\"]");
});

test("planner is refused on a kind that cannot plan and kept on one that can (#525 R1)", () => {
  expect(() => validate({ "local-x": { kind: "local", roles: ["planner"], start_mode: "headless" } })).toThrow("this kind cannot plan");
  expect(validate({ "codex-plan": { kind: "codex", roles: ["planner"], start_mode: "headless" } })["codex-plan"]?.roles).toEqual(["planner"]);
  expect(validate({ "codex-review": { kind: "codex", roles: ["reviewer"], start_mode: "headless", review_mode: "fresh" } })["codex-review"]?.review_mode).toBe("fresh");
});

test("loadConductorPolicy drops a planner role on a kind that cannot plan with a notice, never throwing (#525 R1)", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-roles-525-"));
  try {
    mkdirSync(join(root, ".agenthub"));
    writeFileSync(join(root, ".agenthub", "config.json"), JSON.stringify({ roles: { pi: ["planner", "implementer"], claude: ["planner", "reviewer", "implementer"] } }));
    const policy = loadConductorPolicy(root);
    expect(policy.roles.pi).toEqual(["implementer"]);
    expect(policy.roles.claude).toEqual(["planner", "reviewer", "implementer"]);
    expect(policy.notices).toContain("roles.pi: ignored roles outside the adapter ceiling");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
