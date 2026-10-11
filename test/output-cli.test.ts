import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { Registry } from "../src/hub/registry.ts";
import { Turns } from "../src/hub/snapshots.ts";
import { summarize, summarizeByTask } from "../src/hub/report.ts";
import { drainCliAudits } from "../src/cli/identity-audit.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";

const CLI = join(import.meta.dir, "../src/cli/main.ts");
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function fixture(options: { failFullBoard?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ahub-output-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, ".agenthub/state"); mkdirSync(stateDir, { recursive: true });
  const registry = new Registry(join(root, "home/registry.db"));
  const project = registry.register(root, stateDir); registry.close();
  const now = Date.now();
  const status = { projectId: project.id, pid: process.pid, cwd: root, controlPort: 12345, instanceId: "output-fixture", peers: { claude: { state: "idle", queued: 0, attached: true, context: { used: 0.5, freshness: "fresh", source: "claude_statusline", measuredAt: Date.now() } } }, tasks: { proposed: 1 } };
  const tasks: any[] = [{ id: 1, state: "proposed", class: "implement", owner: "claude", reviewer: "codex", title: "검증할 긴 제목 ".repeat(40), signals: [], created: Date.now() }];
  const budget = { claude: { windows: [{ id: "week", used: 0.25, source: "fixture", at: Date.now(), resetsAt: Date.now() + 60_000 }] } };
  const envelopeId = "12345678-1111-2222-3333-444444444444";
  const deliveries = [{ id: "abcdef12-1111-2222-3333-444444444444", peer: "codex", state: "needs_review", revision: 2, createdAt: now - 60_000, updatedAt: now - 30_000, envelopeIds: [envelopeId], important: true }];
  const delivery = { ...deliveries[0], messages: [{ id: envelopeId, from: "claude", priority: "important", kind: "task", body: "[private: inspect the associated task with ahub task show]" }] };
  const budgets = [{ id: "fixture-budget", kind: "run", peers: ["local"], limits: { model_calls: 5 }, used: { model_calls: 2 }, units: { model_calls: { used: 2, limit: 5, remaining: 3 } }, createdAt: now - 60_000, updatedAt: now }];
  const turnStore = new Turns(join(stateDir, "hub.db"));
  turnStore.begin("turn-fixture-12345678", "codex", "start-tree");
  turnStore.end("turn-fixture-12345678", "end-tree", Array.from({ length: 8 }, (_, i) => `src/한글/file-${i}.ts`), 20);
  const turns = turnStore.list(); turnStore.close();
  const events: any[] = [
    { v: 1, at: new Date(now - 60_000).toISOString(), type: "task", id: 3, state: "in_progress", class: "implement", event: "accepted", by: "codex", owner: "codex", reviewer: "claude", pii: false },
    { v: 1, at: new Date(now - 30_000).toISOString(), type: "tokens", peer: "codex", n: 70, task: 3, attribution: "delivery" },
    { v: 1, at: new Date(now).toISOString(), type: "turn_end", peer: "codex", turn: "t1", ms: 30_000, task: 3, attribution: "delivery" },
  ];
  writeFileSync(join(stateDir, "events.jsonl"), events.map(e => JSON.stringify(e)).join("\n") + "\n");
  const requests: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response("no", { status: 400 }); }, websocket: {
    message(ws, body) {
      const req = JSON.parse(String(body)); requests.push(req);
      const reply = req.t === "hello" ? { t: "welcome", cwd: root, projectId: project.id, instanceId: status.instanceId }
        : req.t === "status" ? { status }
        : req.t === "budget" ? { budget, gate: 0.95 }
        : req.t === "execution_budget" ? req.op === "disable" ? { disabled: true } : { budgets }
        : req.t === "queue" ? req.op === "show" ? { delivery } : { deliveries }
        : req.t === "task" && options.failFullBoard && !Object.keys(req.args ?? {}).length ? { ok: false, error: "full board temporarily unavailable" }
        : req.t === "task" ? { text: JSON.stringify(req.args?.ready ? tasks.filter(t => t.state === "proposed" && (t.deps ?? []).every((id: number) => tasks.some(dep => dep.id === id && dep.state === "approved"))) : req.args?.state ? tasks.filter(t => t.state === req.args.state) : tasks) }
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
  return { run, status, tasks, budget, requests, root, project, deliveries, delivery, budgets, turns, events };
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

for (const filter of ["--ready", "proposed"]) test(`filtered board ${filter} resolves dependencies against the whole board`, async () => {
  const f = fixture();
  Object.assign(f.tasks[0]!, { id: 5, deps: [1], title: "Ready task" });
  f.tasks.push({ ...f.tasks[0]!, id: 1, state: "approved", deps: [], title: "Approved prerequisite" } as any);
  const result = await f.run(["board", filter]);
  expect(result.code).toBe(0); expect(result.stdout).toContain("proposed"); expect(result.stdout).not.toContain("waiting");
  expect(result.stdout).not.toContain("Approved prerequisite");
  expect(f.requests.filter(r => r.t === "task").map(r => r.args)).toEqual([filter === "--ready" ? { ready: true } : { state: "proposed" }, {}]);
});

test("doctor preserves collected findings and its error exit when config parsing throws", async () => {
  const f = fixture(); writeFileSync(join(f.root, ".agenthub/config.local.json"), "{bad");
  const result = await f.run(["doctor", "--color=never"]);
  expect(result.code).toBe(1); expect(result.stdout).toContain("Tools\n"); expect(result.stdout).toContain("fixture 1.0");
  expect(result.stdout).toContain("claude plugin"); expect(result.stderr.length).toBeGreaterThan(0);
});

for (const filter of ["--ready", "proposed"]) test(`filtered board ${filter} remains visible when full dependency context fails`, async () => {
  const f = fixture({ failFullBoard: true }); Object.assign(f.tasks[0]!, { deps: [9], title: "Already fetched task" });
  f.tasks.push({ ...f.tasks[0]!, id: 9, deps: [], state: "approved", title: "Approved prerequisite" });
  const result = await f.run(["board", filter], { COLUMNS: "80" });
  expect(result.code).toBe(0); expect(result.stdout).toContain("Already fetched task");
  expect(result.stdout).toContain("proposed"); expect(result.stdout).not.toContain("waiting"); expect(result.stdout).not.toContain("STAGE");
  expect(result.stderr).toContain("dependency stages unavailable; showing filtered rows without stages");
  expect(result.stderr).toContain("full board temporarily unavailable");
});


test("remaining JSON commands keep fetched documents without color", async () => {
  const f = fixture();
  const expectedProjects = [{ ...f.project, state: "running", status: f.status }];
  const cases: [string[], unknown][] = [
    [["projects"], expectedProjects], [["status", "--all"], expectedProjects], [["queue", "list"], f.deliveries],
    [["queue", "show", f.deliveries[0]!.id], f.delivery], [["turns"], f.turns],
    [["models", "status"], { state: "disabled", enabled: false }], [["budget", "execution", "status"], f.budgets],
    [["report"], summarize(f.events)], [["report", "--by", "task"], summarizeByTask(f.events)],
  ];
  for (const [args, expected] of cases) {
    const result = await f.run([...args, "--json", "--color=always"]);
    expect(result.code, result.stderr).toBe(0); expect(result.stdout).toBe(JSON.stringify(expected, null, 2) + "\n");
    expect(result.stdout).not.toContain("\x1b");
  }
});

test("remaining text command paths use complete readable tables and labelled fields at80", async () => {
  const f = fixture();
  const cases = [
    ["projects"], ["status", "--all"], ["queue", "list"], ["queue", "show", f.deliveries[0]!.id], ["turns"],
    ["models", "status"], ["budget", "execution", "status"], ["report"], ["report", "--by", "task"], ["doctor", "--orphans"],
  ];
  for (const args of cases) {
    const result = await f.run([...args, "--color=never"], { COLUMNS: "80" });
    expect(result.code, result.stderr).toBe(0); expect(result.stdout).not.toContain("\x1b"); expect(result.stdout).not.toContain('{"');
    expect(result.stdout).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    for (const line of result.stdout.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  }
  const turns = await f.run(["turns"]);
  for (const name of f.turns[0]!.changed) expect(turns.stdout).toContain(name);
  const queue = await f.run(["queue", "show", f.deliveries[0]!.id]); expect(queue.stdout).toContain("[private: inspect the associated task with ahub task show]");
  expect(queue.stdout).not.toContain("[pii]");
});


test("new read render paths reject invalid colors before fetching", async () => {
  const f = fixture();
  for (const args of [["projects"], ["status", "--all"], ["queue", "list"], ["turns"], ["models", "status"], ["budget", "execution", "status"], ["report"], ["doctor", "--orphans"]]) {
    const result = await f.run([...args, "--color=bad"]);
    expect(result.code).toBe(1); expect(result.stderr).toContain(`usage: ahub ${args[0]}`);
  }
  expect(f.requests).toHaveLength(0);
});

test("successful filtered-board fallback records run rather than refused for an agent shell", async () => {
  const f = fixture({ failFullBoard: true });
  const result = await f.run(["board", "proposed"], { AGENTHUB_PEER_ID: "codex" });
  expect(result.code).toBe(0); expect(result.stdout).toContain("proposed"); expect(result.stderr).toContain("stages unavailable");
  expect(drainCliAudits(join(f.root, ".agenthub/state")).map(row => row.outcome)).toEqual(["run"]);
});


test("execution configure removes presentation flags before reading its file", async () => {
  const f = fixture(); const file = join(f.root, "execution.json");
  const config = { id: "nightly-run", kind: "run", peers: ["local"], limits: { model_calls: 5 } };
  writeFileSync(file, JSON.stringify(config));
  const result = await f.run(["budget", "--color=never", "execution", "configure", file]);
  expect(result.code, result.stderr).toBe(0);
  expect(f.requests.find(request => request.t === "execution_budget")).toMatchObject({ op: "configure", config });
});


test("execution disable after an output flag performs the exact requested operation", async () => {
  const f = fixture();
  const id = "nightly-run-2";
  const result = await f.run(["budget", "--color=never", "execution", "disable", id]);
  expect(result.code, result.stderr).toBe(0);
  expect(f.requests.filter(request => request.t === "execution_budget")).toMatchObject([{ op: "disable", id }]);
  expect(result.stdout).toContain("disabled"); expect(result.stdout).toContain("true");
  expect(result.stdout).not.toContain("no quota readings");
  const json = await f.run(["budget", "--json", "execution", "disable", id]);
  expect(json.code, json.stderr).toBe(0); expect(json.stdout).toBe(JSON.stringify({ disabled: true }, null, 2) + "\n");
});
