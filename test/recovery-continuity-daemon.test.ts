import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { ControlClient } from "../src/hub/control-client.ts";
import { readSessions, writeSessions } from "../src/hub/crash.ts";
import { DEFAULT_CONFIG, startDaemon, type HubConfig } from "../src/hub/daemon.ts";
import { realPath } from "../src/hub/project.ts";
import { readRecoveryContinuity, writeRecoveryContinuity, type RecoveryContinuityBookmark } from "../src/hub/recovery-continuity.ts";
import type { TerminalOpener } from "../src/hub/terminal-open.ts";

const OP = "00000000-0000-4000-8000-000000000463";
function parsePiFlags(args: string[]): Record<string, unknown> {
  // ponytail: main.ts dispatches when imported. Keep its real pure parser until the CLI extracts a parser module.
  const source = readFileSync(new URL("../src/cli/main.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const parser = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "piFlags");
  expect(parser).toBeDefined();
  const js = ts.transpileModule(parser!.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  return runInNewContext(`${js}; piFlags();`, { args: [...args], fail: (message: string) => { throw new Error(message); } });
}
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
  expect(f.opened[0]).toEqual([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "--project", f.cwd, "pi", "--mode", "tui", "--session-file", f.bookmark.pi.sessionFile!, "--backend", "dgx", "--model", "dgx/coding"]);
  expect(daemon.bus.peers.has("pi")).toBe(false);
  expect(existsSync(f.file)).toBe(true);
});

test("#463 the actual Pi CLI parser accepts the exact continuity TUI command", async () => {
  const f = rig(); writeRecoveryContinuity(f.stateDir, f.bookmark);
  await f.start("tui");
  await until(() => f.opened.length === 1, "recorded terminal command captured");
  expect(parsePiFlags(f.opened[0]!.slice(5))).toEqual({ mode: "tui", sessionFile: f.bookmark.pi.sessionFile, backend: "dgx", model: "dgx/coding" });
  expect(() => parsePiFlags(["--mode", "tui", "--session-id", "one", "--session-file", "/fixture/one.jsonl"])).toThrow("usage: ahub pi");
  expect(existsSync(f.file)).toBe(true);
});

for (const wrong of ["malformed", "project"] as const) test(`#463 ${wrong} continuity evidence holds pi.auto_start instead of opening a fresh terminal`, async () => {
  const f = rig();
  if (wrong === "malformed") writeFileSync(f.file, "{", { mode: 0o600 });
  else writeRecoveryContinuity(f.stateDir, { ...f.bookmark, projectId: "another-project" });
  const { daemon } = await f.start("tui");
  await until(() => f.log().includes("pi.auto_start"), "continuity refusal reported");
  expect(f.log()).toContain("mv");
  expect(f.log()).toContain(f.file);
  expect(f.opened).toEqual([]);
  expect(daemon.bus.peers.has("pi")).toBe(false);
  expect(existsSync(f.file)).toBe(true);
});

test("#463 a proven mismatching archived-session header is retired without falling back fresh", async () => {
  const f = rig(); writeRecoveryContinuity(f.stateDir, { ...f.bookmark, pi: { ...f.bookmark.pi, sessionId: "different-recorded-session" } });
  const { daemon } = await f.start("headless");
  await until(() => f.log().includes("pi.auto_start did not start Pi:") || f.log().includes("Pi auto-start failed:"), "exact session refusal reported");
  expect(daemon.bus.peers.get("pi")?.state ?? "offline").toBe("offline");
  expect(existsSync(f.file)).toBe(false);
  const archive = readdirSync(f.stateDir).find(name => name.startsWith("recovery-continuity.retired.resume_unavailable."));
  expect(archive).toBeDefined();
  expect(JSON.parse(readFileSync(join(f.stateDir, archive!), "utf8")).pi.sessionId).toBe("different-recorded-session");
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

test("#463 a different authenticated Pi retires old continuity only after recording the current crash session", async () => {
  const f = rig(); writeRecoveryContinuity(f.stateDir, f.bookmark);
  const currentFile = join(f.stateDir, "pi-sessions", "current.jsonl");
  writeFileSync(currentFile, JSON.stringify({ type: "session", id: "current-pi-session", cwd: f.cwd }) + "\n");
  const { daemon, client } = await f.start("headless", { pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: false, backend: "dgx", cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts")] } });
  const started = await client.request({ t: "start", peer: "pi", args: { mode: "headless", backend: "dgx", sessionId: "current-pi-session", sessionFile: currentFile } });
  expect(started.ok).toBe(true);
  await until(() => daemon.bus.peers.get("pi")?.state === "idle", "current Pi authenticated");
  expect(readSessions(f.stateDir)?.peers.find(peer => peer.peer === "pi")?.meta.sessionId).toBe("current-pi-session");
  expect(existsSync(f.file)).toBe(false);
  const archive = readdirSync(f.stateDir).find(name => name.startsWith("recovery-continuity.retired.authenticated_session_changed."));
  expect(archive).toBeDefined();
  expect(JSON.parse(readFileSync(join(f.stateDir, archive!), "utf8")).pi.sessionId).toBe(f.bookmark.pi.sessionId);
});

for (const mode of ["headless", "tui"] as const) test(`#463 missing archived session retires continuity after the ${mode} auto-start decision without a fresh replacement`, async () => {
  const f = rig(); writeRecoveryContinuity(f.stateDir, f.bookmark); rmSync(f.bookmark.pi.sessionFile!);
  const { daemon } = await f.start(mode);
  await until(() => f.log().includes("pi.auto_start") || f.log().includes("Pi auto-start failed:"), "unresumable decision reported");
  expect(existsSync(f.file)).toBe(false);
  expect(readdirSync(f.stateDir).some(name => name.startsWith("recovery-continuity.retired.resume_unavailable."))).toBe(true);
  expect(daemon.bus.peers.get("pi")?.state ?? "offline").toBe("offline");
  expect(f.opened).toEqual([]);
  expect(f.log()).toContain("ahub pi");
  expect(f.log()).not.toContain("started a fresh session");
});

test("#463 uncertain session storage failure retains continuity and never starts a fresh TUI", async () => {
  const f = rig(); writeRecoveryContinuity(f.stateDir, f.bookmark); rmSync(f.bookmark.pi.sessionFile!); mkdirSync(f.bookmark.pi.sessionFile!);
  const { daemon } = await f.start("tui");
  await until(() => f.log().includes("pi.auto_start") || f.log().includes("Pi auto-start failed:"), "uncertain failure reported");
  expect(existsSync(f.file)).toBe(true);
  expect(readdirSync(f.stateDir).some(name => name.startsWith("recovery-continuity.retired."))).toBe(false);
  expect(daemon.bus.peers.has("pi")).toBe(false); expect(f.opened).toEqual([]);
});

test("#463 an unconfirmed ID-only resume retains evidence and prints an exact manual archive command", async () => {
  const f = rig();
  writeRecoveryContinuity(f.stateDir, { ...f.bookmark, pi: { sessionId: "unconfirmed-recorded-id", backend: "dgx" } });
  const { daemon } = await f.start("headless", { pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: true, backend: "dgx", cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts"), "--session-id", "different-fixture-owner"] } });
  await until(() => f.log().includes("Pi auto-start failed") || f.log().includes("pi.auto_start did not start"), "unconfirmed native resume reported");
  expect(daemon.bus.peers.get("pi")?.state ?? "offline").toBe("offline");
  expect(existsSync(f.file)).toBe(true);
  expect(f.log()).toContain("mv"); expect(f.log()).toContain(f.file);
  expect(f.log()).not.toContain("started a fresh session");
});
