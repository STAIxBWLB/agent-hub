import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSettingValue, NEVER_EDITABLE, settingDef, settingRefusal, settingRows, SETTINGS, undoSetting, writeConfigSetting, type SettingDef } from "../src/hub/settings.ts";
import * as settingsModule from "../src/hub/settings.ts";
import { parseRouting } from "../src/hub/routing.ts";
import { hubGitSync } from "../src/hub/git.ts";

const instances = { "codex-worker": { kind: "codex" }, "pi-worker": { kind: "pi" }, "local-reader": { kind: "local" } };
function def(key: string, map = instances): SettingDef { const value = settingDef(key, map); expect(typeof value, key).toBe("object"); return value as SettingDef; }
function projectSettings(map?: typeof instances): readonly SettingDef[] {
  expect(typeof settingsModule.projectSettings).toBe("function");
  return settingsModule.projectSettings(map);
}

test("#450 settings keep legacy definitions and recognize only exact project declarations", () => {
  for (const entry of SETTINGS) { expect(settingDef(entry.key)).toBe(entry); expect(settingDef(entry.key, instances)).toBe(entry); }
  for (const scope of ["roster", "permission", "permission_modes"]) {
    expect(typeof settingDef(`${scope}.codex-worker`)).toBe("string");
    expect(typeof settingDef(`${scope}.codex-undeclared`, instances)).toBe("string");
    expect(typeof settingDef(`${scope}.codex-worker`, { "kimi-worker": { kind: "kimi" } })).toBe("string");
    const extra = def(`${scope}.codex-worker`), base = def(`${scope}.codex`);
    expect(extra.store).toBe(base.store); expect(extra.risk).toBe(base.risk); expect(extra.floor).toBe(base.floor);
    expect(extra.values).toEqual(base.values); expect(extra.path.at(-1)).toBe("codex-worker");
  }
  expect(projectSettings()).toBe(SETTINGS);
  expect(NEVER_EDITABLE).toContain("instances");
  expect(String(settingDef("instances", instances))).toContain("never editable");
  expect(String(settingDef("instances.codex-worker.kind", instances))).toContain("never editable");
});

test("#450 extra settings never grant a TUI or bypass existing settings authority", () => {
  for (const id of Object.keys(instances)) {
    const start = def(`peers.${id}.start_mode`);
    expect(start.values).toEqual(["headless"]); expect(start.floor).toBe("headless");
    expect(checkSettingValue(start, "headless")).toBe("headless");
    expect(() => checkSettingValue(start, "tui")).toThrow();
    expect(settingRefusal(def(`roster.${id}`), true, "ordinary")).toContain("widen");
    expect(settingRefusal(def(`permission.${id}`), "never-ask", "ordinary")).toContain("widen");
    expect(settingRefusal(def(`permission.${id}`), "ask", "ordinary")).toBeUndefined();
  }
});

test("#450 lookup and row rendering share the same instance setting definitions", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-instance-setting-rows-"));
  try {
    const input = { cwd, routing: parseRouting('[local]\nfixed_model = "fixture"\n'), running: () => undefined, next: () => undefined, mode: () => ({ value: "ask" }) };
    const legacy = settingRows(input);
    expect(settingRows({ ...input, instances: {} })).toEqual(legacy);
    const rows = settingRows({ ...input, instances }), expected = projectSettings(instances).filter(entry => !SETTINGS.includes(entry));
    expect(rows.slice(0, legacy.length)).toEqual(legacy);
    expect(rows.slice(legacy.length).map(row => row.key)).toEqual(expected.map(entry => entry.key));
    for (const row of rows.slice(legacy.length)) {
      const entry = def(row.key);
      expect(row.type).toBe(entry.type); expect(row.risk).toBe(entry.risk); expect(row.floor).toBe(entry.floor);
      if (entry.type === "enum") expect(row.values).toEqual(entry.values);
    }
    expect(rows.find(row => row.key === "permission.codex-worker")?.hint).toContain("native vendor bounds");
    expect(rows.find(row => row.key === "permission.local-reader")?.hint).toContain("inside hub sandbox");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("#450 instance setting writes and undo preserve declarations and caller validation context", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-instance-setting-write-")), stateDir = join(cwd, ".agenthub", "state");
  try {
    mkdirSync(stateDir, { recursive: true });
    const git = hubGitSync(["-C", cwd, "init", "-q"], { encoding: "utf8" }); if (git.status !== 0) throw new Error(String(git.stderr));
    writeFileSync(join(cwd, ".agenthub", "config.json"), "{}\n");
    const file = join(cwd, ".agenthub", "config.local.json"), original = JSON.stringify({ instances }); writeFileSync(file, original);
    let validations = 0;
    const validate = (scratch: string) => {
      validations++;
      const candidate = JSON.parse(readFileSync(join(scratch, ".agenthub", "config.local.json"), "utf8"));
      expect(candidate.instances).toEqual(instances);
      expect(typeof settingDef("permission_modes.codex-worker", instances)).toBe("object");
      expect(typeof settingDef("permission_modes.codex-worker")).toBe("string");
    };
    expect(writeConfigSetting(cwd, stateDir, def("permission_modes.codex-worker"), "never-ask", validate)).toBe(true);
    const written = readFileSync(file, "utf8");
    expect(JSON.parse(written).permission_modes["codex-worker"]).toBe("never-ask");
    expect(() => writeConfigSetting(cwd, stateDir, def("permission_modes.codex-worker"), "ask", () => { throw new Error("current project policy refused"); })).toThrow("current project policy refused");
    expect(readFileSync(file, "utf8")).toBe(written);
    expect(undoSetting(cwd, stateDir, validate).key).toBe("permission_modes.codex-worker");
    expect(readFileSync(file, "utf8")).toBe(original); expect(validations).toBe(2);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
