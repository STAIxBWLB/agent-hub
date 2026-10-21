import { DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectAdapterCatalog, definitionOf } from "../src/adapters/registry.ts";
import { readInstanceConfig, readInstanceRoleConfig } from "../src/hub/instance-config.ts";
import { effectiveInstanceRoles, instanceCatalog, instanceDefaultRoles, validateInstances } from "../src/hub/instances.ts";
import { configApply, configChanges, configIdentityScope, validateRawConfig } from "../src/hub/config-apply.ts";
import { parseConfigSources, type ConfigSourceTexts } from "../src/hub/config-reload.ts";
import { hubGitSync } from "../src/hub/git.ts";

const adapters = { fixture: { transport: "acp" as const, command: "fixture-agent", args: ["stdio"], displayName: "Fixture ACP", roles: ["implementer", "verifier"], identity: { name: "Fixture", version: "1" }, permission: { ask: "safe" }, readOnly: "plan" } };
const instances = { "fixture-check": { kind: "fixture", roles: ["verifier"], start_mode: "headless" as const, readOnly: true } };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-configured-adapter-"));
  if (hubGitSync(["init", "-q", root], { encoding: "utf8" }).status !== 0) throw new Error("fixture git init failed");
  mkdirSync(join(root, ".agenthub"));
  return { root, write: (name: string, raw: unknown) => writeFileSync(join(root, ".agenthub", name), JSON.stringify(raw)), close: () => rmSync(root, { recursive: true, force: true }) };
}
function texts(local: unknown, shared: unknown = {}): ConfigSourceTexts {
  return { "config.local.json": JSON.stringify(local), "config.json": JSON.stringify(shared), "routing.toml": null, "routing.local.toml": null };
}

test("configured adapter trust is checked before compiling local instances", () => {
  const f = fixture();
  try {
    f.write("config.local.json", { adapters, instances });
    const config = readInstanceRoleConfig(f.root);
    expect(config.catalog.definitionOf("fixture-check", config.instances)?.kind).toBe("fixture");
    expect(config.instances?.["fixture-check"]?.readOnly).toBe(true);
    expect(config.adapters).toEqual(adapters);
    expect(definitionOf("fixture")).toBeUndefined();
  } finally { f.close(); }
});

test("shared and tracked adapter declarations are ignored without leaking their values", () => {
  const f = fixture();
  try {
    f.write("config.json", { adapters: { malformed: "PRIVATE-COMMAND" }, instances: { invalid: {} } });
    const shared = readInstanceConfig(f.root);
    expect(shared.adapters).toBeUndefined(); expect(shared.instances).toBeUndefined();
    expect(shared.ignored.join(" ")).toContain("adapters, instances");
    expect(shared.ignored.join(" ")).not.toContain("PRIVATE-COMMAND");
    f.write("config.local.json", { adapters, instances });
    expect(hubGitSync(["-C", f.root, "add", "-f", ".agenthub/config.local.json"], { encoding: "utf8" }).status).toBe(0);
    const tracked = readInstanceConfig(f.root);
    expect(tracked.adapters).toBeUndefined(); expect(tracked.instances).toBeUndefined();
    expect(tracked.ignored.join(" ")).toContain("committed");
  } finally { f.close(); }
});

test("project catalogs do not leak configured identities or instance defaults to another project", () => {
  const first = createProjectAdapterCatalog(adapters), second = createProjectAdapterCatalog();
  expect(instanceCatalog(instances, first).some(row => row.id === "fixture-check")).toBe(true);
  expect(instanceDefaultRoles(instances, true, first)["fixture-check"]).toEqual(["verifier"]);
  expect(effectiveInstanceRoles("fixture-check", validateInstances(instances, first), {}, first)).toEqual(["verifier"]);
  expect(second.definitionOf("fixture")).toBeUndefined();
  expect(() => validateInstances(instances, second)).toThrow();
  expect(() => createProjectAdapterCatalog({ codex: adapters.fixture })).toThrow();
  expect(() => validateInstances({ fixture: { kind: "fixture" } }, first)).toThrow();
});

test("read-only instance selection requires capability and cannot select a permission mode", () => {
  const catalog = createProjectAdapterCatalog(adapters);
  expect(validateInstances(instances, catalog)["fixture-check"]?.readOnly).toBe(true);
  expect(() => validateInstances({ "fixture-check": { ...instances["fixture-check"], permission_mode: "never-ask" } }, catalog)).toThrow();
  expect(() => validateInstances({ "codex-check": { kind: "codex", readOnly: true } }, catalog)).toThrow();
  expect(() => validateInstances({ "fixture-check": { kind: "fixture", readOnly: "true" } }, catalog)).toThrow();
  const { readOnly: _readOnly, ...withoutReadOnly } = adapters.fixture;
  const noCapability = createProjectAdapterCatalog({ fixture: withoutReadOnly });
  expect(() => validateInstances(instances, noCapability)).toThrow();
});

test("false read-only is not an instance permission ceiling", () => {
  const catalog = createProjectAdapterCatalog(adapters);
  const declarations = { "fixture-check": { kind: "fixture", readOnly: false, permission_mode: "ask" } };
  expect(validateInstances(declarations, catalog)["fixture-check"]?.readOnly).toBe(false);
  expect(() => validateRawConfig({ adapters, instances: declarations, permission_modes: { "fixture-check": "ask" } })).not.toThrow();
});

test("configured dynamic roster and peer settings validate against their captured catalog", () => {
  const config = { adapters, instances, roster: { fixture: true, "fixture-check": true }, peers: { fixture: { start_mode: "headless" }, "fixture-check": { start_mode: "headless" } } };
  expect(() => validateRawConfig(config)).not.toThrow();
  expect(() => validateRawConfig({ ...config, roster: { unknown: true } })).toThrow();
  expect(() => validateRawConfig({ ...config, peers: { fixture: { start_mode: "tui" } } })).toThrow();
  expect(() => validateRawConfig({ ...config, permission_modes: { "fixture-check": "never-ask" } })).toThrow();
  expect(configApply("adapters.fixture.command").applies).toBe("restart");
  expect(configApply("instances.fixture-check.readOnly").applies).toBe("restart");
});

test("strict source parsing compiles adapters before instances and refuses malformed local adapters", () => {
  expect(() => parseConfigSources(texts({ adapters, instances }))).not.toThrow();
  expect(() => parseConfigSources(texts({ adapters: { fixture: { transport: "acp" as const, command: [] } } }))).toThrow();
});

test("strict source parsing with provenance ignores tracked declarations before compilation", () => {
  const f = fixture();
  try {
    f.write("config.local.json", {});
    expect(hubGitSync(["-C", f.root, "add", "-f", ".agenthub/config.local.json"], { encoding: "utf8" }).status).toBe(0);
    expect(() => parseConfigSources(texts({ adapters: { broken: "PRIVATE-COMMAND" } }), undefined, f.root)).not.toThrow();
  } finally { f.close(); }
});

test("Grok foreground contract is enforced by strict config loading", () => {
  const declaration = { ...adapters.fixture, command: "grok", args: ["agent", "stdio"] };
  expect(() => parseConfigSources(texts({ adapters: { grok: declaration } }))).toThrow(/explicit --no-leader/);
  const foreground = { ...declaration, args: ["agent", "--no-leader", "stdio"] };
  expect(() => parseConfigSources(texts({ adapters: { grok: foreground } }))).not.toThrow();
  expect(() => parseConfigSources(texts({ adapters: { grok: { ...foreground, args: [...foreground.args, "--leader-socket=/tmp/leader.sock"] } } }))).toThrow(/attach\/leader/);
});

test("reload classification resolves configured and builtin extras only from bound declarations", () => {
  const catalog = createProjectAdapterCatalog(adapters), declared = validateInstances({ ...instances, "codex-worker": { kind: "codex", roles: ["verifier"] } }, catalog);
  expect(configApply("roster.fixture-check", [{ catalog, instances: declared }]).applies).toBe("live");
  expect(configApply("roster.codex-worker", [{ catalog, instances: declared }]).applies).toBe("live");
  for (const peer of ["fixture-ghost", "codex-ghost", "unknown"]) expect(() => configApply(`roster.${peer}`, [{ catalog, instances: declared }])).toThrow("unknown configuration key");
});


// #225: deleting a roster key whose instance was undeclared is a live change; adding or setting one is still an unknown key, and so is a
// key that never had the shape of an instance id.
test("only the removal of a stale instance roster key is classified, never its addition (#225)", () => {
  const catalog = createProjectAdapterCatalog(adapters), declared = validateInstances(instances, catalog), scope = { catalog, instances: declared };
  const before = { ...DEFAULT_CONFIG, adapters, instances, roster: { "codex-gone": true, "fixture-check": true } };
  const removal = configChanges(before, { ...before, roster: { "fixture-check": true } }, [scope]);
  expect(removal.map(row => [row.key, row.applies])).toEqual([["roster.codex-gone", "live"]]);
  expect(() => configChanges({ ...before, roster: { "fixture-check": true } }, before, [scope])).toThrow("unknown configuration key"); // adding it back
  expect(() => configChanges(before, { ...before, roster: { "codex-gone": false, "fixture-check": true } }, [scope])).toThrow("unknown configuration key"); // setting it
  expect(() => configChanges({ ...before, roster: { "fixture-check": true, "never-an-instance": true } }, { ...before, roster: { "fixture-check": true } }, [scope])).toThrow("unknown configuration key");
  expect(() => configApply("roster.codex-gone", [scope])).toThrow("unknown configuration key"); // the strict classifier itself is unchanged
  // A kind that declares no instance support (jcode) never had an instance, so its key is a typo, not a stale key.
  expect(() => configChanges({ ...before, roster: { "fixture-check": true, "jcode-worker": true } }, { ...before, roster: { "fixture-check": true } }, [scope])).toThrow("unknown configuration key");
});

test("reload diff classifies bound instance roster changes and retained restart declarations", () => {
  const declared = { ...instances, "codex-worker": { kind: "codex", roles: ["verifier"] } };
  const before = { ...DEFAULT_CONFIG, adapters, instances: declared, roster: { "fixture-check": true, "codex-worker": true } };
  const next = { ...before, roster: { "fixture-check": false, "codex-worker": false } };
  const scope = { catalog: createProjectAdapterCatalog(adapters), instances: validateInstances(declared, createProjectAdapterCatalog(adapters)) };
  expect(configChanges(before, next, [scope]).map(row => [row.key, row.applies])).toEqual([["roster.codex-worker", "live"], ["roster.fixture-check", "live"]]);
  const sources = parseConfigSources(texts({ adapters, instances: declared }));
  expect(configIdentityScope(sources.identity).catalog.definitionOf("fixture-check", sources.identity.instances)?.kind).toBe("fixture");
  // Scoped restart staging can remove an adapter while retaining its old declaration until the next startup.
  const staged = { ...next, adapters: {} };
  expect(() => configChanges(before, staged, [scope, configIdentityScope(sources.identity)])).not.toThrow();
  expect(() => configChanges(before, { ...next, roster: { "fixture-ghost": true } }, [scope])).toThrow("unknown configuration key");
});


test("scoped roster edits with a pending adapter role change preserve bound and removed identity classification", () => {
  const declared = { "fixture-check": { kind: "fixture", roles: ["verifier"] } };
  const runningScope = { catalog: createProjectAdapterCatalog(adapters), instances: validateInstances(declared, createProjectAdapterCatalog(adapters)) };
  const pendingAdapters = { fixture: { ...adapters.fixture, roles: ["verifier"] } };
  const sources = parseConfigSources(texts({ adapters: pendingAdapters, instances: declared, roster: { "fixture-check": false } }));
  const before = { ...DEFAULT_CONFIG, adapters, instances: declared, roster: { "fixture-check": true } };
  const next = { ...before, adapters: pendingAdapters, roster: { "fixture-check": false } };
  const changes = configChanges(before, next, [runningScope, configIdentityScope(sources.identity)]);
  expect(changes.find(row => row.key === "roster.fixture-check")).toMatchObject({ applies: "live", before: true, after: false });
  expect(changes.find(row => row.key === "adapters.fixture.roles")).toMatchObject({ applies: "restart" });
  const removed = { ...next, instances: {}, roster: {} };
  expect(configChanges(before, removed, [runningScope, configIdentityScope(sources.identity)]).find(row => row.key === "roster.fixture-check")).toMatchObject({ applies: "live", before: true, after: undefined });
});

test("captured configuration identity remains cloneable without native definition callbacks", () => {
  const sources = parseConfigSources(texts({ adapters, instances }));
  const cloned = structuredClone(sources);
  expect(configIdentityScope(cloned.identity).catalog.definitionOf("fixture-check", cloned.identity.instances)?.kind).toBe("fixture");
  expect(cloned.identity).toEqual({ adapters, instances });
});
