import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_CONFIG, startDaemon, type HubConfig } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import type { InstancesConfig } from "../src/hub/instances.ts";
import type { Envelope } from "../src/hub/envelope.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(condition: () => boolean, name: string) {
  for (let attempt = 0; attempt < 500 && !condition(); attempt++) await Bun.sleep(10);
  expect(condition(), name).toBe(true);
}
function freePort() { const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const port = probe.port!; probe.stop(true); return port; }
const reviewers: InstancesConfig = { "codex-a": { kind: "codex", roles: ["reviewer"], start_mode: "headless" }, "codex-b": { kind: "codex", roles: ["reviewer"], start_mode: "headless" } };
async function fixture(instances: InstancesConfig = reviewers, overrides: Partial<HubConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), "ahub-instance-daemon-")), stateDir = join(root, "state"), record = join(root, "spawn.jsonl"), bin = join(root, "fake-codex");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  // Record identities and endpoint metadata only, never the control token or complete MCP environment.
  writeFileSync(bin, `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nconst args=process.argv.slice(2),env=args.find(arg=>arg.startsWith("mcp_servers.agent-hub.env="))??"";\nappendFileSync(${JSON.stringify(record)},JSON.stringify({peer:process.env.AGENTHUB_PEER_ID,mcpPeer:env.match(/AGENTHUB_PEER_ID="([^"]+)"/)?.[1],listen:args[args.indexOf("--listen")+1]})+"\\n");\nawait import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "fakes/codex-bin.ts")).href)});\n`, { mode: 0o700 });
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: freePort(), codexProxyPort: freePort(), switchyardPort: 0,
    config: { ...DEFAULT_CONFIG, instances, codex_bin: bin, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, ...overrides } });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console", projectRoot: root }); cleanup.push(() => console_.close());
  const spawned = () => existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { peer: string; mcpPeer: string; listen: string }) : [];
  const start = async (peer: string) => {
    const result = await console_.request({ t: "start", peer }); expect(result).toMatchObject({ ok: true });
    expect(typeof result.proxyUrl).toBe("string");
    const seen: any[] = [], tui = new WebSocket(result.proxyUrl);
    tui.onmessage = event => { seen.push(JSON.parse(String(event.data))); };
    cleanup.push(() => tui.close());
    await new Promise<void>((resolve, reject) => { tui.onopen = () => resolve(); tui.onerror = () => reject(new Error("fake TUI connection failed")); });
    // The native TUI sends initialize; the proxy never initializes an app-server itself.
    tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: `fixture-${peer}` } } }));
    await until(() => seen.some(message => message.id === 1), `${peer} initialize reply`);
    tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
    await until(() => seen.some(message => message.id === 2 && message.result?.thread?.id) && daemon.bus.stateOf(peer) === "idle", `${peer} native thread adoption`);
    return { tui, seen, proxy: result.proxyUrl as string };
  };
  return { root, stateDir, daemon, console_, spawned, start };
}

test("I2 daemon runs two Codex reviewer instances with distinct endpoints, MCP identities and targeted delivery", async () => {
  const f = await fixture(), a = await f.start("codex-a"), b = await f.start("codex-b");
  expect(a.proxy).not.toBe(b.proxy);
  const rows = f.spawned(); expect(rows.map(row => row.peer).sort()).toEqual(["codex-a", "codex-b"]);
  expect(rows.map(row => row.mcpPeer).sort()).toEqual(["codex-a", "codex-b"]);
  expect(new Set(rows.map(row => row.listen)).size).toBe(2);
  const envelopes: Envelope[] = []; f.daemon.bus.tap(event => { if (event.t === "envelope") envelopes.push(event.env); });
  for (const peer of ["codex-a", "codex-b"]) {
    const tools = await ControlClient.connect(f.stateDir, { role: "tools", peer, projectRoot: f.root }); cleanup.push(() => tools.close());
    expect((await tools.request({ t: "send", body: `[FYI] identity ${peer}` })).ok).toBe(true);
    expect(envelopes.some(env => env.from === peer && env.body.includes(`identity ${peer}`))).toBe(true);
  }
  const beforeA = a.seen.filter(message => message.method === "turn/started").length;
  expect((await f.console_.request({ t: "send", to: ["codex-b"], body: "Only the second native instance" })).ok).toBe(true);
  await until(() => b.seen.some(message => message.method === "item/completed" && message.params.item.type === "agentMessage" && message.params.item.phase === "final_answer" && message.params.item.text === "echo: Only the second native instance"), "targeted native answer");
  await until(() => f.daemon.bus.stateOf("codex-b") === "idle", "targeted turn completion");
  expect(a.seen.filter(message => message.method === "turn/started")).toHaveLength(beforeA);
  const status = (await f.console_.request({ t: "status" })).status;
  expect(status.peers["codex-a"].state).toBe("idle"); expect(status.peers["codex-b"].state).toBe("idle");
  const snapshot = await f.console_.request({ t: "ui_snapshot" });
  expect(snapshot.budget["codex-b"].context.source).toBe("codex_token_usage");
  expect(typeof snapshot.budget["codex-b"].context.measuredAt).toBe("number");
  expect(snapshot.budget["codex-a"].context.measuredAt).toBeNull();
}, 20_000);

test("I2 daemon extra implementer refuses missing worktree before spawning native processes", async () => {
  const f = await fixture({ "codex-a": { kind: "codex", roles: ["implementer"], start_mode: "headless" } });
  const result = await f.console_.request({ t: "start", peer: "codex-a" });
  expect(result.ok).toBe(false); expect(result.error).toMatch(/worktree/i);
  expect(f.spawned()).toEqual([]); expect(f.daemon.bus.peers.has("codex-a")).toBe(false);
});

test("I2 daemon never infers or starts an undeclared suffix", async () => {
  const f = await fixture();
  const result = await f.console_.request({ t: "start", peer: "codex-ghost" });
  expect(result.ok).toBe(false); expect(f.spawned()).toEqual([]);
  const status = (await f.console_.request({ t: "status" })).status;
  expect(status.peers["codex-ghost"]).toBeUndefined();
  expect(f.daemon.bus.peers.has("codex-ghost")).toBe(false);
});


test("I2 daemon account quota override is shared across sibling instances", async () => {
  const f = await fixture(); await f.start("codex-a"); await f.start("codex-b");
  const result = await f.console_.request({ t: "budget", set: { peer: "codex-a", used: 0.37, window: "5h", resetsInMs: 60_000 } });
  expect(result.ok).toBe(true);
  const snapshot = await f.console_.request({ t: "ui_snapshot" });
  const used = (peer: string) => snapshot.budget[peer].windows.find((window: { id: string }) => window.id === "5h")?.used;
  expect(used("codex-a")).toBe(0.37); expect(used("codex-b")).toBe(0.37);
}, 20_000);


test("I2 optional Qwen and its declared sibling share the quota pause without losing watch capability", async () => {
  const f = await fixture({ "qwen-a": { kind: "qwen", roles: ["reviewer"] } }, {
    roster: { qwen: true }, qwen_cmd: [process.execPath, join(import.meta.dir, "fakes/watch-acp.ts"), "--qwen"],
  });
  for (const peer of ["qwen", "qwen-a"]) {
    expect(await f.console_.request({ t: "start", peer, args: { mode: "headless" } })).toMatchObject({ ok: true });
    expect(await f.console_.request({ t: "watch", peer })).toMatchObject({ ok: true });
  }
  expect(await f.console_.request({ t: "budget", set: { peer: "qwen-a", used: 0.97, window: "5h", resetsInMs: 60_000 } })).toMatchObject({ ok: true });
  await until(() => f.daemon.bus.isPaused("qwen") && f.daemon.bus.isPaused("qwen-a"), "both optional-account native owners paused");
  const snapshot = await f.console_.request({ t: "ui_snapshot" });
  expect(snapshot.budget.qwen.paused).toBeDefined();
  expect(snapshot.budget["qwen-a"].paused).toBeDefined();
}, 20_000);
