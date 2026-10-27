import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { BasePeer, type FrontendProxyPort, type PeerAdapter } from "../src/hub/peers.ts";
import type { PermissionMode } from "../src/hub/permission-mode.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { Bus } from "../src/hub/bus.ts";
import { createProjectAdapterCatalog, isFixedBuiltinDefinition } from "../src/adapters/registry.ts";
import type { Envelope } from "../src/hub/envelope.ts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
class PlainPeer extends BasePeer {
  mode: PermissionMode = "ask";
  calls: PermissionMode[] = [];
  get permissionModeState() { return this.mode; }
  getPermissionMode() { return this.mode; }
  async setPermissionMode(mode: PermissionMode) { this.calls.push(mode); this.mode = mode; }
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) {}
  offline() { this.setState("offline"); }
}
function property(peer: PeerAdapter, key: string, value: unknown): void {
  Object.defineProperty(peer, key, { configurable: true, value });
}
const configured = { fixture: { transport: "acp" as const, command: "fixture-never-started", args: [], displayName: "Fixture", roles: ["implementer"],
  identity: { name: "Fixture", version: "1" },
  permission: { ask: "default", "ask-when-needed": "accept", "never-ask": "never" } } };
async function fixture(peer: PlainPeer, foreign = false) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-frontend-port-")), stateDir = join(cwd, "state");
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, ...(foreign ? { adapters: configured } : {}), batch_ms: 0, roster: { ...DEFAULT_CONFIG.roster, [peer.id]: true },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  daemon.bus.add(peer); await peer.start();
  return { daemon, client, permission: (mode: PermissionMode) => client.request({ t: "permission", peer: peer.id, mode }),
    start: () => client.request({ t: "start", peer: peer.id }) };
}
function proxy(peer: PlainPeer, attached = false, cleared = true) {
  const startup: PermissionMode[] = []; let clears = 0;
  const port: FrontendProxyPort = { url: "ws://127.0.0.1:9/fixture", attached,
    setStartupPermissionMode(mode) { startup.push(mode); peer.mode = mode; },
    clearPermissionMode() { clears++; peer.mode = "ask"; return cleared; } };
  return { port, startup, clears: () => clears };
}

test("#625 a plain fixed-builtin peer uses the frontend attachment refusal before its runtime setter", async () => {
  const peer = new PlainPeer("codex"), p = proxy(peer); property(peer, "frontendProxy", p.port);
  const f = await fixture(peer);
  expect(await f.permission("ask-when-needed")).toMatchObject({ ok: false, error: "Codex TUI is not behind the hub proxy; reconnect with ahub codex" });
  expect(peer.calls).toEqual([]); expect(peer.mode).toBe("ask"); expect(p.startup).toEqual([]);
  expect(await f.start()).toMatchObject({ ok: true, already: true, proxyUrl: p.port.url });
});

test("#625 an attached plain fixed-builtin proxy uses the acknowledged runtime setter", async () => {
  const peer = new PlainPeer("codex"), p = proxy(peer, true); property(peer, "frontendProxy", p.port);
  const f = await fixture(peer);
  expect(await f.permission("ask-when-needed")).toMatchObject({ ok: true, permissionMode: "ask-when-needed" });
  expect(peer.calls).toEqual(["ask-when-needed"]); expect(p.startup).toEqual([]); expect(p.clears()).toBe(0);
});

test("#625 offline ask clears a plain fixed-builtin proxy and keeps the native-baseline notice", async () => {
  const peer = new PlainPeer("codex"), p = proxy(peer, false, false); property(peer, "frontendProxy", p.port);
  const f = await fixture(peer); peer.offline();
  expect(await f.permission("ask")).toMatchObject({ ok: true, permissionMode: "ask",
    note: "The detached session's own approval policy was never reported, so its thread keeps what it last got; a new ahub codex session starts in ask" });
  expect(p.clears()).toBe(1); expect(peer.calls).toEqual([]);
});

test("#625 a present undefined fixed-builtin proxy refuses permission and already-start replies before effects", async () => {
  const peer = new PlainPeer("codex"); property(peer, "frontendProxy", undefined);
  const f = await fixture(peer);
  expect(await f.permission("ask-when-needed")).toMatchObject({ ok: false, error: "frontend proxy state unknown" });
  expect(await f.start()).toMatchObject({ ok: false, error: "frontend proxy state unknown" });
  peer.offline();
  expect(await f.permission("ask")).toMatchObject({ ok: false, error: "frontend proxy state unknown" });
  expect(peer.calls).toEqual([]); expect(f.daemon.bus.peers.get(peer.id)).toBe(peer);
});

test("#625 an absent proxy keeps the plain peer's generic permission path", async () => {
  const peer = new PlainPeer("codex"), f = await fixture(peer);
  expect(await f.permission("ask-when-needed")).toMatchObject({ ok: true, permissionMode: "ask-when-needed" });
  expect(peer.calls).toEqual(["ask-when-needed"]);
  const already = await f.start(); expect(already).toMatchObject({ ok: true, already: true }); expect(already.proxyUrl).toBeUndefined();
});

test("#625 a configured ACP definition never reads its plain product's native proof getters", async () => {
  const peer = new PlainPeer("fixture"); let proxyReads = 0, noticeReads = 0;
  Object.defineProperties(peer, {
    frontendProxy: { get() { proxyReads++; throw new Error("foreign proxy getter must not run"); } },
    statusNotice: { get() { noticeReads++; throw new Error("foreign notice getter must not run"); } },
  });
  const f = await fixture(peer, true);
  expect(await f.permission("ask-when-needed")).toMatchObject({ ok: true, permissionMode: "ask-when-needed" });
  expect(await f.start()).toMatchObject({ ok: true, already: true });
  expect((await f.client.request({ t: "status" })).status.peers.fixture.statusNotice).toBeUndefined();
  expect(proxyReads).toBe(0); expect(noticeReads).toBe(0); expect(peer.calls).toEqual(["ask-when-needed"]);
});

test("#625 fixed-builtin status projection preserves Codex and Qwen notice codes through the generic port", async () => {
  const peer = new PlainPeer("local"), f = await fixture(peer);
  const notices: NonNullable<PeerAdapter["statusNotice"]>[] = [
    { code: "unidentified-cancellation", message: "fixture Codex cancellation" },
    { code: "qwen-detached", message: "fixture Qwen detached" },
    { code: "qwen-stalled", message: "fixture Qwen stalled" },
  ];
  for (const notice of notices) {
    property(peer, "statusNotice", notice);
    expect((await f.client.request({ t: "status" })).status.peers.local.statusNotice).toEqual(notice);
  }
});

const source = readFileSync(new URL("../src/hub/daemon.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("daemon.ts", source, ts.ScriptTarget.Latest, true);
function hostFunctions(names: string[], ports: Record<string, unknown>): Record<string, (...args: any[]) => any> {
  const found = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) found.set(node.name.text, node.getText(ast));
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast)) && node.initializer) found.set(node.name.getText(ast), `const ${node.name.getText(ast)} = ${node.initializer.getText(ast)};`);
    ts.forEachChild(node, visit);
  };
  visit(ast); expect(found.size).toBe(names.length);
  return runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(names.map(name => found.get(name)!).join("\n")) + `\n({${names.join(",")}});`, ports);
}
function lifecycleRig(peer: PlainPeer, foreign = false) {
  const adapterCatalog = createProjectAdapterCatalog(foreign ? configured : undefined), declarations = {};
  const definitionOf = (id: string) => adapterCatalog.definitionOf(id, declarations);
  const bus = new Bus({ batchMs: 0 }); cleanup.push(() => bus.closeJournal());
  const permissionModes = new Map<string, PermissionMode>([[peer.id, "ask-when-needed"]]), pendingPermissionDefaults = new Map([[peer.id, "fixture default"]]);
  const executionOwners = new Map(), executionRoots = new Map();
  const functions = hostFunctions(["isSupportedPeer", "readOnlyPeer", "nativeUnattended", "frontendProxyState", "permissionChange", "reconcileNativeStart", "confirmPermissionDefault"], {
    adapterCatalog, declarations, definitionOf, isFixedBuiltinDefinition, bus, permissionModes, pendingPermissionDefaults,
    permissionChanges: new Map(), starting: new Set(), startingUnattended: new Map(), unattendedPeers: new Set(),
    stopping: false, permissionMode: (id: string) => permissionModes.get(id) ?? "ask", executionOwners, executionRoots, opts: { cwd: "/fixture" },
    permissionModeSources: new Map(), event: () => {}, log: () => {}, writeStatus: () => {},
    changePermission: () => { throw new Error("offline default must not call live changePermission"); },
  });
  expect(functions.isSupportedPeer!(peer.id)).toBe(true); expect(functions.readOnlyPeer!(peer.id)).toBe(false);
  return { bus, permissionModes, pendingPermissionDefaults, executionOwners, functions };
}

for (const attached of [false, true]) test(`#625 plain fixed-builtin startup chooses the ${attached ? "runtime" : "startup"} proxy mode path before bus admission`, async () => {
  const peer = new PlainPeer("codex"), p = proxy(peer, attached); property(peer, "frontendProxy", p.port); if (attached) await peer.start();
  const f = lifecycleRig(peer);
  await f.functions.reconcileNativeStart!(peer.id, peer);
  expect(p.startup).toEqual(attached ? [] : ["ask-when-needed"]);
  expect(peer.calls).toEqual(attached ? ["ask-when-needed"] : []);
  expect(f.bus.peers.get(peer.id)).toBe(peer); expect(f.executionOwners.has(peer.id)).toBe(true);
});

test("#625 unknown startup proxy refuses before bus, execution-owner or mode effects", async () => {
  const peer = new PlainPeer("codex"); property(peer, "frontendProxy", undefined); await peer.start();
  const f = lifecycleRig(peer);
  await expect(f.functions.reconcileNativeStart!(peer.id, peer)).rejects.toThrow("frontend proxy state unknown");
  expect(f.bus.peers.has(peer.id)).toBe(false); expect(f.executionOwners.size).toBe(0); expect(peer.calls).toEqual([]); expect(peer.mode).toBe("ask");
});

test("#625 a foreign startup product ignores its proxy getter and follows the generic acknowledged setter", async () => {
  const peer = new PlainPeer("fixture"); let reads = 0;
  Object.defineProperty(peer, "frontendProxy", { get() { reads++; throw new Error("foreign startup getter must not run"); } });
  await peer.start(); const f = lifecycleRig(peer, true);
  await f.functions.reconcileNativeStart!(peer.id, peer);
  expect(reads).toBe(0); expect(peer.calls).toEqual(["ask-when-needed"]); expect(f.bus.peers.get(peer.id)).toBe(peer);
});

for (const unknown of [false, true]) test(`#625 offline default confirmation refuses a ${unknown ? "unknown" : "known"} fixed-builtin proxy without changing the choice`, async () => {
  const peer = new PlainPeer("codex"), p = proxy(peer); property(peer, "frontendProxy", unknown ? undefined : p.port);
  const f = lifecycleRig(peer); f.bus.add(peer);
  expect(await f.functions.confirmPermissionDefault!(peer.id, true)).toMatchObject({ ok: false,
    error: unknown ? "frontend proxy state unknown" : "connect the Codex TUI through the hub proxy before confirming its default" });
  expect(f.permissionModes.get(peer.id)).toBe("ask-when-needed"); expect(f.pendingPermissionDefaults.has(peer.id)).toBe(true);
  expect(peer.calls).toEqual([]); expect(p.startup).toEqual([]); expect(p.clears()).toBe(0);
});
