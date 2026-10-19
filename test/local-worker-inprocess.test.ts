import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPeer, type LocalOptions } from "../src/adapters/local-worker.ts";
import { newEnvelope, type EnvelopeOpts } from "../src/hub/envelope.ts";
import { OmniRoute } from "../src/omniroute/client.ts";
import { startFakeModelServer, toolCall, type Script } from "./fakes/model-server.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function fixture(extra: Partial<LocalOptions> = {}, script: Script = () => ({ content: "done" })) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-local-inprocess-")));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "a.txt"), "fixture");
  const previousKey = process.env.OMNIROUTE_API_KEY;
  process.env.OMNIROUTE_API_KEY = "local-inprocess-fixture-key";
  cleanup.push(() => {
    if (previousKey === undefined) delete process.env.OMNIROUTE_API_KEY;
    else process.env.OMNIROUTE_API_KEY = previousKey;
  });
  const model = startFakeModelServer({ key: "local-inprocess-fixture-key", script });
  cleanup.push(model.stop);
  const omni = new OmniRoute({ urls: [model.url], access_hosts: [] });
  const lines: string[] = [];
  const said: { body: string; opts?: EnvelopeOpts }[] = [];
  const peer = new LocalPeer("local", {
    cwd, omni, fixedModel: "vllm/fixed", tools: { deny: [], permit: async () => true },
    log: line => lines.push(line), ...extra,
  });
  peer.onMessage = (body, opts) => { said.push({ body, opts }); };
  await peer.start();
  cleanup.push(() => peer.stop());
  const deliver = async (body: string, opts: EnvelopeOpts = {}) => {
    await peer.deliver([newEnvelope("user", body, opts)]);
    for (let i = 0; i < 400 && peer.state === "busy"; i++) await Bun.sleep(10);
    expect(peer.state).toBe("idle");
  };
  return { peer, omni, model, lines, said, deliver };
}

test("class fixed_model without a route overrides the global hub route for calls and conclusion (#553)", async () => {
  const ctx = await fixture({
    route: "hub/default",
    hubRoutes: () => ({ "hub/default": { type: "advisor", efficient: "vllm/global", judge: "vllm/judge", max_reviews: 1 } }),
    turnPolicy: () => ({ fixedModel: "vllm/class", pii: false }),
  });
  await ctx.deliver("class-specific work");
  expect(ctx.model.requests.map(request => request.body.model)).toEqual(["vllm/class"]);
  expect(ctx.said.map(message => message.body)).toEqual(["done"]);
  expect(ctx.peer.lastServedBy).toContain("vllm/class");
});

test("legacy sy route calls the fixed alias directly and warns once across calls and turns (#553)", async () => {
  const ctx = await fixture({ route: "sy/coding" }, body =>
    body.messages.at(-1)?.role === "user" ? { tool_calls: [toolCall("read", { path: "a.txt" })] } : { content: "done" });
  await ctx.deliver("first turn");
  await ctx.deliver("second turn");
  expect(ctx.model.requests.map(request => request.body.model)).toEqual(Array(4).fill("vllm/fixed"));
  expect(ctx.model.requests.every(request => !request.headers["x-switchyard-session-id"])).toBe(true);
  const warnings = ctx.lines.filter(line => line.includes("sy/coding") && /deprecated|legacy|unsupported|ignored/i.test(line));
  expect(warnings).toHaveLength(1);
  expect(ctx.said.map(message => message.body)).toEqual(["done", "done"]);
});

test("PII in-process calls require campus confirmation and retain the transport campus fence (#553)", async () => {
  const ctx = await fixture({ route: "sy/coding", turnPolicy: () => ({ pii: true }) });
  const options: boolean[] = [];
  const chat = ctx.omni.chat.bind(ctx.omni);
  ctx.omni.chat = async (body, opts = {}) => {
    options.push(opts.onCampusOnly === true);
    return chat(body, opts);
  };
  ctx.omni.onCampus = async () => false;
  await ctx.deliver("private refused fixture", { private: true });
  expect(ctx.model.requests).toHaveLength(0);
  expect(ctx.said[0]?.body).toStartWith("Refused: this is a PII task");
  ctx.omni.onCampus = async () => true;
  await ctx.deliver("private campus fixture", { private: true });
  expect(ctx.model.requests.map(request => request.body.model)).toEqual(["vllm/fixed"]);
  expect(options).toEqual([true]);
  expect(ctx.said[1]?.opts).toMatchObject({ private: true, to: ["user"] });
});
