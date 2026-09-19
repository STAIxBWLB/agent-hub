#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, readControl } from "../hub/control-client.ts";
import { loadConfig, startDaemon, stateDirFor } from "../hub/daemon.ts";
import type { BusEvent } from "../hub/bus.ts";
import { allocatePorts, CODEX_APP, CODEX_PROXY, CONTROL } from "../hub/ports.ts";
import { MemoryClient } from "../memory/client.ts";
import { init } from "./init.ts";
import { buildLaunch, UNATTENDED_WARNING } from "./launch.ts";

const USAGE = `agent-hub: Claude Code, Codex and Kimi as peers in one project directory

  hub init                     write .agenthub/config.json and the CLAUDE.md / AGENTS.md marker blocks
  hub up [--unattended]        start the daemon for this directory
  hub claude [args...]         launch Claude Code with the hub channel   [--unattended]
  hub codex [args...]          start the Codex adapter and attach the TUI [--unattended]
  hub kimi [--model <alias>]   start Kimi headless under ACP
  hub say [@peer ...] <text>   send as the console user (no @peer = broadcast); delivered at once,
                               start the text with [STATUS] to let it batch or [FYI] for the record only
  hub pause|resume <peer>      hold a peer's deliveries in its queue / release them
  hub tail                     live stream of messages, states and permission requests
  hub permit <id> <option>     answer a permission request shown by tail ("deny" cancels)
  hub status | logs [-f] | doctor | kill`;

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
  console.error(`hub: ${message}`);
  process.exit(1);
}

function render(e: BusEvent): string {
  if (e.t === "state") return `  . ${e.peer} is ${e.state}`;
  if (e.t === "undeliverable") return `  ! gave up delivering ${e.env.id} (from ${e.env.from}) to ${e.peer}`;
  if (e.t === "overflow") return `  ! ${e.peer}'s queue is full: dropped ${e.env.id} (from ${e.env.from})`;
  const { env } = e;
  const note = e.dropped === "hop" ? " [not delivered: hop limit]" : e.dropped === "fyi" ? " [fyi: record only]" : "";
  const head = `${env.from} -> ${env.to?.join(",") ?? "*"}${env.priority === "important" ? " !" : ""}${note}`;
  return `${new Date(env.ts).toLocaleTimeString()} ${head}\n${env.body.replace(/^/gm, "    ")}`;
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

  init: () => {
    const changed = init(cwd);
    console.log(changed.length ? changed.map((p) => `wrote ${p}`).join("\n") : "already up to date");
  },

  // Internal: the detached daemon process started by `hub up`.
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
      if (await healthy()) return console.log(`hub up (${readControl(stateDir)!.url}), state in ${stateDir}`);
      await Bun.sleep(100);
    }
    fail(`daemon did not start; see ${join(stateDir, "hub.log")}`);
  },

  claude: () => {
    const launch = buildLaunch("claude", args, { unattended: unattendedEnv });
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
    console.log(res.already ? "kimi is already attached" : 'kimi attached (headless). Talk to it with: hub say @kimi "..."');
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
      else if (msg.t === "permission") {
        const options = msg.options.map((o: any) => `${o.optionId} (${o.name})`).join(", ");
        console.log(`  ? ${msg.peer} asks permission: ${msg.title}\n    answer with: hub permit ${msg.id} <${options}> | deny`);
      }
    };
    hub.onClose = () => process.exit(0);
    hub.send({ t: "tail" });
    await new Promise(() => {});
  },

  pause: () => hold("pause"),
  resume: () => hold("resume"),

  permit: async () => {
    const [id, option] = args;
    if (!id || !option) fail("usage: hub permit <id> <option|deny>");
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
    for (const [id, p] of peers) console.log(`  ${id.padEnd(8)} ${p.state.padEnd(8)} queued ${p.queued}`);
    if (!peers.length) console.log("  no peers attached yet (hub claude | hub codex | hub kimi)");
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
    if (/main\.ts daemon|hub daemon/.test(owner)) {
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
    row(up, "hub daemon", up ? readControl(stateDir)!.url : "not running (hub up)");
    const plugins = spawnSync("claude", ["plugin", "list"], { encoding: "utf8" }).stdout ?? "";
    row(plugins.includes("agent-hub@agent-hub"), "claude plugin", plugins.includes("agent-hub@agent-hub") ? "agent-hub@agent-hub installed" : "missing: see docs/smoke.md, Install");

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
