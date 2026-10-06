import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, realpathSync } from "node:fs";
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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[process.argv.indexOf("--session-dir") + 1];
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "model-descriptors.json"), process.env.AGENTHUB_PI_MODELS ?? "[]");
const sessionFile = join(dir, "pi-session.jsonl");
writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "pi-session-1", cwd: process.cwd() }) + "\\n");
const out = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => { const m = JSON.parse(line); if (m.type === "get_state") out({ id: m.id, success: true, data: { sessionId: "pi-session-1", sessionFile } }); });
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

test("Pi tools use hub path guards and approval denial, with persisted call receipts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-pi-permit-"));
  const config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, fakePi(dir)] } };
  const { stateDir, daemon, console_ } = await hub(config);
  expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless" } })).ok).toBe(true);
  writeFileSync(join(stateDir, "sample.txt"), "managed read");
  writeFileSync(join(stateDir, ".env"), "SECRET_MARKER");
  const launch = (daemon.bus.peers.get("pi") as any).tuiLaunch;
  const call = async (name: string, args: unknown, toolCallId: string) => (await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/tool`, {
    method: "POST", headers: { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ name, args, toolCallId }),
  })).json() as Promise<{text: string}>;
  expect((await call("read", { path: "sample.txt" }, "read1")).text).toContain("managed read");
  const blocked = await call("read", { path: ".env" }, "read2");
  expect(blocked.text).toContain("denylist");
  expect(blocked.text).not.toContain("SECRET_MARKER");
  expect((await call("write", { path: "output.txt", content: "denied" }, "write1")).text).toContain("did not approve");
  expect(existsSync(join(stateDir, "output.txt"))).toBe(false);
  expect((await call("write", { path: "different.txt", content: "denied" }, "write1")).text).toContain("different arguments");
});

test.skipIf(process.platform !== "darwin")("idle Pi user_bash keeps the managed route without opt-in budgets and charges only run scope when enabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-pi-user-bash-"));
  const config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, fakePi(dir)] } };
  const { stateDir, daemon, console_ } = await hub(config, true);
  expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless" } })).ok).toBe(true);
  for (let i = 0; i < 100 && daemon.bus.stateOf("pi") !== "idle"; i++) await Bun.sleep(10);
  const peer = daemon.bus.peers.get("pi") as any;
  const launch = peer.tuiLaunch;
  const metadata = peer.recoveryMetadata();
  const base = launch.env.AGENTHUB_PI_BRIDGE_URL;
  const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
  const generation = 0;
  const session = await fetch(`${base}/event`, { method: "POST", headers, body: JSON.stringify({ type: "session_start", ownerToken: launch.env.AGENTHUB_PI_OWNER_TOKEN, pid: process.pid, signature: processSignature(process.pid), sessionId: metadata.sessionId, sessionFile: metadata.sessionFile }) });
  expect(session.status).toBe(200);
  const budget = async () => fetch(`${base}/budget`, { method: "POST", headers, body: JSON.stringify({ unit: "tool_calls", idleUserBash: true, generation }) });
  const tool = async (name: string, reservation: string) => fetch(`${base}/tool`, { method: "POST", headers, body: JSON.stringify({ name: "bash", purpose: "idle_user_bash", generation, reservation, toolCallId: `user-bash-${name}`, args: { command: `printf managed > ${name}`, cwd: stateDir } }) });

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
});

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
async function crashedHub(piConfig: Partial<typeof DEFAULT_CONFIG.pi>, session: (stateDir: string) => string | undefined, recovery = DEFAULT_CONFIG.recovery, launch: Record<string, unknown> = { mode: "headless", backend: "dgx" }, extra: unknown[] = []) {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-pi-crash-")));
  mkdirSync(join(stateDir, "pi-sessions"), { recursive: true });
  const sessionFile = session(stateDir);
  // What a run that died left behind: a session record of another instance, with Pi on that session file.
  writeFileSync(join(stateDir, "sessions.json"), JSON.stringify({ instanceId: "crashed", at: Date.now(), peers: [...extra, { peer: "pi", meta: { launch: { kind: "pi", ...launch }, ...(sessionFile ? { sessionFile } : {}) } }] }));
  const config = { ...DEFAULT_CONFIG, recovery, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts")], ...piConfig }, memory: { ...DEFAULT_CONFIG.memory, enabled: false } };
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

test("after a crash, a terminal Pi is reported with its command, and pi.auto_start starts a fresh headless one on the recorded model", async () => {
  const { daemon, crash } = await crashedHub({ auto_start: true }, recorded, DEFAULT_CONFIG.recovery, { mode: "tui", backend: "dgx", model: "dgx/fast" });
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
    body: JSON.stringify({ name, args, toolCallId }),
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
