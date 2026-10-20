import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configApply, configChanges, validateRawConfig, validateEffectiveConfig, assertReloadTrust, type ConfigLayer } from "../src/hub/config-apply.ts";
import { DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { SETTINGS } from "../src/hub/settings.ts";
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
  for (const key of Object.keys(DEFAULT_CONFIG)) expect(["live", "next use", "restart"]).toContain(configApply(key).applies);
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
  expect(configChanges(before, next).map(change => [change.key, change.applies])).toEqual([["approvals.notify", "live"], ["memory.native", "restart"]]);
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
