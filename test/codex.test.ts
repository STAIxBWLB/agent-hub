import { afterEach, expect, test } from "bun:test";
import { CodexPeer } from "../src/adapters/codex-appserver.ts";
import { Bus } from "../src/hub/bus.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { startFakeAppServer } from "./fakes/app-server.ts";

const cleanup: (() => unknown)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(10);
  expect(cond()).toBe(true);
};

async function setup(turnMs?: number) {
  const fake = startFakeAppServer(turnMs);
  const bus = new Bus({ batchMs: 0 });
  const said: Envelope[] = [];
  bus.tap((e) => e.t === "envelope" && e.env.from === "codex" && said.push(e.env));
  const peer = new CodexPeer("codex", { proxyPort: 0, appPort: 0, upstreamUrl: fake.url, cwd: process.cwd() });
  bus.add(peer);
  await peer.start();
  cleanup.push(fake.stop, () => peer.stop());

  // A minimal TUI: handshake, then start a thread through the proxy.
  const seen: any[] = [];
  const tui = new WebSocket(peer.proxyUrl);
  tui.onmessage = (ev) => seen.push(JSON.parse(String(ev.data)));
  await new Promise((r) => (tui.onopen = r));
  cleanup.push(() => tui.close());
  tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "fake-tui" } } }));
  return { bus, peer, said, tui, seen };
}

test("offline until the TUI starts a thread, then idle", async () => {
  const { peer, tui, seen } = await setup();
  await until(() => seen.some((m) => m.id === 1));
  expect(peer.state).toBe("offline");
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  expect(seen.find((m) => m.id === 2).result.thread.id).toBe("th1"); // proxy is transparent
});

test("idle injection uses turn/start with a negative id; only the final answer is shared", async () => {
  const { bus, peer, said, tui, seen } = await setup();
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");

  const env = newEnvelope("claude", "review the diff");
  bus.publish(env);
  await until(() => said.length === 1);
  expect(said[0]!.body).toBe("echo: review the diff");
  expect(said[0]!.hop).toBe(1);
  expect(said[0]!.trace).toBe(env.trace);
  expect(peer.state).toBe("idle");
  // The TUI sees the turn's notifications but never the response to the hub's own request.
  await until(() => seen.some((m) => m.method === "turn/completed")); // forwarded after the hub handled it
  expect(seen.some((m) => typeof m.id === "number" && m.id < 0)).toBe(false);
});

test("Codex correlates acceptance and silent completion to the native turn id", async () => {
  const { peer, tui } = await setup();
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  const receipts: { id: string; state: string }[] = [];
  peer.onDelivery = (r) => receipts.push({ id: r.id, state: r.state });
  await peer.deliver([newEnvelope("claude", "hello")], "codex-delivery");
  expect(receipts).toEqual([{ id: "codex-delivery", state: "accepted" }]);
  await until(() => receipts.some((r) => r.state === "completed"));
  expect(receipts).toEqual([
    { id: "codex-delivery", state: "accepted" },
    { id: "codex-delivery", state: "completed" },
  ]);
});

test("a turn typed in the TUI makes the peer busy; hub messages queue until turn/completed", async () => {
  const { bus, peer, said, tui } = await setup();
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");

  tui.send(JSON.stringify({ id: 3, method: "turn/start", params: { threadId: "th1", input: [{ type: "text", text: "user typed" }] } }));
  await until(() => peer.state === "busy");
  bus.publish(newEnvelope("kimi", "queued one"));
  expect(bus.queued("codex")).toBe(1);

  await until(() => said.length === 2);
  expect(said[0]!.body).toBe("echo: user typed");
  expect(said[0]!.hop).toBe(0); // the user started that turn, not the hub
  expect(said[1]!.body).toBe("echo: queued one");
});

test("important while a turn runs goes in as turn/steer with the running turn's id; status waits for turn/completed", async () => {
  const { bus, peer, said, tui, seen } = await setup(150);
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  tui.send(JSON.stringify({ id: 3, method: "turn/start", params: { threadId: "th1", input: [{ type: "text", text: "long job" }] } }));
  await until(() => peer.state === "busy");

  const urgent = newEnvelope("claude", "wrong branch", { priority: "important", inReplyTo: { trace: "t", hop: 1 } });
  bus.publish(urgent);
  bus.publish(newEnvelope("kimi", "minor note"));
  expect(bus.queued("codex")).toBe(1); // only the status one waits

  await until(() => said.length === 2);
  expect(said[0]!.body).toBe("echo: long job +steered: wrong branch");
  expect(said[0]!.trace).toBe("t"); // the user's turn now also answers the hub
  expect(said[0]!.hop).toBe(urgent.hop + 1);
  expect(said[1]!.body).toBe("echo: minor note");
  expect(seen.some((m) => typeof m.id === "number" && m.id < 0)).toBe(false);
});

test("a steered high-hop message cannot reset the hop cap, and an unanswered steer comes back to the queue", async () => {
  const { bus, peer, said, tui } = await setup(150);
  const dropped: Envelope[] = [];
  bus.tap((e) => e.t === "envelope" && e.dropped === "hop" && dropped.push(e.env));
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");

  bus.publish(newEnvelope("claude", "start", { priority: "important" })); // hub-started turn, hop 0
  await until(() => peer.state === "busy");
  await Bun.sleep(40); // let turn/started announce the turn id
  bus.publish(newEnvelope("kimi", "ping", { priority: "important", inReplyTo: { trace: "loop", hop: 2 } })); // hop 3
  bus.publish(newEnvelope("kimi", "SILENT", { priority: "important" })); // app-server never answers this steer
  await until(() => dropped.length === 1);
  expect(dropped[0]!.body).toBe("echo: start +steered: ping");
  expect(dropped[0]!.hop).toBe(4);

  await until(() => said.length === 2); // the abandoned steer was re-queued and got a turn of its own
  expect(said[1]!.body).toBe("echo: SILENT");
});

test("a refused steer is not lost: it is delivered when the peer goes idle", async () => {
  const { bus, peer, said, tui } = await setup();
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  // busy because the hub claimed the turn, but app-server has not announced a turn id yet: nothing to steer
  bus.publish(newEnvelope("claude", "first"));
  bus.publish(newEnvelope("claude", "urgent", { priority: "important" }));
  await until(() => said.length === 2);
  expect(said.map((e) => e.body)).toEqual(["echo: first", "echo: urgent"]);
});

test("usage: rate limits are read through the TUI's connection without the TUI seeing it; a refused turn reports a hard limit", async () => {
  const fake = startFakeAppServer();
  const bus = new Bus({ batchMs: 0 });
  const usage: { rl: any; hard: boolean }[] = [];
  const peer = new CodexPeer("codex", { proxyPort: 0, appPort: 0, upstreamUrl: fake.url, cwd: process.cwd(), onUsage: (rl, hard) => usage.push({ rl, hard }) });
  bus.add(peer);
  await peer.start();
  cleanup.push(fake.stop, () => peer.stop());
  const seen: any[] = [];
  const tui = new WebSocket(peer.proxyUrl);
  tui.onmessage = (ev) => seen.push(JSON.parse(String(ev.data)));
  await new Promise((r) => (tui.onopen = r));
  cleanup.push(() => tui.close());
  tui.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => usage.length === 1);
  expect(usage[0]).toMatchObject({ hard: false, rl: { primary: { usedPercent: 93 } } });
  expect(seen.some((m) => typeof m.id === "number" && m.id < 0)).toBe(false);

  bus.publish(newEnvelope("claude", "QUOTA", { priority: "important" }));
  await until(() => usage.some((u) => u.hard));
  expect(usage.at(-1)!.rl).toEqual({ rateLimitReachedType: "usageLimitExceeded" });
  await until(() => peer.state === "idle");
});

test("TUI detach takes the peer offline and keeps queued messages", async () => {
  const { bus, peer, tui } = await setup();
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  tui.close();
  await until(() => peer.state === "offline");
  bus.publish(newEnvelope("kimi", "while away"));
  expect(bus.queued("codex")).toBe(1);
});

test("browser origins are refused", async () => {
  const { peer } = await setup();
  const res = await fetch(peer.proxyUrl.replace("ws:", "http:"), { headers: { origin: "https://evil.example" } });
  expect(res.status).toBe(403);
});

test("only one TUI can claim a hub, even before the first thread starts", async () => {
  const { peer, tui } = await setup();
  const second = new WebSocket(peer.proxyUrl);
  const closed = new Promise<CloseEvent>((resolve) => (second.onclose = resolve));
  const event = await closed;
  expect(event.code).toBe(1013);
  expect(event.reason).toContain("already attached");
  tui.close();
});
