import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { readEvents } from "../src/hub/events.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { LocalPeer, type LocalOptions } from "../src/adapters/local-worker.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { OmniRoute } from "../src/omniroute/client.ts";
import type { HubRoute } from "../src/models/route/config.ts";
import { startFakeModelServer, toolCall } from "./fakes/model-server.ts";

const clean: (() => unknown)[] = [];
const originalKey = process.env.OMNIROUTE_API_KEY;
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); if (originalKey === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = originalKey; });
async function fixture(mode: "off" | "shadow" | "enforce", extra: Partial<LocalOptions> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-adec-local-")); clean.push(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "a.txt"), "ordinary fixture output");
  const model = startFakeModelServer({ key: "fake-adec-gateway-key", script: body => body.messages.some(message => message.role === "tool") ? { content: "done" } : { tool_calls: [toolCall("read", { path: "a.txt" })] } });
  clean.push(model.stop); process.env.OMNIROUTE_API_KEY = "fake-adec-gateway-key";
  const omni = new OmniRoute({ urls: [model.url], access_hosts: [] });
  const requests: any[] = [], pins = new Set<string>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body: any = await req.json(); requests.push(body); const pinned = pins.has(body.turnId); pins.add(body.turnId);
    return Response.json({ id: "0123456789abcdef0123456789abcdef", policyId: "ahub.local", alias: "coding", effort: "high", margin: 0.8, abstain: false, reason: pinned ? "pinned" : "ok", fallbackApplied: false, pinned, rules: [], decider: null });
  } }); clean.push(() => server.stop(true));
  const config: HubRoute = { type: "decision", decision_backend: "adec", decision_mode: mode, policy_id: "ahub.local", adec_endpoint: `http://127.0.0.1:${server.port}/v1/route`, candidates: [{ alias: "coding", efforts: ["high"] }] };
  const answers: string[] = [], units: string[] = [], diagnostics: string[] = [];
  const peer = new LocalPeer("local", { cwd, omni, fixedModel: "fixed", route: "hub/test", hubRoutes: () => ({ "hub/test": config }), routeEvidencePublic: () => true,
    tools: { deny: [], permit: async () => true }, log: line => diagnostics.push(line), admitBudget: async (_envs, unit) => { units.push(unit); return []; }, ...extra });
  clean.push(() => peer.stop()); peer.onMessage = text => { answers.push(text); }; await peer.start();
  const run = async (envs: Envelope[] = [newEnvelope("user", "SOURCE_CANARY complete this task")]) => {
    let done!: () => void; const idle = new Promise<void>(resolve => { done = resolve; });
    peer.onState = state => { if (state === "idle") done(); };
    await peer.deliver(envs); await idle;
    expect(peer.state).toBe("idle"); expect(diagnostics).toEqual([]);
  };
  return { peer, run, model, requests, answers, units, omni, diagnostics };
}

test("local off/shadow preserve normal wire, enforce forwards effort, and the service sees one stable user-turn identity", async () => {
  for (const mode of ["off", "shadow", "enforce"] as const) {
    const f = await fixture(mode); await f.run(); expect(f.answers).toEqual(["done"]);
    expect(f.model.requests.map(row => row.body.model)).toEqual(mode === "enforce" ? ["coding", "coding"] : ["fast", "fast"]);
    for (const row of f.model.requests) expect(row.body.reasoning_effort).toBe(mode === "enforce" ? "high" : undefined);
    expect(f.requests).toHaveLength(mode === "off" ? 0 : 2);
    if (mode !== "off") {
      expect(f.requests[0].turnId).toBe(f.requests[1].turnId);
      expect(f.requests[1].evidence).toContain("ordinary fixture output");
      expect(f.units.filter(unit => unit === "model_calls")).toHaveLength(4); // two decision admissions and two actual gateway calls
    }
  }
});

test("a person model override bypasses the decision service and does not inherit its effort", async () => {
  let applied = 0;
  const f = await fixture("enforce", { getModelOverride: () => ({ model: "fixed", applied: () => { applied++; } }) });
  await f.run(); expect(f.requests).toHaveLength(0); expect(applied).toBe(1);
  expect(f.model.requests.map(row => row.body.model)).toEqual(["fixed", "fixed"]);
  for (const row of f.model.requests) expect(row.body.reasoning_effort).toBeUndefined();
});

test("local private input releases metadata only to adec and review packages release nothing", async () => {
  const private_ = await fixture("shadow");
  await private_.run([newEnvelope("user", "PRIVATE_SENTINEL", { private: true })]);
  expect(private_.requests.length).toBeGreaterThan(0);
  for (const request of private_.requests) {
    expect(request.constraints).toMatchObject({ pii: true, private: true, contextTokens: 0 });
    expect(request.evidence).not.toContain("PRIVATE_SENTINEL"); expect(request.evidence).not.toContain("ordinary fixture output");
  }
  const review = await fixture("shadow");
  await review.run([newEnvelope("hub", "REVIEW_PACKAGE_SENTINEL", { kind: "review", refs: { reviewPackage: "review:decision-fixture" } })]);
  expect(review.requests).toHaveLength(0);
});

test("the production worker's evidence screen can omit all public fragments without forwarding source text", async () => {
  const f = await fixture("shadow", { routeEvidencePublic: () => false }); await f.run();
  expect(f.requests).toHaveLength(2);
  for (const request of f.requests) {
    expect(request.evidence).not.toContain("SOURCE_CANARY"); expect(request.evidence).not.toContain("ordinary fixture output");
    const state = JSON.parse(request.evidence); expect(state.toolNames).toEqual([]);
  }
});


test("a real daemon wires current public-view policy into decision evidence and writes metadata-only route events", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-adec-daemon-")), stateDir = join(cwd, "state");
  clean.push(() => rmSync(cwd, { recursive: true, force: true })); mkdirSync(join(cwd, ".agenthub"));
  const model = startFakeModelServer({ key: "fake-adec-gateway-key", models: ["fast", "coding"], script: () => ({ content: "done" }) }); clean.push(model.stop);
  process.env.OMNIROUTE_API_KEY = "fake-adec-gateway-key";
  const requests: any[] = [];
  const service = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body: any = await req.json(); requests.push(body);
    return Response.json({ id: "0123456789abcdef0123456789abcdef", policyId: "ahub.local", alias: "coding", effort: "high", margin: 0.8, abstain: false, reason: "ok", fallbackApplied: false, pinned: false, rules: [], decider: null });
  } }); clean.push(() => service.stop(true));
  const routing = readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8").replaceAll('pi_backend = "mlx"', 'pi_backend = "dgx"').replace('route = "hub/stage"', 'route = "hub/decision"');
  writeFileSync(join(cwd, ".agenthub/routing.toml"), routing + `
[hub_routes."hub/decision"]
type = "decision"
decision_backend = "adec"
decision_mode = "shadow"
policy_id = "ahub.local"
adec_endpoint = "http://127.0.0.1:${service.port}/v1/route"
candidates = [{alias="coding", efforts=["high"]}]
`);
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0,
      pii: { ...DEFAULT_CONFIG.pii, paths: ["private/**"] },
      specs: { ...DEFAULT_CONFIG.specs, enabled: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [model.url], access_hosts: [] } } });
  clean.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); clean.push(() => client.close());
  const started = await client.request({ t: "start", peer: "local", args: {} });
  expect(started).toMatchObject({ ok: true });
  let finished!: () => void;
  const done = new Promise<void>(resolve => { finished = resolve; });
  daemon.bus.tap(event => { if (event.t === "envelope" && event.env.from === "local" && event.env.body === "done") finished(); });
  expect((await client.request({ t: "send", body: "inspect private/DECISION_PATH_CANARY.txt", to: ["local"] })).ok).toBe(true);
  await done; await client.request({ t: "status" });
  const routeEvents = readEvents(join(stateDir, "events.jsonl")).filter(event => event.type === "route");
  expect(requests).toHaveLength(1); expect(requests[0].evidence).not.toContain("DECISION_PATH_CANARY");
  expect(routeEvents).toHaveLength(1); expect(routeEvents[0]!.source).toBe("decision"); expect(routeEvents[0]!.decisionMode).toBe("shadow");
  expect(routeEvents[0]!.tier).toBe("fast"); expect(routeEvents[0]!.chosenAlias).toBe("coding");
  expect(JSON.stringify(routeEvents)).not.toContain("DECISION_PATH_CANARY");
  expect(model.requests[0]!.body.model).toBe("fast"); expect(model.requests[0]!.body.reasoning_effort).toBeUndefined();
}, 20_000);


test("an enforce handoff rechecks current privacy after gateway discovery and sends no model request", async () => {
  const facts = { pii: false, private: false, excluded: false };
  const f = await fixture("enforce", { routeDecisionContext: () => ({ ...facts }) });
  let arrived!: () => void, release!: () => void, idle!: () => void, failures = 0;
  const entered = new Promise<void>(resolve => { arrived = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  clean.push(release);
  const base = f.omni.base.bind(f.omni);
  f.omni.base = async () => { const url = await base(); arrived(); await gate; return url; };
  const finished = new Promise<void>(resolve => { idle = resolve; });
  f.peer.onState = state => { if (state === "idle") idle(); }; f.peer.onFailed = () => { failures++; };
  await f.peer.deliver([newEnvelope("user", "GATEWAY_HANDOFF_SOURCE_CANARY")]);
  await entered; facts.pii = true; release(); await finished;
  expect(f.requests).toHaveLength(1); // the earlier decision was public when released
  expect(f.model.requests).toHaveLength(0); expect(f.answers).toEqual([]); expect(failures).toBe(1);
  expect(f.diagnostics.some(line => line.includes("policy changed or is unavailable"))).toBe(true);
});
