import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  return { peer, run, model, requests, answers, units };
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
  await review.run([newEnvelope("hub", "REVIEW_PACKAGE_SENTINEL", { kind: "review" })]);
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
