import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";

const CLI = join(import.meta.dir, "../src/cli/main.ts");
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ahub-output-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, ".agenthub/state"); mkdirSync(stateDir, { recursive: true });
  const now = Date.now();
  const status = { pid: process.pid, cwd: root, controlPort: 12345, instanceId: "output-fixture", peers: { claude: { state: "idle", queued: 0, attached: true, context: { used: 0.5, freshness: "fresh", source: "claude_statusline", measuredAt: Date.now() } } }, tasks: { proposed: 1 } };
  const tasks = [{ id: 1, state: "proposed", class: "implement", owner: "claude", reviewer: "codex", title: "검증할 긴 제목 ".repeat(40), signals: [], created: Date.now() }];
  const budget = { claude: { windows: [{ id: "week", used: 0.25, source: "fixture", at: Date.now(), resetsAt: Date.now() + 60_000 }] } };
  const requests: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response("no", { status: 400 }); }, websocket: {
    message(ws, body) {
      const req = JSON.parse(String(body)); requests.push(req);
      const reply = req.t === "hello" ? { t: "welcome", cwd: root, instanceId: status.instanceId }
        : req.t === "status" ? { status }
        : req.t === "budget" ? { budget, gate: 0.95 }
        : req.t === "task" ? { text: JSON.stringify(tasks) }
        : req.t === "recovery" ? { recovery: { peers: { claude: { id: "claude", state: "idle" } } } }
        : {};
      ws.send(JSON.stringify({ ok: true, ...reply, rid: req.rid }));
    },
  } });
  cleanup.push(() => server.stop(true));
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ ...status, controlPort: server.port, protocol: PROTOCOL }));
  writeFileSync(join(stateDir, "control-token"), "fixture-token");
  writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.json({ data: [{ id: "fixture-model" }] }); } });
  cleanup.push(() => gateway.stop(true));
  writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ mlx: { enabled: false }, omniroute: { urls: [`http://127.0.0.1:${gateway.port}/v1`], access_hosts: [] }, local: { sandbox: "allow-default" } }));
  const bin = join(root, "bin"); mkdirSync(bin);
  for (const name of ["bun", "claude", "codex", "kimi", "switchyard-server", "dot"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\ncase "$1" in\n  --version) echo 'fixture 1.0';;\n  plugin) echo '[]';;\n  ai) echo '✓ codex ready';;\nesac\n`, { mode: 0o755 });
  }
  const wrapper = join(root, "run.ts");
  writeFileSync(wrapper, `Date.now = () => ${now}; const original = globalThis.fetch; globalThis.fetch = ((input, init) => String(input).startsWith("http://127.0.0.1:37701/") ? Promise.resolve(Response.json({ status: "ok", version: "fixture" })) : original(input, init)) as typeof fetch; await import(${JSON.stringify(CLI)});`);
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const childEnv: Record<string, string> = { ...process.env as Record<string, string>, HOME: root, AGENTHUB_HOME: join(root, "home"), PATH: `${bin}:${process.env.PATH}`, TERM: "xterm-256color", OMNIROUTE_API_KEY: "fixture", ...env };
    for (const marker of ["AGENTHUB_PEER_ID", "AGENTHUB_CHANNEL", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_PROJECT_DIR", "AGENTHUB_STATE_DIR", "AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID", "NO_COLOR", "COLUMNS", "AGENTHUB_OMNIROUTE_URL", "AGENTHUB_OMNIROUTE_KEY"]) if (!(marker in env)) delete childEnv[marker];
    const proc = Bun.spawn([process.execPath, wrapper, ...args], { cwd: root, env: childEnv, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, stdout, stderr };
  };
  return { run, status, tasks, budget, requests };
}

test("status JSON remains byte-identical and adds no quota read; board/budget JSON print their rendered data without color", async () => {
  const f = fixture();
  const status = await f.run(["status", "--json", "--color=always"]);
  expect(status.code).toBe(0); expect(status.stdout).toBe(JSON.stringify(f.status, null, 2) + "\n");
  expect(f.requests.some(r => r.t === "budget")).toBe(false);
  const board = await f.run(["board", "--json", "--color=always"]);
  expect(board.code).toBe(0); expect(JSON.parse(board.stdout)).toEqual(f.tasks); expect(board.stdout).not.toContain("\x1b");
  const budget = await f.run(["budget", "--json", "--color=always"], { AGENTHUB_PEER_ID: "codex" });
  expect(budget.code).toBe(0); expect(JSON.parse(budget.stdout)).toEqual({ budget: f.budget, gate: 0.95 }); expect(budget.stdout).not.toContain("\x1b");
});

test("piped output is plain and complete; explicit color preserves text; COLUMNS wraps the command", async () => {
  const f = fixture();
  const plain = await f.run(["board"]); const colored = await f.run(["board", "--color=always"]);
  expect(plain.code).toBe(0); expect(colored.code).toBe(0);
  expect(plain.stdout).not.toContain("\x1b"); expect(plain.stdout).toContain(f.tasks[0]!.title);
  expect(colored.stdout.replace(/\x1b\[[0-9;]*m/g, "")).toBe(plain.stdout);
  const narrow = await f.run(["board", "--color=never"], { COLUMNS: "80" });
  expect(narrow.code).toBe(0); for (const line of narrow.stdout.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  const status = await f.run(["status"]); expect(status.stdout).toContain("25%"); expect(f.requests.some(r => r.t === "budget")).toBe(true);
});

test("invalid color prints command usage before connecting; output-only budget flags never acquire mutation authority", async () => {
  const f = fixture(); const bad = await f.run(["status", "--color=rainbow"]);
  expect(bad.code).toBe(1); expect(bad.stderr).toContain("usage: ahub status"); expect(f.requests).toHaveLength(0);
  expect(classifyPeerCommand("budget", ["--full", "--color=always", "--json"])).toBe("allowed");
  expect(classifyPeerCommand("budget", ["set", "claude", "1", "--color=always"])).toBe("console");
});

test("doctor structured checks and sections use declared levels/findings, with its unchanged successful exit code", async () => {
  const f = fixture(); const json = await f.run(["doctor", "--json", "--color=always"]);
  expect(json.code).toBe(0); expect(json.stdout).not.toContain("\x1b");
  const checks = JSON.parse(json.stdout);
  expect(checks).toContainEqual(expect.objectContaining({ section: "Hub", level: "fail", name: "claude plugin" }));
  expect(checks).toContainEqual(expect.objectContaining({ section: "Hub", level: "fail", name: "claude recovery ID" }));
  expect(checks).toContainEqual(expect.objectContaining({ section: "Config", level: "fail", name: "retired setting" }));
  expect(checks).toContainEqual(expect.objectContaining({ section: "Memory", level: "warn", name: "memory capture: kimi", detail: "not ready, per `dot ai memory status`" }));
  for (const check of checks) { expect(["ok", "warn", "fail", "unknown"]).toContain(check.level); expect(check.detail.length).toBeGreaterThan(0); }
  const text = await f.run(["doctor", "--color=never"], { COLUMNS: "80" });
  expect(text.code).toBe(0); for (const section of ["Tools", "Hub", "Config", "Models", "Memory"]) expect(text.stdout).toContain(`${section}\n`);
  expect(text.stdout).toContain("failures"); for (const line of text.stdout.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
}, 20_000);
