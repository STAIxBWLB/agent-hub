import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupResearchDefault } from "../src/cli/setup-research.ts";
import { readAutonomyDefaults } from "../src/hub/autonomy-defaults.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test("#1328 setup changes research only for an explicit choice, preserving an existing choice otherwise", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-setup-research-")); roots.push(root);
  const home = join(root, "hub"), file = join(home, "defaults.json");
  expect(setupResearchDefault(home, [], undefined)).toBeUndefined(); expect(existsSync(file)).toBe(false);
  expect(setupResearchDefault(home, [], true)).toContain("Research records for new projects: on");
  expect(readAutonomyDefaults(home).researchEnabled).toBe(true);
  const held = readFileSync(file, "utf8");
  expect(setupResearchDefault(home, [], undefined)).toBeUndefined(); expect(readFileSync(file, "utf8")).toBe(held);
  expect(setupResearchDefault(home, [], false)).toContain("Research records for new projects: off");
  expect(readAutonomyDefaults(home).researchEnabled).toBe(false);
  chmodSync(file, 0o644); const unsafe = readFileSync(file, "utf8");
  expect(() => setupResearchDefault(home, [], true)).toThrow("check its ownership, mode and schema");
  expect(readFileSync(file, "utf8")).toBe(unsafe);
});
test("#853 the saved choice says to upgrade every hub and CLI on this machine first", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-setup-research-")); roots.push(root);
  const line = setupResearchDefault(join(root, "hub"), [], true);
  expect(line).toContain("Research records for new projects: on");
  expect(line).toContain("Upgrade every hub and CLI on this machine to 0.36 or later first: a version from before 0.36 treats the whole file as untrusted, so its machine autonomy preset falls back to off and its start-agent default to the shipped one.");
});
