import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient, PROTOCOL } from "../src/hub/control-client.ts";
import { drainCliAudits } from "../src/cli/identity-audit.ts";
import { startFakeModelServer } from "./fakes/model-server.ts";
import { readEvents } from "../src/hub/events.ts";

const CLI = join(import.meta.dir, "../src/cli/main.ts");
const MARKERS = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_UNATTENDED", "AGENTHUB_RECOVERY_OPERATION"];
async function cli(root: string, args: string[], markers: Record<string, string> = {}) {
  // Bind fixture markers in the wrapper, independently of the test runner's scrubbed child environment.
  const wrapper = join(root, `cli-${crypto.randomUUID()}.ts`);
  writeFileSync(wrapper, `for (const name of ${JSON.stringify(MARKERS)}) delete process.env[name];
Object.assign(process.env, ${JSON.stringify(markers)}, { COLUMNS: "120", AGENTHUB_HOME: ${JSON.stringify(join(root, "home"))} });
process.argv = [process.execPath, ${JSON.stringify(CLI)}, ...${JSON.stringify(args)}];
await import(${JSON.stringify(CLI)});
`);
  const child = Bun.spawn([process.execPath, wrapper], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}
function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-identity-cli-")));
  mkdirSync(join(root, ".agenthub"));
  writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, snapshots: { enabled: false } }));
  return root;
}

test("#410 delegated operational audit negotiation preserves off-roster caller authority", async () => {
  const root = project(), stateDir = join(root, ".agenthub/state");
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, roster: { ...DEFAULT_CONFIG.roster, codex: false }, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } });
  try {
    const result = await cli(root, ["--live-test", "permission", "pi", "ask"], { AGENTHUB_PEER_ID: "codex" });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe("pi: ask\n");
  } finally { await daemon.stop(); rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test("explicit live-test delegation reaches console commands and retains the initiating peer in daemon evidence", async () => {
  const root = project(), stateDir = join(root, ".agenthub/state");
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false } } });
  try {
    const actor = { AGENTHUB_PEER_ID: "codex", CODEX_THREAD_ID: "fixture-thread" };
    const ordinary = await cli(root, ["permission", "pi", "ask"], actor);
    expect(ordinary.code).toBe(1);
    expect(ordinary.stderr).toContain("codex cannot run ahub permission");
    for (const prefix of [["--live-test", "--project", root], ["--project", root, "--live-test"]]) {
      const delegated = await cli(root, [...prefix, "permission", "pi", "ask"], actor);
      expect(delegated).toEqual({ code: 0, stdout: "pi: ask\n", stderr: "" });
    }
    // Console authority also opens the real authenticated dashboard listener, without opening a browser.
    const ui = await cli(root, ["--live-test", "ui", "--no-open"], actor);
    expect(ui.code, ui.stderr).toBe(0);
    expect(ui.stdout).toContain("http://127.0.0.1:");
    // The grant belongs to the invocation: the same actor's next unflagged command still refuses.
    expect((await cli(root, ["permission", "pi", "ask"], actor)).code).toBe(1);
    const events = () => readEvents(join(stateDir, "events.jsonl")).filter(row => row.type === "agent_cli").filter(row => row.delegated);
    const deadline = Date.now() + 5000;
    while (events().length < 3 && Date.now() < deadline) await Bun.sleep(25);
    expect(events()).toHaveLength(3);
    expect(events().every(row => row.peer === "codex" && row.refused === false && row.delegated === true)).toBe(true);
    expect(events().map(row => row.command).sort()).toEqual(["permission", "permission", "ui"]);
    expect(JSON.stringify(events())).not.toContain("fixture-thread");
  } finally { await daemon.stop(); rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test("live-test rejects invalid identity, duplicate options and unavailable audits before control effects", async () => {
  const root = project(), stateDir = join(root, ".agenthub/state");
  mkdirSync(stateDir);
  let connections = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(req, server) { connections++; if (server.upgrade(req)) return; return new Response("unexpected"); }, websocket: { message() {} } });
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ cwd: root, controlPort: server.port, protocol: PROTOCOL }));
  writeFileSync(join(stateDir, "control-token"), "fixture-token");
  try {
    const invalid = await cli(root, ["--live-test", "permission"], { AGENTHUB_PEER_ID: "codex", CLAUDECODE: "1" });
    expect(invalid.code).toBe(1); expect(invalid.stderr).toContain("conflicts");
    expect(drainCliAudits(stateDir)).toMatchObject([{ peer: "unknown", outcome: "invalid" }]);
    for (const args of [["--live-test", "--live-test", "ui"], ["--project", root, "--project", root, "ui"]]) {
      const duplicate = await cli(root, args, { AGENTHUB_PEER_ID: "codex" });
      expect(duplicate.code).toBe(1); expect(duplicate.stderr).toContain("may appear only once");
    }
    // A flag after the command is command/native data, never a global delegation request.
    expect((await cli(root, ["permission", "--live-test"], { AGENTHUB_PEER_ID: "codex" })).code).toBe(1);
    drainCliAudits(stateDir);
    rmSync(join(stateDir, "cli-audit"), { recursive: true });
    writeFileSync(join(stateDir, "cli-audit"), "not a directory");
    const unaudited = await cli(root, ["--live-test", "permission", "pi", "ask"], { AGENTHUB_PEER_ID: "codex" });
    expect(unaudited.code).toBe(1);
    expect(unaudited.stderr).toContain("live-test delegation audit unavailable; nothing was executed");
    expect(connections).toBe(0);
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test("delegated up passes authority to its real daemon child, then delegated kill stays project-scoped", async () => {
  const root = project();
  const actor = { AGENTHUB_PEER_ID: "codex", CODEX_THREAD_ID: "fixture-thread" };
  try {
    const up = await cli(root, ["--live-test", "up", "--no-console"], actor);
    expect(up.code, up.stderr).toBe(0);
    const status = await cli(root, ["status", "--json"], actor);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).cwd).toBe(root);
    const killed = await cli(root, ["--live-test", "kill"], actor);
    expect(killed.code, killed.stderr).toBe(0);
    expect((await cli(root, ["status", "--json"], actor)).code).toBe(1);
  } finally { await cli(root, ["kill"]); rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test("delegated console forwards authority to its actual CLI subprocess", async () => {
  const root = project(), stateDir = join(root, ".agenthub/state");
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false } } });
  const wrapper = join(root, "console-wrapper.ts");
  writeFileSync(wrapper, `for (const name of ${JSON.stringify(MARKERS)}) delete process.env[name];
Object.assign(process.env, { AGENTHUB_PEER_ID: "codex", CODEX_THREAD_ID: "fixture-thread", AGENTHUB_HOME: ${JSON.stringify(join(root, "home"))} });
const { runConsole } = await import(${JSON.stringify(join(import.meta.dir, "../src/cli/console.ts"))});
const { ControlClient } = await import(${JSON.stringify(join(import.meta.dir, "../src/hub/control-client.ts"))});
let input = (_text) => {}, stop = () => {}, output = "", observed = false;
const client = await ControlClient.connect(${JSON.stringify(stateDir)}, {role: "console"});
const terminal = { columns:120, rows:24, isTTY:true, raw() {},
  write(text) { output += text; if (!observed && output.includes("pi: ask")) { observed = true; queueMicrotask(() => input("q")); } },
  onData(listener) { input = listener; queueMicrotask(() => { for (const key of ":permission pi ask\\r") input(key); }); return () => {}; },
  onResize() { return () => {}; }, onSignal(listener) { stop = listener; return () => {}; }, onError() { return () => {}; } };
const deadline = setTimeout(() => stop(), 5000);
try { await runConsole({client, cwd:${JSON.stringify(root)}, stateDir:${JSON.stringify(stateDir)}, terminal, liveTest:true, color:false, noPet:true}); }
finally { clearTimeout(deadline); }
console.log(observed ? "delegated-console-ok" : output);
process.exitCode = observed ? 0 : 1;
`);
  const child = Bun.spawn([process.execPath, wrapper], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr + stdout).toBe(0);
    expect(stdout).toContain("delegated-console-ok");
  } finally { child.kill(); await daemon.stop(); rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test("stop CLI validates its peer, prints the result and guides an older hub upgrade (#278)", async () => {
  const root = project(), stateDir = join(root, ".agenthub/state");
  mkdirSync(stateDir);
  const requests: any[] = [], hellos: any[] = [];
  let oldHub = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response("unexpected"); },
    websocket: { message(ws, raw) {
      const msg = JSON.parse(String(raw));
      if (msg.t === "hello") { hellos.push(msg); ws.send(JSON.stringify({ t: "welcome", rid: msg.rid, ok: true, cwd: root, protocol: PROTOCOL })); return; }
      requests.push(msg);
      const reply = oldHub ? { ok: false, error: 'this hub does not know "peer_stop" (restart it: ahub kill && ahub up)' }
        : msg.peer === "missing" ? { ok: false, error: "unknown peer missing; inspect ahub status" }
        : msg.peer === "codex" ? { ok: false, error: "end codex in its terminal" }
        : { ok: true, state: "offline" };
      ws.send(JSON.stringify({ t: "reply", rid: msg.rid, ...reply }));
    } } });
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ cwd: root, controlPort: server.port, protocol: PROTOCOL }));
  writeFileSync(join(stateDir, "control-token"), "fixture-token");
  try {
    for (const args of [["stop"], ["stop", "pi", "extra"], ["stop", "--unknown"], ["stop", "bad peer"]]) {
      const result = await cli(root, args);
      expect(result.code).toBe(1); expect(result.stderr).toContain("usage: ahub stop <peer>");
      expect(hellos).toHaveLength(0); expect(requests).toHaveLength(0);
    }
    const stopped = await cli(root, ["stop", "pi"]);
    expect(stopped).toEqual({ code: 0, stdout: "pi: offline\n", stderr: "" });
    expect(hellos[0]).toMatchObject({ role: "console" });
    expect(requests[0]).toMatchObject({ t: "peer_stop", peer: "pi" });
    expect(requests).toHaveLength(1);
    for (const [peer, reason] of [["codex", "end codex in its terminal"], ["missing", "inspect ahub status"]]) {
      const refused = await cli(root, ["stop", peer!]);
      expect(refused.code).toBe(1); expect(refused.stderr).toContain(reason!);
      expect(refused.stderr).not.toContain("upgrade the running hub");
    }
    oldHub = true;
    const old = await cli(root, ["stop", "pi"]);
    expect(old.code).toBe(1); expect(old.stdout).toBe("");
    expect(old.stderr).toContain("upgrade the running hub to use ahub stop");
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test("the human stop CLI leaves a real daemon's local peer offline and the hub running (#278)", async () => {
  const root = project(), stateDir = join(root, ".agenthub/state");
  const model = startFakeModelServer();
  const keyFile = join(root, "gateway-key"); writeFileSync(keyFile, "fixture-key");
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, omniroute: { urls: [model.url], access_hosts: [], api_key_file: keyFile } } });
  let console_: ControlClient | undefined;
  try {
    console_ = await ControlClient.connect(stateDir, { role: "console" });
    expect((await console_.request({ t: "start", peer: "local", args: { model: "m" } })).ok).toBe(true);
    expect(daemon.bus.stateOf("local")).toBe("idle");
    const stopped = await cli(root, ["stop", "local"]);
    expect(stopped).toEqual({ code: 0, stdout: "local: offline\n", stderr: "" });
    expect(daemon.bus.stateOf("local")).toBe("offline");
    const status = await console_.request({ t: "status" });
    expect(status.t).toBe("status"); expect(status.status.pid).toBe(process.pid);
    expect(status.status.peers.local.state).toBe("offline");
    const repeated = await cli(root, ["stop", "local"]);
    expect(repeated.code).toBe(1); expect(repeated.stderr).toContain("offline");
  } finally { console_?.close(); await daemon.stop(); model.stop(); rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test("person commands and unverifiable operational commands refuse promptly without control connections and preserve refused audits", async () => {
  const root = project(), stateDir = join(root, ".agenthub/state");
  mkdirSync(stateDir);
  let connections = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (_req, server) => { connections++; if (server.upgrade(_req)) return; return new Response("unexpected"); }, websocket: { message() {} } });
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ cwd: root, controlPort: server.port, protocol: PROTOCOL }));
  writeFileSync(join(stateDir, "control-token"), "fixture-token");
  try {
    for (const args of [["stop", "sensitive-peer"], ["permission", "pi", "never-ask", "--yes", "--as-user"], ["permit", "sensitive-id", "allow"], ["queue", "resolve", "sensitive-id"], ["budget", "resume", "kimi"], ["budget", "set", "kimi", "0"], ["budget", "execution"], ["kill"], ["recovery", "reattach", "sensitive-id"], ["upgrade"], ["restart"], ["up", "--unattended"], ["ask", "sensitive-question"]]) {
      const result = await cli(root, args, { AGENTHUB_PEER_ID: "claude" });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("ahub console or a terminal");
      expect(connections).toBe(0);
    }
    const audits = drainCliAudits(stateDir);
    expect(audits).toHaveLength(13);
    expect(audits.find(row => row.command === "stop")).toBeDefined();
    expect(audits.every(row => row.peer === "claude" && row.outcome === "refused")).toBe(true);
    expect(JSON.stringify(audits)).not.toContain("sensitive");
    const malformed = await cli(root, ["say", "harmless"], { AGENTHUB_PEER_ID: "codex", CLAUDECODE: "1" });
    expect(malformed.code).toBe(1);
    expect(malformed.stderr).toContain("conflicts");
    expect(connections).toBe(0);
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test("native shell CLI messages and board history retain the actor while plain terminals keep human authority", async () => {
  const root = project(), stateDir = join(root, ".agenthub/state");
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false } } });
  const sent: Array<{ from: string; body: string; priority: string }> = [];
  daemon.bus.tap(event => { if (event.t === "envelope") sent.push(event.env); });
  let console_: ControlClient | undefined;
  let worker: ControlClient | undefined;
  try {
    expect((await cli(root, ["say", "agent-message"], { CLAUDECODE: "1" })).code).toBe(0);
    expect(sent.find(row => row.body === "agent-message")).toMatchObject({ from: "claude", priority: "status" });
    expect((await cli(root, ["say", "native-codex-message"], { CODEX_THREAD_ID: "fixture-thread" })).code).toBe(0);
    expect(sent.find(row => row.body === "native-codex-message")).toMatchObject({ from: "codex", priority: "status" });
    expect((await cli(root, ["--live-test", "say", "delegated-codex-message"], { CODEX_THREAD_ID: "fixture-thread" })).code).toBe(0);
    expect(sent.find(row => row.body === "delegated-codex-message")).toMatchObject({ from: "codex", priority: "status" });
    expect((await cli(root, ["say", "human-message"])).code).toBe(0);
    expect(sent.find(row => row.body === "human-message")).toMatchObject({ from: "user", priority: "important" });
    const proposed = await cli(root, ["task", "propose", "--class", "summarize", "actor-history"], { AGENTHUB_PEER_ID: "claude" });
    expect(proposed.code, proposed.stderr).toBe(0);
    const id = Number(/task #(\d+)/.exec(proposed.stdout)?.[1]);
    expect(id).toBeGreaterThan(0);
    console_ = await ControlClient.connect(stateDir, { role: "console" });
    const shown = await console_.request({ t: "task", op: "task_show", args: { id } });
    expect(JSON.parse(shown.text).history[0]).toMatchObject({ by: "claude", event: "proposed" });
    const flaggedProposed = await cli(root, ["--live-test", "task", "propose", "--class", "summarize", "flagged-actor-history"], { AGENTHUB_PEER_ID: "codex" });
    expect(flaggedProposed.code, flaggedProposed.stderr).toBe(0);
    const flaggedId = Number(/task #(\d+)/.exec(flaggedProposed.stdout)?.[1]);
    const flaggedShown = await console_.request({ t: "task", op: "task_show", args: { id: flaggedId } });
    expect(JSON.parse(flaggedShown.text).history[0]).toMatchObject({ by: "codex", event: "proposed" });
    // The native kimi id is reserved for ACP; a real non-native WS peer exercises holds without spawning it.
    worker = await ControlClient.connect(stateDir, { role: "peer", peer: "kimi-fixture" });
    expect((await console_.request({ t: "status" })).status.peers["kimi-fixture"].state).toBe("idle");
    const ordinary = await cli(root, ["pause", "kimi-fixture"], { AGENTHUB_PEER_ID: "claude" });
    expect(ordinary.code).toBe(1);
    expect(ordinary.stderr).toContain("conductor");
    const flagged = await cli(root, ["--live-test", "pause", "kimi-fixture"], { AGENTHUB_PEER_ID: "claude" });
    expect(flagged.code, flagged.stderr).toBe(0);
    expect((await console_.request({ t: "status" })).status.peers["kimi-fixture"].state).toBe("paused");
    expect((await cli(root, ["--live-test", "resume", "kimi-fixture"], { AGENTHUB_PEER_ID: "claude" })).code).toBe(0);
    expect((await console_.request({ t: "status" })).status.peers["kimi-fixture"].state).not.toBe("paused");
  } finally { worker?.close(); console_?.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test("live-test cannot impersonate the user or file person verdicts and workflow history", async () => {
  const root = project(), stateDir = join(root, ".agenthub/state");
  try {
    for (const args of [["say", "--as-user", "private-message"], ["say", "--as-user=true", "private-message"],
      ["task", "label", "1", "ok"], ["task", "role", "1", "none"], ["task", "assign", "1", "pi"], ["task", "escalate", "1"], ["backlog", "add", "test", "private-title"],
      ["release", "new", "private-release", "goal", "1"], ["sdlc", "record", "1", "{}"], ["board", "import", "github"],
      ["bench", "run", "private-suite"], ["pet", "--window"]]) {
      const result = await cli(root, ["--live-test", ...args], { AGENTHUB_PEER_ID: "codex" });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("live-test cannot write person-attributed content");
    }
    const rows = drainCliAudits(stateDir);
    expect(rows).toHaveLength(12);
    expect(rows.every(row => row.peer === "codex" && row.outcome === "refused")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("private");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test("agent CLI task proposals obey peer capabilities instead of borrowing the console's", async () => {
  const root = project(), stateDir = join(root, ".agenthub/state");
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG, capabilities: { claude: [] }, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false } } });
  let console_: ControlClient | undefined;
  try {
    const refused = await cli(root, ["task", "propose", "--class", "summarize", "restricted-proposal"], { AGENTHUB_PEER_ID: "claude" });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("propose");
    console_ = await ControlClient.connect(stateDir, { role: "console" });
    const list = await console_.request({ t: "task", op: "hub_task_list", args: {} });
    expect(JSON.parse(list.text)).toEqual([]);
  } finally { console_?.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test("permission CLI validates confirmation, lists and shows modes, and guides an older hub upgrade (#242)", async () => {
  const root = project(), stateDir = join(root, ".agenthub/state");
  mkdirSync(stateDir);
  const requests: any[] = [];
  let oldHub = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response("unexpected"); },
    websocket: { message(ws, raw) {
      const msg = JSON.parse(String(raw));
      if (msg.t === "hello") { ws.send(JSON.stringify({ t: "welcome", rid: msg.rid, ok: true, cwd: root, protocol: PROTOCOL })); return; }
      requests.push(msg);
      const reply = msg.t === "status" ? { ok: true, status: { pid: 1, controlPort: server.port, cwd: root, peers: { claude: { state: "idle", permissionMode: "unverified" }, kimi: { state: "idle", permissionMode: "unmanaged" }, local: { state: "idle", permissionMode: "unknown" } } } } : oldHub ? { ok: false, error: 'this hub does not know "permission" (restart it: ahub kill && ahub up)' } : msg.peer === "missing" ? { ok: false, error: "unknown permission peer" } : msg.peer === "unsupported" ? { ok: false, error: "peer unsupported cannot change permission mode: relaunch behind the proxy" } : msg.peer ? { ok: true, peer: msg.peer, ...(msg.peer === "codex" && msg.mode === "ask" ? { note: "Native approval policy was never reported; a new ahub codex session starts in ask" } : {}), permissionMode: msg.mode ?? (msg.peer === "claude" ? "unverified" : msg.peer === "kimi" ? "unmanaged" : msg.peer === "local" ? "unknown" : "ask") } : { ok: true, peers: { pi: "ask-when-needed", codex: "ask", claude: "unverified", kimi: "unmanaged", local: "unknown" } };
      ws.send(JSON.stringify({ t: "reply", rid: msg.rid, ...reply }));
    } } });
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ cwd: root, controlPort: server.port, protocol: PROTOCOL }));
  writeFileSync(join(stateDir, "control-token"), "fixture-token");
  try {
    for (const args of [["permission", "pi", "never-ask"], ["permission", "pi", "invalid-mode"], ["permission", "--unknown"]]) {
      const result = await cli(root, args);
      expect(result.code).toBe(1); expect(requests).toHaveLength(0);
    }
    const list = await cli(root, ["permission"]);
    expect(list.code, list.stderr).toBe(0); expect(list.stdout).toContain("pi: ask-when-needed");
    for (const [peer, display] of [["claude", "unverified"], ["kimi", "unmanaged"], ["local", "unknown"]] as const) {
      expect(list.stdout).toContain(`${peer}: ${display}`);
      const shown = await cli(root, ["permission", peer]);
      expect(shown.code, shown.stderr).toBe(0); expect(shown.stdout).toContain(`${peer}: ${display}`);
    }
    const status = await cli(root, ["status"]);
    expect(status.code, status.stderr).toBe(0);
    const lines = status.stdout.split("\n");
    const header = lines.find(line => line.startsWith("PEER"))!.trim().split(/\s+/);
    const modeColumn = header.indexOf("MODE");
    expect(modeColumn).toBeGreaterThanOrEqual(0);
    for (const [peer, display] of [["claude", "unverified"], ["kimi", "unmanaged"], ["local", "unknown"]] as const) {
      const row = lines.find(line => line.trim().split(/\s+/)[0] === peer);
      expect(row).toBeDefined();
      expect(row!.trim().split(/\s+/)[modeColumn]).toBe(display);
    }
    const show = await cli(root, ["permission", "pi"]);
    expect(show.code, show.stderr).toBe(0); expect(show.stdout).toContain("pi: ask");
    for (const mode of ["ask", "ask-when-needed", "never-ask"]) {
      const result = await cli(root, ["permission", "pi", mode, ...(mode === "never-ask" ? ["--yes"] : [])]);
      expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain(`pi: ${mode}`);
      expect(requests.at(-1)).toMatchObject({ t: "permission", peer: "pi", mode, confirmed: mode === "never-ask" });
    }
    for (const [peer, boundary] of [["local", "inside hub sandbox, path guard and denylist"], ["kimi", "NO hub sandbox"], ["codex", "native vendor bounds"]]) {
      const runtime = await cli(root, ["permission", peer!, "never-ask", "--yes"]);
      expect(runtime.code, runtime.stderr).toBe(0); expect(runtime.stderr).toContain(boundary!);
      expect(requests.at(-1)).toMatchObject({ t: "permission", peer, mode: "never-ask", confirmed: true });
      expect(requests.some(row => row.t === "permission_default")).toBe(false);
    }
    const cleared = await cli(root, ["permission", "codex", "ask"]);
    expect(cleared.code, cleared.stderr).toBe(0);
    expect(cleared.stdout).toContain("Native approval policy was never reported; a new ahub codex session starts in ask");
    const refused = await cli(root, ["permission", "unsupported", "ask"]);
    expect(refused.code).toBe(1); expect(refused.stderr).toContain("relaunch behind the proxy");
    const missing = await cli(root, ["permission", "missing"]);
    expect(missing.code).toBe(1); expect(missing.stderr).toContain("unknown permission peer"); expect(missing.stderr).not.toContain("upgrade");
    oldHub = true;
    const old = await cli(root, ["permission"]);
    expect(old.code).toBe(1); expect(old.stderr).toContain("upgrade the running hub");
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 20_000);
