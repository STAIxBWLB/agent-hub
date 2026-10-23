import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { ADAPTERS, type AdapterDefinition } from "../../src/adapters/registry.ts";

const enrollment = () => import("./enrollment.ts");
const primary = () => ADAPTERS.filter(definition => definition.kind !== "agy").map(definition => definition.kind);

test("#451 conformance constructs driven peers through registered factories, never direct concrete constructors", () => {
  for (const file of readdirSync(new URL(".", import.meta.url)).filter(name => name.endsWith(".test.ts"))) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(source, file).not.toMatch(/\bnew\s+(?:AcpPeer|CodexPeer|JcodePeer|PiPeer|LocalPeer|WatchdogAcp|WatchdogCodex|WatchdogLocal)\s*\(/);
  }
});

test("#451 registry enrollment includes every kind and gives reviewer variants distinct identities", async () => {
  const { assertEnrollment, definitionIdentities, UNSUPPORTED } = await enrollment();
  expect(() => assertEnrollment(ADAPTERS, primary(), UNSUPPORTED)).not.toThrow();
  const rows = definitionIdentities(ADAPTERS);
  expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
  for (const definition of ADAPTERS) {
    expect(rows.some(row => row.id === definition.kind && row.definition === definition)).toBe(true);
    if (definition.headlessVariant) expect(rows.some(row => row.id === `${definition.kind}:implementer` && row.definition === definition.headlessVariant)).toBe(true);
    if (definition.reviewerVariant) expect(rows.some(row => row.id === `${definition.kind}:reviewer` && row.definition === definition.reviewerVariant)).toBe(true);
  }
});

test("#451 deleting agy's unsupported reason fails enrollment instead of silently skipping its contract", async () => {
  const { assertEnrollment, UNSUPPORTED } = await enrollment();
  const reasons = { ...UNSUPPORTED }; delete reasons.agy;
  expect(() => assertEnrollment(ADAPTERS, primary(), reasons)).toThrow(/agy/);
});

test("#451 removing a fixture enrollment fails the registry guard", async () => {
  const { assertEnrollment, UNSUPPORTED } = await enrollment();
  expect(() => assertEnrollment(ADAPTERS, primary().filter(kind => kind !== "codex"), UNSUPPORTED)).toThrow(/codex/);
});

test("#451 a fake ACP kind cannot silently join without its conformance fixture and ACP legs", async () => {
  const { assertEnrollment, UNSUPPORTED } = await enrollment();
  const fake: AdapterDefinition = { ...ADAPTERS.find(definition => definition.transport === "acp")!, kind: "fake-unenrolled", reviewerVariant: undefined };
  expect(() => assertEnrollment([...ADAPTERS, fake], primary(), UNSUPPORTED)).toThrow(/fake-unenrolled/);
  expect(() => assertEnrollment([...ADAPTERS, fake], primary(), { ...UNSUPPORTED, "fake-unenrolled": "not implemented" })).toThrow(/ACP|acp/);
});

test("#451 a removed registry kind leaves an invalid stale conformance enrollment", async () => {
  const { assertEnrollment, UNSUPPORTED } = await enrollment();
  expect(() => assertEnrollment(ADAPTERS.filter(definition => definition.kind !== "codex"), primary(), UNSUPPORTED)).toThrow(/codex/);
});

test("#451 native-hook completion requires the Claude transport or a native facts hook", async () => {
  const { assertEnrollment, UNSUPPORTED } = await enrollment();
  const broken = ADAPTERS.map(definition => definition.kind === "codex" ? { ...definition, turnEnd: "native-hook" as const, hooks: undefined } : definition);
  expect(() => assertEnrollment(broken, primary(), UNSUPPORTED)).toThrow(/codex.*native-hook/);
});

test("#451 coherence checks reviewer variants rather than only the top-level definitions", async () => {
  const { assertEnrollment, UNSUPPORTED } = await enrollment();
  const broken = ADAPTERS.map(definition => definition.kind === "codex" ? {
    ...definition, reviewerVariant: { ...definition.reviewerVariant!, turnEnd: "native-hook" as const, hooks: undefined },
  } : definition);
  expect(() => assertEnrollment(broken, primary(), UNSUPPORTED)).toThrow(/codex:reviewer.*native-hook/);
});

test("#451 unsupported entries require a concrete nonempty reason and cannot hide an enrolled fixture", async () => {
  const { assertEnrollment, UNSUPPORTED } = await enrollment();
  expect(() => assertEnrollment(ADAPTERS, primary(), { ...UNSUPPORTED, agy: "  " })).toThrow(/agy/);
  expect(() => assertEnrollment(ADAPTERS, [...primary(), "agy"], UNSUPPORTED)).toThrow(/agy/);
});


test("#451 fixture creation invokes the selected definition factory with its exact daemon port", async () => {
  const { createFromDefinition } = await import("./factories.ts");
  const original = ADAPTERS.find(definition => definition.kind === "codex")!;
  const calls: any[] = [];
  const peer = { id: "codex", state: "offline" as const, start: async () => {}, stop: async () => {}, deliver: async () => {} };
  const definition: AdapterDefinition = { ...original, start: { ...original.start, create: context => { calls.push(context); return peer; } } };
  const daemon = { codex: { cwd: "/tmp/conformance-factory-only", appPort: 0, proxyPort: 0 } };
  expect(createFromDefinition(definition, daemon)).toBe(peer);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ instance: "codex", projectRoot: daemon.codex.cwd, permission: "ask" });
  expect(calls[0].daemon).toBe(daemon);
});

const coherence = async () => (await import("../../src/adapters/registry.ts")).assertDefinitionCoherence;
const drivenDefinition = () => ADAPTERS.find(definition => definition.start.create && !definition.reviewer)!;

test("#625 registry coherence accepts current definitions and all distinct reviewer variants", async () => {
  const validate = await coherence(), { definitionIdentities } = await enrollment();
  for (const { definition } of definitionIdentities(ADAPTERS)) expect(() => validate(definition)).not.toThrow();
});

test("#625 pull-only forms must be supported by that definition", async () => {
  const validate = await coherence(), original = ADAPTERS.find(definition => definition.transport === "ws-pull")!;
  const broken: AdapterDefinition = { ...original, attach: { ...original.attach, pullOnlyForms: ["headless"] } };
  expect(() => validate(broken)).toThrow(/pullOnlyForms|supported.*form/);
});

test("#625 a native admission policy needs a supported pull-only TUI form", async () => {
  const validate = await coherence(), original = ADAPTERS.find(definition => definition.attach?.admission)!;
  const broken: AdapterDefinition = { ...original, attach: { ...original.attach, pullOnlyForms: undefined } };
  expect(() => validate(broken)).toThrow(/admission/);
});

for (const field of ["reservedRefusal", "watchRefusal"] as const) test(`#625 admission ${field} must give a nonempty refusal reason`, async () => {
  const validate = await coherence(), original = ADAPTERS.find(definition => definition.attach?.admission)!;
  const broken: AdapterDefinition = { ...original, attach: { ...original.attach, admission: { ...original.attach!.admission!, [field]: "  " } } };
  expect(() => validate(broken)).toThrow(new RegExp(field));
});

for (const transport of ["ws-pull", "claude-channel"] as const) test(`#625 ${transport} transport requires explicit external hello admission`, async () => {
  const validate = await coherence(), original = ADAPTERS.find(definition => definition.transport === transport)!;
  const broken: AdapterDefinition = { ...original, attach: { ...original.attach, externalHello: false } };
  expect(() => validate(broken)).toThrow(/externalHello/);
});

test("#625 external instance admission requires its explicit hello policy", async () => {
  const validate = await coherence(), original = drivenDefinition();
  const broken: AdapterDefinition = { ...original, instances: { mode: "external" }, attach: { externalHello: false } };
  expect(() => validate(broken)).toThrow(/externalHello/);
});

test("#625 a ws-pull transport cannot advertise an empty pull-only contract", async () => {
  const validate = await coherence(), original = ADAPTERS.find(definition => definition.transport === "ws-pull")!;
  const broken: AdapterDefinition = { ...original, attach: { ...original.attach, pullOnlyForms: [] } };
  expect(() => validate(broken)).toThrow(/pullOnlyForms|pull-only/);
});

for (const account of ["", "  ", undefined, false]) test(`#625 declared quota account must be a nonempty string (${String(account)})`, async () => {
  const validate = await coherence();
  const broken = { ...drivenDefinition(), budget: { account } } as unknown as AdapterDefinition;
  expect(() => validate(broken)).toThrow(/account/);
});

for (const reader of ["reader", "context"] as const) {
  test(`#625 ${reader} telemetry needs a nonempty declared source`, async () => {
    const validate = await coherence();
    const broken = { ...drivenDefinition(), budget: { account: "fixture", [reader]: { source: "  ", read: () => { throw new Error("never invoke a telemetry reader during load"); } } } } as unknown as AdapterDefinition;
    expect(() => validate(broken)).toThrow(/source/);
  });
  test(`#625 ${reader} telemetry needs a callable reader`, async () => {
    const validate = await coherence();
    const broken = { ...drivenDefinition(), budget: { account: "fixture", [reader]: { source: "fixture-source", read: false } } } as unknown as AdapterDefinition;
    expect(() => validate(broken)).toThrow(/read/);
  });
  test(`#625 ${reader} telemetry rejects a null declaration`, async () => {
    const validate = await coherence();
    const broken = { ...drivenDefinition(), budget: { account: "fixture", [reader]: null } } as unknown as AdapterDefinition;
    expect(() => validate(broken)).toThrow(/reader|context/);
  });
}

test("#625 absent telemetry readers stay valid and imply no fabricated source", async () => {
  const validate = await coherence(), original = drivenDefinition();
  expect(() => validate({ ...original, budget: undefined })).not.toThrow();
  expect(() => validate({ ...original, budget: { account: "fixture" } })).not.toThrow();
  expect(() => validate({ ...original, attach: { pullOnlyForms: [] }, budget: { account: "fixture" } })).not.toThrow();
});

test("#625 coherence validates telemetry structure without invoking native readers", async () => {
  const validate = await coherence(), original = drivenDefinition();
  const read = () => { throw new Error("reader executed during registry load"); };
  const definition: AdapterDefinition = { ...original, budget: { account: "fixture", reader: { source: "fixture-quota", read }, context: { source: "acp_usage_update", read } } };
  expect(() => validate(definition)).not.toThrow();
});

const EXPECTED_ACP_LEGS = ["native-approval-rpc", "native-mode-ack", "native-quota", "watchdog-generation"] as const;

test("#625 follow-up: ACP enrollment exposes the stable catalog used by executable legs", async () => {
  const { ACP_LEGS } = await enrollment();
  expect(ACP_LEGS).toEqual([...EXPECTED_ACP_LEGS]);
});

for (const leg of EXPECTED_ACP_LEGS) test(`#625 follow-up: an owned ACP engine needs its explicit ${leg} skip reason`, async () => {
  const { assertEnrollment, UNSUPPORTED, UNSUPPORTED_LEGS } = await enrollment();
  const reasons = { ...UNSUPPORTED_LEGS }; delete reasons[`jcode:${leg}`];
  expect(() => assertEnrollment(ADAPTERS, primary(), UNSUPPORTED, reasons)).toThrow(new RegExp(`jcode.*${leg}`));
});

for (const key of ["removed-kind:native-quota", "jcode:retired-leg", "codex:native-quota", "codex:reviewer:native-quota"]) test(`#625 follow-up: stale unsupported ACP leg key ${key} is refused`, async () => {
  const { assertEnrollment, UNSUPPORTED, UNSUPPORTED_LEGS } = await enrollment();
  expect(() => assertEnrollment(ADAPTERS, primary(), UNSUPPORTED, { ...UNSUPPORTED_LEGS, [key]: "old reason must not hide an unexecuted leg" })).toThrow(new RegExp(key));
});

test("#625 follow-up: a blank unsupported ACP leg reason is refused", async () => {
  const { assertEnrollment, UNSUPPORTED, UNSUPPORTED_LEGS } = await enrollment();
  expect(() => assertEnrollment(ADAPTERS, primary(), UNSUPPORTED, { ...UNSUPPORTED_LEGS, "jcode:native-approval-rpc": "  " })).toThrow(/jcode.*native-approval-rpc/);
});

test("#625 follow-up: removing an ACP definition invalidates its stale leg reasons", async () => {
  const { assertEnrollment, UNSUPPORTED, UNSUPPORTED_LEGS } = await enrollment();
  expect(() => assertEnrollment(ADAPTERS.filter(definition => definition.kind !== "jcode"), primary().filter(kind => kind !== "jcode"), UNSUPPORTED, UNSUPPORTED_LEGS)).toThrow(/jcode/);
});

test("#625 follow-up: a newly enrolled non-generic ACP engine cannot silently bypass the executable leg catalog", async () => {
  const { assertEnrollment, UNSUPPORTED, UNSUPPORTED_LEGS } = await enrollment();
  const original = ADAPTERS.find(definition => definition.transport === "acp" && definition.start.daemonPort === "acp")!;
  const fake: AdapterDefinition = { ...original, kind: "fake-owned-acp", reviewerVariant: undefined, start: { ...original.start, daemonPort: "owned-acp" } };
  expect(() => assertEnrollment([...ADAPTERS, fake], [...primary(), fake.kind], UNSUPPORTED, UNSUPPORTED_LEGS)).toThrow(/fake-owned-acp/);
});


test("#525 headless implementer cannot disappear from conformance enrollment", async () => {
  const { assertEnrollment, UNSUPPORTED } = await enrollment();
  const reasons = { ...UNSUPPORTED }; delete reasons["claude:implementer"];
  expect(() => assertEnrollment(ADAPTERS, primary(), reasons)).toThrow(/claude:implementer/);
});
