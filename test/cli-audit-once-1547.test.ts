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
function fixture(reply: Record<string, unknown>) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-audit-once-"))), stateDir = join(root, ".agenthub/state");
  mkdirSync(stateDir, { recursive: true }); mkdirSync(join(root, "home"));
  writeFileSync(join(root, ".agenthub/config.json"), "{}");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request, server) => server.upgrade(request) ? undefined : new Response("fixture"), websocket: {
    message(socket, value) {
      const message = JSON.parse(String(value));
      const send = (r: Record<string, unknown>) => socket.send(JSON.stringify({ rid: message.rid, ...r }));
      if (message.t === "hello") return send({ t: "welcome", ok: true, cwd: root, projectId: "fixture", instanceId: "fixture", protocol: PROTOCOL, features: DAEMON_FEATURES });
      if (message.t === "task") return send(reply);
      send({ ok: false, error: "unexpected fixture request" });
    },
  } });
  cleanup.push(() => server.stop(true));
  writeFileSync(join(stateDir, "control-token"), "fixture-token");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ cwd: root, projectId: "fixture", instanceId: "fixture", controlPort: server.port, protocol: PROTOCOL, features: DAEMON_FEATURES, pid: process.pid, pidSignature: processSignature(process.pid) }));
  return { root, stateDir };
}
const outcomes = (stateDir: string) => drainCliAudits(stateDir).map((a) => a.outcome);

test("a domain error from the daemon leaves exactly one audit outcome, run, never refused (#1547)", async () => {
  const f = fixture({ ok: false, authorityRefused: false, error: "no task #99" });
  const result = await run(f.root, ["task", "show", "99"]);
  expect(result.code).not.toBe(0);
  expect(outcomes(f.stateDir)).toEqual(["run"]);
}, 20_000);

test("an authority refusal from the daemon is audited as refused (#1547)", async () => {
  const f = fixture({ ok: false, authorityRefused: true, error: "planning requires a person or configured planner role" });
  const result = await run(f.root, ["task", "show", "99"]);
  expect(result.code).not.toBe(0);
  expect(outcomes(f.stateDir)).toContain("refused");
}, 20_000);
