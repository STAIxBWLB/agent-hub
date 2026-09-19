#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, readControl } from "../hub/control-client.ts";
import { loadConfig, startDaemon, stateDirFor } from "../hub/daemon.ts";
import type { BusEvent } from "../hub/bus.ts";
import { allocatePorts, CODEX_APP, CODEX_PROXY, CONTROL, SWITCHYARD } from "../hub/ports.ts";
import { OmniRoute } from "../omniroute/client.ts";
import { MemoryClient } from "../memory/client.ts";
import { init } from "./init.ts";
import { buildLaunch, UNATTENDED_WARNING } from "./launch.ts";
import { pluginVersion, setupPlan } from "./setup.ts";
import { VERSION } from "../version.ts";
import { createInterface } from "node:readline/promises";

const USAGE = `agent-hub ${VERSION}: Claude Code, Codex and Kimi as peers in one project directory

  ahub setup [--yes]            install or update the Claude Code channel plugin from this package, then run doctor
  ahub init                     write .agenthub/config.json and the CLAUDE.md / AGENTS.md marker blocks
  ahub up [--unattended]        start the daemon for this directory
  ahub claude [args...]         launch Claude Code with the hub channel   [--unattended]
  ahub codex [args...]          start the Codex adapter and attach the TUI [--unattended]
  ahub kimi [--model <alias>]   start Kimi headless under ACP
  ahub local [--route <id> | --model <id>]
                               start the hub-native worker on the self-hosted models (routing.toml)
  ahub say [@peer ...] <text>   send as the console user (no @peer = broadcast); delivered at once,
                               start the text with [STATUS] to let it batch or [FYI] for the record only
  ahub pause|resume <peer>      hold a peer's deliveries in its queue / release them
  ahub budget                   quota windows per peer, and who is paused until when
  ahub budget set <peer> <0..1> [--resets-in 30m] [--window 5h|week]   feed a reading by hand (also: test the relay)
  ahub budget resume <peer>     override a budget pause; readings are ignored for that peer until the window resets
  ahub board [state]            the task board
  ahub task propose [<class>] <title...> [--owner <peer>] [--path <p>]... [--detail <text>]
  ahub task show|escalate <id>  full task with history (PII text included) / hand it to the next peer in escalate_to
  ahub task assign <id> <peer>  give a task to a peer yourself
  ahub review <id> approved|changes_requested [note...]
  ahub remember <text...>       save a note to the memory all agents share
  ahub route explain <id>       why a task went where it went
  ahub route explain --class <c> <title...>   what would happen to such a task now
  ahub tail                     live stream of messages, states and permission requests
  ahub permit <id> <option>     answer a permission request shown by tail ("deny" cancels)
  ahub status | logs [-f] | doctor | kill`;

const cwd = process.cwd();
const stateDir = stateDirFor(cwd);
const unattendedEnv = process.env.AGENTHUB_UNATTENDED === "1";
const [cmd = "help", ...args] = process.argv.slice(2);

const connect = () => ControlClient.connect(stateDir, { role: "console" });

async function healthy(): Promise<boolean> {
  const control = readControl(stateDir);
  if (!control) return false;
  return fetch(control.url.replace("ws:", "http:") + "/healthz").then((r) => r.ok, () => false);
}

function exec(bin: string, argv: string[]): never {
  const res = spawnSync(bin, argv, { stdio: "inherit", env: { ...process.env, AGENTHUB_STATE_DIR: stateDir } });
  if (res.error) fail(`cannot run ${bin}: ${res.error.message}`);
  process.exit(res.status ?? 1);
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

const commands: Record<string, () => Promise<void> | void> = {
  help: () => console.log(USAGE),
  "--version": () => console.log(VERSION),
  version: () => console.log(VERSION),

  setup: async () => {
    const root = join(import.meta.dir, "..", "..");
    const out = (argv: string[]) => spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" }).stdout ?? "";
    const steps = setupPlan(out(["claude", "plugin", "list"]), out(["claude", "plugin", "marketplace", "list"]), root);
    if (!steps.length) console.log(`Claude Code plugin agent-hub@agent-hub ${VERSION} is installed from this package.`);
    else {
      console.log("ahub setup will run:");
      for (const s of steps) console.log(`  ${s.argv.join(" ")}\n      ${s.why}`);
      if (!args.includes("--yes")) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question("Proceed? [y/N] ")).trim().toLowerCase();
        rl.close();
        if (answer !== "y" && answer !== "yes") return console.log("nothing was changed");
      }
      for (const s of steps) {
        const res = spawnSync(s.argv[0]!, s.argv.slice(1), { stdio: "inherit" });
        if (res.status !== 0) fail(`"${s.argv.join(" ")}" failed; nothing after it was run`);
      }
    }
    await commands.doctor!();
  },

  init: () => {
    const changed = init(cwd);
    console.log(changed.length ? changed.map((p) => `wrote ${p}`).join("\n") : "already up to date");
  },

  // Internal: the detached daemon process started by `ahub up`.
  daemon: async () => {
    // Long-lived process: one bad adapter callback must not take every peer down. stderr is hub.log.
    process.on("unhandledRejection", (e) => console.error(`${new Date().toISOString()} unhandled rejection:`, e));
    process.on("uncaughtException", (e) => console.error(`${new Date().toISOString()} uncaught exception:`, e));
    const base = allocatePorts(cwd);
    const daemon = await startDaemon({
      cwd,
      stateDir,
      controlPort: base + CONTROL,
      codexAppPort: base + CODEX_APP,
      codexProxyPort: base + CODEX_PROXY,
      switchyardPort: base + SWITCHYARD,
      unattended: unattendedEnv || args.includes("--unattended"),
    });
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void daemon.stop());
    await daemon.stopped;
    process.exit(0);
  },

  up: async () => {
    if (await healthy()) return console.log("hub is already running");
    const unattended = unattendedEnv || args.includes("--unattended");
    if (unattended) console.error(UNATTENDED_WARNING);
    mkdirSync(stateDir, { recursive: true });
    const log = openSync(join(stateDir, "hub.log"), "a");
    spawn(process.execPath, [import.meta.path, "daemon", ...(unattended ? ["--unattended"] : [])], {
      cwd,
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, AGENTHUB_STATE_DIR: stateDir },
    }).unref();
    for (let i = 0; i < 50; i++) {
      if (await healthy()) return console.log(`ahub up (${readControl(stateDir)!.url}), state in ${stateDir}`);
      await Bun.sleep(100);
    }
    fail(`daemon did not start; see ${join(stateDir, "hub.log")}`);
  },

  claude: () => {
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
    const launch0 = buildLaunch("codex", args, { unattended: unattendedEnv, proxyUrl: "pending" }); // refuse bad flags before starting anything
    const hub = await connect();
    const res = await hub.request({ t: "start", peer: "codex" });
    hub.close();
    if (!res.ok) fail(res.error);
    const launch = buildLaunch("codex", args, { unattended: unattendedEnv, proxyUrl: res.proxyUrl, codexBin: loadConfig(cwd).codex_bin });
    if (launch0.warning) console.error(launch0.warning);
    exec(launch.cmd, launch.args);
  },

  kimi: async () => {
    const i = args.indexOf("--model");
    const model = i === -1 ? undefined : args[i + 1] ?? fail("--model needs an alias");
    const hub = await connect();
    const res = await hub.request({ t: "start", peer: "kimi", args: { model } });
    hub.close();
    if (!res.ok) fail(res.error);
    console.log(res.already ? "kimi is already attached" : 'kimi attached (headless). Talk to it with: ahub say @kimi "..."');
  },

  local: async () => {
    const opt = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] ?? fail(`${flag} needs a value`) : undefined);
    const hub = await connect();
    const res = await hub.request({ t: "start", peer: "local", args: { route: opt("--route"), model: opt("--model") } });
    hub.close();
    if (!res.ok) fail(res.error);
    console.log(res.already ? "local is already attached" : `local attached on ${res.model}. Give it work with: ahub say @local "..."`);
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
    // The class is optional: a first word that is not a class belongs to the title, and the hub's model names the class.
    const hasClass = ["plan", "implement", "bulk_edit", "test", "review", "summarize", "triage"].includes(rest[0]!);
    const flags = takeFlags(hasClass ? rest.slice(1) : rest, ["--owner", "--detail"], ["--path"]);
    console.log(await taskOp("hub_task_propose", { ...(hasClass ? { class: rest[0] } : {}), title: flags.rest.join(" "), owner: flags.one["--owner"], detail: flags.one["--detail"], ...(flags.many["--path"]?.length ? { refs: { paths: flags.many["--path"] } } : {}) }));
  },

  review: async () => {
    const [id, verdict, ...note] = args;
    if (!id || !verdict) fail("usage: ahub review <id> approved|changes_requested [note...]");
    console.log(await taskOp("hub_review", { id: Number(id), verdict, note: note.join(" ") }));
  },

  remember: async () => console.log(await taskOp("hub_remember", { text: args.join(" ") })),

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
    const hub = await connect();
    const { status } = await hub.request({ t: "status" });
    hub.close();
    console.log(`hub pid ${status.pid}, control 127.0.0.1:${status.controlPort}, ${status.cwd}`);
    const peers = Object.entries(status.peers as Record<string, { state: string; queued: number }>);
    for (const [id, p] of peers) console.log(`  ${id.padEnd(8)} ${p.state.padEnd(8)} queued ${p.queued}${(p as any).paused ? `  (${(p as any).paused})` : ""}${(p as any).servedBy ? `  last call: ${(p as any).servedBy}` : ""}`);
    if (status.switchyard) console.log(`  switchyard: ${status.switchyard}`);
    const counts = Object.entries(status.tasks ?? {}).map(([s, n]) => `${n} ${s}`).join(", ");
    if (counts) console.log(`  tasks: ${counts} (ahub board)`);
    if (!peers.length) console.log("  no peers attached yet (ahub claude | ahub codex | ahub kimi)");
  },

  logs: () => exec("tail", [args.includes("-f") ? "-f" : "-n100", join(stateDir, "hub.log")]),

  kill: async () => {
    const hub = await connect().catch(() => undefined);
    if (hub) {
      hub.send({ t: "kill" });
      await new Promise<void>((r) => (hub.onClose = r));
      return console.log("hub stopped");
    }
    const pidFile = join(stateDir, "hub.pid");
    if (!existsSync(pidFile)) return console.log("hub is not running");
    // The pid file may be stale and the pid reused: signal it only if it still is a hub daemon.
    const pid = Number(readFileSync(pidFile, "utf8"));
    const owner = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout ?? "";
    if (/main\.ts daemon|ahub daemon/.test(owner)) {
      process.kill(pid, "SIGTERM");
      return console.log("hub signalled");
    }
    for (const f of ["hub.pid", "status.json", "control-token"]) rmSync(join(stateDir, f), { force: true });
    console.log("hub is not running (removed stale state files)");
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
    const installed = pluginVersion(spawnSync("claude", ["plugin", "list"], { encoding: "utf8" }).stdout ?? "");
    row(installed === VERSION, "claude plugin", !installed ? "missing: run ahub setup" : installed === VERSION ? `agent-hub@agent-hub ${installed}` : `agent-hub@agent-hub ${installed}, this hub is ${VERSION}: run ahub setup`);

    const config = loadConfig(cwd);
    const omni = new OmniRoute(config.omniroute);
    const gateway = await omni.base();
    row(!!gateway, "omniroute", gateway ? `${new URL(gateway).host} healthy` : config.omniroute.urls.length || process.env.AGENTHUB_OMNIROUTE_URL ? "no candidate reachable (VPN off?); ahub local cannot run" : "not configured: set omniroute.urls in .agenthub/config.json (any OpenAI-compatible gateway); ahub local cannot run");
    row(!!omni.apiKey(), "omniroute key", omni.apiKey() ? "present" : "missing: set OMNIROUTE_API_KEY or omniroute.api_key_file in .agenthub/config.json");
    const sy = spawnSync(process.env.AGENTHUB_SWITCHYARD_BIN ?? "switchyard-server", ["--version"], { encoding: "utf8" });
    row(sy.status === 0 ? true : undefined, "switchyard", sy.status === 0 ? sy.stdout.trim() : "not installed: ahub local uses fixed_model on OmniRoute (cargo install --locked switchyard-server)");

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
