// Live smoke: real `codex app-server` behind the proxy, with this script standing in for the TUI.
// Usage: bun scripts/smoke-codex.ts   (uses the logged-in Codex account; one short turn)
import { CodexPeer } from "../src/adapters/codex-appserver.ts";
import { Bus } from "../src/hub/bus.ts";
import { newEnvelope } from "../src/hub/envelope.ts";

const bus = new Bus();
const peer = new CodexPeer("codex", { proxyPort: 4692, appPort: 4691, cwd: process.cwd(), log: (l) => console.error(l) });
bus.add(peer);
const done = (code: number) => peer.stop().then(() => process.exit(code));
bus.tap((e) => {
  if (e.t === "state") console.log(`state ${e.peer} -> ${e.state}`);
  else console.log(`${e.env.from} (hop ${e.env.hop}): ${e.env.body}`);
  if (e.t === "envelope" && e.env.from === "codex") void done(0);
});
await peer.start();
const tui = new WebSocket(peer.proxyUrl);
tui.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.id === 1) {
    tui.send(JSON.stringify({ method: "initialized" }));
    tui.send(JSON.stringify({ id: 2, method: "thread/start", params: { cwd: process.cwd() } }));
  } else if (m.id !== undefined && m.method) {
    console.log(`approval request ${m.method} -> declined`);
    tui.send(JSON.stringify({ id: m.id, result: { decision: "decline" } }));
  } else if (m.error) console.error("rpc error", JSON.stringify(m.error));
  else if (process.env.SMOKE_DEBUG && m.method) console.error("<-", m.method, JSON.stringify(m.params).slice(0, 300));
};
tui.onopen = () =>
  tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "agent-hub-smoke", title: "agent-hub smoke", version: "0.1.0" } } }));
await new Promise<void>((r) => bus.tap((e) => e.t === "state" && e.state === "idle" && r()));
bus.publish(newEnvelope("user", "Reply with exactly the single word: pong. Do not run any tools."));
setTimeout(() => (console.error("timeout"), void done(1)), 120_000);
