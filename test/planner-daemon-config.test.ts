import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectAdapterCatalog } from "../src/adapters/registry.ts";
import { loadConfig, loadConductorPolicy, type ConfigLayer } from "../src/hub/daemon.ts";
import { validateEffectiveConfig, validateRawConfig } from "../src/hub/config-apply.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { checkSettingValue, settingDef, writeConfigSetting, type SettingDef } from "../src/hub/settings.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-planner-loader-")), stateDir = join(root, ".agenthub", "state");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(stateDir, { recursive: true });
  expect(hubGitSync(["init", "-q", root], { encoding: "utf8", timeout: 1000 }).status).toBe(0);
  const local = join(root, ".agenthub", "config.local.json");
  const write = (raw: Record<string, unknown>) => writeFileSync(local, JSON.stringify(raw));
  const read = () => JSON.parse(readFileSync(local, "utf8"));
  write({});
  return { root, stateDir, local, write, read };
}
const layer = (raw: Record<string, unknown>): ConfigLayer[] => [{ name: "config.local.json", raw }];

for (const raw of ["claude", ["claude"], ["codex", "claude"]]) test(`#525 R3 real loaders preserve valid planner input ${JSON.stringify(raw)}`, () => {
  const f = fixture(); f.write({ planner: raw });
  expect(loadConfig(f.root).planner).toEqual(raw);
  expect(loadConductorPolicy(f.root).planner).toEqual(raw);
  expect(() => validateRawConfig(f.read())).not.toThrow();
  expect(() => validateEffectiveConfig(loadConfig(f.root))).not.toThrow();
});

test("#525 R3 singleton settings writes normalize to scalar before both real loaders read the local file", () => {
  const f = fixture(), def = settingDef("planner") as SettingDef;
  const value = checkSettingValue(def, ["claude"]);
  expect(value).toBe("claude");
  expect(writeConfigSetting(f.root, f.stateDir, def, value, scratch => validateEffectiveConfig(loadConfig(scratch)))).toBe(true);
  expect(f.read().planner).toBe("claude");
  expect(loadConfig(f.root).planner).toBe("claude");
  expect(loadConductorPolicy(f.root).planner).toBe("claude");
});

test("#525 R3 eight startup-declared capable planner instances pass every real config admission", () => {
  const f = fixture();
  const instances = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`codex-plan${index}`, { kind: "codex", roles: ["implementer"] }]));
  const planner = Object.keys(instances);
  f.write({ instances, planner });
  expect(loadConfig(f.root).planner).toEqual(planner);
  expect(loadConfig(f.root).instances).toEqual(instances);
  expect(loadConductorPolicy(f.root).planner).toEqual(planner);
  expect(() => validateEffectiveConfig(loadConfig(f.root))).not.toThrow();
  expect(() => validateRawConfig(f.read())).not.toThrow();
  // Neither a previous load nor a matching suffix registers an instance in another project.
  expect(() => loadConductorPolicy(f.root, layer({ planner: "codex-plan0" }))).toThrow();
  f.write({ planner: "codex-plan0" });
  expect(() => loadConfig(f.root)).toThrow();
});

for (const planner of [null, [], ["claude", "claude"], "claude-undeclared", "local", true, ["claude", 2], Array.from({ length: 9 }, (_, i) => `codex-plan${i}`)]) test(`#525 R3 all config admissions refuse invalid planner ${JSON.stringify(planner)}`, () => {
  const f = fixture(); f.write({ planner });
  expect(() => loadConductorPolicy(f.root)).toThrow();
  expect(() => loadConfig(f.root)).toThrow();
  expect(() => validateRawConfig(f.read())).toThrow();
  const ordinary = loadConfig(f.root, layer({}));
  expect(() => validateEffectiveConfig({ ...ordinary, planner })).toThrow();
});

test("#525 R3 configured ACP legacy planner role policy remains valid but cannot widen explicit planner capability", () => {
  const f = fixture();
  const adapters = { fixture: { transport: "acp", command: "never-execute-planner-fixture", displayName: "Fixture ACP", roles: ["planner", "implementer"], identity: { name: "Fixture ACP", version: "1" } } };
  f.write({ adapters, roles: { fixture: ["planner"] } });
  expect(loadConductorPolicy(f.root).roles.fixture).toEqual(["planner"]);
  expect(loadConfig(f.root).roles.fixture).toEqual(["planner"]);
  expect(() => validateEffectiveConfig(loadConfig(f.root))).not.toThrow();
  const catalog = createProjectAdapterCatalog(adapters);
  expect(catalog.definitionOf("fixture")?.projection?.plannerEligible).not.toBe(true);
  f.write({ adapters, roles: { fixture: ["planner"] }, planner: ["claude", "fixture"] });
  expect(() => loadConductorPolicy(f.root)).toThrow();
  expect(() => loadConfig(f.root)).toThrow();
  expect(() => validateRawConfig(f.read())).toThrow();
});
