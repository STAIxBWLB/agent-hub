import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateContext } from "../src/adapters/registry-types.ts";
import type { PeerAdapter } from "../src/hub/peers.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const cases = [
  ["codex", "createCodex", "codex", "CodexPeer"],
  ["kimi", "createKimi", "acp", "AcpPeer"],
  ["jcode", "createJcode", "jcode", "JcodePeer"],
  ["pi", "createPi", "pi", "PiPeer"],
  ["local", "createLocal", "local", "LocalPeer"],
] as const;
async function factories(): Promise<Record<string, (ctx: CreateContext) => PeerAdapter>> {
  const path = "../src/adapters/definitions/native-factories.ts";
  const loaded = await import(path).catch(() => undefined);
  for (const [, name] of cases) expect(typeof loaded?.[name]).toBe("function");
  return loaded;
}
function context(kind: string, port: string, options: unknown, permission: CreateContext["permission"] = "ask"): CreateContext {
  return { instance: kind, projectRoot: "/factory-fixture", stateDir: "/factory-fixture/state", permission,
    kindConfig: {}, mcpServers: [], daemon: { [port]: options } } as unknown as CreateContext;
}

for (const [kind, factory, port] of cases) {
  test(`A2 ${kind} factory refuses another transport before constructor option access`, async () => {
    const module = await factories(); let touched = 0;
    const poison = new Proxy({}, { get() { touched++; throw new Error("constructor options touched"); } });
    const wrong = port === "codex" ? "acp" : "codex";
    expect(() => module[factory]!(context(kind, wrong, poison))).toThrow(/requires.*transport options/i);
    expect(touched).toBe(0);
  });
  test(`A2 ${kind} factory refuses unverified read-only before constructor effects`, async () => {
    const module = await factories(); let touched = 0;
    const poison = new Proxy({}, { get() { touched++; throw new Error("constructor options touched"); } });
    expect(() => module[factory]!(context(kind, port, poison, "read-only"))).toThrow(/no verified read-only permission mapping/i);
    expect(touched).toBe(0);
  });
}

test("A2 native factory creation preserves transport options and never starts a native owner", async () => {
  const module = await factories();
  const [{ CodexPeer }, { AcpPeer }, { JcodePeer }, { PiPeer }, { LocalPeer }] = await Promise.all([
    import("../src/adapters/codex-appserver.ts"), import("../src/adapters/acp.ts"), import("../src/adapters/jcode.ts"), import("../src/adapters/pi.ts"), import("../src/adapters/local-worker.ts"),
  ]);
  const root = mkdtempSync(join(tmpdir(), "ahub-factory-a2-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const constructors = { CodexPeer, AcpPeer, JcodePeer, PiPeer, LocalPeer };
  let callbacks = 0;
  const observe = () => { callbacks++; };
  const permit = async () => false as const;
  const mcp = [{ name: "fixture", command: "must-not-run", args: [], env: [] }];
  const options: Record<string, unknown> = {
    codex: { proxyPort: 0, appPort: 0, bin: "must-not-run", extraArgs: ["--fixture"], permissionMode: "never-ask", onTokens: observe },
    acp: { cwd: root, cmd: ["must-not-run", "fixture"], permissionMode: "ask-when-needed", mcpServers: mcp, onTokens: observe },
    jcode: { cwd: root, command: ["must-not-run", "fixture"], home: root, providerProfile: "fixture-profile", onTokens: observe },
    pi: { cwd: root, stateDir: root, mode: "headless", backend: "dgx", relay: { url: "http://127.0.0.1:1", token: "fixture", models: [] }, tools: [], executeTool: async () => { callbacks++; return "unexpected"; }, onTokens: observe },
    local: { cwd: root, fixedModel: "fixture", omni: { chat: async () => { callbacks++; throw new Error("provider called"); } }, tools: { deny: [], permit }, onTokens: observe },
  };
  for (const [kind, factory, port, className] of cases) {
    const Constructor = constructors[className];
    const start = spyOn(Constructor.prototype, "start"); cleanup.push(() => start.mockRestore());
    const peer = module[factory]!(context(kind, port, options[port]));
    expect(peer).toBeInstanceOf(Constructor); expect(peer.id).toBe(kind); expect(peer.state).toBe("offline");
    expect(start).not.toHaveBeenCalled(); expect(callbacks).toBe(0);
    const stored = peer as unknown as { opts?: unknown; jcode?: unknown; proc?: unknown };
    expect(port === "jcode" ? stored.jcode : stored.opts).toBe(options[port]); expect(stored.proc).toBeUndefined();
    if (port === "jcode") {
      expect((stored.opts as { permissionMode?: unknown }).permissionMode).toBeUndefined();
      expect((stored.opts as { mcpServers?: unknown }).mcpServers).toEqual([]);
      cleanup.push(() => peer.stop()); // The existing constructor owns a private socket directory, not a started process.
    }
  }
});

test("A2 builtin metadata uses the exported native factory identities", async () => {
  const module = await factories(), { definitionOf } = await import("../src/adapters/registry.ts");
  for (const [kind, factory] of cases) expect(definitionOf(kind)?.start.create).toBe(module[factory]);
});

test("A2 factory engine tags match existing host engines and reject missing or unknown engines", async () => {
  const { ADAPTERS, assertDaemonEngine } = await import("../src/adapters/registry.ts");
  const expected = { claude: undefined, codex: "codex-appserver", kimi: "acp", pi: "pi-rpc", local: "local-worker", qwen: "acp", jcode: "owned-acp" } as const;
  for (const definition of ADAPTERS) {
    expect(definition.start.daemonPort).toBe(expected[definition.kind as keyof typeof expected]);
    expect(() => assertDaemonEngine(definition)).not.toThrow();
    expect(() => assertDaemonEngine({ start: { ...definition.start, daemonPort: "unknown" as never } })).toThrow("invalid adapter daemon engine");
    if (definition.start.create) expect(() => assertDaemonEngine({ start: { ...definition.start, daemonPort: undefined } })).toThrow("invalid adapter daemon engine");
  }
});
