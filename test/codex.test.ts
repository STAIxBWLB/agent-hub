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

async function setup() {
  const fake = startFakeAppServer();
  const bus = new Bus();
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
