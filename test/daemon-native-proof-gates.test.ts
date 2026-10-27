import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createProjectAdapterCatalog, definitionOf, isFixedBuiltinDefinition } from "../src/adapters/registry.ts";
import { isCodexPeer } from "../src/adapters/codex-appserver.ts";
import { createClaudeLaunchProof } from "../src/hub/claude-launch-proof.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { isWsPeer } from "../src/adapters/channel-peer.ts";
import type { Envelope } from "../src/hub/envelope.ts";

const source = readFileSync(new URL("../src/hub/daemon.ts", import.meta.url), "utf8");
function hostFunction(name: string, next: string, ports: Record<string, unknown>): (...args: any[]) => any {
  const start = source.indexOf(`  ${name}`), end = source.indexOf(`  ${next}`, start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const functionName = name.replace(/^(?:async )?function /, "").split("(")[0]!;
  return runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end)) + `\n${functionName}`, ports);
}
function hostBinding(name: string, ports: Record<string, unknown>): (...args: any[]) => any {
  const start = source.indexOf(`  const ${name} =`), end = source.indexOf(";\n", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  return runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end + 1)) + `\n${name}`, ports);
}

test("#625 Claude launch proof is unreadable under a same-name foreign definition", () => {
  const builtin = definitionOf("claude")!, stateDir = mkdtempSync(join(tmpdir(), "ahub-proof-gate-"));
  try {
    writeFileSync(join(stateDir, "claude-launch.json"), JSON.stringify({ instanceId: "fixture", launchId: "fixture-launch", permissionHook: true }), { mode: 0o600 });
    for (const definition of [builtin, { ...builtin }]) {
      const proof = createClaudeLaunchProof({ stateDir, cwd: stateDir, instanceId: "fixture", definitionOf: () => definition, peer: () => undefined });
      expect(proof.permissionLaunch("claude")?.launchId).toBe(isFixedBuiltinDefinition(definition) ? "fixture-launch" : undefined);
    }
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("#625 offline Codex clear reads native proof state only under the fixed resolved definition", async () => {
  const builtin = definitionOf("codex")!;
  for (const definition of [builtin, { ...builtin }]) {
    const owner = builtin.start.create!({ instance: "codex", projectRoot: "/unopened/fixture", stateDir: "/unopened/state", kindConfig: {}, permission: "ask", mcpServers: [],
      daemon: { codex: { cwd: "/unopened/fixture", appPort: 0, proxyPort: 0 } } });
    expect(isCodexPeer(owner)).toBe(true);
    let clears = 0;
    Object.defineProperty(owner.frontendProxy!, "clearPermissionMode", { value: () => { clears++; return false; } });
    const policyPorts = { declarations: { locked: { readOnly: true } }, adapterCatalog: createProjectAdapterCatalog() };
    const isSupportedPeer = hostBinding("isSupportedPeer", policyPorts), readOnlyPeer = hostBinding("readOnlyPeer", policyPorts);
    expect(isSupportedPeer("codex")).toBe(true); expect(isSupportedPeer("foreign-unregistered")).toBe(false);
    expect(readOnlyPeer("locked")).toBe(true); expect(readOnlyPeer("codex")).toBe(false);
    const frontendProxyState = hostFunction("function frontendProxyState(", "const manualPaused =", { isFixedBuiltinDefinition, definitionOf: () => definition });
    const run = hostFunction("async function changePermission(", "async function confirmPermissionDefault(", {
      isFixedBuiltinDefinition, isCodexPeer, definitionOf: () => definition, isSupportedPeer, readOnlyPeer,
      frontendProxyState,
      requestedPeerStops: new Set(), bus: { peers: new Map([["codex", owner]]) },
      claudeLaunchProof: createClaudeLaunchProof({ stateDir: "/unopened/state", cwd: "/unopened/fixture", instanceId: "fixture", definitionOf: () => definition, peer: () => owner }),
      permissionMode: () => "ask", permissionModes: new Map(), permissionModeSources: new Map(), pendingPermissionDefaults: new Map(),
      event: () => {}, log: () => {}, writeStatus: () => {},
    });
    const result = await run("codex", "ask", true);
    expect(result).toMatchObject({ ok: true, peer: "codex", permissionMode: "ask" });
    expect(clears).toBe(isFixedBuiltinDefinition(definition) ? 1 : 0);
    expect(result.note !== undefined).toBe(isFixedBuiltinDefinition(definition));
  }
});

test("#625 a non-channel adapter cannot reuse a verified Claude generation through actual facts", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-proof-owner-")), stateDir = join(cwd, "state"), previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(cwd, "claude-config"); mkdirSync(join(process.env.CLAUDE_CONFIG_DIR, "projects"), { recursive: true });
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const clients: ControlClient[] = [];
  try {
    daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false } } });
    const console_ = await ControlClient.connect(stateDir, { role: "console" }); clients.push(console_);
    const native = await ControlClient.connect(stateDir, { role: "peer", peer: "claude" }); clients.push(native);
    for (let n = 0; n < 100 && daemon.bus.stateOf("claude") !== "idle"; n++) await Bun.sleep(5);
    const owner = daemon.bus.peers.get("claude"); expect(isWsPeer(owner)).toBe(true);
    const generation = owner!.sessionGeneration;
    const status = (await console_.request({ t: "status" })).status;
    writeFileSync(join(stateDir, "claude-launch.json"), JSON.stringify({ instanceId: status.instanceId, launchId: "fixture-launch", permissionHook: true, hookPurpose: "permission" }), { mode: 0o600 });
    const hook = await ControlClient.connect(stateDir, { role: "tools", peer: "claude" }); clients.push(hook);
    const facts = { t: "facts", phase: "pre", tool: "Read", sessionId: "fixture-session", nativeInstanceId: status.instanceId, nativeLaunchId: "fixture-launch" };
    expect((await hook.request(facts)).permission).toBe("ask");
    expect((await console_.request({ t: "status" })).status.actionPolicyInfo.claude.enforceable).toBe(true);
    class Pretender extends BasePeer {
      readonly sessionGeneration = generation;
      async start() { this.setState("idle"); }
      async stop() { this.setState("offline"); }
      async deliver(_envs: Envelope[]) {}
    }
    const plain = new Pretender("claude"); daemon.bus.add(plain); await plain.start();
    await hook.request(facts);
    expect((await console_.request({ t: "status" })).status.actionPolicyInfo.claude.enforceable).toBe(false);
    expect(await console_.request({ t: "permission", peer: "claude", mode: "ask-when-needed" })).toMatchObject({ ok: false, error: "Claude has no verified ahub claude permission hook; restart with ahub claude and run a tool first" });
  } finally {
    for (const client of clients.reverse()) client.close(); await daemon?.stop();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});
