import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPeer, type LocalOptions } from "../src/adapters/local-worker.ts";
import { Board } from "../src/hub/board.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { Bus } from "../src/hub/bus.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { Capture } from "../src/memory/capture.ts";
import { MemoryClient } from "../src/memory/client.ts";
import { OmniRoute } from "../src/omniroute/client.ts";
import { switchyardToml } from "../src/switchyard/config.ts";
import { Sidecar } from "../src/switchyard/sidecar.ts";
import { startFakeMemWorker } from "./fakes/mem-worker.ts";
import { startFakeModelServer, toolCall, type Script } from "./fakes/model-server.ts";

const FAKE_SWITCHYARD = join(import.meta.dir, "fakes/switchyard.ts");
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  delete process.env.OMNIROUTE_API_KEY;
});
const until = async (cond: () => boolean, what = "condition") => {
  for (let i = 0; i < 400 && !cond(); i++) await Bun.sleep(10);
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

/** read a.txt, then edit it, then conclude. */
const bulkEdit: Script = (body) => {
  const tools = body.messages.filter((m) => m.role === "tool").length;
  if (tools === 0) return { tool_calls: [toolCall("read", { path: "a.txt" })] };
  if (tools === 1) return { tool_calls: [toolCall("edit", { path: "a.txt", old: "two", new: "2" })] };
  return { content: `done: ${body.messages.at(-1)?.content}` };
};

class WatchdogLocalPeer extends LocalPeer { expireWatchdog(): void { this.onWatchdog(); } }

async function setup(script: Script, extra: Partial<LocalOptions> = {}, permit = true) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-local-")));
  writeFileSync(join(cwd, "a.txt"), "one\ntwo\n");
  const model = startFakeModelServer({ key: "sk-fake-secret", script });
  process.env.OMNIROUTE_API_KEY = "sk-fake-secret";
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  const omni = new OmniRoute({ urls: [model.url], access_hosts: [] }, log);
  const bus = new Bus({ batchMs: 0, retryMs: 20 });
  const events: string[] = [];
  const said: Envelope[] = [];
  bus.tap((e) => {
    events.push(e.t);
    if (e.t === "envelope" && e.env.from === "local") said.push(e.env);
  });
  const asked: string[] = [];
  const peer = new WatchdogLocalPeer("local", {
    cwd,
    omni,
    fixedModel: "vllm/fixed",
    tools: { deny: [], permit: async (t) => (asked.push(t), permit) },
    log,
    ...extra,
  });
  bus.add(peer);
  await peer.start();
  cleanup.push(model.stop, () => peer.stop());
  return { cwd, model, omni, bus, peer, said, asked, lines, events, log };
}

test("a bulk edit: tool calls run in the project, one conclusion is shared, the provider is recorded, no reasoning or key leaks", async () => {
  const { cwd, model, bus, peer, said, asked, lines } = await setup(bulkEdit);
  const env = newEnvelope("claude", "replace two with 2 in a.txt", { priority: "important" });
  bus.publish(env);
  expect(peer.state).toBe("busy");
  await until(() => said.length === 1, "answer");
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("one\n2\n");
  expect(said[0]!.body).toBe("done: edited a.txt");
  expect(said[0]!.hop).toBe(1);
  expect(asked).toEqual(["edit a.txt:\n- two\n+ 2"]); // read did not ask
  expect(peer.lastServedBy).toBe("omniroute vllm/fixed (provider vllm)");
  expect(peer.state).toBe("idle");

  const sent = JSON.stringify(model.requests.map((r) => r.body));
  expect(sent).toContain("untrusted"); // peers' text reaches the model framed
  expect(sent).not.toContain("private chain of thought"); // reasoning_content is never stored
  expect(`${sent}${lines.join()}${said[0]!.body}`).not.toContain("sk-fake-secret");
  expect(model.requests[0]!.body.tools.map((t: any) => t.function.name)).toEqual(["read", "write", "edit", "bash", "git", "hub_send"]);
});

test("a refused approval and a malformed tool call come back to the model as text; the step limit ends a loop", async () => {
  const refused = await setup(bulkEdit, {}, false);
  refused.bus.publish(newEnvelope("user", "edit it", { priority: "important" }));
  await until(() => refused.said.length === 1, "answer after refusal");
  expect(refused.said[0]!.body).toBe("done: error: the user did not approve this edit");
  expect(readFileSync(join(refused.cwd, "a.txt"), "utf8")).toBe("one\ntwo\n");

  const looping = await setup(() => ({ content: "still working", tool_calls: [toolCall("read", "{broken json")] }), { maxSteps: 3 });
  looping.bus.publish(newEnvelope("user", "loop", { priority: "important" }));
  await until(() => looping.said.length === 1, "step limit");
  expect(looping.said[0]!.body).toBe("(stopped after 3 steps) still working");
  expect(looping.model.requests).toHaveLength(3);
  expect(JSON.stringify(looping.model.requests[2]!.body.messages)).toContain("not valid JSON");
});

test("watchdog aborts a silent model call; its late answer neither publishes nor flips the next turn", async () => {
  let release = () => {}, slowObserved = false;
  let parsedLate!: () => void;
  const lateResponse = new Promise<void>(resolve => { parsedLate = resolve; });
  const { bus, peer, said, model, omni } = await setup(async (body) => {
    if (String(body.messages.at(-1)?.content).includes("SLOW")) await new Promise<void>(resolve => { release = resolve; slowObserved = true; });
    return { content: `echo: ${String(body.messages.at(-1)?.content).split("\n").at(-1)}` };
  });
  const chat = omni.chat.bind(omni);
  // This fake transport returns even after cancellation, so a parsed late response exercises the turn-generation guard.
  omni.chat = async (body, options = {}) => {
    const slow = String(body.messages.at(-1)?.content).includes("SLOW");
    const response = await chat(body, slow ? { ...options, signal: undefined } : options);
    if (slow) parsedLate();
    return response;
  };
  cleanup.push(() => { omni.chat = chat; release(); }); // release before model.stop even if a preceding assertion fails
  bus.publish(newEnvelope("user", "SLOW", { priority: "important" }));
  bus.publish(newEnvelope("user", "after", { priority: "important" }));
  await until(() => slowObserved, "SLOW request held by the fake gateway");
  peer.expireWatchdog(); // ordinary I/O uses the normal watchdog; only the observed silent turn is expired
  await until(() => said.length === 1, "turn after the abort");
  release();
  await lateResponse; // the real OmniRoute parser consumed the released response
  await new Promise<void>(resolve => setImmediate(resolve)); // drain its downstream promise continuations, not a fixed delay
  expect(said.map((e) => e.body)).toEqual(["echo: after"]);
  expect(peer.state).toBe("idle");
  // the aborted turn joined nothing to the history: the next request holds only the system prompt and its own user turn
  expect(model.requests.at(-1)!.body.messages.map((m: any) => m.role)).toEqual(["system", "user"]);
});

test("a model failure after tools with side effects is reported, not redelivered; history stays valid for the next turn", async () => {
  let calls = 0;
  const { bus, said, model, events, cwd } = await setup((body) => {
    calls++;
    if (calls === 1) return { tool_calls: [toolCall("edit", { path: "a.txt", old: "two", new: "2" })] };
    if (calls === 2) throw new Error("boom"); // the fake answers 500
    return { content: `roles=${body.messages.map((m) => m.role).join(",")}` };
  });
  bus.publish(newEnvelope("user", "edit then fail", { priority: "important" }));
  await until(() => said.length === 1, "failure report");
  expect(said[0]!.body).toMatch(/^\(turn failed after 1 tool call\(s\) with side effects: /);
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("one\n2\n");
  expect(events).not.toContain("undeliverable");
  expect(model.requests).toHaveLength(2); // no redelivery: the edit was not attempted again

  bus.publish(newEnvelope("user", "next", { priority: "important" }));
  await until(() => said.length === 2, "next turn");
  // every assistant tool call in the history is followed by its tool result
  expect(said[1]!.body).toBe("roles=system,user,assistant,tool,assistant,user");
});

test("budget exhaustion midway through a tool batch is terminal and leaves valid history", async () => {
  let calls = 0, toolCalls = 0;
  const { bus, peer, said, model } = await setup((body) => {
    calls++;
    if (calls === 1) return { tool_calls: [toolCall("read", { path: "a.txt" }), toolCall("read", { path: "a.txt" })] };
    return { content: `roles=${body.messages.map((m) => m.role).join(",")}` };
  }, {
    admitBudget: async (_envs, unit) => {
      if (unit === "model_calls") return [{ allowed: true, scope: "run:test", unit, used: 1, limit: 3, remaining: 2 }];
      toolCalls++;
      return [{ allowed: toolCalls < 2, scope: "run:test", unit, used: 1, limit: 1, remaining: 0, ...(toolCalls >= 2 ? { reason: "exhausted" as const } : {}) }];
    },
  });
  bus.publish(newEnvelope("user", "read twice", { priority: "important" }));
  await until(() => said.length === 1, "budget stop report");
  expect(said[0]!.body).toContain("execution budget stopped before any tool side effects");
  expect(model.requests).toHaveLength(1); // a budget stop cannot be auto-replayed
  bus.publish(newEnvelope("user", "continue", { priority: "important" }));
  await until(() => said.length === 2, "next delivery");
  expect(said[1]!.body).toBe("roles=system,user,assistant,tool,tool,assistant,user");
});

test("elapsed budget aborts an active model request and does not replay it", async () => {
  const { bus, peer, said, model } = await setup(async () => {
    await Bun.sleep(300);
    return { content: "late response" };
  }, {
    admitBudget: async (_envs, unit) => [
      { allowed: true, scope: "run:deadline", unit, used: 1, limit: 10, remaining: 9 },
      { allowed: true, scope: "run:deadline", unit: "elapsed_ms", used: 20, limit: 80, remaining: 25 },
    ],
  });
  bus.publish(newEnvelope("user", "finish before deadline", { priority: "important" }));
  await until(() => said.length === 1, "elapsed budget report");
  expect(said[0]!.body).toContain("execution budget stopped before any tool side effects");
  expect(model.requests).toHaveLength(1);
  expect(peer.state).toBe("idle");
});

test("elapsed budget cancels a pending approval before a write can start", async () => {
  let releaseApproval = () => {};
  const deadline = Date.now() + 150;
  const { bus, peer, said, cwd, model } = await setup(() => ({ tool_calls: [toolCall("edit", { path: "a.txt", old: "two", new: "2" })] }), {
    tools: { deny: [], permit: async () => new Promise<boolean>((resolve) => { releaseApproval = () => resolve(true); }) },
    admitBudget: async (_envs, unit) => Date.now() >= deadline
      ? [{ allowed: false, scope: "run:approval", unit: "elapsed_ms", used: 150, limit: 150, remaining: 0, reason: "exhausted" }]
      : [
          { allowed: true, scope: "run:approval", unit, used: 1, limit: 10, remaining: 9 },
          { allowed: true, scope: "run:approval", unit: "elapsed_ms", used: Date.now() - (deadline - 150), limit: 150, remaining: deadline - Date.now() },
        ],
  });
  bus.publish(newEnvelope("user", "edit after approval", { priority: "important" }));
  await until(() => said.length === 1, "approval budget stop");
  expect(said[0]!.body).toContain("execution budget stopped before any tool side effects");
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("one\ntwo\n");
  expect(model.requests).toHaveLength(1);
  releaseApproval();
  await peer.stop();
});

test("correlated local delivery after a side effect requires review", async () => {
  let calls = 0;
  const { peer, said, model, cwd } = await setup((body) => {
    calls++;
    if (calls === 1) return { tool_calls: [toolCall("edit", { path: "a.txt", old: "two", new: "2" })] };
    throw new Error("model disconnected after edit");
  });
  const receipts: { id: string; state: string }[] = [];
  peer.onDelivery = (r) => receipts.push({ id: r.id, state: r.state });
  await peer.deliver([newEnvelope("user", "edit then disconnect", { to: ["local"] })], "local-effects");
  await until(() => receipts.some((r) => r.state === "needs_review"), "needs-review receipt");
  expect(receipts[0]).toEqual({ id: "local-effects", state: "accepted" });
  expect(receipts.at(-1)).toEqual({ id: "local-effects", state: "needs_review" });
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("one\n2\n");
  expect(said).toHaveLength(1);
  expect(model.requests).toHaveLength(2);
});

test("a long turn elides its oldest tool outputs instead of outgrowing the context", async () => {
  const big = "x".repeat(19_000);
  const { bus, said, model, cwd } = await setup((body) => {
    const n = body.messages.filter((m) => m.role === "tool").length;
    return n < 9 ? { tool_calls: [toolCall("read", { path: "big.txt" })] } : { content: "done" };
  });
  writeFileSync(join(cwd, "big.txt"), big);
  bus.publish(newEnvelope("user", "read a lot", { priority: "important" }));
  await until(() => said.length === 1, "answer");
  const last = model.requests.at(-1)!.body.messages as { role: string; content: string }[];
  expect(JSON.stringify(last).length).toBeLessThan(140_000);
  expect(last.filter((m) => m.role === "tool" && m.content.startsWith("(output elided")).length).toBeGreaterThan(0);
  expect(last.filter((m) => m.role === "tool")).toHaveLength(9); // structure intact
});

test("task turns: the class route and model, native task tools, and a PII turn that answers the console only and leaves no trace", async () => {
  const mem = startFakeMemWorker();
  cleanup.push(mem.stop);
  const toolCalls: string[] = [];
  const ctx = await setup(
    (body) => {
      const last = String(body.messages.at(-1)?.content);
      if (body.messages.at(-1)?.role === "tool") return { content: `tool said: ${last}` };
      if (last.includes("use the board")) return { tool_calls: [toolCall("hub_task_accept", { id: 7 })] };
      return { content: `model=${body.model} saw=${body.messages.filter((m) => m.role === "user").length} users` };
    },
    {
      capture: new Capture(new MemoryClient(mem.url), { project: "p", cwd: "/p" }),
      taskTool: async (name, a, turn) => (toolCalls.push(`${name}:${JSON.stringify(a)}:pii=${turn.pii}`), "task #7: in_progress"),
      turnPolicy: (envs) => (envs[0]!.refs?.task === "7" ? { fixedModel: "vllm/class-model", pii: false } : envs[0]!.refs?.task === "8" ? { pii: true, task: "8" } : undefined),
      preamble: "Your roles: implementer",
    },
  );
  const tapped: Envelope[] = [];
  ctx.bus.tap((e) => e.t === "envelope" && e.env.from === "local" && tapped.push(e.env));

  ctx.bus.publish(newEnvelope("hub", "use the board", { to: ["local"], kind: "task", priority: "important", refs: { task: "7" } }));
  await until(() => tapped.length === 1, "task turn");
  expect(toolCalls).toEqual(['hub_task_accept:{"id":7}:pii=false']); // the turn's PII flag travels with every task tool call
  expect(tapped[0]!.body).toBe("tool said: task #7: in_progress");
  expect(ctx.model.requests[0]!.body.model).toBe("vllm/class-model"); // the class's model, not the worker default
  expect(ctx.model.requests[0]!.body.tools.map((t: any) => t.function.name)).toContain("hub_task_propose");
  expect(ctx.model.requests[0]!.body.messages[0].content).toContain("Your roles: implementer");

  const posts = () => mem.calls.filter((c) => c.path.includes("/observations")).length;
  const before = posts();
  ctx.bus.publish(newEnvelope("hub", "patient 900101-1234567", { to: ["local"], kind: "task", priority: "important", private: true, refs: { task: "8" } }));
  await until(() => tapped.length === 2, "pii turn");
  expect(tapped[1]).toMatchObject({ to: ["user"], private: true, refs: { task: "8" } });
  expect(posts()).toBe(before);

  ctx.bus.publish(newEnvelope("user", "plain question", { priority: "important" }));
  await until(() => tapped.length === 3, "turn after pii");
  expect(tapped[2]!.body).toBe("model=vllm/fixed saw=2 users"); // the task turn and this one: the PII turn is not in the history
  expect(JSON.stringify(ctx.model.requests.at(-1)!.body)).not.toContain("900101");
});

test("a PII turn is refused when the only gateway is off campus", async () => {
  const model = startFakeModelServer({ key: "k" });
  cleanup.push(model.stop);
  process.env.OMNIROUTE_API_KEY = "k";
  const omni = new OmniRoute({ urls: [model.url], access_hosts: ["127.0.0.1"] });
  const peer = new LocalPeer("local", { cwd: mkdtempSync(join(tmpdir(), "agenthub-")), omni, fixedModel: "m", tools: { deny: [], permit: async () => true }, turnPolicy: () => ({ pii: true }) });
  const bus = new Bus({ batchMs: 0 });
  const said: Envelope[] = [];
  bus.tap((e) => e.t === "envelope" && e.env.from === "local" && said.push(e.env));
  bus.add(peer);
  await peer.start();
  cleanup.push(() => peer.stop());
  bus.publish(newEnvelope("hub", "pii work", { to: ["local"], priority: "important", private: true }));
  await until(() => said.length === 1, "refusal");
  expect(said[0]!.body).toStartWith("Refused: this is a PII task");
  expect(model.requests).toHaveLength(0); // nothing was sent through Cloudflare
});

test("unreachable gateway: the envelope is retried and then reported undeliverable, the peer stays usable", async () => {
  const { bus, model, events, peer } = await setup(() => ({ content: "never" }));
  model.stop();
  bus.publish(newEnvelope("user", "anyone there", { priority: "important" }));
  await until(() => events.includes("undeliverable"), "undeliverable");
  expect(peer.state).toBe("idle");
});

test("switchyard config: gateway client added, key by env name only, route ids and nested tables kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-"));
  Bun.spawnSync(["mkdir", "-p", join(dir, ".agenthub")]);
  writeFileSync(
    join(dir, ".agenthub", "routing.toml"),
    [
      '[local]\nroute = "sy/coding"\nfixed_model = "vllm/dsv4f"',
      '[targets.glm]\nid = "vllm/glm"\n[targets.dsv4f]\nid = "vllm/dsv4f"\n[targets."glm-5.3"]\nid = "vllm/glm-5.3"',
      '[routes."sy/coding"]\ntype = "stage_router"\nefficient_target = "glm"\ncapable_target = "dsv4f"\npicker = "efficient_first"\nconfidence_threshold = 0.5',
      '[routes."sy/review"]\ntype = "llm_classifier"\nmode = "escalation"\nclassifier_target = "glm"\nweak_target = "glm"\nstrong_target = "dsv4f"\n[routes."sy/review".escalation]\nconfirmations = 2',
      '[routes."sy/fast"]\ntype = "passthrough"\ntarget = "glm"',
    ].join("\n\n"),
  );
  const toml = switchyardToml(loadRouting(dir), { baseUrl: "https://gateway.example.edu/v1", extraHeaders: { "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": "sec" } });
  const parsed = Bun.TOML.parse(toml) as any;
  expect(parsed.schema_version).toBe(1);
  expect(parsed.llm_clients.gateway).toMatchObject({ format: "openai_chat", base_url: "https://gateway.example.edu/v1", api_key_env: "OMNIROUTE_API_KEY" });
  expect(parsed.llm_clients.gateway.extra_headers["CF-Access-Client-Secret"]).toBe("sec");
  expect(parsed.targets.glm).toEqual({ id: "vllm/glm", llm_client: "gateway" });
  expect(parsed.targets["glm-5.3"]).toEqual({ id: "vllm/glm-5.3", llm_client: "gateway" }); // a dotted name stays one table
  const routes = Object.values(parsed.routes) as any[];
  expect(routes.map((r) => r.id)).toEqual(["sy/coding", "sy/review", "sy/fast"]);
  expect(routes[0]).toMatchObject({ type: "stage_router", picker: "efficient_first", confidence_threshold: 0.5 });
  expect(routes[1].escalation).toEqual({ confirmations: 2 });
  expect(parsed.local).toBeUndefined();
});

test("sidecar: calls go through the route, the selected model is recorded, the config file is 0600 and gone after stop", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-state-"));
  const routing = loadRouting(mkdtempSync(join(tmpdir(), "agenthub-")));
  let sidecar!: Sidecar;
  const ctx = await setup(bulkEdit);
  sidecar = new Sidecar({ routing, omni: ctx.omni, stateDir, port: 47000 + (process.pid % 900), bin: FAKE_SWITCHYARD, log: ctx.log });
  cleanup.push(() => sidecar.stop());
  const peer = new LocalPeer("local", { cwd: ctx.cwd, omni: ctx.omni, sidecar, route: "sy/coding", fixedModel: "vllm/fixed", tools: { deny: [], permit: async () => true } });
  const bus = new Bus({ batchMs: 0 });
  const said: Envelope[] = [];
  bus.tap((e) => e.t === "envelope" && e.env.from === "local" && said.push(e.env));
  bus.add(peer);
  await peer.start();
  cleanup.push(() => peer.stop());

  bus.publish(newEnvelope("user", "go", { priority: "important" }));
  await until(() => said.length === 1, "answer through the sidecar");
  expect(peer.lastServedBy).toBe("switchyard sy/coding -> vllm/deepseek-ai/DeepSeek-V4-Flash-0731");
  expect(ctx.model.requests.at(-1)!.body.model).toBe("vllm/deepseek-ai/DeepSeek-V4-Flash-0731"); // the route id was mapped to the target
  expect(readFileSync(join(ctx.cwd, "a.txt"), "utf8")).toBe("one\n2\n"); // tool calls survive the hop
  const file = join(stateDir, "switchyard.toml");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8")).not.toContain("sk-fake-secret");
  sidecar.stop();
  expect(() => readFileSync(file)).toThrow();
});

for (const [mode, why] of [["missing-binary", "not runnable"], ["reject-config", "config rejected"], ["fail-calls", "HTTP 502"], ["die-after-start", "exited"]] as const) {
  test(`fallback to fixed_model when switchyard is ${mode}, said once`, async () => {
    const ctx = await setup((b) => ({ content: `model=${b.model}` }));
    // The sidecar gets a scrubbed environment, so the fake's failure mode travels in a wrapper script instead.
    const wrapper = join(mkdtempSync(join(tmpdir(), "agenthub-bin-")), "switchyard-server");
    writeFileSync(wrapper, `#!/bin/sh\nFAKE_SWITCHYARD=${mode} exec bun ${FAKE_SWITCHYARD} "$@"\n`, { mode: 0o755 });
    const sidecar = new Sidecar({
      routing: loadRouting(mkdtempSync(join(tmpdir(), "agenthub-"))),
      omni: ctx.omni,
      stateDir: mkdtempSync(join(tmpdir(), "agenthub-state-")),
      port: 48000 + (process.pid % 900),
      bin: mode === "missing-binary" ? "/nonexistent/switchyard-server" : wrapper,
      log: ctx.log,
    });
    cleanup.push(() => sidecar.stop());
    const peer = new LocalPeer("local", { cwd: ctx.cwd, omni: ctx.omni, sidecar, route: "sy/coding", fixedModel: "vllm/fixed", tools: { deny: [], permit: async () => true }, log: ctx.log });
    const bus = new Bus({ batchMs: 0 });
    const said: Envelope[] = [];
    bus.tap((e) => e.t === "envelope" && e.env.from === "local" && said.push(e.env));
    bus.add(peer);
    await peer.start();
    cleanup.push(() => peer.stop());

    if (mode === "die-after-start") {
      await sidecar.endpoint();
      await Bun.sleep(500); // it starts healthy, then dies mid-session
    }
    bus.publish(newEnvelope("user", "one", { priority: "important" }));
    await until(() => said.length === 1, "first answer");
    bus.publish(newEnvelope("user", "two", { priority: "important" }));
    await until(() => said.length === 2, "second answer");
    expect(said.map((e) => e.body)).toEqual(["model=vllm/fixed", "model=vllm/fixed"]);
    const notices = ctx.lines.filter((l) => l.includes("falling back to fixed_model"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(why);
    expect(sidecar.status).toStartWith("off (");
  });
}

test("model-call budget admits a sidecar attempt and gates its fixed-model fallback separately", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-local-budget-fallback-")));
  const model = startFakeModelServer({ key: "sk-fake-secret", script: (body) => ({ content: `model=${body.model}` }) });
  process.env.OMNIROUTE_API_KEY = "sk-fake-secret";
  const lines: string[] = [], omni = new OmniRoute({ urls: [model.url], access_hosts: [] }, (line) => lines.push(line));
  const wrapper = join(mkdtempSync(join(tmpdir(), "agenthub-bin-")), "switchyard-server");
  writeFileSync(wrapper, `#!/bin/sh\nFAKE_SWITCHYARD=fail-calls exec bun ${FAKE_SWITCHYARD} "$@"\n`, { mode: 0o755 });
  const sidecar = new Sidecar({ routing: loadRouting(mkdtempSync(join(tmpdir(), "agenthub-routing-"))), omni, stateDir: mkdtempSync(join(tmpdir(), "agenthub-state-")), port: 48000 + (process.pid % 900), bin: wrapper, log: (line) => lines.push(line) });
  const admissions: string[] = [], bus = new Bus({ batchMs: 0 });
  const said: Envelope[] = [];
  bus.tap((e) => e.t === "envelope" && e.env.from === "local" && said.push(e.env));
  const peer = new LocalPeer("local", { cwd, omni, sidecar, route: "sy/coding", fixedModel: "vllm/fixed", tools: { deny: [], permit: async () => true }, admitBudget: async (_envs, unit) => {
    admissions.push(unit);
    return admissions.filter((entry) => entry === "model_calls").length === 1
      ? [{ allowed: true, scope: "run:fallback", unit, used: 1, limit: 1, remaining: 0 }]
      : [{ allowed: false, scope: "run:fallback", unit, used: 1, limit: 1, remaining: 0, reason: "exhausted" }];
  } });
  bus.add(peer); await peer.start();
  cleanup.push(model.stop, () => sidecar.stop(), () => peer.stop());
  bus.publish(newEnvelope("user", "use routed model", { priority: "important" }));
  await until(() => said.length === 1, "fallback budget report");
  expect(admissions).toEqual(["model_calls", "model_calls"]);
  expect(said[0]!.body).toContain("execution budget stopped before any tool side effects");
  expect(model.requests).toHaveLength(0); // fallback is stopped before reaching the fixed-model endpoint
});

test("a gateway that is down when the sidecar would start does not turn L2 off: the next call starts it", async () => {
  const ctx = await setup((b) => ({ content: `model=${b.model}` }));
  const sidecar = new Sidecar({
    routing: loadRouting(mkdtempSync(join(tmpdir(), "agenthub-"))),
    omni: ctx.omni,
    stateDir: mkdtempSync(join(tmpdir(), "agenthub-state-")),
    port: 49000 + (process.pid % 900),
    bin: FAKE_SWITCHYARD,
    log: ctx.log,
  });
  cleanup.push(() => sidecar.stop());
  ctx.model.state.healthy = false;
  expect(await sidecar.endpoint()).toBeUndefined();
  expect(sidecar.status).toBe("not started");
  ctx.model.state.healthy = true;
  expect(await sidecar.endpoint()).toStartWith("http://127.0.0.1:");
});

test("claude-mem capture: init, one observation per tool call, summarize, session-end; skip list and denylisted paths stay out; a down worker blocks nothing", async () => {
  const mem = startFakeMemWorker();
  cleanup.push(mem.stop);
  const script: Script = (body) => {
    const n = body.messages.filter((m) => m.role === "tool").length;
    if (n === 0) return { tool_calls: [toolCall("read", { path: "a.txt" }), toolCall("read", { path: ".env" }), toolCall("hub_send", { text: "[FYI] halfway" })] };
    return { content: "all done" };
  };
  const cwdHolder = { cwd: "" };
  const capture = new Capture(new MemoryClient(mem.url), { project: "agent-hub", cwd: "/proj", skip: ["hub_send"], deny: [] });
  const ctx = await setup(script, { capture });
  cwdHolder.cwd = ctx.cwd;
  ctx.bus.publish(newEnvelope("user", "work", { priority: "important" }));
  await until(() => ctx.said.some((e) => e.body === "all done"), "answer");
  await ctx.peer.stop();
  await until(() => mem.calls.some((c) => c.path.endsWith("/session-end")), "session-end");

  const posts = mem.calls.filter((c) => c.method === "POST");
  expect(posts.map((c) => c.path.split("/").at(-1))).toEqual(["init", "observations", "summarize", "session-end"]);
  const [init, obs, sum] = posts.map((c) => c.body as any);
  expect(init).toMatchObject({ project: "agent-hub", platformSource: "agent-hub" });
  expect(obs).toMatchObject({ tool_name: "read", platformSource: "agent-hub", agentId: "local", agentType: "local-worker", contentSessionId: init.contentSessionId });
  expect(obs.tool_input).toContain("a.txt"); // the .env read and the skip-listed hub_send were not posted
  expect(sum.last_assistant_message).toBe("all done");
  expect(sum.agentId).toBeUndefined(); // claude-mem skips a summarize that looks like a subagent's

  const down = await setup(bulkEdit, { capture: new Capture(new MemoryClient("http://127.0.0.1:9", 100), { project: "p", cwd: "/p" }) });
  down.bus.publish(newEnvelope("user", "go", { priority: "important" }));
  await until(() => down.said.length === 1, "answer with memory down");
});

// issue #68: a hub_send the bus refuses comes back to the model in the same turn, as `not sent: <why>`.
test("a hub_send the bus refuses answers the model with not sent and the reason", async () => {
  const script: Script = (body) => {
    const tools = body.messages.filter((m) => m.role === "tool");
    if (!tools.length) return { tool_calls: [toolCall("hub_send", { text: "status: halfway", to: ["claude"] })] };
    return { content: `seen: ${tools[0]!.content}` };
  };
  const ctx = await setup(script);
  const deliver = ctx.peer.onMessage!;
  ctx.peer.onMessage = (text, opts) => (text.includes("halfway") ? "rate limited: too many messages from local; retry after 20 s" : deliver(text, opts));
  ctx.bus.publish(newEnvelope("user", "work", { priority: "important" }));
  await until(() => ctx.said.some((e) => e.body.startsWith("seen:")), "answer");
  expect(ctx.said.find((e) => e.body.startsWith("seen:"))!.body).toBe("seen: not sent: rate limited: too many messages from local; retry after 20 s");
});

// #230: the real Tasks checks must remain the only memory path for hub tool text.
test("hub tool capture cannot leak refused notes, withheld summaries or PII proposals", async () => {
  const mem = startFakeMemWorker();
  cleanup.push(mem.stop);
  const secret = "patient 900101-1234567";
  const withheld = "screen-only-private-summary";
  const calls = [toolCall("hub_remember", { text: secret }), toolCall("hub_task_done", { id: 1, summary: withheld }), toolCall("hub_task_propose", { title: secret, class: "implement" }), toolCall("hub_task_show", { id: 1 })];
  let tasks: Tasks;
  const results: string[] = [];
  const ctx = await setup((body) => body.messages.at(-1)?.role === "tool" ? { content: "finished" } : { tool_calls: calls }, {
    capture: new Capture(new MemoryClient(mem.url), { project: "p", cwd: "/p", skip: [] }),
    taskTool: async (name, a) => {
      let result: string;
      if (name === "hub_remember") result = await tasks.remember("local", a as { text: string }).catch((e: Error) => `error: ${e.message}`);
      else if (name === "hub_task_done") result = JSON.stringify(await tasks.done("local", a.id, String(a.summary)));
      else if (name === "hub_task_propose") result = JSON.stringify(await tasks.propose("local", a as { title: string; class: "implement" }));
      else result = "conductor result";
      results.push(result);
      return result;
    },
  });
  const board = new Board(join(ctx.cwd, "hub.db"));
  cleanup.push(() => board.close());
  const routing = loadRouting(ctx.cwd);
  routing.signals.pii_screen = "local";
  tasks = new Tasks({ board, bus: new Bus({ batchMs: 0 }), routing: () => routing, cwd: ctx.cwd, project: "p", memory: new MemoryClient(mem.url), notify: () => {}, piiScreen: async (text) => ({ label: text.includes(withheld) ? "pii" : "clear", ms: 0 }) });
  const ordinary = board.propose("user", { title: "ordinary work", class: "implement" });
  board.update(ordinary.id, "local", "accepted", { state: "in_progress", owner: "local" });
  ctx.bus.publish(newEnvelope("user", "use the hub tools", { priority: "important" }));
  await until(() => ctx.said.length === 1, "hub-tool answer");
  await ctx.peer.stop();
  expect(results[0]).toContain("not saved");
  expect(board.get(1)!.history.some((h) => h.withheld)).toBe(true);
  expect(tasks.isPii(board.get(2)!)).toBe(true);
  expect(mem.calls.filter((c) => c.path.endsWith("/observations"))).toHaveLength(0);
  expect(JSON.stringify(mem.calls)).not.toContain(secret);
  expect(JSON.stringify(mem.calls)).not.toContain(withheld);
});

test("daemon local board lists expose PII rows only in a PII turn, never ordinary history or answers", async () => {
  const secret = "patient 900101-1234567";
  const mem = startFakeMemWorker();
  const model = startFakeModelServer({ key: "k", script: (body) => {
    if (body.messages.at(-1)?.role === "tool") return { content: String(body.messages.at(-1)?.content) };
    return { tool_calls: [toolCall("hub_task_list", {})] };
  } });
  cleanup.push(mem.stop, model.stop);
  process.env.OMNIROUTE_API_KEY = "k";
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-board-private-")));
  const stateDir = join(cwd, "state");
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, switchyardPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, omniroute: { urls: [model.url], access_hosts: [] }, memory: { enabled: true, worker_url: mem.url, inject_tokens: 40, brief_items: 8 } } });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" });
  cleanup.push(() => client.close());
  // Create while local is offline, so no private offer enters the ordinary test turn.
  await client.request({ t: "task", op: "hub_task_propose", args: { title: secret, class: "implement", refs: { paths: ["private.txt"] }, plan: { signatures: ["privatePatient()"] } } });
  const answers: Envelope[] = [];
  daemon.bus.tap((e) => { if (e.t === "envelope" && e.env.from === "local") answers.push(e.env); });
  await client.request({ t: "start", peer: "local", args: { model: "vllm/x" } });
  await until(() => daemon.bus.peers.get("local")?.state === "idle", "local start");
  daemon.bus.publish(newEnvelope("user", "read the board", { priority: "important", to: ["local"] }));
  await until(() => answers.length === 1, "ordinary list");
  expect(answers[0]!.body).toContain("[pii]");
  expect(JSON.stringify(model.requests)).not.toContain(secret);
  expect(JSON.stringify(answers)).not.toContain(secret);
  daemon.bus.publish(newEnvelope("user", "read the board again", { priority: "important", to: ["local"] }));
  await until(() => answers.length === 2, "later ordinary list");
  expect(JSON.stringify(model.requests)).not.toContain(secret);
  expect(JSON.stringify(answers)).not.toContain(secret);
  await until(() => mem.calls.filter((c) => c.path.endsWith("/summarize")).length === 2, "both ordinary summaries");
  expect(mem.calls.filter((c) => c.path.endsWith("/observations"))).toHaveLength(0);
  expect(JSON.stringify(mem.calls)).not.toContain(secret);
  const before = mem.calls.filter((c) => c.method === "POST").length;
  daemon.bus.publish(newEnvelope("hub", secret, { kind: "task", priority: "important", to: ["local"], private: true, refs: { task: "1" } }));
  await until(() => answers.length === 3, "PII list");
  expect(model.requests.at(-1)!.body.messages.at(-1).content).toContain(secret);
  expect(model.requests.at(-1)!.body.messages.at(-1).content).toContain("privatePatient()");
  expect(answers[2]).toMatchObject({ private: true, to: ["user"] });
  expect(mem.calls.filter((c) => c.method === "POST")).toHaveLength(before);
  expect(JSON.stringify(mem.calls)).not.toContain(secret);
});


test("refused hub_send text is not captured while ordinary file tools still are", async () => {
  const mem = startFakeMemWorker();
  cleanup.push(mem.stop);
  const secret = "refused patient 900101-1234567";
  const ctx = await setup((body) => body.messages.at(-1)?.role === "tool"
    ? { content: "finished" }
    : { tool_calls: [toolCall("hub_send", { text: secret, to: ["claude"] }), toolCall("read", { path: "a.txt" })] },
    { capture: new Capture(new MemoryClient(mem.url), { project: "p", cwd: "/p", skip: [] }) });
  const deliver = ctx.peer.onMessage!;
  ctx.peer.onMessage = (text, opts) => text === secret ? "rate limited: retry later" : deliver(text, opts);
  ctx.bus.publish(newEnvelope("user", "work", { priority: "important" }));
  await until(() => ctx.said.length === 1, "answer after refused send");
  await ctx.peer.stop();
  expect(ctx.model.requests.at(-1)!.body.messages.some((m: { role: string; content: string }) => m.role === "tool" && m.content === "not sent: rate limited: retry later")).toBe(true);
  expect(ctx.said[0]!.body).toBe("finished");
  const observations = mem.calls.filter((c) => c.path.endsWith("/observations"));
  expect(observations).toHaveLength(1);
  expect(observations[0]!.body).toMatchObject({ tool_name: "read" });
  expect(JSON.stringify(mem.calls)).not.toContain(secret);
});


test("two actual expired local approvals stop the turn without safe replay or a third model request (#253)", async () => {
  const notices: string[] = [];
  const { bus, peer, said, cwd, model } = await setup(() => ({ tool_calls: [toolCall("write", { path: "a.txt", content: "no" })] }), {
    tools: { deny: [], permit: async () => "expired" }, onApprovalStop: (reason) => notices.push(reason),
  });
  bus.publish(newEnvelope("user", "work", { to: ["local"] }));
  await until(() => peer.state === "idle" && notices.length === 1);
  expect(model.requests).toHaveLength(2);
  expect(said.at(-1)!.body).toContain("two unanswered approvals");
  const firstTool = model.requests[1]!.body.messages.find((message: { role: string }) => message.role === "tool");
  expect(firstTool.content).toContain("approval expired: no person answered");
  expect(firstTool.content).not.toContain("did not approve");
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("one\ntwo\n");
  await Bun.sleep(60); expect(model.requests).toHaveLength(2); // no safe-failure delivery retry
});

test("local answered denial resets the expiry streak and each new turn starts a fresh streak (#253)", async () => {
  const notices: string[] = [];
  let decisions = 0;
  const { bus, peer, model } = await setup((body) => {
    const start = body.messages.findLastIndex((message) => message.role === "user");
    const tools = body.messages.slice(start + 1).filter((message) => message.role === "tool").length;
    return tools < 3 ? { tool_calls: [toolCall("write", { path: "a.txt", content: "no" })] } : { content: "stopped myself" };
  }, { tools: { deny: [], permit: async () => ++decisions % 3 === 2 ? false : "expired" }, onApprovalStop: (reason) => notices.push(reason) });
  for (const turn of [1, 2]) {
    const before = model.requests.length;
    bus.publish(newEnvelope("user", `turn ${turn}`, { to: ["local"] }));
    await until(() => model.requests.length >= before + 4 && peer.state === "idle");
  }
  expect(notices).toEqual([]); expect(decisions).toBe(6);
});

test("the daemon's actual person denial resets local expiry provenance and the next turn starts fresh (#253)", async () => {
  const model = startFakeModelServer({ key: "k", script: body => {
    const start = body.messages.findLastIndex(message => message.role === "user");
    const tools = body.messages.slice(start + 1).filter(message => message.role === "tool").length;
    return tools < 3 ? { tool_calls: [toolCall("write", { path: "a.txt", content: "no" })] }
      : { content: "registry turn complete" };
  } });
  cleanup.push(model.stop); process.env.OMNIROUTE_API_KEY = "k";
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "local-denial-daemon-"))), stateDir = join(cwd, "state");
  writeFileSync(join(cwd, "a.txt"), "kept");
  const daemon = await startDaemon({ cwd, stateDir, permissionTimeoutMs: 400, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, omniroute: { urls: [model.url], access_hosts: [] } } });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  const asks: any[] = [], answers: Envelope[] = [];
  client.onPush = message => { if (message.t === "permission") asks.push(message); };
  client.send({ t: "tail" });
  daemon.bus.tap(event => { if (event.t === "envelope" && event.env.from === "local") answers.push(event.env); });
  expect((await client.request({ t: "start", peer: "local", args: { model: "m" } })).ok).toBe(true);
  const peer = daemon.bus.peers.get("local")!;
  for (const turn of [1, 2]) {
    const before = model.requests.length, askedBefore = asks.length;
    daemon.bus.publish(newEnvelope("user", `registry turn ${turn}`, { to: ["local"] }));
    await until(() => asks.length === askedBefore + 2, "second approval after the first expired");
    expect((await client.request({ t: "permit", id: asks[askedBefore + 1]!.id, option: "deny", surface: "console" })).ok).toBe(true);
    await until(() => answers.length === turn && peer.state === "idle", "ordinary completion after expire, person deny, expire");
    expect(model.requests).toHaveLength(before + 4);
    expect(asks).toHaveLength(askedBefore + 3);
    expect(answers[turn - 1]!.body).toBe("registry turn complete");
    const messages = model.requests[before + 3]!.body.messages as { role: string; content: string }[];
    const start = messages.findLastIndex(message => message.role === "user");
    const results = messages.slice(start + 1).filter(message => message.role === "tool");
    expect(results).toHaveLength(3);
    expect(results[0]!.content).toContain("approval expired: no person answered");
    expect(results[1]!.content).toContain("the user did not approve this write");
    expect(results[2]!.content).toContain("approval expired: no person answered");
    expect(daemon.bus.queueSummary("local").heldBy).toBeUndefined();
  }
  expect(readFileSync(join(stateDir, "hub.log"), "utf8")).not.toContain("Local turn stopped after two unanswered approvals");
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("kept");
  await Bun.sleep(60); expect(model.requests).toHaveLength(8);
}, 30_000);


test("daemon local expiry text and N2 stop use real approval timeout without replay (#253)", async () => {
  const nextTurn = "answer the second independent message";
  const model = startFakeModelServer({ key: "k", script: (body) => {
    const lastUser = body.messages.findLast(message => message.role === "user");
    return String(lastUser?.content).includes(nextTurn) ? { content: "second message answered" }
      : { tool_calls: [toolCall("write", { path: "a.txt", content: "no" })] };
  } });
  cleanup.push(model.stop); process.env.OMNIROUTE_API_KEY = "k";
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "local-timeout-daemon-"))), stateDir = join(cwd, "state");
  writeFileSync(join(cwd, "a.txt"), "kept");
  const daemon = await startDaemon({ cwd, stateDir, permissionTimeoutMs: 20, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, omniroute: { urls: [model.url], access_hosts: [] } } });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  expect((await client.request({ t: "start", peer: "local", args: { model: "m" } })).ok).toBe(true);
  const peer = daemon.bus.peers.get("local")!;
  const answers: Envelope[] = [], receiptStates: string[] = [];
  daemon.bus.tap(event => { if (event.t === "envelope" && event.env.from === "local") answers.push(event.env); });
  const recordReceipt = peer.onDelivery;
  peer.onDelivery = receipt => { receiptStates.push(receipt.state); recordReceipt?.(receipt); };
  const original = newEnvelope("user", "work", { to: ["local"] });
  daemon.bus.publish(original);
  await until(() => model.requests.length >= 2 && peer.state === "idle");
  expect(model.requests).toHaveLength(2);
  expect(model.requests[1]!.body.messages.find((message: {role: string}) => message.role === "tool").content).toContain("approval expired: no person answered");
  expect(readFileSync(join(stateDir, "hub.log"), "utf8")).toContain("Local turn stopped after two unanswered approvals");
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("kept");
  await Bun.sleep(60); expect(model.requests).toHaveLength(2);
  const firstDelivery = daemon.bus.queueList("local").filter(row => row.originals.some(env => env.id === original.id));
  expect(firstDelivery).toHaveLength(1);
  expect(firstDelivery[0]!.state).toBe("completed");
  expect(daemon.bus.queueSummary("local").needsReview).toBe(0);
  expect(daemon.bus.queueSummary("local").heldBy).toBeUndefined();
  expect(answers).toHaveLength(1);
  expect(answers[0]!.body).toContain("two unanswered approvals");

  const second = newEnvelope("user", nextTurn, { to: ["local"] });
  daemon.bus.publish(second);
  await until(() => answers.length === 2 && peer.state === "idle", "automatic delivery after the expired approval turn");
  expect(model.requests).toHaveLength(3);
  expect(String(model.requests[2]!.body.messages.findLast((message: { role: string }) => message.role === "user").content)).toContain(nextTurn);
  expect(answers[1]!.body).toBe("second message answered");
  const secondDelivery = daemon.bus.queueList("local").filter(row => row.originals.some(env => env.id === second.id));
  expect(secondDelivery).toHaveLength(1);
  expect(secondDelivery[0]!.state).toBe("completed");
  expect(receiptStates).toEqual(["accepted", "completed", "accepted", "completed"]);
  expect(daemon.bus.queueSummary("local").needsReview).toBe(0);
  expect(daemon.bus.queueSummary("local").heldBy).toBeUndefined();
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("kept");
  await Bun.sleep(60); expect(model.requests).toHaveLength(3); // original turn was not replayed
});
