import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalPeer } from "../../src/adapters/local-worker.ts";
import type { PiPeer } from "../../src/adapters/pi.ts";
import { OmniRoute } from "../../src/omniroute/client.ts";
import { newEnvelope } from "../../src/hub/envelope.ts";
import { startFakeModelServer, toolCall } from "../fakes/model-server.ts";
import { until } from "./kit.ts";
import { createRegisteredPeer, expire } from "./factories.ts";


test("P4 local: a consumed model result from an expired generation cannot publish into the next turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "conformance-local-late-"));
  let release = () => {}, observed = false, parsed = () => {};
  const parsedLate = new Promise<void>(resolve => { parsed = resolve; });
  const server = startFakeModelServer({ key: "conformance-key", script: async body => {
    const text = String(body.messages.at(-1)?.content);
    if (text.includes("OLD_GENERATION")) await new Promise<void>(resolve => { release = resolve; observed = true; });
    return { content: text.includes("OLD_GENERATION") ? "stale answer" : "current answer" };
  } });
  const oldUrl = process.env.AGENTHUB_OMNIROUTE_URL, oldKey = process.env.OMNIROUTE_API_KEY;
  process.env.AGENTHUB_OMNIROUTE_URL = server.url; process.env.OMNIROUTE_API_KEY = "conformance-key";
  const omni = new OmniRoute({ urls: [server.url], access_hosts: [] }), chat = omni.chat.bind(omni);
  omni.chat = async (body, options = {}) => {
    const old = String(body.messages.at(-1)?.content).includes("OLD_GENERATION");
    const result = await chat(body, old ? { ...options, signal: undefined } : options);
    if (old) parsed(); return result;
  };
  const messages: string[] = [];
  const peer = createRegisteredPeer<LocalPeer>("local", { local: { cwd: dir, omni, fixedModel: "vllm/fixed", tools: { deny: [], permit: async () => false } } });
  peer.onMessage = text => { messages.push(text); };
  let oldTurn: Promise<void> | undefined;
  try {
    await peer.start(); oldTurn = peer.deliver([newEnvelope("user", "OLD_GENERATION")]); oldTurn.catch(() => {});
    await until(() => observed, "old gateway call held"); expire(peer);
    expect(peer.state).toBe("idle");
    await peer.deliver([newEnvelope("user", "CURRENT_GENERATION")]);
    await until(() => messages.length === 1, "new generation publishes");
    release(); await parsedLate; await oldTurn; await new Promise<void>(resolve => setImmediate(resolve));
    expect(messages).toEqual(["current answer"]); expect(peer.state).toBe("idle");
  } finally { release(); await peer.stop(); await oldTurn?.catch(() => {}); server.stop();
    if (oldUrl === undefined) delete process.env.AGENTHUB_OMNIROUTE_URL; else process.env.AGENTHUB_OMNIROUTE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = oldKey;
    rmSync(dir, { recursive: true, force: true }); }
});

test("P4 local: tool approval refusal prevents the write and hub tools use the host callback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "conformance-local-approval-")), path = join(dir, "a.txt"); writeFileSync(path, "before");
  const asked: string[] = [], called: string[] = [];
  const server = startFakeModelServer({ key: "conformance-key", script: body => {
    const tools = body.messages.filter(message => message.role === "tool").length;
    return tools === 0 ? { tool_calls: [toolCall("write", { path: "a.txt", content: "after" })] }
      : tools === 1 ? { tool_calls: [toolCall("hub_task_list", {})] } : { content: "done" };
  } });
  const oldUrl = process.env.AGENTHUB_OMNIROUTE_URL, oldKey = process.env.OMNIROUTE_API_KEY;
  process.env.AGENTHUB_OMNIROUTE_URL = server.url; process.env.OMNIROUTE_API_KEY = "conformance-key";
  const peer = createRegisteredPeer<LocalPeer>("local", { local: { cwd: dir, omni: new OmniRoute({ urls: [server.url], access_hosts: [] }), fixedModel: "vllm/fixed",
    tools: { deny: [], permit: async title => { asked.push(title); return false; } }, taskTool: async name => { called.push(name); return "[]"; } } });
  try {
    await peer.start(); await peer.deliver([newEnvelope("user", "edit and list tasks")]);
    await until(() => peer.state === "idle", "local tools settled");
    expect(readFileSync(path, "utf8")).toBe("before"); expect(asked).toHaveLength(1); expect(called).toEqual(["hub_task_list"]);
  } finally { await peer.stop(); server.stop(); if (oldUrl === undefined) delete process.env.AGENTHUB_OMNIROUTE_URL; else process.env.AGENTHUB_OMNIROUTE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = oldKey;
    rmSync(dir, { recursive: true, force: true }); }
});

test("P4 Pi: recovery resumes its exact persisted session and rejects a stale bridge generation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "conformance-pi-resume-")), stateDir = join(dir, "state"), sessions = join(stateDir, "pi-sessions");
  mkdirSync(sessions, { recursive: true });
  const sessionFile = join(sessions, "saved-session.jsonl"); writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "saved-session", cwd: dir }) + "\n");
  const peer = createRegisteredPeer<PiPeer>("pi", { pi: { cwd: dir, stateDir, sessionFile, mode: "headless", backend: "dgx", cmd: [process.execPath, join(import.meta.dir, "../fakes/pi-rpc.ts")],
    relay: { url: "http://127.0.0.1:9/v1", token: "fixture", models: [{ id: "dgx/coding" }] }, tools: [], executeTool: async () => "fixture" } });
  const messages: string[] = []; peer.onMessage = text => { messages.push(text); };
  try {
    await peer.start(); expect(peer.recoveryMetadata()).toMatchObject({ sessionId: "saved-session", sessionFile });
    const launch = peer.tuiLaunch!;
    const event = async (body: unknown) => fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/event`, { method: "POST", headers: { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    await peer.deliver([newEnvelope("user", "resumed turn")]);
    expect((await event({ type: "agent_start", generation: 3, sessionId: "saved-session" })).status).toBe(200);
    await event({ type: "agent_end", generation: 2, text: "stale answer" });
    await event({ type: "agent_settled", generation: 2 });
    expect(peer.state).toBe("busy"); expect(messages).toEqual([]);
    await event({ type: "agent_end", generation: 3, text: "current answer" });
    await event({ type: "agent_settled", generation: 3 });
    expect(peer.state).toBe("idle"); expect(messages).toEqual(["current answer"]);
  } finally { await peer.stop(); rmSync(dir, { recursive: true, force: true }); }
});
