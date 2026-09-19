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
