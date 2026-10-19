import { expect, test } from "bun:test";

async function registry(): Promise<any> {
  const path = "../src/adapters/registry.ts";
  const result = await import(path).catch(() => undefined);
  expect(typeof result?.kindOf).toBe("function");
  return result;
}

test("adapter registry keeps the existing native order, defaults and permissions without starting an owner", async () => {
  const r = await registry();
  expect(r.ADAPTER_API).toBe(1);
  expect(r.ADAPTERS.map((definition: any) => definition.kind)).toEqual(["claude", "codex", "kimi", "pi", "local", "qwen", "jcode", "agy"]);
  for (const definition of r.ADAPTERS) {
    expect(definition.api).toBe(1);
    expect(definition.family).toBe(definition.kind);
    expect(definition.start.forms).toContain(definition.start.defaultForm);
    expect(r.definitionOf(definition.kind)).toBe(definition);
    expect(r.kindOf(definition.kind)).toBe(definition.kind);
    expect(r.familyOf(definition.kind)).toBe(definition.kind);
    expect(typeof definition.start.launch).toBe("function");
  }
  expect(r.definitionOf("qwen")).toMatchObject({ optional: true, defaultOnRoster: false, transport: "acp", roles: ["implementer", "verifier"], trust: { onPrem: false, hubSandboxed: false } });
  expect(r.definitionOf("qwen").start.forms).toEqual(["headless"]);
  expect(r.definitionOf("qwen").start.ownsTerminal("headless")).toBe(false);
  expect(r.definitionOf("qwen").permission.modes).toEqual({ ask: { kind: "acp-mode", modeId: "default" }, "ask-when-needed": { kind: "acp-mode", modeId: "auto-edit" }, "never-ask": { kind: "acp-mode", modeId: "yolo" } });
  expect(r.definitionOf("qwen").permission.readOnly).toBeUndefined();
  expect(r.definitionOf("agy")).toMatchObject({ optional: true, defaultOnRoster: false, transport: "ws-pull", roles: ["implementer", "verifier"], identity: { mcp: "channel-plugin" }, permission: { modes: {}, unmanagedForms: ["tui"] }, turnEnd: "native-hook" });
  expect(r.definitionOf("agy").start.forms).toEqual(["tui"]);
  expect(r.definitionOf("agy").session.recoveryRefusal()).toContain("continuity and resume are unavailable");
  expect(r.definitionOf("agy").reviewerVariant.reviewer.unavailable).toBe("agy is an implementer peer (#485)");
});

test("adapter lookup never guesses undeclared instance suffixes or reserved core ids", async () => {
  const r = await registry();
  for (const id of ["", "user", "hub", "digest", "Codex", "external", "codex-2", "qwen-review", "codex-", "codex-../../other"]) {
    expect(r.kindOf(id)).toBeUndefined();
    expect(r.definitionOf(id)).toBeUndefined();
    expect(r.familyOf(id)).toBeUndefined();
  }
});

test("registry policy data is immutable across projects", async () => {
  const r = await registry(), qwen = r.definitionOf("qwen");
  expect(Object.isFrozen(r.ADAPTERS)).toBe(true);
  expect(Object.isFrozen(qwen)).toBe(true);
  expect(Object.isFrozen(qwen.roles)).toBe(true);
  expect(Object.isFrozen(qwen.permission.modes)).toBe(true);
  expect(() => qwen.roles.push("planner")).toThrow();
  expect(r.definitionOf("qwen").roles).toEqual(["implementer", "verifier"]);
});

test("Qwen's definition owns its headless refusal and rejects another transport's factory ports", async () => {
  const r = await registry(), qwen = r.definitionOf("qwen");
  expect(qwen.start.preflight({ instance: "qwen", form: "tui" })).toBe("Qwen TUI is not offered before its native verification; use ahub qwen --mode headless");
  expect(qwen.start.preflight({ instance: "qwen", form: "headless" })).toBeUndefined();
  expect(() => qwen.start.create({ instance: "qwen", projectRoot: "/fixture", stateDir: "/fixture/state", kindConfig: {}, permission: "ask", mcpServers: [], daemon: { local: {} } })).toThrow("ACP");
});
