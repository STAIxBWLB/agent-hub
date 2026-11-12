import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeAgyHook } from "../src/adapters/agy/hooks.ts";
import { PiPeer } from "../src/adapters/pi.ts";
import { stateModelId } from "../src/adapters/pi-state-model.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { readEvents } from "../src/hub/events.ts";

// #1402 T4: Pi reports the model of its get_state, Antigravity the modelName its hook payloads carry; both as `session` evidence, and nothing when the source has none.

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const until = async (ok: () => boolean) => { for (let i = 0; i < 300 && !ok(); i++) await Bun.sleep(10); expect(ok()).toBe(true); };

test("stateModelId reads data.model.id only: a safe id stays whole, the Pi placeholder and hostile shapes name none", () => {
  expect(stateModelId({ model: { id: "dgx/coding", name: "x", provider: "agent-hub-local" } })).toBe("dgx/coding");
  const long = "m".repeat(161);
  for (const bad of [undefined, null, "x", [], {}, { model: null }, { model: "dgx" }, { model: [] }, { model: {} }, { model: { id: 7 } }, { model: { id: "unknown", provider: "unknown" } },
    { model: { id: "has space" } }, { model: { id: "/etc/passwd" } }, { model: { id: long } }, { model: { id: "ok\nbad" } }]) expect(stateModelId(bad)).toBeUndefined();
});

async function pi(args: string[], extra: Record<string, unknown> = {}) {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-model-test-"));
  const peer = new PiPeer("pi", { cwd: process.cwd(), stateDir, mode: "headless", backend: "dgx", cmd: ["bun", join(import.meta.dir, "fakes/pi-rpc.ts"), ...args],
    relay: { url: "http://127.0.0.1:9/v1", token: "relay-token", models: [{ id: "dgx/coding" }] }, tools: [], executeTool: async () => "ok", ...extra } as never);
  cleanup.push(async () => { await peer.stop(); rmSync(stateDir, { recursive: true, force: true }); });
  await peer.start();
  return peer;
}

test("Pi headless: the turn records the get_state model as session evidence, read once", async () => {
  const peer = await pi(["--model-id", "dgx/coding"]);
  await peer.deliver([newEnvelope("user", "hello", { to: ["pi"] })]);
  expect(peer.observedModel()).toEqual({ model: "dgx/coding", evidence: "session" });
  expect(peer.observedModel()).toBeUndefined();
});

test("Pi headless: no model in get_state records nothing, and a model the hub set is only configured", async () => {
  const none = await pi([]);
  await none.deliver([newEnvelope("user", "hello", { to: ["pi"] })]);
  expect(none.observedModel()).toBeUndefined();
  const set = await pi([], { model: "dgx/coding", selectModel: async () => "dgx/coding" });
  await set.deliver([newEnvelope("user", "hello", { to: ["pi"] })]);
  expect(set.observedModel()).toEqual({ model: "dgx/coding", evidence: "configured" });
});

test("Antigravity: the hook payload's modelName is carried when safe, and an alias is kept as reported", () => {
  const payload = { conversationId: "ee5ab2ab-7319-4a81-82ca-bf2fc84678d0", transcriptPath: "/tmp/t/transcript_full.jsonl", workspacePaths: ["/tmp/w"], invocationNum: 0 };
  expect(decodeAgyHook("PreInvocation", { ...payload, modelName: "gemini-4-argon-medium" })?.model).toBe("gemini-4-argon-medium");
  expect(decodeAgyHook("PreInvocation", { ...payload, modelName: "default" })?.model).toBe("default");
  for (const bad of [undefined, null, 7, "", "unknown", "has space", "/etc/passwd", "m".repeat(161), "ok\nbad", {}]) {
    const decoded = decodeAgyHook("PreInvocation", { ...payload, modelName: bad });
    expect(decoded).toBeDefined();
    expect("model" in decoded!).toBe(false);
  }
  expect("model" in decodeAgyHook("PreInvocation", payload)!).toBe(false);
});

test("Antigravity through the daemon: the turn_end carries the hook's model as session evidence, and a turn whose hooks name none carries neither field", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-agy-model-")), stateDir = join(root, "state"), savedHome = process.env.HOME;
  process.env.HOME = root;
  const session = "ee5ab2ab-7319-4a81-82ca-bf2fc84678d0";
  const logs = join(root, ".gemini/antigravity-cli/brain", session, ".system_generated/logs"), transcript = join(logs, "transcript_full.jsonl");
  mkdirSync(logs, { recursive: true }); writeFileSync(transcript, "");
  mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ roster: { agy: true }, memory: { enabled: false, native: false }, snapshots: { enabled: false } }));
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: {
    ...DEFAULT_CONFIG, roster: { agy: true }, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
    inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
    snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false } } });
  const person = await ControlClient.connect(stateDir, { role: "console" });
  const tools = await ControlClient.connect(stateDir, { role: "tools", peer: "agy" });
  let peer: ControlClient | undefined;
  cleanup.push(async () => { peer?.close(); tools.close(); person.close(); await daemon.stop(); if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome; rmSync(root, { recursive: true, force: true }); });
  const admission = await person.request({ t: "native_hook_launch", op: "begin", peer: "agy" });
  expect(admission.ok).toBe(true);
  peer = await ControlClient.connect(stateDir, { role: "peer", peer: "agy", channel: false });
  await until(() => daemon.bus.peers.get("agy")?.state === "idle");
  const payload = { conversationId: session, transcriptPath: transcript, workspacePaths: [root], invocationNum: 0 };
  const facts = (event: string, extra = {}) => tools.request({ t: "native_facts", event, payload: { ...payload, ...extra }, nativeInstanceId: admission.instanceId, nativeLaunchId: admission.launchId });
  const turnEnds = () => readEvents(join(stateDir, "events.jsonl")).filter((ev: any) => ev.type === "turn_end" && ev.peer === "agy") as any[];
  const turn = async (extra: Record<string, unknown>, step: number) => {
    const before = turnEnds().length;
    daemon.bus.publish(newEnvelope("user", `work ${step}`, { to: ["agy"] }));
    expect((await facts("PreInvocation", extra)).ok).toBe(true);
    writeFileSync(transcript, JSON.stringify({ step_index: step, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: `complete ${step}` }) + "\n");
    expect((await facts("Stop", { ...extra, fullyIdle: true, terminationReason: "NO_TOOL_CALL" })).ok).toBe(true);
    await until(() => turnEnds().length > before);
    return turnEnds().at(-1);
  };
  expect(await turn({ modelName: "gemini-4-argon-medium" }, 2)).toMatchObject({ model: "gemini-4-argon-medium", modelEvidence: "session" });
  const unnamed = await turn({}, 3);
  expect("model" in unnamed).toBe(false); expect("modelEvidence" in unnamed).toBe(false);
});
