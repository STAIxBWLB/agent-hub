import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { shellQuote } from "../src/cli/terminal-recovery.ts";
import { personEnv } from "../src/hub/child-process.ts";
import { MACHINE_LOCAL } from "../src/hub/config-trust.ts";
import { ControlClient, PROTOCOL } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, loadConfig, startDaemon, type HubConfig } from "../src/hub/daemon.ts";
import { peerStartConfig, startModeOf, terminalTemplate } from "../src/hub/start-mode.ts";
import { terminalOpener, type TerminalOpener } from "../src/hub/terminal-open.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const until = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(10); expect(check()).toBe(true); };
const MAIN = realpathSync(join(import.meta.dir, "../src/cli/main.ts"));
const PI = [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts")];

/** A terminal provider that records what it was asked to run and opens nothing. `script` answers each open in turn. */
function provider(present = true, script: (() => Promise<{ ok: true; via: string } | { ok: false; why: string; detail?: string }>)[] = []) {
  const opened: { title: string; argv: string[] }[] = [];
  const answer = () => present ? { ok: true as const, via: "fake" } : { ok: false as const, why: "no provider in this test" };
  const opener: TerminalOpener = { available: answer, open: async (title, argv) => {
    const can = script.length ? await script.shift()!() : answer();
    if (can.ok) opened.push({ title, argv: [...argv] });
    return can;
  } };
  return { opened, terminal: () => opener };
}
async function hub(config: Partial<HubConfig> = {}, terminal?: () => TerminalOpener) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ahub-start-modes-"))), stateDir = join(cwd, ".agenthub/state");
  mkdirSync(join(cwd, ".agenthub"));
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, switchyardPort: 0, ...(terminal ? { terminal } : {}),
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      kimi_cmd: [process.execPath, join(import.meta.dir, "fakes/acp-server.ts")], pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: PI }, ...config } });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  async function page(settings = false) {
    const url = new URL((await client.request({ t: "ui", ...(settings ? { settings: true } : {}) })).url);
    const post = (path: string, body: unknown, cookie?: string) => fetch(`${url.origin}${path}`, { method: "POST", headers: { origin: url.origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const cookie = (await post("/session", { ticket: url.hash.slice(1) })).headers.get("set-cookie")!.split(";")[0]!;
    return { act: async (body: Record<string, unknown>) => (await post("/action", body, cookie)).json() as Promise<Record<string, any>>, snapshot: async () => (await post("/snapshot", { after: 0 }, cookie)).json() as Promise<Record<string, any>> };
  }
  const log = () => readFileSync(join(stateDir, "hub.log"), "utf8");
  return { cwd, stateDir, daemon, client, page, log };
}

test("start modes: tui is the default wherever a peer has one, and only pi and codex can be set", () => {
  expect(["claude", "codex", "pi", "kimi", "local"].map((peer) => startModeOf({}, peer))).toEqual(["tui", "tui", "tui", "headless", "headless"]);
  const set = peerStartConfig({ pi: { start_mode: "headless" }, codex: {} });
  expect([startModeOf(set, "pi"), startModeOf(set, "codex"), startModeOf(set, "claude")]).toEqual(["headless", "tui", "tui"]);
  expect(startModeOf(undefined, "pi")).toBe("tui");
  for (const bad of [[], "tui", { kimi: { start_mode: "tui" } }, { claude: { start_mode: "headless" } }, { pi: "headless" }, { pi: { start_mode: "window" } }]) expect(() => peerStartConfig(bad)).toThrow("peers");
  // The terminal template is an argv with {command} in exactly one element, and it is a machine-local field.
  expect(terminalTemplate(["tmux", "new-window", "{command}"])).toEqual(["tmux", "new-window", "{command}"]);
  expect(terminalTemplate(undefined)).toEqual([]);
  for (const bad of ["tmux {command}", ["tmux"], ["{command}", "{command}"], ["tmux", ""], ["tmux", 3]]) expect(() => terminalTemplate(bad)).toThrow("terminal.open");
  expect(MACHINE_LOCAL).toContain("terminal.open");
  // The loader refuses a malformed block instead of starting with a guess.
  const cwd = mkdtempSync(join(tmpdir(), "ahub-start-config-")); mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub/config.json"), JSON.stringify({ peers: { pi: { start_mode: "headless" } } }));
  expect(loadConfig(cwd).peers).toEqual({ pi: { start_mode: "headless" } });
  writeFileSync(join(cwd, ".agenthub/config.json"), JSON.stringify({ peers: { pi: { start_mode: "sometimes" } } }));
  expect(() => loadConfig(cwd)).toThrow("peers.pi.start_mode must be tui or headless");
});

test("AC6: a hub-made start of a TUI peer opens the fixed command through the provider, once, and no caller text reaches it", async () => {
  const fake = provider();
  const rig = await hub({ roles: { ...DEFAULT_CONFIG.roles, claude: ["conductor"] } }, fake.terminal);
  const ui = await rig.page();
  const fixed = (...words: string[]) => [process.execPath, MAIN, "--project", rig.cwd, ...words];
  // The dashboard's Start control says what will happen before it is pressed.
  const starts = (await ui.snapshot()).starts as Record<string, any>[];
  expect(starts.map((s) => [s.peer, s.mode, s.via ?? null, s.command])).toEqual([
    ["claude", "tui", "fake", "ahub claude"], ["codex", "tui", "fake", "ahub codex"], ["kimi", "headless", null, "ahub kimi"], ["pi", "tui", "fake", "ahub pi --mode tui"], ["local", "headless", null, "ahub local"]]);
  // Dashboard.
  expect(await ui.act({ action: "start_peer", peer: "pi" })).toEqual({ ok: true, text: "Opened a terminal running ahub pi --mode tui; pi attaches when its TUI is ready." });
  expect(fake.opened).toEqual([{ title: "pi (agent-hub)", argv: fixed("pi", "--mode", "tui") }]);
  expect(rig.daemon.bus.peers.has("pi")).toBe(false); // nothing was started headless in its place
  expect(rig.log()).toContain("pi: the dashboard opened a terminal running ahub pi --mode tui (fake)");
  // A second press while that terminal comes up opens no second one.
  const again = await ui.act({ action: "start_peer", peer: "pi" });
  expect(again.ok).toBe(false); expect(again.error).toContain("a terminal for pi was opened");
  expect(fake.opened).toHaveLength(1);
  // The console child's request, for the peers whose only form is a TUI.
  expect(await rig.client.request({ t: "peer_start", peer: "claude" })).toMatchObject({ ok: true, mode: "tui", opened: "fake", command: "ahub claude" });
  expect(fake.opened.at(-1)).toEqual({ title: "claude (agent-hub)", argv: fixed("claude") });
  // The conductor: the same start, and it cannot choose the mode.
  const lead = await ControlClient.connect(rig.stateDir, { role: "tools", peer: "claude" }); cleanup.push(() => lead.close());
  const conducted = await lead.request({ t: "task", op: "hub_peer_start", args: { peer: "codex" } });
  expect(JSON.parse(conducted.text)).toEqual({ peer: "codex", mode: "tui", command: "ahub codex", opened: "fake" });
  expect(fake.opened.at(-1)).toEqual({ title: "codex (agent-hub)", argv: fixed("codex") });
  const chosen = await lead.request({ t: "task", op: "hub_peer_start", args: { peer: "codex", mode: "headless" } });
  expect(chosen.ok).toBe(false); expect(chosen.error).toContain("the conductor cannot choose one");
  expect((await lead.request({ t: "peer_start", peer: "pi" })).error).toContain("console command");
  // Nothing but a peer id from the closed list is ever accepted, from any surface, and nothing else reaches a command.
  const before = fake.opened.length;
  for (const peer of ["pi --mode headless", "pi; touch /tmp/x", "$(id)", "../pi", "other", "", 7, null, ["pi"]]) {
    expect((await rig.client.request({ t: "peer_start", peer })).ok).toBe(false);
    expect((await ui.act({ action: "start_peer", peer })).ok).toBe(false);
    expect((await lead.request({ t: "task", op: "hub_peer_start", args: { peer } })).ok).toBe(false);
  }
  expect(await ui.act({ action: "start_peer", peer: "codex", command: "sh -c evil", args: ["--unattended"], mode: "headless" })).toMatchObject({ ok: false }); // codex's terminal is still coming up
  expect(fake.opened).toHaveLength(before);
  for (const { argv } of fake.opened) expect(argv.slice(0, 4)).toEqual([process.execPath, MAIN, "--project", rig.cwd]);
}, 30_000);

test("AC6: with no terminal provider a TUI start is refused with the command to run by hand and is never downgraded to headless", async () => {
  const rig = await hub({ pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: true, cmd: PI }, roles: { ...DEFAULT_CONFIG.roles, claude: ["conductor"] } });
  // pi.auto_start at hub start: said out loud, and no Pi.
  await until(() => rig.log().includes("pi.auto_start did not start Pi"));
  expect(rig.log()).toContain("pi.auto_start did not start Pi: pi starts in its TUI and the hub could not open a terminal for it (this hub was started without a terminal provider). Run ahub pi --mode tui in a terminal, or set its start mode to headless (ahub settings set peers.pi.start_mode headless)");
  const ui = await rig.page();
  const snapshot = await ui.snapshot();
  expect(snapshot.starts.find((s: any) => s.peer === "pi")).toEqual({ peer: "pi", mode: "tui", attached: false, command: "ahub pi --mode tui", why: "this hub was started without a terminal provider" });
  const refused = await ui.act({ action: "start_peer", peer: "pi" });
  expect(refused.ok).toBe(false); expect(refused.error).toContain("Run ahub pi --mode tui in a terminal");
  const claude = await rig.client.request({ t: "peer_start", peer: "claude" });
  expect(claude).toMatchObject({ ok: false, command: "ahub claude" });
  expect(claude.error).not.toContain("start_mode"); // Claude has no headless form to offer
  const lead = await ControlClient.connect(rig.stateDir, { role: "tools", peer: "claude" }); cleanup.push(() => lead.close());
  const conducted = await lead.request({ t: "task", op: "hub_peer_start", args: { peer: "pi" } });
  expect(conducted.ok).toBe(false); expect(conducted.error).toContain("Run ahub pi --mode tui in a terminal");
  await Bun.sleep(100);
  expect(rig.daemon.bus.peers.has("pi")).toBe(false);
  // Headless-only peers are not affected: Kimi starts as before.
  expect(await ui.act({ action: "start_peer", peer: "kimi" })).toEqual({ ok: true, text: "kimi started (headless)." });
  await until(() => rig.daemon.bus.stateOf("kimi") === "idle");
  expect((await ui.snapshot()).starts.find((s: any) => s.peer === "kimi").attached).toBe(true);
}, 30_000);

test("AC6: a headless start mode is how a person asks for headless: auto-start and the dashboard start Pi at once, and the setting applies at the next start", async () => {
  const fake = provider();
  const rig = await hub({ peers: { pi: { start_mode: "headless" } }, pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: true, cmd: PI } }, fake.terminal);
  await until(() => rig.daemon.bus.stateOf("pi") === "idle");
  expect((rig.daemon.bus.peers.get("pi") as unknown as { mode: string }).mode).toBe("headless");
  expect(fake.opened).toEqual([]);
  expect(await rig.client.request({ t: "peer_start", peer: "pi" })).toMatchObject({ ok: true, already: true });
  expect((await rig.client.request({ t: "peer_stop", peer: "pi" })).ok).toBe(true);
  // Setting it back to tui: an ordinary session may (it is the floor); headless again needs a settings session.
  const ordinary = await rig.page(), settings = await rig.page(true);
  expect(await ordinary.act({ action: "setting", key: "peers.pi.start_mode", value: "tui" })).toEqual({ ok: true, text: "peers.pi.start_mode: tui (applies at the peer's next start)" });
  expect(JSON.parse(readFileSync(join(rig.cwd, ".agenthub/config.local.json"), "utf8"))).toEqual({ peers: { pi: { start_mode: "tui" } } });
  expect(await ordinary.act({ action: "start_peer", peer: "pi" })).toMatchObject({ ok: true, text: "Opened a terminal running ahub pi --mode tui; pi attaches when its TUI is ready." });
  expect(fake.opened).toHaveLength(1);
  expect((await ordinary.act({ action: "setting", key: "peers.pi.start_mode", value: "headless" })).error).toContain("ahub ui --settings");
  expect(await settings.act({ action: "setting", key: "peers.pi.start_mode", value: "headless" })).toMatchObject({ ok: true });
  const row = (await settings.snapshot()).settings.rows.find((r: any) => r.key === "peers.pi.start_mode");
  expect(row).toMatchObject({ value: "headless", source: "config.local.json", applies: "peer start", group: "Start" });
  expect(row.pending).toBeUndefined();
  expect(await settings.act({ action: "start_peer", peer: "pi" })).toEqual({ ok: true, text: "pi started (headless)." });
  expect(rig.daemon.bus.stateOf("pi")).toBe("idle");
  expect(fake.opened).toHaveLength(1);
  // The terminal template and anything under peers but a start mode are not settings.
  for (const key of ["terminal.open", "terminal", "peers.pi.cmd", "peers.kimi.start_mode", "peers.claude.start_mode"]) expect((await settings.act({ action: "setting", key, value: "tui" })).ok).toBe(false);
}, 30_000);

test("terminal providers: the machine-local template gets one quoted command line, Orca gets the worktree on record, and without either there is none", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ahub term open-"))), stateDir = join(cwd, "state"); // a space in the path, on purpose
  mkdirSync(stateDir);
  const argv = [process.execPath, "/pkg path/main.ts", "--project", cwd, "pi", "--mode", "tui"], line = argv.map(shellQuote).join(" ");
  // Template: every placeholder is substituted inside argv elements; the shell that runs {command} sees the same words back.
  const out = join(cwd, "out.txt");
  const template = terminalOpener({ template: ["/bin/sh", "-c", `printf '%s\\n' "$1" "$2" "$3" > ${shellQuote(out)}; eval "set -- $1"; printf '%s\\n' "$#" "$2" "$4" >> ${shellQuote(out)}`, "sh", "{command}", "{title}", "{cwd}"], cwd, stateDir, env: {} });
  expect(template.available()).toEqual({ ok: true, via: "terminal.open" });
  expect(await template.open("pi (agent-hub)", argv)).toEqual({ ok: true, via: "terminal.open" });
  await until(() => existsSync(out) && readFileSync(out, "utf8").split("\n").length >= 7);
  expect(readFileSync(out, "utf8").trimEnd().split("\n")).toEqual([line, "pi (agent-hub)", cwd, "7", "/pkg path/main.ts", cwd]);
  expect(await terminalOpener({ template: ["/bin/sh", "-c", "exit 3", "{command}"], cwd, stateDir, env: {} }).open("t", argv)).toEqual({ ok: false, why: "terminal.open exited 3" });
  expect((await terminalOpener({ template: ["/nonexistent/terminal", "{command}"], cwd, stateDir, env: {} }).open("t", argv)).ok).toBe(false);
  // Orca: the worktree this hub runs in, and the documented create call with the command as one argument.
  const calls: string[][] = [];
  const run = async (args: readonly string[]) => { calls.push([...args]); return { result: { terminal: { handle: "term-1" } } }; };
  const orca = terminalOpener({ template: [], cwd, stateDir, env: { ORCA_WORKTREE_ID: "wt-7" }, run });
  expect(orca.available()).toEqual({ ok: true, via: "orca" });
  expect(await orca.open("pi (agent-hub)", argv)).toEqual({ ok: true, via: "orca" });
  expect(calls).toEqual([["terminal", "create", "--worktree", "id:wt-7", "--command", line, "--title", "pi (agent-hub)", "--json"]]);
  const refusing = terminalOpener({ template: [], cwd, stateDir, env: { ORCA_WORKTREE_ID: "wt-7" }, run: async () => ({ status: 1, stdout: "", stderr: "no such worktree" }) });
  expect(await refusing.open("t", argv)).toMatchObject({ ok: false });
  // A worktree recorded by an earlier `ahub <peer>` launch of this project serves when the hub's own environment has none.
  const none = terminalOpener({ template: [], cwd, stateDir, env: {}, run });
  expect(none.available()).toEqual({ ok: false, why: "no terminal.open command is configured and this project has no Orca worktree on record" });
  expect(await none.open("t", argv)).toMatchObject({ ok: false });
  writeFileSync(join(stateDir, "terminal-recovery.json"), JSON.stringify([{ peer: "codex", projectRoot: cwd, stateDir, instanceId: "i", launcherPid: 1, launcherSignature: "s", launchId: "l", handle: "h", incarnationId: "inc", worktreeId: "wt-recorded", env: {} }]));
  expect(none.available()).toEqual({ ok: true, via: "orca" });
  await none.open("t", argv);
  expect(calls.at(-1)!.slice(0, 4)).toEqual(["terminal", "create", "--worktree", "id:wt-recorded"]);
  // The person's terminal carries no agent marker, whatever started the hub.
  expect(personEnv({ PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s", CODEX_THREAD_ID: "t", AGENTHUB_PEER_ID: "kimi", AGENTHUB_CHANNEL: "c", AGENTHUB_UNATTENDED: "1", AGENTHUB_RECOVERY_OPERATION: "op", ORCA_TERMINAL_HANDLE: "h", ORCA_WORKTREE_ID: "w" })).toEqual({ PATH: "/bin" });
  // A project path is data, whatever it holds: a quote, a shell command, "$" patterns and the template's own
  // placeholders reach the terminal's shell as one word, exactly, and run nothing.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ahub-term-hostile-"))), hostile = join(base, "p'; touch INJECTED; '{cwd} $& $$ {title} {command}");
  mkdirSync(hostile);
  const seen = join(base, "seen.txt"), words = [process.execPath, "/pkg/main.ts", "--project", hostile, "pi", "--mode", "tui"];
  const guarded = terminalOpener({ template: ["/bin/sh", "-c", `eval "set -- $1"; printf '%s\\n' "$#" "$4" > ${shellQuote(seen)}`, "sh", "{command}"], cwd: hostile, stateDir, env: {} });
  expect(await guarded.open("pi (agent-hub)", words)).toEqual({ ok: true, via: "terminal.open" });
  await until(() => existsSync(seen) && readFileSync(seen, "utf8").endsWith("\n"));
  expect(readFileSync(seen, "utf8")).toBe(`7\n${hostile}\n`);
  expect([existsSync(join(hostile, "INJECTED")), existsSync(join(base, "INJECTED"))]).toEqual([false, false]);
  // {title} and {cwd} are substituted once, raw, in elements of their own.
  const raw = join(base, "raw.txt");
  await terminalOpener({ template: ["/bin/sh", "-c", `printf '%s\\n' "$1" "$2" > ${shellQuote(raw)}`, "sh", "{title}", "{cwd}", "{command}"], cwd: hostile, stateDir, env: {} }).open("pi (agent-hub)", words);
  await until(() => existsSync(raw) && readFileSync(raw, "utf8").endsWith("\n"));
  expect(readFileSync(raw, "utf8")).toBe(`pi (agent-hub)\n${hostile}\n`);
}, 20_000);

const MARKERS = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_UNATTENDED", "AGENTHUB_RECOVERY_OPERATION"];
/** The real CLI in a child; `tty` marks its standard input and output as a terminal, as a person's shell has them. */
async function cli(root: string, args: string[], opts: { tty?: boolean; markers?: Record<string, string> } = {}) {
  const wrapper = join(root, `cli-${crypto.randomUUID()}.ts`);
  writeFileSync(wrapper, `for (const name of ${JSON.stringify(MARKERS)}) delete process.env[name];
Object.assign(process.env, ${JSON.stringify(opts.markers ?? {})}, { AGENTHUB_HOME: ${JSON.stringify(join(root, "home"))} });
${opts.tty ? 'for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, "isTTY", { value: true, configurable: true });' : ""}
process.argv = [process.execPath, ${JSON.stringify(MAIN)}, ...${JSON.stringify(args)}];
await import(${JSON.stringify(MAIN)});
`);
  const child = Bun.spawn([process.execPath, wrapper], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

test("AC6: ahub pi asks for the TUI by default, --mode headless and --headless are honoured, and without a terminal the hub is asked to open one", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ahub-pi-cli-"))), stateDir = join(root, ".agenthub/state");
  mkdirSync(stateDir, { recursive: true });
  const config = (value: unknown) => writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify(value));
  config({ memory: { enabled: false } });
  // A hub that records each request and answers as scripted: what the CLI asks for is the subject here.
  const requests: any[] = [];
  let answer: (msg: any) => Record<string, unknown> = () => ({ ok: false, error: "scripted refusal" });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, srv) { if (srv.upgrade(req)) return; return new Response("unexpected"); },
    websocket: { message(ws, raw) {
      const msg = JSON.parse(String(raw));
      if (msg.t === "hello") return void ws.send(JSON.stringify({ t: "welcome", rid: msg.rid, ok: true, cwd: root, protocol: PROTOCOL }));
      requests.push(msg);
      ws.send(JSON.stringify({ t: "reply", rid: msg.rid, ...answer(msg) }));
    } } });
  cleanup.push(() => server.stop(true));
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ cwd: root, controlPort: server.port, protocol: PROTOCOL }));
  writeFileSync(join(stateDir, "control-token"), "fixture-token");
  const last = () => { const { rid: _rid, ...rest } = requests.at(-1); return rest; };

  // A person's terminal: the TUI, unless a flag or the start mode says headless.
  expect((await cli(root, ["pi"], { tty: true })).stderr).toContain("scripted refusal");
  expect(last()).toMatchObject({ t: "start", peer: "pi", args: { mode: "tui" } });
  answer = () => ({ ok: true });
  for (const flags of [["--mode", "headless"], ["--headless"], ["--headless", "--backend", "dgx"]]) {
    expect(await cli(root, ["pi", ...flags], { tty: true })).toMatchObject({ code: 0, stdout: 'pi attached (headless). Talk to it with: ahub say @pi "..."\n' });
    expect(last()).toMatchObject({ t: "start", peer: "pi", args: { mode: "headless" } });
  }
  expect(last().args.backend).toBe("dgx");
  expect((await cli(root, ["pi", "--headless", "--mode", "tui"], { tty: true })).stderr).toContain("usage: ahub pi [--mode headless|tui | --headless]");
  // --headless is --mode headless on every path of the command, the preview included.
  const preview = await cli(root, ["pi", "--headless", "--print-command"]);
  expect(preview.stderr).toBe(""); expect(preview.code).toBe(0);
  expect(preview.stdout).toBe((await cli(root, ["pi", "--mode", "headless", "--print-command"])).stdout);
  expect(preview.stdout).not.toBe((await cli(root, ["pi", "--mode", "tui", "--print-command"])).stdout);
  config({ memory: { enabled: false }, peers: { pi: { start_mode: "headless" } } });
  expect((await cli(root, ["pi"], { tty: true })).code).toBe(0);
  expect(last()).toMatchObject({ t: "start", args: { mode: "headless" } });
  expect((await cli(root, ["pi"])).code).toBe(0); // and the same without a terminal: headless needs none
  expect(last()).toMatchObject({ t: "start", args: { mode: "headless" } });
  config({ memory: { enabled: false } });

  // No terminal (the console's command line, a script): the hub is asked to start Pi in its mode. Never headless by default.
  answer = () => ({ ok: true, mode: "tui", opened: "orca", command: "ahub pi --mode tui" });
  expect(await cli(root, ["pi"])).toEqual({ code: 0, stdout: "pi: opened a terminal running ahub pi --mode tui; it attaches when its TUI is ready\n", stderr: "" });
  expect(last()).toEqual({ t: "peer_start", peer: "pi" });
  answer = () => ({ ok: false, error: "pi starts in its TUI and the hub could not open a terminal for it (none). Run ahub pi --mode tui in a terminal" });
  const refused = await cli(root, ["pi"]);
  expect(refused.code).toBe(1); expect(refused.stderr).toContain("Run ahub pi --mode tui in a terminal");
  answer = () => ({ ok: false, error: 'this hub does not know "peer_start" (restart it: ahub kill && ahub up)' });
  expect((await cli(root, ["pi"])).stderr).toContain("upgrade the running hub, or run ahub pi --mode headless");
  const sent = requests.length;
  const optioned = await cli(root, ["pi", "--backend", "dgx"]);
  expect(optioned.code).toBe(1); expect(optioned.stderr).toContain("Pi's TUI needs a terminal");
  expect(requests).toHaveLength(sent); // refused before anything was asked of the hub
  // An explicit --mode tui is taken at its word, as before this change (the recovery driver passes it).
  answer = () => ({ ok: false, error: "scripted refusal" });
  await cli(root, ["pi", "--mode", "tui"]);
  expect(last()).toMatchObject({ t: "start", args: { mode: "tui" } });

  // An agent shell is the conductor's path: no mode unless it repeats one, and the hub decides.
  answer = () => ({ ok: true, text: "{}" });
  await cli(root, ["pi"], { markers: { AGENTHUB_PEER_ID: "claude" } });
  expect(last()).toMatchObject({ t: "task", op: "hub_peer_start", args: { peer: "pi" } });
  expect(last().args.mode).toBeUndefined();
  for (const flags of [["--mode", "headless"], ["--headless"]]) {
    await cli(root, ["pi", ...flags], { markers: { AGENTHUB_PEER_ID: "claude" } });
    expect(last().args).toEqual({ peer: "pi", mode: "headless" });
  }
}, 60_000);

test("AC6 dashboard: the Start control names the mode and where the terminal comes from, and offers no button it cannot honour", () => {
  const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
  const code = /function renderStarts\(target, starts\) \{[\s\S]*?\n\}/.exec(html)![0];
  class Node { children: Node[] = []; constructor(public tag: string, public textContent = "", public className = "") {} append(...nodes: Node[]) { this.children.push(...nodes); } text(): string { return [this.textContent, ...this.children.map((c) => c.text())].join("\n"); } }
  const root = new Node("div"), actions: unknown[] = [];
  runInNewContext(`${code}; renderStarts(target, starts)`, {
    target: root, el: (tag: string, text?: string, cls?: string) => new Node(tag, text ?? "", cls ?? ""), badge: (text: string) => new Node("span", text),
    button: (text: string, payload: unknown) => { actions.push(payload); return new Node("button", text); },
    starts: [
      { peer: "claude", mode: "tui", attached: true, command: "ahub claude", via: "orca" },
      { peer: "codex", mode: "tui", attached: false, command: "ahub codex", via: "orca" },
      { peer: "kimi", mode: "headless", attached: false, command: "ahub kimi" },
      { peer: "pi", mode: "tui", attached: false, command: "ahub pi --mode tui", why: "no terminal.open command is configured and this project has no Orca worktree on record" },
    ],
  });
  const page = root.text();
  expect(page).not.toContain("Start claude"); // attached: nothing to start
  expect(page).toContain("Start mode tui: opens ahub codex in a terminal through orca.");
  expect(page).toContain("Starts headless: its start mode.");
  expect(page).toContain("Start mode tui, and the hub has no terminal to open (no terminal.open command is configured and this project has no Orca worktree on record). Run ahub pi --mode tui in a terminal.");
  expect(actions).toEqual([{ action: "start_peer", peer: "codex" }, { action: "start_peer", peer: "kimi" }]);
});

test("AC6: starts that arrive together open one terminal, a failed open frees the next try, and a provider's own error text stays in the log", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fake = provider(true, [
    async () => ({ ok: false, why: "Orca could not create the terminal", detail: "stderr: /Users/someone/private/path refused" }),
    async () => { await gate; return { ok: true, via: "fake" }; },
  ]);
  const rig = await hub({}, fake.terminal);
  const ui = await rig.page();
  // A provider failure: the caller gets the hub's wording and the manual command; the provider's text goes to hub.log only.
  const failed = await ui.act({ action: "start_peer", peer: "pi" });
  expect(failed.ok).toBe(false);
  expect(failed.error).toContain("could not open a terminal for it (Orca could not create the terminal). Run ahub pi --mode tui in a terminal");
  expect(JSON.stringify(failed)).not.toContain("private/path");
  expect(rig.log()).toContain("terminal provider for pi: stderr: /Users/someone/private/path refused");
  // Nothing was opened, so the next request is not held off by the 30 s guard. Three arrive together: one terminal.
  const together = [ui.act({ action: "start_peer", peer: "pi" }), rig.client.request({ t: "peer_start", peer: "pi" }), ui.act({ action: "start_peer", peer: "pi" })];
  await Bun.sleep(50);
  release();
  const results = await Promise.all(together);
  expect(results.filter((r) => r.ok === true)).toHaveLength(1);
  for (const refused of results.filter((r) => r.ok !== true)) expect(refused.error).toContain("a terminal for pi was opened");
  expect(fake.opened).toHaveLength(1);
}, 20_000);
