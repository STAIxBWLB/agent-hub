import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as peerContracts from "../src/hub/peers.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Bus } from "../src/hub/bus.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { HUB, newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { isWsPeer } from "../src/adapters/channel-peer.ts";
import { CodexPeer, isCodexPeer } from "../src/adapters/codex-appserver.ts";
import { PiPeer, isPiPeer } from "../src/adapters/pi.ts";
import type { PermissionMode } from "../src/hub/permission-mode.ts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
class PlainPeer extends BasePeer {
  delivered: Envelope[] = [];
  session = "session-A";
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[]) { this.delivered.push(...envs); }
  offline() { this.setState("offline"); }
  recoveryMetadata() { return { sessionId: this.session }; }
}
class GenerationPeer extends PlainPeer {
  generation: string | number | undefined = "generation-A";
  checkpointUsesSessionGeneration?: boolean;
  get sessionGeneration() { return this.generation; }
}
class PermissionPeer extends PlainPeer {
  mode: PermissionMode | "unknown" | "unmanaged" = "ask";
  calls: PermissionMode[] = [];
  pending: Promise<void> | undefined;
  refusal = false;
  get permissionModeState() { return this.mode; }
  async setPermissionMode(mode: PermissionMode) {
    this.calls.push(mode); await this.pending;
    if (this.refusal) throw new Error("fixture native mode refused");
    this.mode = mode;
  }
}
async function fixture(peer: PlainPeer) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-peer-capabilities-"));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const daemon = await startDaemon({ cwd, stateDir: cwd, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false } } });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(cwd, { role: "console" });
  cleanup.push(() => client.close());
  daemon.bus.add(peer); await peer.start();
  return { daemon, client, mode: (mode?: PermissionMode, confirmed = false) => client.request({ t: "permission", peer: peer.id, ...(mode ? { mode } : {}), confirmed }) };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(predicate()).toBe(true);
}
test("#625 generic permission state getters are displayed without native class inheritance", async () => {
  const peer = new PermissionPeer("local"), f = await fixture(peer);
  for (const mode of ["unknown", "unmanaged", "ask-when-needed", "never-ask", "ask"] as const) {
    peer.mode = mode;
    expect((await f.mode()).permissionMode).toBe(mode);
    const status = (await f.client.request({ t: "status" })).status;
    expect(status.peers.local.permissionMode ?? "ask").toBe(mode);
  }
});
test("#625 generic native permission changes await ACK and preserve confirmation", async () => {
  const peer = new PermissionPeer("local"), f = await fixture(peer);
  let release!: () => void; peer.pending = new Promise(resolve => { release = resolve; });
  const pending = f.mode("ask-when-needed");
  await until(() => peer.calls.length === 1);
  expect((await f.client.request({ t: "status" })).status.peers.local.permissionMode ?? "ask").toBe("ask");
  release(); expect((await pending).ok).toBe(true);
  expect((await f.mode()).permissionMode).toBe("ask-when-needed");
  expect((await f.mode("never-ask")).ok).toBe(false);
  expect(peer.calls).toEqual(["ask-when-needed"]);
  expect((await f.mode("never-ask", true)).ok).toBe(true);
  expect(peer.calls).toEqual(["ask-when-needed", "never-ask"]);
});
for (const change of ["replace", "offline", "refuse"] as const) test(`#625 generic permission ACK ${change} cannot commit stale hub mode`, async () => {
  const peer = new PermissionPeer("local"), f = await fixture(peer);
  let release!: () => void; peer.pending = new Promise(resolve => { release = resolve; });
  const pending = f.mode("ask-when-needed");
  await until(() => peer.calls.length === 1);
  if (change === "replace") { const replacement = new PlainPeer("local"); f.daemon.bus.add(replacement); await replacement.start(); }
  if (change === "offline") peer.offline();
  if (change === "refuse") peer.refusal = true;
  release(); expect((await pending).ok).toBe(false);
  // A generationless host-only replacement exposes the hub choice rather than the old native getter.
  const replacement = new PlainPeer("local"); f.daemon.bus.add(replacement); await replacement.start();
  expect((await f.mode()).permissionMode).toBe("ask");
});
test("#625 generationless peers retain host-only permission changes", async () => {
  const f = await fixture(new PlainPeer("local"));
  expect((await f.mode("ask-when-needed")).ok).toBe(true);
  expect((await f.mode()).permissionMode).toBe("ask-when-needed");
});

const source = readFileSync(new URL("../src/hub/daemon.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("daemon.ts", source, ts.ScriptTarget.Latest, true);
function closure(name: string): string {
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = node; ts.forEachChild(node, visit); };
  visit(ast); expect(found?.initializer).toBeDefined();
  return ts.transpileModule(`const ${name} = ${found!.initializer!.getText(ast)}; ${name};`, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
}
function generationRig(peer: PlainPeer) {
  const bus = new Bus({ batchMs: 0 }); bus.add(peer);
  const waits = new Map<string, { valid(): boolean; done(summary: string | undefined): void }>();
  const context = { ...peerContracts, bus, checkConnections: new WeakMap(), instanceId: "fixture-instance", randomUUID: () => crypto.randomUUID(),
    isWsPeer, isCodexPeer, isPiPeer, stopping: false, recoveryActive: () => false, checkpointWaits: waits,
    contextSession: () => peer.session, contextPii: () => false, turns: new Map(), board: { list: () => [{ state: "in_progress", owner: peer.id }] },
    config: { budget: { checkpoint_timeout_s: 1 } }, HUB, newEnvelope, log: () => {}, setTimeout, clearTimeout,
  };
  cleanup.push(() => { for (const wait of waits.values()) wait.done(undefined); bus.closeJournal(); });
  return { bus, waits, connection: runInNewContext(closure("connectionGeneration"), context) as (id: string) => string | undefined,
    checkpoint: runInNewContext(closure("requestCheckpoint"), context) as (id: string, reason: "quota" | "context") => Promise<string | undefined> };
}
test("#625 checks bind optional generation and retain generationless recovery fallback", async () => {
  const peer = new GenerationPeer("fixture"), f = generationRig(peer); await peer.start();
  const initial = f.connection(peer.id); expect(initial).toBeDefined();
  peer.generation = "generation-B"; expect(f.connection(peer.id)).not.toBe(initial);
  peer.generation = 0; expect(f.connection(peer.id)).toContain(":0");
  peer.generation = undefined; expect(f.connection(peer.id)).toBeUndefined();
  const plain = new PlainPeer("plain"); f.bus.add(plain); await plain.start();
  const fallback = f.connection(plain.id); expect(fallback).toBeDefined();
  plain.session = "session-B"; expect(f.connection(plain.id)).not.toBe(fallback);
});
test("#625 checkpoint refuses stale generation while preserving explicit opt-out", async () => {
  const peer = new GenerationPeer("fixture"), f = generationRig(peer); await peer.start();
  const pending = f.checkpoint(peer.id, "context");
  expect(f.waits.get(peer.id)?.valid()).toBe(true);
  peer.generation = "generation-B"; expect(f.waits.get(peer.id)?.valid()).toBe(false);
  f.waits.get(peer.id)!.done(undefined); await pending;
  peer.checkpointUsesSessionGeneration = false;
  const optedOut = f.checkpoint(peer.id, "context");
  peer.generation = "generation-C"; expect(f.waits.get(peer.id)?.valid()).toBe(true);
  f.waits.get(peer.id)!.done(undefined); await optedOut;
  peer.checkpointUsesSessionGeneration = undefined; peer.generation = undefined;
  expect(await f.checkpoint(peer.id, "context")).toBeUndefined(); expect(f.waits.size).toBe(0);
});
test("#625 checkpoint generationless fallback still fences owner session changes", async () => {
  const peer = new PlainPeer("fixture"), f = generationRig(peer); await peer.start();
  const pending = f.checkpoint(peer.id, "context"); expect(f.waits.get(peer.id)?.valid()).toBe(true);
  peer.session = "session-B"; expect(f.waits.get(peer.id)?.valid()).toBe(false);
  f.waits.get(peer.id)!.done(undefined); await pending;
});

for (const state of ["unknown", "unmanaged"] as const) test(`#625 generic ${state} native mode refuses changes before setter effects`, async () => {
  const peer = new PermissionPeer("local"), f = await fixture(peer); peer.mode = state;
  for (const mode of ["ask", "ask-when-needed", "never-ask"] as const) expect((await f.mode(mode, true)).ok).toBe(false);
  expect(peer.calls).toEqual([]);
  const replacement = new PlainPeer("local"); f.daemon.bus.add(replacement); await replacement.start();
  expect((await f.mode()).permissionMode).toBe("ask");
});
test("#625 native Pi explicitly retains its generationless checkpoint ceiling", () => {
  const peer = new PiPeer("pi", { cwd: "/fixture", stateDir: "/fixture/state", mode: "headless", backend: "dgx",
    relay: { url: "http://127.0.0.1:9/v1", token: "fixture", models: [] }, tools: [], executeTool: async () => "unused fixture tool" });
  // Construction starts no native process or bridge; absent ownership is still unknown, never a verified epoch.
  expect("sessionGeneration" in peer).toBe(true);
  expect(peer.sessionGeneration).toBeUndefined();
  expect(peer.checkpointUsesSessionGeneration).toBe(false);
});
test("#625 native Codex permission state aliases its existing selected mode", () => {
  const peer = new CodexPeer("codex", { cwd: "/fixture", appPort: 0, proxyPort: 0 });
  expect(peer.permissionModeState).toBe(peer.getPermissionMode());
  expect(peer.permissionModeState).toBe("ask");
  for (const mode of ["ask-when-needed", "never-ask", "ask"] as const) {
    peer.setStartupPermissionMode(mode);
    expect(peer.permissionModeState).toBe(mode);
    expect(peer.permissionModeState).toBe(peer.getPermissionMode());
  }
  peer.setStartupPermissionMode("never-ask");
  expect(peer.clearPermissionMode()).toBe(true);
  expect(peer.permissionModeState).toBe("ask");
});
