import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { projectConsole, type Lifecycle } from "../src/hub/manager.ts";
import { Registry } from "../src/hub/registry.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";
import type { TerminalOpener } from "../src/hub/terminal-open.ts";
import { startProjectAgents } from "../src/cli/start-agents-run.ts";

// #608 (agent-hub#1040): `ahub up` starts the default agent set through the console peer_start. The real CLI runs in a child
// process against the daemon it starts itself; a `terminal.open` command that appends its command line to a file is the
// recording terminal provider, so what the hub asked a terminal to run is observed, not assumed.
const CLI = realpathSync(join(import.meta.dir, "..", "src", "cli", "main.ts"));
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
class FixturePeer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envelopes: Envelope[]) { /* attached, takes nothing */ }
}

/** The person's own shell: no agent marker, no Orca, a hub home of this test's own. */
function personEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/^(AGENTHUB_|CLAUDE|CODEX|ORCA_|KIMI|QWEN|JCODE|PI_|OMNIROUTE)/.test(key)) env[key] = value;
  return { ...env, AGENTHUB_HOME: home, ...extra };
}
async function ahub(root: string, home: string, args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], { cwd: root, env: personEnv(home, extra), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 60_000);
  try {
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}
/** A git project whose config.local.json holds `local`, with a recording terminal.open unless `terminal` is false. */
async function project(local: Record<string, unknown> = {}, terminal = true) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ahub-up-agents-"))), root = join(base, "p"), home = join(base, "home"), record = join(base, "terminal.log");
  mkdirSync(root); mkdirSync(home);
  Bun.spawnSync(["git", "-C", root, "init", "-q"]);
  expect((await ahub(root, home, ["init"])).code).toBe(0);
  writeFileSync(join(root, ".agenthub", "config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false } }));
  writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify({ ...(terminal ? { terminal: { open: ["/bin/sh", "-c", `printf '%s\\n' "$1" >> '${record}'`, "sh", "{command}"] } } : {}), ...local }));
  const stop = async () => {
    const killed = await ahub(root, home, ["kill"]);
    if (killed.code !== 0) { const registry = new Registry(join(home, "registry.db")); try { const row = registry.list().find(p => p.root === root); if (row?.pid) process.kill(row.pid, "SIGTERM"); } catch { /* gone */ } finally { registry.close(); } }
    rmSync(base, { recursive: true, force: true });
  };
  cleanup.push(stop);
  const opened = () => existsSync(record) ? readFileSync(record, "utf8").split("\n").filter(Boolean) : [];
  /** The words of one recorded command line, unquoted: the hub shell-quotes each word it asks a terminal to run. */
  const words = (line: string) => line.split(/\s+/).map(word => word.replace(/^'(.*)'$/, "$1"));
  return { root, home, base, opened, words, stateDir: join(root, ".agenthub", "state") };
}
const lines = (out: string) => out.split("\n").filter(line => /^[a-z]+: /.test(line));

test("AC1: with no setting, ahub up starts claude and codex through hubStart, one line each, and a terminal is asked to run each peer's start words", async () => {
  const p = await project();
  const up = await ahub(p.root, p.home, ["up"]);
  expect(up.code, up.stderr).toBe(0);
  const printed = lines(up.stdout);
  expect(printed).toHaveLength(2);
  expect(printed[0]).toMatch(/^claude: started tui \(terminal\.open\)/); expect(printed[1]).toMatch(/^codex: started tui \(terminal\.open\)/);
  const asked = p.opened();
  expect(asked).toHaveLength(2);
  // Both are asked at once, so the order of the two terminals is not fixed; each runs the hub's own entry with this project and the peer's start word.
  expect(asked.map(line => p.words(line)[4]).sort()).toEqual(["claude", "codex"]);
  for (const line of asked) { expect(p.words(line).slice(2, 4)).toEqual(["--project", p.root]); expect(line).not.toContain("headless"); }
}, 90_000);

test("AC2: start.agents chooses exactly that list, an empty list starts none, and --no-agents skips the set for one run", async () => {
  const p = await project({ start: { agents: ["kimi"] } });
  const up = await ahub(p.root, p.home, ["up"]);
  expect(up.code, up.stderr).toBe(0);
  expect(lines(up.stdout)).toHaveLength(1); expect(lines(up.stdout)[0]).toMatch(/^kimi: /);
  expect(p.opened()).toHaveLength(1); expect(p.words(p.opened()[0]!).slice(4)).toEqual(["kimi", "--mode", "tui"]);
  expect(p.opened().join("\n")).not.toMatch(/\bclaude\b|\bcodex\b/);
  const none = await project({ start: { agents: [] } });
  const upNone = await ahub(none.root, none.home, ["up"]);
  expect(upNone.code, upNone.stderr).toBe(0); expect(lines(upNone.stdout)).toEqual([]); expect(none.opened()).toEqual([]);
  const skipped = await project();
  const upSkipped = await ahub(skipped.root, skipped.home, ["up", "--no-agents"]);
  expect(upSkipped.code, upSkipped.stderr).toBe(0); expect(lines(upSkipped.stdout)).toEqual([]); expect(skipped.opened()).toEqual([]);
  expect(upSkipped.stdout).toContain("ahub up (ws://127.0.0.1:");                       // the hub itself came up
}, 120_000);

test("AC5: with no terminal provider, ahub up keeps the hub running and names the refusal and the manual command for each agent; nothing falls back to headless", async () => {
  const p = await project({}, false);
  const up = await ahub(p.root, p.home, ["up"]);
  expect(up.code, up.stderr).toBe(0);
  const printed = lines(up.stdout);
  expect(printed).toHaveLength(2);
  expect(printed[0]).toContain("claude: not started: claude starts in its TUI and the hub could not open a terminal for it");
  expect(printed[0]).toContain("Run ahub claude in a terminal");
  expect(printed[1]).toContain("codex: not started: codex starts in its TUI");
  expect(printed[1]).toContain("Run ahub codex in a terminal");
  const client = await ControlClient.connect(p.stateDir, { role: "console" });
  try {
    const status = (await client.request({ t: "status" })).status;
    expect(status.stopping).toBeFalsy();                                                  // the hub is up
    for (const peer of ["claude", "codex"]) expect(["offline", undefined]).toContain(status.peers?.[peer]?.state);   // and no headless peer was made
  } finally { client.close(); }
}, 90_000);

test("AC6: an upgrade or recovery relaunch of ahub up starts no agent from the set", async () => {
  const relaunch = await project();
  const up = await ahub(relaunch.root, relaunch.home, ["up"], { AGENTHUB_RECOVERY_OPERATION: "op-608-relaunch" });
  expect(up.code, up.stderr).toBe(0);
  expect(lines(up.stdout)).toEqual([]); expect(relaunch.opened()).toEqual([]);
  expect(up.stdout).toContain("ahub up (ws://127.0.0.1:");
}, 120_000);

test("AC1: a second start answers already for the attached agents, and a daemon restart or a config reload starts none from the set", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ahub-up-agents-daemon-"))), cwd = join(base, "p"), stateDir = join(cwd, ".agenthub", "state");
  mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  writeFileSync(join(cwd, ".agenthub", "config.json"), JSON.stringify({ memory: { enabled: false } }));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const opened: string[][] = [];
  const opener: TerminalOpener = { available: () => ({ ok: true, via: "recording" }), open: async (_title, argv) => { opened.push([...argv]); return { ok: true, via: "recording" }; } };
  const boot = () => startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, terminal: () => opener, configWatch: false,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } });
  const daemon = await boot();
  cleanup.push(() => daemon.stop());
  const project = { root: cwd, stateDir };
  const first = await startProjectAgents(project, ["claude", "codex"]);
  expect(first.map(line => line.split(":")[0])).toEqual(["claude", "codex"]);
  expect(first.every(line => line.includes(": started tui (recording)"))).toBe(true);
  expect(opened.map(argv => argv.at(-1))).toEqual(["claude", "codex"]);
  // the two TUIs attach; a second ahub up now finds them already attached and opens nothing
  for (const id of ["claude", "codex"]) { const peer = new FixturePeer(id); daemon.bus.add(peer); await peer.start(); }
  expect(await startProjectAgents(project, ["claude", "codex"])).toEqual(["claude: already attached", "codex: already attached"]);
  expect(opened).toHaveLength(2);
  // a refusal for one agent never stops the others
  const mixed = await startProjectAgents(project, ["pi", "codex"]);
  expect(mixed[0]).toMatch(/^pi: not started: /); expect(mixed[1]).toBe("codex: already attached");
  // a config reload and a daemon restart start nothing: the hub never reads the set
  const client = await ControlClient.connect(stateDir, { role: "console" });
  try { await client.request({ t: "settings_reload" }, 10_000); } finally { client.close(); }
  await Bun.sleep(200);
  expect(opened).toHaveLength(2);
  await daemon.stop();
  const again = await boot();
  cleanup.push(() => again.stop());
  await Bun.sleep(300);
  expect(opened).toHaveLength(2);
}, 60_000);

test("the dashboard manager's start counts as the person's ahub up: the set starts after the hub is ready, and a failing start of the set never fails the start", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ahub-manager-agents-"))), home = join(base, "home"), root = join(base, "p");
  mkdirSync(home); mkdirSync(root, { recursive: true });
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const registry = new Registry(join(home, "registry.db")); cleanup.push(() => registry.close());
  const project = registry.register(root);
  const events: string[] = [];
  const lifecycle: Lifecycle = { inspectProject: async () => ({ state: "stopped" }) as never, stopProject: async () => {},
    startProject: async () => { events.push("hub ready"); return { instanceId: "inst-1", controlPort: 1 }; } };
  let fail = false;
  const { act } = projectConsole({ registry, lifecycle, home, afterStart: async started => { events.push(`agents for ${started.root}`); if (fail) throw new Error("terminal provider broke"); return []; } });
  expect(await act({ action: "start", projectId: project.id })).toEqual({ ok: true, projectId: project.id, instanceId: "inst-1" });
  await Bun.sleep(20);
  expect(events).toEqual(["hub ready", `agents for ${project.root}`]);                   // after the hub, never before
  fail = true;
  expect((await act({ action: "start", projectId: project.id })).ok).toBe(true);
  await Bun.sleep(20);
  expect(events).toHaveLength(4);
  const plain = projectConsole({ registry, lifecycle, home });                             // no hook: the start is the hub's alone
  events.length = 0;
  expect((await plain.act({ action: "start", projectId: project.id })).ok).toBe(true);
  expect(events).toEqual(["hub ready"]);
});

test("an agent's ahub up is refused by the CLI before it starts anything, and --live-test (an agent borrowing console authority) starts no agent from the set", async () => {
  const agent = await project();
  const asAgent = await ahub(agent.root, agent.home, ["up"], { AGENTHUB_PEER_ID: "codex" });
  expect(asAgent.code).toBe(1); expect(asAgent.stderr).toContain("codex cannot run ahub up"); expect(asAgent.stdout).toBe("");
  expect(agent.opened()).toEqual([]);
  const delegated = await project();
  const live = await ahub(delegated.root, delegated.home, ["--live-test", "up"], { AGENTHUB_PEER_ID: "codex" });
  expect(lines(live.stdout)).toEqual([]); expect(delegated.opened()).toEqual([]);          // delegated live tests never open the person's terminals from the set
}, 120_000);

test("review P2: a live-test dashboard session's start never opens the default agents, and the lines and failures of an ordinary session's start reach manager.log", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ahub-manager-review-"))), home = join(base, "home"), root = join(base, "p");
  mkdirSync(home); mkdirSync(root, { recursive: true });
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const registry = new Registry(join(home, "registry.db")); cleanup.push(() => registry.close());
  const project = registry.register(root);
  const lifecycle: Lifecycle = { inspectProject: async () => ({ state: "stopped" }) as never, stopProject: async () => {}, startProject: async () => ({ instanceId: "inst-1", controlPort: 1 }) };
  const asked: string[] = [];
  let outcome: "lines" | "throws" = "lines";
  const { act } = projectConsole({ registry, lifecycle, home, afterStart: async started => {
    asked.push(started.id);
    if (outcome === "throws") throw new Error("terminal provider broke\nsecond line");
    return ["claude: not started: no terminal.open command is configured. Run ahub claude in a terminal", "codex: already attached"];
  } });
  const written: string[] = [], original = console.error;
  console.error = (...args: unknown[]) => { written.push(args.join(" ")); };
  try {
    // the session, not the manager process, carries the live-test flag: an agent's `ahub --live-test ui` opens one
    expect((await act({ action: "start", projectId: project.id }, { liveTest: true })).ok).toBe(true);
    await Bun.sleep(30);
    expect(asked).toEqual([]); expect(written).toEqual([]);
    expect((await act({ action: "start", projectId: project.id }, {})).ok).toBe(true);
    await Bun.sleep(30);
    expect(asked).toEqual([project.id]);
    expect(written).toHaveLength(2);
    expect(written[0]).toContain(`default agents for ${project.id}: claude: not started: no terminal.open command is configured. Run ahub claude in a terminal`);
    expect(written[1]).toContain("codex: already attached");
    outcome = "throws"; written.length = 0;
    expect((await act({ action: "start", projectId: project.id })).ok).toBe(true);        // a failing hook never fails the start
    await Bun.sleep(30);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("not started: terminal provider broke second line");
    expect(written[0]).not.toContain("\n");                                                 // one log line, whatever the text held
  } finally { console.error = original; }
});
