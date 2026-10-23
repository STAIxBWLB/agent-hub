import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { CodexPeer } from "../src/adapters/codex-appserver.ts";
import { actionPolicyConfig } from "../src/hub/action-policy.ts";
import { ACTION_BUDGET_OPTION } from "../src/adapters/acp.ts";
import { sandboxAvailable } from "../src/local/sandbox.ts";
import { realPath } from "../src/hub/project.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { startFakeModelServer, toolCall } from "./fakes/model-server.ts";
import { startFakeAppServer } from "./fakes/app-server.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(check: () => boolean, reason: string) {
  for (let n = 0; n < 400 && !check(); n++) await Bun.sleep(10);
  expect(check(), reason).toBe(true);
}
async function rig(unattended = false, options: { command?: (marker: string) => string; privateAnswer?: string } = {}) {
  const prior = process.env.OMNIROUTE_API_KEY; process.env.OMNIROUTE_API_KEY = "action-fixture-key";
  cleanup.push(() => { if (prior === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = prior; });
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-local-action-"))), stateDir = join(cwd, "state");
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const model = startFakeModelServer({ key: "action-fixture-key", script: body => {
    const last = body.messages.at(-1);
    if (last?.role === "tool") return { content: options.privateAnswer && String(body.messages.findLast(message => message.role === "user")?.content).includes("ACTION:private-command") ? options.privateAnswer : `tool result: ${last.content}` };
    const marker = /ACTION:([a-z0-9-]+)/.exec(String(body.messages.findLast(message => message.role === "user")?.content))?.[1];
    if (!marker) return { content: "fixture has no action" };
    // This new directory has no git repository/remotes. The prefix is the observed harmless effect;
    // git push is classified as publish, then fails locally without any provider or network action.
    return { tool_calls: [toolCall("bash", { command: options.command?.(marker) ?? `printf ran > marker-${marker}; git push`, timeout_s: 1 })] };
  } }); cleanup.push(model.stop);
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, permissionTimeoutMs: 2000, unattended,
    config: { ...DEFAULT_CONFIG, batch_ms: 0,
      action_policy: actionPolicyConfig({ always_ask: ["publish"], budgets: { publish: 2 } }),
      omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [model.url], access_hosts: [] },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
    } }); cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  const asks: any[] = [], answers: string[] = [], pushes: any[] = [];
  client.onPush = message => { pushes.push(message); if (message.t === "permission") asks.push(message); }; client.send({ t: "tail" });
  daemon.bus.tap(event => { if (event.t === "envelope" && event.env.from === "local") answers.push(event.env.body); });
  expect((await client.request({ t: "start", peer: "local", args: { model: "vllm/test" } })).ok).toBe(true);
  expect((await client.request({ t: "permission", peer: "local", mode: "never-ask", confirmed: true })).permissionMode).toBe("never-ask");
  const send = async (marker: string) => { expect((await client.request({ t: "send", body: `ACTION:${marker}`, to: ["local"] })).ok).toBe(true); };
  const finished = async (count: number) => until(() => answers.length === count && daemon.bus.stateOf("local") === "idle", "the corresponding local tool result completes");
  const permit = (ask: any, option: string) => client.request({ t: "permit", id: ask.id, option, surface: "console" });
  const status = async () => (await client.request({ t: "status" })).status.actionPolicyInfo;
  const effect = (marker: string, answer: string) => {
    if (sandboxAvailable()) expect(readFileSync(join(cwd, `marker-${marker}`), "utf8")).toBe("ran");
    else { expect(answer).toContain("needs macOS sandbox-exec"); expect(existsSync(join(cwd, `marker-${marker}`))).toBe(false); }
  };
  return { cwd, stateDir, daemon, client, asks, answers, pushes, model, send, finished, permit, status, effect };
}

for (const unattended of [false, true]) test(`local classed calls under never-ask still ask, deny has no effect, allow_once grants no budget (unattended=${unattended})`, async () => {
  const r = await rig(unattended);
  expect((await r.status()).local).toMatchObject({ enforceable: true, remaining: { publish: 0 } });
  expect((await r.status()).local.note).toContain("always-ask active");
  await r.send("denied"); await until(() => r.asks.length === 1, "always-ask reaches the real console registry");
  expect(r.asks[0]).toMatchObject({ peer: "local", classed: true }); expect(r.asks[0].title).toContain("Action approval (publish)");
  expect(r.asks[0].options.map((option: any) => option.kind)).toEqual(["allow_once", "reject_once", "allow_once"]);
  expect(existsSync(join(r.cwd, "marker-denied"))).toBe(false);
  expect((await r.permit(r.asks[0], "deny")).ok).toBe(true); await r.finished(1);
  expect(r.answers[0]).toContain("did not approve"); expect(existsSync(join(r.cwd, "marker-denied"))).toBe(false);
  await r.send("once"); await until(() => r.asks.length === 2, "a second classed call still requires a person");
  expect((await r.permit(r.asks[1], "allow")).ok).toBe(true); await r.finished(2);
  r.effect("once", r.answers[1]!); expect((await r.status()).local.remaining.publish).toBe(0);
  expect(readFileSync(join(r.stateDir, "events.jsonl"), "utf8")).not.toContain("printf ran > marker-once");
});

test("local explicit class budget counts this call and the next, then asks again", async () => {
  const r = await rig(); await r.send("budget-one"); await until(() => r.asks.length === 1, "the class-budget choice is offered");
  expect(r.asks[0].options.find((option: any) => option.optionId === ACTION_BUDGET_OPTION)).toMatchObject({ name: "Allow publish x2 for this session", kind: "allow_once" });
  expect((await r.permit(r.asks[0], ACTION_BUDGET_OPTION)).ok).toBe(true); await r.finished(1);
  r.effect("budget-one", r.answers[0]!); expect((await r.status()).local.remaining.publish).toBe(1);
  await r.send("budget-two"); await r.finished(2); r.effect("budget-two", r.answers[1]!);
  expect(r.asks).toHaveLength(1); expect((await r.status()).local.remaining.publish).toBe(0);
  await r.send("budget-three"); await until(() => r.asks.length === 2, "an exhausted budget asks again");
  expect(r.asks[1].classed).toBe(true); expect((await r.permit(r.asks[1], "deny")).ok).toBe(true); await r.finished(3);
  expect(existsSync(join(r.cwd, "marker-budget-three"))).toBe(false);
});

test("local stop withdraws the pending class challenge; a stale budget answer cannot create a grant or effect", async () => {
  const r = await rig(); await r.send("withdrawn"); await until(() => r.asks.length === 1, "a live local challenge is registered");
  const id = r.asks[0].id;
  expect((await r.client.request({ t: "peer_stop", peer: "local" })).ok).toBe(true);
  await until(() => r.daemon.bus.stateOf("local") === "offline", "the old local owner has stopped");
  expect((await r.client.request({ t: "permit", id, option: ACTION_BUDGET_OPTION, surface: "console" })).ok).toBe(false);
  expect((await r.status()).local.remaining.publish).toBe(0); expect(existsSync(join(r.cwd, "marker-withdrawn"))).toBe(false);
  expect((await r.status()).local.enforceable).toBe(false);
});

test("status reports a live local gate enforceable but a fake-attached Codex approval-only gate conservatively unenforceable", async () => {
  const r = await rig(), native = startFakeAppServer(); cleanup.push(native.stop);
  const codex = new CodexPeer("codex", { cwd: r.cwd, proxyPort: 0, appPort: 0, upstreamUrl: native.url, permissionMode: "never-ask", actionGate: () => undefined });
  r.daemon.bus.add(codex); await codex.start(); cleanup.push(() => codex.stop());
  const tui = new WebSocket(codex.proxyUrl); cleanup.push(() => tui.close());
  await new Promise<void>(resolve => { tui.onopen = () => resolve(); });
  tui.send(JSON.stringify({ id: 1, method: "thread/start", params: {} })); await until(() => codex.state === "idle", "the fake Codex native thread attaches");
  const info = await r.status(); expect(info.local.enforceable).toBe(true); expect(info.codex.enforceable).toBe(false);
  expect(info.codex.note).toContain("native policy can execute without sending one"); expect(info.codex.note).toContain("never-ask sends approvalPolicy never");
});


test("local classed long bash exposes its complete significant tail to the person's console before deny or allow_once", async () => {
  const command = (marker: string) => `printf ran > marker-${marker}; : ${"padding ".repeat(90)}; printf tail > tail-${marker}; git push`;
  const r = await rig(false, { command });
  for (const [index, choice] of ["deny", "allow"].entries()) {
    const marker = `long-${choice}`, whole = command(marker); expect(whole.length).toBeGreaterThan(512);
    await r.send(marker); await until(() => r.asks.length === index + 1, "the full classed command reaches the person");
    const ask = r.asks[index];
    expect(ask.classed).toBe(true); expect(ask.title).toContain(whole);
    expect(ask.title).toContain(`printf tail > tail-${marker}; git push`);
    expect(ask.options.some((option: any) => option.optionId === "allow" && option.kind === "allow_once")).toBe(true);
    expect(existsSync(join(r.cwd, `marker-${marker}`))).toBe(false); expect(existsSync(join(r.cwd, `tail-${marker}`))).toBe(false);
    expect((await r.permit(ask, choice)).ok).toBe(true); await r.finished(index + 1);
    if (choice === "deny") { expect(r.answers[index]).toContain("did not approve"); expect(existsSync(join(r.cwd, `marker-${marker}`))).toBe(false); expect(existsSync(join(r.cwd, `tail-${marker}`))).toBe(false); }
    else {
      r.effect(marker, r.answers[index]!);
      if (sandboxAvailable()) expect(readFileSync(join(r.cwd, `tail-${marker}`), "utf8")).toBe("tail");
      else expect(existsSync(join(r.cwd, `tail-${marker}`))).toBe(false);
    }
  }
});

test("local private-turn approval shows the whole command only to the on-prem person, never public logs, peers or later history", async () => {
  const sensitive = "synthetic-patient-900101-1234567", privateAnswer = "synthetic private result 900101-1234567";
  const whole = `printf '%s' '${sensitive}' > marker-private-command; git push`;
  const r = await rig(false, { command: () => whole, privateAnswer });
  // The fake loopback model is a healthy non-Access gateway, exercising the actual onCampus() admission.
  const observer = await ControlClient.connect(r.stateDir, { role: "peer", peer: "claude" }); cleanup.push(() => observer.close());
  const peerPushes: any[] = []; observer.onPush = message => peerPushes.push(message);
  await until(() => r.daemon.bus.stateOf("claude") === "idle", "the ordinary peer is attached before private work");
  r.daemon.bus.publish(newEnvelope("user", "ACTION:private-command", { to: ["local"], private: true, priority: "important" }));
  await until(() => r.asks.length === 1, "the private classed command reaches the person's console");
  const ask = r.asks[0]; expect(ask.classed).toBe(true); expect(ask.title).toContain(whole);
  expect(ask.title).toContain(sensitive); expect(ask.options.some((option: any) => option.optionId === "allow")).toBe(true);
  expect(JSON.stringify(await r.client.request({ t: "status" }))).not.toContain(sensitive);
  expect((await r.permit(ask, "deny")).ok).toBe(true); await r.finished(1);
  expect(existsSync(join(r.cwd, "marker-private-command"))).toBe(false);
  // A public round-trip consumes the observer's transport after the private completion.
  expect((await observer.request({ t: "status" })).status).toBeDefined();
  expect(JSON.stringify(peerPushes)).not.toContain(sensitive); expect(JSON.stringify(peerPushes)).not.toContain(privateAnswer);
  const publicEvents = r.pushes.filter(message => message.t === "event");
  expect(publicEvents.some(message => message.e?.t === "envelope" && message.e.env.private)).toBe(true);
  expect(JSON.stringify(publicEvents)).not.toContain(sensitive); expect(JSON.stringify(publicEvents)).not.toContain(privateAnswer);
  for (const file of ["events.jsonl", "hub.log"]) {
    const log = readFileSync(join(r.stateDir, file), "utf8"); expect(log).not.toContain(sensitive); expect(log).not.toContain(privateAnswer);
  }
  // A subsequent ordinary turn observes only ordinary history, not the private tool call or its result.
  const before = r.model.requests.length;
  expect((await r.client.request({ t: "send", body: "ordinary follow-up without an action", to: ["local"] })).ok).toBe(true);
  await r.finished(2); expect(r.model.requests.length).toBeGreaterThan(before);
  const ordinary = JSON.stringify(r.model.requests.slice(before));
  expect(ordinary).not.toContain(sensitive); expect(ordinary).not.toContain(privateAnswer); expect(ordinary).not.toContain("ACTION:private-command");
});
