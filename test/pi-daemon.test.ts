import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
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
const sessionFile = join(dir, "pi-session.jsonl");
writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "pi-session-1", cwd: process.cwd() }) + "\\n");
const out = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => { const m = JSON.parse(line); if (m.type === "get_state") out({ id: m.id, success: true, data: { sessionId: "pi-session-1", sessionFile } }); });
`);
  return file;
}

async function hub(config = DEFAULT_CONFIG) {
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-pi-daemon-"));
  const daemon = await startDaemon({ cwd: stateDir, permissionTimeoutMs: 20, projectId: "pi-project", instanceId: `pi-instance-${Math.random()}`, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...config, memory: { ...config.memory, enabled: false } } });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" });
  cleanup.push(() => console_.close());
  return { stateDir, daemon, console_ };
}

test("Pi is disabled by default and its peer identity remains reserved", async () => {
  const { stateDir, console_ } = await hub();
  expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless" } })).error).toContain("disabled");
  await expect(ControlClient.connect(stateDir, { role: "peer", peer: "pi" }, 200)).rejects.toThrow();
});

test("enabled Pi starts headless, duplicate start is idempotent, and handover preserves the saved session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-pi-fake-"));
  const config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, fakePi(dir)] } };
  const { daemon, console_ } = await hub(config);
  const first = await console_.request({ t: "start", peer: "pi", args: { mode: "headless", backend: "dgx" } });
  expect(first.ok).toBe(true);
  for (let i = 0; i < 100 && daemon.bus.stateOf("pi") !== "idle"; i++) await Bun.sleep(10);
  expect(daemon.bus.stateOf("pi")).toBe("idle");
  expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless" } })).already).toBe(true);
  const originalSession = daemon.bus.peers.get("pi")!.recoveryMetadata!().sessionId;
  expect((await console_.request({ t: "start", peer: "pi", args: { mode: "headless", backend: "mlx" } })).ok).toBe(true);
  expect(daemon.bus.peers.get("pi")!.recoveryMetadata!().sessionId).toBe(originalSession);
  expect((daemon.bus.peers.get("pi")!.recoveryMetadata!().launch as any).backend).toBe("mlx");
  const tui = await console_.request({ t: "start", peer: "pi", args: { mode: "tui", backend: "dgx" } });
  if (!tui.ok) throw new Error(String(tui.error));
  expect(tui.ok).toBe(true);
  expect(tui.launch?.args).toContain("--session");
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
