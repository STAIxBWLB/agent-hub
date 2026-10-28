/** #544 opt-in diagnostic producer. It characterizes deliberate permission-push omission outside the regression suite. No installed Claude binary, account or model provider is used. */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { COMPAT, assessVersion, trustFile, writeTrust } from "../../src/adapters/compat.ts";
import { startDaemon, loadConfig } from "../../src/hub/daemon.ts";
import { ControlClient } from "../../src/hub/control-client.ts";
import { hubGitEnv, hubGitSync } from "../../src/hub/git.ts";
import { hostExecutable } from "../../src/hub/host-executable.ts";
import { realPath } from "../../src/hub/project.ts";
import { shellQuote } from "../../src/cli/shell-quote.ts";
import { taskShellCommand } from "../../src/hub/task-shell-command.ts";
import { sandboxAvailable } from "../../src/local/sandbox.ts";
import { runConsole, type ConsoleTerminal } from "../../src/cli/console.ts";

// Keep testing the trusted-but-unverified path if a later native receipt verifies 2.1.312.
const VERSION = COMPAT["claude-implementer"].verified.includes("2.1.312") ? "9999.0.0" : "2.1.312";
const REPO_ROOT = resolve(import.meta.dir, "../..");
const COMMAND = "bun test test/ci-watch.test.ts";
async function until(check: () => boolean, label: string): Promise<void> {
  for (let n = 0; n < 400 && !check(); n++) await new Promise<void>(done => setImmediate(done));
  expect(check(), label).toBe(true);
}
async function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`triage barrier timed out: ${label}`)), 5000);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-544-"))), hostBin = realPath(mkdtempSync(join(tmpdir(), "ahub-544-host-bin-")));
  const peer = "claude-triage", tree = join(root, ".worktrees", peer), home = join(root, "home"), bin = join(root, "bin"), stateDir = join(root, ".agenthub", "state"), callFile = join(root, "fake-call.json");
  const keys = ["HOME", "CLAUDE_CONFIG_DIR", "AGENTHUB_HOME", "AMEM_HOME", "PATH"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const clients: ControlClient[] = []; let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const close = async () => {
    for (const client of clients) client.close();
    await daemon?.stop();
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(root, { recursive: true, force: true }); rmSync(hostBin, { recursive: true, force: true });
  };
  try {
    mkdirSync(home); mkdirSync(bin); mkdirSync(stateDir, { recursive: true });
    const git = hostExecutable("git", root, previous.PATH ?? "/usr/bin:/bin");
    writeFileSync(join(hostBin, "git"), `#!/bin/sh\nexport GIT_CONFIG_SYSTEM=/dev/null\nexport GIT_CONFIG_GLOBAL=/dev/null\nexec ${shellQuote(git)} "$@"\n`, { mode: 0o700 });
    const env = hubGitEnv({ ...process.env, HOME: home, PATH: `${hostBin}:${previous.PATH ?? "/usr/bin:/bin"}` }, { repositoryIsolation: true });
    for (const args of [["init", "-q"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "triage fixture"], ["worktree", "add", "-qb", "triage/worker", tree], ["remote", "add", "origin", "https://github.com/fixture/triage.git"]]) expect(hubGitSync(["-C", root, ...args], { encoding: "utf8", env }).status).toBe(0);
    mkdirSync(join(tree, "test")); writeFileSync(join(tree, "test", "ci-watch.test.ts"), 'throw new Error("fixture command must not execute");\n');
    writeFileSync(join(bin, "claude"), `#!${process.execPath}\nimport{writeFileSync,renameSync}from"node:fs";\nif(process.argv.includes("--version")){console.log(${JSON.stringify(VERSION + " (Claude Code)")});process.exit(0)}\nawait new Response(Bun.stdin.stream()).text();\nwriteFileSync(${JSON.stringify(callFile + ".tmp")},JSON.stringify({args:process.argv.slice(2),launchId:process.env.AGENTHUB_LAUNCH_ID,peer:process.env.AGENTHUB_PEER_ID}));renameSync(${JSON.stringify(callFile + ".tmp")},${JSON.stringify(callFile)});\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
    Object.assign(process.env, { HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude"), AGENTHUB_HOME: join(home, "hub"), AMEM_HOME: join(home, "memory"), PATH: `${bin}:${hostBin}:${previous.PATH ?? "/usr/bin:/bin"}` });
    writeTrust("claude-implementer", VERSION, false, trustFile(join(home, "hub")));
    writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify({ instances: { [peer]: { kind: "claude", roles: ["implementer"], start_mode: "headless", worktree: `.worktrees/${peer}`, permission_mode: "ask-when-needed" } }, roles: { [peer]: ["implementer"] }, roster: { [peer]: true }, memory: { enabled: false, native: false }, inference: { enabled: false }, mlx: { enabled: false }, snapshots: { enabled: false }, pi: { enabled: false, auto_start: false }, task_sweep: { enabled: false }, batch_ms: 0 }));
    daemon = await startDaemon({ cwd: root, stateDir, config: loadConfig(root), controlPort: 0, codexAppPort: 0, codexProxyPort: 0, permissionTimeoutMs: 4000, agentDrift: false, shellDefaultBranchProbe: async () => "main" });
    const person = await ControlClient.connect(stateDir, { role: "console", projectRoot: root }); clients.push(person);
    const instanceId = (await person.request({ t: "status" })).status.instanceId;
    expect(await person.request({ t: "start", peer })).toMatchObject({ ok: true, executionCwd: tree });
    const proposed = await person.request({ t: "task", op: "hub_task_propose", args: { title: "isolated permission triage", class: "test", owner: peer } });
    expect(proposed.ok).toBe(true); const task = Number(String(proposed.text).match(/task #(\d+)/)?.[1]); expect(task).toBeGreaterThan(0);
    // The fake records before idling. This waits for its consumed stdin, never an installed native process.
    for (let n = 0; n < 300 && !existsSync(callFile); n++) await Bun.sleep(5);
    expect(existsSync(callFile)).toBe(true);
    const call = JSON.parse(readFileSync(callFile, "utf8")) as { args: string[]; launchId: string; peer: string };
    const tools = await ControlClient.connect(stateDir, { role: "tools", peer, launchId: call.launchId, projectRoot: root }); clients.push(tools);
    expect(await tools.request({ t: "task", op: "hub_task_accept", args: { id: task } })).toMatchObject({ ok: true });
    const connectPerson = async () => { const client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root }); clients.push(client); return client; };
    return { root, home, peer, tree, stateDir, person, tools, call, instanceId, close, connectPerson };
  } catch (error) { await close(); throw error; }
}

const permissionPush = (client: ControlClient) => {
  const pending = deferred<any>(), closed = deferred<any>(), pushes: any[] = [];
  client.onPush = message => { pushes.push(message); if (message.t === "permission") pending.resolve(message); if (message.t === "permission_closed") closed.resolve(message); };
  client.send({ t: "tail" });
  return { pending: () => withDeadline(pending.promise, "permission push"), closed: () => withDeadline(closed.promise, "permission closure"), pushes };
};

// This proves host policy using a fake native and never redeems the issued shell ticket.
test("#544 trusted unverified admission does not itself disable the closed host-wrapper permission path", async () => {
  expect(assessVersion("claude-implementer", VERSION, [])).toMatchObject({ ok: false, state: "refused" });
  expect(assessVersion("claude-implementer", VERSION, [{ id: "claude-implementer", version: VERSION, at: 1 }])).toMatchObject({ ok: true, state: "trusted" });
  expect(taskShellCommand(COMMAND, { branch: "triage/worker", defaultBranch: "main" })?.kind).toBe("test");
  const f = await fixture();
  try {
    expect(f.call.args[f.call.args.indexOf("--permission-mode") + 1]).toBe("default");
    expect(f.call.args[f.call.args.indexOf("--permission-prompt-tool") + 1]).toBe("mcp__agent-hub__hub_permission_request");
    expect(f.call.args).not.toContain("bypassPermissions"); expect(f.call.args).not.toContain("dontAsk");
    const answer = await f.tools.request({ t: "permission_request", tool: "Bash", input: { command: COMMAND }, wrapperProtocol: 1 });
    if (sandboxAvailable()) {
      expect(answer).toMatchObject({ ok: true, behavior: "allow", wrapperProtocol: 1 });
      expect(answer.updatedInput.command).not.toBe(COMMAND);
    } else {
      expect(answer).toMatchObject({ ok: true, behavior: "deny", message: "no person answered" });
      expect(answer.updatedInput).toBeUndefined();
    }
  } finally { await f.close(); }
}, 20_000);

test("#544 real daemon pending approvals are pushed, replayed to a fresh console, then withdrawn on timeout", async () => {
  const f = await fixture();
  try {
    const live = permissionPush(f.person);
    const answer = f.tools.request({ t: "permission_request", tool: "Bash", input: { command: "pwd && pwd" }, wrapperProtocol: 1 }); void answer.catch(() => {});
    const request = await live.pending();
    expect(request).toMatchObject({ peer: f.peer, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
    expect((await f.person.request({ t: "ui_snapshot" })).permissions).toContainEqual(expect.objectContaining({ id: request.id, peer: f.peer }));
    expect((await f.person.request({ t: "status" })).status.attentionItems).toContainEqual(expect.objectContaining({ kind: "approval", id: request.id, peer: f.peer, level: "act" }));
    const late = await f.connectPerson(), replay = permissionPush(late);
    expect((await replay.pending()).id).toBe(request.id);
    expect(await answer).toMatchObject({ ok: true, behavior: "deny", message: "no person answered" });
    expect(await live.closed()).toMatchObject({ id: request.id, outcome: "cancelled", reason: "expired" });
    expect((await f.person.request({ t: "ui_snapshot" })).permissions).toEqual([]);
    expect((await f.person.request({ t: "status" })).status.attentionItems.filter((item: { kind: string }) => item.kind === "approval")).toEqual([]);
  } finally { await f.close(); }
}, 20_000);

test("#544 missing native tool_use_id denies in the production MCP channel before any daemon approval", async () => {
  const f = await fixture(), observed = permissionPush(f.person); let client: Client | undefined;
  try {
    await f.person.request({ t: "status" }); // Same socket barrier: tail is registered before the test calls MCP.
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("AGENTHUB_") && !["CLAUDECODE", "CLAUDE_CODE_SESSION_ID"].includes(entry[0])));
    Object.assign(env, { HOME: f.home, CLAUDE_CONFIG_DIR: join(f.home, "claude"), AGENTHUB_HOME: join(f.home, "hub"), AMEM_HOME: join(f.home, "memory"), AGENTHUB_MODE: "tools", AGENTHUB_PERMISSION_TOOL: "1", AGENTHUB_PEER_ID: f.peer, AGENTHUB_PROJECT_DIR: f.root, AGENTHUB_STATE_DIR: f.stateDir, AGENTHUB_INSTANCE_ID: f.instanceId, AGENTHUB_LAUNCH_ID: f.call.launchId });
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(REPO_ROOT, "src", "adapters", "claude-channel.ts")], cwd: f.tree, env, stderr: "pipe" });
    let diagnostics = ""; transport.stderr?.on("data", chunk => { diagnostics = (diagnostics + String(chunk)).slice(-16384); });
    client = new Client({ name: "permission-triage-fixture", version: "1" }); await client.connect(transport);
    for (let n = 0; n < 300 && !diagnostics.includes(`connected to hub as "${f.peer}"`); n++) await Bun.sleep(5);
    expect(diagnostics).toContain(`connected to hub as "${f.peer}"`);
    const schema = (await client.listTools()).tools.find(tool => tool.name === "hub_permission_request")!.inputSchema;
    expect(schema.required).toEqual(["tool_name", "input", "tool_use_id"]);
    const result = await client.callTool({ name: "hub_permission_request", arguments: { tool_name: "Bash", input: { command: COMMAND } } });
    const content = result.content as { type: string; text?: string }[];
    expect(JSON.parse(content.filter(row => row.type === "text").map(row => row.text).join("\n"))).toEqual({ behavior: "deny", message: "invalid native permission request" });
    expect(observed.pushes.filter(message => message.t === "permission")).toEqual([]);
    expect((await f.person.request({ t: "ui_snapshot" })).permissions).toEqual([]);
    expect((await f.person.request({ t: "status" })).status.attentionItems.filter((item: { kind: string }) => item.kind === "approval")).toEqual([]);
  } finally { await client?.close(); await f.close(); }
}, 20_000);

// Deliberately dropped push: this proves the UI's current information-source boundary,
// not that a real WebSocket lost a message in the reported incident.
test("#544 console status refresh alone cannot reconstruct a missed permission push, while a later push renders", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-544-console-")), output: string[] = [];
  const id = "triage-approval", expiresAt = Date.now() + 60_000;
  let input = (_text: string) => {}, signal = () => {}, statusReads = 0;
  const terminal: ConsoleTerminal = { columns: 120, rows: 30, isTTY: true, write: text => { output.push(text); }, raw: () => {}, onData: listener => { input = listener; return () => {}; }, onResize: () => () => {}, onSignal: listener => { signal = listener; return () => {}; } };
  const client = { onPush: (_message: any) => {}, onClose: (_code: number, _reason: string) => {}, send: (_message: any) => {}, close: () => {}, request: async (message: any) => {
    if (message.t === "status") statusReads++;
    return { ok: true, status: { peers: {}, attentionItems: [{ kind: "approval", level: "act", id, peer: "claude-triage", until: expiresAt }] }, budget: {}, text: "[]", deliveries: [] };
  } };
  const running = runConsole({ client, cwd: root, stateDir: root, terminal, panels: true, noPet: true, color: false });
  try {
    await until(() => statusReads >= 1, "initial positive status"); input("2"); await until(() => statusReads >= 2, "refresh after choosing approvals");
    expect(output.join("")).toContain("0 approvals"); expect(output.join("")).not.toContain("TRIAGE-PENDING-BASH");
    client.onPush({ t: "permission", id, peer: "claude-triage", title: "TRIAGE-PENDING-BASH", expiresAt, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
    expect(output.join("")).toContain("1 approval"); expect(output.join("")).toContain("TRIAGE-PENDING-BASH");
  } finally { signal(); await running; rmSync(root, { recursive: true, force: true }); }
});
