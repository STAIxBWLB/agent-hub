import { createProjectAdapterCatalog } from "../src/adapters/registry.ts";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configApply, configChanges, SCHEMA_KEYS, validateRawConfig, validateEffectiveConfig, assertReloadTrust, type ConfigLayer } from "../src/hub/config-apply.ts";
import { parseConfigSources, configSourceTexts } from "../src/hub/config-reload.ts";
import { DEFAULT_CONFIG, loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { runConsole, type ConsoleTerminal } from "../src/cli/console.ts";
import { savePetPalette } from "../src/pet/config.ts";
import { init } from "../src/cli/init.ts";
import { SETTINGS, writeConfigSetting } from "../src/hub/settings.ts";
import { hubGitSync } from "../src/hub/git.ts";
import * as configAuthorization from "../src/hub/config-apply.ts";

type LeafDecision = { key: string; allowed: boolean; guarded: boolean; reason: string };
const authorize = (input: Record<string, unknown>): LeafDecision => (configAuthorization as unknown as {
  authorizeConfigLeaf(input: Record<string, unknown>): LeafDecision;
}).authorizeConfigLeaf(input);
const ordinary = { source: "config", tracked: true, authority: "ordinary" };

test("#439 delegated catalog and profile maps reject reserved names before confirmation", () => {
  for (const name of ["constructor", "prototype", "__proto__"]) {
    const catalog = JSON.parse(JSON.stringify({ catalog_roles: { [name]: [] } }));
    expect(() => validateRawConfig(catalog)).toThrow("unknown key");
    const profile = JSON.parse(JSON.stringify({ profile_overrides: { classes: { [name]: "implement" } } }));
    expect(() => validateRawConfig(profile)).toThrow("unknown key");
  }
});

test("#439 leaf authorization automatically admits privacy tightening and role removal from tracked or untracked sources", () => {
  for (const tracked of [true, false, undefined]) {
    for (const change of [
      { key: "routing.constraints.pii", before: "off", after: "local_only" },
      { key: "routing.signals.pii_patterns", before: ["old"], after: ["old", "new"] },
      { key: "routing.signals.pii_screen", before: "off", after: "local" },
      { key: "roles.codex", before: ["implementer", "conductor"], after: ["implementer"] },
      { key: "capabilities.codex", before: ["memory_read", "check_run"], after: ["memory_read"] },
    ]) {
      const result = authorize({ ...ordinary, ...change, source: change.key.startsWith("routing.") ? "routing" : "config", tracked });
      expect(result).toMatchObject({ key: change.key, allowed: true }); expect(result.reason.length).toBeGreaterThan(0);
    }
  }
});

test("#439 leaf authorization distinguishes registered WIP reductions, floors and increases", () => {
  const guard = SETTINGS.find(entry => entry.key === "tasks.wip_limits.codex")!;
  for (const after of [3, 0]) expect(authorize({ ...ordinary, key: guard.key, before: 5, after, guard }).allowed).toBe(true);
  for (const tracked of [true, false, undefined]) expect(authorize({ ...ordinary, key: guard.key, before: 1, after: 5, tracked, guard }).allowed).toBe(false);
  expect(authorize({ ...ordinary, key: guard.key, before: 1, after: 5, tracked: false, authority: "settings", confirmed: true, guard }).allowed).toBe(true);
  expect(authorize({ ...ordinary, key: guard.key, before: 1, after: 5, tracked: false, authority: "terminal", guard }).allowed).toBe(false);
});

test("#439 machine command changes and removals require untracked confirmed terminal intent", () => {
  for (const after of [["new-program"], undefined]) {
    const change = { key: "kimi_cmd", before: ["old-program"], after };
    for (const tracked of [true, undefined]) expect(authorize({ ...ordinary, ...change, tracked, authority: "terminal", confirmed: true })).toMatchObject({ allowed: false, guarded: true });
    expect(authorize({ ...ordinary, ...change, tracked: false, authority: "terminal" }).allowed).toBe(false);
    expect(authorize({ ...ordinary, ...change, tracked: false, authority: "settings", confirmed: true }).allowed).toBe(false);
    expect(authorize({ ...ordinary, ...change, tracked: false, authority: "terminal", confirmed: true })).toMatchObject({ allowed: true, guarded: true });
  }
});

test("#439 nonregistry policy changes are guarded while known semantic tightenings remain automatic", () => {
  for (const change of [
    { key: "limits.sender_per_min", before: 12, after: 0 },
    { key: "conductor.feed", before: "own", after: "all" },
    { key: "inference.enabled", before: false, after: true },
    { key: "review.min_reviews", before: 5, after: 1 },
    { key: "routing.classes.implement.route", before: "old", after: "new" },
  ]) {
    expect(authorize({ ...ordinary, ...change, tracked: false })).toMatchObject({ allowed: false, guarded: true });
    expect(authorize({ ...ordinary, ...change, tracked: false, authority: "settings", confirmed: true }).allowed).toBe(false);
    expect(authorize({ ...ordinary, ...change, tracked: false, authority: "terminal", confirmed: true }).allowed).toBe(true);
  }
  for (const change of [
    { key: "limits.sender_per_min", before: 0, after: 12 },
    { key: "limits.sender_per_min", before: 12, after: 6 },
    { key: "limits.repeat_window_s", before: 60, after: 120 },
    { key: "conductor.feed", before: "all", after: "own" },
    { key: "inference.enabled", before: true, after: false },
    { key: "review.min_reviews", before: 1, after: 5 },
  ]) expect(authorize({ ...ordinary, ...change }).allowed).toBe(true);
});

test("#439 safe registry changes and identical values need no guarded adoption", () => {
  const guard = SETTINGS.find(entry => entry.key === "research.enabled")!;
  expect(authorize({ ...ordinary, key: guard.key, before: false, after: true, guard })).toMatchObject({ allowed: true, guarded: false });
  expect(authorize({ ...ordinary, key: "kimi_cmd", before: ["same"], after: ["same"] })).toMatchObject({ allowed: true, guarded: false });
  const protection = SETTINGS.find(entry => entry.key === "scoped_grants.protect_instructions")!;
  expect(authorize({ ...ordinary, key: "protect_instruction_files", before: false, after: true, guard: protection }).allowed).toBe(true);
});

test("#439 every effective block and editable config key has an apply class, restart reasons and leaf overrides", () => {
  for (const key of new Set([...Object.keys(DEFAULT_CONFIG), ...SCHEMA_KEYS])) expect(["live", "next use", "restart"]).toContain(configApply(key).applies);
  for (const def of SETTINGS) {
    const key = def.store === "config" ? def.path.join(".") : def.key;
    expect(configApply(key).applies).toBe(def.applies);
  }
  for (const key of ["memory.native", "omniroute.urls", "mlx.enabled", "checks.runner", "pii.paths", "data.readonly", "local.deny", "profile", "profile_overrides", "text_projection", "terminal.open", "bench.enabled"]) {
    expect(configApply(key).applies).toBe("restart"); expect(configApply(key).reason?.length).toBeGreaterThan(10);
  }
  expect(configApply("memory.brief_items").applies).toBe("next use");
  for (const key of ["unknown", "memory.typo", "approvals.typo"]) expect(() => configApply(key)).toThrow();
});

test("#439 raw and effective config reject malformed entire candidates without mutating them", () => {
  expect(() => validateEffectiveConfig(DEFAULT_CONFIG)).not.toThrow();
  const optional = { ...DEFAULT_CONFIG, planner: undefined, checks: { ...DEFAULT_CONFIG.checks, runner: undefined } };
  expect(() => validateEffectiveConfig(optional)).not.toThrow();
  expect(() => validateRawConfig({ conductor: { approval_wait_s: 0 }, capabilities: { external: ["memory_read"] }, roles: { external: ["reviewer"] } })).not.toThrow();
  expect(() => validateRawConfig({ text_projection: { bad_extension: ["converter", "{input}"] } })).toThrow();
  const custom = { ...DEFAULT_CONFIG, profile_overrides: { classes: { custom: "implement" } }, checks: { ...DEFAULT_CONFIG.checks, custom: "fixed check" } };
  expect(() => validateEffectiveConfig(custom)).not.toThrow();
  for (const bad of [{ typo: true }, { approvals: { notify: "yes" } }, { task_sweep: { interval_s: 0 } }, { task_sweep: { typo: 1 } }, { memory: { short_ttl_days: 1.5 } }, { snapshots: { enabled: true, keep: "2" } }, { peers: { codex: { typo: true } } }]) {
    const snapshot = structuredClone(bad); expect(() => validateRawConfig(bad)).toThrow(); expect(bad).toEqual(snapshot);
  }
  expect(() => validateRawConfig({ task_sweep: { interval_s: 1.5 }, approvals: { notify: false } })).not.toThrow();
  const before = structuredClone(DEFAULT_CONFIG), next = structuredClone(DEFAULT_CONFIG);
  next.approvals.notify = !before.approvals.notify; next.memory.native = !before.memory.native;
  expect(configChanges(before, next, [{ catalog: createProjectAdapterCatalog(), instances: {} }]).map(change => [change.key, change.applies])).toEqual([["approvals.notify", "live"], ["memory.native", "restart"]]);
  expect(before).toEqual(DEFAULT_CONFIG);
});

test("#439 reload trust compares actual files and raw accepted baseline, refuses tracked raises and unrelated ordinary raises", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-config-reload-trust-"));
  try {
    mkdirSync(join(root, ".agenthub"));
    const git = (...args: string[]) => expect(hubGitSync(args, { cwd: root, encoding: "utf8", timeout: 1000 }).status).toBe(0);
    git("init", "-q");
    writeFileSync(join(root, ".agenthub", "config.json"), "{}"); git("add", "-f", ".agenthub/config.json");
    const baseline: ConfigLayer[] = [{ name: "config.json", raw: {} }];
    const tracked: ConfigLayer[] = [{ name: "config.json", raw: { pi: { cmd: ["untrusted"] } } }];
    expect(() => assertReloadTrust(root, tracked, baseline, SETTINGS, "terminal", DEFAULT_CONFIG)).toThrow("tracked");
    const local: ConfigLayer[] = [{ name: "config.local.json", raw: { roster: { codex: true }, research: { enabled: true } } }];
    expect(() => assertReloadTrust(root, local, [], SETTINGS, "ordinary", DEFAULT_CONFIG)).toThrow("authority");
    expect(() => assertReloadTrust(root, local, [], SETTINGS, "terminal", DEFAULT_CONFIG)).not.toThrow();
    expect(() => assertReloadTrust(root, local, local, SETTINGS, "ordinary", DEFAULT_CONFIG)).not.toThrow();
    expect(() => assertReloadTrust(root, [{ name: "config.local.json", raw: { roster: { codex: false } } }], local, SETTINGS, "ordinary", DEFAULT_CONFIG)).not.toThrow();
    expect(() => assertReloadTrust(root, [], local, SETTINGS, "ordinary", DEFAULT_CONFIG)).toThrow();
    expect(() => assertReloadTrust(root, [{ name: "config.local.json", raw: { permission_modes: { codex: "ask" } } }], [], SETTINGS, "ordinary", DEFAULT_CONFIG)).not.toThrow();
    const askDefault: ConfigLayer[] = [{ name: "config.local.json", raw: { permission_modes: { codex: "ask" } } }];
    expect(() => assertReloadTrust(root, [], askDefault, SETTINGS, "ordinary", DEFAULT_CONFIG)).toThrow("authority");
    const routing = { name: "routing.toml" as const, raw: { stay_switch: "enforce" } };
    writeFileSync(join(root, ".agenthub", "routing.toml"), 'stay_switch="enforce"'); git("add", "-f", ".agenthub/routing.toml");
    expect(() => assertReloadTrust(root, [routing], [], SETTINGS, "terminal", DEFAULT_CONFIG)).toThrow("tracked");
    expect(() => assertReloadTrust(root, [routing], [routing], SETTINGS, "ordinary", DEFAULT_CONFIG)).not.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("#439 non-machine settings retain terminal authority outside Git without treating a broken repository as untracked", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-reload-no-git-"));
  try {
    mkdirSync(join(root, ".agenthub"));
    const routing = [{ name: "routing.local.toml" as const, raw: { stay_switch: "enforce" } }];
    expect(() => assertReloadTrust(root, routing, [], SETTINGS, "terminal", DEFAULT_CONFIG)).not.toThrow();
    expect(() => assertReloadTrust(root, [{ name: "config.local.json", raw: { pi: { cmd: ["program"] } } }], [], SETTINGS, "terminal", DEFAULT_CONFIG)).toThrow("unknown");
    writeFileSync(join(root, ".git"), "unreadable repository declaration");
    expect(() => assertReloadTrust(root, routing, [], SETTINGS, "terminal", DEFAULT_CONFIG)).toThrow("unknown");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

 test("#439 routing policy is live while published Pi relay models require restart", () => {
  for (const key of ["routing.classes.implement.peer", "routing.stay_switch", "routing.constraints.pii", "routing.hub_routes"]) expect(configApply(key).applies).toBe("live");
  for (const key of ["routing.local.fixed_model"]) expect(configApply(key).applies).toBe("next use");
  for (const key of ["routing.pi.context_window", "pi.dgx_coding", "pi.dgx_fast"]) {
    expect(configApply(key).applies).toBe("restart"); expect(configApply(key).reason).toContain("relay");
  }
});

test("#439 removing a restricted capabilities entry is a widening because absence grants all", () => {
  for (const tracked of [true, false, undefined]) expect(authorize({ ...ordinary, key: "capabilities.codex", before: ["memory_read"], after: undefined, tracked }).allowed).toBe(false);
  expect(authorize({ ...ordinary, key: "capabilities.codex", before: ["memory_read"], after: [], tracked: true }).allowed).toBe(true);
});

test("tasks.escalate_after is a bounded integer that applies live (#488)", () => {
  for (const value of [1, 3, 10]) expect(() => validateRawConfig({ tasks: { escalate_after: value } })).not.toThrow();
  for (const value of [0, 11, 2.5, "3"]) expect(() => validateRawConfig({ tasks: { escalate_after: value } })).toThrow();
  expect(configApply("tasks.escalate_after").applies).toBe("live");
  expect(DEFAULT_CONFIG.tasks.escalate_after).toBe(3);
});

test("#483 A1-A6: pet config block validates at startup and reload, applies live across daemon and open console, and preserves required default maps", async () => {
  // A1: schema, apply class and leaf authorization for pet
  expect(() => validateRawConfig({ pet: false })).not.toThrow();
  expect(() => validateRawConfig({ pet: { character: "gyul", size: "mini", glyphs: "blocks", blink: false, bell: true, palette: "c", window: true } })).not.toThrow();
  const invalidPetConfigs = [{ pet: true }, { pet: "stai" }, { pet: [] }, { pet: { unknown: true } }, { pet: { character: "dragon" } }, { pet: { size: "huge" } }, { pet: { glyphs: "emoji" } }, { pet: { palette: "red" } }, { pet: { blink: "yes" } }, { pet: { bell: 1 } }, { pet: { window: "true" } }];
  for (const bad of invalidPetConfigs) {
    expect(() => validateRawConfig(bad)).toThrow();
  }
  for (const key of ["pet", "pet.character", "pet.size", "pet.glyphs", "pet.blink", "pet.bell", "pet.palette", "pet.window"]) {
    expect(configApply(key)).toEqual({ applies: "live" });
    expect(authorize({ ...ordinary, key, before: undefined, after: "teal", tracked: true })).toMatchObject({ key, allowed: true, guarded: false });
    expect(authorize({ ...ordinary, key, before: "teal", after: undefined, tracked: false })).toMatchObject({ key, allowed: true, guarded: false });
  }
  expect(() => configApply("pet.typo")).toThrow();

  // A4 & A5: round-trip every config writer and verify startup (loadConfig) and reload (parseConfigSources) reject invalid pet values identically
  const root = mkdtempSync(join(tmpdir(), "ahub-pet-reload-"));
  try {
    init(root);
    expect(() => parseConfigSources(configSourceTexts(root))).not.toThrow();
    for (const bad of invalidPetConfigs) {
      writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify(bad));
      let startupMessage = "", reloadMessage = "";
      try { loadConfig(root); } catch (error) { startupMessage = (error as Error).message; }
      try { parseConfigSources(configSourceTexts(root)); } catch (error) { reloadMessage = (error as Error).message; }
      expect(startupMessage.length).toBeGreaterThan(0);
      expect(reloadMessage).toBe(`.agenthub/config.local.json: ${startupMessage}`);
    }
    writeFileSync(join(root, ".agenthub/config.local.json"), "{}");
    for (const choice of ["a", "b", "c", "d", "blue", "teal", "violet", "ochre"]) {
      savePetPalette(root, choice);
      expect(() => loadConfig(root)).not.toThrow();
      expect(() => validateRawConfig(JSON.parse(readFileSync(join(root, ".agenthub/config.local.json"), "utf8")))).not.toThrow();
      expect(() => parseConfigSources(configSourceTexts(root))).not.toThrow();
    }
    const stateDir = join(root, ".agenthub/state");
    for (const [key, value] of [["research.enabled", true], ["roster.jcode", true]] as const) {
      const def = SETTINGS.find(s => s.key === key)!;
      writeConfigSetting(root, stateDir, def, value, scratch => parseConfigSources(configSourceTexts(scratch)));
      expect(() => parseConfigSources(configSourceTexts(root))).not.toThrow();
    }

    // A2, A3, A5, A6 + I1 regression: live daemon reload with saved palette, unrelated jcode_cmd + roster add, removing pet block, and removing sole capabilities.codex entry
    writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, pet: { window: true, character: "boxbot" } }));
    writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ pet: { palette: "teal" }, capabilities: { codex: ["memory_read"] } }));
    expect(hubGitSync(["init", "-q"], { cwd: root, encoding: "utf8", timeout: 1000 }).status).toBe(0);
    const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0 });
    const client = await ControlClient.connect(stateDir, { role: "console" });
    const tools = await ControlClient.connect(stateDir, { role: "tools", peer: "codex" });
    try {
      // A2: savePetPalette round-trips through live reload
      savePetPalette(root, "violet");
      const r1 = await client.request({ t: "settings_reload" });
      expect(r1).toMatchObject({ ok: true, rejected: [] });
      expect(r1.applied).toContain("pet.palette");

      // A3: unrelated config.local.json change (jcode_cmd) + roster add reloads with saved palette present
      const current = JSON.parse(readFileSync(join(root, ".agenthub/config.local.json"), "utf8"));
      writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ ...current, jcode_cmd: ["jcode", "--custom"] }, null, 2) + "\n");
      const rosterReply = await client.request({ t: "settings_set", key: "roster.jcode", value: true });
      expect(rosterReply).toMatchObject({ ok: true });
      const reloadPreview = await client.request({ t: "settings_reload" });
      expect(reloadPreview.ok).toBe(true);
      expect(reloadPreview.confirmation?.keys).toEqual(["jcode_cmd"]);
      const reloadConfirmed = await client.request({ t: "settings_reload", confirm: reloadPreview.confirmation.token });
      expect(reloadConfirmed).toMatchObject({ ok: true, rejected: [] });
      expect(reloadConfirmed.applied).toContain("jcode_cmd");

      // A5 & A6: removing the pet block from config.local.json (and config.json) reloads cleanly without deadlock
      writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ roster: { jcode: true }, jcode_cmd: ["jcode", "--custom"], capabilities: { codex: ["memory_read"] } }, null, 2) + "\n");
      const afterLocalRemove = await client.request({ t: "settings_reload" });
      expect(afterLocalRemove).toMatchObject({ ok: true, rejected: [] });
      expect(afterLocalRemove.applied).toContain("pet.palette");
      writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false } }));
      const afterAllRemove = await client.request({ t: "settings_reload" });
      expect(afterAllRemove).toMatchObject({ ok: true, rejected: [] });
      expect(afterAllRemove.applied).toEqual(["pet"]);

      // I1 regression: removing the sole capabilities.codex entry on a confirmed reload preserves capabilities: {} so subsequent tool checks succeed
      const restricted = await tools.request({ t: "task", op: "hub_task_propose", args: { title: "restricted", class: "implement", owner: "codex" } });
      expect(restricted).toMatchObject({ ok: false });
      expect(String(restricted.error)).toContain('no "propose" in capabilities.codex');
      writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ roster: { jcode: true }, jcode_cmd: ["jcode", "--custom"] }, null, 2) + "\n");
      const capPreview = await client.request({ t: "settings_reload" });
      expect(capPreview.ok).toBe(true);
      expect(capPreview.confirmation?.keys).toEqual(["capabilities.codex"]);
      const capConfirmed = await client.request({ t: "settings_reload", confirm: capPreview.confirmation.token });
      expect(capConfirmed).toMatchObject({ ok: true, rejected: [] });
      expect(capConfirmed.applied).toEqual(["capabilities.codex"]);
      const allowed = await tools.request({ t: "task", op: "hub_task_propose", args: { title: "allowed after cap removal", class: "implement", owner: "codex" } });
      expect(allowed).toMatchObject({ ok: true });
      expect(String(allowed.text)).toContain("task #1");
    } finally {
      tools.close();
      client.close();
      await daemon.stop();
    }

    // I3: open console refreshes pet character, blink and bell live when the config file changes
    writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ pet: { character: "stai", bell: false, blink: true } }));
    let output = "", key = (_text: string) => {}, signal = () => {};
    const terminal: ConsoleTerminal = { columns: 70, rows: 20, isTTY: true, write: text => { output += text; }, raw: () => {}, onData: fn => { key = fn; return () => {}; }, onSignal: fn => { signal = fn; return () => {}; }, onResize: () => () => {} };
    const fakeClient: any = { request: async () => ({ ok: true, status: { tasks: {}, peers: {} }, budget: {} }), send: () => {}, close: () => {}, onPush: undefined, onClose: undefined };
    const runningConsole = runConsole({ cwd: root, stateDir, client: fakeClient, terminal, color: false });
    try {
      await Bun.sleep(20);
      output = "";
      writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ pet: { character: "boxbot", bell: true, blink: false } }));
      key("\t"); // triggers refresh() on the open console
      await Bun.sleep(20);
      fakeClient.onPush({ t: "permission", id: "perm-1", peer: "codex", title: "fixture", expiresAt: Date.now() + 300_000, options: [] });
      expect(output).toContain("{O O} ! 1 need you");
      expect(output).toContain("\x07");
    } finally {
      signal();
      await runningConsole;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
