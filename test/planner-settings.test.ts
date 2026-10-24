import { expect, test } from "bun:test";
import { createProjectAdapterCatalog, definitionOf, PLANNER_PEERS, type KindMap, type ProjectAdapterCatalog } from "../src/adapters/registry.ts";
import { checkSettingValue, parseSettingText, projectSettings, settingDef, settingRefusal, SETTINGS, type SettingDef } from "../src/hub/settings.ts";

function planner(instances?: KindMap, catalog?: ProjectAdapterCatalog): SettingDef {
  const def = settingDef("planner", instances, catalog);
  expect(typeof def).toBe("object");
  return def as SettingDef;
}

test("#525 R3 planner settings normalize scalar and singleton values and retain a distinct ordered list", () => {
  const def = planner();
  expect(def.type).toBe("peers");
  expect(def.values).toEqual(PLANNER_PEERS);
  expect(checkSettingValue(def, "claude")).toBe("claude");
  expect(checkSettingValue(def, ["claude"])).toBe("claude");
  expect(checkSettingValue(def, ["codex", "claude"])).toEqual(["codex", "claude"]);
  expect(checkSettingValue(def, null)).toBeNull();
  expect(checkSettingValue(def, parseSettingText(def, " codex , claude "))).toEqual(["codex", "claude"]);
  expect(checkSettingValue(def, parseSettingText(def, "claude"))).toBe("claude");
  expect(checkSettingValue(def, parseSettingText(def, "inherit"))).toBeNull();
  for (const value of [[], ["claude", "claude"], "", "CLAUDE", "unknown", ["claude", "local"], false, 1, ["claude", 1]]) {
    expect(() => checkSettingValue(def, value), JSON.stringify(value)).toThrow("eligible planner peer ids");
  }
  expect(settingRefusal(def, "claude", "ordinary")).toContain("settings session");
  expect(settingRefusal(def, ["codex", "claude"], "terminal")).toBeUndefined();
});

test("#525 R3 planner settings allow eight eligible peers but refuse a ninth", () => {
  const instances = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`claude-plan${index}`, { kind: "claude", roles: ["planner"] }]));
  const def = planner(instances, createProjectAdapterCatalog());
  const peers = Object.keys(instances);
  expect(checkSettingValue(def, peers.slice(0, 8))).toEqual(peers.slice(0, 8));
  expect(() => checkSettingValue(def, [...peers, "claude"])).toThrow("one to 8");
});

test("#525 R3 planner settings use only this project's qualified planner declarations", () => {
  const catalog = createProjectAdapterCatalog();
  const instances: KindMap = {
    "claude-plan": { kind: "claude", roles: ["planner"] },
    "claude-review": { kind: "claude", roles: ["reviewer"], start_mode: "headless" },
    "claude-unset": { kind: "claude" },
    "codex-code": { kind: "codex", roles: ["implementer"] },
    "claude-code": { kind: "claude", roles: ["implementer"], start_mode: "headless" },
    "agy-plan": { kind: "agy", roles: ["planner"] },
    "local-plan": { kind: "local", roles: ["planner"] },
    "unqualified": { kind: "claude", roles: ["planner"] },
    "missing-plan": { kind: "missing", roles: ["planner"] },
  };
  const def = planner(instances, catalog);
  expect(def.values).toEqual([...PLANNER_PEERS, "claude-plan", "claude-unset", "codex-code"]);
  expect(checkSettingValue(def, "claude-plan")).toBe("claude-plan");
  expect(checkSettingValue(def, "codex-code")).toBe("codex-code");
  expect(checkSettingValue(def, "claude-unset")).toBe("claude-unset");
  for (const peer of Object.keys(instances).filter(peer => !["claude-plan", "claude-unset", "codex-code"].includes(peer))) {
    expect(() => checkSettingValue(def, peer), peer).toThrow();
  }
  expect(() => checkSettingValue(planner(), "claude-plan")).toThrow();
  expect(() => checkSettingValue(planner({}, catalog), "claude-plan")).toThrow();
  expect(definitionOf("claude-plan")).toBeUndefined();
  expect(planner().values).toEqual(PLANNER_PEERS);
  expect(projectSettings()).toBe(SETTINGS);
  for (const row of SETTINGS.filter(row => row.key !== "planner")) expect(settingDef(row.key, instances, catalog)).toBe(row);
});

test("#525 R3 planner settings obey bound role ceilings and do not discover inherited instance aliases", () => {
  const catalog = createProjectAdapterCatalog();
  const original = catalog.definitionOf("claude")!;
  for (const restricted of [
    { ...original, projection: { ...original.projection, plannerEligible: false } },
    { ...original, instances: { ...original.instances!, roles: ["reviewer"] } },
    { ...original, routing: { ...original.routing, allowedRoles: ["implementer"] } },
  ]) {
    const bound: ProjectAdapterCatalog = { ...catalog, definitionOf: (id, declarations) => catalog.definitionOf(id, declarations)?.kind === original.kind ? restricted : catalog.definitionOf(id, declarations) };
    expect(() => checkSettingValue(planner({ "claude-plan": { kind: "claude", roles: ["planner"] } }, bound), "claude-plan")).toThrow();
  }
  const inherited: KindMap = Object.create({ "claude-plan": { kind: "claude", roles: ["planner"] } });
  expect(() => checkSettingValue(planner(inherited, catalog), "claude-plan")).toThrow();
});

test("#525 R3 generic routing peer settings keep their existing unconstrained array contract", () => {
  const def = settingDef("routing.classes.implement.peers") as SettingDef;
  expect(checkSettingValue(def, [])).toEqual([]);
  expect(checkSettingValue(def, ["unknown-instance", "codex"])).toEqual(["unknown-instance", "codex"]);
  expect(checkSettingValue(def, ["codex"])).toEqual(["codex"]);
  expect(() => checkSettingValue(def, "codex")).toThrow("distinct peer ids");
  expect(() => checkSettingValue(def, ["codex", "codex"])).toThrow("distinct peer ids");
});
