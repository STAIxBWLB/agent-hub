import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPeer, type LocalOptions } from "../src/adapters/local-worker.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { OmniRoute } from "../src/omniroute/client.ts";
import type { HubRoute } from "../src/models/route/config.ts";
import { parseHubRoutes } from "../src/models/route/config.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { switchyardToml } from "../src/switchyard/config.ts";
import { startFakeModelServer, toolCall, type Script } from "./fakes/model-server.ts";

const cleanup: (() => unknown)[] = [];
const savedKey = process.env.OMNIROUTE_API_KEY;
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); if (savedKey === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = savedKey; });
async function fixture(route: HubRoute, script: Script, extra: Partial<LocalOptions> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-route-local-"));
  writeFileSync(join(cwd, "a.txt"), "Traceback (most recent call last):\nImportError: missing module");
  const model = startFakeModelServer({ key: "fake-route-key", script });
  process.env.OMNIROUTE_API_KEY = "fake-route-key";
  const omni = new OmniRoute({ urls: [model.url], access_hosts: [] });
  const routes: string[] = [], answers: string[] = [];
  const peer = new LocalPeer("local", { cwd, omni, fixedModel: "fixed", route: "hub/test", hubRoutes: () => ({ "hub/test": route }), tools: { deny: [], permit: async () => true }, onRoute: e => routes.push(e.tier), maxSteps: 8, ...extra });
  peer.onMessage = text => { answers.push(text); };
  await peer.start(); cleanup.push(model.stop, () => peer.stop());
  const run = async () => {
    await peer.deliver([newEnvelope("user", "Complete the task", { to: ["local"], priority: "important" })]);
    for (let i = 0; i < 400 && peer.state === "busy"; i++) await Bun.sleep(10);
    expect(peer.state).toBe("idle");
  };
  return { peer, model, routes, answers, run };
}

test("local stage routes repeated failures to capable and preserves whole completed tool batches", async () => {
  const f = await fixture({ type: "stage" }, body => {
    const n = body.messages.filter(m => m.role === "tool").length;
    return n < 2 ? { tool_calls: [toolCall("bash", { command: "printf 'ImportError: missing module\n'; exit 1" })] } : { content: "completed" };
  });
  await f.run();
  expect(f.routes[0]).toBe("fast");
  expect(f.routes.at(-1)).toBe("coding");
  expect(f.answers).toEqual(["completed"]);
  expect(f.model.requests.at(-1)!.body.messages.filter((m: any) => m.role === "tool")).toHaveLength(2);
});

test("local plan/execute changes tier after the first mutation", async () => {
  const f = await fixture({ type: "plan_execute" }, body => body.messages.some(m => m.role === "tool") ? { content: "done" } : { tool_calls: [toolCall("write", { path: "out.txt", content: "ok" })] });
  await f.run();
  expect(f.routes).toEqual(["coding", "fast"]);
});

test("advisor REDO re-enters the same turn and retains feedback for the next turn", async () => {
  let reviewed = 0;
  const f = await fixture({ type: "advisor", max_reviews: 1 }, body => {
    if (body.model === "coding") { reviewed++; return { content: "REDO: verify the result" }; }
    return { content: body.messages.some(m => m.role === "user" && m.content?.includes("senior reviewer")) ? "verified" : "draft" };
  });
  await f.run(); expect(f.answers).toEqual(["verified"]); expect(reviewed).toBe(1);
  await f.run(); expect(reviewed).toBe(1);
  expect(JSON.stringify(f.model.requests.at(-1)!.body.messages)).toContain("verify the result");
});

test("advisor APPROVE and malformed/unavailable judges pass the held answer through", async () => {
  for (const verdict of ["APPROVE", "unexpected words", "failure"]) {
    const f = await fixture({ type: "advisor" }, body => {
      if (body.model === "coding") { if (verdict === "failure") throw new Error("judge down"); return { content: verdict }; }
      return { content: "answer" };
    });
    await f.run(); expect(f.answers).toEqual(["answer"]);
  }
});

test("failed optional executor falls back to fixed_model without failing the turn", async () => {
  const f = await fixture({ type: "stage" }, body => { if (body.model === "fast") throw new Error("route down"); return { content: "fallback worked" }; });
  await f.run(); expect(f.answers).toEqual(["fallback worked"]);
  expect(f.model.requests.map(r => r.body.model)).toEqual(["fast", "fixed"]);
});

test("PII turn is refused before any executor or advisor when campus is unconfirmed", async () => {
  const f = await fixture({ type: "advisor" }, () => ({ content: "should never run" }), { turnPolicy: () => ({ pii: true, task: "1" }) });
  f.peer["opts"].omni.onCampus = async () => false;
  await f.run(); expect(f.model.requests).toHaveLength(0); expect(f.answers[0]).toContain("PII");
});

test("hub route parser is closed and sidecar serialization excludes its tables", () => {
  expect(() => parseHubRoutes({ "sy/wrong": { type: "stage" } })).toThrow();
  expect(() => parseHubRoutes({ "hub/wrong": { type: "arbitrary" } })).toThrow();
  expect(() => parseHubRoutes({ "hub/wrong": { type: "stage", confidence_threshold: NaN } })).toThrow();
  const routing = loadRouting(mkdtempSync(join(tmpdir(), "ahub-route-config-")));
  expect(routing.hub_routes?.["hub/stage"]?.type).toBe("stage");
  expect(switchyardToml(routing, { baseUrl: "http://localhost/v1", extraHeaders: {} })).not.toContain("hub_routes");
});

test("local failed edits and exit-only shell failures carry route metadata but never unsupported wire fields", async () => {
  for (const name of ["edit", "bash"]) {
    const f = await fixture({ type: "stage" }, body => {
      const n = body.messages.filter(m => m.role === "tool").length;
      return n < 2 ? { tool_calls: [toolCall(name, name === "edit" ? { path: "a.txt", old: "no such fragment", new: "replacement" } : { command: "exit 1" })] } : { content: "reported the failure" };
    });
    await f.run();
    expect(f.routes.at(-1)).toBe("coding");
    expect(f.answers).toEqual(["reported the failure"]);
    for (const request of f.model.requests) for (const message of request.body.messages) expect(message).not.toHaveProperty("is_error");
  }
});

test("REDO feedback remains in completed history even when the current turn has no execution steps left", async () => {
  const f = await fixture({ type: "advisor" }, body => ({ content: body.model === "coding" ? "REDO: verify before finishing" : "draft" }), { maxSteps: 1 });
  await f.run(); expect(f.answers[0]).toContain("review requested changes; step limit reached");
  await f.run();
  expect(JSON.stringify(f.model.requests.at(-1)!.body.messages)).toContain("verify before finishing");
  expect(f.model.requests.filter(request => request.body.model === "coding")).toHaveLength(1);
});

test("a route configuration callback failure falls back without failing the completed answer", async () => {
  const f = await fixture({ type: "stage" }, () => ({ content: "fixed answer" }), { hubRoutes: () => { throw new Error("policy unavailable"); } });
  await f.run(); expect(f.answers).toEqual(["fixed answer"]);
  expect(f.model.requests.map(request => request.body.model)).toEqual(["fixed"]);
});
