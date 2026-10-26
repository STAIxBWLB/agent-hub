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

test("#450 I2 permits only explicit headless native instances and retains the Claude ceiling; a Jcode instance needs its own home (#685)", () => {
  for (const kind of ["codex", "kimi", "qwen", "pi", "local"]) {
    const declarations = validateInstances({ [`${kind}-worker`]: { kind, start_mode: "headless", permission_mode: "never-ask" } }, builtinProjectCatalog());
    expect(kindOf(`${kind}-worker`, declarations)).toBe(kind);
  }
  expect(() => validateInstances({ "claude-review": { kind: "claude" } }, builtinProjectCatalog())).toThrow(/I2|headless|channel/);
  // #685: Jcode now declares instances, but only with a native home of its own (test/jcode-instances.test.ts).
  expect(() => validateInstances({ "jcode-worker": { kind: "jcode" } }, builtinProjectCatalog())).toThrow(/jcode_home/);
  expect(kindOf("jcode-worker", validateInstances({ "jcode-worker": { kind: "jcode", jcode_home: "/h/worker" } }, builtinProjectCatalog()))).toBe("jcode");
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

test("#844 a headless Claude implementer accepts one bounded model word; no other Claude or non-Jcode instance does", () => {
  const impl = { kind: "claude", roles: ["implementer"], start_mode: "headless", worktree: ".worktrees/claude-impl", permission_mode: "ask" };
  const parsed = validateInstances({ "claude-impl": { ...impl, model: "claude-sonnet-5-5" } }, builtinProjectCatalog());
  expect(parsed["claude-impl"]).toMatchObject({ kind: "claude", model: "claude-sonnet-5-5" });
  expect(Object.isFrozen(parsed["claude-impl"])).toBe(true);
  expect("model" in validateInstances({ "claude-impl": impl }, builtinProjectCatalog())["claude-impl"]!).toBe(false); // unset stays unset
  for (const model of ["", " ", "a b", "-flag", "x\ny", "a".repeat(129), 3, null, ["m"], { m: 1 }]) {
    expect(() => validateInstances({ "claude-impl": { ...impl, model } }, builtinProjectCatalog()), JSON.stringify(model)).toThrow(/claude-impl\.model/);
  }
  // A Claude instance that is not a headless implementer takes no model, and neither does a non-Jcode kind.
  expect(() => validateInstances({ "claude-review": { kind: "claude", roles: ["reviewer"], start_mode: "headless", model: "claude-sonnet-5-5" } }, builtinProjectCatalog())).toThrow(/model/);
  for (const kind of ["codex", "kimi", "qwen", "pi", "local"]) expect(() => validateInstances({ [`${kind}-worker`]: { kind, start_mode: "headless", model: "x" } }, builtinProjectCatalog()), kind).toThrow(/unsupported field/);
});
