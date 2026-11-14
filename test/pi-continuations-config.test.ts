import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nativeConfigurationDefaults, mergeNativeConfiguration } from "../src/adapters/definitions/native-config-defaults.ts";
import { PI_SETTINGS } from "../src/adapters/definitions/native-config-policy.ts";
import { configApply, validateRawConfig, validateEffectiveConfig } from "../src/hub/config-apply.ts";
import { DEFAULT_CONFIG, loadConfig } from "../src/hub/daemon.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project() { const root = mkdtempSync(join(tmpdir(), "ahub-pi-continuations-config-")); roots.push(root); return root; }

test("T3 raises only the Pi step default while continuation and local defaults stay unchanged", () => {
  const defaults = nativeConfigurationDefaults({ home: "/fixture-home", env: {}, networkAllow: [] });
  expect(defaults.rpc.pi.max_continuations).toBe(2);
  expect(DEFAULT_CONFIG.pi.max_continuations).toBe(2);
  expect(defaults.rpc.pi.max_steps).toBe(100);
  expect(defaults.sandbox.local.max_steps).toBe(30);
  expect(mergeNativeConfiguration({}, DEFAULT_CONFIG).pi.max_continuations).toBe(2);
});

test("Pi continuation policy accepts the disabled setting, default and ruled upper bound", () => {
  for (const value of [0, 2, 10]) expect(() => validateRawConfig({ pi: { max_continuations: value } })).not.toThrow();
  for (const value of [-1, 0.5, 11, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "2", null])
    expect(() => validateRawConfig({ pi: { max_continuations: value } })).toThrow("pi.max_continuations");
});

test("shared and local continuation settings merge valid overrides without losing zero", () => {
  const cwd = project();
  expect(loadConfig(cwd).pi.max_continuations).toBe(2);
  const changed = loadConfig(cwd, [
    { name: "config.json", raw: { pi: { max_continuations: 10 } } },
    { name: "config.local.json", raw: { pi: { max_continuations: 0 } } },
  ]);
  expect(changed.pi.max_continuations).toBe(0);
  expect(changed.pi.max_steps).toBe(DEFAULT_CONFIG.pi.max_steps);
  // #1447 conductor ruling: loadConfig tests valid precedence; schema ports own native validation.
  expect(loadConfig(cwd, [
    { name: "config.json", raw: { pi: { max_continuations: 5 } } },
    { name: "config.local.json", raw: { pi: { max_continuations: 2 } } },
  ]).pi.max_continuations).toBe(2);
  expect(() => validateEffectiveConfig({ ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, max_continuations: 11 } })).toThrow("pi.max_continuations");
});

test("Pi continuations retain config-only next-use application like the existing step ceiling", () => {
  expect(configApply("pi.max_continuations").applies).toBe("next use");
  expect(configApply("pi.max_steps").applies).toBe("next use");
  expect(PI_SETTINGS.some(row => row.key === "pi.max_continuations")).toBe(false);
  expect(PI_SETTINGS.some(row => row.key === "pi.max_steps")).toBe(false);
});
