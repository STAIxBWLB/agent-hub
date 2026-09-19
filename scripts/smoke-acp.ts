// Live smoke: one real ACP round trip. Usage: bun scripts/smoke-acp.ts [cmd...]   (default: kimi acp)
import { AcpPeer } from "../src/adapters/acp.ts";
import { Bus } from "../src/hub/bus.ts";
import { newEnvelope } from "../src/hub/envelope.ts";

const cmd = process.argv.slice(2).length ? process.argv.slice(2) : ["kimi", "acp"];
const bus = new Bus();
const peer = new AcpPeer("kimi", { cmd, cwd: process.cwd(), log: (l) => console.error(l) });
bus.add(peer);
bus.tap((e) => {
  if (e.t === "state") console.log(`state ${e.peer} -> ${e.state}`);
  else console.log(`${e.env.from} (hop ${e.env.hop}): ${e.env.body}`);
  if (e.t === "envelope" && e.env.from === "kimi") void peer.stop().then(() => process.exit(0));
});
const t0 = Date.now();
await peer.start();
console.log(`session ready in ${Date.now() - t0} ms`);
bus.publish(newEnvelope("user", "Reply with exactly the single word: pong", { to: ["kimi"] }));
setTimeout(() => (console.error("timeout"), process.exit(1)), 120_000);
