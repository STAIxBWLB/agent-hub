import { expect, test, jest } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { sandboxAvailable } from "../src/local/sandbox.ts";
import { completeJsonLines } from "./fakes/jsonl.ts";

async function until(condition: () => boolean, leg: string) { for (let n = 0; n < 300 && !condition(); n++) await Bun.sleep(5); expect(condition(), leg).toBe(true); }
async function fixture(taskBound = false, model?: string, shell?: { origin: true; actionEnabled: boolean; readCanonical?: boolean }) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-claude-impl-daemon-"))), peer = "claude-worker", tree = join(root, ".worktrees", peer), stateDir = join(root, ".agenthub", "state"), log = join(root, "calls.jsonl"), home = join(root, "home"), bin = join(root, "bin");
  const oldEnv = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, PATH: process.env.PATH, AMEM_HOME: process.env.AMEM_HOME, AGENTHUB_HOME: process.env.AGENTHUB_HOME };
  mkdirSync(stateDir, { recursive: true }); mkdirSync(home); mkdirSync(bin);
  for (const args of [["init", "-q"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], ["worktree", "add", "-qb", "worker", tree]]) expect(hubGitSync(["-C", root, ...args], { encoding: "utf8" }).status).toBe(0);
  if (shell?.origin) expect(hubGitSync(["-C", root, "remote", "add", "origin", "https://github.com/fixture/repo.git"], { encoding: "utf8" }).status).toBe(0);
  writeFileSync(join(tree, "source.ts"), "fixture source\n");
  writeFileSync(join(bin, "claude"), `#!${process.execPath}\nif(process.argv.includes("--version")){console.log("2.1.309 (Claude Code)");process.exit(0)}\nprocess.argv=[process.argv[0],${JSON.stringify(resolve(import.meta.dir, "fakes/fake-claude-implementer.ts"))},${JSON.stringify(log)},"hang",...process.argv.slice(2)];\nawait import(${JSON.stringify(resolve(import.meta.dir, "fakes/fake-claude-implementer.ts"))});\n`, { mode: 0o700 });
  process.env.HOME = home; process.env.AMEM_HOME = join(home, "memory"); process.env.AGENTHUB_HOME = join(home, "hub"); process.env.CLAUDE_CONFIG_DIR = join(home, ".claude"); process.env.PATH = `${bin}:${oldEnv.PATH}`;
  writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify({ instances: { [peer]: { kind: "claude", roles: ["implementer"], start_mode: "headless", worktree: `.worktrees/${peer}`, permission_mode: "ask-when-needed", ...(model ? { model } : {}) } }, roles: { [peer]: ["implementer"] }, roster: { [peer]: true }, memory: { enabled: false, native: false }, inference: { enabled: false }, snapshots: { enabled: false }, mlx: { enabled: false }, pi: { enabled: false, auto_start: false }, task_sweep: { enabled: false }, batch_ms: 0 }));
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined; const clients: ControlClient[] = [];
  try {
    const config = loadConfig(root);
    if (shell) config.action_policy = { enabled: shell.actionEnabled, always_ask: ["publish", "destroy", "install", "external-write"], budgets: { publish: 1, destroy: 3, install: 2, "external-write": 5 } };
    if (shell?.readCanonical) config.local = { ...config.local, read_allow: [root] };
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, permissionTimeoutMs: 250, config });
    const console_ = await ControlClient.connect(stateDir, { role: "console", projectRoot: root }); clients.push(console_);
    const instanceId = (await console_.request({ t: "status" })).status.instanceId;
    const started = await console_.request({ t: "start", peer }); expect(started).toMatchObject({ ok: true, executionCwd: tree });
    expect((await console_.request({ t: "status" })).status.actionPolicyInfo[peer].enforceable).toBe(false); // idle has no current native child (#402)
    expect(await console_.request({ t: "permission", peer, mode: "ask-when-needed" })).toMatchObject({ ok: true });
    let taskId: number | undefined;
    if (taskBound) {
      const proposed = await console_.request({ t: "task", op: "hub_task_propose", args: { title: "bound fixture task", class: "test", owner: peer } });
      expect(proposed, proposed.error).toMatchObject({ ok: true });
      taskId = Number(String(proposed.text).match(/task #(\d+)/)?.[1]); expect(taskId).toBeGreaterThan(0);
    } else {
      const sent = daemon.bus.publish(newEnvelope("user", "fixture only", { to: [peer] })); expect(sent).toContain(peer);
    }
    await until(() => completeJsonLines(existsSync(log) ? readFileSync(log, "utf8") : "").length > 0, "owned native child log");
    const call = completeJsonLines(readFileSync(log, "utf8"))[0] as any, session = call.args[call.args.indexOf("--session-id") + 1];
    const tools = await ControlClient.connect(stateDir, { role: "tools", peer, launchId: call.launchId, projectRoot: root }); clients.push(tools);
    const connect = async (launchId: string) => { const client = await ControlClient.connect(stateDir, { role: "tools", peer, launchId, projectRoot: root }); clients.push(client); return client; };
    return { taskId, root, peer, tree, stateDir, log, home, daemon, console_, tools, call, session, instanceId, connect, async close() { for (const client of clients) client.close(); await daemon!.stop(); for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { for (const client of clients) client.close(); await daemon?.stop(); for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); throw error; }
}

async function shellTask(f: Awaited<ReturnType<typeof fixture>>, bind = false) {
  expect(await f.tools.request({ t: "task", op: "hub_task_accept", args: { id: f.taskId } })).toMatchObject({ ok: true });
  for (const args of [["update-ref", "refs/remotes/origin/main", "HEAD"], ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]]) expect(hubGitSync(["-C", f.root, ...args], { encoding: "utf8" }).status).toBe(0);
  mkdirSync(join(f.tree, "scripts"), { recursive: true }); writeFileSync(join(f.tree, "scripts", "check.sh"), "#!/bin/sh\n/bin/pwd\n", { mode: 0o700 });
  if (bind) expect(await f.tools.request({ t: "permission_request", tool: "Bash", input: { command: "bun run build" }, wrapperProtocol: 1 })).toMatchObject({ behavior: "allow", wrapperProtocol: 1 });
}
async function runGranted(command: string, cwd: string) {
  const child = Bun.spawn(["/bin/sh", "-c", command], { cwd, env: { ...process.env, GIT_DIR: "/fixture-poison", RIPGREP_CONFIG_PATH: "/fixture-poison" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  } finally { clearTimeout(timer); }
}

test.skipIf(!sandboxAvailable())("#845 current task Bash grants use a single-use host wrapper and persist their branch binding", async () => {
  const f = await fixture(true);
  try {
    await shellTask(f, false);
    const input = { command: "scripts/check.sh --changed" };
    expect(await f.tools.request({ t: "permission_request", tool: "Bash", input: { command: "pwd" }, wrapperProtocol: 1 })).toMatchObject({ behavior: "deny", message: "no person answered" });
    expect(await f.tools.request({ t: "permission_request", tool: "Bash", input: { command: "bun run build" }, wrapperProtocol: 1 })).toMatchObject({ behavior: "allow", wrapperProtocol: 1 });
    const allowed = await f.tools.request({ t: "permission_request", tool: "Bash", input, wrapperProtocol: 1 });
    expect(allowed).toMatchObject({ ok: true, behavior: "allow", wrapperProtocol: 1 });
    expect(allowed.updatedInput.command).not.toBe(input.command);
    expect(await runGranted(allowed.updatedInput.command, f.root)).toEqual({ code: 0, stdout: `${f.tree}\n`, stderr: "" });
    const replay = await runGranted(allowed.updatedInput.command, f.root);
    expect(replay.code).not.toBe(0); expect(replay.stdout).toBe(""); expect(replay.stderr).toContain("host shell execution refused");
    const shown = await f.tools.request({ t: "task", op: "hub_task_show", args: { id: f.taskId } });
    const task = JSON.parse(shown.text); expect(task.refs.branch).toBe("worker");
    expect(task.history.filter((entry: any) => entry.event === "shell branch bound")).toHaveLength(1);
    const build = await f.tools.request({ t: "permission_request", tool: "Bash", input: { command: "bun run build" }, wrapperProtocol: 1 });
    expect(build).toMatchObject({ ok: true, behavior: "allow", wrapperProtocol: 1 });
  } finally { await f.close(); }
}, 20_000);

test("#845 branch changes invalidate outstanding tickets and never rebind the task", async () => {
  const f = await fixture(true, undefined, { origin: true, actionEnabled: false });
  try {
    await shellTask(f);
    const allowed = await f.tools.request({ t: "permission_request", tool: "Bash", input: { command: "git push origin worker" }, wrapperProtocol: 1 });
    expect(allowed.behavior).toBe("allow");
    expect(hubGitSync(["-C", f.tree, "checkout", "-qb", "other-task"], { encoding: "utf8" }).status).toBe(0);
    const stale = await runGranted(allowed.updatedInput.command, f.root);
    expect(stale.code).not.toBe(0); expect(stale.stdout).toBe("");
    expect(await f.tools.request({ t: "permission_request", tool: "Bash", input: { command: "git push origin worker" }, wrapperProtocol: 1 })).toMatchObject({ behavior: "deny", message: "no person answered" });
  } finally { await f.close(); }
}, 20_000);

test("#845 ask, old clients, extra native fields, operators and force push retain person approval", async () => {
  const f = await fixture(true);
  try {
    await shellTask(f);
    for (const request of [
      { tool: "Bash", input: { command: "pwd" } },
      { tool: "Bash", input: { command: "pwd && pwd" }, wrapperProtocol: 1 },
      { tool: "Bash", input: { command: "pwd", cwd: f.root }, wrapperProtocol: 1 },
      { tool: "Bash", input: { command: "pwd", run_in_background: true }, wrapperProtocol: 1 },
      { tool: "Bash", input: { command: "git push --force origin worker" }, wrapperProtocol: 1 },
    ]) expect(await f.tools.request({ t: "permission_request", ...request })).toMatchObject({ behavior: "deny", message: "no person answered" });
    expect(await f.console_.request({ t: "permission", peer: f.peer, mode: "ask" })).toMatchObject({ ok: true });
    expect(await f.tools.request({ t: "permission_request", tool: "Bash", input: { command: "pwd" }, wrapperProtocol: 1 })).toMatchObject({ behavior: "deny", message: "no person answered" });
  } finally { await f.close(); }
}, 20_000);

test("#845 an enabled publish class asks even for an otherwise valid branch-bound push", async () => {
  for (const actionEnabled of [true, false]) {
    const f = await fixture(true, undefined, { origin: true, actionEnabled });
    try {
      await shellTask(f);
      const answer = await f.tools.request({ t: "permission_request", tool: "Bash", input: { command: "git push origin worker" }, wrapperProtocol: 1 });
      if (actionEnabled) expect(answer).toMatchObject({ behavior: "deny", message: "no person answered" });
      else expect(answer).toMatchObject({ behavior: "allow", wrapperProtocol: 1 });
      // No push is redeemed; this fixture proves the policy boundary without network or publication.
    } finally { await f.close(); }
  }
}, 20_000);

test.skipIf(!sandboxAvailable())("#845 model-written gate test cannot read the hub control token or SSH key, even with canonical read allowance", async () => {
  const f = await fixture(true, undefined, { origin: true, actionEnabled: false, readCanonical: true });
  try {
    await shellTask(f);
    const token = join(f.stateDir, "control-token"), ssh = join(f.home, ".ssh", "id_ed25519"), output = join(f.tree, "gate-output");
    mkdirSync(join(f.home, ".ssh")); writeFileSync(ssh, "fixture-ssh-private", { mode: 0o600 });
    expect(readFileSync(token, "utf8").trim().length).toBeGreaterThan(0);
    expect(readFileSync(ssh, "utf8")).toBe("fixture-ssh-private");
    mkdirSync(join(f.tree, "test"));
    writeFileSync(join(f.tree, "test", "gate.test.ts"), `import {expect,test} from "bun:test";import {readFileSync,writeFileSync} from "node:fs";test("kernel gate boundary",()=>{for(const file of ${JSON.stringify([token, ssh])})expect(()=>readFileSync(file,"utf8")).toThrow();expect(()=>writeFileSync(${JSON.stringify(join(f.root, "escaped"))},"outside")).toThrow();writeFileSync(${JSON.stringify(output)},"worktree-write-ok");});`);
    const allowed = await f.tools.request({ t: "permission_request", tool: "Bash", input: { command: "bun test test/gate.test.ts" }, wrapperProtocol: 1 });
    expect(allowed).toMatchObject({ behavior: "allow", wrapperProtocol: 1 });
    const result = await runGranted(allowed.updatedInput.command, f.root);
    expect(result.code, result.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("worktree-write-ok");
    expect(existsSync(join(f.root, "escaped"))).toBe(false);
  } finally { await f.close(); }
}, 20_000);

test.skipIf(sandboxAvailable())("#845 executable task gates ask when the local kernel sandbox is unavailable", async () => {
  const f = await fixture(true);
  try {
    await shellTask(f);
    for (const command of ["scripts/check.sh --changed", "bun run build", "bun test test/gate.test.ts", "git add source.ts", "git commit -m fixture"]) {
      expect(await f.tools.request({ t: "permission_request", tool: "Bash", input: { command }, wrapperProtocol: 1 }), command).toMatchObject({ behavior: "deny", message: "no person answered" });
    }
  } finally { await f.close(); }
}, 20_000);

test("#525 headless current-child facts are isolated; missing or stale launch evidence cannot attach or grant", async () => {
  const f = await fixture();
  try {
    expect((await f.console_.request({ t: "status" })).status.actionPolicyInfo[f.peer]).toMatchObject({ enforceable: true, note: "always-ask active" });
    await expect(f.connect("forged-child")).rejects.toThrow("current Claude child");
    const facts = () => f.tools.request({ t: "facts", phase: "pre", nativeLaunchId: f.call.launchId, nativeInstanceId: f.instanceId, sessionId: f.session, tool: "Write", input: { file_path: join(f.tree, "source.ts"), content: "fixture" } });
    expect(await facts()).toMatchObject({ ok: true, projectRoot: f.tree, permission: "ask-when-needed" });
    expect(await f.tools.request({ t: "facts", phase: "pre", nativeLaunchId: "stale", nativeInstanceId: f.instanceId, sessionId: f.session })).toMatchObject({ ok: false });
    expect(hubGitSync(["-C", f.tree, "checkout", "--detach", "HEAD"], { encoding: "utf8" }).status).toBe(0);
    expect(await facts()).toMatchObject({ ok: false });
    expect((await f.console_.request({ t: "status" })).status.ownerIsolation[f.peer]).toBe(false);
  } finally { await f.close(); }
}, 20_000);

test("#525 only the current child reaches person allow-once or deny; timeout and stopped child deny", async () => {
  const f = await fixture(), pushes: any[] = [];
  try {
    f.console_.onPush = push => { pushes.push(push); }; f.console_.send({ t: "tail" });
    for (const option of ["allow", "deny"]) {
      const before = pushes.length, answer = f.tools.request({ t: "permission_request", tool: "Write", input: { file_path: join(f.tree, "source.ts"), content: "fixture".repeat(120) } });
      await until(() => pushes.slice(before).some(row => row.t === "permission"), "person approval visible");
      const request = pushes.slice(before).find(row => row.t === "permission");
      expect(request.title).toMatch(/ \[cut, \d+ chars\]$/);
      expect(request.options.map((row: any) => row.kind)).toEqual(["allow_once", "reject_once"]);
      expect(await f.console_.request({ t: "permit", id: request.id, option })).toMatchObject({ ok: true });
      expect(await answer).toMatchObject({ ok: true, behavior: option === "allow" ? "allow" : "deny" });
    }
    expect(await f.tools.request({ t: "permission_request", tool: "Write", input: {} })).toMatchObject({ ok: true, behavior: "deny", message: "no person answered" });
    const answer = f.tools.request({ t: "permission_request", tool: "Write", input: {} });
    expect(await f.console_.request({ t: "peer_stop", peer: f.peer })).toMatchObject({ ok: true });
    const stopped = await answer; expect(stopped.behavior === "deny" || stopped.ok === false).toBe(true);
    expect(await f.tools.request({ t: "task", op: "hub_task_show", args: { id: 1 } })).toMatchObject({ ok: false });
  } finally { await f.close(); }
}, 20_000);

test("#525 current-child inbox refuses a private pending batch before pull removes it", async () => {
  const f = await fixture();
  try {
    f.daemon.bus.publish(newEnvelope("user", "private fixture", { to: [f.peer], private: true }));
    const before = f.daemon.bus.queueIds(f.peer);
    expect(before.length).toBeGreaterThan(0);
    expect(await f.tools.request({ t: "inbox" })).toMatchObject({ ok: false });
    expect(f.daemon.bus.queueIds(f.peer)).toEqual(before);
  } finally { await f.close(); }
}, 20_000);

test("#525 a task child reads only its own inbox and leaves another task queued for its own session", async () => {
  const f = await fixture(true);
  try {
    const same = newEnvelope("user", "same task follow-up", { to: [f.peer], refs: { task: String(f.taskId) } });
    f.daemon.bus.publish(same);
    const own = await f.tools.request({ t: "inbox" });
    expect(own.ok).toBe(true);
    expect(own.envs?.some((env: Envelope) => env.id === same.id)).toBe(true);
    const proposed = await f.console_.request({ t: "task", op: "hub_task_propose", args: { title: "second bound fixture task", class: "test", owner: f.peer } });
    expect(proposed, proposed.error).toMatchObject({ ok: true });
    const second = Number(String(proposed.text).match(/task #(\d+)/)?.[1]);
    expect(second).toBeGreaterThan(0); expect(second).not.toBe(f.taskId);
    const before = f.daemon.bus.queueIds(f.peer);
    expect(before.length).toBeGreaterThan(0);
    expect(await f.tools.request({ t: "inbox" })).toMatchObject({ ok: false, error: "inbox delivery belongs to another task session" });
    expect(f.daemon.bus.queueIds(f.peer)).toEqual(before);
  } finally { await f.close(); }
}, 20_000);

test("#525 a current task child records deliverables from its verified worktree through completion", async () => {
  const f = await fixture(true);
  try {
    expect(existsSync(join(f.root, "source.ts"))).toBe(false);
    expect(await f.tools.request({ t: "task", op: "hub_task_done", args: { id: f.taskId, summary: "public fixture delivery", deliverables: [{ path: "source.ts", format: "ts" }] } })).toMatchObject({ ok: true });
    const result = await f.console_.request({ t: "task", op: "task_show", args: { id: f.taskId } });
    expect(result).toMatchObject({ ok: true });
    const task = JSON.parse(String(result.text));
    const sha256 = createHash("sha256").update("fixture source\n").digest("hex");
    expect(task.history.find((row: { event: string }) => row.event === "done").deliverables).toMatchObject([{ path: "source.ts", format: "ts", sha256 }]);
    expect(task.deliverables.files).toMatchObject([{ path: "source.ts", state: "unchanged", sha256 }]);
  } finally { await f.close(); }
}, 20_000);


test("#525 cancelling the bound task revokes a waiting permission even when the person answers allow", async () => {
  const f = await fixture(true);
  try {
    const waiting = new Promise<any>(resolve => { f.console_.onPush = push => { if (push.t === "permission") resolve(push); }; });
    f.console_.send({ t: "tail" });
    // This tests final-answer authority, not expiry or the heartbeat's earlier withdrawal.
    // Native WebSocket I/O stays live while the existing clock/timer ports are held.
    jest.useFakeTimers({ now: Date.now() });
    const heldAt = Date.now();
    const answer = f.tools.request({ t: "permission_request", tool: "Write", input: { file_path: join(f.tree, "source.ts"), content: "cancelled work" } });
    const request = await waiting;
    expect(request.t).toBe("permission"); expect(request.peer).toBe(f.peer);
    expect(jest.getTimerCount()).toBeGreaterThanOrEqual(2);
    expect(await f.console_.request({ t: "task", op: "hub_task_cancel", args: { id: f.taskId, reason: "fixture cancellation" } })).toMatchObject({ ok: true });
    expect(Date.now()).toBe(heldAt);
    expect(await f.console_.request({ t: "permit", id: request.id, option: "allow" })).toMatchObject({ ok: true });
    const result = await answer;
    expect(result.ok === false || result.behavior === "deny").toBe(true);
  } finally { jest.useRealTimers(); await f.close(); }
  expect(jest.isFakeTimers()).toBe(false);
}, 20_000);

test("#525 an approval answer revalidates a worktree changed while its heartbeat was waiting", async () => {
  const f = await fixture(), pushes: any[] = [];
  try {
    f.console_.onPush = push => { pushes.push(push); }; f.console_.send({ t: "tail" });
    const answer = f.tools.request({ t: "permission_request", tool: "Write", input: {} });
    await until(() => pushes.some(row => row.t === "permission"), "approval visible before root change");
    expect(hubGitSync(["-C", f.tree, "checkout", "--detach", "HEAD"], { encoding: "utf8" }).status).toBe(0);
    const request = pushes.find(row => row.t === "permission");
    expect(await f.console_.request({ t: "permit", id: request.id, option: "allow" })).toMatchObject({ ok: true });
    const result = await answer;
    expect(result.ok === false || result.behavior === "deny").toBe(true);
  } finally { await f.close(); }
}, 20_000);

test("#844 a declared model reaches the native argv and the status row", async () => {
  const f = await fixture(false, "claude-sonnet-5-5");
  try {
    expect(f.call.args[f.call.args.indexOf("--model") + 1]).toBe("claude-sonnet-5-5");
    expect((await f.console_.request({ t: "status" })).status.peers[f.peer].modelSource).toBe("claude-sonnet-5-5");
  } finally { await f.close(); }
}, 20_000);

test("#844 without a declared model the native argv and the status row carry none", async () => {
  const f = await fixture();
  try {
    expect(f.call.args).not.toContain("--model");
    expect((await f.console_.request({ t: "status" })).status.peers[f.peer].modelSource).toBeUndefined();
  } finally { await f.close(); }
}, 20_000);
