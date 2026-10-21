import { createProjectAdapterCatalog as builtinProjectCatalog } from "../src/adapters/registry.ts";
import { expect, test } from "bun:test";
import { ADAPTERS, defaultPeerRoles, kindOf, definitionOf, familyOf } from "../src/adapters/registry.ts";
import { validateInstances, instanceCatalog, instancePeerIds, instanceDefaultRoles } from "../src/hub/instances.ts";

test("#450 instance resolution is explicit, project-local and preserves all legacy ids", () => {
  const a = validateInstances({ "codex-worker": { kind: "codex" } }, builtinProjectCatalog()), b = validateInstances({ "kimi-worker": { kind: "kimi" } }, builtinProjectCatalog());
  for (const definition of ADAPTERS) {
    expect(kindOf(definition.kind)).toBe(definition.kind);
    expect(definitionOf(definition.kind)).toBe(definition);
    expect(familyOf(definition.kind)).toBe(definition.family);
  }
  expect(kindOf("codex-worker")).toBeUndefined();
  expect(kindOf("codex-worker", a)).toBe("codex");
  expect(definitionOf("codex-worker", a)).toBe(definitionOf("codex"));
  expect(familyOf("codex-worker", a)).toBe(familyOf("codex"));
  expect(kindOf("codex-worker", b)).toBeUndefined();
  expect(kindOf("codex-worker")).toBeUndefined();
  expect(kindOf("codex-undeclared", a)).toBeUndefined();
  expect(kindOf("codex", { codex: { kind: "kimi" } })).toBe("codex");
  expect(kindOf("unprefixed", { unprefixed: { kind: "codex" } })).toBeUndefined();
});

test("#450 declarations are cloned and immutable without materializing optional defaults", () => {
  const source = { "codex-worker": { kind: "codex", roles: ["implementer", "verifier"], start_mode: "headless", permission_mode: "ask", worktree: ".worktrees/codex-worker" } };
  const parsed = validateInstances(source, builtinProjectCatalog());
  source["codex-worker"].roles.push("reviewer"); source["codex-worker"].worktree = ".worktrees/elsewhere";
  expect(parsed["codex-worker"]?.roles).toEqual(["implementer", "verifier"]);
  expect(parsed["codex-worker"]?.worktree).toBe(".worktrees/codex-worker");
  expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed["codex-worker"])).toBe(true); expect(Object.isFrozen(parsed["codex-worker"]?.roles)).toBe(true);
  expect(Object.keys(validateInstances(undefined, builtinProjectCatalog()))).toEqual([]);
  expect(validateInstances({ "local-reader": { kind: "local", roles: [] } }, builtinProjectCatalog())["local-reader"]).toEqual({ kind: "local", roles: [] });
});

test("#450 malformed declarations, builtin/reserved collisions and unsupported fields refuse", () => {
  for (const raw of [null, [], "invalid", 3,
    { codex: { kind: "codex" } }, { user: { kind: "codex" } }, { hub: { kind: "codex" } }, { digest: { kind: "codex" } },
    { "codex-": { kind: "codex" } }, { "codex worker": { kind: "codex" } }, { ["codex-" + "x".repeat(27)]: { kind: "codex" } },
    { "codex-worker": { kind: "unknown" } }, { "codex-worker": { kind: "kimi" } },
    { "codex-worker": { kind: "codex", roles: "implementer" } }, { "codex-worker": { kind: "codex", roles: ["unknown"] } },
    { "codex-worker": { kind: "codex", roles: ["implementer", "implementer"] } },
    { "codex-worker": { kind: "codex", start_mode: "tui" } }, { "codex-worker": { kind: "codex", start_mode: "auto" } },
    { "codex-worker": { kind: "codex", permission_mode: "automatic" } },
    { "codex-worker": { kind: "codex", worktree: 4 } }, { "codex-worker": { kind: "codex", worktree: "" } },
    { "codex-worker": { kind: "codex", worktree: "bad\npath" } }, { "codex-worker": { kind: "codex", enabled: true } },
  ]) expect(() => validateInstances(raw, builtinProjectCatalog())).toThrow();
});

test("#450 prototype, getter and proxy declarations never execute caller code", () => {
  let executed = 0;
  const getter = Object.defineProperty({}, "codex-worker", { enumerable: true, get() { executed++; return { kind: "codex" }; } });
  const field = Object.defineProperty({ kind: "codex" }, "roles", { enumerable: true, get() { executed++; return ["implementer"]; } });
  const roles = Object.defineProperty(["implementer"], "0", { enumerable: true, get() { executed++; return "implementer"; } });
  const proxy = new Proxy({}, { ownKeys() { executed++; return []; } });
  const hidden = Object.defineProperty({}, "codex-worker", { value: { kind: "codex" } });
  for (const raw of [getter, { "codex-worker": field }, { "codex-worker": { kind: "codex", roles } }, proxy, hidden,
    Object.create({ "codex-worker": { kind: "codex" } }), { "codex-worker": Object.create({ kind: "codex" }) },
    JSON.parse('{"__proto__":{"kind":"codex"}}'), { [Symbol("hidden")]: { kind: "codex" } },
  ]) expect(() => validateInstances(raw, builtinProjectCatalog())).toThrow();
  expect(kindOf("codex-worker", getter as never)).toBeUndefined();
  expect(kindOf("codex-worker", Object.create({ "codex-worker": { kind: "codex" } }))).toBeUndefined();
  expect(executed).toBe(0);
  const nullPrototype = Object.assign(Object.create(null), { "codex-worker": Object.assign(Object.create(null), { kind: "codex" }) });
  expect(validateInstances(nullPrototype, builtinProjectCatalog())["codex-worker"]?.kind).toBe("codex");
});

test("#450 I2 permits only explicit headless native instances and retains the Claude/Jcode ceilings", () => {
  for (const kind of ["codex", "kimi", "qwen", "pi", "local"]) {
    const declarations = validateInstances({ [`${kind}-worker`]: { kind, start_mode: "headless", permission_mode: "never-ask" } }, builtinProjectCatalog());
    expect(kindOf(`${kind}-worker`, declarations)).toBe(kind);
  }
  expect(() => validateInstances({ "claude-review": { kind: "claude" } }, builtinProjectCatalog())).toThrow(/I2|headless|channel/);
  expect(() => validateInstances({ "jcode-worker": { kind: "jcode" } }, builtinProjectCatalog())).toThrow(/I2|project.file|unsupported/);
});

test("#450 catalog and role projections preserve builtin order and isolate caller-owned arrays", () => {
  const declarations = validateInstances({ "codex-worker": { kind: "codex", roles: ["verifier"] }, "local-reader": { kind: "local" } }, builtinProjectCatalog());
  const ids = ADAPTERS.map(definition => definition.kind);
  expect(instancePeerIds(undefined, builtinProjectCatalog())).toEqual(ids);
  expect(instancePeerIds(declarations, builtinProjectCatalog())).toEqual([...ids, "codex-worker", "local-reader"]);
  const catalog = instanceCatalog(declarations, builtinProjectCatalog());
  expect(catalog.find(entry => entry.id === "codex-worker")?.definition).toBe(definitionOf("codex"));
  expect(instanceDefaultRoles(undefined, true, builtinProjectCatalog())).toEqual(defaultPeerRoles(true));
  const roles = instanceDefaultRoles(declarations, true, builtinProjectCatalog());
  expect(roles["codex-worker"]).toEqual(["verifier"]);
  expect(roles["local-reader"]).toEqual([...definitionOf("local")!.roles]);
  roles["local-reader"]!.push("conductor");
  expect(instanceDefaultRoles(declarations, true, builtinProjectCatalog())["local-reader"]).not.toContain("conductor");
});
