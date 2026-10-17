import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { initialConsoleState, reduceConsole, renderConsole } from "../src/cli/console-state.ts";
import { renderStatus } from "../src/cli/output.ts";
import { BasePeer } from "../src/hub/peers.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
class Peer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver() {}
}

async function hub(extra: Record<string, unknown> = {}) {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-planner-"))), state = join(dir, ".agenthub/state");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  const shared = JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, mlx: { enabled: false }, snapshots: { enabled: false }, ...extra });
  writeFileSync(join(dir, ".agenthub/config.json"), shared);
  const daemon = await startDaemon({ cwd: dir, stateDir: state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...loadConfig(dir), batch_ms: 0 } });
  cleanup.push(() => daemon.stop());
  const connect = async (role: "console" | "tools", peer?: string) => { const c = await ControlClient.connect(state, { role, ...(peer ? { peer } : {}) }); cleanup.push(() => c.close()); return c; };
  const tools = async (id: string) => { const peer = new Peer(id); daemon.bus.add(peer); await peer.start(); return connect("tools", id); };
  const person = await connect("console"), codex = await tools("codex");
  const status = async () => (await person.request({ t: "status" })).status;
  const plans = async (client: ControlClient) => (await client.request({ t: "task", op: "hub_backlog_list", args: {} })).ok;
  return { dir, shared, person, codex, tools, status, plans };
}

test("the planner key is validated and exclusive at load (#455)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-planner-load-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  for (const bad of ["pi", "local", "nobody", 3]) {
    writeFileSync(join(dir, ".agenthub/config.json"), JSON.stringify({ planner: bad }));
    expect(() => loadConfig(dir)).toThrow("planner must be one of");
  }
  writeFileSync(join(dir, ".agenthub/config.json"), JSON.stringify({ planner: "claude" }));
  writeFileSync(join(dir, ".agenthub/config.local.json"), JSON.stringify({ planner: "kimi" }));
  expect(loadConfig(dir).planner).toBe("kimi"); // the machine's own file wins
});

test("default roles keep claude as planner; the setting moves planning authority live and undo puts it back (#455)", async () => {
  const f = await hub(), claude = await f.tools("claude");
  expect((await f.status()).planner).toEqual({ peers: ["claude"], source: "roles" });
  expect(await f.plans(claude)).toBe(true); expect(await f.plans(f.codex)).toBe(false);

  expect((await f.codex.request({ t: "settings_set", key: "planner", value: "codex" })).ok).toBe(false); // agents never change it
  expect((await f.person.request({ t: "settings_set", key: "planner", value: "pi" })).ok).toBe(false);
  const set = await f.person.request({ t: "settings_set", key: "planner", value: "codex" });
  expect(set).toMatchObject({ ok: true }); expect(set.text).toContain("in force now");
  expect(JSON.parse(readFileSync(join(f.dir, ".agenthub/config.local.json"), "utf8")).planner).toBe("codex");
  expect(readFileSync(join(f.dir, ".agenthub/config.json"), "utf8")).toBe(f.shared);
  const s = await f.status();
  expect(s.planner).toEqual({ peers: ["codex"], source: "setting" });
  expect(s.roleInfo.claude.flowRoles).toEqual(["reviewer"]); expect(s.roleInfo.codex).toMatchObject({ flowRoles: ["planner", "implementer"], planner: "setting" });
  expect(await f.plans(f.codex)).toBe(true); expect(await f.plans(claude)).toBe(false);
  const row = (await f.person.request({ t: "settings_get" })).rows.find((r: any) => r.key === "planner");
  expect(row).toMatchObject({ value: "codex", group: "Roles", risk: "raises" }); expect(row.hint).toContain("codex (setting)");

  expect((await f.person.request({ t: "settings_undo" })).ok).toBe(true);
  expect((await f.status()).planner).toEqual({ peers: ["claude"], source: "roles" });
  expect(await f.plans(claude)).toBe(true); expect(await f.plans(f.codex)).toBe(false);
});

test("with the roles planner off the roster the hub assigns one automatically and follows roster changes (#455)", async () => {
  const f = await hub({ roster: { claude: false } });
  expect((await f.status()).planner).toEqual({ peers: ["codex"], source: "automatic" });
  expect(await f.plans(f.codex)).toBe(true);
  expect((await f.person.request({ t: "settings_set", key: "roster.claude", value: true })).ok).toBe(true);
  expect((await f.status()).planner).toEqual({ peers: ["claude"], source: "roles" });
  expect(await f.plans(f.codex)).toBe(false); expect(await f.plans(await f.tools("claude"))).toBe(true);
  expect(renderStatus({ peers: {}, planner: { peers: ["codex"], source: "automatic" } }, 120).flat().map(s => s.text).join("")).toContain("pin it with ahub settings set planner <peer>");
});

test("console marks the planner and l then y runs the setting as a terminal command (#455)", () => {
  const s = initialConsoleState(true); s.panel = 1;
  s.peers = { claude: { state: "idle", flowRoles: ["planner", "reviewer"], planner: "roles" }, codex: { state: "idle", flowRoles: ["implementer"] }, pi: { state: "idle" } };
  expect(renderConsole(s, 160, 24, 0).join("\n")).toContain("claude (planner)");
  s.selection = 0; expect(reduceConsole(s, "l", 0).state.notice).toContain("already the planner");
  s.selection = 2; expect(reduceConsole(s, "l", 0).state.notice).toContain("pi cannot plan");
  s.selection = 1;
  const asked = reduceConsole(s, "l", 0);
  expect(asked.state.confirm).toEqual({ type: "command", args: ["settings", "set", "planner", "codex"], prompt: "make codex the planner" });
  expect(reduceConsole(asked.state, "y", 0).effects).toEqual([{ type: "command", args: ["settings", "set", "planner", "codex"] }]);
});
