import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { AcpPeer, type AcpOptions } from "../src/adapters/acp.ts";
import type { AcpModelPolicy } from "../src/adapters/acp-model-policy.ts";
import { sessionModelId, updatedModelId } from "../src/adapters/acp-session-model.ts";
import { Bus } from "../src/hub/bus.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { turnModelFields } from "../src/hub/events.ts";

// #1402 T3: an ACP peer's turn reports the model its session was on when the prompt was sent, as `session` evidence, whatever the override policy.

const FAKE = ["bun", join(import.meta.dir, "fakes/acp-server.ts")];
const peers: AcpPeer[] = [];
afterEach(async () => { for (const peer of peers.splice(0)) await peer.stop(); });
const until = async (cond: () => boolean) => { for (let i = 0; i < 300 && !cond(); i++) await Bun.sleep(10); expect(cond()).toBe(true); };

async function rig(args: string[] = [], extra: Partial<AcpOptions> = {}) {
  const bus = new Bus({ batchMs: 0 }), said: Envelope[] = [];
  bus.tap(e => e.t === "envelope" && e.env.from === "kimi" && said.push(e.env));
  const peer = new AcpPeer("kimi", { cmd: [...FAKE, ...args], cwd: process.cwd(), ...extra });
  peers.push(peer); bus.add(peer); await peer.start();
  const turn = async (text: string) => { const before = said.length; bus.publish(newEnvelope("user", text, { to: ["kimi"] })); await until(() => said.length > before && peer.state === "idle"); };
  return { bus, peer, said, turn };
}

test("an agent that reports models.currentModelId: the turn records it as session evidence, without any override policy", async () => {
  const { peer, turn } = await rig(["--model-id", "kimi-k3"]);
  await turn("one");
  expect(peer.observedModel()).toEqual({ model: "kimi-k3", evidence: "session" });
  expect(turnModelFields(peer.observedModel())).toEqual({}); // read once
  await turn("two");
  expect(turnModelFields(peer.observedModel())).toEqual({ model: "kimi-k3", modelEvidence: "session" });
});

test("an agent that reports the model only as the model select of configOptions is read the same way", async () => {
  const { peer, turn } = await rig(["--model-id", "jcode-model-2", "--model-shape", "config"]);
  await turn("one");
  expect(peer.observedModel()).toEqual({ model: "jcode-model-2", evidence: "session" });
});

test("an agent that reports no model records nothing", async () => {
  const { peer, turn } = await rig();
  await turn("one");
  expect(peer.observedModel()).toBeUndefined();
});

test("a model-update notification moves the session model for the next turn", async () => {
  const { peer, turn } = await rig(["--model-id", "before-1"]);
  await turn("one");
  expect(peer.observedModel()?.model).toBe("before-1");
  const transport = peer as unknown as { onLine(line: string): void; sessionId: string };
  transport.onLine(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: transport.sessionId, update: { sessionUpdate: "current_model_update", currentModelId: "after-2" } } }));
  await turn("two");
  expect(peer.observedModel()).toEqual({ model: "after-2", evidence: "session" });
  // Another session's update, and a hostile id, change nothing.
  transport.onLine(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "foreign", update: { sessionUpdate: "current_model_update", currentModelId: "foreign-9" } } }));
  transport.onLine(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: transport.sessionId, update: { sessionUpdate: "current_model_update", currentModelId: "/etc/passwd" } } }));
  await turn("three");
  expect(peer.observedModel()).toEqual({ model: "after-2", evidence: "session" });
});

test("a model reported after the prompt was sent belongs to the next turn, not the one that ended", async () => {
  const { peer, turn } = await rig(["--model-id", "first-1"]);
  await turn("one");
  const transport = peer as unknown as { onLine(line: string): void; sessionId: string };
  transport.onLine(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: transport.sessionId, update: { sessionUpdate: "current_model_update", currentModelId: "late-2" } } }));
  expect(peer.observedModel()).toEqual({ model: "first-1", evidence: "session" });
});

test("sessionModelId and updatedModelId read only the documented shapes and keep a safe id whole", () => {
  expect(sessionModelId({ models: { currentModelId: "m-1" } })).toBe("m-1");
  expect(sessionModelId({ configOptions: [{ id: "model", type: "select", currentValue: "m-2" }] })).toBe("m-2");
  expect(sessionModelId({ models: { currentModelId: "m-1" }, configOptions: [{ id: "model", type: "select", currentValue: "m-2" }] })).toBe("m-1");
  expect(updatedModelId({ currentModelId: "m-3" })).toBe("m-3");
  expect(updatedModelId({ configOptions: [{ id: "model", type: "select", currentValue: "m-4" }] })).toBe("m-4");
  const long = "m".repeat(161);
  for (const bad of [undefined, null, "x", [], {}, { models: {} }, { models: { currentModelId: 7 } }, { models: { currentModelId: "has space" } }, { models: { currentModelId: "/etc/passwd" } },
    { models: { currentModelId: long } }, { models: { currentModelId: "unknown" } }, { configOptions: [] }, { configOptions: "model" },
    { configOptions: [{ id: "model", type: "text", currentValue: "m" }] }, { configOptions: [{ id: "model", type: "select", currentValue: "a" }, { id: "model", type: "select", currentValue: "b" }] }])
    expect(sessionModelId(bad)).toBeUndefined();
  expect(updatedModelId(undefined)).toBeUndefined();
  expect(updatedModelId({ currentModelId: "ok\nbad" })).toBeUndefined();
});

test("Qwen's provider-qualified wire id is read through its receipt codec, and an id the codec cannot read names no model", () => {
  const policy = { admission: { nativeIdentity: true }, agentName: "Qwen Code", version: "0.27.0", setter: "set_model", receipt: "synthetic-test-only", idCodec: "qwen-openai" } as AcpModelPolicy;
  expect(sessionModelId({ models: { currentModelId: "qwen-max(openai)" } }, policy)).toBe("qwen-max");
  expect(sessionModelId({ models: { currentModelId: "qwen-max" } }, policy)).toBeUndefined();
  expect(updatedModelId({ currentModelId: "qwen-plus(openai)" }, policy)).toBe("qwen-plus");
});
