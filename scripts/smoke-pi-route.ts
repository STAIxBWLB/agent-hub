// Explicit live Pi + hub/auto smoke. No project tools or existing hub processes are touched.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiPeer } from "../src/adapters/pi.ts";
import { loadConfig } from "../src/hub/daemon.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { startModelRelay } from "../src/models/relay.ts";
import { OmniRoute } from "../src/omniroute/client.ts";
const config = loadConfig(process.env.AHUB_SMOKE_PROJECT ?? process.cwd());
const root = mkdtempSync(join(tmpdir(), "ahub-pi-route-smoke-"));
const choices: string[] = [];
const omni = new OmniRoute(config.omniroute);
let peer: PiPeer | undefined;
const relay = await startModelRelay({ omni, allowedDGXmodels: { "dgx/fast": config.pi.dgx_fast, "dgx/coding": config.pi.dgx_coding }, mlx: config.mlx, enableHubAuto: true, fallbackDGXAlias: "dgx/fast", onRoute: e => choices.push(e.tier), routeSessionKey: () => { const id = peer?.recoveryMetadata().sessionId; return typeof id === "string" ? id : undefined; } });
try {
  peer = new PiPeer("pi", { cwd: root, stateDir: root, mode: "headless", backend: "auto", model: "hub/auto", cmd: process.env.PI_BIN ? [process.env.PI_BIN] : config.pi.cmd, relay: { url: relay.url, token: relay.token, models: relay.models.map(id => ({ id, contextWindow: id === "hub/auto" ? 8192 : config.pi.backend === "mlx" ? 8192 : 262144, maxTokens: 128 })) }, tools: [], executeTool: async () => { throw new Error("No tools are allowed in the smoke"); }, maxSteps: 2, watchdogMs: 120_000 });
  let answer = "", failed = false;
  peer.onState = state => console.log(JSON.stringify({ smokeState: state }));
  peer["opts"].onTurnFailure = async () => { failed = true; };
  peer.onMessage = text => { answer = text; };
  await peer.start();
  await peer.deliver([newEnvelope("user", "Reply with exactly PI_HUB_AUTO_OK. Do not call tools.", { to: ["pi"], priority: "important" })]);
  const deadline = Date.now() + 120_000;
  while (!answer && !failed && peer.state === "busy" && Date.now() < deadline) await Bun.sleep(100);
  console.log(JSON.stringify({ observed: { state: peer.state, choices, failed, answerChars: answer.length, backends: relay.status().backends.map(({ alias, state, active }) => ({ alias, state, active })) } }));
  if (!answer.includes("PI_HUB_AUTO_OK") || !choices.length) throw new Error("Native Pi did not return the sentinel through hub/auto");
  console.log(JSON.stringify({ nativePi: "PI_HUB_AUTO_OK", route: "hub/auto", tiers: choices, state: peer.state }));
} finally {
  await peer?.stop();
  await relay.close();
  rmSync(root, { recursive: true, force: true });
}
