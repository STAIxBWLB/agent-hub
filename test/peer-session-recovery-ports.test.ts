import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { taskKey } from "@staix/agent-mem";
import { BasePeer, type PeerAdapter } from "../src/hub/peers.ts";
import { Bus } from "../src/hub/bus.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { definitionOf } from "../src/adapters/registry.ts";
import { WsPeer, isWsPeer } from "../src/adapters/channel-peer.ts";
import { AcpPeer } from "../src/adapters/acp.ts";
import { LocalPeer } from "../src/adapters/local-worker.ts";
import { OmniRoute } from "../src/omniroute/client.ts";
import { isClosedTaskState } from "../src/hub/board.ts";
import { deliveryTask } from "../src/hub/attribution.ts";
import { MemoryObservations } from "../src/hub/memory-observations.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { restartPath } from "../src/hub/restart.ts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
class PlainPeer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) {}
  recoveryMetadata() { return { sessionId: "metadata-only" }; }
}
function ports<T extends PeerAdapter>(peer: T, values: Record<string, unknown>): T {
  for (const [key, value] of Object.entries(values)) Object.defineProperty(peer, key, { configurable: true, writable: true, value });
  return peer;
}
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-session-recovery-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
async function fixture(peer: PeerAdapter, offRoster = false, start = true) {
  const cwd = scratch(), stateDir = join(cwd, "state");
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, roster: { ...DEFAULT_CONFIG.roster, [peer.id]: !offRoster },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  daemon.bus.add(peer); if (start) await peer.start();
  const instance = (await client.request({ t: "status" })).status.instanceId;
  const recovery = (op: string) => client.request({ t: "recovery", op, operationId: "ports-recovery", expectedInstanceId: instance, targetFeatures: DAEMON_FEATURES });
  return { daemon, client, recovery, stateDir };
}

for (const ready of [false, undefined, true, "absent"] as const) test(`#625 plain recoveryReady ${String(ready)} gates prepare with no native class`, async () => {
  const peer = new PlainPeer("local"); if (ready !== "absent") ports(peer, { recoveryReady: ready });
  const f = await fixture(peer), settled = ready === true || ready === "absent";
  const prepared = await f.recovery("prepare");
  expect(prepared).toMatchObject({ ok: true, recovery: { phase: settled ? "prepared" : "preparing", ready: settled, blockers: settled ? [] : ["local is not settled"] } });
  expect(await f.recovery("inspect")).toMatchObject({ ok: true, recovery: { ready: settled, blockers: settled ? [] : ["local is not settled"] } });
  if (!settled) {
    ports(peer, { recoveryReady: true });
    expect(await f.recovery("prepare")).toMatchObject({ ok: true, recovery: { ready: true, phase: "prepared", blockers: [] } });
  }
  expect((await f.recovery("abort")).ok).toBe(true);
});

test("#625 a retained plain TUI's unsettled notice uses the definition display name", async () => {
  const peer = ports(new PlainPeer("local"), { recoveryReady: undefined, form: "tui" }), f = await fixture(peer, true, false);
  const notice = `local is not settled; end the retained ${definitionOf("local")!.displayName} TUI, then prepare again`;
  expect(await f.recovery("prepare")).toMatchObject({ ok: true, recovery: { ready: false, blockers: [notice] } });
});

test("#625 generic captureResume runs for inspect, prepare and commit before recovery snapshots", async () => {
  let captures = 0;
  const peer = new PlainPeer("local");
  ports(peer, { captureResume: async () => { captures++; peer.recoveryMetadata = () => ({ sessionId: "captured-session" }); return {}; } });
  const f = await fixture(peer);
  for (const op of ["inspect", "prepare", "commit"]) {
    const result = await f.recovery(op);
    expect(result.ok, op).toBe(true);
    expect(captures, op).toBe(["inspect", "prepare", "commit"].indexOf(op) + 1);
    expect(result.recovery.peers.local.sessionId, op).toBe("captured-session");
    if (op === "commit") {
      const saved = JSON.parse(readFileSync(restartPath(f.stateDir), "utf8"));
      expect(saved.peers.find((row: { id: string }) => row.id === "local").sessionId).toBe("captured-session");
    }
  }
});

test("#625 a generic capture refusal keeps its exact native notice and starts no recovery hold", async () => {
  const peer = ports(new PlainPeer("local"), { captureResume: async () => { throw new Error("fixture resume evidence unavailable"); } }), f = await fixture(peer);
  expect(await f.recovery("prepare")).toMatchObject({ ok: false, error: "fixture resume evidence unavailable" });
  expect(f.daemon.bus.isRecoveryHeld).toBe(false);
});

for (const owner of ["acp", "channel"] as const) test(`#625 ${owner} owner keeps settled recovery notices and snapshot metadata unchanged`, async () => {
  const peer = owner === "acp" ? new AcpPeer("kimi", { cwd: "/fixture", cmd: ["fixture-never-started"] }) : new WsPeer("claude");
  const f = await fixture(peer, false, false);
  expect("recoveryReady" in peer).toBe(false); expect("captureResume" in peer).toBe(false);
  expect(await f.recovery("prepare")).toMatchObject({ ok: true, recovery: { ready: true, blockers: [], phase: "prepared", capabilities: { controlledRestart: true, snapshotSchemaVersion: 1, maxLeaseMs: 600000 } } });
  const inspected = await f.recovery("inspect");
  expect(inspected.recovery.blockers).toEqual([]);
  expect(inspected.recovery.peers[peer.id].launch).toEqual(peer.recoveryMetadata().launch);
  expect((await f.recovery("abort")).ok).toBe(true);
});

const source = readFileSync(new URL("../src/hub/daemon.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("daemon.ts", source, ts.ScriptTarget.Latest, true);
function hostVariables(names: string[], ports: Record<string, unknown>): any {
  const declarations = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast))) {
      expect(node.initializer).toBeDefined(); declarations.set(node.name.getText(ast), node.initializer!.getText(ast));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast); expect(declarations.size).toBe(names.length);
  const code = names.map(name => `const ${name} = ${declarations.get(name)};`).join("\n");
  return runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(code) + `\n({${names.join(",")}});`, ports);
}

test("#625 session binding reads the plain nativeSession port, preserves empty strings and keeps host Claude proof", () => {
  const bus = new Bus({ batchMs: 0 }); cleanup.push(() => bus.closeJournal());
  const peer = new PlainPeer("kimi"); bus.add(peer);
  const { contextSession } = hostVariables(["contextSession"], { bus, isWsPeer, definitionOf, claudeSession: () => ({ sessionId: "host-session", launchId: "host-launch" }) });
  expect(contextSession(peer.id)).toBeUndefined(); // recoveryMetadata is not a session authority for a portless peer.
  for (const nativeSession of [undefined, "", "native-session"] as const) { ports(peer, { nativeSession }); expect(contextSession(peer.id)).toBe(nativeSession); }
  const channel = new WsPeer("claude"), socket = { readyState: WebSocket.OPEN, data: {}, send: () => {}, close: () => {} };
  bus.add(channel); channel.claim(socket);
  expect(contextSession(channel.id)).toBeUndefined();
  channel.attach(socket);
  ports(channel, { nativeSession: "cannot-replace-host-proof" });
  expect(contextSession(channel.id)).toBe("host-session:host-launch");
});

test("#625 local memory provenance stays unbound even when its other native session reader is populated", () => {
  const cwd = scratch(), local = new LocalPeer("local", { cwd, omni: new OmniRoute({ urls: [], access_hosts: [] }), fixedModel: "fixture", tools: { deny: [], permit: async () => false } });
  expect(typeof definitionOf("local")!.session.currentId(local)).toBe("string");
  expect("nativeSession" in local).toBe(false);
  const bus = new Bus({ batchMs: 0 }); bus.add(local); cleanup.push(() => bus.closeJournal());
  const recorded: { session: unknown }[] = [];
  const { contextSession, memoryObservations } = hostVariables(["contextSession", "contextPii", "memoryObservations"], {
    bus, isWsPeer, definitionOf, claudeSession: () => { throw new Error("local must not read Claude state"); },
    turns: new Map(), board: { list: () => [], get: () => undefined }, isClosedTaskState, deliveryTask, taskKey, memoryProject: "fixture",
    tasks: { isPii: () => { throw new Error("fixture has no tasks to screen"); } }, MemoryObservations,
    memoryTelemetry: { record: (_text: string, context: { session: unknown }) => recorded.push(context) },
  });
  expect(contextSession(local.id)).toBeUndefined();
  memoryObservations.cite(local.id, `mem:${"a".repeat(32)} fixture`, "message:fixture", [newEnvelope("user", "fixture")]);
  expect(recorded).toHaveLength(1); expect(recorded[0]!.session).toBeNull();
});

test("#625 the Codex resume command keeps its daemon-held fallback and respects an explicit empty port", () => {
  const start = source.indexOf("  function codexResumeCommand("), end = source.indexOf("  function retainedTerminalNotice(", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const bus = new Bus({ batchMs: 0 }); cleanup.push(() => bus.closeJournal());
  const owner = new PlainPeer("codex"); bus.add(owner);
  const resume = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end)) + "\ncodexResumeCommand", { bus, lastCodexThreads: new Map([["codex", "saved-thread"]]), declarations: {} });
  expect(resume("codex")).toBe("ahub codex resume saved-thread");
  ports(owner, { nativeSession: "live-thread" }); expect(resume("codex")).toBe("ahub codex resume live-thread");
  ports(owner, { nativeSession: "" }); expect(resume("codex")).toBe("ahub codex resume");
});
