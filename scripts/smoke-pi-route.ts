// Explicit live Pi + hub/auto smoke. No project tools or existing hub processes are touched.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiPeer } from "../src/adapters/pi.ts";
import { loadConfig } from "../src/hub/daemon.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { startModelRelay, type RelayRequestRecord } from "../src/models/relay.ts";
import { PI_ROUTE_SENTINEL, piSmokeVerdict } from "./smoke-pi-verdict.ts";
import { OmniRoute } from "../src/omniroute/client.ts";
const flags = process.argv.slice(2);
if (flags.some(flag => flag !== "--require-primary")) throw new Error("Usage: bun scripts/smoke-pi-route.ts [--require-primary]");
const requirePrimary = flags.includes("--require-primary");
const config = loadConfig(process.env.AHUB_SMOKE_PROJECT ?? process.cwd());
const root = mkdtempSync(join(tmpdir(), "ahub-pi-route-smoke-"));
const choices: string[] = [];
const requests: RelayRequestRecord[] = [];
const omni = new OmniRoute(config.omniroute);
let peer: PiPeer | undefined;
const relay = await startModelRelay({ omni, allowedDGXmodels: { "dgx/fast": config.pi.dgx_fast, "dgx/coding": config.pi.dgx_coding }, mlx: (config.mlx as typeof config.mlx & { enabled?: boolean }).enabled === false ? undefined : config.mlx, enableHubAuto: true, fallbackDGXAlias: "dgx/fast", onRoute: e => choices.push(e.tier), onRequest: record => { requests.push(record); }, routeSessionKey: () => { const id = peer?.recoveryMetadata().sessionId; return typeof id === "string" ? id : undefined; } });
let answer = "", failed = false;
try {
  peer = new PiPeer("pi", { cwd: root, stateDir: root, mode: "headless", backend: "auto", model: "hub/auto", cmd: process.env.PI_BIN ? [process.env.PI_BIN] : config.pi.cmd, relay: { url: relay.url, token: relay.token, models: relay.models.map(id => ({ id, contextWindow: id === "hub/auto" ? 8192 : config.pi.backend === "mlx" ? 8192 : 262144, maxTokens: 128 })) }, tools: [], executeTool: async () => { throw new Error("No tools are allowed in the smoke"); }, maxSteps: 2, watchdogMs: 120_000, onTurnFailure: async () => { failed = true; } });
  peer.onState = state => console.log(JSON.stringify({ smokeState: state }));
  peer.onMessage = text => { answer = text; };
  await peer.start();
  await peer.deliver([newEnvelope("user", `Reply with exactly ${PI_ROUTE_SENTINEL}. Do not call tools.`, { to: ["pi"], priority: "important" })]);
  const deadline = Date.now() + 120_000;
  while (!answer && !failed && peer.state === "busy" && Date.now() < deadline) await Bun.sleep(100);
} catch {
  failed = true;
} finally {
  await peer?.stop();
  await relay.close();
  rmSync(root, { recursive: true, force: true });
}

const verdict = piSmokeVerdict({ answer, failed, choices, requests, requirePrimary });
console.log(JSON.stringify(verdict));
if (!verdict.passed) throw new Error("Native Pi hub/auto smoke failed; inspect the sanitized verdict");
