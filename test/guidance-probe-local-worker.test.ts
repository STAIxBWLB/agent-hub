import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalPeer, localProbeFingerprints, prepareLocalProbeInput, type LocalOptions } from "../src/adapters/local-worker.ts";
import { createGuidanceProbeLocalAdapter } from "../src/adapters/local-probe.ts";
import { ProbeLocalError, probeLocalEffect, type ProbeLocalEffectScope, type ProbeLocalModelConfig, type ProbeLocalSession } from "../src/local/probe-types.ts";
import { materializeProbeWorkspace, probeWorkspacePrivateRoot, type ProbeWorkspace } from "../src/local/probe-workspace.ts";
import type { ProbeConfinement } from "../src/local/probe-sandbox.ts";
import { GUIDANCE_PROBE_MODEL, guidanceProbeCanonical, guidanceProbeManifestKey, probeHash,
  type ProbeFakeEffectRequest, type ProbeFakeEffects, type ProbeSlot, type ProbeStoredState } from "../src/hub/guidance-probes.ts";
import { OmniRoute, type ChatResult } from "../src/omniroute/client.ts";
import type { Capture } from "../src/memory/capture.ts";
import { guidanceProbeFixture } from "./fakes/guidance-probe-provider.ts";
import { startFakeModelServer, toolCall } from "./fakes/model-server.ts";
import { USER, newEnvelope } from "../src/hub/envelope.ts";
import { ProbeToolRefusal } from "../src/local/probe-errors.ts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const config: ProbeLocalModelConfig = { maxSteps: 4, maxOutputTokens: 128, tokenUpperBound: 16384 };
const reference = (text: string) => ({ sha256: probeHash(text), bytes: Buffer.byteLength(text) });

function state() {
  const value = guidanceProbeFixture(), actual = localProbeFingerprints(config), registration = value.registration;
  registration.snapshots.systemPolicy = actual.systemPolicy;
  registration.manifest.inputs.systemPolicy = { sha256: probeHash(actual.systemPolicy), bytes: Buffer.byteLength(actual.systemPolicy) };
  registration.manifest.runtime = { runtimeSha256: actual.runtimeSha256, toolsetSha256: actual.toolsetSha256, modelConfigSha256: actual.modelConfigSha256 };
  registration.manifest.limits.tokens = config.tokenUpperBound! * config.maxSteps;
  return { registration, binding: value.host, receipt: { id: guidanceProbeManifestKey(registration.manifest), revision: 0, state: "declared", already: false },
    counters: { workerAttempts: 0, editorAttempts: 0, modelCalls: 0, toolCalls: 0, tokensReserved: 0, tokensObservedKnown: 0,
      inputBytes: 0, scratchBytes: 0, outputBytes: 0, elapsedHighWaterMs: 0, usageUnknown: false },
    firstReservedAt: null, admissionHold: "none", cancelRequested: false, notNeeded: 0, sessions: [] } as ProbeStoredState;
}

function effects(signal = new AbortController().signal) {
  const requests: ProbeFakeEffectRequest[] = [];
  let pending = false, current = true;
  const port: ProbeFakeEffects = {
    current() { if (!current || signal.aborted) throw new ProbeLocalError("interrupted"); },
    async runEffect(request, execute) {
      port.current(); if (pending) throw new Error("fixture detects a nested descriptor");
      requests.push(request); pending = true;
      try {
        const observed = await execute(signal);
        expect(observed.observationSha256).toBe(probeHash(guidanceProbeCanonical({ request, usage: observed.usage })));
        return { kind: "executed" as const, value: observed.value };
      } finally { pending = false; }
    },
  };
  let sequence = 0;
  const accounting: ProbeLocalEffectScope = { effects: port, next: () => sequence++, current: port.current };
  return { port, accounting, requests, withdraw: () => { current = false; } };
}

function setup(script: (body: unknown, signal: AbortSignal | undefined) => Promise<ChatResult>, overrides: Partial<LocalOptions> = {},
  inputFiles: readonly { dataId: string; relative: string; content: string }[] = []) {
  const parent = mkdtempSync(join(tmpdir(), "ahub-probe-local-fixture-")), root = join(parent, "workspace"), home = join(parent, "home");
  for (const directory of [root, home, join(root, "scratch"), join(root, "output")]) mkdirSync(directory);
  cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
  const descriptors = inputFiles.map(file => {
    writeFileSync(join(root, file.relative), file.content, { mode: 0o400 });
    return { dataId: file.dataId, relative: file.relative, sha256: probeHash(file.content), bytes: Buffer.byteLength(file.content) };
  });
  const workspace: ProbeWorkspace = { role: "worker", root, home, scratch: join(root, "scratch"), output: join(root, "output"),
    inputDigest: probeHash(JSON.stringify(descriptors)), files: descriptors, allowedWrites: [join(root, "output/result.txt")] };
  let stopped = 0;
  const confinement: ProbeConfinement = { workspace, profile: "fixture-only, not an OS proof", env: {}, stop: async () => { stopped++; } };
  const calls: string[] = [], bodies: unknown[] = [], ledger = effects();
  const spy = (name: string) => () => { calls.push(name); };
  const opts: LocalOptions = { cwd: root, omni: { chat: async (body, options) => { bodies.push(body); return script(body, options?.signal); } } as OmniRoute,
    fixedModel: GUIDANCE_PROBE_MODEL, maxSteps: config.maxSteps, tools: { deny: [], permit: async () => true },
    capture: { init: spy("capture.init"), observe: spy("capture.observe"), summarize: spy("capture.summarize"), end: spy("capture.end") } as unknown as Capture,
    onTool: spy("tool"), onUsage: spy("usage"), onRoute: spy("route"), onAdvisor: spy("advisor"), onRouteOutcome: spy("outcome"),
    onLimit: spy("limit"), onApprovalStop: spy("approval"), log: spy("log"), beforeInput: spy("beforeInput"), inputReleased: spy("inputReleased"),
    titlePreface: () => { calls.push("titlePreface"); return "ordinary title"; },
    getModelOverride: () => { calls.push("override"); return { model: "wrong/model", applied: spy("applied") }; },
    turnPolicy: () => { calls.push("policy"); return { pii: false, fixedModel: "wrong/model" }; },
    taskTool: async () => { calls.push("taskTool"); return "must not run"; },
    admitBudget: async () => { calls.push("ordinaryBudget"); return []; }, ...overrides };
  const peer = new LocalPeer("local", opts, confinement, "fixture_only");
  peer.onMessage = spy("message"); peer.onFinalAnswer = spy("answer"); peer.onState = spy("state"); peer.onFailed = spy("failed");
  peer.onDoing = spy("doing"); peer.onDelivery = spy("delivery"); peer.recordInstruction = () => { calls.push("record"); return "ordinary record"; };
  cleanup.push(() => peer.stopProbe());
  const saved = state(), slot = saved.registration.manifest.slots[0]!;
  if (descriptors.length) {
    saved.registration.snapshots.dataPolicy.admittedData = descriptors.map(file => ({ id: file.dataId, sha256: file.sha256, bytes: file.bytes }));
    saved.registration.snapshots.dataPolicy.roles.worker = { dataIds: descriptors.map(file => file.dataId), guidanceOnlyExperience: true };
    saved.registration.manifest.inputs.dataPolicy = reference(guidanceProbeCanonical(saved.registration.snapshots.dataPolicy));
    saved.receipt.id = guidanceProbeManifestKey(saved.registration.manifest);
  }
  const prepared = prepareLocalProbeInput(saved, slot, saved.binding.baselineGuidance, descriptors, config);
  const session: ProbeLocalSession = { purpose: "guidance_probe", prepared, workspace, confinement, config, accounting: ledger.accounting,
    reserve: async (charges, descriptor) => {
      if (Object.values(charges).some(value => value > 0)) await probeLocalEffect(ledger.accounting, "resources", descriptor, charges, undefined,
        async () => ({ value: undefined, usage: 0 }));
    } };
  return { peer, opts, calls, bodies, ledger, session, workspace, confinement, stopped: () => stopped };
}
const result = (content = "private fixture answer"): ChatResult => ({ message: { role: "assistant", content }, servedModel: GUIDANCE_PROBE_MODEL,
  servedModelExact: true, usage: { totalTokens: 5 } });

test("full initial input changes only its single worker guidance slot and contains stable host fingerprints", () => {
  const saved = state(), slot = saved.registration.manifest.slots[0]!;
  const baseline = prepareLocalProbeInput(saved, slot, "baseline guidance", [], config), candidate = prepareLocalProbeInput(saved, slot, "candidate guidance", [], config);
  expect(candidate.nonGuidanceInputSha256).toBe(baseline.nonGuidanceInputSha256);
  const left = JSON.parse(baseline.inputFrame), right = JSON.parse(candidate.inputFrame);
  expect(left.messages[1].content).toBe("baseline guidance"); expect(right.messages[1].content).toBe("candidate guidance");
  left.messages[1].content = ""; right.messages[1].content = ""; expect(left).toEqual(right);
  expect(baseline.inputFrame).toContain("/workspace"); expect(baseline.inputFrame).not.toContain("agent-hub-local-");
  expect(baseline.request.tools).toHaveLength(3);
  saved.registration.manifest.runtime.toolsetSha256 = probeHash("changed toolset");
  expect(() => prepareLocalProbeInput(saved, slot, "guidance", [], config)).toThrow(ProbeLocalError);
});

test("fixture-only private LocalPeer reuses its loop, charges writes before I/O and excludes every ordinary observer", async () => {
  let step = 0;
  const f = setup(async () => ++step === 1 ? { ...result(), message: { role: "assistant", content: null, tool_calls: [
    { id: "write", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "/workspace/output/result.txt", content: "owned" }) } },
    { id: "send", type: "function", function: { name: "hub_send", arguments: JSON.stringify({ text: "must not publish" }) } },
    { id: "shell", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "must not execute" }) } },
  ] } } : result());
  const answer = await f.peer.runProbe(f.session, new AbortController().signal);
  expect(answer.answer).toBe("private fixture answer"); expect(answer.complete).toBe(true);
  expect(readFileSync(join(f.workspace.output, "result.txt"), "utf8")).toBe("owned");
  expect(f.calls).toEqual([]); expect(f.peer.state).toBe("offline");
  expect((f.peer as unknown as { history: unknown[] }).history).toEqual([]);
  expect(JSON.stringify(f.bodies)).not.toContain(f.workspace.root);
  expect(JSON.stringify(f.bodies)).not.toContain("ordinary record");
  expect(JSON.stringify(f.bodies[0])).toBe(f.session.prepared.inputFrame);
  const tools = f.ledger.requests.filter(request => request.unit === "tool_calls");
  expect(tools).toHaveLength(3); expect(tools[0]!.charges?.outputBytes).toBe(5);
  expect(f.ledger.requests.filter(request => request.unit === "model_calls")).toHaveLength(2);
  expect(f.ledger.requests.find(request => request.unit === "model_calls" && request.charges?.inputBytes)?.charges?.inputBytes).toBe(Buffer.byteLength(JSON.stringify(f.bodies[1])));
  expect((f.bodies[1] as { messages: { role: string; content: string }[] }).messages.filter(message => message.role === "tool").slice(1).every(message => message.content.startsWith("error:"))).toBe(true);
  await f.peer.stopProbe(); expect(f.stopped()).toBeGreaterThan(0); expect(f.calls).toEqual([]);
  await expect(f.peer.runProbe(f.session, new AbortController().signal)).rejects.toThrow(ProbeLocalError);
});

for (const failure of ["missing usage", "wrong model", "normalized identity"] as const) test(`private model refusal is observed and never emitted: ${failure}`, async () => {
  const f = setup(async () => failure === "missing usage" ? { ...result(), usage: undefined }
    : failure === "wrong model" ? { ...result(), servedModel: "different/model" } : { ...result(), servedModelExact: undefined });
  await expect(f.peer.runProbe(f.session, new AbortController().signal)).rejects.toThrow(ProbeLocalError);
  expect(f.calls).toEqual([]); expect(f.ledger.requests.filter(request => request.unit === "model_calls")).toHaveLength(1);
  expect(f.ledger.requests.filter(request => request.unit === "resources")).toHaveLength(0);
});

test("a large admitted tool result refuses the second call before HTTP or a new token/input reservation", async () => {
  const f = setup(async () => ({ ...result(), message: { role: "assistant", content: null,
    tool_calls: [toolCall("read", { path: "/workspace/large.txt", limit: 1 }, "large-input")] } }), {},
  [{ dataId: "large-input", relative: "large.txt", content: "x".repeat(20000) }]);
  expect(Buffer.byteLength(f.session.prepared.inputFrame) + config.maxOutputTokens).toBeLessThanOrEqual(config.tokenUpperBound!);
  const observed = await f.peer.runProbe(f.session, new AbortController().signal);
  expect(observed.complete).toBe(false); expect(observed.answer).toBe(""); expect(observed.refusal).toBe("token_ceiling");
  expect(observed.reason).toContain("token ceiling"); expect(observed.reason).toContain("reduce");
  expect(observed.servedModel).toBe(GUIDANCE_PROBE_MODEL); expect(observed.usageKnown).toBe(true);
  expect(f.bodies).toHaveLength(1);
  const models = f.ledger.requests.filter(request => request.unit === "model_calls");
  expect(models).toHaveLength(1); expect(models[0]!.reservedTokens).toBe(config.tokenUpperBound);
  expect(models[0]!.charges?.inputBytes).toBeUndefined();
  expect(f.ledger.requests.filter(request => request.unit === "tool_calls")).toHaveLength(1);
  expect(f.ledger.requests.filter(request => request.unit === "resources")).toHaveLength(0); expect(f.calls).toEqual([]);
});

test("prepared model instructions show only logical admitted write targets", () => {
  const saved = state(), prepared = prepareLocalProbeInput(saved, saved.registration.manifest.slots[0]!, saved.binding.baselineGuidance, [], config);
  expect(prepared.request.messages[0]!.content).toContain("/workspace/output/result.txt");
  expect(prepared.request.messages[0]!.content).toContain("No other target is writable");
  expect(prepared.inputFrame).not.toContain(saved.binding.requestConnectionId);
});

test("a known pre-tool workspace ceiling is a safe refusal result and never invokes the write body", async () => {
  let calls = 0;
  const f = setup(async () => {
    if (++calls === 1) {
      return { ...result(), message: { role: "assistant", content: null,
        tool_calls: [toolCall("write", { path: "/workspace/output/result.txt", content: "must not write" }, "workspace-cap")] } };
    }
    return result("completed without a write");
  });
  const admit = f.ledger.port.runEffect;
  f.ledger.port.runEffect = (request, execute) => {
    if (request.unit === "tool_calls") throw new ProbeToolRefusal("workspace_ceiling");
    return admit(request, execute);
  };
  const observed = await f.peer.runProbe(f.session, new AbortController().signal);
  expect(observed.complete).toBe(true); expect(existsSync(join(f.workspace.output, "result.txt"))).toBe(false);
  const refused = (f.bodies[1] as { messages: { role: string; content: string }[] }).messages.find(message => message.role === "tool")!.content;
  expect(refused).toContain("workspace ceiling"); expect(refused).toContain("reduce");
  expect(refused).not.toContain(f.workspace.root);
  expect(f.ledger.requests.filter(request => request.unit === "tool_calls")).toHaveLength(0); expect(f.calls).toEqual([]);
});

test("private stop joins an uncooperative model promise and never turns abort into a final answer", async () => {
  let started!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const f = setup(async () => { started(); await gate; return result(); }); cleanup.push(release);
  const running = f.peer.runProbe(f.session, new AbortController().signal).then(value => ({ value }), error => ({ error }));
  await began;
  let stopped = false;
  const stopping = f.peer.stopProbe().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false); expect(f.stopped()).toBe(0);
  release(); const settled = await running; await stopping;
  expect("error" in settled).toBe(true); expect(f.calls).toEqual([]); expect(f.stopped()).toBeGreaterThan(0);
});

test("private stop also joins a normal approval port that has not settled after abort", async () => {
  let started!: () => void, release!: (decision: boolean) => void;
  const began = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<boolean>(resolve => { release = resolve; });
  const f = setup(async () => ({ ...result(), message: { role: "assistant", content: null, tool_calls: [
    toolCall("write", { path: "/workspace/output/result.txt", content: "must not write" }, "pending-permission"),
  ] } }));
  f.opts.tools.permit = async () => { started(); return gate; }; cleanup.push(() => release(false));
  const running = f.peer.runProbe(f.session, new AbortController().signal).then(value => ({ value }), error => ({ error }));
  await began;
  let stopped = false;
  const stopping = f.peer.stopProbe().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false); expect(f.stopped()).toBe(0);
  release(false); const settled = await running; await stopping;
  expect("error" in settled).toBe(true); expect(f.calls).toEqual([]);
  expect(existsSync(join(f.workspace.output, "result.txt"))).toBe(false);
});

test("an envelope purpose cannot enter or consume the private probe lifecycle", async () => {
  const f = setup(async () => result()), forged = { ...newEnvelope(USER, "ordinary message"), purpose: "guidance_probe" };
  await expect(f.peer.deliver([forged])).rejects.toThrow(ProbeLocalError);
  expect(f.bodies).toEqual([]); expect(f.calls).toEqual([]);
  expect((await f.peer.runProbe(f.session, new AbortController().signal)).complete).toBe(true);
  expect(f.bodies).toHaveLength(1); expect(f.calls).toEqual([]);
});

test("a structural fixture profile is refused by the default native probe entry before a model call", async () => {
  const f = setup(async () => result()), peer = new LocalPeer("local", f.opts, f.confinement);
  cleanup.push(() => peer.stopProbe());
  await expect(peer.runProbe(f.session, new AbortController().signal)).rejects.toThrow();
  expect(f.bodies).toEqual([]); expect(f.calls).toEqual([]);
});

test("the unwired adapter's explicit fixture path prepares and reuses the exact request before private collection", async () => {
  const f = setup(async () => result()), saved = state(), slot = saved.registration.manifest.slots[0]!;
  const adapter = createGuidanceProbeLocalAdapter({ omni: f.opts.omni, config, permit: async () => true, current: () => {},
    resolveInput: () => ({ files: [], verifySource: () => "task_source" }), fixture: { evidence: "fixture_only",
      materialize: async input => { await input.reserveStorage(0); return f.workspace; }, confine: async () => f.confinement } });
  const frame = await adapter.prepareWorkerFrame(saved, slot, saved.binding.baselineGuidance);
  const reservation = { key: { projectKey: saved.registration.manifest.projectKey, id: guidanceProbeManifestKey(saved.registration.manifest) }, slotId: slot.id, generation: 1, revision: 1 };
  const observed = await adapter.ports.launch({ reservation, slot, manifest: saved.registration.manifest, inputFrame: frame.inputFrame,
    inputSha256: probeHash(frame.inputFrame), nonGuidanceInputSha256: frame.nonGuidanceInputSha256, purpose: "guidance_probe" }, f.ledger.port, new AbortController().signal);
  expect(observed.outcome).toBe("closed_fixture"); expect(observed.usage).toBe("known_fixture");
  expect(JSON.stringify(f.bodies[0])).toBe(frame.inputFrame); expect(f.calls).toEqual([]);
  expect(f.ledger.requests.filter(request => request.unit === "model_calls")).toHaveLength(1);
  expect(f.ledger.requests.find(request => request.unit === "resources")?.charges?.outputBytes).toBe(Buffer.byteLength("private fixture answer"));
  expect((await adapter.ports.stop({ reservation }, new AbortController().signal)).stopped).toBe("known_fixture");
  expect((await adapter.ports.stop({ reservation: { ...reservation } }, new AbortController().signal)).stopped).toBe("unknown");
});

test.skipIf(process.platform !== "darwin")("default real confinement plus a fake model exercises the complete private factory lifecycle", async () => {
  const saved = state(), slot = saved.registration.manifest.slots[0]!, ledger = effects();
  let parent: { directory: string; dev: number; ino: number } | undefined, models = 0;
  const adapter = createGuidanceProbeLocalAdapter({ omni: { chat: async () => { models++; return result(); } } as unknown as OmniRoute,
    config, permit: async () => true, current: () => {}, resolveInput: () => ({ files: [], verifySource: () => "task_source" }),
    workspaceOwned: workspace => {
      const directory = probeWorkspacePrivateRoot(workspace), identity = lstatSync(directory);
      parent = { directory, dev: identity.dev, ino: identity.ino };
    } });
  const frame = await adapter.prepareWorkerFrame(saved, slot, saved.binding.baselineGuidance);
  const reservation = { key: { projectKey: saved.registration.manifest.projectKey, id: guidanceProbeManifestKey(saved.registration.manifest) }, slotId: slot.id, generation: 1, revision: 1 };
  cleanup.push(async () => {
    const stopped = await adapter.ports.stop({ reservation }, new AbortController().signal);
    if (stopped.stopped !== "known_fixture") throw new Error("native fixture ownership remains uncertain; retain its private root");
    if (parent) {
      const current = lstatSync(parent.directory);
      expect(current.isDirectory() && !current.isSymbolicLink()).toBe(true);
      expect([current.dev, current.ino]).toEqual([parent.dev, parent.ino]);
      rmSync(parent.directory, { recursive: true, force: true });
    }
  });
  const observed = await adapter.ports.launch({ reservation, slot, manifest: saved.registration.manifest, inputFrame: frame.inputFrame,
    inputSha256: probeHash(frame.inputFrame), nonGuidanceInputSha256: frame.nonGuidanceInputSha256, purpose: "guidance_probe" }, ledger.port, new AbortController().signal);
  expect(parent).toBeDefined(); expect(models).toBe(1);
  expect(observed.outcome).toBe("closed_fixture"); expect(observed.usage).toBe("known_fixture");
});

test("actual loopback HTTP request bytes preserve the prepared frame and omit internal tool outcome markers", async () => {
  const prior = process.env.OMNIROUTE_API_KEY; process.env.OMNIROUTE_API_KEY = "probe-fixture-key";
  cleanup.push(() => { if (prior === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = prior; });
  const server = startFakeModelServer({ key: "probe-fixture-key", script: (_body, call) => call === 1
    ? { tool_calls: [toolCall("hub_send", { text: "refused fixture message" }, "fixture-tool")] } : { content: "fixture HTTP answer" } });
  cleanup.push(server.stop);
  const client = new OmniRoute({ urls: [server.url], access_hosts: [] });
  const f = setup(async (body, signal) => {
    const received = await client.chat(body as Parameters<OmniRoute["chat"]>[0], { signal });
    // The existing fake omits usage and model. This constructor-only observation is fixture data, never provider proof.
    return { ...received, servedModel: GUIDANCE_PROBE_MODEL, servedModelExact: true, usage: { totalTokens: 5 } };
  });
  await f.peer.runProbe(f.session, new AbortController().signal);
  expect(server.requests).toHaveLength(2);
  expect(JSON.stringify(server.requests[0]!.body)).toBe(f.session.prepared.inputFrame);
  for (let index = 0; index < server.requests.length; index++) {
    expect(JSON.stringify(server.requests[index]!.body)).toBe(JSON.stringify(f.bodies[index]));
    expect(server.requests[index]!.body.stream).toBe(false);
    expect(server.requests[index]!.body.messages.every((message: object) => !Object.hasOwn(message, "is_error"))).toBe(true);
  }
  expect((f.bodies[1] as { messages: { role: string; content: string }[] }).messages.find(message => message.role === "tool")?.content.startsWith("error:")).toBe(true);
  expect(f.calls).toEqual([]);
});

test("fresh authority is checked after normal write approval and before any filesystem write", async () => {
  const f = setup(async () => ({ ...result(), message: { role: "assistant", content: null, tool_calls: [
    { id: "write", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "/workspace/output/result.txt", content: "owned" }) } },
  ] } }));
  f.opts.tools.permit = async () => { f.ledger.withdraw(); return true; };
  await expect(f.peer.runProbe(f.session, new AbortController().signal)).rejects.toThrow(ProbeLocalError);
  expect(existsSync(join(f.workspace.output, "result.txt"))).toBe(false);
  expect(f.calls).toEqual([]); expect(f.bodies).toHaveLength(1);
});

test("an exhausted retained-output budget returns no final answer to the collector", async () => {
  const f = setup(async () => result());
  f.session.reserve = async () => { throw new ProbeLocalError("interrupted"); };
  await expect(f.peer.runProbe(f.session, new AbortController().signal)).rejects.toThrow(ProbeLocalError);
  expect(f.ledger.requests.filter(request => request.unit === "model_calls")).toHaveLength(1);
  expect(f.calls).toEqual([]);
});

test("selector and reflector requests do not inherit worker-only inputs or identity fields", () => {
  const saved = state(); saved.registration.snapshots.improverContext = "private frozen experience";
  saved.registration.snapshots.baselineContext = "worker-only baseline context";
  saved.binding.baselineGuidance = "worker-only role guidance";
  saved.registration.manifest.inputs.baselineContext = reference(saved.registration.snapshots.baselineContext);
  saved.registration.manifest.improverContextHash = probeHash(saved.registration.snapshots.improverContext);
  saved.registration.manifest.improverContextBytes = Buffer.byteLength(saved.registration.snapshots.improverContext);
  saved.registration.manifest.guidance.baselineSha256 = probeHash(saved.binding.baselineGuidance);
  const anonymous = { dataId: "candidate1", relative: "item-a.txt", sha256: probeHash("anonymous result"), bytes: Buffer.byteLength("anonymous result") };
  saved.registration.snapshots.dataPolicy.admittedData = [{ id: anonymous.dataId, sha256: anonymous.sha256, bytes: anonymous.bytes }];
  saved.registration.snapshots.dataPolicy.roles.select = { dataIds: [anonymous.dataId], anonymizedDeliverables: true };
  saved.registration.manifest.inputs.dataPolicy = reference(guidanceProbeCanonical(saved.registration.snapshots.dataPolicy));
  saved.receipt.id = guidanceProbeManifestKey(saved.registration.manifest);
  const selector: ProbeSlot = { id: "select", stage: "select", role: "select", arm: "none" };
  const reflector: ProbeSlot = { id: "reflect", stage: "reflect", role: "reflect", arm: "none" };
  const select = prepareLocalProbeInput(saved, selector, saved.binding.baselineGuidance, [anonymous], config);
  const reflect = prepareLocalProbeInput(saved, reflector, saved.binding.baselineGuidance, [], config);
  for (const frame of [select.inputFrame, reflect.inputFrame]) {
    expect(frame).not.toContain("worker-only"); expect(frame).not.toContain("private frozen experience");
    expect(frame).not.toContain(saved.registration.manifest.experimentId); expect(frame).not.toContain(saved.binding.requestConnectionId);
    for (const arm of ["baseline", "candidate1", "candidate2", "successor"]) expect(frame).not.toContain(`\"${arm}\"`);
  }
  expect(JSON.parse(reflect.request.messages[2]!.content!)).toEqual({ role: "reflect", files: [] });
  expect(JSON.parse(select.request.messages[2]!.content!)).toEqual({ role: "select", task: saved.registration.snapshots.task,
    files: [{ relative: anonymous.relative, sha256: anonymous.sha256, bytes: anonymous.bytes }] });
});

for (const drift of ["destination", "order"] as const) test(`factory checks retained actual baseline input across a reopen: ${drift}`, async () => {
  const saved = state(), baselineSlot = saved.registration.manifest.slots[0]!, candidateSlot = saved.registration.manifest.slots[2]!;
  const files = [{ dataId: "one", relative: "one.txt", sha256: probeHash("one"), bytes: Buffer.from("one") },
    { dataId: "two", relative: "two.txt", sha256: probeHash("two"), bytes: Buffer.from("two") }];
  saved.registration.snapshots.dataPolicy.admittedData = files.map(file => ({ id: file.dataId, sha256: file.sha256, bytes: file.bytes.length }));
  saved.registration.snapshots.dataPolicy.roles.worker = { dataIds: files.map(file => file.dataId), guidanceOnlyExperience: true };
  saved.registration.manifest.inputs.dataPolicy = reference(guidanceProbeCanonical(saved.registration.snapshots.dataPolicy));
  saved.receipt.id = guidanceProbeManifestKey(saved.registration.manifest);
  const descriptors = files.map(file => ({ dataId: file.dataId, relative: file.relative, sha256: file.sha256, bytes: file.bytes.length }));
  const baseline = prepareLocalProbeInput(saved, baselineSlot, saved.binding.baselineGuidance, descriptors, config);
  saved.sessions = [{ slotId: baselineSlot.id, generation: 1, revision: 1, state: "closed_fixture", candidateArtifactSha256: null,
    coverage: { inputFrameSha256: baseline.inputSha256, inputFrameBytes: Buffer.byteLength(baseline.inputFrame), launchExposed: true,
      preLaunchFailure: false, modelCalls: 1, modelUsageKnown: 1, toolCalls: 0, toolUsageKnown: 0, usageUnknown: false, coverageVerified: true } }];
  const changed = drift === "destination" ? [{ ...files[0]!, relative: "different.txt" }, files[1]!] : [...files].reverse();
  let models = 0;
  const adapter = createGuidanceProbeLocalAdapter({ omni: { chat: async () => { models++; return result(); } } as unknown as OmniRoute,
    config, permit: async () => true, resolveInput: () => ({ files: changed, verifySource: () => "task_source" }), current: () => {} });
  await expect(adapter.prepareWorkerFrame(saved, candidateSlot, "candidate guidance")).rejects.toThrow(ProbeLocalError);
  expect(models).toBe(0);
});

test("a retained successful preregistered baseline retry remains the actual-input comparison authority", async () => {
  const saved = state(), original = saved.registration.manifest.slots[0]!, candidate = saved.registration.manifest.slots[2]!;
  const retry: ProbeSlot = { ...original, id: "baseline-retry", retryOf: original.id };
  saved.registration.manifest.slots = [original, retry, ...saved.registration.manifest.slots.slice(1)];
  saved.receipt.id = guidanceProbeManifestKey(saved.registration.manifest);
  const baseline = prepareLocalProbeInput(saved, retry, saved.binding.baselineGuidance, [], config);
  saved.sessions = [{ slotId: original.id, generation: 1, revision: 1, state: "failed_known", candidateArtifactSha256: null,
    coverage: { inputFrameSha256: baseline.inputSha256, inputFrameBytes: Buffer.byteLength(baseline.inputFrame), launchExposed: false,
      preLaunchFailure: true, modelCalls: 0, modelUsageKnown: 0, toolCalls: 0, toolUsageKnown: 0, usageUnknown: false, coverageVerified: false } },
  { slotId: retry.id, generation: 2, revision: 2, state: "closed_fixture", candidateArtifactSha256: null,
    coverage: { inputFrameSha256: baseline.inputSha256, inputFrameBytes: Buffer.byteLength(baseline.inputFrame), launchExposed: true,
      preLaunchFailure: false, modelCalls: 1, modelUsageKnown: 1, toolCalls: 0, toolUsageKnown: 0, usageUnknown: false, coverageVerified: true } }];
  const adapter = createGuidanceProbeLocalAdapter({ omni: {} as OmniRoute, config, permit: async () => true, current: () => {},
    resolveInput: () => ({ files: [], verifySource: () => "task_source" }) });
  const prepared = await adapter.prepareWorkerFrame(saved, candidate, "candidate guidance");
  expect(prepared.nonGuidanceInputSha256).toBe(baseline.nonGuidanceInputSha256);
  expect(JSON.parse(prepared.inputFrame).messages[1].content).toBe("candidate guidance");
});

/** A real materialized workspace under the fixture confinement, whose model writes `answer` into the declared output file (and `scratch` into scratch) while it runs. */
async function harvestRun(answer: string, retentionRoot: string | undefined, scratch = "", finalWrite = "", scratchLevels = 0) {
  const saved = state(), slot = saved.registration.manifest.slots[0]!, ledger = effects();
  let created: ProbeWorkspace | undefined, privateRoot: string | undefined, stopped = 0;
  const adapter = createGuidanceProbeLocalAdapter({ omni: { chat: async () => {
      writeFileSync(join(created!.output, "answer.txt"), answer); if (scratch) writeFileSync(join(created!.scratch, "work.bin"), scratch);
      if (scratchLevels) { let directory = created!.scratch; for (let level = 0; level < scratchLevels; level++) { directory = join(directory, `s${level}`); mkdirSync(directory); } writeFileSync(join(directory, "deep.bin"), "tiny"); }
      return result(); } } as unknown as OmniRoute,
    config, permit: async () => true, current: () => {}, resolveInput: () => ({ files: [], verifySource: () => "task_source" }), ...(retentionRoot ? { retentionRoot } : {}),
    workspaceOwned: workspace => { privateRoot = probeWorkspacePrivateRoot(workspace); },
    fixture: { evidence: "fixture_only",
      materialize: async input => { created = await materializeProbeWorkspace({ ...input, policy: { ...input.policy, allowedWrites: [{ root: "output", relative: "answer.txt" }] } }); return created; },
      // A straggler child may still be writing until the stop reports quiescence. The fixture stop plays that child's last write, so only a harvest taken AFTER
      // the stop can see it: collecting before the stop would hash the earlier bytes of a tree that is still moving.
      confine: async workspace => ({ workspace, profile: "fixture-only, not an OS proof", env: {}, stop: async () => { stopped++; if (finalWrite) writeFileSync(join(workspace.output, "answer.txt"), finalWrite); } }) } });
  cleanup.push(() => { if (privateRoot) rmSync(privateRoot, { recursive: true, force: true }); });
  const frame = await adapter.prepareWorkerFrame(saved, slot, saved.binding.baselineGuidance);
  const reservation = { key: { projectKey: saved.registration.manifest.projectKey, id: guidanceProbeManifestKey(saved.registration.manifest) }, slotId: slot.id, generation: 1, revision: 1 };
  const observed = await adapter.ports.launch({ reservation, slot, manifest: saved.registration.manifest, inputFrame: frame.inputFrame,
    inputSha256: probeHash(frame.inputFrame), nonGuidanceInputSha256: frame.nonGuidanceInputSha256, purpose: "guidance_probe" }, ledger.port, new AbortController().signal);
  return { observed, limits: saved.registration.manifest.limits, stopped: () => stopped };
}
const retentionDir = () => { const root = mkdtempSync(join(tmpdir(), "ahub-probe-retain-")); cleanup.push(() => rmSync(root, { recursive: true, force: true })); return root; };

test("the adapter harvests the declared output after the stop reported quiescence, and reports what it measured", async () => {
  const root = retentionDir();
  const { observed } = await harvestRun("the answer", root);
  expect(observed.outcome).toBe("closed_fixture");
  const measured = observed.measured!;
  expect(measured.output.entries).toEqual([{ relative: "output/answer.txt", sha256: probeHash("the answer"), bytes: Buffer.byteLength("the answer") }]);
  expect(measured.teardownVerified).toBe(true); expect(measured.servedModel).toBe(GUIDANCE_PROBE_MODEL);
  expect(measured.limits).toEqual([]);
  const retained = measured.retained!;
  expect(retained.directory.startsWith(root)).toBe(true);
  expect(readFileSync(join(retained.directory, "output", "answer.txt"), "utf8")).toBe("the answer");
  expect(readdirSync(root)).toHaveLength(1);
});

test("without a retention root the output is hashed but nothing is copied or kept", async () => {
  const { observed } = await harvestRun("the answer", undefined);
  expect(observed.measured!.output.entries).toHaveLength(1);
  expect(observed.measured!.retained).toBeUndefined();
});

test("an output past the declared cap is excluded, never retained or hashed, so the receipt cannot be a success", async () => {
  const root = retentionDir(), probe = await harvestRun("seed", undefined);
  const cap = probe.limits.outputBytes;
  const { observed } = await harvestRun("x".repeat(cap + 1), root);
  expect(observed.measured!.output.entries).toEqual([]);
  expect(observed.measured!.output.excluded).toEqual([{ relative: "output/answer.txt", reason: "over_file_cap" }]);
  expect(observed.measured!.retained).toBeUndefined();
  expect(readdirSync(root)).toEqual([]);
});

test("scratch left past the declared scratch cap carries storage_over_cap and retains nothing", async () => {
  const root = retentionDir(), probe = await harvestRun("seed", undefined);
  const { observed } = await harvestRun("small", root, "y".repeat(probe.limits.scratchBytes + 1));
  expect(observed.measured!.limits).toContain("storage_over_cap");
  expect(observed.measured!.scratchBytes).toBeGreaterThan(probe.limits.scratchBytes);
  expect(observed.measured!.retained).toBeUndefined();
  expect(readdirSync(root)).toEqual([]);
});

test("the harvest happens AFTER the confinement stop: a straggler's last write is what gets hashed, and the stop ran first", async () => {
  const root = retentionDir();
  const { observed, stopped } = await harvestRun("written while running", root, "", "written by the straggler before the stop returned");
  expect(stopped()).toBeGreaterThan(0);
  expect(observed.measured!.output.entries).toEqual([{ relative: "output/answer.txt", sha256: probeHash("written by the straggler before the stop returned"),
    bytes: Buffer.byteLength("written by the straggler before the stop returned") }]);
  expect(readFileSync(join(observed.measured!.retained!.directory, "output/answer.txt"), "utf8")).toBe("written by the straggler before the stop returned");
});

test("when the stop cannot confirm quiescence nothing is read: the output of a possibly running tree is not evidence", async () => {
  const saved = state(), slot = saved.registration.manifest.slots[0]!, ledger = effects(), retentionRootOf = retentionDir();
  let created: ProbeWorkspace | undefined, privateRoot: string | undefined;
  const adapter = createGuidanceProbeLocalAdapter({ omni: { chat: async () => { writeFileSync(join(created!.output, "answer.txt"), "partial"); return result(); } } as unknown as OmniRoute,
    config, permit: async () => true, current: () => {}, resolveInput: () => ({ files: [], verifySource: () => "task_source" }), retentionRoot: retentionRootOf,
    workspaceOwned: workspace => { privateRoot = probeWorkspacePrivateRoot(workspace); },
    fixture: { evidence: "fixture_only",
      materialize: async input => { created = await materializeProbeWorkspace({ ...input, policy: { ...input.policy, allowedWrites: [{ root: "output", relative: "answer.txt" }] } }); return created; },
      confine: async workspace => ({ workspace, profile: "fixture-only, not an OS proof", env: {}, stop: async () => { throw new Error("process tree still running"); } }) } });
  cleanup.push(() => { if (privateRoot) rmSync(privateRoot, { recursive: true, force: true }); });
  const frame = await adapter.prepareWorkerFrame(saved, slot, saved.binding.baselineGuidance);
  const reservation = { key: { projectKey: saved.registration.manifest.projectKey, id: guidanceProbeManifestKey(saved.registration.manifest) }, slotId: slot.id, generation: 1, revision: 1 };
  const outcome = await adapter.ports.launch({ reservation, slot, manifest: saved.registration.manifest, inputFrame: frame.inputFrame,
    inputSha256: probeHash(frame.inputFrame), nonGuidanceInputSha256: frame.nonGuidanceInputSha256, purpose: "guidance_probe" }, ledger.port, new AbortController().signal).catch(error => error);
  // An uncertain stop makes the launch itself fail as interrupted, before any harvest: the failed-close branch throws first. The guard inside the harvest
  // (`!entry.closed || entry.closeFailed`) is defence in depth behind that throw, so removing it changes no observable behaviour and is not mutation-tested.
  // What this test pins is the observable contract: no partial output of an uncertain tree was copied out.
  expect(outcome).toBeInstanceOf(ProbeLocalError);
  expect(readdirSync(retentionRootOf)).toEqual([]);
});

test("scratch nested deeper than the walk limit is unmeasured, so it counts as over the cap and nothing is retained", async () => {
  const root = retentionDir();
  const { observed } = await harvestRun("small", root, "", "", 12);
  expect(observed.measured!.limits).toContain("storage_over_cap");
  expect(observed.measured!.retained).toBeUndefined();
  expect(readdirSync(root)).toEqual([]);
});

test("host fingerprints ride on the measurement and come from the adapter's own runtime, not the declaration", async () => {
  const { observed } = await harvestRun("x", undefined);
  const actual = localProbeFingerprints(config);
  expect(observed.measured!.runtime).toEqual({ runtimeSha256: actual.runtimeSha256, toolsetSha256: actual.toolsetSha256, modelConfigSha256: actual.modelConfigSha256 });
});
