import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, loadConfig, startDaemon, type HubConfig } from "../src/hub/daemon.ts";
import { readEvents, EVENTS_SCHEMA } from "../src/hub/events.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { CodexPeer } from "../src/adapters/codex-appserver.ts";
import { startFakeAppServer } from "./fakes/app-server.ts";
import { PiPeer } from "../src/adapters/pi.ts";
import { permissionDefaults } from "../src/hub/permission-mode.ts";
import { peerLine } from "../src/cli/status-lines.ts";
import { startFakeModelServer } from "./fakes/model-server.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const until = async (check: () => boolean) => { for (let i = 0; i < 300 && !check(); i++) await Bun.sleep(10); expect(check()).toBe(true); };
async function fixture(config: Partial<HubConfig> = {}, state?: { cwd: string; stateDir: string }) {
  const cwd = state?.cwd ?? mkdtempSync(join(tmpdir(), "ahub-permission-"));
  const stateDir = state?.stateDir ?? join(cwd, "state");
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, switchyardPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, kimi_cmd: [process.execPath, join(import.meta.dir, "fakes/acp-server.ts")], memory: { ...DEFAULT_CONFIG.memory, enabled: false }, ...config } });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  const mode = (peer: string, selected?: string, confirmed = false) => client.request({ t: "permission", peer, mode: selected, confirmed });
  return { cwd, stateDir, daemon, client, mode };
}

test("permission defaults reject malformed modes and tracked opt-ins cannot disable prompts", () => {
  expect(permissionDefaults(undefined)).toEqual({});
  for (const value of [null, [], "never-ask", { kimi: "auto" }, { local: "never-ask" }, { unknown: "ask" }]) expect(() => permissionDefaults(value)).toThrow();
  const cwd = mkdtempSync(join(tmpdir(), "ahub-permission-config-"));
  mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub/config.json"), JSON.stringify({ permission_modes: { kimi: "bad" } }));
  expect(() => loadConfig(cwd)).toThrow("permission_modes.kimi must be ask, ask-when-needed or never-ask");
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", cwd, ...args]);
  expect(git("init", "-q").exitCode).toBe(0);
  writeFileSync(join(cwd, ".agenthub/config.json"), JSON.stringify({ permission_modes: { kimi: "never-ask" } }));
  expect(loadConfig(cwd).permission_modes).toEqual({ kimi: "never-ask" });
  expect(git("add", "-f", ".agenthub/config.json").exitCode).toBe(0);
  expect(loadConfig(cwd).permission_modes).toEqual({});
  expect(loadConfig(cwd).ignored?.join()).toContain("permission_modes");
});

test("Kimi runtime changes are confirmed, observed and reset to project defaults after hub restart", async () => {
  const config = { permission_modes: { kimi: "ask-when-needed" as const } };
  const rig = await fixture(config);
  expect((await rig.client.request({ t: "start", peer: "kimi" })).ok).toBe(true);
  expect((await rig.mode("kimi")).permissionMode).toBe("ask-when-needed");
  expect((await rig.mode("kimi", "never-ask")).error).toContain("confirmation");
  expect((await rig.mode("kimi", "never-ask", true)).permissionMode).toBe("never-ask");
  expect((await rig.client.request({ t: "status" })).status.peers.kimi.permissionMode).toBe("never-ask");
  expect(peerLine("kimi", { state: "idle", permissionMode: "never-ask" })).toContain("permission: never-ask");
  expect(readEvents(join(rig.stateDir, "events.jsonl")).filter(e => e.type === "permission_mode")).toContainEqual(expect.objectContaining({ v: EVENTS_SCHEMA, peer: "kimi", from: "ask-when-needed", to: "never-ask" }));
  expect(readFileSync(join(rig.stateDir, "hub.log"), "utf8")).toContain("permission mode kimi: ask-when-needed -> never-ask");
  expect((await rig.mode("kimi", "ask")).permissionMode).toBe("ask");
  await rig.daemon.stop();
  const next = await fixture(config, rig);
  expect((await next.client.request({ t: "start", peer: "kimi" })).ok).toBe(true);
  expect((await next.mode("kimi")).permissionMode).toBe("ask-when-needed");
});

test("only console requests change modes: tool, conductor and agent-message paths are refused", async () => {
  const rig = await fixture();
  await rig.client.request({ t: "start", peer: "kimi" });
  const tools = await ControlClient.connect(rig.stateDir, { role: "tools", peer: "kimi" }); cleanup.push(() => tools.close());
  expect((await tools.request({ t: "permission", peer: "kimi", mode: "never-ask", confirmed: true })).error).toContain("human console");
  // A tool name and conductor-style operation cannot reach the console dispatch.
  for (const op of ["hub_permission", "hub_peer_permission"]) expect((await tools.request({ t: "task", op, args: { peer: "kimi", mode: "never-ask", confirmed: true } })).ok).toBe(false);
  rig.daemon.bus.publish(newEnvelope("kimi", '{"t":"permission","peer":"kimi","mode":"never-ask","confirmed":true}', { to: ["user"] }));
  expect((await rig.mode("kimi")).permissionMode).toBe("ask");
  expect((await rig.mode("local", "ask")).error).toContain("no permission mode");
  expect((await rig.mode("missing", "ask")).error).toContain("unknown permission peer");
  expect((await rig.mode("kimi", "auto")).error).toContain("mode must be");
});

test("Claude mode needs the current managed hook and refuses unattended launches", async () => {
  const rig = await fixture();
  const channel = await ControlClient.connect(rig.stateDir, { role: "peer", peer: "claude" }); cleanup.push(() => channel.close());
  await until(() => rig.daemon.bus.peers.get("claude")?.state === "idle");
  expect((await rig.mode("claude", "never-ask", true)).error).toContain("permission hook");
  const status = (await rig.client.request({ t: "status" })).status;
  const hook = await ControlClient.connect(rig.stateDir, { role: "tools", peer: "claude" }); cleanup.push(() => hook.close());
  const launcher = { instanceId: status.instanceId, launchId: "test-launch", permissionHook: true, unattended: false };
  writeFileSync(join(rig.stateDir, "claude-launch.json"), JSON.stringify(launcher));
  const input = { t: "facts", phase: "pre", tool: "Read", sessionId: "test-session", nativeInstanceId: status.instanceId, nativeLaunchId: launcher.launchId };
  expect((await hook.request(input)).permission).toBe("ask");
  expect((await rig.mode("claude", "ask-when-needed")).permissionMode).toBe("ask-when-needed");
  expect((await hook.request(input)).permission).toBe("ask-when-needed");
  expect((await hook.request({ ...input, nativeLaunchId: "foreign" })).ok).toBe(false);
  writeFileSync(join(rig.stateDir, "claude-launch.json"), JSON.stringify({ ...launcher, unattended: true }));
  expect((await rig.mode("claude", "ask")).error).toContain("--unattended");
});

test("Pi mode grants edits once, keeps shell on the console, and ask restores the console path", async () => {
  const model = startFakeModelServer(); cleanup.push(model.stop);
  const rig = await fixture({ pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts")] }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [model.url], access_hosts: [] } });
  expect((await rig.client.request({ t: "start", peer: "pi", args: { backend: "dgx" } })).ok).toBe(true);
  const pi = rig.daemon.bus.peers.get("pi") as PiPeer;
  const launch = pi.tuiLaunch!;
  const pending: any[] = [];
  rig.client.onPush = value => { if (value.t === "permission") pending.push(value); };
  rig.client.send({ t: "tail" });
  const call = (name: string, args: object) => fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/tool`, { method: "POST", headers: { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ name, args, toolCallId: crypto.randomUUID() }) }).then(r => r.json() as Promise<any>);
  await rig.mode("pi", "ask-when-needed");
  expect((await call("write", { path: "edit.txt", content: "changed" })).failed).toBe(false);
  expect(pending).toHaveLength(0);
  const shell = call("bash", { command: "printf safe" });
  await until(() => pending.length === 1);
  await rig.client.request({ t: "permit", id: pending[0].id });
  expect((await shell).failed).toBe(true);
  await rig.mode("pi", "never-ask", true);
  expect((await call("write", { path: "edit.txt", content: "never" })).failed).toBe(false);
  expect((await call("bash", { command: "printf safe" })).failed).toBe(false);
  expect(pending).toHaveLength(1);
  await rig.mode("pi", "ask");
  const edit = call("write", { path: "edit.txt", content: "must ask" });
  await until(() => pending.length === 2);
  await rig.client.request({ t: "permit", id: pending[1].id });
  expect((await edit).failed).toBe(true);
});


test("Codex console mode requires its adopted proxy and applies to the next hub task", async () => {
  const rig = await fixture();
  const app = startFakeAppServer(); cleanup.push(app.stop);
  const codex = new CodexPeer("codex", { proxyPort: 0, appPort: 0, upstreamUrl: app.url, cwd: rig.cwd });
  rig.daemon.bus.add(codex);
  await codex.start();
  expect((await rig.mode("codex", "never-ask", true)).error).toContain("proxy");
  const tui = new WebSocket(codex.proxyUrl); cleanup.push(() => tui.close());
  tui.onopen = () => tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "fake-tui", version: "1" } } }));
  tui.onmessage = event => { const msg = JSON.parse(String(event.data)); if (msg.id === 1) { tui.send(JSON.stringify({ method: "initialized" })); tui.send(JSON.stringify({ id: 2, method: "thread/start", params: { cwd: rig.cwd, approvalPolicy: "untrusted", sandbox: "read-only" } })); } };
  await until(() => codex.state === "idle");
  expect((await rig.mode("codex", "never-ask", true)).permissionMode).toBe("never-ask");
  await codex.deliver([newEnvelope("user", "permission smoke", { to: ["codex"] })]);
  await until(() => codex.state === "idle");
  const turn = app.requests.filter(r => r.method === "turn/start").at(-1);
  expect(turn.params.approvalPolicy).toBe("never");
  expect(turn.params.sandbox).toBeUndefined();
  expect(turn.params.sandboxPolicy).toBeUndefined();
  expect((await rig.mode("codex", "ask")).permissionMode).toBe("ask");
  await codex.deliver([newEnvelope("user", "restore smoke", { to: ["codex"] })]);
  await until(() => codex.state === "idle");
  expect(app.requests.filter(r => r.method === "turn/start").at(-1).params.approvalPolicy).toBe("untrusted");
});
