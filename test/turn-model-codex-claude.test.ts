import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ClaudePrintPeer } from "../src/adapters/claude-print.ts";
import { ClaudeImplementerPeer } from "../src/adapters/claude-implementer.ts";
import { CodexPeer } from "../src/adapters/codex-appserver.ts";
import { resultModel } from "../src/adapters/print-result-model.ts";
import { Bus } from "../src/hub/bus.ts";
import { HUB, newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { turnModelFields } from "../src/hub/events.ts";
import { startFakeAppServer } from "./fakes/app-server.ts";

// #1402 T2: Codex and Claude print turns report the model their native surface named, with the grade it supports.

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const until = async (ok: () => boolean) => { for (let i = 0; i < 300 && !ok(); i++) await Bun.sleep(10); expect(ok()).toBe(true); };

async function codex() {
  const fake = startFakeAppServer(5);
  const bus = new Bus({ batchMs: 0 });
  const said: Envelope[] = [];
  bus.tap(e => e.t === "envelope" && e.env.from === "codex" && said.push(e.env));
  const peer = new CodexPeer("codex", { proxyPort: 0, appPort: 0, upstreamUrl: fake.url, cwd: process.cwd() });
  bus.add(peer); await peer.start();
  cleanup.push(fake.stop, () => peer.stop());
  const tui = new WebSocket(peer.proxyUrl);
  const seen: any[] = [];
  tui.onmessage = ev => seen.push(JSON.parse(String(ev.data)));
  await new Promise(r => (tui.onopen = r));
  cleanup.push(() => tui.close());
  tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "fake-tui" } } }));
  return { bus, peer, said, tui, seen };
}

test("Codex: the thread/start reply's model is the turn's session model; no served grade is claimed", async () => {
  const { bus, peer, said, tui } = await codex();
  expect(peer.observedModel()).toBeUndefined(); // nothing reported before a thread exists
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  bus.publish(newEnvelope(HUB, "work", { to: ["codex"] }));
  await until(() => said.length === 1);
  expect(peer.observedModel()).toEqual({ model: "fake", evidence: "session" });
  expect(turnModelFields(peer.observedModel())).toEqual({ model: "fake", modelEvidence: "session" });
});

test("Codex: a resumed thread reports its model too", async () => {
  const { peer, tui } = await codex();
  tui.send(JSON.stringify({ id: 2, method: "thread/resume", params: { threadId: "th9" } }));
  await until(() => peer.state === "idle");
  expect(peer.observedModel()).toEqual({ model: "fake", evidence: "session" });
});

test("Codex: a model/rerouted notification names the served model for that turn only", async () => {
  const { bus, peer, said, tui } = await codex();
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  bus.publish(newEnvelope(HUB, "REROUTE:gpt-safe-1", { to: ["codex"] }));
  await until(() => said.length === 1);
  expect(peer.observedModel()).toEqual({ model: "gpt-safe-1", evidence: "served" });
  // Read once: the next turn falls back to the session model until Codex reroutes again.
  expect(peer.observedModel()).toEqual({ model: "fake", evidence: "session" });
});

test("Codex: an accepted hub-chosen model on turn/start becomes the session model", async () => {
  const fake = startFakeAppServer(5);
  const bus = new Bus({ batchMs: 0 });
  const said: Envelope[] = [];
  bus.tap(e => e.t === "envelope" && e.env.from === "codex" && said.push(e.env));
  const peer = new CodexPeer("codex", { proxyPort: 0, appPort: 0, upstreamUrl: fake.url, cwd: process.cwd(),
    getModelOverride: () => ({ model: "provider/override-1", applied: () => {} }) as never });
  bus.add(peer); await peer.start();
  cleanup.push(fake.stop, () => peer.stop());
  const tui = new WebSocket(peer.proxyUrl);
  await new Promise(r => (tui.onopen = r)); cleanup.push(() => tui.close());
  tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "fake-tui" } } }));
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  bus.publish(newEnvelope(HUB, "work", { to: ["codex"] }));
  await until(() => said.length === 1);
  expect(peer.observedModel()).toEqual({ model: "provider/override-1", evidence: "session" });
});

test("resultModel: one safe key is the model; several name the one with strictly more tokens; ties, hostile and absent shapes name none", () => {
  const row = (modelUsage: unknown) => ({ type: "result", subtype: "success", modelUsage });
  expect(resultModel(row({ "claude-opus-5-5": { inputTokens: 10, outputTokens: 5 } }))).toBe("claude-opus-5-5");
  expect(resultModel(row({ "claude-opus-5-5": { inputTokens: 900, outputTokens: 100 }, "claude-haiku-5": { inputTokens: 30, outputTokens: 5 } }))).toBe("claude-opus-5-5");
  // A real entry also carries model limits; they never decide which model handled the turn.
  const real = (inputTokens: number, outputTokens: number, maxOutputTokens: number) => ({ inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.01, contextWindow: 200000, maxOutputTokens });
  expect(resultModel(row({ "big-model-1": real(100, 10, 8000), "small-model-1": real(500, 50, 64000) }))).toBe("small-model-1");
  expect(resultModel(row({ a1: { inputTokens: 5 }, b1: { inputTokens: 5 } }))).toBeUndefined();
  expect(resultModel(row({ a1: { maxOutputTokens: 9000 }, b1: { maxOutputTokens: 1 } }))).toBeUndefined();
  expect(resultModel(row({ a1: {}, b1: {} }))).toBeUndefined();
  expect(resultModel(row({ "/etc/passwd": { inputTokens: 9 } }))).toBeUndefined();
  expect(resultModel(row({ "has space": { inputTokens: 9 }, ok1: { inputTokens: 1 } }))).toBe("ok1");
  expect(resultModel(row({ unknown: { inputTokens: 9 } }))).toBeUndefined();
  for (const bad of [undefined, null, 7, "x", [], { type: "result" }, row(undefined), row(null), row([]), row("claude")]) expect(resultModel(bad)).toBeUndefined();
});

test("Claude print: a reviewer turn reports the served model from the result's modelUsage; a result without it reports nothing", async () => {
  const FAKE = resolve(import.meta.dir, "fakes/fake-claude-print.ts");
  const dir = mkdtempSync(join(tmpdir(), "ahub-turn-model-claude-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const set = (values: Record<string, string | undefined>) => {
    const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    for (const [k, v] of Object.entries(values)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    cleanup.push(() => { for (const [k, v] of Object.entries(before)) v === undefined ? delete process.env[k] : (process.env[k] = v); });
  };
  const run = async (modelUsage: unknown) => {
    set({ FAKE_CLAUDE_ACTION: "none", FAKE_CLAUDE_LOG: join(dir, "calls.jsonl"), FAKE_CLAUDE_MODEL_USAGE: modelUsage === undefined ? undefined : JSON.stringify(modelUsage) });
    const peer = new ClaudePrintPeer("claude-review", { cwd: dir, command: [process.execPath, FAKE], mcpConfig: "{}", systemPrompt: "role", watchdogMs: 5000, verdictSince: () => true });
    cleanup.push(() => peer.stop());
    await peer.start();
    await peer.deliver([newEnvelope(HUB, "Review task #1 fixture", { to: ["claude-review"], kind: "review", refs: { task: "1" } })], "d1");
    await until(() => peer.state === "idle");
    return peer;
  };
  const withModel = await run({ "claude-opus-5-5": { inputTokens: 10, outputTokens: 5 } });
  expect(withModel.observedModel()).toEqual({ model: "claude-opus-5-5", evidence: "served" });
  expect(withModel.observedModel()).toBeUndefined(); // read once
  const without = await run(undefined);
  expect(without.observedModel()).toBeUndefined();
});

test("Claude implementer: the result row's modelUsage is the served model of the turn, read once", async () => {
  const fake = resolve(import.meta.dir, "fakes/fake-claude-implementer.ts");
  const dir = mkdtempSync(join(tmpdir(), "ahub-turn-model-impl-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const before = process.env.FAKE_CLAUDE_MODEL_USAGE;
  cleanup.push(() => { if (before === undefined) delete process.env.FAKE_CLAUDE_MODEL_USAGE; else process.env.FAKE_CLAUDE_MODEL_USAGE = before; });
  const run = async (modelUsage: unknown) => {
    if (modelUsage === undefined) delete process.env.FAKE_CLAUDE_MODEL_USAGE; else process.env.FAKE_CLAUDE_MODEL_USAGE = JSON.stringify(modelUsage);
    const peer = new ClaudeImplementerPeer("claude-worker", { cwd: dir, stateDir: dir, projectRoot: dir, instanceId: "fixture-instance", server: join(dir, "server.js"), factsHook: join(dir, "hook.ts"), systemPrompt: "role", watchdogMs: 5000,
      command: [process.execPath, fake, join(dir, "calls.jsonl"), "success"], admit: () => true, chatTask: () => undefined, prove: async () => () => true } as never);
    cleanup.push(() => peer.stop());
    await peer.start();
    await peer.deliver([newEnvelope(HUB, "do the work", { to: ["claude-worker"], refs: { task: "9" } })], "d1");
    await until(() => peer.state === "idle");
    return peer;
  };
  const peer = await run({ "claude-sonnet-5": { inputTokens: 7, outputTokens: 3 } });
  expect(peer.observedModel()).toEqual({ model: "claude-sonnet-5", evidence: "served" });
  expect(peer.observedModel()).toBeUndefined();
  expect((await run(undefined)).observedModel()).toBeUndefined();
});

test("Codex: a reroute for a retired turn, after a fenced cancellation, or left unread never becomes a later turn's served model", async () => {
  const { bus, peer, said, tui } = await codex();
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  const internal = peer as unknown as { link: unknown; threadId: string; retiredTurns: Set<string>; unidentifiedCancellation: boolean; onNotification(link: unknown, method: string, params: unknown): void };
  const reroute = (turnId: string, toModel: string) => internal.onNotification(internal.link, "model/rerouted", { threadId: internal.threadId, turnId, fromModel: "fake", toModel, reason: "x" });
  // A turn the watchdog retired.
  internal.retiredTurns.add("old-turn");
  reroute("old-turn", "leaked-retired");
  expect(peer.observedModel()).toEqual({ model: "fake", evidence: "session" });
  // An unidentified cancellation fences hub attribution altogether.
  internal.unidentifiedCancellation = true;
  reroute("turn-x", "leaked-fenced");
  expect(peer.observedModel()).toEqual({ model: "fake", evidence: "session" });
  internal.unidentifiedCancellation = false;
  // A live reroute whose turn end was never read is dropped when the next turn starts.
  reroute("turn-y", "unread-reroute");
  bus.publish(newEnvelope(HUB, "plain", { to: ["codex"] }));
  await until(() => said.length === 1);
  expect(peer.observedModel()).toEqual({ model: "fake", evidence: "session" });
});
