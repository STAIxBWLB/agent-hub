import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { configureJcodeMcp, JCODE_MCP_FILE, JCODE_MCP_NAME } from "../src/cli/jcode-mcp.ts";

// issue #685 (scope update 2) and #368: extra Jcode instances started through the daemon. The person authenticates inside Jcode;
// the hub passes -p, -m and --provider-profile as written, and a hub-tools socket is admitted only for an owned launch.
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const root = () => { const dir = mkdtempSync(join(tmpdir(), "ahub-jcode-inst-d-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const fake = [process.execPath, join(import.meta.dir, "fakes/jcode-instance-agent.ts")];
const bundle = join(import.meta.dir, "../plugins/agent-hub/server.js");
const rows = (file: string) => readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(10); expect(condition()).toBe(true); };

async function hub(extraInstances: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const dir = root(), stateDir = join(dir, "state"), baseHome = join(dir, "home-base"), localHome = join(dir, "home-local"), claudeHome = join(dir, "home-claude");
  const record = join(dir, "record.jsonl");
  for (const home of [baseHome, localHome, claudeHome]) { mkdirSync(home); writeFileSync(join(home, "mcp.json"), "{}"); }
  // A verifier runs in the project root; an extra implementer would need an explicit managed worktree (instance-execution.ts).
  const instances = {
    "jcode-local": { kind: "jcode", jcode_home: localHome, provider_profile: "onprem", start_mode: "headless", roles: ["verifier"] },
    "jcode-claude": { kind: "jcode", jcode_home: claudeHome, provider: "claude", model: "claude-sonnet-5-5", start_mode: "headless", roles: ["verifier"] },
    ...extraInstances,
  };
  const daemon = await startDaemon({ cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, instances, jcode_cmd: [...fake, "--record", record], jcode_home: baseHome, roster: { jcode: true, "jcode-local": true, "jcode-claude": true }, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, ...extra } as never });
  cleanups.push(() => daemon.stop());
  configureJcodeMcp(dir, stateDir, bundle);
  const console_ = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => console_.close());
  return { dir, stateDir, daemon, console_, record, baseHome, localHome, claudeHome };
}
const launches = (record: string, peer: string, role: "serve" | "acp") => rows(record).filter(row => row.kind === "launch" && row.role === role && row.peer === peer);

test("an instance's argv is the base Jcode argv plus its own -p, -m and --provider-profile, with its own home and socket (#685)", async () => {
  const { console_, record, localHome, claudeHome } = await hub();
  for (const peer of ["jcode-local", "jcode-claude"]) expect((await console_.request({ t: "start", peer, args: { mode: "headless" } })).ok, peer).toBe(true);
  const local = launches(record, "jcode-local", "acp")[0], claude = launches(record, "jcode-claude", "acp")[0];
  expect(local.home).toBe(localHome); expect(claude.home).toBe(claudeHome);
  expect(local.socket).not.toBe(claude.socket);
  // Only the declared values are passed, exactly as written.
  expect(local.argv).toEqual(expect.arrayContaining(["--provider-profile", "onprem"])); expect(local.argv).not.toContain("-p"); expect(local.argv).not.toContain("--model");
  expect(claude.argv).toEqual(expect.arrayContaining(["-p", "claude", "--model", "claude-sonnet-5-5"])); expect(claude.argv).not.toContain("--provider-profile");
  // The hub sets no model URL or key for either.
  for (const row of [local, claude]) { expect(row.compatBase).toBeUndefined(); expect(row.compatKey).toBeUndefined(); }
});

test("two instances and the base run at once with separate groups; stopping one leaves the others (#685)", async () => {
  const { console_, record, daemon } = await hub();
  for (const peer of ["jcode", "jcode-local", "jcode-claude"]) expect((await console_.request({ t: "start", peer, args: { mode: "headless" } })).ok, peer).toBe(true);
  const servers = rows(record).filter(row => row.kind === "serve");
  expect(new Set(servers.map(row => row.socket)).size).toBe(3);
  const stopped = await console_.request({ t: "peer_stop", peer: "jcode-local" });
  expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
  expect(daemon.bus.stateOf("jcode-local")).toBe("offline");
  for (const peer of ["jcode", "jcode-claude"]) expect(daemon.bus.stateOf(peer)).not.toBe("offline");
});

test("a start with a missing or foreign-kind jcode_home is refused and nothing is started (#685)", async () => {
  const { console_, record, localHome, daemon } = await hub();
  rmSync(localHome, { recursive: true });
  const missing = await console_.request({ t: "start", peer: "jcode-local", args: { mode: "headless" } });
  expect(missing.ok).toBe(false); expect(String(missing.error)).toContain("jcode_home"); expect(String(missing.error)).not.toContain(localHome);
  writeFileSync(localHome, "a file, not a directory");
  const file = await console_.request({ t: "start", peer: "jcode-local", args: { mode: "headless" } });
  expect(file.ok).toBe(false); expect(String(file.error)).toContain("jcode_home");
  expect(() => readFileSync(record, "utf8")).toThrow(); // the fake jcode never ran
  expect(daemon.bus.stateOf("jcode-local") ?? "offline").toBe("offline");
});

test("the start preflight reads and writes nothing under jcode_home (#685)", async () => {
  const { console_, claudeHome, localHome } = await hub();
  const tree = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: false }).map(String).sort();
  const before = { local: tree(localHome), claude: tree(claudeHome) };
  const modified = statSync(join(claudeHome, "mcp.json")).mtimeMs;
  chmodSync(claudeHome, 0o700);
  expect((await console_.request({ t: "start", peer: "jcode-claude", args: { mode: "headless" } })).ok).toBe(true);
  // Only the fake Jcode (the native client) may create files in its home; the hub's own preflight left the unstarted home untouched.
  expect(tree(localHome)).toEqual(before.local);
  expect(statSync(join(claudeHome, "mcp.json")).mtimeMs).toBe(modified);
});

test("status shows each instance's declared provider, model and profile, and no URL, token or home path (#685)", async () => {
  const { console_, localHome, claudeHome } = await hub();
  for (const peer of ["jcode-local", "jcode-claude"]) expect((await console_.request({ t: "start", peer, args: { mode: "headless" } })).ok).toBe(true);
  const status = (await console_.request({ t: "status" })).status;
  expect(status.peers["jcode-local"].modelSource).toBe("profile onprem");
  expect(status.peers["jcode-claude"].modelSource).toBe("claude claude-sonnet-5-5");
  expect(status.peers.jcode?.modelSource).toBeUndefined();
  const text = JSON.stringify(status);
  for (const secret of [localHome, claudeHome]) expect(text).not.toContain(secret);
});

test("an extra Jcode implementer needs a managed worktree like every extra implementer; the refusal starts nothing (#685)", async () => {
  const { console_, record } = await hub({ "jcode-local": { kind: "jcode", jcode_home: "/nonexistent-never-read", roles: ["implementer"], start_mode: "headless" } });
  const reply = await console_.request({ t: "start", peer: "jcode-local", args: { mode: "headless" } });
  expect(reply.ok).toBe(false);
  expect(() => readFileSync(record, "utf8")).toThrow();
});

/** What a hub-tools socket needs (#368): the peer id from the owned process env and that launch's id. */
test("a hub-tools hello for an owned Jcode is admitted only with the launch id of that peer's current owned launch (#368)", async () => {
  const { console_, record, stateDir } = await hub();
  expect((await console_.request({ t: "start", peer: "jcode-local", args: { mode: "headless" } })).ok).toBe(true);
  const owned = launches(record, "jcode-local", "acp")[0];
  expect(owned.launch).toBeString();
  const ok = await ControlClient.connect(stateDir, { role: "tools", peer: "jcode-local", launchId: owned.launch }); cleanups.push(() => ok.close());
  expect((await ok.request({ t: "send", body: "owned launch", to: [] })).ok).toBe(true);
  // A process that sets AGENTHUB_PEER_ID=jcode-local but has no owned launch (none, a forged one, another peer's) is refused.
  const claude = await console_.request({ t: "start", peer: "jcode-claude", args: { mode: "headless" } });
  expect(claude.ok).toBe(true);
  const otherLaunch = launches(record, "jcode-claude", "acp")[0].launch;
  for (const launchId of [undefined, "forged-launch-id", otherLaunch, ""]) {
    await expect(ControlClient.connect(stateDir, { role: "tools", peer: "jcode-local", ...(launchId === undefined ? {} : { launchId }) }), String(launchId)).rejects.toThrow(/owned launch|not an owned/);
  }
  // The base peer is bound the same way.
  expect((await console_.request({ t: "start", peer: "jcode", args: { mode: "headless" } })).ok).toBe(true);
  await expect(ControlClient.connect(stateDir, { role: "tools", peer: "jcode" })).rejects.toThrow(/owned launch|not an owned/);
});

test("a forged AGENTHUB_PEER_ID with no owned launch is refused, even for an offline instance and the base peer (#368)", async () => {
  const { stateDir } = await hub();
  for (const peer of ["jcode-local", "jcode"]) {
    await expect(ControlClient.connect(stateDir, { role: "tools", peer, launchId: "forged" }), peer).rejects.toThrow(/owned launch|not an owned/);
  }
  // Other kinds keep the existing tools admission: their entries carry the id and no launch id.
  const codex = await ControlClient.connect(stateDir, { role: "tools", peer: "codex" }); cleanups.push(() => codex.close());
});

test("a stopped owned launch no longer admits its launch id (#368)", async () => {
  const { console_, record, stateDir } = await hub();
  expect((await console_.request({ t: "start", peer: "jcode-local", args: { mode: "headless" } })).ok).toBe(true);
  const owned = launches(record, "jcode-local", "acp")[0].launch;
  expect((await console_.request({ t: "peer_stop", peer: "jcode-local" })).ok).toBe(true);
  await expect(ControlClient.connect(stateDir, { role: "tools", peer: "jcode-local", launchId: owned })).rejects.toThrow(/owned launch|not an owned/);
});

test("the shared MCP server run with no AGENTHUB_PEER_ID refuses every hub tool and never connects as jcode, and a forged id has no owned launch (#368)", async () => {
  const { dir, stateDir, console_, record } = await hub();
  expect((await console_.request({ t: "start", peer: "jcode-local", args: { mode: "headless" } })).ok).toBe(true);
  const entry = JSON.parse(readFileSync(join(dir, JCODE_MCP_FILE), "utf8")).mcpServers[JCODE_MCP_NAME];
  expect(entry.env).not.toHaveProperty("AGENTHUB_PEER_ID");
  const run = async (env: Record<string, string | undefined>) => {
    const clean = { ...process.env } as Record<string, string | undefined>;
    for (const name of ["AGENTHUB_PEER_ID", "AGENTHUB_LAUNCH_ID", "AGENTHUB_CHANNEL", "CLAUDECODE"]) delete clean[name];
    const transport = new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(Object.entries({ ...clean, ...entry.env, ...env }).filter(([, v]) => v !== undefined)) as Record<string, string>, stderr: "pipe" });
    let diagnostics = ""; transport.stderr?.on("data", data => { diagnostics += String(data); });
    const client = new Client({ name: "fixture", version: "1" }); cleanups.push(() => client.close());
    await client.connect(transport);
    return { client, diagnostics: () => diagnostics };
  };
  // A person's own jcode started outside the hub: no peer id at all.
  const anonymous = await run({});
  const refused = await anonymous.client.callTool({ name: "hub_send", arguments: { text: "NO_IDENTITY" } });
  expect(refused.isError).toBe(true); expect(JSON.stringify(refused)).toContain("no AGENTHUB_PEER_ID");
  await Bun.sleep(300);
  expect(anonymous.diagnostics()).not.toContain("connected to hub");
  // A forged peer id with no owned launch id connects to nothing.
  const forged = await run({ AGENTHUB_PEER_ID: "jcode-local" });
  await until(() => forged.diagnostics().includes("not an owned launch"));
  expect(forged.diagnostics()).not.toContain("connected to hub");
  // The owned launch's own env (peer id and launch id) is admitted.
  const owned = launches(record, "jcode-local", "acp")[0];
  const genuine = await run({ AGENTHUB_PEER_ID: "jcode-local", AGENTHUB_LAUNCH_ID: owned.launch });
  await until(() => genuine.diagnostics().includes('connected to hub as "jcode-local"'));
  expect(existsSync(stateDir)).toBe(true);
});
