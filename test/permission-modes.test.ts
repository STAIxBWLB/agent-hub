import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildLaunch, claudeObservationHooks, recordClaudeLaunch, recordClaudeNative, readClaudeNative, type ClaudeLaunchRecord } from "../src/cli/launch.ts";
import { processSignature } from "../src/pi/process-signature.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, loadConfig, startDaemon, type HubConfig } from "../src/hub/daemon.ts";
import { readEvents, EVENTS_SCHEMA } from "../src/hub/events.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { CodexPeer } from "../src/adapters/codex-appserver.ts";
import { startFakeAppServer } from "./fakes/app-server.ts";
import { PiPeer } from "../src/adapters/pi.ts";
import { AGENT_CONFIG_SEGMENTS, grantablePath, isAgentConfigPath, permissionDefaults } from "../src/hub/permission-mode.ts";
import { sandboxAvailable } from "../src/local/sandbox.ts";
import { peerLine } from "../src/cli/status-lines.ts";
import { startFakeModelServer, toolCall } from "./fakes/model-server.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const until = async (check: () => boolean) => { for (let i = 0; i < 300 && !check(); i++) await Bun.sleep(10); expect(check()).toBe(true); };
async function fixture(config: Partial<HubConfig> = {}, state?: { cwd: string; stateDir: string }, native: { codexAppPort?: number; unattended?: boolean } = {}) {
  const cwd = state?.cwd ?? mkdtempSync(join(tmpdir(), "ahub-permission-"));
  const stateDir = state?.stateDir ?? join(cwd, "state");
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: native.codexAppPort ?? 0, codexProxyPort: 0, switchyardPort: 0,
    unattended: native.unattended,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, kimi_cmd: [process.execPath, join(import.meta.dir, "fakes/acp-server.ts")], memory: { ...DEFAULT_CONFIG.memory, enabled: false }, ...config } });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  const mode = (peer: string, selected?: string, confirmed = false) => client.request({ t: "permission", peer, mode: selected, confirmed });
  return { cwd, stateDir, daemon, client, mode };
}

for (const kind of ["empty", "unsigned", "live"]) test(`${kind} native-attestation lock cannot leave managed Claude hooks or recovery on the previous launch (#270)`, async () => {
  const rig = await fixture();
  const claude = await ControlClient.connect(rig.stateDir, { role: "peer", peer: "claude" }); cleanup.push(() => claude.close());
  await until(() => rig.daemon.bus.peers.get("claude")?.state === "idle");
  const status = (await rig.client.request({ t: "status" })).status;
  const hook = await ControlClient.connect(rig.stateDir, { role: "tools", peer: "claude" }); cleanup.push(() => hook.close());
  const old: ClaudeLaunchRecord = { instanceId: status.instanceId, launchId: "launch-A", launcherPid: process.pid, launcherSignature: processSignature(process.pid), permissionHook: true, hookPurpose: "permission", unattended: false };
  recordClaudeLaunch(rig.stateDir, old);
  const input = { t: "facts", tool: "Read", input: {}, nativeInstanceId: status.instanceId, hookPurpose: "permission" };
  expect((await hook.request({ ...input, phase: "session", sessionId: "session-A", nativeLaunchId: old.launchId })).ok).toBe(true);
  expect((await rig.mode("claude", "ask-when-needed")).permissionMode).toBe("ask-when-needed");
  const lock = join(rig.stateDir, "claude-launch.lock");
  const contents = kind === "empty" ? "" : JSON.stringify({ pid: process.pid, ...(kind === "live" ? { signature: processSignature(process.pid) } : {}) });
  writeFileSync(lock, contents, { mode: 0o600 });
  const current = { ...old, launchId: "launch-B" };
  expect(recordClaudeLaunch(rig.stateDir, current).recorded).toBe(true);
  const warnings: string[] = [];
  expect(await recordClaudeNative(rig.stateDir, current, process.pid + 1, "unpublished-native", warning => warnings.push(warning))).toBe(false);
  expect(readClaudeNative(rig.stateDir, current)).toBeUndefined();
  expect(warnings).toHaveLength(1); expect(warnings[0]).toContain(lock);
  expect(warnings[0]).toContain("managed hook record stays current");
  expect(readFileSync(lock, "utf8")).toBe(contents);
  expect(JSON.parse(readFileSync(join(rig.stateDir, "claude-launch.json"), "utf8"))).toEqual(current);
  expect((await hook.request({ ...input, phase: "session", sessionId: "session-B", nativeLaunchId: current.launchId })).ok).toBe(true);
  expect(await hook.request({ ...input, phase: "pre", sessionId: "session-B", nativeLaunchId: current.launchId })).toMatchObject({ ok: true, permission: "ask-when-needed" });
  expect((await hook.request({ ...input, phase: "pre", sessionId: "session-A", nativeLaunchId: old.launchId })).ok).toBe(false);
  expect(JSON.parse(readFileSync(join(rig.stateDir, "claude-session.json"), "utf8"))).toMatchObject({ sessionId: "session-B", launchId: current.launchId });
  const recovery = await rig.client.request({ t: "recovery", op: "inspect", expectedInstanceId: status.instanceId });
  expect(recovery.ok).toBe(true); expect(recovery.recovery.peers.claude.sessionId).toBe("session-B");
  expect((await rig.client.request({ t: "status" })).status.peers.claude.permissionMode).toBe("ask-when-needed");
}, 30_000);

test("slow native default confirmation refuses competing decline, duplicate approval and runtime changes", async () => {
  const rig = await fixture({ permission_modes: { kimi: "never-ask" }, permission_default_sources: { kimi: { mode: "never-ask", source: ".agenthub/config.local.json" } },
    kimi_cmd: [process.execPath, join(import.meta.dir, "fakes/acp-server.ts"), "--mode-delay-ms", "350"] });
  expect((await rig.client.request({ t: "start", peer: "kimi" })).ok).toBe(true);
  const confirming = rig.client.request({ t: "permission_default", peer: "kimi", confirmed: true });
  await Bun.sleep(30);
  for (const confirmed of [false, true]) expect((await rig.client.request({ t: "permission_default", peer: "kimi", confirmed })).error).toContain("still pending");
  expect((await rig.mode("kimi", "ask")).error).toContain("still pending");
  expect((await confirming).permissionMode).toBe("never-ask");
  expect((await rig.mode("kimi")).permissionMode).toBe("never-ask");
  expect((await rig.client.request({ t: "status" })).status.permissionDefaults).toBeUndefined();
  expect(readFileSync(join(rig.stateDir, "hub.log"), "utf8")).not.toContain("declined; effective ask");
  expect((await rig.mode("kimi", "ask")).permissionMode).toBe("ask");
});

for (const peer of ["kimi", "codex", "codex-unattended"]) test(`startup console y reconciles ${peer}'s captured mode or refuses its actual unattended launch`, async () => {
  const actualUnattended = peer === "codex-unattended";
  const id = actualUnattended ? "codex" : peer;
  let contexts = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const memory = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/api/context/inject") { contexts++; await gate; return new Response("# [fixture] recent context\n### today\nreference"); }
    return Response.json({ status: "ok" });
  } }); cleanup.push(() => { release(); memory.stop(true); });
  const cwd = mkdtempSync(join(tmpdir(), "ahub-startup-mode-"));
  const record = join(cwd, "requests.jsonl"), bin = join(cwd, "fake-codex");
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const port = reservation.port!; reservation.stop(true);
  writeFileSync(bin, `#!${process.execPath}\nimport { appendFileSync } from "node:fs"; import { startFakeAppServer } from ${JSON.stringify(join(import.meta.dir, "fakes/app-server.ts"))}; const url=process.argv[process.argv.indexOf("--listen")+1]; startFakeAppServer(30,Number(new URL(url).port),undefined,0,true,msg=>appendFileSync(${JSON.stringify(record)},JSON.stringify(msg)+"\\n"));\n`, { mode: 0o700 });
  const rig = await fixture({ codex_bin: bin, permission_modes: { [id]: "never-ask" }, memory: { ...DEFAULT_CONFIG.memory, enabled: true, worker_url: `http://127.0.0.1:${memory.port}` } },
    { cwd, stateDir: join(cwd, "state") }, { codexAppPort: port, unattended: id === "codex" });
  const started = rig.client.request({ t: "start", peer: id, args: { unattended: actualUnattended } });
  await until(() => contexts > 0);
  const joined = id === "codex" ? rig.client.request({ t: "start", peer: id, args: { unattended: actualUnattended } }) : undefined;
  if (id === "codex") expect((await rig.client.request({ t: "start", peer: id, args: { unattended: !actualUnattended } })).error).toContain("different --unattended");
  const confirmed = await rig.client.request({ t: "permission_default", peer: id, confirmed: true });
  if (actualUnattended) expect(confirmed.error).toContain("--unattended");
  else expect(confirmed.permissionMode).toBe("never-ask");
  release(); const ready = await started; expect(ready).toMatchObject({ ok: true });
  if (joined) expect((await joined).ok).toBe(true);
  const owner = rig.daemon.bus.peers.get(id) as CodexPeer | import("../src/adapters/acp.ts").AcpPeer;
  expect(owner.getPermissionMode()).toBe(actualUnattended ? "ask" : "never-ask");
  if (actualUnattended) {
    expect((await rig.client.request({ t: "status" })).status.peers[id].permissionMode).toBeUndefined();
    expect(readFileSync(join(rig.stateDir, "hub.log"), "utf8")).not.toContain("confirmed by the console");
    return;
  }
  expect((await rig.client.request({ t: "status" })).status.peers[id].permissionMode).toBe("never-ask");
  if (peer === "codex") {
    const tui = new WebSocket(ready.proxyUrl); cleanup.push(() => tui.close());
    tui.onopen = () => tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "fake-tui", version: "1" } } }));
    tui.onmessage = event => { if (JSON.parse(String(event.data)).id === 1) { tui.send(JSON.stringify({ method: "initialized" })); tui.send(JSON.stringify({ id: 2, method: "thread/start", params: { cwd: rig.cwd } })); } };
    await until(() => owner.state === "idle");
    rig.daemon.bus.publish(newEnvelope("user", "one turn", { to: [id], priority: "important" }));
    const requests = () => { try { return readFileSync(record, "utf8").trim().split("\n").map(row => JSON.parse(row)); } catch { return []; } };
    await until(() => requests().some(r => r.method === "turn/start"));
    expect(requests().find(r => r.method === "turn/start").params.approvalPolicy).toBe("never");
  }
});

for (const selected of ["ask", "ask-when-needed", "never-ask"]) test(`runtime ${selected} supersedes a pending config default and rejects stale y/n`, async () => {
  const rig = await fixture({ permission_modes: { kimi: "never-ask" } });
  await rig.client.request({ t: "start", peer: "kimi" });
  expect((await rig.mode("kimi", selected, true)).permissionMode).toBe(selected);
  expect((await rig.client.request({ t: "status" })).status.permissionDefaults).toBeUndefined();
  for (const confirmed of [true, false]) expect((await rig.client.request({ t: "permission_default", peer: "kimi", confirmed })).ok).toBe(false);
  expect((await rig.mode("kimi")).permissionMode).toBe(selected);
  const log = readFileSync(join(rig.stateDir, "hub.log"), "utf8");
  expect(log).not.toContain("confirmed by the console"); expect(log).not.toContain("declined; effective ask");
  if (selected !== "ask") {
    await rig.daemon.bus.peers.get("kimi")!.stop();
    await rig.client.request({ t: "start", peer: "kimi" });
    expect(readFileSync(join(rig.stateDir, "hub.log"), "utf8")).toContain(`permission start kimi: ${selected} from human runtime command`);
  }
});

test("a new Kimi replays its started state, drains offline work and persists the session", async () => {
  const rig = await fixture();
  await rig.client.request({ t: "start", peer: "kimi" });
  await rig.daemon.bus.peers.get("kimi")!.stop(); // a known offline recipient retains its queue
  const answers: string[] = [];
  rig.daemon.bus.tap(event => { if (event.t === "envelope" && event.env.from === "kimi") answers.push(event.env.body); });
  rig.daemon.bus.publish(newEnvelope("user", "queued before start", { to: ["kimi"], priority: "important" }));
  expect(rig.daemon.bus.queued("kimi")).toBe(1);
  expect((await rig.client.request({ t: "start", peer: "kimi" })).ok).toBe(true);
  await until(() => answers.some(answer => answer.includes("queued before start")));
  expect(rig.daemon.bus.queued("kimi")).toBe(0);
  expect(readEvents(join(rig.stateDir, "events.jsonl"))).toContainEqual(expect.objectContaining({ type: "state", peer: "kimi", state: "idle" }));
  expect(JSON.parse(readFileSync(join(rig.stateDir, "sessions.json"), "utf8")).peers).toContainEqual(expect.objectContaining({ peer: "kimi", meta: expect.objectContaining({ sessionId: "s1" }) }));
});

test("offline and absent ask clears the hub choice and pending defaults without native attachment", async () => {
  const rig = await fixture({ permission_modes: { kimi: "ask-when-needed", codex: "never-ask" } });
  expect((await rig.mode("kimi", "ask")).permissionMode).toBe("ask");
  expect((await rig.mode("codex", "ask")).permissionMode).toBe("ask");
  expect((await rig.client.request({ t: "status" })).status.permissionDefaults).toBeUndefined();
  await rig.client.request({ t: "start", peer: "kimi" });
  expect((await rig.mode("kimi")).permissionMode).toBe("ask");
  await rig.mode("kimi", "never-ask", true); await rig.daemon.bus.peers.get("kimi")!.stop();
  expect((await rig.mode("kimi", "ask")).permissionMode).toBe("ask");
  await rig.client.request({ t: "start", peer: "kimi" });
  expect((await rig.mode("kimi")).permissionMode).toBe("ask");
});

test("ask for a Codex whose proxy outlived its TUI clears the proxy's own mode: the next TUI runs its own policy", async () => {
  const rig = await fixture();
  const app = startFakeAppServer(); cleanup.push(app.stop);
  const codex = new CodexPeer("codex", { proxyPort: 0, appPort: 0, upstreamUrl: app.url, cwd: rig.cwd });
  rig.daemon.bus.add(codex);
  await codex.start();
  const attach = (threadId?: string) => {
    const tui = new WebSocket(codex.proxyUrl); cleanup.push(() => tui.close());
    tui.onopen = () => tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "fake-tui", version: "1" } } }));
    tui.onmessage = event => { const msg = JSON.parse(String(event.data)); if (msg.id === 1) { tui.send(JSON.stringify({ method: "initialized" })); tui.send(JSON.stringify({ id: 2, method: threadId ? "thread/resume" : "thread/start", params: { cwd: rig.cwd, approvalPolicy: "untrusted", ...(threadId ? { threadId } : {}) } })); } };
    return tui;
  };
  const first = attach();
  await until(() => codex.state === "idle");
  expect((await rig.mode("codex", "never-ask", true)).permissionMode).toBe("never-ask");
  await codex.deliver([newEnvelope("user", "overridden turn", { to: ["codex"] })]);
  await until(() => codex.state === "idle");
  expect(app.requests.filter(r => r.method === "turn/start").at(-1).params.approvalPolicy).toBe("never");
  first.close();
  await until(() => codex.state === "offline");
  // The TUI is gone, the proxy is not: `ask` must reach the proxy's own copy, not only the hub's table.
  expect((await rig.mode("codex", "ask")).permissionMode).toBe("ask");
  expect(codex.getPermissionMode()).toBe("ask");
  attach("different-thread");
  await until(() => codex.state === "idle");
  expect((await rig.client.request({ t: "status" })).status.peers.codex.permissionMode ?? "ask").toBe("ask");
  await codex.deliver([newEnvelope("user", "after offline ask", { to: ["codex"] })]);
  await until(() => codex.state === "idle");
  // The new TUI's thread runs its own policy: the hub sends no override (before the fix this turn carried "never").
  expect(app.requests.filter(r => r.method === "turn/start").at(-1).params.approvalPolicy).toBeUndefined();
});

test("ask for a detached Codex is never refused, even when the native policy was never reported", async () => {
  const rig = await fixture();
  const app = startFakeAppServer(30, 0, undefined, 93, false); cleanup.push(app.stop); // thread responses carry no approvalPolicy
  const codex = new CodexPeer("codex", { proxyPort: 0, appPort: 0, upstreamUrl: app.url, cwd: rig.cwd });
  rig.daemon.bus.add(codex);
  await codex.start();
  const tui = new WebSocket(codex.proxyUrl); cleanup.push(() => tui.close());
  tui.onopen = () => tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "fake-tui", version: "1" } } }));
  tui.onmessage = event => { const msg = JSON.parse(String(event.data)); if (msg.id === 1) { tui.send(JSON.stringify({ method: "initialized" })); tui.send(JSON.stringify({ id: 2, method: "thread/start", params: { cwd: rig.cwd } })); } };
  await until(() => codex.state === "idle");
  expect((await rig.mode("codex", "never-ask", true)).permissionMode).toBe("never-ask");
  await codex.deliver([newEnvelope("user", "overridden turn", { to: ["codex"] })]);
  await until(() => codex.state === "idle");
  // Attached, the hub cannot restore a policy it never saw, and says so.
  expect((await rig.mode("codex", "ask")).error).toContain("native approval policy unavailable");
  tui.close();
  await until(() => codex.state === "offline");
  // Away, a leftover mode can always be dropped: the hub stops overriding and the status says ask.
  const cleared = await rig.mode("codex", "ask");
  expect(cleared).toMatchObject({ ok: true, permissionMode: "ask" });
  expect(cleared.note).toContain("approval policy was never reported");
  expect(codex.getPermissionMode()).toBe("ask");
  expect((await rig.client.request({ t: "status" })).status.peers.codex.permissionMode ?? "ask").toBe("ask");
  expect(readFileSync(join(rig.stateDir, "hub.log"), "utf8")).toContain("approval policy was never reported");
});

test("a scoped grant folds look-alike names, judges the path inside the project and refuses a hard link", () => {
  // A case-insensitive disk opens these as the real names.
  for (const name of [".mcp.j\u017Fon", ".MCP.JSON", ".\u212Aimi", ".Claude", ".codex"]) expect(isAgentConfigPath(`sub/${name}`)).toBe(true);
  // HFS+ ignores these code points inside a name.
  for (const name of [".mcp.js\u200Don", ".co\u200Cdex/config.toml", ".\uFEFFkimi/settings.json", ".cl\u202Eaude/x"]) expect(isAgentConfigPath(name)).toBe(true);
  expect(isAgentConfigPath("src/mcp.json")).toBe(false);
  const base = mkdtempSync(join(tmpdir(), "ahub-grant-"));
  // A project that itself lives under an agent's directory is still a project: only the path inside it counts.
  const root = join(base, ".claude", "worktrees", "feature"); mkdirSync(join(root, ".codex"), { recursive: true });
  writeFileSync(join(root, "ordinary.txt"), "x"); writeFileSync(join(root, ".codex", "config.toml"), "x");
  expect(grantablePath(root, join(root, "ordinary.txt"))).toBe(true);
  expect(grantablePath(root, join(root, "new-file.txt"))).toBe(true);
  expect(grantablePath(root, join(root, ".codex", "config.toml"))).toBe(false);
  expect(grantablePath(root, join(root, ".mcp.j\u017Fon"))).toBe(false);
  expect(grantablePath(root, join(base, "outside.txt"))).toBe(false);
  expect(grantablePath(root, root)).toBe(false);
  for (const hub of [".git/config", ".GIT/config", "sub/.Git/HEAD", ".AGENTHUB/config.local.json"]) expect(grantablePath(root, join(root, hub))).toBe(false);
  // Another name for a config file is the config file.
  linkSync(join(root, ".codex", "config.toml"), join(root, "notes.txt"));
  expect(grantablePath(root, join(root, "notes.txt"))).toBe(false);
});

for (const peer of ["pi", "local"]) test(`${peer} scoped edit grants exclude every canonical native config segment`, async () => {
  const prior = process.env.OMNIROUTE_API_KEY; process.env.OMNIROUTE_API_KEY = "guard-fixture";
  cleanup.push(() => { if (prior === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = prior; });
  let tool = "write", args: Record<string, string> = { path: "ordinary.txt", content: "after" };
  const model = startFakeModelServer({ script: body => body.messages.at(-1)?.role === "tool" ? { content: String(body.messages.at(-1)?.content) } : { tool_calls: [toolCall(tool, args)] } }); cleanup.push(model.stop);
  const rig = await fixture({ pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts")] }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [model.url], access_hosts: [] } });
  expect((await rig.client.request({ t: "start", peer, args: peer === "pi" ? { backend: "dgx" } : { model: "vllm/test" } })).ok).toBe(true);
  await rig.mode(peer, "ask-when-needed");
  const pending: any[] = [], answers: string[] = [];
  rig.client.onPush = msg => { if (msg.t === "permission") pending.push(msg); }; rig.client.send({ t: "tail" });
  rig.daemon.bus.tap(event => { if (event.t === "envelope" && event.env.from === peer) answers.push(event.env.body); });
  const pi = rig.daemon.bus.peers.get("pi") as PiPeer | undefined;
  const call = async (name: string, input: Record<string, string>) => {
    if (peer === "pi") { const launch = pi!.tuiLaunch!; return fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/tool`, { method: "POST", headers: { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ name, args: input, toolCallId: crypto.randomUUID(), sessionId: pi!.recoveryMetadata().sessionId, generation: 0 }) }).then(r => r.json() as Promise<any>); }
    tool = name; args = input; const before = answers.length;
    rig.daemon.bus.publish(newEnvelope("user", `operation ${before}`, { to: [peer], priority: "important" }));
    await until(() => answers.length > before); return { text: answers.at(-1) };
  };
  await call("write", { path: "ordinary.txt", content: "after" }); expect(pending).toHaveLength(0);
  const targets = [...AGENT_CONFIG_SEGMENTS].flatMap(segment => [segment, segment.toUpperCase()]).map(segment => segment.toLowerCase() === ".mcp.json" ? `nested/${segment}` : `nested/${segment}/policy.json`);
  mkdirSync(join(rig.cwd, "nested/.claude"), { recursive: true }); symlinkSync(join(rig.cwd, "nested/.claude"), join(rig.cwd, "policy-alias")); targets.push("policy-alias/policy.json");
  for (const target of targets) for (const name of ["write", "edit"]) {
    const file = join(rig.cwd, target); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "before");
    const before = pending.length;
    const result = call(name, name === "write" ? { path: target, content: "after" } : { path: target, old: "before", new: "after" });
    await until(() => pending.length > before);
    await rig.client.request({ t: "permit", id: pending.at(-1).id });
    expect((await result).text).toContain("did not approve"); expect(readFileSync(file, "utf8")).toBe("before");
  }
});

test("failed unattended startup cannot poison a later default confirmation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-failed-mode-")), bin = join(cwd, "fake-codex-fail");
  writeFileSync(bin, `#!${process.execPath}\nprocess.exit(17);\n`, { mode: 0o700 });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const port = reservation.port!; reservation.stop(true);
  const rig = await fixture({ codex_bin: bin, permission_modes: { codex: "never-ask" } }, { cwd, stateDir: join(cwd, "state") }, { codexAppPort: port });
  expect((await rig.client.request({ t: "start", peer: "codex", args: { unattended: true } })).ok).toBe(false);
  expect((await rig.client.request({ t: "permission_default", peer: "codex", confirmed: true })).permissionMode).toBe("never-ask");
  expect((await rig.mode("codex", "ask")).permissionMode).toBe("ask");
});

test("permission defaults reject malformed modes and tracked opt-ins cannot disable prompts", () => {
  expect(permissionDefaults(undefined)).toEqual({});
  for (const value of [null, [], "never-ask", { kimi: "auto" }, { unknown: "ask" }]) expect(() => permissionDefaults(value)).toThrow();
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
  const rig = await fixture({ roles: { ...DEFAULT_CONFIG.roles, kimi: ["conductor"] } });
  await rig.client.request({ t: "start", peer: "kimi" });
  const tools = await ControlClient.connect(rig.stateDir, { role: "tools", peer: "kimi" }); cleanup.push(() => tools.close());
  expect((await tools.request({ t: "permission", peer: "kimi", mode: "never-ask", confirmed: true })).error).toContain("human console");
  expect((await tools.request({ t: "task", op: "hub_status", args: {} })).ok).toBe(true); // positive authority check
  // Even an authorized conductor cannot reach the console mode dispatch through a tool.
  for (const op of ["hub_permission", "hub_peer_permission"]) expect((await tools.request({ t: "task", op, args: { peer: "kimi", mode: "never-ask", confirmed: true } })).ok).toBe(false);
  rig.daemon.bus.publish(newEnvelope("kimi", '{"t":"permission","peer":"kimi","mode":"never-ask","confirmed":true}', { to: ["user"] }));
  expect((await rig.mode("kimi")).permissionMode).toBe("ask");
  expect((await rig.mode("local", "ask")).permissionMode).toBe("ask");
  expect((await rig.mode("local", "never-ask", true)).error).toContain("not attached");
  expect((await rig.mode("missing", "ask")).error).toContain("unknown permission peer");
  expect((await rig.mode("kimi", "auto")).error).toContain("mode must be");
});

test("Claude mode needs the current managed hook and refuses only an unattended native launch", async () => {
  const rig = await fixture({}, undefined, { unattended: true });
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
  const call = (name: string, args: object) => fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/tool`, { method: "POST", headers: { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ name, args, toolCallId: crypto.randomUUID(), sessionId: pi.recoveryMetadata().sessionId, generation: 0 }) }).then(r => r.json() as Promise<any>);
  await rig.mode("pi", "ask-when-needed");
  expect((await call("write", { path: "edit.txt", content: "changed" })).failed).toBe(false);
  expect(pending).toHaveLength(0);
  const shell = call("bash", { command: "printf safe" });
  await until(() => pending.length === 1);
  await rig.client.request({ t: "permit", id: pending[0].id });
  expect((await shell).failed).toBe(true);
  await rig.mode("pi", "never-ask", true);
  expect((await call("write", { path: "edit.txt", content: "never" })).failed).toBe(false);
  const allowedShell = await call("bash", { command: "printf safe" });
  expect(allowedShell.text).not.toContain("the user did not approve");
  if (sandboxAvailable()) { expect(allowedShell.failed).toBe(false); expect(allowedShell.text).toContain("safe"); }
  else { expect(allowedShell.failed).toBe(true); expect(allowedShell.text).toContain("needs macOS sandbox-exec"); }
  expect(pending).toHaveLength(1);
  await rig.mode("pi", "ask");
  const edit = call("write", { path: "edit.txt", content: "must ask" });
  await until(() => pending.length === 2);
  await rig.client.request({ t: "permit", id: pending[1].id });
  expect((await edit).failed).toBe(true);
});


test("Codex console mode uses its TUI policy even under an unattended broker", async () => {
  const rig = await fixture({}, undefined, { unattended: true });
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


test("actual unattended Codex launch metadata fences daemon runtime changes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-unattended-launch-"));
  const bin = join(cwd, "fake-codex");
  writeFileSync(bin, `#!${process.execPath}\nimport { startFakeAppServer } from ${JSON.stringify(join(import.meta.dir, "fakes/app-server.ts"))}; const url=process.argv[process.argv.indexOf("--listen")+1]; startFakeAppServer(30,Number(new URL(url).port));\n`, { mode: 0o700 });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const port = reservation.port!; reservation.stop(true);
  const rig = await fixture({ codex_bin: bin }, { cwd, stateDir: join(cwd, "state") }, { codexAppPort: port });
  const launch = buildLaunch("codex", ["--unattended"], { unattended: false, proxyUrl: "pending" });
  const started = await rig.client.request({ t: "start", peer: "codex", args: { unattended: launch.unattended === true } });
  expect(started.ok).toBe(true);
  const codex = rig.daemon.bus.peers.get("codex") as CodexPeer;
  const tui = new WebSocket(started.proxyUrl); cleanup.push(() => tui.close());
  tui.onopen = () => tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "fake-tui", version: "1" } } }));
  tui.onmessage = event => { if (JSON.parse(String(event.data)).id === 1) { tui.send(JSON.stringify({ method: "initialized" })); tui.send(JSON.stringify({ id: 2, method: "thread/start", params: { cwd } })); } };
  await until(() => codex.state === "idle");
  expect((await rig.mode("codex", "never-ask", true)).error).toContain("--unattended");
  expect((await rig.mode("codex", "ask")).error).toContain("--unattended");
});

test("permission-only Pre never marks Claude busy, even without a Stop", async () => {
  const rig = await fixture();
  const channel = await ControlClient.connect(rig.stateDir, { role: "peer", peer: "claude" }); cleanup.push(() => channel.close());
  await until(() => rig.daemon.bus.stateOf("claude") === "idle");
  expect((await rig.client.request({ t: "status" })).status.peers.claude.permissionMode).toBe("unverified");
  const instanceId = (await rig.client.request({ t: "status" })).status.instanceId;
  const launchId = "permission-only-launch", sessionId = "permission-only-session";
  const facts = claudeObservationHooks(DEFAULT_CONFIG, { script: join(import.meta.dir, "../src/cli/facts-hook.ts"), stateDir: rig.stateDir });
  const launch = buildLaunch("claude", [], { unattended: false, facts });
  writeFileSync(join(rig.stateDir, "claude-launch.json"), JSON.stringify({ instanceId, launchId, permissionHook: launch.permissionHook, hookPurpose: launch.hookPurpose, unattended: launch.unattended }));
  const settings = JSON.parse(readFileSync(launch.args[launch.args.indexOf("--settings") + 1]!, "utf8"));
  expect(settings.hooks.Stop).toBeUndefined();
  const child = Bun.spawn(["/bin/sh", "-c", settings.hooks.PreToolUse[0].hooks[0].command], { cwd: rig.cwd,
    env: { ...process.env, AGENTHUB_PEER_ID: "claude", AGENTHUB_INSTANCE_ID: instanceId, AGENTHUB_LAUNCH_ID: launchId },
    stdin: Buffer.from(JSON.stringify({ hook_event_name: "PreToolUse", session_id: sessionId, tool_name: "Read", tool_input: {} })), stdout: "pipe", stderr: "pipe" });
  await new Response(child.stdout).text(); await new Response(child.stderr).text(); expect(await child.exited).toBe(0);
  expect(rig.daemon.bus.stateOf("claude")).toBe("idle");
  expect((await rig.client.request({ t: "status" })).status.peers.claude.permissionMode).toBeUndefined();
  const delivered: any[] = []; channel.onPush = msg => { if (msg.t === "deliver") delivered.push(msg); };
  rig.daemon.bus.publish(newEnvelope("user", "after interrupted or denied permission-only tool", { to: ["claude"], priority: "important" }));
  await until(() => delivered.length === 1);
});


for (const tracked of [false, true]) test(`never-ask config default ${tracked ? "tracked main is ignored" : "local overlay needs startup confirmation"}`, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-default-confirm-")); mkdirSync(join(cwd, ".agenthub"));
  expect(Bun.spawnSync(["git", "-C", cwd, "init", "-q"]).exitCode).toBe(0);
  const name = tracked ? "config.json" : "config.local.json";
  writeFileSync(join(cwd, ".agenthub", name), JSON.stringify({ permission_modes: { kimi: "never-ask" } }));
  if (tracked) expect(Bun.spawnSync(["git", "-C", cwd, "add", "-f", `.agenthub/${name}`]).exitCode).toBe(0);
  const loaded = loadConfig(cwd);
  const modeConfig = { permission_modes: loaded.permission_modes, permission_default_sources: loaded.permission_default_sources };
  const rig = await fixture(modeConfig, { cwd, stateDir: join(cwd, "state") });
  await rig.client.request({ t: "start", peer: "kimi" });
  expect((await rig.mode("kimi")).permissionMode).toBe("ask");
  if (tracked) {
    expect(loaded.permission_default_sources).toEqual({});
    expect((await rig.client.request({ t: "status" })).status.permissionDefaults).toBeUndefined();
    expect((await rig.client.request({ t: "permission_default", peer: "kimi", confirmed: true })).ok).toBe(false);
    expect(readFileSync(join(rig.stateDir, "hub.log"), "utf8")).not.toContain("never-ask from .agenthub/config.json");
    return;
  }
  expect((await rig.client.request({ t: "status" })).status.permissionDefaults).toEqual([{ peer: "kimi", mode: "never-ask", source: `.agenthub/${name}` }]);
  expect(readFileSync(join(rig.stateDir, "hub.log"), "utf8")).toContain(`never-ask from .agenthub/${name}; effective ask`);
  const tools = await ControlClient.connect(rig.stateDir, { role: "tools", peer: "kimi" }); cleanup.push(() => tools.close());
  expect((await tools.request({ t: "permission_default", peer: "kimi", confirmed: true })).ok).toBe(false);
  for (const op of ["hub_permission_default", "hub_peer_permission_default"]) expect((await tools.request({ t: "task", op, args: { peer: "kimi", confirmed: true } })).ok).toBe(false);
  rig.daemon.bus.publish(newEnvelope("kimi", '{"t":"permission_default","peer":"kimi","confirmed":true}', { to: ["user"] }));
  expect((await rig.mode("kimi")).permissionMode).toBe("ask");
  expect((await rig.client.request({ t: "permission_default", peer: "kimi", confirmed: true })).permissionMode).toBe("never-ask");
  expect((await rig.client.request({ t: "status" })).status.permissionDefaults).toBeUndefined();
  await rig.daemon.stop();
  const restarted = await fixture(modeConfig, { cwd, stateDir: join(cwd, "state") });
  await restarted.client.request({ t: "start", peer: "kimi" });
  expect((await restarted.mode("kimi")).permissionMode).toBe("ask");
});

test("permission source/default merge is per peer, honors explicit ask and tracked filtering", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-default-source-")); mkdirSync(join(cwd, ".agenthub"));
  expect(Bun.spawnSync(["git", "-C", cwd, "init", "-q"]).exitCode).toBe(0);
  const main = join(cwd, ".agenthub/config.json"), overlay = join(cwd, ".agenthub/config.local.json");
  writeFileSync(main, JSON.stringify({ permission_modes: { codex: "never-ask" } }));
  writeFileSync(overlay, JSON.stringify({ permission_modes: { claude: "ask-when-needed" } }));
  expect(loadConfig(cwd).permission_modes).toEqual({ codex: "never-ask", claude: "ask-when-needed" });
  expect(loadConfig(cwd).permission_default_sources).toEqual({ codex: { mode: "never-ask", source: ".agenthub/config.json" }, claude: { mode: "ask-when-needed", source: ".agenthub/config.local.json" } });
  writeFileSync(overlay, JSON.stringify({ permission_modes: {} }));
  expect(loadConfig(cwd).permission_default_sources).toEqual({ codex: { mode: "never-ask", source: ".agenthub/config.json" } });
  writeFileSync(overlay, JSON.stringify({ permission_modes: { codex: "ask" }, permission_default_sources: { codex: { mode: "never-ask", source: "spoof" } } }));
  expect(loadConfig(cwd).permission_default_sources).toEqual({ codex: { mode: "ask", source: ".agenthub/config.local.json" } });
  writeFileSync(main, JSON.stringify({ permission_modes: { kimi: "ask-when-needed" } }));
  writeFileSync(overlay, JSON.stringify({ permission_modes: { kimi: "ask" } }));
  expect(Bun.spawnSync(["git", "-C", cwd, "add", "-f", ".agenthub/config.local.json"]).exitCode).toBe(0);
  expect(loadConfig(cwd).permission_modes).toEqual({ kimi: "ask-when-needed" });
  expect(loadConfig(cwd).permission_default_sources).toEqual({ kimi: { mode: "ask-when-needed", source: ".agenthub/config.json" } });
});

test("local mode grants write/edit only in ask-when-needed and keeps its sandbox in never-ask", async () => {
  const priorKey = process.env.OMNIROUTE_API_KEY;
  process.env.OMNIROUTE_API_KEY = "permission-fixture-key";
  cleanup.push(() => { if (priorKey === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = priorKey; });
  const model = startFakeModelServer({ script: body => body.messages.at(-1)?.role === "tool" ? { content: `done: ${body.messages.at(-1)?.content}` } : { tool_calls: [String(body.messages.at(-1)?.content).includes("SHELL") ? toolCall("bash", { command: "printf safe" }) : toolCall("write", { path: "edit.txt", content: "changed" })] } }); cleanup.push(model.stop);
  const rig = await fixture({ omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [model.url], access_hosts: [] } });
  expect((await rig.client.request({ t: "start", peer: "local", args: { model: "vllm/test" } })).ok).toBe(true);
  const pending: any[] = [], answers: string[] = [];
  rig.client.onPush = msg => { if (msg.t === "permission") pending.push(msg); }; rig.client.send({ t: "tail" });
  rig.daemon.bus.tap(event => { if (event.t === "envelope" && event.env.from === "local") answers.push(event.env.body); });
  await rig.mode("local", "ask-when-needed");
  rig.daemon.bus.publish(newEnvelope("user", "WRITE", { to: ["local"], priority: "important" })); await until(() => answers.length === 1);
  expect(readFileSync(join(rig.cwd, "edit.txt"), "utf8")).toBe("changed"); expect(pending).toHaveLength(0);
  rig.daemon.bus.publish(newEnvelope("user", "SHELL", { to: ["local"], priority: "important" })); await until(() => pending.length === 1);
  await rig.client.request({ t: "permit", id: pending[0].id }); await until(() => answers.length === 2);
  expect(answers[1]).toContain("did not approve");
  await rig.mode("local", "never-ask", true);
  rig.daemon.bus.publish(newEnvelope("user", "SHELL", { to: ["local"], priority: "important" })); await until(() => answers.length === 3);
  expect(answers[2]).not.toContain("did not approve"); expect(pending).toHaveLength(1);
  if (sandboxAvailable()) expect(answers[2]).toContain("safe"); else expect(answers[2]).toContain("needs macOS sandbox-exec");
  await rig.mode("local", "ask");
  rig.daemon.bus.publish(newEnvelope("user", "WRITE", { to: ["local"], priority: "important" })); await until(() => pending.length === 2);
  await rig.client.request({ t: "permit", id: pending[1].id }); await until(() => answers.length === 4);
  expect(answers[3]).toContain("did not approve");
});
