import { expect, test } from "bun:test";
import { createProjectAdapterCatalog } from "../src/adapters/registry.ts";
import { checkSettingValue, projectSettings, settingRefusal, settingRows } from "../src/hub/settings.ts";
import { parseRouting } from "../src/hub/routing.ts";
import { initialConsoleState, reduceConsole } from "../src/cli/console-state.ts";

const adapterCatalog = createProjectAdapterCatalog({ fixture: { transport: "acp", command: "fixture-acp", displayName: "Fixture", roles: ["verifier"], readOnly: "inspect" } });
const instances = { "fixture-reader": { kind: "fixture", roles: ["verifier"], readOnly: true } };
const definitions = () => projectSettings(instances, adapterCatalog).filter(row => row.key === "permission.fixture-reader" || row.key === "permission_modes.fixture-reader");
const rows = () => settingRows({ cwd: "/fixture-not-present", adapterCatalog, instances, routing: parseRouting('[local]\nfixed_model="fixture"\n'), running: () => "never-ask", next: () => "ask", mode: () => ({ value: "never-ask" }) });

test("read-only instances show locked runtime and default settings even without an ordinary permission map", () => {
  const defs = definitions();
  expect(defs).toHaveLength(2);
  for (const def of defs) {
    expect(def.values).toEqual(["read-only"]);
    expect(def.locked).toContain("read-only");
    const row = rows().find(row => row.key === def.key)!;
    expect(row).toMatchObject({ value: "read-only", fileValue: "read-only", locked: def.locked, note: def.locked });
    expect(row.pending).toBeUndefined();
  }
});

test("locked settings refuse values, inheritance and undo across every setting authority", () => {
  for (const def of definitions()) for (const value of ["ask", "never-ask", "read-only", null]) {
    expect(() => checkSettingValue(def, value)).toThrow(def.locked!);
    for (const authority of ["ordinary", "settings", "terminal"] as const) expect(settingRefusal(def, value, authority)).toBe(def.locked);
  }
});

test("console e and undo show the read-only lock without opening an editor or preview", () => {
  const row = rows().find(row => row.key === "permission.fixture-reader")!;
  for (const key of ["e", "u"]) {
    const initial = { ...initialConsoleState(true), panel: 6, settingsKnown: true, settingsRows: [row], settingsUndo: row.key };
    const result = reduceConsole(initial, key);
    expect(result.state.settingsEdit).toBeUndefined();
    expect(result.effects).toEqual([]);
    expect(JSON.stringify(result.state)).toContain(row.locked!);
  }
});
