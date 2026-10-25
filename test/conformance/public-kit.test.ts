import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterDefinition } from "../../src/adapters/registry-types.ts";

const publicKit = () => import("../../src/adapters/conformance/index.ts");

test("A4 public conformance entry exports callable transport registrations and server fakes", async () => {
  const kit = await publicKit();
  for (const name of ["registerConformance", "registerAcpConformance", "registerCodexConformance", "registerOwnedAcpConformance", "registerPiConformance", "registerLocalConformance", "registerExternalChannelConformance", "createFromDefinition", "expire", "until", "startFakeAppServer", "startFakeModelServer", "toolCall"] as const) {
    expect(typeof kit[name], name).toBe("function");
  }
  expect(kit.ACP_LEGS).toEqual(["native-approval-rpc", "native-mode-ack", "native-quota", "watchdog-generation"]);
});

test("A4 public fake paths are immutable packaged source assets with no test-tree dependency", async () => {
  const kit = await publicKit();
  expect(Object.isFrozen(kit.fakePaths)).toBe(true);
  expect(Object.keys(kit.fakePaths).sort()).toEqual(["acpServer", "acpWatchdog", "appServer", "codexBin", "jcodeAgent", "modelServer", "piRpc"].sort());
  const publicRoot = fileURLToPath(new URL("../../src/adapters/conformance/", import.meta.url));
  for (const value of Object.values(kit.fakePaths)) {
    expect(typeof value).toBe("string");
    expect(statSync(value).isFile()).toBe(true);
    const inside = relative(publicRoot, value);
    expect(inside === ".." || inside.startsWith(".." + sep)).toBe(false);
    const source = readFileSync(value, "utf8");
    expect(source).not.toMatch(/(?:from|import)\s*["'][^"']*test\/(?:conformance|fakes)\//);
  }
  expect(dirname(kit.fakePaths.acpServer)).toBe(dirname(kit.fakePaths.codexBin));
});

test("A4 public factory calls the supplied definition rather than a builtin or a concrete class", async () => {
  const kit = await publicKit(), calls: unknown[] = [];
  const peer = { id: "external-fixture", state: "offline" as const, start: async () => {}, stop: async () => {}, deliver: async () => {} };
  const definition: AdapterDefinition = {
    api: 1, kind: peer.id, family: peer.id, displayName: "External fixture", transport: "acp", roles: ["implementer"],
    trust: { onPrem: false, hubSandboxed: false }, identity: { mcp: "acp-session" }, permission: {},
    start: { forms: ["headless"], defaultForm: "headless", conductorStartable: true, daemonPort: "acp", hubSwitches: [], ownedFlags: [],
      create: context => { calls.push(context); return peer; } },
    session: { idField: "sessionId", currentId: () => undefined }, turnEnd: "adapter",
    cli: { command: peer.id, startWords: () => [peer.id] }, display: { palette: { fg: "white", bg: "black" } },
  };
  const daemon = { acp: { cwd: "/public-kit-fixture", cmd: ["fixture-not-executed"], mcpServers: [{ name: "fixture", command: "fixture", args: [], env: [] }] } };
  expect(kit.createFromDefinition(definition, daemon)).toBe(peer);
  expect(calls).toHaveLength(1);
  expect(() => kit.registerCodexConformance(definition)).toThrow("codex-appserver");
  expect(() => kit.registerOwnedAcpConformance(definition)).toThrow("owned-acp");
  expect(() => kit.registerPiConformance(definition)).toThrow("pi-rpc");
  expect(() => kit.registerLocalConformance(definition)).toThrow("local-worker");
  expect(() => kit.registerAcpConformance({ definition, unsupported: { "native-mode-ack": "" } })).toThrow("reason");

  expect(calls[0]).toMatchObject({ instance: peer.id, projectRoot: "/public-kit-fixture", stateDir: "/public-kit-fixture/state", permission: "ask", mcpServers: daemon.acp.mcpServers });
  expect((calls[0] as { daemon: unknown }).daemon).toBe(daemon);
  expect(() => kit.createFromDefinition({ ...definition, start: { ...definition.start, create: undefined } }, daemon)).toThrow(/factory|external/);
});

for (const port of ["frontendProxy", "statusNotice", "revertTurn"] as const) test(`A4 conformance rejects foreign product native proof port ${port} by presence`, async () => {
  const kit = await publicKit(), original = (await import("../../src/adapters/registry.ts")).definitionOf("codex")!;
  for (const value of [undefined, { unsafe: "foreign proof" }]) {
    const product = { id: "foreign", state: "offline" as const, start: async () => {}, stop: async () => {}, deliver: async () => {}, [port]: value };
    const definition: AdapterDefinition = { ...original, start: { ...original.start, create: () => product } };
    expect(() => kit.createFromDefinition(definition, { codex: { cwd: "/unopened/fixture", appPort: 0, proxyPort: 0 } })).toThrow(`${port} is restricted`);
  }
});

test("A4 conformance admits ordinary foreign products but cannot skip their active proof leg", async () => {
  const kit = await publicKit(), original = (await import("../../src/adapters/registry.ts")).definitionOf("codex")!;
  const product = { id: "foreign", state: "offline" as const, start: async () => {}, stop: async () => {}, deliver: async () => {} };
  const definition: AdapterDefinition = { ...original, kind: "foreign", start: { ...original.start, create: () => product } };
  expect(kit.createFromDefinition(definition, { codex: { cwd: "/unopened/fixture", appPort: 0, proxyPort: 0 } })).toBe(product);
  expect(() => kit.assertEnrollment([definition], [definition.kind], {}, { "foreign:native-proof-ports": "pretend native proof does not apply" })).toThrow("only fixed builtin proof legs");
});
