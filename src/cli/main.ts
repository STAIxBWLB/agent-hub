#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ControlClient, readControl } from "../hub/control-client.ts";
import { loadConfig } from "../hub/daemon.ts";
import { projectContext } from "../hub/project.ts";
import { Registry, type Project } from "../hub/registry.ts";
import { inspectProject, startProject, stopProject, runProjectDaemon } from "../hub/lifecycle.ts";
import { openManager, startManager, stopManager } from "../hub/manager.ts";
import type { BusEvent } from "../hub/bus.ts";
import { OmniRoute } from "../omniroute/client.ts";
import { MemoryClient } from "../memory/client.ts";
import { init } from "./init.ts";
import { buildLaunch, UNATTENDED_WARNING } from "./launch.ts";
import { nextStep, parseList, pluginState, type InstalledPlugin, type Marketplace } from "./setup.ts";
import { CLASSES } from "../hub/board.ts";
import { VERSION } from "../version.ts";
import { createInterface } from "node:readline/promises";
import { assertLifecycleAvailable, readOperation } from "../hub/recovery-store.ts";
import { childEnv } from "../hub/child-process.ts";
import { abortRecovery, createOperation, publicOperation, registeredProjects, runRecovery, type RecoveryOperation } from "./upgrade.ts";
import { makeRecoveryDriver, makeUpgradePlan, preserveSource } from "./upgrade-runtime.ts";
import { recordTerminalLaunch } from "./terminal-recovery.ts";
import { ensureMlx, inspectMlx, stopMlx } from "../models/mlx.ts";

const USAGE = `agent-hub ${VERSION}: Claude Code, Codex and Kimi as peers in one project directory

  ahub --project <path|id> <command>  select a repository or worktree explicitly
  ahub projects [--json]         list registered projects and live status
  ahub projects remove <id>      forget a stopped registration (keeps project files)
  ahub status --all              show every registered project
  ahub ui --all [--no-open]      open the unified project dashboard
  ahub ui --all --stop           stop only the dashboard manager
  ahub setup [--yes]            install or update the Claude Code channel plugin from this package, then run doctor
  ahub init                     write .agenthub/config.json and the CLAUDE.md / AGENTS.md marker blocks
  ahub up [--unattended]        start the daemon for this directory
  ahub upgrade --to <version> [--dry-run] [--yes]   review and upgrade running projects
  ahub restart [--dry-run] [--yes]                 recover this project's runtime
  ahub recovery status|resume|abort <operation-id> inspect, resume or cancel a preflight
  ahub claude [args...]         launch Claude Code with the hub channel   [--unattended]
  ahub codex [args...]          start the Codex adapter and attach the TUI [--unattended]
  ahub kimi [--model <alias>]   start Kimi headless under ACP
  ahub pi [--mode headless|tui] [--backend auto|dgx|mlx] [--session-id <id>] [--session-file <path>]  start Pi
  ahub models setup|status|start|stop  manage the pinned local MLX runtime
  ahub local [--route <id> | --model <id>]
                               start the hub-native worker on the self-hosted models (routing.toml)
  ahub say [@peer ...] <text>   send as the console user (no @peer = broadcast); delivered at once,
                               start the text with [STATUS] to let it batch or [FYI] for the record only
  ahub pause|resume <peer>      hold a peer's deliveries in its queue / release them
  ahub budget                   quota windows per peer, and who is paused until when
  ahub budget set <peer> <0..1> [--resets-in 30m] [--window 5h|week]   feed a reading by hand (also: test the relay)
  ahub budget resume <peer>     override a budget pause; readings are ignored for that peer until the window resets
  ahub board [state]            the task board
  ahub task propose [--class <c> | <class>] <title...> [--owner <peer>] [--path <p>]... [--detail <text>]
  ahub task show|escalate <id>  full task with history (PII text included) / hand it to the next peer in escalate_to
  ahub task assign <id> <peer>  give a task to a peer yourself
  ahub review <id> approved|changes_requested [note...]
  ahub remember <text...>       save a note to the memory all agents share
  ahub ask [--remember] <question...>   answer from the task board, shared memory and this run's log, with the ids it rests on
  ahub route explain <id>       why a task went where it went
  ahub route explain --class <c> <title...>   what would happen to such a task now
  ahub ui [--no-open]           open the local dashboard (or print its one-time link)
  ahub tail                     live stream of messages, states and permission requests
  ahub permit <id> <option>     answer a permission request shown by tail ("deny" cancels)
  ahub status | logs [-f] | doctor | kill`;

const argv = process.argv.slice(2);
let selector: string | undefined;
if (argv[0] === "--project") {
  argv.shift();
  selector = argv.shift();
  if (!selector || selector.startsWith("--")) fail("--project needs a path or project ID");
}
const [cmd = "help", ...args] = argv;
let selected: { root: string; stateDir: string };
try {
  if (selector) {
    const projects = registeredProjects();
    {
      const known = projects.find((p) => p.id === selector);
      const context = known ?? projectContext(selector, {});
      const registered = known ?? projects.find((p) => p.root === context.root);
      selected = registered ?? context;
    }
  } else selected = projectContext(process.cwd());
} catch (error) { fail((error as Error).message); }
const cwd = selected.root;
const stateDir = selected.stateDir;
try { process.chdir(cwd); } catch { fail(`project directory is unavailable: ${cwd}`); }
const unattendedEnv = process.env.AGENTHUB_UNATTENDED === "1";
const lifecycle = { inspectProject, startProject, stopProject };
const connect = () => ControlClient.connect(stateDir, { role: "console", projectRoot: cwd });

function registeredProject(): Project {
  const registry = new Registry();
  try { return registry.register(cwd, stateDir); }
  finally { registry.close(); }
}

async function healthy(): Promise<boolean> {
  let hub: ControlClient | undefined;
  try { hub = await connect(); const reply = await hub.request({ t: "status" }, 3000); return reply.status?.cwd === cwd; }
  catch { return false; }
  finally { hub?.close(); }
}

function exec(bin: string, argv: string[]): never {
  const res = spawnSync(bin, argv, { cwd, stdio: "inherit", env: { ...childEnv(), AGENTHUB_STATE_DIR: stateDir, AGENTHUB_PROJECT_DIR: cwd } });
  if (res.error) fail(`cannot run ${bin}: ${res.error.message}`);
  process.exit(res.status ?? 1);
}

function execWithEnv(bin: string, argv: string[], extra: NodeJS.ProcessEnv): never {
  const env: NodeJS.ProcessEnv = { ...extra, AGENTHUB_STATE_DIR: stateDir, AGENTHUB_PROJECT_DIR: cwd };
  delete env.AGENTHUB_RECOVERY_OPERATION;
  delete env.AGENTHUB_UNATTENDED;
  const res = spawnSync(bin, argv, { cwd, stdio: "inherit", env });
  if (res.error) fail(`cannot run ${bin}: ${res.error.message}`);
  process.exit(res.status ?? 1);
}

function piFlags(): { mode: "headless" | "tui"; backend?: "auto" | "dgx" | "mlx"; model?: string; sessionId?: string; sessionFile?: string } {
  for (const flag of ["--mode", "--backend", "--model", "--session-id", "--session-file"]) {
    const index = args.indexOf(flag);
    if (index >= 0 && (!args[index + 1] || args[index + 1]!.startsWith("--"))) fail(`${flag} needs a value`);
  }
  const mode = (args.includes("--mode") ? args[args.indexOf("--mode") + 1] : "headless") as string;
  const backend = (args.includes("--backend") ? args[args.indexOf("--backend") + 1] : undefined) as string | undefined;
  const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : undefined;
  const sessionId = args.includes("--session-id") ? args[args.indexOf("--session-id") + 1] : undefined;
  const sessionFile = args.includes("--session-file") ? args[args.indexOf("--session-file") + 1] : undefined;
  if (!["headless", "tui"].includes(mode) || (backend !== undefined && !["auto", "dgx", "mlx"].includes(backend)) || (sessionId && sessionFile)) fail("usage: ahub pi [--mode headless|tui] [--backend auto|dgx|mlx] [--model <alias>] [--session-id <id> | --session-file <path>]");
  return { mode: mode as "headless" | "tui", ...(backend ? { backend: backend as "auto" | "dgx" | "mlx" } : {}), ...(model ? { model } : {}), ...(sessionId ? { sessionId } : {}), ...(sessionFile ? { sessionFile } : {}) };
}

async function projectRows() {
  const registry = new Registry();
  try { return await Promise.all(registry.list().map(async (project) => ({ ...project, ...await inspectProject(project) }))); }
  finally { registry.close(); }
}

async function printProjects(json = false) {
  const rows = await projectRows();
  if (json) return console.log(JSON.stringify(rows, null, 2));
  for (const row of rows) {
    console.log(`${row.id}  ${row.state.padEnd(12)} ${row.root}`);
    if (row.status) console.log(`  peers ${Object.keys(row.status.peers ?? {}).length}, control ${row.status.controlPort}, tasks ${JSON.stringify(row.status.tasks ?? {})}`);
    if (row.error) console.log(`  ${row.error}`);
  }
  if (!rows.length) console.log("No registered projects. Run ahub init in a project directory.");
}

function fail(message: string): never {
  console.error(`ahub: ${message}`);
  process.exit(1);
}

function render(e: BusEvent): string {
  if (e.t === "state") return `  . ${e.peer} is ${e.state}`;
  if (e.t === "undeliverable") return `  ! gave up delivering ${e.env.id} (from ${e.env.from}) to ${e.peer}`;
  if (e.t === "envelope" && e.env.from === "hub" && e.env.kind !== "chat") {
    return `${new Date(e.env.ts).toLocaleTimeString()} hub -> ${e.env.to?.join(",")} [${e.env.kind}${e.env.refs?.task ? ` #${e.env.refs.task}` : ""}]\n${e.env.body.split("\n")[0]!.replace(/^/, "    ")}`;
  }
  if (e.t === "overflow") return `  ! ${e.peer}'s queue is full: dropped ${e.env.id} (from ${e.env.from})`;
  const { env } = e;
  const note = e.dropped === "hop" ? " [not delivered: hop limit]" : e.dropped === "fyi" ? " [fyi: record only]" : "";
  const head = `${env.from} -> ${env.to?.join(",") ?? "*"}${env.priority === "important" ? " !" : ""}${note}`;
  return `${new Date(env.ts).toLocaleTimeString()} ${head}\n${env.body.replace(/^/gm, "    ")}`;
}

async function taskOp(op: string, a: Record<string, unknown>): Promise<string> {
  const hub = await connect();
  const res = await hub.request({ t: "task", op, args: a });
  hub.close();
  if (!res.ok) fail(res.error);
  return res.text;
}

/** `--flag value` pairs pulled out of an argument list; the rest keeps its order. */
function takeFlags(argv: string[], single: string[], repeated: string[]) {
  const one: Record<string, string> = {};
  const many: Record<string, string[]> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (single.includes(a)) one[a] = argv[++i] ?? fail(`${a} needs a value`);
    else if (repeated.includes(a)) (many[a] ??= []).push(argv[++i] ?? fail(`${a} needs a value`));
    else rest.push(a);
  }
  return { one, many, rest };
}

async function hold(t: "pause" | "resume"): Promise<void> {
  if (!args[0]) fail(`usage: hub ${t} <peer>`);
  const hub = await connect();
  const res = await hub.request({ t, peer: args[0] });
  hub.close();
  if (!res.ok) fail(res.error);
  console.log(`${args[0]} is ${res.state}`);
}

function spawnRecovery(operation: RecoveryOperation): void {
  const child = spawn(process.execPath, [join(operation.sourceRoot, "src/cli/main.js"), "recovery-run", operation.id], {
    cwd, detached: true, stdio: "ignore", env: { ...process.env, AGENTHUB_RECOVERY_OPERATION: operation.id },
  });
  child.on("error", () => console.error(`runner launch failed; use ahub recovery resume ${operation.id}`));
  child.unref();
  console.log(`Recovery operation ${operation.id} scheduled.\nahub recovery status ${operation.id}`);
}

async function upgrade(kind: "restart" | "upgrade"): Promise<void> {
  const { one, rest } = takeFlags(args, ["--to"], []);
  if (rest.some((a) => !["--dry-run", "--yes"].includes(a)) || (kind === "restart" && one["--to"])) fail("usage: ahub upgrade --to <version> [--dry-run] [--yes] | ahub restart [--dry-run] [--yes]");
  if (kind === "upgrade" && !one["--to"]) fail("upgrade requires --to <exact-version>");
  if (kind === "upgrade" && selector) fail("upgrade changes the shared package/plugin; omit --project to review all affected running projects");
  const plan = await makeUpgradePlan(kind, one["--to"] ?? VERSION, kind === "restart" ? cwd : undefined);
  console.log(JSON.stringify(plan, null, 2));
  if (args.includes("--dry-run")) return;
  if (plan.blockers.length || plan.projects.some((p) => p.blockers.length)) fail("plan has blockers; no runtime was changed");
  assertLifecycleAvailable();
  if (!args.includes("--yes")) {
    if (!process.stdin.isTTY) fail("review --dry-run and use --yes in non-interactive sessions");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!/^(y|yes)$/i.test((await rl.question("Apply this project list and restore its sessions? [y/N] ")).trim())) return;
    } finally { rl.close(); }
  }
  const current = await makeUpgradePlan(kind, plan.version, kind === "restart" ? cwd : undefined);
  if (current.fingerprint !== plan.fingerprint) fail("plan changed during review; run the command again");
  const sourceRoot = preserveSource(plan);
  const operation = createOperation(plan, sourceRoot);
  spawnRecovery(operation);
}

const commands: Record<string, () => Promise<void> | void> = {
  upgrade: () => upgrade("upgrade"),
  restart: () => upgrade("restart"),
  recovery: async () => {
    const [action, id] = args;
    if (args.length !== 2 || !id || !["status", "resume", "abort"].includes(action ?? "")) fail("usage: ahub recovery status|resume|abort <operation-id>");
    const operation = readOperation<RecoveryOperation>(id);
    if (action === "status") console.log(JSON.stringify(publicOperation(operation), null, 2));
    else if (action === "abort") { await abortRecovery(id, makeRecoveryDriver()); console.log("preflight cancelled; no committed transition was rolled back"); }
    else if (["completed", "cancelled"].includes(operation.phase)) console.log(`recovery is already ${operation.phase}`);
    else spawnRecovery(operation);
  },
  "recovery-run": async () => {
    if (args.length !== 1 || process.env.AGENTHUB_RECOVERY_OPERATION !== args[0]) fail("recovery-run is an internal command");
    const result = await runRecovery(args[0]!, makeRecoveryDriver());
    if (result.phase !== "completed") process.exitCode = 1;
  },
  help: () => console.log(USAGE),
  "--version": () => console.log(VERSION),
  version: () => console.log(VERSION),

  projects: async () => {
    if (args[0] === "remove") {
      if (args.length !== 2) fail("usage: ahub projects remove <id>");
      const registry = new Registry();
      try { registry.remove(args[1]!); } finally { registry.close(); }
      console.log("registration removed; project files were kept");
      return;
    }
    if (args.some((arg) => arg !== "--json")) fail("usage: ahub projects [--json]");
    await printProjects(args.includes("--json"));
  },

  ui: async () => {
    if (args.some((arg) => !["--no-open", "--all", "--stop"].includes(arg))) fail("usage: ahub ui [--all] [--no-open] | --all --stop");
    if (args.includes("--stop")) {
      if (!args.includes("--all") || args.includes("--no-open")) fail("usage: ahub ui --all --stop");
      await stopManager();
      return console.log("dashboard manager stopped; project hubs were kept running");
    }
    let url: string;
    if (args.includes("--all")) url = await openManager();
    else {
      const hub = await connect();
      try {
        const res = await hub.request({ t: "ui" }, 10_000);
        if (!res.ok) fail(res.error);
        url = res.url;
      } finally { hub.close(); }
    }
    if (args.includes("--no-open")) return console.log(url);
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    const opened = spawnSync(opener, [url], { stdio: "ignore", timeout: 10_000 });
    if (opened.error || opened.status !== 0) console.log(`Open this one-time link within 60 seconds:\n${url}`);
    else console.log("Dashboard opened. The session expires in one hour; run ahub ui to reopen it.");
  },

  manager: async () => {
    const manager = await startManager({ lifecycle });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void manager.stop());
    await manager.stopped;
  },

  setup: async () => {
    assertLifecycleAvailable();
    const root = join(import.meta.dir, "..", "..");
    const state = () => {
      const out = (argv: string[]) => spawnSync("claude", argv, { encoding: "utf8" }).stdout ?? "";
      return nextStep(parseList<InstalledPlugin>(out(["plugin", "list", "--json"])), parseList<Marketplace>(out(["plugin", "marketplace", "list", "--json"])), root);
    };
    let step = state();
    if (!step) console.log(`Claude Code plugin agent-hub@agent-hub ${VERSION} is installed from this package.`);
    else {
      console.log(`ahub setup changes your Claude Code plugin configuration, one step at a time, re-checking after each. First step:\n  ${step.argv.join(" ")}\n      ${step.why}`);
      if (!args.includes("--yes")) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question("Proceed (this and the steps that follow from it)? [y/N] ")).trim().toLowerCase();
        rl.close();
        if (answer !== "y" && answer !== "yes") return console.log("nothing was changed");
      }
      for (let i = 0; step && i < 6; i++, step = state()) {
        console.log(`> ${step.argv.join(" ")}   (${step.why})`);
        if (spawnSync(step.argv[0]!, step.argv.slice(1), { stdio: "inherit" }).status !== 0) fail(`"${step.argv.join(" ")}" failed; nothing after it was run`);
      }
      if (step) fail(`still not done after 6 steps; next would be: ${step.argv.join(" ")}`);
    }
    await commands.doctor!();
  },

  init: () => {
    assertLifecycleAvailable();
    const changed = init(cwd);
    registeredProject();
    console.log(changed.length ? changed.map((p) => `wrote ${p}`).join("\n") : "already up to date");
  },

  // Internal: the detached daemon process started by ahub up or the manager.
  daemon: async () => {
    process.on("unhandledRejection", (e) => console.error(`${new Date().toISOString()} unhandled rejection:`, e));
    process.on("uncaughtException", (e) => console.error(`${new Date().toISOString()} uncaught exception:`, e));
    await runProjectDaemon(registeredProject(), unattendedEnv || args.includes("--unattended"));
  },

  up: async () => {
    const unattended = unattendedEnv || args.includes("--unattended");
    if (unattended) console.error(UNATTENDED_WARNING);
    const status = await startProject(registeredProject(), { unattended });
    console.log(`ahub up (ws://127.0.0.1:${status.controlPort}), state in ${stateDir}`);
  },

  claude: async () => {
    assertLifecycleAvailable();
    const control = readControl(stateDir);
    if (control?.instanceId) {
      process.env.AGENTHUB_INSTANCE_ID = control.instanceId;
      await recordTerminalLaunch("claude", cwd, stateDir, control.instanceId);
    }
    // `--settings` outranks project and user settings, so the tee has to wrap whichever status line would have won:
    // project local, then project, then user.
    let original: { command?: string; refreshInterval?: number; padding?: number } | undefined;
    for (const file of [join(cwd, ".claude", "settings.local.json"), join(cwd, ".claude", "settings.json"), join(process.env.HOME ?? "", ".claude", "settings.json")]) {
      try {
        original ??= JSON.parse(readFileSync(file, "utf8")).statusLine;
      } catch {
        // no such file, or no status line in it
      }
    }
    const launch = buildLaunch("claude", args, { unattended: unattendedEnv, statusLine: { script: join(import.meta.dir, "statusline-tee.ts"), stateDir, ...(original ? { original } : {}) } });
    if (launch.warning) console.error(launch.warning);
    exec(launch.cmd, launch.args);
  },

  codex: async () => {
    assertLifecycleAvailable();
    const launch0 = buildLaunch("codex", args, { unattended: unattendedEnv, proxyUrl: "pending" }); // refuse bad flags before starting anything
    const hub = await connect();
    const res = await hub.request({ t: "start", peer: "codex", operationId: process.env.AGENTHUB_RECOVERY_OPERATION });
    hub.close();
    if (!res.ok) fail(res.error);
    const control = readControl(stateDir);
    if (control?.instanceId) await recordTerminalLaunch("codex", cwd, stateDir, control.instanceId);
    const launch = buildLaunch("codex", args, { unattended: unattendedEnv, proxyUrl: res.proxyUrl, codexBin: loadConfig(cwd).codex_bin });
    if (launch0.warning) console.error(launch0.warning);
    exec(launch.cmd, launch.args);
  },

  kimi: async () => {
    const i = args.indexOf("--model");
    const model = i === -1 ? undefined : args[i + 1] ?? fail("--model needs an alias");
    const hub = await connect();
    const res = await hub.request({ t: "start", peer: "kimi", args: { model }, operationId: process.env.AGENTHUB_RECOVERY_OPERATION });
    hub.close();
    if (!res.ok) fail(res.error);
    console.log(res.already ? "kimi is already attached" : 'kimi attached (headless). Talk to it with: ahub say @kimi "..."');
  },

  pi: async () => {
    const options = piFlags();
    const hub = await connect();
    const res = await hub.request({ t: "start", peer: "pi", args: options, operationId: process.env.AGENTHUB_RECOVERY_OPERATION });
    hub.close();
    if (!res.ok) fail(res.error);
    if (options.mode === "tui") {
      const launch = res.launch;
      if (!launch || typeof launch.cmd !== "string" || !Array.isArray(launch.args) || !launch.args.every((a: unknown) => typeof a === "string") || !launch.env || typeof launch.env !== "object") fail("Pi TUI launch metadata was not verified");
      const launchEnv = { ...(launch.env as NodeJS.ProcessEnv) };
      delete launchEnv.AGENTHUB_RECOVERY_OPERATION;
      delete launchEnv.AGENTHUB_UNATTENDED;
      const control = readControl(stateDir);
      if (control?.instanceId) await recordTerminalLaunch("pi", cwd, stateDir, control.instanceId);
      return execWithEnv(launch.cmd, launch.args, launchEnv);
    }
    console.log(res.already ? "pi is already attached" : 'pi attached (headless). Talk to it with: ahub say @pi "..."');
  },

  local: async () => {
    const opt = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] ?? fail(`${flag} needs a value`) : undefined);
    const hub = await connect();
    const res = await hub.request({ t: "start", peer: "local", args: { route: opt("--route"), model: opt("--model") }, operationId: process.env.AGENTHUB_RECOVERY_OPERATION });
    hub.close();
    if (!res.ok) fail(res.error);
    console.log(res.already ? "local is already attached" : `local attached on ${res.model}. Give it work with: ahub say @local "..."`);
  },

  models: async () => {
    const action = args[0] ?? "status";
    const runtimeDir = join(homedir(), ".agenthub", "runtimes", "mlx");
    const modelPath = join(homedir(), ".agenthub", "models", "qwen3-8b-mlx");
    if (action === "status") return console.log(JSON.stringify(await inspectMlx({ runtimeDir, modelPath }), null, 2));
    if (action === "start") { const handle = await ensureMlx({ runtimeDir, modelPath }); return console.log(JSON.stringify(handle.status(), null, 2)); }
    if (action === "stop") { await stopMlx({ runtimeDir, modelPath }); return console.log("MLX stopped"); }
    if (action !== "setup") fail("usage: ahub models setup|status|start|stop");
    const python = join(runtimeDir, "bin", "python");
    const run = (argv: string[]) => { const result = spawnSync(argv[0]!, argv.slice(1), { cwd, stdio: "inherit" }); if (result.status !== 0) fail(`models setup failed: ${argv.join(" ")}`); };
    if (!existsSync(python)) run(["uv", "venv", "--python", "3.12", runtimeDir]);
    run(["uv", "pip", "install", "--python", python, "mlx-lm==0.31.3"]);
    run([python, "-c", `from huggingface_hub import snapshot_download; snapshot_download(repo_id='Qwen/Qwen3-8B-MLX-4bit', revision='383413e909f3bc5303ce195ebbdf0339c5a1a2a3', local_dir=${JSON.stringify(modelPath)}, token=False)`]);
    console.log(`MLX runtime and pinned model prepared at ${runtimeDir}`);
  },

  say: async () => {
    const lead = args.findIndex((a) => !/^@[a-z][a-z0-9-]*$/.test(a)); // only leading @tokens are recipients
    const to = args.slice(0, lead === -1 ? args.length : lead).map((a) => a.slice(1));
    const body = lead === -1 ? "" : args.slice(lead).join(" ");
    const hub = await connect();
    const res = await hub.request({ t: "send", body, to });
    hub.close();
    if (!res.ok) fail(res.error);
    if (res.recorded) return console.log("recorded only ([FYI]); no peer was interrupted");
    console.log(res.targets.length ? `queued for: ${res.targets.join(", ")}` : "no peers attached; nothing delivered");
  },

  tail: async () => {
    const hub = await connect();
    hub.onPush = (msg) => {
      if (msg.t === "event") console.log(render(msg.e));
      else if (msg.t === "notice") console.log(`  * ${msg.line}`);
      else if (msg.t === "permission") {
        const options = msg.options.map((o: any) => `${o.optionId} (${o.name})`).join(", ");
        console.log(`  ? ${msg.peer} asks permission: ${String(msg.title).replace(/\n/g, "\n      | ")}\n    answer with: ahub permit ${msg.id} <${options}> | deny`);
      }
    };
    hub.onClose = () => process.exit(0);
    hub.send({ t: "tail" });
    await new Promise(() => {});
  },

  budget: async () => {
    const hub = await connect();
    let set: Record<string, unknown> | undefined;
    if (args[0] === "resume") {
      if (!args[1]) fail("usage: ahub budget resume <peer>");
      const res = await hub.request({ t: "budget", resume: args[1] });
      hub.close();
      if (!res.ok) fail(res.error);
      return console.log(`${args[1]} resumed; the coordinator leaves it alone until its window resets`);
    }
    if (args[0] === "set") {
      const flags = takeFlags(args.slice(1), ["--resets-in", "--window"], []);
      const [peer, used] = flags.rest;
      if (!peer || used === undefined) fail("usage: ahub budget set <peer> <0..1> [--resets-in 30m] [--window 5h|week]");
      const m = /^(\d+)(s|m|h)$/.exec(flags.one["--resets-in"] ?? "");
      if (flags.one["--resets-in"] && !m) fail("--resets-in takes a duration like 90s, 30m or 5h");
      set = { peer, used: Number(used), window: flags.one["--window"], ...(m ? { resetsInMs: Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"] } : {}) };
    }
    const res = await hub.request({ t: "budget", ...(set ? { set } : {}) });
    hub.close();
    if (!res.ok) fail(res.error);
    const peers = Object.entries(res.budget as Record<string, any>);
    if (!peers.length) return console.log(`no quota readings yet (gate ${res.gate}). Sources: Codex rate limits, Claude's status line (ahub claude), ahub budget set.`);
    const left = (at: number) => { const s = Math.max(0, Math.round((at - Date.now()) / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`; };
    for (const [peer, b] of peers) {
      console.log(`${peer}${b.paused ? `  PAUSED: ${b.paused.reason}, resumes in ${left(b.paused.resetsAt)}` : ""}`);
      for (const w of b.windows) console.log(`  ${String(w.id).padEnd(7)} ${String(Math.round(w.used * 100)).padStart(3)}%${w.resetsAt ? `  resets in ${left(w.resetsAt)}` : ""}  [${w.source}, ${Math.round((Date.now() - w.at) / 1000)}s ago${w.stale ? ", STALE" : ""}]`);
    }
  },

  board: async () => {
    const tasks = JSON.parse(await taskOp("hub_task_list", args[0] ? { state: args[0] } : {})) as any[];
    if (!tasks.length) return console.log("no tasks");
    for (const t of tasks) console.log(`#${String(t.id).padEnd(4)} ${t.state.padEnd(18)} ${t.class.padEnd(10)} ${(t.owner ?? "-").padEnd(8)} review:${(t.reviewer ?? "-").padEnd(8)} ${t.title}${t.signals.includes("pii") ? `  (ahub task show ${t.id})` : ""}`);
  },

  task: async () => {
    const [sub, ...rest] = args;
    if (sub === "show") return console.log(await taskOp("task_show", { id: rest[0] }));
    if (sub === "escalate") return console.log(await taskOp("task_escalate", { id: rest[0] }));
    if (sub === "assign") return console.log(await taskOp("task_assign", { id: rest[0], peer: rest[1] }));
    if (sub !== "propose" || rest.length < 1) fail("usage: ahub task propose [<class>] <title...> | show <id> | assign <id> <peer> | escalate <id>");
    // `--class` is the explicit form. A first word that is a class name is still taken as the class (the documented
    // short form), but said out loud: "review the auth module" would otherwise be filed as class review, silently.
    const flags = takeFlags(rest, ["--owner", "--detail", "--class"], ["--path"]);
    const positional = !flags.one["--class"] && (CLASSES as readonly string[]).includes(flags.rest[0] ?? "") && flags.rest.length > 1;
    const cls = flags.one["--class"] ?? (positional ? flags.rest[0] : undefined);
    const title = (positional ? flags.rest.slice(1) : flags.rest).join(" ");
    if (positional) console.error(`note: "${cls}" was taken as the class and left out of the title; use --class <c> when the title itself starts with that word`);
    console.log(await taskOp("hub_task_propose", { ...(cls ? { class: cls } : {}), title, owner: flags.one["--owner"], detail: flags.one["--detail"], ...(flags.many["--path"]?.length ? { refs: { paths: flags.many["--path"] } } : {}) }));
  },

  review: async () => {
    const [id, verdict, ...note] = args;
    if (!id || !verdict) fail("usage: ahub review <id> approved|changes_requested [note...]");
    console.log(await taskOp("hub_review", { id: Number(id), verdict, note: note.join(" ") }));
  },

  remember: async () => console.log(await taskOp("hub_remember", { text: args.join(" ") })),

  ask: async () => {
    const remember = args.includes("--remember");
    const question = args.filter((a) => a !== "--remember").join(" ");
    if (!question.trim()) fail("usage: ahub ask [--remember] <question...>");
    const hub = await connect();
    const res = await hub.request({ t: "ask", question, remember }, 75_000); // above the hub's own budget (probe + 45 s model call)
    hub.close();
    if (!res.ok) fail(res.error);
    console.log(res.answer ?? `(${res.note})`);
    // "Nothing found" means the list did not answer the question: printing it anyway would only look like an answer.
    if (res.evidence.length && (res.found || res.note)) {
      console.log("\nEvidence:");
      for (const e of res.evidence as { id: string; text: string }[]) console.log(`  ${e.id.padEnd(12)} ${e.text.slice(0, 150)}`);
    }
    if (res.pii) console.log("\n(PII is involved: shown here only, not saved anywhere)");
    if (res.saved) console.log(`\n${res.saved}`);
  },

  route: async () => {
    if (args[0] !== "explain") fail("usage: ahub route explain <id> | --class <class> <title...>");
    const flags = takeFlags(args.slice(1), ["--class"], []);
    console.log(await taskOp("route_explain", flags.one["--class"] ? { class: flags.one["--class"], title: flags.rest.join(" ") } : { id: flags.rest[0] }));
  },

  pause: () => hold("pause"),
  resume: () => hold("resume"),

  permit: async () => {
    const [id, option] = args;
    if (!id || !option) fail("usage: ahub permit <id> <option|deny>");
    const hub = await connect();
    hub.send({ t: "permit", id, ...(option === "deny" ? {} : { option }) });
    await hub.request({ t: "status" }); // flush before closing
    hub.close();
  },

  status: async () => {
    if (args.includes("--all")) return printProjects(args.includes("--json"));
    const hub = await connect();
    const { status } = await hub.request({ t: "status" });
    hub.close();
    console.log(`hub pid ${status.pid}, control 127.0.0.1:${status.controlPort}, ${status.cwd}`);
    const peers = Object.entries(status.peers as Record<string, { state: string; queued: number }>);
    for (const [id, p] of peers) console.log(`  ${id.padEnd(8)} ${p.state.padEnd(8)} queued ${p.queued}${(p as any).paused ? `  (${(p as any).paused})` : ""}${(p as any).servedBy ? `  last call: ${(p as any).servedBy}` : ""}`);
    const models = (status as any).models?.backends as any[] | undefined;
    if (models?.length) for (const backend of models) console.log(`  model    ${backend.kind ?? "unknown"}/${backend.alias ?? "unknown"} ${backend.state ?? "unknown"} active ${backend.active ?? 0}${backend.requestedModel ? ` requested ${backend.requestedModel}` : ""}${backend.actualModel ? ` actual ${backend.actualModel}` : ""}${backend.provider ? ` provider ${backend.provider}` : ""}`);
    if (status.switchyard) console.log(`  switchyard: ${status.switchyard}`);
    const counts = Object.entries(status.tasks ?? {}).map(([s, n]) => `${n} ${s}`).join(", ");
    if (counts) console.log(`  tasks: ${counts} (ahub board)`);
    if (!peers.length) console.log("  no peers attached yet (ahub claude | ahub codex | ahub kimi)");
  },

  logs: () => exec("tail", [args.includes("-f") ? "-f" : "-n100", join(stateDir, "hub.log")]),

  kill: async () => {
    const registry = new Registry();
    let project: Project | undefined;
    try { project = registry.list().find((p) => p.root === cwd && p.stateDir === stateDir); }
    finally { registry.close(); }
    if (!project) {
      if (!readControl(stateDir) && !existsSync(join(stateDir, "hub.pid"))) return console.log("hub is not running");
      fail("hub has no matching registration; use its matching CLI to stop it before upgrading");
    }
    await stopProject(project);
    console.log("hub stopped");
  },

  doctor: async () => {
    const version = (bin: string) => {
      const res = spawnSync(bin, ["--version"], { encoding: "utf8" });
      return res.status === 0 ? res.stdout.trim().split("\n")[0]! : undefined;
    };
    const row = (ok: boolean | undefined, name: string, detail: string) =>
      console.log(`  ${ok === undefined ? "?" : ok ? "ok" : "--"}  ${name.padEnd(22)} ${detail}`);

    for (const bin of ["bun", "claude", "codex", "kimi"]) {
      const v = version(bin);
      row(!!v, bin, v ?? "not found on PATH");
    }
    const up = await healthy();
    row(up, "ahub daemon", up ? readControl(stateDir)!.url : "not running (ahub up)");
    const plugin = pluginState(parseList<InstalledPlugin>(spawnSync("claude", ["plugin", "list", "--json"], { encoding: "utf8" }).stdout ?? ""), join(import.meta.dir, "..", ".."));
    row(plugin.state === "current", "claude plugin", plugin.state === "missing" ? "missing: run ahub setup" : plugin.state === "current" ? `agent-hub@agent-hub ${plugin.version}` : `agent-hub@agent-hub is stale (${plugin.why}): run ahub setup`);

    const config = loadConfig(cwd);
    const omni = new OmniRoute(config.omniroute);
    const gateway = await omni.base();
    row(!!gateway, "omniroute", gateway ? `${new URL(gateway).host} healthy` : config.omniroute.urls.length || process.env.AGENTHUB_OMNIROUTE_URL ? "no candidate reachable (VPN off?); ahub local cannot run" : "not configured: set omniroute.urls in .agenthub/config.json (any OpenAI-compatible gateway); ahub local cannot run");
    row(!!omni.apiKey(), "omniroute key", omni.apiKey() ? "present" : "missing: set OMNIROUTE_API_KEY or omniroute.api_key_file in .agenthub/config.json");
    const sy = spawnSync(process.env.AGENTHUB_SWITCHYARD_BIN ?? "switchyard-server", ["--version"], { encoding: "utf8" });
    row(sy.status === 0 ? true : undefined, "switchyard", sy.status === 0 ? sy.stdout.trim() : "not installed: ahub local uses fixed_model on OmniRoute (cargo install --locked switchyard-server)");
    const mlx = await inspectMlx();
    row(mlx.state === "ready" || mlx.state === "stopped", "pi mlx", `${mlx.state}${mlx.model ? ` (${mlx.model})` : ""}${mlx.lastError ? `: ${mlx.lastError}` : ""}`);

    const memory = new MemoryClient();
    const mem = await memory.health();
    row(mem.ok, "memory worker", mem.ok ? `claude-mem ${mem.version ?? ""} at ${memory.url}` : `unavailable at ${memory.url} (the hub works without it)`);
    const bridge = spawnSync("dot", ["ai", "memory", "status"], { encoding: "utf8" });
    const out = bridge.error ? "" : bridge.stdout.replace(/\x1b\[[0-9;]*m/g, "");
    for (const tool of ["codex", "kimi"]) {
      row(bridge.error ? undefined : new RegExp(`✓\\s+${tool} ready`).test(out), `memory capture: ${tool}`, bridge.error ? "unknown (`dot ai memory status` not available)" : "per `dot ai memory status`");
    }
  },
};

const run = commands[cmd] ?? (() => fail(`unknown command "${cmd}"\n\n${USAGE}`));
try {
  await run();
} catch (e) {
  fail((e as Error).message);
}
