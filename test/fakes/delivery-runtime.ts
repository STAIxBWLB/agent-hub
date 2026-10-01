import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient } from "../../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../../src/hub/daemon.ts";

const value = (name: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1]! : "";
};

const stateDir = value("--state-dir");
const cwd = value("--cwd");
const projectId = value("--project-id");
const marker = value("--marker");
const noPeer = process.argv.includes("--no-peer");
// issue #37: a Kimi peer (the fake ACP agent) and crash recovery that resumes it
const withKimi = process.argv.includes("--kimi");
const autoResume = process.argv.includes("--auto-resume");
// issue #68: a headless Pi (the fake RPC agent), so a crash leaves its session file in the record; `--pi-enabled`
// only enables it, for the run after a crash, where recovery starts it
const startPi = process.argv.includes("--pi");
const withPi = startPi || process.argv.includes("--pi-enabled");
if (!stateDir || !cwd || !projectId || !marker) throw new Error("delivery runtime needs --state-dir, --cwd, --project-id and --marker");

mkdirSync(stateDir, { recursive: true });
const append = (event: Record<string, unknown>) => {
  const line = `${JSON.stringify({ at: Date.now(), pid: process.pid, ...event })}\n`;
  const old = (() => { try { return readFileSync(marker, "utf8"); } catch { return ""; } })();
  writeFileSync(marker, `${old}${line}`);
};

// The signal handlers come first: crash recovery reports from inside startDaemon, and a test that stops the hub on
// that report must not find the default action (an exit that skips the clean stop) still in place (issue #80).
let peer: ControlClient | undefined;
const started = startDaemon({
  cwd,
  stateDir,
  projectId,
  controlPort: 0,
  codexAppPort: 0,
  codexProxyPort: 0,
  config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: withPi, auto_start: false, cmd: [process.execPath, join(import.meta.dir, "pi-rpc.ts")] }, batch_ms: 15_000, kimi_cmd: ["bun", join(import.meta.dir, "acp-server.ts"), "--record-load", join(stateDir, "acp-load.txt")], recovery: { auto_resume_after_crash: autoResume } },
});
const stop = async () => {
  peer?.close();
  await (await started).stop();
};
process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));
process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
const daemon = await started;
append({ type: "daemon-ready", pid: process.pid, port: daemon.port });
if (startPi) {
  const console_ = await ControlClient.connect(stateDir, { role: "console", projectId, projectRoot: cwd });
  const started = await console_.request({ t: "start", peer: "pi", args: { mode: "headless" } });
  console_.close();
  append({ type: "pi-started", ok: started.ok, error: started.error });
}
if (withKimi) {
  const console_ = await ControlClient.connect(stateDir, { role: "console", projectId, projectRoot: cwd });
  const started = await console_.request({ t: "start", peer: "kimi" });
  console_.close();
  append({ type: "kimi-started", ok: started.ok });
}

if (!noPeer) {
  peer = await ControlClient.connect(stateDir, { role: "peer", peer: "claude", projectId, projectRoot: cwd });
  peer.onPush = (msg) => {
    if (msg.t !== "deliver" || !Array.isArray(msg.envs)) return;
    const ids = msg.envs.map((env: { id: string }) => env.id);
    append({ type: "deliver", deliveryId: msg.deliveryId, ids, envs: msg.envs });
    // This peer deliberately does not acknowledge deliveries. The crash tests kill this
    // disposable process at the handoff boundary to exercise journal recovery.
  };
  append({ type: "peer-ready", peer: "claude" });
}

await new Promise<void>(() => {});
