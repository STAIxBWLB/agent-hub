import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { writeSessions } from "../src/hub/crash.ts";
import { DEFAULT_CONFIG, startDaemon, type HubConfig } from "../src/hub/daemon.ts";
import { realPath } from "../src/hub/project.ts";
import { readRecoveryContinuity, writeRecoveryContinuity, type RecoveryContinuityBookmark } from "../src/hub/recovery-continuity.ts";
import type { TerminalOpener } from "../src/hub/terminal-open.ts";

const OP = "00000000-0000-4000-8000-000000000463";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(10);
  expect(check(), label).toBe(true);
}
function rig() {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-continuity-daemon-"))), stateDir = join(cwd, ".agenthub", "state");
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const sessionDir = join(stateDir, "pi-sessions"); mkdirSync(sessionDir, { mode: 0o700 });
  const sessionFile = join(sessionDir, "saved session's file.jsonl");
  writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "saved-pi-session", cwd }) + "\n", { mode: 0o600 });
  const bookmark: RecoveryContinuityBookmark = { schema: 1, operationId: OP, projectId: "continuity-fixture", projectRoot: cwd, at: 1000, pi: { sessionId: "saved-pi-session", sessionFile, backend: "dgx", model: "dgx/coding" } };
  const opened: string[][] = [];
  const opener: TerminalOpener = { available: () => ({ ok: true, via: "fixture" }), open: async (_title, argv) => { opened.push([...argv]); return { ok: true, via: "fixture" }; } };
  const start = async (mode: "headless" | "tui", overrides: Partial<HubConfig> = {}) => {
    const daemon = await startDaemon({ cwd, stateDir, projectId: bookmark.projectId, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, switchyardPort: 0, terminal: () => opener,
      config: { ...DEFAULT_CONFIG, roster: { claude: false, codex: false, kimi: false, qwen: false, jcode: false, local: false, pi: true }, batch_ms: 0,
        memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
        mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: true, backend: "dgx", cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts")] },
        peers: { pi: { start_mode: mode } }, ...overrides } });
    cleanup.push(() => daemon.stop());
    const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
    return { daemon, client };
  };
  const log = () => readFileSync(join(stateDir, "hub.log"), "utf8");
  return { cwd, stateDir, bookmark, opened, start, log, file: join(stateDir, "recovery-continuity.json") };
}

test("#463 pi.auto_start resumes the archived headless session and consumes only its authenticated identity", async () => {
  const f = rig(); writeRecoveryContinuity(f.stateDir, f.bookmark);
  const { daemon } = await f.start("headless");
  await until(() => daemon.bus.peers.get("pi")?.state === "idle", "Pi attached to its recorded session");
  expect(daemon.bus.peers.get("pi")!.recoveryMetadata!()).toMatchObject({ sessionId: f.bookmark.pi.sessionId, sessionFile: f.bookmark.pi.sessionFile });
  expect(readRecoveryContinuity(f.stateDir, { projectId: f.bookmark.projectId, projectRoot: f.cwd })).toEqual({ state: "absent" });
  expect(f.opened).toEqual([]);
});

test("#463 pi.auto_start opens the configured TUI with fixed recorded resume arguments but retains an unclaimed bookmark", async () => {
  const f = rig(); writeRecoveryContinuity(f.stateDir, f.bookmark);
  const { daemon } = await f.start("tui");
  await until(() => f.opened.length === 1, "recorded Pi terminal opened");
  expect(f.opened[0]).toEqual([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "--project", f.cwd, "pi", "--mode", "tui", "--session-id", f.bookmark.pi.sessionId, "--session-file", f.bookmark.pi.sessionFile!, "--backend", "dgx", "--model", "dgx/coding"]);
  expect(daemon.bus.peers.has("pi")).toBe(false);
  expect(existsSync(f.file)).toBe(true);
});

for (const wrong of ["malformed", "project"] as const) test(`#463 ${wrong} continuity evidence holds pi.auto_start instead of opening a fresh terminal`, async () => {
  const f = rig();
  if (wrong === "malformed") writeFileSync(f.file, "{", { mode: 0o600 });
  else writeRecoveryContinuity(f.stateDir, { ...f.bookmark, projectId: "another-project" });
  const { daemon } = await f.start("tui");
  await until(() => f.log().includes("pi.auto_start"), "continuity refusal reported");
  expect(f.opened).toEqual([]);
  expect(daemon.bus.peers.has("pi")).toBe(false);
  expect(existsSync(f.file)).toBe(true);
});

test("#463 failed archived-session attachment retains its bookmark and never falls back fresh", async () => {
  const f = rig(); writeRecoveryContinuity(f.stateDir, { ...f.bookmark, pi: { ...f.bookmark.pi, sessionId: "different-recorded-session" } });
  const { daemon } = await f.start("headless");
  await until(() => f.log().includes("pi.auto_start did not start Pi:") || f.log().includes("Pi auto-start failed:"), "exact session refusal reported");
  expect(daemon.bus.peers.get("pi")?.state ?? "offline").toBe("offline");
  expect(existsSync(f.file)).toBe(true);
  expect(f.log()).not.toContain("started a fresh session");
});

test("#463 pending continuity prevents crash recovery from replacing the archived session with a fresh Pi", async () => {
  const f = rig(); writeFileSync(f.file, "{", { mode: 0o600 });
  writeSessions(f.stateDir, { instanceId: "prior-instance", at: 500, peers: [{ peer: "pi", meta: { sessionId: "old-crash-session", sessionFile: join(f.cwd, "missing-crash-session.jsonl"), launch: { kind: "pi", mode: "headless", backend: "dgx" } } }] });
  const { daemon } = await f.start("tui");
  await until(() => f.log().includes("crash recovery:"), "crash receipt observed");
  await until(() => f.log().includes("continuity"), "continuity fence reported");
  expect(daemon.bus.peers.has("pi")).toBe(false);
  expect(f.opened).toEqual([]);
  expect(f.log()).not.toContain("started a fresh session");
  expect(existsSync(f.file)).toBe(true);
});

test("#463 pi.auto_start off leaves continuity evidence untouched", async () => {
  const f = rig(); writeRecoveryContinuity(f.stateDir, f.bookmark);
  const { daemon, client } = await f.start("tui", { pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: false } });
  const status = await client.request({ t: "status" });
  expect(status.t).toBe("status"); expect(status.status.stopping).toBe(false);
  expect(f.opened).toEqual([]); expect(daemon.bus.peers.has("pi")).toBe(false); expect(existsSync(f.file)).toBe(true);
});

test("#463 an off-roster Pi leaves continuity evidence untouched", async () => {
  const f = rig(); writeRecoveryContinuity(f.stateDir, f.bookmark);
  const { daemon, client } = await f.start("tui", { roster: { claude: false, codex: false, kimi: false, qwen: false, jcode: false, local: false, pi: false } });
  const status = await client.request({ t: "status" });
  expect(status.t).toBe("status"); expect(status.status.stopping).toBe(false);
  expect(f.opened).toEqual([]); expect(daemon.bus.peers.has("pi")).toBe(false); expect(existsSync(f.file)).toBe(true);
});
