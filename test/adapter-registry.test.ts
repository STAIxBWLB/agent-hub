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
    expect(definition.start.launch === undefined || typeof definition.start.launch === "function").toBe(true);
    expect(definition.start).not.toHaveProperty("ownsTerminal");
    expect(definition.permission).not.toHaveProperty("modes");
    expect(definition.permission).not.toHaveProperty("readOnly");
    expect(definition).not.toHaveProperty("init");
  }
  expect(r.definitionOf("qwen")).toMatchObject({ optional: true, defaultOnRoster: false, transport: "acp", roles: ["implementer", "verifier"], trust: { onPrem: false, hubSandboxed: false } });
  expect(r.definitionOf("qwen").start.forms).toEqual(["headless"]);
  expect(r.definitionOf("qwen").permission.readOnly).toBeUndefined();
  expect(r.definitionOf("agy")).toMatchObject({ optional: true, defaultOnRoster: false, transport: "ws-pull", roles: ["implementer", "verifier"], identity: { mcp: "channel-plugin" }, permission: { unmanagedForms: ["tui"] }, turnEnd: "native-hook" });
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
  expect(Object.isFrozen(qwen.permission.grants)).toBe(true);
  expect(() => qwen.roles.push("planner")).toThrow();
  expect(r.definitionOf("qwen").roles).toEqual(["implementer", "verifier"]);
});

test("Qwen's definition owns its headless refusal and rejects another transport's factory ports", async () => {
  const r = await registry(), qwen = r.definitionOf("qwen");
  expect(qwen.start.preflight({ instance: "qwen", form: "tui" })).toBe("Qwen TUI is not offered before its native verification; use ahub qwen --mode headless");
  expect(qwen.start.preflight({ instance: "qwen", form: "headless" })).toBeUndefined();
  expect(() => qwen.start.create({ instance: "qwen", projectRoot: "/fixture", stateDir: "/fixture/state", kindConfig: {}, permission: "ask", mcpServers: [], daemon: { local: {} } })).toThrow("ACP");
});

test("#625 follow-up runtime launch plans exist only for the verified native launch surfaces", async () => {
  const r = await registry();
  expect(r.ADAPTERS.filter((definition: any) => typeof definition.start.launch === "function").map((definition: any) => definition.kind).sort()).toEqual(["agy", "claude", "codex", "qwen"]);
});

test("#625 follow-up malformed channel-plugin ACP definitions require explicit external admission", async () => {
  const r = await registry();
  const original = r.ADAPTERS.find((definition: any) => definition.transport === "acp" && definition.start.daemonPort === "acp");
  const malformed = { ...original, identity: { mcp: "channel-plugin" }, attach: { ...original.attach, externalHello: false } };
  expect(() => r.assertDefinitionCoherence(malformed)).toThrow(/channel-plugin|externalHello|external.*admission/);
});

test("#625 phase5 preserves every observable native projection order", async () => {
  const r = await registry();
  expect(r.KNOWN_PEERS).toEqual(["claude", "codex", "kimi", "pi", "local"]);
  expect(r.OPTIONAL_PEERS).toEqual(["qwen", "jcode", "agy"]);
  // Legacy start settings put Pi first, independently of the native catalog order.
  expect(r.START_MODE_PEERS).toEqual(["pi", "codex", "kimi", "jcode"]);
  // Legacy role-map display places the local worker before Pi.
  expect(Object.keys(r.defaultPeerRoles(true))).toEqual(["claude", "codex", "kimi", "local", "pi", "qwen", "jcode", "agy"]);
  // Planner eligibility includes configurable cloud candidates without granting them default planner roles.
  expect(r.PLANNER_PEERS).toEqual(["claude", "codex", "kimi", "qwen", "jcode"]);
  const { HELP } = await import("../src/cli/help.ts");
  // Legacy help groups optional terminal clients before headless-only and local entries.
  expect(HELP.filter(entry => entry.section === "Agents").flatMap(entry => /^ahub (claude|codex|kimi|pi|local|qwen|jcode|agy) /.exec(entry.usage)?.[1] ?? [])).toEqual(["claude", "codex", "kimi", "jcode", "agy", "qwen", "pi", "local"]);
});

test("#625 phase5 a fake definition joins lists and rendered help without another native roster", async () => {
  const r = await registry();
  const fake = { ...r.definitionOf("qwen"), kind: "fixture-kind", family: "fixture-kind", optional: false, roles: ["planner"], projection: { plannerEligible: true },
    start: { ...r.definitionOf("qwen").start, forms: ["tui", "headless"], defaultForm: "tui" },
    cli: { command: "fixture-kind", startWords: () => ["fixture-kind"], usage: [["ahub fixture-kind [--print-command]", "fixture definition usage"]] } };
  const definitions = [...r.ADAPTERS, fake];
  // The old projection deliberately ignores this input, demonstrating the missing derived behavior.
  const derive = r.deriveAdapterLists ?? (() => r);
  const lists = derive(definitions);
  expect(lists.KNOWN_PEERS.at(-1)).toBe("fixture-kind");
  expect(lists.START_MODE_PEERS.at(-1)).toBe("fixture-kind");
  expect(lists.PLANNER_PEERS.at(-1)).toBe("fixture-kind");
  expect(lists.ROLE_ORDER.at(-1)).toBe("fixture-kind");
  expect(lists.HELP_ORDER.at(-1)).toBe("fixture-kind");
  const optional = derive([...r.ADAPTERS, { ...fake, optional: true }]);
  expect(optional.OPTIONAL_PEERS.at(-1)).toBe("fixture-kind");
  expect(optional.KNOWN_PEERS).not.toContain("fixture-kind");
  const { renderHelp } = await import("../src/cli/help.ts");
  const text = Reflect.apply(renderHelp, undefined, [100, false, "fixture-kind", definitions]);
  expect(text).toContain("ahub fixture-kind [--print-command]");
  expect(text).toContain("fixture definition usage");
  expect(r.ADAPTERS.some((definition: any) => definition.kind === "fixture-kind")).toBe(false);
});


test("#625 phase5 builtin CLI ports retain their existing policy and exact help strings", async () => {
  const r = await registry();
  const { HELP } = await import("../src/cli/help.ts");
  const agents = HELP.filter(entry => entry.section === "Agents");
  for (const definition of r.ADAPTERS) {
    expect(typeof definition.cli.entry?.execute).toBe("function");
    expect(definition.cli.entry.lifecycleAdmission).toBe(!["pi", "local"].includes(definition.kind));
    for (const [usage, description] of definition.cli.usage) {
      expect(agents.find(entry => entry.usage === usage)?.description).toBe(description);
    }
  }
  expect(r.ADAPTERS.filter((definition: any) => definition.cli.preview).map((definition: any) => definition.kind)).toEqual(["claude", "codex", "kimi", "pi", "qwen", "jcode"]);
});

test("#625 phase5 config-only definitions cannot register trusted builtin CLI ports", async () => {
  const r = await registry();
  const generic = r.createProjectAdapterCatalog({ fixture: { transport: "acp", command: "fixture-not-executed", args: [], displayName: "Fixture", roles: ["implementer"] } }).definitionOf("fixture");
  for (const field of ["entry", "preview", "usage"]) {
    const value = r.definitionOf("claude").cli[field];
    expect(() => r.assertNativeCapabilityScope({ ...generic, cli: { ...generic.cli, [field]: value } })).toThrow(`cli.${field}`);
  }
});

test("#625 phase5 a fake definition renders its own usage through ahub help", async () => {
  const r = await registry();
  const fake = { ...r.definitionOf("qwen"), kind: "fixture-kind", projection: { plannerEligible: true }, cli: { command: "fixture-kind", startWords: () => ["fixture-kind"], usage: [["ahub fixture-kind [--print-command]", "fixture definition usage"]] } };
  const { renderHelp } = await import("../src/cli/help.ts");
  const text = Reflect.apply(renderHelp, undefined, [100, false, "fixture-kind", [...r.ADAPTERS, fake]]);
  expect(text).toContain("ahub fixture-kind [--print-command]");
  expect(text).toContain("fixture definition usage");
});


test("#625 phase5 projection metadata is unavailable to configured and external adapters", async () => {
  const r = await registry();
  const raw = { transport: "acp", command: "fixture-not-executed", args: [], displayName: "Fixture", roles: ["planner"] };
  expect(() => r.createProjectAdapterCatalog({ fixture: { ...raw, projection: { plannerEligible: true } } })).toThrow();
  const generic = r.createProjectAdapterCatalog({ fixture: raw }).definitionOf("fixture");
  expect(r.deriveAdapterLists([generic]).PLANNER_PEERS).toEqual([]);
  expect(() => r.assertNativeCapabilityScope({ ...generic, projection: { plannerEligible: true } })).toThrow("projection");
  const { validateExternalDefinition } = await import("../src/adapters/external-modules.ts");
  expect(() => validateExternalDefinition({ ...generic, projection: { plannerEligible: true } })).toThrow();
});
