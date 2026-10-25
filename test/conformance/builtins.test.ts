import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpPeer } from "../../src/adapters/acp.ts";
import type { CodexPeer } from "../../src/adapters/codex-appserver.ts";
import type { JcodePeer } from "../../src/adapters/jcode.ts";
import type { PiPeer } from "../../src/adapters/pi.ts";
import type { LocalPeer } from "../../src/adapters/local-worker.ts";
import { DEFAULT_CONFIG, startDaemon } from "../../src/hub/daemon.ts";
import { ControlClient } from "../../src/hub/control-client.ts";
import { processTable } from "../../src/hub/child-process.ts";
import { OmniRoute } from "../../src/omniroute/client.ts";
import { startFakeAppServer } from "../../src/adapters/conformance/fakes/app-server.ts";
import { startFakeModelServer } from "../../src/adapters/conformance/fakes/model-server.ts";
import { fakePaths } from "../../src/adapters/conformance/fake-paths.ts";
import { registerConformance, registerExternalChannelConformance, until, type ConformanceFixture } from "./kit.ts";
import { ADAPTERS, type AdapterDefinition } from "../../src/adapters/registry.ts";
import { createFromDefinition } from "./factories.ts";
import { assertEnrollment, UNSUPPORTED } from "./enrollment.ts";

const fake = (name: "acp-server.ts" | "jcode-agent.ts" | "pi-rpc.ts") => ({ "acp-server.ts": fakePaths.acpServer, "jcode-agent.ts": fakePaths.jcodeAgent, "pi-rpc.ts": fakePaths.piRpc })[name];
const root = () => mkdtempSync(join(tmpdir(), "ahub-conformance-"));
const lines = (file: string): any[] => readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
const qwen = ["--agent-name", "qwen-code", "--agent-version", "0.25.0", "--modes", "default,auto-edit,yolo"];

const fixtures: Record<string, (definition: AdapterDefinition) => Promise<ConformanceFixture>> = {};
const acpFixture = async (definition: AdapterDefinition): Promise<ConformanceFixture> => {
  const kind = definition.kind;
  const dir = root(), record = join(dir, "rpc"), pid = join(dir, "pid"), messages: string[] = [];
  const peer = createFromDefinition<AcpPeer>(definition, { acp: { cwd: dir, cmd: [process.execPath, fake("acp-server.ts"), "--record-protocol", record, "--record-pid", pid, ...(kind === "qwen" ? qwen : [])], qwen025: kind === "qwen", resumeSessionId: "s1" } });
  peer.onMessage = text => { messages.push(text); };
  try { await peer.start(); } catch (error) { await peer.stop(); rmSync(dir, { recursive: true, force: true }); throw error; }
  return { peer, messages, busyOnDeliver: true,
    verifyTransport() { expect(lines(record).find(row => row.method === "session/load").params.sessionId).toBe("s1"); expect(lines(record).some(row => row.method === "session/prompt")).toBe(true); },
    async close() {
      try { await peer.stop(); const owned = Number(readFileSync(pid, "utf8")); const table = processTable(); expect(table).toBeDefined(); expect(table!.some(row => row.pid === owned || row.pgid === owned)).toBe(false); }
      finally { rmSync(dir, { recursive: true, force: true }); }
    },
  };
};
for (const definition of ADAPTERS.filter(candidate => candidate.transport === "acp" && candidate.start.daemonPort === "acp")) fixtures[definition.kind] = acpFixture;

fixtures.jcode = async (definition) => {
  const dir = root(), home = join(dir, "home"), record = join(dir, "rpc"), messages: string[] = [];
  mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}");
  const peer = createFromDefinition<JcodePeer>(definition, { jcode: { cwd: dir, home, command: [process.execPath, fake("jcode-agent.ts"), "--record", record], resumeSessionId: "saved-jcode" } });
  peer.onMessage = text => { messages.push(text); };
  try { await peer.start(); } catch (error) { await peer.stop(); rmSync(dir, { recursive: true, force: true }); throw error; }
  return { peer, messages, busyOnDeliver: true,
    async verifyTransport() { expect(lines(record).find(row => row.method === "session/load").params.sessionId).toBe("saved-jcode"); expect(peer.permissionModeState).toBe("unmanaged"); await expect(peer.setPermissionMode("ask")).rejects.toThrow("no verified mode mapping"); },
    async close() { try { await peer.stop(); const owned = lines(record).find(row => row.kind === "serve").pid; const table = processTable(); expect(table).toBeDefined(); expect(table!.some(row => row.pid === owned || row.pgid === owned)).toBe(false); } finally { rmSync(dir, { recursive: true, force: true }); } },
  };
};

fixtures.codex = async (definition) => {
  const dir = root(), server = startFakeAppServer(), messages: string[] = [];
  const peer = createFromDefinition<CodexPeer>(definition, { codex: { cwd: dir, appPort: 0, proxyPort: 0, upstreamUrl: server.url } });
  peer.onMessage = text => { messages.push(text); };
  await peer.start();
  const tui = new WebSocket(peer.proxyUrl), seen: any[] = [];
  tui.onmessage = event => seen.push(JSON.parse(String(event.data)));
  await new Promise<void>((resolve, reject) => { tui.onopen = () => resolve(); tui.onerror = () => reject(new Error("fake TUI open")); });
  tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "conformance-tui" } } }));
  await until(() => seen.some(row => row.id === 1), "Codex initializes only through TUI");
  tui.send(JSON.stringify({ id: 2, method: "thread/resume", params: { threadId: "saved-thread" } }));
  await until(() => peer.state === "idle", "Codex adopts resumed thread");
  return { peer, messages, busyOnDeliver: true,
    verifyTransport() { expect(peer.recoveryMetadata().threadId).toBe("saved-thread"); expect(server.requests.find(row => row.method === "turn/start").params.threadId).toBe("saved-thread"); expect(seen.some(row => typeof row.id === "number" && row.id < 0)).toBe(false); },
    async close() { try { tui.close(); await peer.stop(); } finally { server.stop(); rmSync(dir, { recursive: true, force: true }); } },
  };
};

fixtures.pi = async (definition) => {
  const dir = root(), stateDir = join(dir, "state"), messages: string[] = [];
  const peer = createFromDefinition<PiPeer>(definition, { pi: { cwd: dir, stateDir, mode: "headless", backend: "dgx", cmd: [process.execPath, fake("pi-rpc.ts")],
    relay: { url: "http://127.0.0.1:9/v1", token: "fixture", models: [{ id: "dgx/coding" }] }, tools: [], executeTool: async () => "fixture" } });
  peer.onMessage = text => { messages.push(text); };
  try { await peer.start(); } catch (error) { await peer.stop(); rmSync(dir, { recursive: true, force: true }); throw error; }
  const launch = peer.tuiLaunch!;
  const event = async (body: unknown) => { const response = await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/event`, { method: "POST", headers: { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) }); expect(response.status).toBe(200); };
  const metadata = peer.recoveryMetadata();
  const table = processTable(); expect(table).toBeDefined();
  const owners = table!.filter(row => row.ppid === process.pid && row.command.includes(stateDir));
  expect(owners.length).toBeGreaterThan(0);
  return { peer, messages, busyOnDeliver: true,
    async settle() { await event({ type: "agent_end", text: "conformance Pi answer" }); await event({ type: "agent_settled" }); },
    verifyTransport() { expect(peer.recoveryMetadata().sessionId).toBe(metadata.sessionId); expect(typeof metadata.sessionFile).toBe("string"); },
    async close() { try { await peer.stop(); const stopped = processTable(); expect(stopped).toBeDefined(); expect(stopped!.some(row => owners.some(owner => row.pid === owner.pid || row.pgid === owner.pgid))).toBe(false); } finally { rmSync(dir, { recursive: true, force: true }); } },
  };
};

fixtures.local = async (definition) => {
  const dir = root(), messages: string[] = [], server = startFakeModelServer({ key: "conformance-key" });
  const oldUrl = process.env.AGENTHUB_OMNIROUTE_URL, oldKey = process.env.OMNIROUTE_API_KEY;
  process.env.AGENTHUB_OMNIROUTE_URL = server.url; process.env.OMNIROUTE_API_KEY = "conformance-key";
  const key = join(dir, "gateway-key"); writeFileSync(key, "conformance-key");
  const omni = new OmniRoute({ urls: [server.url], access_hosts: [], api_key_file: key });
  const peer = createFromDefinition<LocalPeer>(definition, { local: { cwd: dir, omni, fixedModel: "vllm/fixed", tools: { deny: [], permit: async () => false } } });
  peer.onMessage = text => { messages.push(text); }; await peer.start();
  return { peer, messages, busyOnDeliver: true,
    verifyTransport() { expect(server.requests).toHaveLength(1); expect(JSON.stringify(server.requests[0]!.body)).toContain("conformance ping"); },
    async close() { try { await peer.stop(); } finally { server.stop();
      if (oldUrl === undefined) delete process.env.AGENTHUB_OMNIROUTE_URL; else process.env.AGENTHUB_OMNIROUTE_URL = oldUrl;
      if (oldKey === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = oldKey;
      rmSync(dir, { recursive: true, force: true }); } },
  };
};

fixtures.claude = async (definition) => {
  // External channel ownership stays in the real daemon; no driven constructor is invented for it.
  expect(definition.start.create).toBeUndefined();
  const dir = root(), stateDir = join(dir, "state"), messages: string[] = [], delivered: any[] = [];
  const daemon = await startDaemon({ cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } });
  const channel = await ControlClient.connect(stateDir, { role: "peer", peer: "claude", channel: true });
  channel.onPush = message => { if (message.t === "deliver") delivered.push(message); };
  await until(() => daemon.bus.stateOf("claude") === "idle", "Claude fake channel attached");
  delivered.length = 0;
  const peer = daemon.bus.peers.get("claude")!;
  return { peer, messages, busyOnDeliver: false,
    async settle() { await until(() => delivered.length > 0, "Claude channel consumed insertion"); const result = await channel.request({ t: "send", body: "conformance Claude answer" }); expect(result.ok).toBe(true); messages.push("conformance Claude answer"); },
    verifyTransport() { expect(delivered).toHaveLength(1); expect(delivered[0].envs[0].body).toBe("conformance ping"); },
    async close() { try { channel.close(); await daemon.stop(); } finally { rmSync(dir, { recursive: true, force: true }); } },
  };
};


test("#451 all registry kinds and reviewer variants have explicit conformance enrollment", () => {
  assertEnrollment(ADAPTERS, Object.keys(fixtures), UNSUPPORTED);
});
for (const definition of ADAPTERS) {
  const create = fixtures[definition.kind];
  if (create) (definition.attach?.externalHello ? registerExternalChannelConformance : registerConformance)({ kind: definition.kind, definition, create: () => create(definition) });
  else test(`P4 ${definition.kind}: explicitly unsupported generic driven legs`, () => {
    expect(UNSUPPORTED[definition.kind]?.trim()).not.toBeEmpty();
  });
}
