import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { Registry } from "../src/hub/registry.ts";
import { planFingerprint, type NextChoice, type RecoveryOperation, type UpgradePlan } from "../src/cli/upgrade.ts";
import { renderBudgetResult, renderRecoveryStatus, renderUpgradePlan } from "../src/cli/upgrade-output.ts";
import { paint } from "../src/cli/console-state.ts";
import { VERSION } from "../src/version.ts";

// #814 T3: the non-interactive restart/upgrade plan, recovery status, queue resolve, models start/setup and
// budget execution configure|disable print for a person by default and print exactly today's JSON with --json.
const CLI = join(import.meta.dir, "../src/cli/main.ts");
const NOW = 1_800_000_000_000;
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const parses = (text: string) => { try { JSON.parse(text); return true; } catch { return false; } };
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

const LONG = "a deliberately long blocker sentence that has to wrap beside its label at eighty columns without losing any of its words or splitting a path like /Users/someone/work/dev/agent-hub/.agenthub/state";
function planWith(overrides: Partial<UpgradePlan["projects"][number]> = {}, blockers: string[] = []): UpgradePlan {
  const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind: "upgrade", version: "0.18.0", integrity: "sha512-x", sourceRoot: "/pkg", sourceDigest: "d".repeat(64), blockers,
    projects: [{ project: { id: "agent-hub-with-a-rather-long-project-identifier", root: "/Users/someone/work/dev/agent-hub", stateDir: "/s", basePort: 4600, instanceId: "i", pid: 1 },
      source: { state: "running", instanceId: "i", version: "0.17.0", protocol: PROTOCOL, blockers: [], peers: [
        { id: "claude", state: "idle", attached: true } as never, { id: "codex-review-with-a-long-name", state: "busy", attached: true } as never, { id: "kimi", state: "offline", attached: false } as never] },
      terminals: [], blockers: [LONG], reconnectOnly: ["claude"], freshStart: ["codex-review-with-a-long-name"], ...overrides }] };
  return { ...body, fingerprint: planFingerprint(body) };
}
const options = (columns: number, color = false) => ({ columns, color, verbose: false, now: () => NOW });
const operation = (phase: RecoveryOperation["phase"], plan = planWith()): RecoveryOperation => ({ schema: 1, id: "00000000-0000-4000-8000-000000000814", plan, sourceRoot: "/pkg", createdAt: 1, updatedAt: NOW - 90_000, phase, step: phase === "completed" ? "completed" : "commit",
  projects: [{ id: plan.projects[0]!.project.id, phase: phase === "completed" ? "verified" : "stopped", terminals: {} }], ...(phase === "blocked" ? { error: "the target hub did not answer; next actions: ahub recovery status x" } : {}) });

test("renderUpgradePlan: a pipe or dry run shows each peer, its blocker, reconnect-only and fresh-start sessions, and says nothing changed", () => {
  for (const columns of [80, 200]) {
    const text = renderUpgradePlan(planWith({}, ["a plan level blocker"]), "0.17.0", options(columns)).join("\n");
    const words = flat(text);
    for (const must of ["upgrade to 0.18.0", "agent-hub-with-a-rather-long-project-identifier", "claude", "reconnects by itself", "codex-review-with-a-long-name", "restarts as a new session", "kimi", "offline, left as it is", "blocker: a plan level blocker", "Blocked:", "Nothing was changed"]) expect(words, `${must} @${columns}`).toContain(must);
    for (const line of text.split("\n")) expect(Bun.stringWidth(line), line).toBeLessThanOrEqual(columns);
    expect(parses(text)).toBe(false); expect(text).not.toContain("{");
  }
  const clean = renderUpgradePlan(planWith({ blockers: [], reconnectOnly: [], freshStart: [] }), "0.17.0", options(80)).join("\n");
  expect(clean).toContain("Apply with `--yes`"); expect(clean).not.toContain("Blocked:");
  expect(renderUpgradePlan({ ...planWith(), projects: [], blockers: ["no running registered projects in scope"] }, "0.17.0", options(80)).join("\n")).toContain("No hub is running");
});

test("renderRecoveryStatus: completed, running, blocked and unknown-runner receipts each say what the person can do", () => {
  const choices: NextChoice[] = [{ kind: "resume", text: "ahub recovery resume 00000000-0000-4000-8000-000000000814" }, { kind: "abort", text: "ahub recovery abort 00000000-0000-4000-8000-000000000814" }];
  const done = renderRecoveryStatus(operation("completed"), undefined, [], options(80)).join("\n");
  expect(flat(done)).toContain("completed"); expect(done).not.toContain("Next:");
  const running = renderRecoveryStatus(operation("running"), 4242, [{ kind: "wait", text: "wait: runner 4242 is working" }], options(80)).join("\n");
  expect(flat(running)).toContain("Recovery runner 4242 is active"); expect(flat(running)).toContain("wait: runner 4242 is working");
  const blocked = renderRecoveryStatus(operation("blocked"), undefined, choices, options(80)).join("\n");
  for (const must of ["What happened", "What to do", "ahub recovery resume", "ahub recovery abort"]) expect(flat(blocked), must).toContain(must);
  const pending = renderRecoveryStatus(operation("pending"), "unknown", choices, options(200)).join("\n");
  expect(flat(pending)).toContain("unknown"); expect(flat(pending)).toContain("Next:");
  for (const text of [done, running, blocked, pending]) { expect(parses(text)).toBe(false); expect(text).not.toMatch(/"[A-Za-z]+":/); }
  for (const line of blocked.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
});

test("renderBudgetResult: configure shows the stored budget, disable says whether one was disabled", () => {
  const cfg = { id: "nightly-run", kind: "run", peers: ["local"], limits: { model_calls: 5 }, used: { model_calls: 0 } };
  const lines = (op: "configure" | "disable", value: unknown, columns?: number) => renderBudgetResult(op, value, columns, NOW).map(line => paint(line, false)).join("\n");
  expect(lines("configure", cfg, 80)).toContain("Execution budget configured"); expect(lines("configure", cfg, 80)).toContain("nightly-run");
  expect(lines("disable", { disabled: true }, 80)).toContain("Disabled"); expect(lines("disable", { disabled: false }, 80)).toContain("nothing was disabled");
  for (const op of ["configure", "disable"] as const) for (const value of [undefined, null, {}]) expect(lines(op, value, 80)).not.toMatch(/undefined|NaN|\[object/);
  for (const line of lines("configure", { ...cfg, id: "x".repeat(150) }, 80).split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
});

// ---- the real CLI against a fake control server: queue resolve and budget execution configure|disable ----
const delivery = { id: "abcdef12-1111-2222-3333-444444444444", peer: "codex-review-with-a-long-name", state: "completed", revision: 3, createdAt: NOW - 600_000, updatedAt: NOW - 30_000, envelopeIds: ["12345678-1111-2222-3333-444444444444"], important: true, note: LONG };
const budget = { id: "nightly-run", kind: "run", peers: ["local"], limits: { model_calls: 5 }, used: { model_calls: 2 }, createdAt: NOW - 60_000 };
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ahub-upgrade-output-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, ".agenthub/state"); mkdirSync(stateDir, { recursive: true });
  const registry = new Registry(join(root, "home/registry.db"));
  const project = registry.register(root, stateDir); registry.close();
  const status = { projectId: project.id, pid: process.pid, cwd: root, controlPort: 12345, instanceId: "upgrade-output-fixture", peers: {}, tasks: {} };
  const requests: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, srv) { if (srv.upgrade(req)) return; return new Response("no", { status: 400 }); }, websocket: {
    message(ws, body) {
      const req = JSON.parse(String(body)); requests.push(req);
      const reply = req.t === "hello" ? { t: "welcome", cwd: root, projectId: project.id, instanceId: status.instanceId } : req.t === "status" ? { status }
        : req.t === "queue" ? { delivery }
        : req.t === "execution_budget" ? req.op === "configure" ? { budget } : req.op === "disable" ? { disabled: req.id === "nightly-run" } : { budgets: [budget] }
        : {};
      ws.send(JSON.stringify({ ok: true, ...reply, rid: req.rid }));
    },
  } });
  cleanup.push(() => server.stop(true));
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ ...status, controlPort: server.port, protocol: PROTOCOL }));
  writeFileSync(join(stateDir, "control-token"), "fixture-token");
  writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const bin = join(root, "bin"); mkdirSync(bin);
  for (const name of ["bun", "claude", "codex", "kimi", "dot"]) writeFileSync(join(bin, name), `#!/bin/sh\ncase "$1" in\n  --version) echo 'fixture 1.0';;\nesac\n`, { mode: 0o755 });
  const wrapper = join(root, "run.ts");
  writeFileSync(wrapper, `Date.now = () => ${NOW}; await import(${JSON.stringify(CLI)});`);
  const file = join(root, "budget.json"); writeFileSync(file, JSON.stringify({ id: "nightly-run", kind: "run", peers: ["local"], limits: { model_calls: 5 } }));
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const childEnv: Record<string, string> = { ...process.env as Record<string, string>, HOME: root, AGENTHUB_HOME: join(root, "home"), PATH: `${bin}:${process.env.PATH}`, TERM: "xterm-256color", ...env };
    for (const marker of ["AGENTHUB_PEER_ID", "AGENTHUB_CHANNEL", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_PROJECT_DIR", "AGENTHUB_STATE_DIR", "AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID", "AGENTHUB_DELIVERY_ONLY", "NO_COLOR", "COLUMNS"]) if (!(marker in env)) delete childEnv[marker];
    const proc = Bun.spawn([process.execPath, wrapper, ...args], { cwd: root, env: childEnv, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, stdout, stderr };
  };
  return { run, requests, file };
}

const cases = [
  { name: "queue resolve", argv: (f: ReturnType<typeof fixture>) => ["queue", "resolve", delivery.id, "--action", "completed", "--reason", "checked by hand", "--revision", "3"], json: JSON.stringify(delivery, null, 2) + "\n", must: ["Delivery", "completed", "codex-review-with-a-long-name"] },
  { name: "budget execution configure", argv: (f: ReturnType<typeof fixture>) => ["budget", "execution", "configure", f.file], json: JSON.stringify(budget, null, 2) + "\n", must: ["Execution budget configured", "nightly-run", "model_calls"] },
  { name: "budget execution disable", argv: () => ["budget", "execution", "disable", "nightly-run"], json: JSON.stringify({ disabled: true }, null, 2) + "\n", must: ["Execution budget", "Disabled"] },
  { name: "budget execution disable of an unknown id", argv: () => ["budget", "execution", "disable", "nothing-here"], json: JSON.stringify({ disabled: false }, null, 2) + "\n", must: ["nothing was disabled"] },
] as const;

for (const command of cases) {
  test(`AC1 ${command.name}: the default is for a person, --json is today's document byte for byte`, async () => {
    const f = fixture();
    const human = await f.run([...command.argv(f)]);
    expect(human.code, human.stderr).toBe(0);
    expect(parses(human.stdout), "default output must not parse as JSON").toBe(false);
    expect(human.stdout).not.toMatch(/^\s*[{[]/); expect(human.stdout).not.toMatch(/"[A-Za-z_]+":/); expect(human.stdout).not.toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
    for (const needle of command.must) expect(flat(human.stdout).toLowerCase(), needle).toContain(needle.toLowerCase());
    const json = await f.run([...command.argv(f), "--json"]);
    expect(json.code, json.stderr).toBe(0);
    expect(json.stdout).toBe(command.json);
  });
  test(`AC3 ${command.name}: 80 and 200 columns with long cells, nothing over the width, --color=never plain`, async () => {
    const f = fixture();
    const narrow = await f.run([...command.argv(f), "--color=never"], { COLUMNS: "80" });
    const wide = await f.run([...command.argv(f), "--color=never"], { COLUMNS: "200" });
    expect(narrow.code, narrow.stderr).toBe(0); expect(wide.code, wide.stderr).toBe(0);
    for (const line of narrow.stdout.split("\n")) expect(Bun.stringWidth(line), line).toBeLessThanOrEqual(80);
    for (const line of wide.stdout.split("\n")) expect(Bun.stringWidth(line), line).toBeLessThanOrEqual(200);
    expect(narrow.stdout).not.toContain("\x1b"); expect(wide.stdout).not.toContain("\x1b");
    const colored = await f.run([...command.argv(f), "--color=always"], { COLUMNS: "200" });
    expect(colored.stdout).toContain("\x1b["); expect(plain(colored.stdout)).toBe(wide.stdout);
  });
}

test("queue resolve: the long note survives whole at both widths", async () => {
  const f = fixture();
  const argv = ["queue", "resolve", delivery.id, "--action", "completed", "--reason", "checked", "--revision", "3", "--color=never"];
  const words = (text: string) => flat(text).split(" ").filter(Boolean);
  const wide = words((await f.run(argv, { COLUMNS: "200" })).stdout), narrow = words((await f.run(argv, { COLUMNS: "80" })).stdout);
  for (const word of LONG.split(" ")) if (word.length <= 70) { expect(wide, word).toContain(word); expect(narrow, word).toContain(word); }
});

test("restart and recovery commands off a terminal, through the real CLI: default readable, --json the old document", async () => {
  const f = fixture();
  // restart --dry-run with no running project in scope: a readable blocked plan, exit 0; --json the document with its stderr line
  const human = await f.run(["restart", "--dry-run"], { COLUMNS: "80" });
  expect(human.code, human.stderr).toBe(0);
  expect(parses(human.stdout)).toBe(false); expect(flat(human.stdout)).toContain("restart to " + VERSION);
  for (const line of human.stdout.split("\n")) expect(Bun.stringWidth(line), line).toBeLessThanOrEqual(80);
  expect(human.stderr).not.toContain("blocker");
  const json = await f.run(["restart", "--dry-run", "--json"]);
  expect(json.code, json.stderr).toBe(0); expect(JSON.parse(json.stdout).kind).toBe("restart"); expect(json.stderr).toContain("ahub: blocker:");
  const wide = await f.run(["restart", "--dry-run", "--color=never"], { COLUMNS: "200" });
  for (const line of wide.stdout.split("\n")) expect(Bun.stringWidth(line), line).toBeLessThanOrEqual(200);
  expect(wide.stdout).not.toContain("\x1b");
});
