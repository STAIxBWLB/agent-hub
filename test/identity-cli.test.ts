import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient, PROTOCOL } from "../src/hub/control-client.ts";
import { drainCliAudits } from "../src/cli/identity-audit.ts";

const CLI = join(import.meta.dir, "../src/cli/main.ts");
const MARKERS = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_UNATTENDED", "AGENTHUB_RECOVERY_OPERATION"];
async function cli(root: string, args: string[], markers: Record<string, string> = {}) {
  // Bind fixture markers in the wrapper, independently of the test runner's scrubbed child environment.
  const wrapper = join(root, `cli-${crypto.randomUUID()}.ts`);
  writeFileSync(wrapper, `for (const name of ${JSON.stringify(MARKERS)}) delete process.env[name];
Object.assign(process.env, ${JSON.stringify(markers)}, { AGENTHUB_HOME: ${JSON.stringify(join(root, "home"))} });
process.argv = [process.execPath, ${JSON.stringify(CLI)}, ...${JSON.stringify(args)}];
await import(${JSON.stringify(CLI)});
`);
  const child = Bun.spawn([process.execPath, wrapper], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}
function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-identity-cli-")));
  mkdirSync(join(root, ".agenthub"));
  writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, snapshots: { enabled: false } }));
  return root;
}

test("all human-only agent CLI commands refuse before a control connection and preserve ids-only audits", async () => {
  const root = project(), stateDir = join(root, ".agenthub/state");
  mkdirSync(stateDir);
  let connections = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (_req, server) => { connections++; if (server.upgrade(_req)) return; return new Response("unexpected"); }, websocket: { message() {} } });
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ cwd: root, controlPort: server.port, protocol: PROTOCOL }));
  writeFileSync(join(stateDir, "control-token"), "fixture-token");
  try {
    for (const args of [["permit", "sensitive-id", "allow"], ["queue", "resolve", "sensitive-id"], ["queue", "list"], ["budget", "resume", "kimi"], ["budget", "set", "kimi", "0"], ["budget", "execution"], ["kill"], ["recovery", "status", "sensitive-id"], ["upgrade"], ["restart"], ["up", "--unattended"], ["ask", "sensitive-question"]]) {
      const result = await cli(root, args, { AGENTHUB_PEER_ID: "claude" });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("ahub console or a terminal");
      expect(connections).toBe(0);
    }
    const audits = drainCliAudits(stateDir);
    expect(audits).toHaveLength(12);
    expect(audits.every(row => row.peer === "claude" && row.outcome === "refused")).toBe(true);
    expect(JSON.stringify(audits)).not.toContain("sensitive");
    const malformed = await cli(root, ["say", "harmless"], { AGENTHUB_PEER_ID: "codex", CLAUDECODE: "1" });
    expect(malformed.code).toBe(1);
    expect(malformed.stderr).toContain("conflicts");
    expect(connections).toBe(0);
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test("native shell CLI messages and board history retain the actor while plain terminals keep human authority", async () => {
  const root = project(), stateDir = join(root, ".agenthub/state");
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false } } });
  const sent: Array<{ from: string; body: string; priority: string }> = [];
  daemon.bus.tap(event => { if (event.t === "envelope") sent.push(event.env); });
  let console_: ControlClient | undefined;
  let worker: ControlClient | undefined;
  try {
    expect((await cli(root, ["say", "agent-message"], { CLAUDECODE: "1" })).code).toBe(0);
    expect(sent.find(row => row.body === "agent-message")).toMatchObject({ from: "claude", priority: "status" });
    expect((await cli(root, ["say", "native-codex-message"], { CODEX_THREAD_ID: "fixture-thread" })).code).toBe(0);
    expect(sent.find(row => row.body === "native-codex-message")).toMatchObject({ from: "codex", priority: "status" });
    expect((await cli(root, ["say", "human-message"])).code).toBe(0);
    expect(sent.find(row => row.body === "human-message")).toMatchObject({ from: "user", priority: "important" });
    const proposed = await cli(root, ["task", "propose", "--class", "summarize", "actor-history"], { AGENTHUB_PEER_ID: "claude" });
    expect(proposed.code, proposed.stderr).toBe(0);
    const id = Number(/task #(\d+)/.exec(proposed.stdout)?.[1]);
    expect(id).toBeGreaterThan(0);
    console_ = await ControlClient.connect(stateDir, { role: "console" });
    const shown = await console_.request({ t: "task", op: "task_show", args: { id } });
    expect(JSON.parse(shown.text).history[0]).toMatchObject({ by: "claude", event: "proposed" });
    // The native kimi id is reserved for ACP; a real non-native WS peer exercises holds without spawning it.
    worker = await ControlClient.connect(stateDir, { role: "peer", peer: "kimi-fixture" });
    expect((await console_.request({ t: "status" })).status.peers["kimi-fixture"].state).toBe("idle");
    const ordinary = await cli(root, ["pause", "kimi-fixture"], { AGENTHUB_PEER_ID: "claude" });
    expect(ordinary.code).toBe(1);
    expect(ordinary.stderr).toContain("conductor");
    expect((await console_.request({ t: "status" })).status.peers["kimi-fixture"].state).not.toBe("paused");
  } finally { worker?.close(); console_?.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test("agent CLI task proposals obey peer capabilities instead of borrowing the console's", async () => {
  const root = project(), stateDir = join(root, ".agenthub/state");
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG, capabilities: { claude: [] }, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false } } });
  let console_: ControlClient | undefined;
  try {
    const refused = await cli(root, ["task", "propose", "--class", "summarize", "restricted-proposal"], { AGENTHUB_PEER_ID: "claude" });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("propose");
    console_ = await ControlClient.connect(stateDir, { role: "console" });
    const list = await console_.request({ t: "task", op: "hub_task_list", args: {} });
    expect(JSON.parse(list.text)).toEqual([]);
  } finally { console_?.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true }); }
}, 20_000);
