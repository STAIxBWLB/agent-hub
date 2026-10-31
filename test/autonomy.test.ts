import { expect, test } from "bun:test";
import { autonomyPreset, autonomyStatus, autonomyRemovalKeys, planAutonomy, validateAutonomyPreset, type AutonomyKindPreset, type AutonomyPreset, type AutonomySettingLookup } from "../src/hub/autonomy.ts";
import { confirmationMatrix } from "../src/hub/confirmation-matrix.ts";

import presetJson from "../templates/presets/autonomous.json";
const clone = () => structuredClone(presetJson) as unknown as AutonomyPreset;
const lookup: AutonomySettingLookup = () => ({ store: "config" });

test("a new environment is data in the one preset, including its inventory projection", () => {
  const preset = clone();
  preset.environments.remote = { ...preset.environments.headless, aliases: ["remote-ci"], matrixEnvironment: "headless", detect: { priority: 20, variable: "REMOTE_EXECUTION" } };
  for (const entry of Object.values(preset.kinds)) entry.start.remote = entry.start.headless;
  expect(validateAutonomyPreset(preset)).toEqual([]);
  expect(planAutonomy("remote-ci", undefined, undefined, preset)).toEqual(planAutonomy("headless", undefined, undefined, preset));
});

test("the one shipped T1 preset covers every matrix kind without writing action policy", () => {
  const preset = autonomyPreset(), matrix = confirmationMatrix();
  expect(validateAutonomyPreset(preset)).toEqual([]);
  expect(Object.keys(preset.kinds).sort()).toEqual(Object.keys(matrix.kinds).sort());
  expect(Object.keys(preset.hub).some(key => key.startsWith("action_policy."))).toBe(false);
  expect(preset.floorClasses).toHaveLength(8);
  for (const key of ["tasks.auto_pull", "task_sweep.enabled", "task_sweep.auto_reassign"]) expect(preset.hub[key]).toBe(true);
});

test("planning emits only configuration defaults and CI selects the headless defaults", () => {
  const plan = planAutonomy("ci");
  expect(plan).toEqual(planAutonomy("headless"));
  expect(plan.length).toBeGreaterThan(5);
  expect(plan.every(operation => operation.store === "config" && !operation.key.startsWith("permission."))).toBe(true);
  expect(plan.find(operation => operation.key === "peers.codex.start_mode")?.value).toBe("headless");
  expect(plan.find(operation => operation.key === "permission_modes.codex")?.value).toBe("never-ask");
  expect(plan.some(operation => operation.key === "terminal.open")).toBe(false); // Preserve the person's existing template.
});

test("required hub operations fail clearly without a safe writer, never disappear from the transaction", () => {
  expect(() => planAutonomy("terminal", key => key === "tasks.auto_pull" ? undefined : { store: "config" })).toThrow("no safe writer for tasks.auto_pull");
  expect(() => planAutonomy("terminal", key => ({ store: key === "tasks.auto_pull" ? "runtime" : "config" }))).toThrow("unsupported preset value for tasks.auto_pull");
  expect(() => planAutonomy("terminal", key => ({ store: "config", ...(key === "task_sweep.enabled" ? { locked: "unavailable" } : {}) }))).toThrow("locked required setting task_sweep.enabled");
  expect(() => planAutonomy("headless", key => key === "peers.codex.start_mode" ? undefined : { store: "config" })).toThrow("no safe writer for peers.codex.start_mode");
});

test("unsupported terminal writer fails if an environment supplies a concrete template", () => {
  const preset = clone();
  preset.environments.terminal.terminalOpen = ["terminal-helper", "{command}"];
  expect(() => planAutonomy("terminal", key => key === "terminal.open" ? undefined : { store: "config" }, [], preset)).toThrow("no safe writer for terminal.open");
});

test("native-only forms get no invented permission setting and TUI-only kinds get no headless downgrade", () => {
  const terminal = planAutonomy("terminal");
  expect(terminal.some(operation => operation.key === "permission_modes.kimi")).toBe(false);
  expect(terminal.some(operation => operation.key === "permission_modes.jcode")).toBe(false);
  expect(terminal.some(operation => operation.key === "permission_modes.agy")).toBe(false);
  const headless = planAutonomy("headless");
  expect(headless.some(operation => operation.key === "permission_modes.claude" || operation.key === "peers.claude.start_mode")).toBe(false);
  expect(headless.some(operation => operation.key === "peers.agy.start_mode")).toBe(false);
});

test("declared instances use their fixed supported form and preserve locked permission defaults", () => {
  const definitions: AutonomySettingLookup = key => {
    if (key === "peers.claude-worker.start_mode") return { store: "config", values: ["headless"] };
    if (key === "permission_modes.claude-worker") return { store: "config", values: ["ask", "ask-when-needed"] };
    if (key === "permission_modes.codex-reader") return { store: "config", values: ["ask"], locked: "read-only" };
    if (key === "peers.codex-reader.start_mode") return { store: "config", values: ["headless"] };
    return { store: "config" };
  };
  const plan = planAutonomy("terminal", definitions, [{ id: "claude-worker", kind: "claude", form: "headless" }, { id: "codex-reader", kind: "codex", form: "headless" }]);
  expect(plan.find(operation => operation.key === "peers.claude-worker.start_mode")?.value).toBe("headless");
  expect(plan.find(operation => operation.key === "permission_modes.claude-worker")?.value).toBe("ask-when-needed");
  expect(plan.some(operation => operation.key === "permission_modes.codex-reader")).toBe(false);
  expect(plan.find(operation => operation.key === "peers.codex-reader.start_mode")?.value).toBe("headless");
});

test("resolved unmanaged variants retain start defaults without requiring a permission writer", () => {
  for (const kind of ["codex", "kimi", "claude"]) {
    const id = `${kind}-review`, peer = { id, kind, form: "headless" as const, unmanaged: true };
    const definitions: AutonomySettingLookup = key => key === `permission_modes.${id}` ? undefined : { store: "config", ...(key === `peers.${id}.start_mode` ? { values: ["headless"] } : {}) };
    const plan = planAutonomy("terminal", definitions, [peer]);
    expect(plan.some(operation => operation.key === `permission_modes.${id}`)).toBe(false);
    expect(plan).toContainEqual({ key: `peers.${id}.start_mode`, value: "headless", store: "config" });
    const [status] = autonomyStatus({ environment: "terminal", peers: [peer] });
    expect(status).toMatchObject({ effectiveMode: "unmanaged", nextMode: null, nextForm: "headless" });
    expect(status!.missing).toContain("Native permissions are not managed by the hub in this form; configure them in the native client.");
  }
});

test("a kind added to the inventory needs only matching preset data, not another code branch", () => {
  const preset = clone(), matrix = structuredClone(confirmationMatrix());
  matrix.kinds.newpeer = { forms: ["headless"], extraForms: [], conductorStartable: true, pullOnlyForms: [], hubMode: "mapped" };
  expect(validateAutonomyPreset(preset, matrix)).toContain("kinds.newpeer: missing");
  preset.kinds.newpeer = { permission: { tui: null, headless: "never-ask" }, start: Object.fromEntries(Object.keys(preset.environments).map(environment => [environment, "headless"])) as AutonomyKindPreset["start"] };
  matrix.keys["permission_modes.<peer>"]!.appliesTo!.push("newpeer");
  matrix.keys["peers.<peer>.start_mode"]!.appliesTo!.push("newpeer");
  expect(validateAutonomyPreset(preset, matrix)).toEqual([]);
  expect(planAutonomy("terminal", undefined, [{ id: "newpeer", kind: "newpeer" }], preset, matrix)).toContainEqual({ key: "permission_modes.newpeer", value: "never-ask", store: "config" });
});

test("validation refuses an invalid flow switch, native hub mapping, ambiguous alias and non-config key", () => {
  const cases: { change: (preset: ReturnType<typeof clone>) => void; text: string }[] = [
    { change: preset => { preset.hub["tasks.auto_pull"] = false; }, text: "must be true" },
    { change: preset => { preset.kinds.jcode!.permission.headless = "never-ask"; }, text: "unsupported hub mode" },
    { change: preset => { preset.environments.terminal.aliases.push("ci"); }, text: "ambiguous" },
    { change: preset => { preset.hub["release.authorize"] = true; }, text: "not a config setting" },
  ];
  for (const { change, text } of cases) { const preset = clone(); change(preset); expect(validateAutonomyPreset(preset).some(problem => problem.includes(text))).toBe(true); }
});

test("status reports current mode separately from the next-start default", () => {
  const [status] = autonomyStatus({ environment: "terminal", peers: [{ id: "claude", kind: "claude", form: "tui", permissionMode: "ask" }], terminalOpener: { available: true } });
  expect(status).toMatchObject({ effectiveMode: "ask", nextMode: "never-ask", applies: "next peer start" });
  expect(status!.missing.some(item => item.includes("Current mode ask") && item.includes("next peer start"))).toBe(true);
  expect(status!.floor.every(entry => entry.status === "not-enforced")).toBe(true);
});

test("status never suggests restarting a locked read-only peer into the wider preset mode", () => {
  const [status] = autonomyStatus({ environment: "headless", peers: [{ id: "codex-reader", kind: "codex", form: "headless", permissionMode: "read-only", lockedMode: "read-only" }] });
  expect(status).toMatchObject({ effectiveMode: "read-only", nextMode: "read-only" });
  expect(status!.missing.some(reason => reason.includes("ceiling is locked"))).toBe(true);
  expect(status!.missing.some(reason => reason.includes("restart the peer to use it"))).toBe(false);
});

test("a live pre-tool gate alone does not establish the unimplemented finer floor", () => {
  const [status] = autonomyStatus({ environment: "terminal", peers: [{ id: "claude", kind: "claude", form: "tui", permissionMode: "never-ask", actionEnforcement: { enforced: true } }], terminalOpener: { available: true } });
  expect(status!.floor.every(entry => entry.status === "not-enforced" && entry.reason.includes("#582"))).toBe(true);
});

test("native bypass potential or missing live evidence never becomes an assumed structural guard", () => {
  const [status] = autonomyStatus({ environment: "headless", peers: [{ id: "codex", kind: "codex", form: "headless", permissionMode: "never-ask", actionEnforcement: { enforced: false, reason: "native policy can execute without a request" } }] });
  expect(status!.floor.every(entry => entry.status === "not-enforced" && entry.reason.includes("native policy"))).toBe(true);
  expect(status!.missing.some(item => item.includes("No verified structural guard"))).toBe(true);
});

test("structural protection is reported per class only with explicit verified evidence", () => {
  const [status] = autonomyStatus({ environment: "headless", peers: [{ id: "codex", kind: "codex", structuralGuards: { "default-branch-push": { verified: true, reason: "Verified default-branch rule for this repository" }, "destroy-outside-root": { verified: false, reason: "native sandbox was not inspected" } } }] });
  expect(status!.floor.find(entry => entry.class === "default-branch-push")).toMatchObject({ status: "structural-guard", reason: "Verified default-branch rule for this repository" });
  expect(status!.floor.find(entry => entry.class === "destroy-outside-root")?.status).toBe("not-enforced");
  expect(status!.floor.find(entry => entry.class === "external-send")?.status).toBe("not-enforced");
});

test("personal-turn visibility gaps in the T0 matrix remain gaps even when a caller supplies an optimistic gate", () => {
  const [status] = autonomyStatus({ environment: "terminal", peers: [{ id: "qwen", kind: "qwen", form: "tui", actionEnforcement: { enforced: true } }], terminalOpener: { available: true } });
  expect(status!.effectiveMode).toBe("unmanaged");
  expect(status!.floor.every(entry => entry.status === "not-enforced")).toBe(true);
  expect(status!.missing.some(item => item.includes("every turn"))).toBe(true);
});

test("environment and unsupported native setup are explicit missing entries, never presumed installed", () => {
  const [status] = autonomyStatus({ environment: "orca", peers: [{ id: "claude", kind: "claude", form: "tui" }], terminalOpener: { available: false, reason: "Orca executable is unavailable" } });
  expect(status!.missing.some(item => item.includes("Orca executable is unavailable") && item.includes("Configure terminal.open"))).toBe(true);
  const [unavailable] = autonomyStatus({ environment: "ci", peers: [{ id: "agy", kind: "agy" }] });
  expect(unavailable!.nextForm).toBeNull();
  expect(unavailable!.missing.some(item => item.includes("No headless base start"))).toBe(true);
  const [unknown] = autonomyStatus({ environment: "terminal", peers: [{ id: "newpeer", kind: "newpeer" }] });
  expect(unknown!.effectiveMode).toBe("unknown");
  expect(unknown!.missing.some(item => item.includes("No autonomy preset"))).toBe(true);
  const [observed] = autonomyStatus({ environment: "terminal", peers: [{ id: "newpeer", kind: "newpeer", permissionMode: "ask" }] });
  expect(observed!.effectiveMode).toBe("ask");
  expect(observed!.missing.some(item => item.includes("No autonomy preset"))).toBe(true);
});

test("off scope comes from shipped keys and host peers across all environments", () => {
  const keys = autonomyRemovalKeys([{ id: "codex", kind: "codex" }, { id: "kimi", kind: "kimi" }]);
  for (const key of ["permission_modes.codex", "permission.codex", "permission_modes.kimi", "tasks.auto_pull", "task_sweep.auto_reassign", "peers.codex.start_mode"]) expect(keys).toContain(key);
  expect(keys.some(key => key.startsWith("action_policy."))).toBe(false);
  expect(() => autonomyRemovalKeys([{ id: "constructor.prototype", kind: "codex" }])).toThrow();
});
