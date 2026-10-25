import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { processSignature } from "../src/pi/process-signature.ts";
import { realPath } from "../src/hub/project.ts";
import { drainCliAudits } from "../src/cli/identity-audit.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const CLI = join(import.meta.dir, "../src/cli/main.ts");
async function run(root: string, args: string[]) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || ["CODEX_THREAD_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "KIMI_CODE", "QWEN_CODE", "QWEN_CODE_SESSION_ID"].includes(key)) delete env[key];
  Object.assign(env, { AGENTHUB_PEER_ID: "codex", AGENTHUB_HOME: join(root, "home"), HOME: join(root, "home") });
  const child = Bun.spawn([process.execPath, CLI, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timeout); }
}
function fixture(options: { helloMs?: number; authorizeMs?: number; incomplete?: boolean; error?: string; deny?: boolean; live?: boolean } = {}) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-conductor-cli-"))), stateDir = join(root, ".agenthub/state");
  mkdirSync(stateDir, { recursive: true }); mkdirSync(join(root, "home"));
  writeFileSync(join(root, ".agenthub/config.json"), "{}");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const messages: Record<string, any>[] = [], timers: ReturnType<typeof setTimeout>[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request, server) => server.upgrade(request) ? undefined : new Response("fixture"), websocket: {
    message(socket, value) {
      const message = JSON.parse(String(value)); messages.push(message);
      const send = (reply: Record<string, unknown>, ms = 0) => { const timer = setTimeout(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ rid: message.rid, ...reply })); }, ms); timers.push(timer); };
      if (message.t === "hello") return send({ t: "welcome", ok: true, cwd: root, projectId: "fixture", instanceId: "fixture", protocol: PROTOCOL, features: DAEMON_FEATURES }, options.helloMs);
      if (message.t === "conductor_operational" && message.op === "authorize") return send(options.deny
        ? { ok: false, authorityRefused: true, refusalAudited: true, error: "codex cannot run ahub logs; the person runs it in ahub console or a terminal; this operation requires the explicit conductor role" }
        : { ok: true, instanceId: "fixture" }, options.authorizeMs);
      if (message.t === "conductor_operational" && options.error) return send({ ok: false, authorityRefused: false, error: options.error });
      if (message.t === "conductor_operational" && message.op === "logs") return send({ ok: true, lines: ["safe operational line"], complete: !options.incomplete, truncated: options.incomplete === true, ...(options.incomplete ? { incompleteReason: "privacy inventory unavailable" } : {}) });
      if (message.t === "conductor_operational" && message.op === "export") return send({ ok: true, events: [{ type: "state", peer: "codex", state: "idle" }], complete: !options.incomplete, truncated: options.incomplete === true, ...(options.incomplete ? { incompleteReason: "privacy inventory unavailable" } : {}) });
      send({ ok: false, error: "unexpected fixture request" });
    },
  } });
  cleanup.push(() => { for (const timer of timers) clearTimeout(timer); server.stop(true); });
  writeFileSync(join(stateDir, "control-token"), "fixture-token");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ cwd: root, projectId: "fixture", instanceId: "fixture", controlPort: server.port, protocol: PROTOCOL, features: DAEMON_FEATURES, pid: options.live === false ? 99999999 : process.pid, pidSignature: options.live === false ? "stale-fixture" : processSignature(process.pid) }));
  return { root, stateDir, messages };
}

test("a live conductor tolerates handshake and authorization delays beyond 750 ms without losing identity", async () => {
  const f = fixture({ helloMs: 1100, authorizeMs: 1100 });
  const result = await run(f.root, ["logs"]);
  expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain("safe operational line");
  expect(result.stderr).not.toContain("the person runs it");
  expect(f.messages.filter(message => message.t === "hello").every(message => message.role === "tools" && message.peer === "codex")).toBe(true);
  expect(f.messages.filter(message => message.t === "conductor_operational" && message.op === "logs")).toHaveLength(1);
}, 20_000);

test("incomplete logs and export explain withholding once without corrupting data output", async () => {
  const f = fixture({ incomplete: true });
  for (const command of ["logs", "export"]) {
    const result = await run(f.root, [command]); expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain("operational output is incomplete: privacy inventory unavailable");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    if (command === "export") expect(JSON.parse(result.stdout)).toEqual({ type: "state", peer: "codex", state: "idle" });
    else expect(result.stdout).toBe("safe operational line\n");
  }
});

test("ordinary operation failure keeps its reason and does not fabricate a refused CLI audit", async () => {
  const f = fixture({ error: "operational history unavailable" }), result = await run(f.root, ["logs"]);
  expect(result.code).toBe(1); expect(result.stderr).toContain("operational history unavailable");
  expect(result.stderr).not.toContain("cannot run ahub"); expect(result.stderr).not.toContain("the person runs it");
  expect(drainCliAudits(f.stateDir).some(row => row.outcome === "refused")).toBe(false);
});

test("a genuine authority refusal prints the person guidance only once", async () => {
  const f = fixture({ deny: true }), result = await run(f.root, ["logs"]);
  expect(result.code).toBe(1);
  expect(result.stderr.match(/the person runs it in ahub console or a terminal/g)).toHaveLength(1);
  expect(f.messages.some(message => message.t === "conductor_operational" && message.op === "logs")).toBe(false);
});

test("a dead descriptor refuses promptly before opening a control connection", async () => {
  const f = fixture({ live: false }), started = Date.now(), result = await run(f.root, ["logs"]);
  expect(result.code).toBe(1); expect(Date.now() - started).toBeLessThan(2500);
  expect(result.stderr).toContain("the person runs it in ahub console or a terminal"); expect(f.messages).toHaveLength(0);
});
