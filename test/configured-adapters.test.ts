import { expect, test } from "bun:test";
import { createProjectAdapterCatalog, definitionOf, ADAPTERS } from "../src/adapters/registry.ts";

const config = () => ({ transport: "acp", command: "fixture-agent", args: ["stdio"], displayName: "Fixture ACP", roles: ["implementer", "verifier"] });

test("configured ACP catalogs are project-local, immutable and leave builtins untouched", () => {
  const raw = { fixture: config() }, a = createProjectAdapterCatalog(raw), b = createProjectAdapterCatalog();
  raw.fixture.args.push("changed");
  expect(a.kindOf("fixture")).toBe("fixture"); expect(a.familyOf("fixture")).toBe("fixture");
  expect(b.definitionOf("fixture")).toBeUndefined(); expect(definitionOf("fixture")).toBeUndefined();
  expect(a.definitions.slice(0, ADAPTERS.length)).toEqual([...ADAPTERS]);
  expect(Object.isFrozen(a)).toBe(true); expect(Object.isFrozen(a.definitions)).toBe(true);
  const d = a.definitionOf("fixture")!;
  expect(Object.isFrozen(d)).toBe(true); expect(Object.isFrozen(d.roles)).toBe(true);
  expect(d).toMatchObject({ optional: true, defaultOnRoster: false, trust: { onPrem: false, hubSandboxed: false }, start: { forms: ["headless"] } });
  expect(d.budget).toBeUndefined(); expect(d.reviewer).toBeUndefined(); expect(d.hooks).toBeUndefined();
  const plan = d.start.launch!({ instance: "fixture", form: "headless", projectRoot: "/fixture", stateDir: "/state", entrypoint: "/cli", userArgs: [], unattended: false, env: {} });
  expect([plan.cmd, ...plan.args]).toEqual(["fixture-agent", "stdio"]);
});

test("configured ACP instances require explicit valid declarations and preserve builtin reviewer resolution", () => {
  const a = createProjectAdapterCatalog({ fixture: config() });
  expect(a.definitionOf("fixture-one")).toBeUndefined();
  expect(a.kindOf("fixture-one", { "fixture-one": { kind: "fixture" } })).toBe("fixture");
  expect(a.familyOf("fixture-one", { "fixture-one": { kind: "fixture" } })).toBe("fixture");
  expect(a.isSupportedPeer("fixture-one", { "fixture-one": { kind: "fixture" } })).toBe(true);
  expect(a.definitionOf("foreign-one", { "foreign-one": { kind: "fixture" } })).toBeUndefined();
  const declarations = { "codex-review": { kind: "codex", roles: ["reviewer"], start_mode: "headless" as const } };
  expect(a.definitionOf("codex-review", declarations)).toBe(definitionOf("codex-review", declarations));
  let accessed = false;
  expect(a.definitionOf("fixture-one", Object.defineProperty({}, "fixture-one", { enumerable: true, get() { accessed = true; return { kind: "fixture" }; } }))).toBeUndefined();
  expect(accessed).toBe(false);
});

for (const kind of ["claude", "codex", "user", "hub", "digest", "bad_kind", "Constructor", "constructor", "__proto__"]) test(`configured ACP refuses collision or invalid kind ${kind}`, () => {
  expect(() => createProjectAdapterCatalog(Object.fromEntries([[kind, config()]]))).toThrow();
});
for (const field of ["trust", "budget", "routing", "hooks", "reviewer", "attach", "start", "family", "api"]) test(`configured ACP refuses privileged field ${field}`, () => {
  expect(() => createProjectAdapterCatalog({ fixture: { ...config(), [field]: {} } })).toThrow();
});
for (const change of [{ command: "bad\ncommand" }, { args: ["bad\0arg"] }, { displayName: "bad\rname" }, { roles: ["invented"] }, { roles: ["implementer", "implementer"] }, { identity: { name: "native" } }, { permission: { unknown: "mode" } }, { permission: { ask: "" } }, { readOnly: "" }, { transport: "ws-pull" }]) test(`configured ACP validates bounded fields ${JSON.stringify(change)}`, () => {
  expect(() => createProjectAdapterCatalog({ fixture: { ...config(), ...change } })).toThrow();
});

test("configured ACP validation never invokes caller accessors or proxies", () => {
  let accessed = false;
  const bad = Object.defineProperty({}, "fixture", { enumerable: true, get() { accessed = true; return config(); } });
  expect(() => createProjectAdapterCatalog(bad)).toThrow();
  expect(() => createProjectAdapterCatalog(new Proxy({}, { ownKeys() { accessed = true; return []; } }))).toThrow();
  expect(accessed).toBe(false);
  expect(() => createProjectAdapterCatalog({ fixture: { ...config(), command: "x".repeat(4097) } })).toThrow();
  expect(() => createProjectAdapterCatalog({ fixture: { ...config(), args: Array(129).fill("arg") } })).toThrow();
});

test("configured ACP factory binds identity, load echo and native policy without native startup", () => {
  const d = createProjectAdapterCatalog({ fixture: { ...config(), identity: { name: "Fixture", version: "1" }, permission: { ask: "safe" }, readOnly: "plan" } }).definitionOf("fixture")!;
  const peer = d.start.create!({ instance: "fixture", projectRoot: "/fixture", stateDir: "/state", kindConfig: {}, permission: "read-only", mcpServers: [], daemon: { acp: { cwd: "/fixture", cmd: ["wrong"], qwen025: true } } });
  const opts = (peer as any).opts;
  expect(opts).toMatchObject({ kind: "fixture", cmd: ["fixture-agent", "stdio"], expectedAgent: { name: "Fixture", version: "1" }, requireLoadSessionEcho: true, requireOwnedGroup: true, nativePolicy: { modes: { ask: "safe" }, readOnly: "plan", lockedReadOnly: true } });
  expect(opts.qwen025).toBe(false);
  expect(d.permission.genericAcp).toEqual({ modes: { ask: "safe" }, readOnly: "plan" });
  const unmanaged = createProjectAdapterCatalog({ fixture: config() }).definitionOf("fixture")!;
  expect(unmanaged.permission.unmanaged).toBeDefined();
  expect(() => unmanaged.start.create!({ instance: "fixture", projectRoot: "/fixture", stateDir: "/state", kindConfig: {}, permission: "read-only", mcpServers: [], daemon: { acp: { cwd: "/fixture", cmd: [] } } })).toThrow(/read-only/);
});

for (const selector of ["--leader", "--leader=other", "--attach", "--connect=localhost", "--remote"]) test(`configured ACP refuses attachment selector ${selector}`, () => {
  expect(() => createProjectAdapterCatalog({ fixture: { ...config(), args: [selector] } })).toThrow(/foreground|attach|leader/);
});
test("configured ACP identity is optional configuration but required for runtime start", () => {
  const d = createProjectAdapterCatalog({ fixture: config() }).definitionOf("fixture")!;
  expect(d.start.preflight!({ instance: "fixture", form: "headless" })).toMatch(/identity.*unverified/);
  const verified = createProjectAdapterCatalog({ fixture: { ...config(), identity: { name: "Fixture", version: "1" } } }).definitionOf("fixture")!;
  expect(verified.start.preflight!({ instance: "fixture", form: "headless" })).toBeUndefined();
  expect(verified.start.preflight!({ instance: "fixture", form: "tui" })).toMatch(/headless/);
});
