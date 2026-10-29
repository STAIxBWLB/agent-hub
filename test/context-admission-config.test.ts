import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeConfigLeaf, configApply, validateRawConfig } from "../src/hub/config-apply.ts";
import { ALL_MACHINE_LOCAL } from "../src/hub/config-trust.ts";
import { DEFAULT_CONFIG, loadConfig } from "../src/hub/daemon.ts";
import { hubGitSync } from "../src/hub/git.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("#802 context assignment admission is off by default and its threshold is a closed finite fraction", () => {
  expect(DEFAULT_CONFIG.context.max_assignment_used).toBe(0);
  for (const max_assignment_used of [0, 0.8, 1]) {
    expect(() => validateRawConfig({ context: { max_assignment_used } })).not.toThrow();
  }
  for (const max_assignment_used of [-0.01, 1.01, NaN, Infinity, null, "0.8", true]) {
    expect(() => validateRawConfig({ context: { max_assignment_used } })).toThrow("context.max_assignment_used");
  }
  expect(() => validateRawConfig({ context: { assignment_used: 0.8 } })).toThrow("context.assignment_used");
  expect(configApply("context.max_assignment_used")).toEqual({ applies: "next use" });
});

test("#802 tracked configuration cannot opt another machine into context admission", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-context-admission-config-")); dirs.push(dir);
  expect(hubGitSync(["-C", dir, "init", "-q"], { encoding: "utf8" }).status).toBe(0);
  mkdirSync(join(dir, ".agenthub"));
  writeFileSync(join(dir, ".agenthub", "config.local.json"), JSON.stringify({ context: { gate: 0.7, stale_min: 15, max_assignment_used: 0.8 } }));
  expect(ALL_MACHINE_LOCAL).toContain("context.max_assignment_used");
  expect(loadConfig(dir).context).toMatchObject({ gate: 0.7, stale_min: 15, max_assignment_used: 0.8 });
  expect(hubGitSync(["-C", dir, "add", "-f", ".agenthub/config.local.json"], { encoding: "utf8" }).status).toBe(0);
  const tracked = loadConfig(dir);
  expect(tracked.context).toMatchObject({ gate: 0.7, stale_min: 15, max_assignment_used: 0 });
  expect(tracked.ignored?.join("\n")).toContain("context.max_assignment_used");
});

test("#802 context admission changes need a confirmed person reload from an untracked source", () => {
  const change = { key: "context.max_assignment_used", before: 0, after: 0.8, source: "config" as const, sourceFile: "config.local.json" };
  for (const tracked of [true, undefined]) {
    expect(authorizeConfigLeaf({ ...change, tracked, authority: "terminal", confirmed: true }).allowed).toBe(false);
  }
  for (const authority of ["ordinary", "settings", "conductor"] as const) {
    expect(authorizeConfigLeaf({ ...change, tracked: false, authority, confirmed: true }).allowed).toBe(false);
  }
  expect(authorizeConfigLeaf({ ...change, tracked: false, authority: "terminal" }).allowed).toBe(false);
  expect(authorizeConfigLeaf({ ...change, tracked: false, authority: "terminal", confirmed: true }).allowed).toBe(true);
});
