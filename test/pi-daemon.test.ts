import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Board } from "../src/hub/board.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { PiPeer } from "../src/adapters/pi.ts";
import { processSignature as ownerSignature } from "../src/pi/process-signature.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function fakePi(dir: string): string {
  const file = join(dir, "fake-pi.ts");
  writeFileSync(file, `import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[process.argv.indexOf("--session-dir") + 1];
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "model-descriptors.json"), process.env.AGENTHUB_PI_MODELS ?? "[]");
const resumed = process.argv.indexOf("--session");
const sessionFile = resumed < 0 ? join(dir, "pi-session.jsonl") : process.argv[resumed + 1];
const sessionId = resumed < 0 ? "pi-session-1" : JSON.parse(readFileSync(sessionFile, "utf8").split("\\n")[0]).id;
if (resumed < 0) writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId, cwd: process.cwd() }) + "\\n");
const out = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => { const m = JSON.parse(line); if (m.type === "get_state") out({ id: m.id, success: true, data: { sessionId, sessionFile } }); else if (m.type === "prompt" || m.type === "set_model") out({ id: m.id, success: true }); });
`);
  return file;
}

async function hub(config = DEFAULT_CONFIG, unattended = false) {
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-pi-daemon-"));
  const daemon = await startDaemon({ cwd: stateDir, permissionTimeoutMs: 20, unattended, projectId: "pi-project", instanceId: `pi-instance-${Math.random()}`, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...config, memory: { ...config.memory, enabled: false } } });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" });
  cleanup.push(() => console_.close());
  return { stateDir, daemon, console_ };
}

function processSignature(pid: number): string {
  const signature = ownerSignature(pid);
  if (!signature) throw new Error("test owner process is not visible");
  return signature;
}

test("Pi is disabled by default and its peer identity remains reserved", async () => {
  const { stateDir, console_ } = await hub();
  expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless" } })).error).toContain("disabled");
  await expect(ControlClient.connect(stateDir, { role: "peer", peer: "pi" }, 200)).rejects.toThrow();
});

test("enabled Pi starts headless, duplicate start is idempotent, and handover preserves the saved session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-pi-fake-"));
  const config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, fakePi(dir)] } };
  const { stateDir, daemon, console_ } = await hub(config);
  const first = await console_.request({ t: "start", peer: "pi", args: { mode: "headless", backend: "dgx" } });
  expect(first.ok).toBe(true);
  for (let i = 0; i < 100 && daemon.bus.stateOf("pi") !== "idle"; i++) await Bun.sleep(10);
  expect(daemon.bus.stateOf("pi")).toBe("idle");
  const models = JSON.parse(readFileSync(join(stateDir, "pi-sessions", "model-descriptors.json"), "utf8"));
  expect(models.find((model: { id: string }) => model.id === "mlx/fast")).toMatchObject({ contextWindow: 8192, maxTokens: 2048 });
  expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless" } })).already).toBe(true);
  const originalSession = daemon.bus.peers.get("pi")!.recoveryMetadata!().sessionId;
  // Handover must not flash `offline` into the status snapshot between adapters (issue #42): the console
  // sees only the replacement's transition to `idle`.
  const states: string[] = [];
  daemon.bus.tap((e) => { if (e.t === "state") states.push(e.state); });
  expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless", backend: "mlx" } })).ok).toBe(true);
  for (let i = 0; i < 100 && daemon.bus.stateOf("pi") !== "idle"; i++) await Bun.sleep(10);
  expect(daemon.bus.peers.get("pi")!.recoveryMetadata!().sessionId).toBe(originalSession);
  expect((daemon.bus.peers.get("pi")!.recoveryMetadata!().launch as any).backend).toBe("mlx");
  expect(states).toEqual(["idle"]);
  const tui = await console_.request({ t: "start", peer: "pi", args: { mode: "tui", backend: "dgx" } });
  if (!tui.ok) throw new Error(String(tui.error));
  expect(tui.ok).toBe(true);
  expect(tui.launch?.args).toContain("--session");
  const exits = readFileSync(join(stateDir, "hub.log"), "utf8").split("\n").filter((line) => line.includes("Pi exited"));
  expect(exits).toHaveLength(2);
  expect(exits.every((line) => line.includes("stopped for a new Pi owner; inspect ahub status for the replacement"))).toBe(true);
  expect(exits.some((line) => line.includes("owner teardown; inspect"))).toBe(false);
});

// issue #42, other half: the handover hides the replaced adapter's `offline` from the console. If the
// replacement never arrives, the hook has to go back on, or status keeps reporting a dead peer as idle.
test("a handover that never reaches a replacement reports the stopped adapter as offline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-pi-nohandover-"));
  const config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, fakePi(dir)] } };
  const { daemon, console_ } = await hub(config);
  expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless", backend: "dgx" } })).ok).toBe(true);
  for (let i = 0; i < 100 && daemon.bus.stateOf("pi") !== "idle"; i++) await Bun.sleep(10);
  const states: string[] = [];
  daemon.bus.tap((e) => { if (e.t === "state") states.push(e.state); });
  config.pi.enabled = false; // the daemon shares this object: the replacement is refused after the stop
  const res = await console_.request({ t: "start", peer: "pi", args: { mode: "tui", backend: "mlx" } });
  expect(res.ok).toBe(false);
  expect(daemon.bus.stateOf("pi")).toBe("offline");
  expect(states).toEqual(["offline"]);
});

test("Pi tools use hub path guards and approval expiry, with persisted call receipts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-pi-permit-"));
  const config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, fakePi(dir)] } };
  const { stateDir, daemon, console_ } = await hub(config);
  expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless" } })).ok).toBe(true);
  writeFileSync(join(stateDir, "sample.txt"), "managed read");
  writeFileSync(join(stateDir, ".env"), "SECRET_MARKER");
  const launch = (daemon.bus.peers.get("pi") as any).tuiLaunch;
  const call = async (name: string, args: unknown, toolCallId: string) => (await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/tool`, {
    method: "POST", headers: { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ name, args, toolCallId, sessionId: daemon.bus.peers.get("pi")!.recoveryMetadata!().sessionId, generation: 0 }),
  })).json() as Promise<{text: string}>;
  expect((await call("read", { path: "sample.txt" }, "read1")).text).toContain("managed read");
  const blocked = await call("read", { path: ".env" }, "read2");
  expect(blocked.text).toContain("denylist");
  expect(blocked.text).not.toContain("SECRET_MARKER");
  expect((await call("write", { path: "output.txt", content: "denied" }, "write1")).text).toContain("approval expired");
  expect(existsSync(join(stateDir, "output.txt"))).toBe(false);
  expect((await call("write", { path: "different.txt", content: "denied" }, "write1")).text).toContain("different arguments");
});

test("Pi's 'always' answer allows later calls of that tool until Pi restarts, and the dashboard cannot give it (#209)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-pi-always-"));
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-pi-daemon-"));
  const config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, fakePi(dir)] }, memory: { ...DEFAULT_CONFIG.memory, enabled: false } };
  const daemon = await startDaemon({ cwd: stateDir, permissionTimeoutMs: 10_000, projectId: "pi-project", instanceId: `pi-instance-${Math.random()}`, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" });
  cleanup.push(() => console_.close());
  const asks: any[] = [];
  console_.onPush = (m) => { if (m.t === "permission") asks.push(m); };
  console_.send({ t: "tail" });
  const asked = async (n: number) => { for (let i = 0; i < 300 && asks.length < n; i++) await Bun.sleep(10); expect(asks.length).toBe(n); return asks[n - 1]; };
  const start = async (model: string) => {
    expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless", model } })).ok).toBe(true);
    for (let i = 0; i < 100 && daemon.bus.stateOf("pi") !== "idle"; i++) await Bun.sleep(10);
    const launch = (daemon.bus.peers.get("pi") as any).tuiLaunch;
    return async (name: string, args: unknown, toolCallId: string) => ((await (await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/tool`, {
      method: "POST", headers: { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ name, args, toolCallId, sessionId: daemon.bus.peers.get("pi")!.recoveryMetadata!().sessionId, generation: 0 }),
    })).json()) as { text: string }).text;
  };
  let call = await start("dgx/fast");

  const first = call("write", { path: "one.txt", content: "one" }, "w1");
  const ask = await asked(1);
  expect(ask.options.map((o: any) => [o.optionId, o.kind])).toEqual([["allow", "allow_once"], ["always", "allow_always"], ["deny", "reject_once"]]);
  expect(ask.options[1].name).toBe("Always allow write until Pi restarts");
  const opened = await console_.request({ t: "ui" });
  const url = new URL(opened.url);
  const headers: Record<string, string> = { origin: url.origin, "content-type": "application/json" };
  const session = await fetch(`${url.origin}/session`, { method: "POST", headers, body: JSON.stringify({ ticket: url.hash.slice(1) }) });
  headers.cookie = session.headers.get("set-cookie")!.split(";")[0]!;
  const ui = await (await fetch(`${url.origin}/action`, { method: "POST", headers, body: JSON.stringify({ action: "permit", id: ask.id, option: "always" }) })).json() as any;
  expect(ui.ok).toBe(false);
  expect((await console_.request({ t: "permit", id: ask.id, option: "always", surface: "console" })).ok).toBe(true);
  expect(await first).toBe("wrote one.txt");

  expect(await call("write", { path: "two.txt", content: "two" }, "w2")).toBe("wrote two.txt");
  expect(asks.length).toBe(1);
  const log = readFileSync(join(stateDir, "hub.log"), "utf8");
  expect(log).toContain("permission auto-allowed for pi: write (granted until Pi restarts)");
  expect(log).not.toContain("two.txt");
  const edit = call("edit", { path: "two.txt", old: "two", new: "2" }, "e1");
  expect((await asked(2)).options[1].name).toBe("Always allow edit until Pi restarts");
  expect((await console_.request({ t: "permit", id: asks[1].id, surface: "console" })).ok).toBe(true);
  expect(await edit).toContain("did not approve");

  call = await start("dgx/coding");
  const again = call("write", { path: "three.txt", content: "three" }, "w3");
  await asked(3);
  expect((await console_.request({ t: "permit", id: asks[2].id, surface: "console" })).ok).toBe(true);
  expect(await again).toContain("did not approve");
  expect(existsSync(join(stateDir, "three.txt"))).toBe(false);
});

test.skipIf(process.platform !== "darwin")("idle Pi user_bash keeps the managed route without opt-in budgets and charges only run scope when enabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-pi-user-bash-"));
  const config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, fakePi(dir)] } };
  const { stateDir, daemon, console_ } = await hub(config, true);
  expect((await console_.request({ t: "start", peer: "pi", args: { mode: "tui" } })).ok).toBe(true);

  const peer = daemon.bus.peers.get("pi") as any;
  const launch = peer.tuiLaunch;
  const owner = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  cleanup.push(async () => { if (owner.exitCode === null) owner.kill(); await owner.exited; });
  const sessionDir = join(stateDir, "pi-sessions"); mkdirSync(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, "idle-budget.jsonl");
  writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "idle-budget", cwd: stateDir }) + "\n");
  const metadata = { sessionId: "idle-budget", sessionFile };
  const base = launch.env.AGENTHUB_PI_BRIDGE_URL;
  const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
  const generation = 0;
  const session = await fetch(`${base}/event`, { method: "POST", headers, body: JSON.stringify({ type: "session_start", ownerToken: launch.env.AGENTHUB_PI_OWNER_TOKEN, pid: owner.pid, signature: processSignature(owner.pid), sessionId: metadata.sessionId, sessionFile: metadata.sessionFile }) });
  expect(session.status).toBe(200);
  const budget = async () => fetch(`${base}/budget`, { method: "POST", headers, body: JSON.stringify({ unit: "tool_calls", idleUserBash: true, generation }) });
  const tool = async (name: string, reservation: string) => fetch(`${base}/tool`, { method: "POST", headers, body: JSON.stringify({ name: "bash", purpose: "idle_user_bash", sessionId: metadata.sessionId, generation, reservation, toolCallId: `user-bash-${name}`, args: { command: `printf managed > ${name}`, cwd: stateDir } }) });

  const unconfigured = await budget();
  expect(unconfigured.status).toBe(200);
  const unconfiguredResult = await unconfigured.json() as any;
  expect(unconfiguredResult).toMatchObject({ decisions: [] });
  expect(await (await tool("legacy.txt", unconfiguredResult.reservation)).json()).toMatchObject({ text: expect.stringContaining("(exit 0)") });
  expect(readFileSync(join(stateDir, "legacy.txt"), "utf8")).toBe("managed");

  expect((await console_.request({ t: "execution_budget", op: "configure", config: { id: "run:pi-shell", kind: "run", peers: ["pi"], limits: { tool_calls: 1 } } })).ok).toBe(true);
  const budgeted = await (await budget()).json() as any;
  expect(budgeted.decisions).toMatchObject([{ allowed: true, unit: "tool_calls", used: 1, remaining: 0 }]);
  expect(await (await tool("budgeted.txt", budgeted.reservation)).json()).toMatchObject({ text: expect.stringContaining("(exit 0)") });
  const exhausted = await budget();
  expect(exhausted.status).toBe(200);
  expect(((await exhausted.json()) as any).decisions).toMatchObject([{ allowed: false, reason: "exhausted", used: 1, remaining: 0 }]);
  const staleTool = await tool("must-not-exist.txt", "missing-reservation");
  expect(staleTool.status).toBe(409);
  expect(existsSync(join(stateDir, "must-not-exist.txt"))).toBe(false);
}, 30_000);

test("an unattached Pi TUI launch can be replaced without restarting the hub", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-pi-pending-"));
  const config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, fakePi(dir)] } };
  const { console_ } = await hub(config);
  const first = await console_.request({ t: "start", peer: "pi", args: { mode: "tui" } });
  expect(first.ok).toBe(true);
  const second = await console_.request({ t: "start", peer: "pi", args: { mode: "tui" } });
  expect(second.ok).toBe(true);
  expect(second.launch.env.AGENTHUB_PI_BRIDGE_TOKEN).not.toBe(first.launch.env.AGENTHUB_PI_BRIDGE_TOKEN);
  const staleStatus = await fetch(`${first.launch.env.AGENTHUB_PI_BRIDGE_URL}/event`, { method: "POST", headers: { authorization: `Bearer ${first.launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ type: "agent_start" }), signal: AbortSignal.timeout(1000) }).then((r) => r.status).catch(() => 0);
  expect(staleStatus).not.toBe(200);
  expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless" } })).ok).toBe(true);
});

test("empty Pi mode handover and pending-launch retry retain the source identity", async () => {
  const config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts"), "--empty-session"] } };
  const { daemon, console_ } = await hub(config);
  expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless" } })).ok).toBe(true);
  const id = daemon.bus.peers.get("pi")!.recoveryMetadata!().sessionId;
  const inspected = await console_.request({ t: "recovery", op: "inspect", expectedInstanceId: (await console_.request({ t: "status" })).status.instanceId });
  expect(inspected.ok).toBe(true);
  expect(inspected.recovery.peers.pi.launch.sessionFile).toBeUndefined();
  const tui = await console_.request({ t: "start", peer: "pi", args: { mode: "tui" } });
  expect(tui.ok).toBe(true);
  expect(tui.launch.args).toContain("--session-id");
  expect(tui.launch.args).toContain(id);
  expect(tui.launch.args).not.toContain("--session");
  const retried = await console_.request({ t: "start", peer: "pi", args: { mode: "headless" } });
  expect(retried.ok).toBe(true);
  expect(daemon.bus.peers.get("pi")!.recoveryMetadata!().sessionId).toBe(id);
});

test("a stopped Pi owner can hand its persisted history to a different mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-pi-stopped-"));
  const config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, fakePi(dir)] } };
  const { daemon, console_ } = await hub(config);
  expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless" } })).ok).toBe(true);
  const peer = daemon.bus.peers.get("pi")!;
  const saved = peer.recoveryMetadata!();
  await peer.stop();
  const resumed = await console_.request({ t: "start", peer: "pi", args: { mode: "tui" } });
  expect(resumed.ok).toBe(true);
  expect(resumed.launch.args).toContain("--session");
  expect(resumed.launch.args).toContain(saved.sessionFile);
});

// issue #66: after a crash, pi.auto_start brings Pi back on its recorded session, or on a fresh one.
/** #269: Pi's start mode is its TUI unless set: a hub that auto-starts a headless Pi says so, as these fixtures do. */
const HEADLESS_PI = { pi: { start_mode: "headless" as const } };
async function crashedHub(piConfig: Partial<typeof DEFAULT_CONFIG.pi>, session: (stateDir: string) => string | undefined, recovery = DEFAULT_CONFIG.recovery, launch: Record<string, unknown> = { mode: "headless", backend: "dgx" }, extra: unknown[] = [], peers: typeof DEFAULT_CONFIG.peers = {}) {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-pi-crash-")));
  mkdirSync(join(stateDir, "pi-sessions"), { recursive: true });
  const sessionFile = session(stateDir);
  // What a run that died left behind: a session record of another instance, with Pi on that session file.
  writeFileSync(join(stateDir, "sessions.json"), JSON.stringify({ instanceId: "crashed", at: Date.now(), peers: [...extra, { peer: "pi", meta: { launch: { kind: "pi", ...launch }, ...(sessionFile ? { sessionFile } : {}) } }] }));
  const config = { ...DEFAULT_CONFIG, recovery, peers, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts")], ...piConfig }, memory: { ...DEFAULT_CONFIG.memory, enabled: false } };
  const daemon = await startDaemon({ cwd: stateDir, permissionTimeoutMs: 20, projectId: "pi-project", instanceId: `pi-instance-${Math.random()}`, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" });
  cleanup.push(() => console_.close());
  const crash = async () => ((await console_.request({ t: "status" })).status.crash ?? []) as string[];
  return { daemon, crash };
}
const recorded = (stateDir: string) => {
  const file = join(stateDir, "pi-sessions", "recorded.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", id: "recorded-1", cwd: stateDir }) + "\n");
  return file;
};

test("after a crash, pi.auto_start resumes Pi on its recorded session, also with auto-resume off", async () => {
  const { daemon, crash } = await crashedHub({ auto_start: true }, recorded);
  for (let i = 0; i < 200 && daemon.bus.stateOf("pi") !== "idle"; i++) await Bun.sleep(10);
  expect(daemon.bus.peers.get("pi")!.recoveryMetadata!().sessionId).toBe("recorded-1");
  expect((await crash()).some((l) => l.startsWith("pi resumed (pi.auto_start): pi: its session file can be resumed"))).toBe(true);
});

test("after a crash, a Pi resume that fails falls back to a fresh session under pi.auto_start, and the report says so", async () => {
  const { daemon, crash } = await crashedHub({ auto_start: true }, (dir) => join(dir, "pi-sessions", "gone.jsonl"), { auto_resume_after_crash: true });
  for (let i = 0; i < 200 && !(await crash()).some((l) => l.startsWith("pi.auto_start")); i++) await Bun.sleep(10);
  expect(daemon.bus.stateOf("pi")).toBe("idle");
  expect(daemon.bus.peers.get("pi")!.recoveryMetadata!().sessionId).toBe("fake-session");
  const report = await crash();
  expect(report.some((l) => l.startsWith("pi not resumed ("))).toBe(true);
  expect(report).toContain("pi.auto_start started a fresh session");
});

test("after a crash, with pi.auto_start off, a recorded Pi is reported and not started (auto-resume off)", async () => {
  const { daemon, crash } = await crashedHub({ auto_start: false }, recorded);
  for (let i = 0; i < 100 && !(await crash()).length; i++) await Bun.sleep(10);
  await Bun.sleep(100);
  expect(daemon.bus.peers.has("pi")).toBe(false);
  expect((await crash()).some((l) => l.includes("(recovery.auto_resume_after_crash is off)"))).toBe(true);
});

test("after a crash, a terminal Pi is reported with its command and never replaced by a headless one while its start mode is tui (#269)", async () => {
  const { daemon, crash } = await crashedHub({ auto_start: true }, recorded, DEFAULT_CONFIG.recovery, { mode: "tui", backend: "dgx", model: "dgx/fast" });
  for (let i = 0; i < 200 && !(await crash()).some((l) => l.startsWith("pi.auto_start")); i++) await Bun.sleep(10);
  const report = await crash();
  expect(report.some((l) => l.startsWith("pi: it ran in a terminal; start it again with ahub pi --mode tui --session-file "))).toBe(true);
  expect(report).toContain("pi.auto_start starts no headless Pi in place of a terminal one: run the command above, or set peers.pi.start_mode to headless");
  expect(report.some((l) => l.startsWith("pi.auto_start started a fresh session"))).toBe(false);
  await Bun.sleep(50);
  expect(daemon.bus.stateOf("pi")).toBe("offline");
});

test("after a crash, a terminal Pi is reported with its command, and with a headless start mode pi.auto_start starts a fresh headless one on the recorded model", async () => {
  const { daemon, crash } = await crashedHub({ auto_start: true }, recorded, DEFAULT_CONFIG.recovery, { mode: "tui", backend: "dgx", model: "dgx/fast" }, [], HEADLESS_PI);
  for (let i = 0; i < 200 && !(await crash()).some((l) => l.startsWith("pi.auto_start")); i++) await Bun.sleep(10);
  const report = await crash();
  expect(report.some((l) => l.startsWith("pi: it ran in a terminal; start it again with ahub pi --mode tui --session-file "))).toBe(true);
  expect(report.some((l) => l.startsWith("pi.auto_start started a fresh session; to go back to the recorded session"))).toBe(true);
  const launch = daemon.bus.peers.get("pi")!.recoveryMetadata!().launch as Record<string, unknown>;
  expect(launch).toMatchObject({ mode: "headless", backend: "dgx", model: "dgx/fast" });
});

test("after a crash with no Pi session recorded there is no way back to offer; a fresh start that fails is reported", async () => {
  const until = async (crash: () => Promise<string[]>) => { for (let i = 0; i < 300 && !(await crash()).some((l) => l.startsWith("pi.auto_start")); i++) await Bun.sleep(10); return crash(); };
  const none = await until((await crashedHub({ auto_start: true }, () => undefined)).crash);
  expect(none).toContain("pi: no session file was recorded; start it again with ahub pi");
  expect(none).toContain("pi.auto_start started a fresh session");
  const broken = await until((await crashedHub({ auto_start: true, cmd: [process.execPath, "-e", "process.exit(1)"] }, () => undefined)).crash);
  expect(broken.some((l) => l.startsWith("pi.auto_start could not start Pi either ("))).toBe(true);
});

test("after a crash, malformed session records are skipped and pi.auto_start still brings Pi back", async () => {
  const { daemon, crash } = await crashedHub({ auto_start: true }, recorded, DEFAULT_CONFIG.recovery, undefined, [null, { peer: "kimi", meta: null }]);
  for (let i = 0; i < 200 && daemon.bus.stateOf("pi") !== "idle"; i++) await Bun.sleep(10);
  expect(daemon.bus.peers.get("pi")!.recoveryMetadata!().sessionId).toBe("recorded-1");
  expect((await crash()).some((l) => l.startsWith("pi resumed (pi.auto_start)"))).toBe(true);
});

// issue #68: Pi's hub_send hears a refusal too, instead of "sent".
test("a Pi hub_send the limits refuse returns not sent with the reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-pi-limits-"));
  const config = { ...DEFAULT_CONFIG, limits: { ...DEFAULT_CONFIG.limits, repeat_window_s: 60 }, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, fakePi(dir)] } };
  const { daemon, console_ } = await hub(config);
  expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless" } })).ok).toBe(true);
  for (let i = 0; i < 100 && daemon.bus.stateOf("pi") !== "idle"; i++) await Bun.sleep(10);
  const launch = (daemon.bus.peers.get("pi") as any).tuiLaunch;
  const call = async (name: string, args: unknown, toolCallId: string) => (await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/tool`, {
    method: "POST", headers: { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ name, args, toolCallId, sessionId: daemon.bus.peers.get("pi")!.recoveryMetadata!().sessionId, generation: 0 }),
  })).json() as Promise<{ text: string }>;
  expect((await call("hub_send", { text: "build is green" }, "send1")).text).toBe("sent");
  expect((await call("hub_send", { text: "build is green" }, "send2")).text).toMatch(/^not sent: the same message went to everyone \d+ s ago$/);
});


test("the actual daemon model selector preserves DGX fast for bulk/test class policies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-pi-class-model-"));
  const config = { ...DEFAULT_CONFIG, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, fakePi(dir)] } };
  const { daemon, console_ } = await hub(config);
  expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless", backend: "auto" } })).ok).toBe(true);
  const peer = daemon.bus.peers.get("pi") as PiPeer;
  for (const [cls, expected] of [["bulk_edit", "dgx/fast"], ["test", "dgx/fast"], ["implement", "dgx/coding"], ["summarize", "mlx/fast"]]) {
    const proposed = await console_.request({ t: "task", op: "hub_task_propose", args: { title: `Model policy ${cls}`, class: cls, owner: "pi" } });
    expect(proposed.ok).toBe(true);
    const id = String(proposed.text).match(/task #(\d+)/)?.[1];
    expect(id).toBeDefined();
    const model = await peer["opts"].selectModel!([newEnvelope("hub", "Task model selection", { kind: "task", refs: { task: id! } })]);
    expect(model).toBe(expected!);
  }
  expect(await peer["opts"].selectModel!([newEnvelope("user", "No class pin")])).toBe("hub/auto");
});

test("disabled MLX exposes remote auto only and refuses explicit local launches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-pi-remote-only-"));
  const config = { ...DEFAULT_CONFIG, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, fakePi(dir)] } };
  const { daemon, console_, stateDir } = await hub(config);
  for (const args of [{ backend: "mlx" }, { model: "mlx/fast" }]) {
    const denied = await console_.request({ t: "start", peer: "pi", args });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("mlx.enabled=false");
    expect(daemon.bus.peers.has("pi")).toBe(false);
  }
  expect((await console_.request({ t: "start", peer: "pi", args: { backend: "auto" } })).ok).toBe(true);
  const peer = daemon.bus.peers.get("pi") as PiPeer;
  const models = peer["opts"].relay.models;
  expect(models.map(model => model.id).sort()).toEqual(["dgx/coding", "dgx/fast", "hub/auto"]);
  expect(models.find(model => model.id === "hub/auto")?.maxTokens).toBe(8192);
  expect(await peer["opts"].selectModel!([newEnvelope("user", "unassigned")])).toBe("hub/auto");
  const proposed = await console_.request({ t: "task", op: "hub_task_propose", args: { title: "Summarize remotely", class: "summarize", owner: "pi" } });
  const id = String(proposed.text).match(/task #(\d+)/)?.[1];
  expect(id).toBeDefined();
  expect(await peer["opts"].selectModel!([newEnvelope("hub", "Task", { kind: "task", refs: { task: id! } })])).toBe("hub/auto");
  mkdirSync(join(stateDir, ".agenthub"), { recursive: true });
  writeFileSync(join(stateDir, ".agenthub/routing.toml"), '[local]\nfixed_model="coding"\n[classes.summarize]\npi_backend="mlx"\n');
  const conflict = await console_.request({ t: "start", peer: "pi", args: { backend: "auto" } });
  expect(conflict.ok).toBe(false);
  expect(conflict.error).toContain("classes.summarize");
});

test("recorded MLX crash recovery is rejected before Pi starts", async () => {
  for (const launch of [{ backend: "mlx" }, { backend: "auto", model: "mlx/fast" }]) {
    const stateDir = mkdtempSync(join(tmpdir(), "ahub-pi-disabled-recovery-"));
    writeFileSync(join(stateDir, "sessions.json"), JSON.stringify({ instanceId: "old", at: Date.now(), peers: [{ peer: "pi", meta: { launch } }] }));
    const config = { ...DEFAULT_CONFIG, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: true, cmd: ["must-not-be-spawned"] } };
    await expect(startDaemon({ cwd: stateDir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config })).rejects.toThrow("recorded Pi recovery");
    expect(existsSync(join(stateDir, "sessions.json"))).toBe(true);
    expect(existsSync(join(stateDir, "pi-sessions"))).toBe(false);
  }
});

test("controlled restart refuses recorded MLX without consuming the snapshot", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ahub-pi-disabled-restart-"));
  const priorOperation = process.env.AGENTHUB_RECOVERY_OPERATION;
  const operationId = "disabled-mlx-recovery";
  writeFileSync(join(stateDir, "restart.json"), JSON.stringify({ schemaVersion: 1, projectRoot: stateDir, projectId: "disabled-test", sourceInstanceId: "prior", operationId, committedAt: Date.now(), bus: { schemaVersion: 1, queues: {}, prefaces: {}, seen: [], attempts: {}, withdrawn: [] }, manualPaused: [], peers: [{ id: "pi", state: "idle", queueIds: [], launch: { kind: "pi", backend: "mlx" } }] }));
  process.env.AGENTHUB_RECOVERY_OPERATION = operationId;
  try {
    const config = { ...DEFAULT_CONFIG, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false } };
    await expect(startDaemon({ cwd: stateDir, stateDir, projectId: "disabled-test", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config })).rejects.toThrow("recorded Pi recovery");
    expect(existsSync(join(stateDir, "restart.json"))).toBe(true);
    expect(existsSync(join(stateDir, "pi-sessions"))).toBe(false);
  } finally {
    if (priorOperation === undefined) delete process.env.AGENTHUB_RECOVERY_OPERATION;
    else process.env.AGENTHUB_RECOVERY_OPERATION = priorOperation;
  }
});


async function piToolCall(peer: PiPeer, name: string, args: unknown, toolCallId: string): Promise<{ text: string; failed?: boolean }> {
  const launch = peer.tuiLaunch!;
  return (await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/tool`, { method: "POST", headers: {
    authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json",
  }, body: JSON.stringify({ name, args, toolCallId, sessionId: peer.recoveryMetadata().sessionId, generation: (peer as any).budgetGeneration }) })).json() as Promise<{ text: string; failed?: boolean }>;
}

test("Pi task authority and state refusals return their exact errors as done receipts through the daemon (#254)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-refusal-daemon-"));
  const config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, fakePi(dir)] } };
  const { stateDir, daemon, console_ } = await hub(config);
  const board = new Board(join(stateDir, "hub.db")); cleanup.push(() => board.close());
  const foreign = board.propose("claude", { title: "owned by codex", class: "implement" });
  board.update(foreign.id, "hub", "assigned", { owner: "codex", reviewer: "claude" });
  const reviewing = board.propose("claude", { title: "already reviewing", class: "implement" });
  board.update(reviewing.id, "pi", "accepted", { owner: "pi", state: "in_progress" });
  board.update(reviewing.id, "pi", "done", { state: "in_review" });
  expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless" } })).ok).toBe(true);
  const peer = daemon.bus.peers.get("pi") as PiPeer;
  for (const [name, args, message] of [
    ["hub_task_accept", { id: foreign.id }, `task #${foreign.id}: only its owner (codex) or the console user can do that`],
    ["hub_task_assign", { id: foreign.id, peer: "pi" }, "this operation requires the explicit conductor role"],
    ["hub_task_done", { id: foreign.id, summary: "done" }, `task #${foreign.id}: only its owner (codex) or the console user can do that`],
    ["hub_task_accept", { id: reviewing.id }, `task #${reviewing.id} is in_review: cannot move to in_progress`],
  ] as const) {
    const id = `${name}-${args.id}`;
    const result = await piToolCall(peer, name, args, id);
    expect(result).toEqual({ text: `error: ${message}`, failed: true });
    const db = new Database(join(stateDir, "hub.db"));
    try { expect(db.query("SELECT state,result FROM pi_tool_receipts WHERE call_id=?").get(id)).toEqual({ state: "done", result: `error: ${message}` }); }
    finally { db.close(); }
    expect(await piToolCall(peer, name, args, id)).toEqual(result);
  }
  expect(board.get(foreign.id)!.state).toBe("proposed");
  expect(board.get(reviewing.id)!.state).toBe("in_review");
});

test("a Pi accept failure after its board write remains uncertain and pending, without repeating the effect (#254)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-postwrite-daemon-"));
  const config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, fakePi(dir)] } };
  const { stateDir, daemon, console_ } = await hub(config);
  const board = new Board(join(stateDir, "hub.db")); cleanup.push(() => board.close());
  const task = board.propose("claude", { title: "Pi implementation", class: "implement" });
  board.update(task.id, "hub", "assigned", { owner: "pi" });
  expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless" } })).ok).toBe(true);
  const peer = daemon.bus.peers.get("pi") as PiPeer;
  const prototype = Board.prototype.get;
  // The state transition is committed, then its final readback fails in Board.update.
  const db = new Database(join(stateDir, "hub.db"));
  let failed = false;
  Board.prototype.get = function (id) {
    if (!failed && id === task.id && (db.query("SELECT state FROM tasks WHERE id=?").get(id) as { state?: string })?.state === "in_progress") {
      failed = true; throw new Error("lost board readback after write");
    }
    return prototype.call(this, id);
  };
  let result: { text: string; failed?: boolean };
  try { result = await piToolCall(peer, "hub_task_accept", { id: task.id }, "post-write"); }
  finally { Board.prototype.get = prototype; }
  expect(failed).toBe(true);
  expect(result!.text).toContain("outcome is uncertain");
  expect(result!.failed).toBe(true);
  expect(board.get(task.id)!.state).toBe("in_progress");
  expect(db.query("SELECT state,result FROM pi_tool_receipts WHERE call_id='post-write'").get()).toEqual({ state: "pending", result: null });
  expect((await piToolCall(peer, "hub_task_accept", { id: task.id }, "post-write")).text).toContain("previous tool outcome is uncertain");
  expect(board.get(task.id)!.history.filter((entry) => entry.event === "accepted")).toHaveLength(1);
  db.close();
});

for (const outcome of [{ code: 0 }, { code: 19 }, { signal: "SIGTERM" }] as const) {
  test(`Pi exit notice names the OS cause and next action (${JSON.stringify(outcome)}) (#255)`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-exit-daemon-")), trigger = join(dir, "exit-now");
    const config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: false,
      cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts"), "--exit-trigger", trigger,
        ...("code" in outcome ? ["--exit-code", String(outcome.code)] : ["--exit-signal", outcome.signal])] } };
    const { stateDir, daemon, console_ } = await hub(config);
    const notices: string[] = [];
    console_.onPush = (m) => { if (m.t === "notice") notices.push(String(m.line)); }; console_.send({ t: "tail" });
    expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless" } })).ok).toBe(true);
    writeFileSync(trigger, "exit");
    for (let i = 0; i < 200 && !notices.some((line) => line.startsWith("Pi exited")); i++) await Bun.sleep(5);
    const exits = notices.filter((line) => line.startsWith("Pi exited"));
    expect(exits).toHaveLength(1);
    expect(exits[0]).toContain("code" in outcome ? `code ${outcome.code}` : `signal ${outcome.signal}`);
    expect(exits[0]).toContain("pi.auto_start is off; start it with ahub pi");
    expect(readFileSync(join(stateDir, "hub.log"), "utf8").split("\n").filter((line) => line.includes("Pi exit:"))).toHaveLength(1);
    expect(daemon.bus.stateOf("pi")).toBe("offline");
  });
}

test("pi.auto_start resumes one recorded idle-exit session and stops at a second exit within 60 s (#255)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-auto-exit-")), trigger = join(dir, "exit-now");
  const config = { ...DEFAULT_CONFIG, peers: HEADLESS_PI, pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: true,
    cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts"), "--exit-trigger", trigger, "--exit-consume-trigger", "--exit-code", "0"] } };
  const { stateDir, daemon, console_ } = await hub(config);
  const notices: string[] = [];
  console_.onPush = (m) => { if (m.t === "notice") notices.push(String(m.line)); }; console_.send({ t: "tail" });
  for (let i = 0; i < 200 && daemon.bus.stateOf("pi") !== "idle"; i++) await Bun.sleep(5);
  expect(daemon.bus.stateOf("pi")).toBe("idle");
  const original = daemon.bus.peers.get("pi") as PiPeer, saved = original.recoveryMetadata();
  writeFileSync(trigger, "exit");
  for (let i = 0; i < 300 && (daemon.bus.peers.get("pi") === original || daemon.bus.stateOf("pi") !== "idle"); i++) await Bun.sleep(5);
  expect(daemon.bus.peers.get("pi")).not.toBe(original);
  expect(daemon.bus.stateOf("pi")).toBe("idle");
  writeFileSync(trigger, "exit again");
  for (let i = 0; i < 300 && !notices.some((line) => line.includes("restart limit")); i++) await Bun.sleep(5);
  expect(notices.filter((line) => line.includes("Pi exited"))).toHaveLength(2);
  expect(notices.filter((line) => line.includes("restart limit"))).toHaveLength(1);
  const replacement = daemon.bus.peers.get("pi") as PiPeer;
  expect(replacement).not.toBe(original);
  expect(replacement.recoveryMetadata()).toMatchObject({ sessionId: saved.sessionId, sessionFile: saved.sessionFile });
  expect(daemon.bus.stateOf("pi")).toBe("offline");
  expect(readFileSync(join(stateDir, "hub.log"), "utf8").split("\n").filter((line) => line.includes("Pi exit:"))).toHaveLength(2);
});


test("pi.auto_start does not replace an idle-exit session whose persisted history cannot be verified (#255)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-auto-unpersisted-")), trigger = join(dir, "exit-now");
  const config = { ...DEFAULT_CONFIG, peers: HEADLESS_PI, pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: true,
    cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts"), "--empty-session", "--exit-trigger", trigger, "--exit-code", "0"] } };
  const { stateDir, daemon, console_ } = await hub(config);
  const notices: string[] = [];
  console_.onPush = (m) => { if (m.t === "notice") notices.push(String(m.line)); }; console_.send({ t: "tail" });
  for (let i = 0; i < 200 && daemon.bus.stateOf("pi") !== "idle"; i++) await Bun.sleep(5);
  expect(daemon.bus.stateOf("pi")).toBe("idle");
  const original = daemon.bus.peers.get("pi") as PiPeer;
  writeFileSync(trigger, "exit");
  for (let i = 0; i < 300 && !notices.some((line) => line.includes("could not resume its recorded session")); i++) await Bun.sleep(5);
  expect(notices.some((line) => line.includes("could not resume its recorded session") && line.includes("ahub pi"))).toBe(true);
  expect(daemon.bus.peers.get("pi")).toBe(original);
  expect(daemon.bus.stateOf("pi")).toBe("offline");
  expect(existsSync(join(stateDir, "pi-sessions", "fake-session.jsonl"))).toBe(false);
});

test("pi.auto_start reports a startup exit once and does not retry it (#255)", async () => {
  const config = { ...DEFAULT_CONFIG, peers: HEADLESS_PI, pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: true, cmd: [process.execPath, "-e", "process.exit(0)"] } };
  const { stateDir, daemon } = await hub(config);
  for (let i = 0; i < 200 && !readFileSync(join(stateDir, "hub.log"), "utf8").includes("startup failed;"); i++) await Bun.sleep(5);
  const log = readFileSync(join(stateDir, "hub.log"), "utf8");
  expect(log).toContain("startup failed; inspect its session, then ahub pi");
  expect(log.split("\n").filter((line) => line.includes("Pi exit:"))).toHaveLength(1);
  expect(log).not.toContain("will try its recorded session once");
  expect(daemon.bus.stateOf("pi")).toBe("offline");
});

test("an active Pi turn exiting under auto_start stays offline for reconciliation (#255)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-auto-active-")), trigger = join(dir, "exit-now");
  const config = { ...DEFAULT_CONFIG, peers: HEADLESS_PI, pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: true,
    cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts"), "--exit-trigger", trigger, "--exit-code", "0"] } };
  const { stateDir, daemon } = await hub(config);
  for (let i = 0; i < 200 && daemon.bus.stateOf("pi") !== "idle"; i++) await Bun.sleep(5);
  expect(daemon.bus.stateOf("pi")).toBe("idle");
  const original = daemon.bus.peers.get("pi") as PiPeer, launch = original.tuiLaunch!;
  await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/event`, { method: "POST", headers: {
    authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json",
  }, body: JSON.stringify({ type: "agent_start", generation: 1 }) });
  writeFileSync(trigger, "exit");
  for (let i = 0; i < 200 && daemon.bus.stateOf("pi") !== "offline"; i++) await Bun.sleep(5);
  expect(daemon.bus.stateOf("pi")).toBe("offline");
  expect(daemon.bus.peers.get("pi")).toBe(original);
  expect(readFileSync(join(stateDir, "hub.log"), "utf8")).toContain("turn/tool effects may be partial; inspect its session, then ahub pi");
});


test("Pi conductor entry validation refusals settle receipts before assignment or startup effects (#254)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-validation-daemon-"));
  const config = { ...DEFAULT_CONFIG, roles: { ...DEFAULT_CONFIG.roles, pi: ["implementer", "verifier", "conductor"] },
    pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, fakePi(dir)] } };
  const { stateDir, daemon, console_ } = await hub(config);
  const board = new Board(join(stateDir, "hub.db")); cleanup.push(() => board.close());
  const open = board.propose("claude", { title: "open", class: "implement" });
  board.update(open.id, "hub", "assigned", { owner: "pi" });
  const closed = board.propose("claude", { title: "closed", class: "implement" });
  board.update(closed.id, "pi", "accepted", { owner: "pi", state: "in_progress" });
  board.update(closed.id, "pi", "approved", { state: "approved" });
  expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless" } })).ok).toBe(true);
  const peer = daemon.bus.peers.get("pi") as PiPeer;
  const db = new Database(join(stateDir, "hub.db")); cleanup.push(() => db.close());
  for (const [name, args, message, callId] of [
    ["hub_task_assign", { id: open.id, peer: "bad peer" }, "peer must be a valid agent peer id", "invalid-peer"],
    ["hub_task_assign", { id: closed.id, peer: "pi" }, `task #${closed.id} is approved: it can no longer change hands`, "closed-task"],
    ["hub_task_escalate", { id: closed.id }, `task #${closed.id} is approved: it can no longer change hands`, "closed-escalate"],
    ["hub_peer_start", { peer: "pi", mode: "invalid" }, "mode must be headless or tui", "invalid-mode"],
  ] as const) {
    const result = await piToolCall(peer, name, args, callId);
    expect(result).toEqual({ text: `error: ${message}`, failed: true });
    expect(db.query("SELECT state,result FROM pi_tool_receipts WHERE call_id=?").get(callId)).toEqual({ state: "done", result: `error: ${message}` });
    expect(await piToolCall(peer, name, args, callId)).toEqual(result);
  }
  expect(board.get(open.id)!.history.at(-1)!.event).toBe("assigned");
  expect(board.get(closed.id)!.history.at(-1)!.event).toBe("approved");
  expect(daemon.bus.peers.get("pi")).toBe(peer);
});


test("a watchdog Pi teardown gives inspection and ahub pi guidance rather than claiming a requested person stop (#255)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-watchdog-notice-"));
  const config = { ...DEFAULT_CONFIG, watchdog_ms: 50, pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: false, cmd: [process.execPath, fakePi(dir)] } };
  const { stateDir, daemon, console_ } = await hub(config);
  expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless" } })).ok).toBe(true);
  const peer = daemon.bus.peers.get("pi") as PiPeer, launch = peer.tuiLaunch!;
  await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/event`, { method: "POST", headers: {
    authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json",
  }, body: JSON.stringify({ type: "agent_start", generation: 1 }) });
  for (let i = 0; i < 300 && daemon.bus.stateOf("pi") !== "offline"; i++) await Bun.sleep(5);
  expect(daemon.bus.stateOf("pi")).toBe("offline");
  const exit = readFileSync(join(stateDir, "hub.log"), "utf8").split("\n").find((line) => line.includes("Pi exited"));
  expect(exit).toContain("owner teardown; inspect its session, then ahub pi");
  expect(exit).not.toContain("requested stop");
});


test("a long Pi idle restart attempt rearms its 60 s bound after settling (#255)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-long-restart-")), trigger = join(dir, "exit-now");
  const config = { ...DEFAULT_CONFIG, peers: HEADLESS_PI, pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: true,
    cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts"), "--exit-trigger", trigger, "--exit-consume-trigger", "--exit-code", "0"] } };
  const { stateDir, daemon } = await hub(config);
  for (let i = 0; i < 200 && daemon.bus.stateOf("pi") !== "idle"; i++) await Bun.sleep(5);
  const original = daemon.bus.peers.get("pi") as PiPeer;
  expect(original.state).toBe("idle");
  const capture = original.captureResume.bind(original), now = Date.now;
  let waiting = false, release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  original.captureResume = async () => { const saved = await capture(); if (!waiting) { waiting = true; await barrier; } return saved; };
  try {
    writeFileSync(trigger, "exit");
    for (let i = 0; i < 200 && !waiting; i++) await Bun.sleep(5);
    expect(waiting).toBe(true);
    Date.now = () => now() + 61_000; // elapsed while the attempt was in flight, not after its replacement settled
    release();
    for (let i = 0; i < 300 && !readFileSync(join(stateDir, "hub.log"), "utf8").includes("resumed the recorded Pi session after its idle exit"); i++) await Bun.sleep(5);
    const replacement = daemon.bus.peers.get("pi") as PiPeer;
    expect(replacement).not.toBe(original); expect(replacement.state).toBe("idle");
    writeFileSync(trigger, "second exit");
    for (let i = 0; i < 300 && !readFileSync(join(stateDir, "hub.log"), "utf8").includes("restart limit"); i++) await Bun.sleep(5);
    expect(readFileSync(join(stateDir, "hub.log"), "utf8")).toContain("restart limit (one in 60 s)");
    expect(daemon.bus.peers.get("pi")).toBe(replacement);
    expect(daemon.bus.stateOf("pi")).toBe("offline");
  } finally { release(); Date.now = now; original.captureResume = capture; }
});


test("Pi review's internal post-write escalation keeps the generic default and an uncertain pending receipt (#254)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-postreview-daemon-"));
  const config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, fakePi(dir)] } };
  const { stateDir, daemon, console_ } = await hub(config);
  const board = new Board(join(stateDir, "hub.db")); cleanup.push(() => board.close());
  const task = board.propose("claude", { title: "second review", class: "implement" });
  board.update(task.id, "codex", "accepted", { owner: "codex", reviewer: "pi", state: "in_progress", rejections: 1 });
  board.update(task.id, "codex", "done", { state: "in_review" });
  expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless" } })).ok).toBe(true);
  const peer = daemon.bus.peers.get("pi") as PiPeer, escalate = Tasks.prototype.escalate;
  let reached = false;
  Tasks.prototype.escalate = async function (...args) {
    if (args[0] === "hub" && args[1] === task.id) {
      reached = true;
      expect(board.get(task.id)!.history.at(-1)!.event).toBe("changes_requested"); // the review is already saved
      board.update(task.id, "hub", "reopened", { state: "in_progress" });
      board.update(task.id, "claude", "approved", { state: "approved" }); // another task operation closes it before escalation
    }
    return escalate.apply(this, args);
  };
  let result: { text: string; failed?: boolean };
  const args = { id: task.id, verdict: "changes_requested", note: "fix it" };
  try { result = await piToolCall(peer, "hub_review", args, "post-review"); }
  finally { Tasks.prototype.escalate = escalate; }
  expect(reached).toBe(true); expect(result!.text).toContain("outcome is uncertain");
  const db = new Database(join(stateDir, "hub.db")); cleanup.push(() => db.close());
  expect(db.query("SELECT state,result FROM pi_tool_receipts WHERE call_id='post-review'").get()).toEqual({ state: "pending", result: null });
  expect((await piToolCall(peer, "hub_review", args, "post-review")).text).toContain("previous tool outcome is uncertain");
  expect(board.get(task.id)!.history.filter((entry) => entry.event === "changes_requested")).toHaveLength(1);
});


test("global hub stop gives a requested-stop notice rather than replacement or failure guidance (#255)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-global-stop-"));
  const config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, fakePi(dir)] } };
  const { stateDir, daemon, console_ } = await hub(config);
  expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless" } })).ok).toBe(true);
  await daemon.stop();
  const exits = readFileSync(join(stateDir, "hub.log"), "utf8").split("\n").filter((line) => line.includes("Pi exited"));
  expect(exits).toHaveLength(1);
  expect(exits[0]).toContain("hub is stopping; requested stop, no automatic restart");
  expect(exits[0]).not.toContain("requested replacement");
  expect(exits[0]).not.toContain("owner teardown; inspect");
});

for (const phase of ["startup", "active"] as const) {
  test(`Pi ${phase} failure keeps inspection guidance with auto_start off (#255)`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-auto-off-order-")), trigger = join(dir, "exit-now");
    const config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: false,
      cmd: phase === "startup" ? [process.execPath, "-e", "process.exit(0)"] :
        [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts"), "--exit-trigger", trigger, "--exit-code", "0"] } };
    const { stateDir, daemon, console_ } = await hub(config);
    const result = await console_.request({ t: "start", peer: "pi", args: { mode: "headless" } });
    expect(result.ok).toBe(phase === "active");
    if (phase === "active") {
      const launch = (daemon.bus.peers.get("pi") as PiPeer).tuiLaunch!;
      await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/event`, { method: "POST", headers: {
        authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json",
      }, body: JSON.stringify({ type: "agent_start", generation: 1 }) });
      writeFileSync(trigger, "exit");
    }
    for (let i = 0; i < 200 && daemon.bus.stateOf("pi") !== "offline"; i++) await Bun.sleep(5);
    const exit = readFileSync(join(stateDir, "hub.log"), "utf8").split("\n").find((line) => line.includes("Pi exited"));
    expect(exit).toContain(phase === "startup" ? "startup failed; inspect its session, then ahub pi" : "turn/tool effects may be partial; inspect its session, then ahub pi");
    expect(exit).not.toContain("pi.auto_start is off");
  });
}


// Exercise the real approval registry and authenticated Pi bridge without a native model/account.
async function approvalPi(timeout = 20, approvalTurnAbort = false) {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-pi-approval-"));
  const config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, fakePi(dir)] }, memory: { ...DEFAULT_CONFIG.memory, enabled: false } };
  const instanceId = `approval-${Math.random()}`;
  const daemon = await startDaemon({ cwd: dir, stateDir: dir, projectId: "approval-project", instanceId, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, permissionTimeoutMs: timeout, config });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(dir, { role: "console" });
  cleanup.push(() => console_.close());
  const asks: any[] = [];
  console_.onPush = (m) => { if (m.t === "permission") asks.push(m); };
  console_.send({ t: "tail" });
  expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless" } })).ok).toBe(true);
  const pi = daemon.bus.peers.get("pi") as any;
  const launch = pi.tuiLaunch, metadata = pi.recoveryMetadata();
  const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
  const bridgeUrl = launch.env.AGENTHUB_PI_BRIDGE_URL as string;
  const post = (path: string, body: unknown) => fetch(`${bridgeUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  expect((await post("/event", { type: "session_start", ownerToken: launch.env.AGENTHUB_PI_OWNER_TOKEN, pid: pi.proc.pid, signature: processSignature(pi.proc.pid), sessionId: metadata.sessionId, sessionFile: metadata.sessionFile, ...(approvalTurnAbort ? { approvalTurnAbort: true } : {}) })).status).toBe(200);
  const event = (type: string, fields = {}) => post("/event", { type, sessionId: metadata.sessionId, ...fields });
  const call = async (id: string, name = "write") => (await (await post("/tool", { name, toolCallId: id, sessionId: metadata.sessionId, generation: pi.budgetGeneration, args: name === "edit" ? { path: `${id}.txt`, old: "a", new: "b" } : { path: `${id}.txt`, content: id } })).json()) as { text: string; failed: boolean };
  const asked = async (n: number) => { for (let i = 0; i < 200 && asks.length < n; i++) await Bun.sleep(5); expect(asks.length).toBe(n); return asks[n - 1]; };
  const inspect = async () => (await console_.request({ t: "recovery", op: "inspect", expectedInstanceId: instanceId })).recovery;
  const nextCommand = async () => (await (await fetch(`${bridgeUrl}/commands`, { headers })).json() as any).command;
  return { dir, daemon, console_, pi, event, post, call, asked, asks, inspect, bridgeUrl, headers, nextCommand };
}

test("two Pi approval expiries return distinct results including the second, then stop the turn without retry", async () => {
  const h = await approvalPi();
  const receipts: any[] = [], failures: string[] = [];
  const settle = h.pi.onDelivery;
  h.pi.onDelivery = (receipt: any) => { receipts.push(receipt); settle?.(receipt); };
  h.pi.opts.onTurnFailure = async (_envs: unknown, reason: string) => { failures.push(reason); };
  await h.pi.deliver([newEnvelope("user", "work until approvals expire", { to: ["pi"] })], "unanswered-delivery");
  await h.event("agent_start", { generation: 1 });
  for (const id of ["expired-first", "expired-second"]) {
    const result = await h.call(id);
    expect(result.failed).toBe(true);
    expect(typeof result.text).toBe("string");
    expect(result.text).toContain("approval expired");
    expect(result.text).not.toContain("did not approve");
    expect(existsSync(join(h.dir, `${id}.txt`))).toBe(false);
  }
  for (let i = 0; i < 200 && h.pi.state !== "offline"; i++) await Bun.sleep(10);
  expect(h.pi.state).toBe("offline");
  const log = readFileSync(join(h.dir, "hub.log"), "utf8");
  expect(log).toContain("Pi turn stopped after two unanswered approvals");
  expect(h.asks).toHaveLength(2);
  expect(failures).toEqual([]); // observe the actual escalation hook, never a nonexistent log phrase
  expect(receipts.filter(receipt => receipt.state === "accepted")).toHaveLength(1);
  expect(receipts.at(-1).state).toBe("needs_review"); // unsupported Pi went offline, not safely replayable
}, 30_000);

test("Pi tool abort withdraws only its own approval and a late always answer cannot grant future calls", async () => {
  const h = await approvalPi(10_000);
  await h.event("agent_start", { generation: 1 });
  const first = h.call("abort-one"); const a = await h.asked(1);
  const sibling = h.call("sibling"); const b = await h.asked(2);
  // A cross-session cancellation must not remove any current request.
  await h.post("/event", { type: "tool_abort", generation: 1, sessionId: "another-session", toolCallId: "abort-one" });
  expect((await h.inspect()).pendingApprovals).toBe(2);
  await h.event("tool_abort", { generation: 1, toolCallId: "abort-one" });
  expect(await first).toMatchObject({ failed: true, text: expect.stringContaining("withdrawn") });
  expect((await h.inspect()).pendingApprovals).toBe(1);
  expect((await h.console_.request({ t: "permit", id: a.id, option: "always", surface: "console" })).ok).toBe(false);
  expect((await h.console_.request({ t: "permit", id: b.id, option: "deny", surface: "console" })).ok).toBe(true);
  expect((await sibling).text).toContain("did not approve");
  expect((await h.inspect()).pendingApprovals).toBe(0);
  const later = h.call("after-abort"); const c = await h.asked(3);
  expect((await h.console_.request({ t: "permit", id: c.id, option: "deny", surface: "console" })).ok).toBe(true);
  expect((await later).text).toContain("did not approve");
  await h.event("agent_settled", { generation: 1 });
  expect(h.pi.recoveryReady).toBe(true);
  expect(existsSync(join(h.dir, "after-abort.txt"))).toBe(false);
  // An abort arriving before the corresponding /tool call still fences that one ID.
  await h.event("agent_start", { generation: 2 });
  await h.event("tool_abort", { generation: 2, toolCallId: "early" });
  expect(await h.call("early")).toMatchObject({ failed: true, text: expect.stringContaining("cancelled") });
  expect(await h.call("early")).toMatchObject({ failed: true, text: expect.stringContaining("cancelled") });
  expect(h.asks).toHaveLength(3);
  await h.event("agent_settled", { generation: 2 });
}, 30_000);


test.skipIf(process.platform !== "darwin")("a claimed TUI person's shell bypasses hub approval and returns its actual nonzero exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-pi-person-shell-"));
  const config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, fakePi(dir)] } };
  const { stateDir, daemon, console_ } = await hub(config); // deliberately not unattended
  const asks: any[] = [];
  console_.onPush = message => { if (message.t === "permission") asks.push(message); };
  console_.send({ t: "tail" });
  const launch = (await console_.request({ t: "start", peer: "pi", args: { mode: "tui" } })).launch;
  const owner = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  cleanup.push(async () => { if (owner.exitCode === null) owner.kill(); await owner.exited; });
  const sessionDir = join(stateDir, "pi-sessions"); mkdirSync(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, "person.jsonl");
  writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "person-session", cwd: stateDir }) + "\n");
  const post = (path: string, body: unknown) => fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}${path}`, { method: "POST", headers: { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await post("/event", { type: "session_start", ownerToken: launch.env.AGENTHUB_PI_OWNER_TOKEN, pid: owner.pid, signature: processSignature(owner.pid), sessionId: "person-session", sessionFile, approvalTurnAbort: true })).status).toBe(200);
  const admission = await (await post("/budget", { unit: "tool_calls", idleUserBash: true, generation: 0 })).json() as any;
  const result = await (await post("/tool", { name: "bash", purpose: "idle_user_bash", sessionId: "person-session", generation: 0, reservation: admission.reservation, toolCallId: "human-exit-7", args: { command: "printf human; exit 7", cwd: stateDir } })).json() as any;
  expect(result).toMatchObject({ exitCode: 7, failed: true, text: expect.stringContaining("human") });
  expect(asks).toHaveLength(0);
  expect(readFileSync(join(stateDir, "hub.log"), "utf8")).not.toMatch(/permission [^ ]+ requested by pi/);
  const invalid = await post("/tool", { name: "bash", purpose: "idle_user_bash", sessionId: "person-session", generation: 0, reservation: admission.reservation, toolCallId: "reused-human", args: { command: "true", cwd: stateDir } });
  expect(invalid.status).toBe(409);
  const pi = daemon.bus.peers.get("pi") as PiPeer;
  await post("/event", { type: "agent_start", generation: 1 });
  const abortCommand = fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/commands`, { headers: { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}` } }).then(response => response.json() as Promise<any>);
  for (const id of ["person-expiry-one", "person-expiry-two"]) {
    const expired = await (await post("/tool", { name: "write", toolCallId: id, sessionId: "person-session", generation: 1, args: { path: `${id}.txt`, content: id } })).json() as any;
    expect(expired.text).toContain("approval expired");
  }
  const command = (await abortCommand).command;
  expect(command.cause).toBe("approval");
  await post("/ack", { id: command.id, ok: true });
  await post("/event", { type: "agent_end", generation: 1, failed: true, error: command.reason });
  await post("/event", { type: "agent_settled", generation: 1 });
  expect(pi.state).toBe("idle");
  expect(asks).toHaveLength(2);
  // With no new agent_start to reset state, both idle human commands must still run.
  for (const id of ["person-after-stop", "person-after-stop-again"]) {
    const admission = await (await post("/budget", { unit: "tool_calls", idleUserBash: true, generation: 1 })).json() as any;
    const shell = await (await post("/tool", { name: "bash", purpose: "idle_user_bash", sessionId: "person-session", generation: 1, reservation: admission.reservation, toolCallId: id, args: { command: "printf human-after-stop; exit 7" } })).json() as any;
    expect(shell.exitCode).toBe(7); expect(shell.text).toContain("human-after-stop");
    expect(shell.text).not.toContain("approval withdrawn");
    expect(asks).toHaveLength(2); expect(pi.state).toBe("idle");
  }
  // A turn's bounded early-abort cache must not fence the person's later idle shell.
  await post("/event", { type: "agent_start", generation: 2 });
  for (let i = 0; i < 65; i++) await post("/event", { type: "tool_abort", sessionId: "person-session", generation: 2, toolCallId: `early-${i}` });
  await post("/event", { type: "agent_settled", generation: 2 });
  const cleanAdmission = await (await post("/budget", { unit: "tool_calls", idleUserBash: true, generation: 2 })).json() as any;
  const afterOverflow = await (await post("/tool", { name: "bash", purpose: "idle_user_bash", sessionId: "person-session", generation: 2, reservation: cleanAdmission.reservation, toolCallId: "person-after-abort-overflow", args: { command: "printf cache-cleared; exit 7" } })).json() as any;
  expect(afterOverflow.exitCode).toBe(7); expect(afterOverflow.text).toContain("cache-cleared");
  expect(asks).toHaveLength(2);
  // A real claimed TUI owner is stopped on handover, and the replacement keeps the recorded session.
  const replacement = await console_.request({ t: "start", peer: "pi", args: { mode: "headless" } });
  expect(replacement.ok).toBe(true);
  expect(await owner.exited).not.toBeNull();
  expect(daemon.bus.peers.get("pi")!.recoveryMetadata!().sessionId).toBe("person-session");
  expect(readFileSync(join(stateDir, "hub.log"), "utf8")).toContain("stopped for a new Pi owner");
}, 30_000);


test("Pi approval expiry count resets on an answered denial and at the actual new turn", async () => {
  const h = await approvalPi(150);
  await h.event("agent_start", { generation: 1 });
  expect((await h.call("reset-expiry-one")).text).toContain("approval expired");
  const denied = h.call("reset-denial"), ask = await h.asked(2);
  expect((await h.console_.request({ t: "permit", id: ask.id, option: "deny", surface: "console" })).ok).toBe(true);
  expect((await denied).text).toContain("did not approve");
  expect((await h.call("reset-expiry-two")).text).toContain("approval expired");
  await h.event("agent_settled", { generation: 1 });
  await h.event("agent_start", { generation: 2 });
  expect((await h.call("new-turn-expiry")).text).toContain("approval expired");
  await h.event("agent_settled", { generation: 2 });
  expect(h.pi.state).toBe("idle");
  expect(readFileSync(join(h.dir, "hub.log"), "utf8")).not.toContain("turn stopped after two unanswered approvals");
}, 30_000);

test("a failed approval event audit neither strands the grant nor logs private arguments (#253)", async () => {
  const h = await approvalPi(10_000);
  await h.event("agent_start", { generation: 1 });
  const pending = h.post("/tool", { name: "write", toolCallId: "audit-failure", sessionId: h.pi.recoveryMetadata().sessionId, generation: 1, args: { path: "audit.txt", content: "PRIVATE_APPROVAL_PAYLOAD" } });
  const ask = await h.asked(1);
  const file = join(h.dir, "events.jsonl"), saved = file + ".saved";
  renameSync(file, saved); mkdirSync(file); // force telemetry append failure, without failing the authoritative stores
  try {
    expect((await h.console_.request({ t: "permit", id: ask.id, option: "allow", surface: "console" })).ok).toBe(true);
    const result = await (await pending).json() as any;
    expect(result.failed).toBe(false);
    expect(readFileSync(join(h.dir, "audit.txt"), "utf8")).toBe("PRIVATE_APPROVAL_PAYLOAD");
    const log = readFileSync(join(h.dir, "hub.log"), "utf8");
    expect(log).toContain("permission event recording failed at answered for pi");
    expect(log).not.toContain("PRIVATE_APPROVAL_PAYLOAD");
  } finally { rmSync(file, { recursive: true }); renameSync(saved, file); }
  await h.event("agent_settled", { generation: 1 });
}, 30_000);

test("a person answering one of several parallel Pi requests keeps their expiries from stopping the turn", async () => {
  const h = await approvalPi(400);
  await h.event("agent_start", { generation: 1 });
  const answered = h.call("parallel-answered"); const a = await h.asked(1);
  const first = h.call("parallel-expiry-one"); await h.asked(2);
  const second = h.call("parallel-expiry-two"); await h.asked(3);
  expect((await h.console_.request({ t: "permit", id: a.id, option: "allow", surface: "console" })).ok).toBe(true);
  expect((await answered).failed).toBe(false);
  expect(existsSync(join(h.dir, "parallel-answered.txt"))).toBe(true);
  // Both parallel expiries were pending while the person answered: neither counts toward the streak.
  expect((await first).text).toContain("approval expired");
  expect((await second).text).toContain("approval expired");
  const later = h.call("parallel-later"); const l = await h.asked(4);
  expect((await h.console_.request({ t: "permit", id: l.id, option: "deny", surface: "console" })).ok).toBe(true);
  expect((await later).text).toContain("did not approve");
  await h.event("agent_settled", { generation: 1 });
  expect(h.pi.state).toBe("idle");
  expect(readFileSync(join(h.dir, "hub.log"), "utf8")).not.toContain("turn stopped after two unanswered approvals");
}, 30_000);

test("an always-cache grant is not an answer: it does not reset the expiry streak", async () => {
  const h = await approvalPi(400);
  await h.event("agent_start", { generation: 1 });
  writeFileSync(join(h.dir, "streak-expiry-one.txt"), "a");
  writeFileSync(join(h.dir, "streak-expiry-two.txt"), "a");
  const seed = h.call("cache-seed"); const a = await h.asked(1);
  expect((await h.console_.request({ t: "permit", id: a.id, option: "always", surface: "console" })).ok).toBe(true);
  expect((await seed).failed).toBe(false);
  expect((await h.call("streak-expiry-one", "edit")).text).toContain("approval expired"); // streak 1
  const auto = await h.call("cache-auto"); // served from the always cache: no request, no answer, streak kept
  expect(auto.failed).toBe(false);
  expect(existsSync(join(h.dir, "cache-auto.txt"))).toBe(true);
  expect(h.asks).toHaveLength(2);
  expect((await h.call("streak-expiry-two", "edit")).text).toContain("approval expired"); // streak 2: stop
  for (let i = 0; i < 200 && h.pi.state !== "offline"; i++) await Bun.sleep(10);
  expect(h.pi.state).toBe("offline");
  expect(readFileSync(join(h.dir, "hub.log"), "utf8")).toContain("Pi turn stopped after two unanswered approvals");
}, 30_000);

test("an approval abort delayed until after settlement cannot tear down the idle Pi owner", async () => {
  const h = await approvalPi(40); // unsupported extension would otherwise tear down the owner
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const abortTurn = h.pi.endApprovalTurn.bind(h.pi);
  h.pi.endApprovalTurn = async (generation: number, reason: string) => { entered(); await delayed; return abortTurn(generation, reason); };
  try {
    await h.event("agent_start", { generation: 1 });
    await h.call("settled-delay-one"); await h.call("settled-delay-two");
    await started; // hold the delayed continuation while native settlement arrives
    await h.event("agent_settled", { generation: 1 });
    release();
    await Bun.sleep(60);
    expect(h.pi.state).toBe("idle");
    expect(h.pi.proc.exitCode).toBeNull();
    expect(readFileSync(join(h.dir, "hub.log"), "utf8")).not.toContain("approval turn abort unsupported");
  } finally { release(); }
}, 30_000);

test("a later Pi owner failure before agent_start never inherits a settled approval reason", async () => {
  const h = await approvalPi(40, true);
  const messages: string[] = [], failures: string[] = [];
  const publish = h.pi.onMessage;
  h.pi.onMessage = (text: string, opts: any) => { messages.push(text); return publish?.(text, opts); };
  h.pi.opts.onTurnFailure = async (_envs: unknown, reason: string) => { failures.push(reason); };
  await h.pi.deliver([newEnvelope("user", "first work", { to: ["pi"] })], "first-work");
  await h.event("agent_start", { generation: 1 });
  const pending = h.nextCommand();
  await h.call("stale-reason-one"); await h.call("stale-reason-two");
  const command = await pending;
  await h.post("/ack", { id: command.id, ok: true });
  await h.event("agent_end", { generation: 1, failed: true, error: command.reason });
  await h.event("agent_settled", { generation: 1 });
  expect(messages).toHaveLength(1); expect(messages[0]).toContain("two unanswered approvals");
  await h.pi.deliver([newEnvelope("user", "unrelated next work", { to: ["pi"] })], "unrelated-work");
  h.pi.proc.kill("SIGKILL"); // accepted next delivery, no native agent_start yet
  for (let i = 0; i < 200 && h.pi.state !== "offline"; i++) await Bun.sleep(10);
  expect(h.pi.state).toBe("offline"); expect(messages).toHaveLength(2);
  expect(messages[1]).toContain("Pi turn failed");
  expect(messages[1]).not.toContain("unanswered approvals");
  expect(failures).toHaveLength(1); expect(failures[0]).toContain("SIGKILL");
}, 30_000);

test("two expiries abort the Pi turn through the budget path when the extension supports it; Pi stays attached", async () => {
  const h = await approvalPi(400, true);
  const notices: { text: string; opts: any }[] = [], deliveries: any[] = [];
  const publish = h.pi.onMessage, settle = h.pi.onDelivery;
  h.pi.onMessage = (text: string, opts: any) => { notices.push({ text, opts }); return publish?.(text, opts); };
  h.pi.onDelivery = (event: any) => { deliveries.push(event); settle?.(event); };
  const envelope = newEnvelope("user", "run the approval turn", { to: ["pi"] });
  const ownerPid = h.pi.proc.pid;
  await h.pi.deliver([envelope], "approval-delivery");
  await h.event("agent_start", { generation: 1 });
  const pending = h.nextCommand();
  expect((await h.call("turn-abort-expiry-one")).text).toContain("approval expired");
  expect((await h.call("turn-abort-expiry-two")).text).toContain("approval expired");
  const command = await pending;
  expect(command).toMatchObject({ type: "abort_budget", generation: 1, cause: "approval" });
  expect(command.reason).toContain("no person answered");
  await h.post("/ack", { id: command.id, ok: true });
  await h.event("agent_end", { generation: 1, failed: true, error: command.reason });
  await h.event("agent_settled", { generation: 1 });
  for (let i = 0; i < 200 && h.pi.state !== "idle"; i++) await Bun.sleep(10);
  expect(h.pi.state).toBe("idle");
  expect(h.pi.state).not.toBe("offline");
  const log = readFileSync(join(h.dir, "hub.log"), "utf8");
  expect(log).toContain("Pi turn stopped after two unanswered approvals");
  expect(log).not.toContain("approval turn abort unsupported");
  expect(notices).toHaveLength(1);
  expect(notices[0]!.text).toContain("Pi turn stopped after two unanswered approvals");
  expect(notices[0]!.opts.to).toEqual(["user"]);
  expect(notices[0]!.opts.inReplyTo.id).toBe(envelope.id);
  expect(h.pi.proc.pid).toBe(ownerPid);
  expect(deliveries.some((event) => event.state === "completed")).toBe(true);
  // The next delivery runs normally on the same attached Pi.
  await h.pi.deliver([newEnvelope("user", "next turn", { to: ["pi"] })], "next-delivery");
  await h.event("agent_start", { generation: 2 });
  const again = h.call("turn-abort-next-turn"); const ask = await h.asked(3);
  expect((await h.console_.request({ t: "permit", id: ask.id, option: "allow", surface: "console" })).ok).toBe(true);
  expect((await again).failed).toBe(false);
  expect(existsSync(join(h.dir, "turn-abort-next-turn.txt"))).toBe(true);
  await h.event("agent_end", { generation: 2, text: "next turn complete" });
  await h.event("agent_settled", { generation: 2 });
  expect(notices[1]!.text).toBe("next turn complete");
  expect(h.pi.proc.pid).toBe(ownerPid);
}, 30_000);


test("a claimed headless owner cannot obtain or consume a person's idle TUI shell reservation", async () => {
  const h = await approvalPi(10_000);
  expect((await h.post("/budget", { unit: "tool_calls", idleUserBash: true, generation: 0 })).status).toBe(409);
  // Even a reservation previously recorded in memory cannot authorize another surface.
  h.pi.idleBashReservations.set("forged-headless", { generation: 0, expiresAt: Date.now() + 10_000 });
  const result = await h.post("/tool", { name: "bash", purpose: "idle_user_bash", sessionId: h.pi.recoveryMetadata().sessionId, generation: 0, reservation: "forged-headless", toolCallId: "headless-bypass", args: { command: "printf bad > forbidden.txt" } });
  expect(result.status).toBe(409);
  expect(existsSync(join(h.dir, "forbidden.txt"))).toBe(false);
}, 30_000);

test.skipIf(process.platform !== "darwin")("hub stop cancels and settles a claimed TUI person's running sandbox command", async () => {
  const config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enabled: true } };
  const h = await hub(config);
  const launch = (await h.console_.request({ t: "start", peer: "pi", args: { mode: "tui" } })).launch;
  const owner = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  cleanup.push(async () => { if (owner.exitCode === null) owner.kill(); await owner.exited; });
  const sessionDir = join(h.stateDir, "pi-sessions"); mkdirSync(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, "running-person.jsonl");
  writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "running-person", cwd: h.stateDir }) + "\n");
  const post = (path: string, body: unknown) => fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}${path}`, { method: "POST", headers: { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  await post("/event", { type: "session_start", ownerToken: launch.env.AGENTHUB_PI_OWNER_TOKEN, pid: owner.pid, signature: processSignature(owner.pid), sessionId: "running-person", sessionFile });
  const admission = await (await post("/budget", { unit: "tool_calls", idleUserBash: true, generation: 0 })).json() as any;
  const pending = post("/tool", { name: "bash", purpose: "idle_user_bash", sessionId: "running-person", generation: 0, reservation: admission.reservation, toolCallId: "long-person", args: { command: "printf started > started.txt; sleep 2; printf bad > after-stop.txt" } }).then((response) => response.json()).catch(() => undefined);
  for (let i = 0; i < 200 && !existsSync(join(h.stateDir, "started.txt")); i++) await Bun.sleep(10);
  expect(existsSync(join(h.stateDir, "started.txt"))).toBe(true);
  await h.daemon.stop();
  await pending;
  await Bun.sleep(2_100); // outlive the program's scheduled write, including after stop returned
  expect(existsSync(join(h.stateDir, "after-stop.txt"))).toBe(false);
}, 30_000);


test("a delayed aborted old-generation tool cannot be rebound after a new Pi turn starts", async () => {
  const h = await approvalPi(10_000);
  const sessionId = h.pi.recoveryMetadata().sessionId;
  await h.event("agent_start", { generation: 1 });
  await h.event("tool_abort", { generation: 1, toolCallId: "cross-turn" });
  await h.event("agent_start", { generation: 2 });
  const old = await h.post("/tool", { name: "write", sessionId, generation: 1, toolCallId: "cross-turn", args: { path: "old-effect.txt", content: "bad" } });
  expect(old.status).toBe(409);
  expect((await old.json() as any).text).toContain("lineage");
  const legacy = await h.post("/tool", { name: "write", toolCallId: "legacy", args: { path: "old-effect.txt", content: "bad" } });
  expect(legacy.status).toBe(409);
  expect((await legacy.json() as any).text).toContain("restart Pi");
  expect(h.asks).toHaveLength(0);
  expect(existsSync(join(h.dir, "old-effect.txt"))).toBe(false);
  const current = h.call("cross-turn"), ask = await h.asked(1);
  await h.event("tool_abort", { generation: 1, toolCallId: "cross-turn" });
  expect((await h.inspect()).pendingApprovals).toBe(1);
  expect((await h.console_.request({ t: "permit", id: ask.id, option: "allow", surface: "console" })).ok).toBe(true);
  expect((await current).text).toBe("wrote cross-turn.txt");
  expect(readFileSync(join(h.dir, "cross-turn.txt"), "utf8")).toBe("cross-turn");
  await h.event("agent_settled", { generation: 2 });
}, 30_000);


test("a normal approval cannot grant after the verified OS owner dies before exit notification", async () => {
  const h = await approvalPi(10_000);
  await h.event("agent_start", { generation: 1 });
  const pending = h.call("owner-died"), ask = await h.asked(1);
  const proc = h.pi.proc;
  const exits = proc.listeners("exit");
  proc.removeAllListeners("exit"); // hold the notification, preserving the real OS identity boundary
  try {
    process.kill(proc.pid, "SIGKILL");
    for (let i = 0; i < 200 && proc.exitCode === null && proc.signalCode === null; i++) await Bun.sleep(5);
    expect(proc.signalCode).toBe("SIGKILL");
    expect((await h.console_.request({ t: "permit", id: ask.id, option: "always", surface: "console" })).ok).toBe(true);
    expect((await pending).text).toContain("withdrawn");
    expect(existsSync(join(h.dir, "owner-died.txt"))).toBe(false);
  } finally {
    for (const listener of exits) listener.call(proc, proc.exitCode, proc.signalCode);
    await pending.catch(() => undefined);
  }
}, 30_000);
