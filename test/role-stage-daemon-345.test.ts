import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexPeer } from "../src/adapters/codex-appserver.ts";
import { startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { claudeStateFile } from "../src/hub/claude-state.ts";
import type { PeerAdapter } from "../src/hub/peers.ts";
import type { InstanceConfig } from "../src/hub/instances.ts";

const until = async (condition: () => boolean, label: string) => {
  for (let n = 0; n < 2000 && !condition(); n++) await Bun.sleep(5);
  expect(condition(), label).toBe(true);
};
const rows = (file: string): any[] => existsSync(file)
  ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];

async function fixture() {
  const top = realPath(mkdtempSync(join(tmpdir(), "ahub-role-stage-345-"))), root = join(top, "repo"), home = join(top, "home"), bin = join(top, "bin");
  const stateDir = join(root, ".agenthub", "state"), claudeCalls = join(top, "claude.jsonl"), reviewCalls = join(top, "review.jsonl"), appRequests = join(top, "app.jsonl");
  const before = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, AMEM_HOME: process.env.AMEM_HOME, AGENTHUB_HOME: process.env.AGENTHUB_HOME,
    PATH: process.env.PATH, FAKE_CODEX_REVIEW_LOG: process.env.FAKE_CODEX_REVIEW_LOG, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM };
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, database: Database | undefined;
  const clients: ControlClient[] = [], sockets: WebSocket[] = [];
  const close = async () => {
    for (const socket of sockets) socket.close();
    for (const client of clients) client.close();
    database?.close(); await daemon?.stop();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(top, { recursive: true, force: true });
  };
  try {
    mkdirSync(stateDir, { recursive: true }); mkdirSync(home); mkdirSync(bin);
    writeFileSync(join(root, "fixture.ts"), "fixture file\n");
    Object.assign(process.env, { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), AMEM_HOME: join(home, "memory"), AGENTHUB_HOME: join(home, "hub"),
      PATH: bin + ":" + (before.PATH ?? "/usr/bin:/bin"), FAKE_CODEX_REVIEW_LOG: reviewCalls, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
    const git = (...args: string[]) => {
      const result = hubGitSync(["-C", root, ...args], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0); return result.stdout;
    };
    git("init", "-q"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
    for (const id of ["claude-impl", "codex-impl", "claude-terminal", "codex-moving"]) git("worktree", "add", "-qb", id, join(root, ".worktrees", id));
    const fakeClaude = resolve(import.meta.dir, "fakes/fake-claude-implementer.ts"), fakeReviewer = resolve(import.meta.dir, "fakes/fake-codex-reviewer.ts"), fakeApp = resolve(import.meta.dir, "fakes/codex-planner-345.ts");
    writeFileSync(join(bin, "claude"), "#!" + process.execPath + "\n" +
      "if(process.argv.includes('--version')){console.log('2.1.309 (Claude Code)');process.exit(0)}\n" +
      // This fixture write observes the real owned child's cwd; it is not native tool/sandbox evidence.
      "await Bun.write('implemented.ts','fixture implementation\\n');\n" +
      "process.argv=[process.argv[0]," + JSON.stringify(fakeClaude) + "," + JSON.stringify(claudeCalls) + ",'hang',...process.argv.slice(2)];await import(" + JSON.stringify(fakeClaude) + ");\n", { mode: 0o700 });
    const codexBin = join(bin, "codex");
    writeFileSync(codexBin, "#!" + process.execPath + "\n" +
      "if(process.argv[2]==='app-server'){process.argv.push('--fixture-record'," + JSON.stringify(appRequests) + ");await import(" + JSON.stringify(fakeApp) + ")}else await import(" + JSON.stringify(fakeReviewer) + ");\n", { mode: 0o700 });
    const instances: Record<string, InstanceConfig> = {
      "claude-plan": { kind: "claude", roles: ["planner"] },
      "claude-impl": { kind: "claude", roles: ["implementer"], start_mode: "headless", worktree: ".worktrees/claude-impl", permission_mode: "ask-when-needed" },
      "claude-review": { kind: "claude", roles: ["reviewer"], start_mode: "headless" },
      "codex-plan": { kind: "codex", roles: ["planner"], start_mode: "headless" },
      "codex-impl": { kind: "codex", roles: ["implementer"], start_mode: "headless", worktree: ".worktrees/codex-impl" },
      "codex-review": { kind: "codex", roles: ["reviewer"], start_mode: "headless", review_mode: "fresh" },
      "claude-terminal": { kind: "claude", roles: ["implementer"], worktree: ".worktrees/claude-terminal" },
      "codex-flex": { kind: "codex", start_mode: "headless" },
      "codex-moving": { kind: "codex", start_mode: "headless", worktree: ".worktrees/codex-moving" },
    };
    writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify({ instances, codex_bin: codexBin,
      planner: ["codex-plan", "claude-plan"], roles: { claude: [], codex: [], kimi: [], pi: [], local: [], "codex-flex": ["reviewer"], "codex-moving": ["implementer"] },
      roster: Object.fromEntries(Object.keys(instances).map(id => [id, true])), review: { pool: ["codex"] },
      batch_ms: 0, memory: { enabled: false, native: false }, inference: { enabled: false }, snapshots: { enabled: false },
      mlx: { enabled: false }, pi: { enabled: false, auto_start: false }, task_sweep: { enabled: false }, approvals: { notify: false } }));
    writeFileSync(join(root, ".agenthub", "routing.toml"), '[local]\nfixed_model="fixture"\n[signals]\npii_patterns=["PII_FIXTURE"]\npii_screen="off"\n[classes.implement]\npeers=["claude-impl"]\n[classes.review]\npeers=["codex-review"]\n');
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, shellDefaultBranchProbe: async () => "main" });
    const connect = async (hello: Parameters<typeof ControlClient.connect>[1]) => { const client = await ControlClient.connect(stateDir, hello); clients.push(client); return client; };
    const console_ = await connect({ role: "console", projectRoot: root });
    const status = async () => (await console_.request({ t: "status" })).status;
    const instanceId = (await status()).instanceId;
    database = new Database(join(stateDir, "hub.db"), { readonly: true });
    const record = (id: number) => database!.query("SELECT state,history FROM tasks WHERE id=?").get(id) as { state: string; history: string };
    const planner = async () => {
      const started = await console_.request({ t: "start", peer: "codex-plan" }); expect(started).toMatchObject({ ok: true });
      const socket = new WebSocket(started.proxyUrl); sockets.push(socket); const replies: any[] = [];
      socket.onmessage = event => replies.push(JSON.parse(String(event.data)));
      await new Promise<void>((resolve_, reject) => { socket.onopen = () => resolve_(); socket.onerror = () => reject(new Error("planner proxy connection failed")); });
      socket.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "role-stage-fixture", version: "1" } } }));
      await until(() => replies.some(reply => reply.id === 1), "planner initialize reply");
      socket.send(JSON.stringify({ id: 2, method: "thread/start", params: { cwd: root, sandbox: "workspace-write" } }));
      await until(() => replies.some(reply => reply.id === 2), "planner thread reply");
      expect(replies.find(reply => reply.id === 2)).toMatchObject({ result: { sandbox: { type: "readOnly" } } });
      await until(() => daemon!.bus.stateOf("codex-plan") === "idle", "confirmed planner adopted");
      expect(rows(appRequests).find(request => request.method === "thread/start")?.params.sandbox).toBe("read-only");
      return connect({ role: "tools", peer: "codex-plan", projectRoot: root });
    };
    const channel = async (peer: string) => {
      const launchId = "launch-" + peer, sessionId = "session-" + peer;
      const file = join(stateDir, claudeStateFile("claude-launch", peer));
      writeFileSync(file, JSON.stringify({ instanceId, launchId, executionCwd: root, permissionHook: true, hookPurpose: "permission", launcherPid: process.pid }), { mode: 0o600 }); chmodSync(file, 0o600);
      const client = await connect({ role: "peer", peer, channel: true, projectRoot: root, cwd: root, launchId });
      await until(() => daemon!.bus.stateOf(peer) === "idle", "channel attached");
      const facts = (tool = "Write") => client.request({ t: "facts", phase: "pre", nativeInstanceId: instanceId, nativeLaunchId: launchId, sessionId,
        tool, input: tool === "Bash" ? { command: "touch fixture" } : { file_path: join(root, "fixture.ts"), notebook_path: join(root, "fixture.ts"), content: "fixture" } });
      await facts(); // Establish the managed permission generation before the person's runtime command.
      return { client, facts };
    };
    return { root, stateDir, instances, daemon, console_, status, instanceId, planner, channel, connect, record, claudeCalls, reviewCalls, appRequests, close };
  } catch (error) { await close(); throw error; }
}

test("#525-6 AC3: Codex plans, an owned Claude child implements, and a fresh Codex reviewer records the verdict", async () => {
  const f = await fixture();
  try {
    const planner = await f.planner();
    expect(await f.console_.request({ t: "start", peer: "claude-impl" })).toMatchObject({ ok: true, executionCwd: join(f.root, ".worktrees", "claude-impl") });
    expect(await f.console_.request({ t: "start", peer: "codex-review" })).toMatchObject({ ok: true });
    const task = async (client: ControlClient, op: string, args: Record<string, unknown>) => {
      const reply = await client.request({ t: "task", op, args }); expect(reply, reply.error).toMatchObject({ ok: true }); return String(reply.text);
    };
    const proposed = await task(planner, "hub_task_propose", { title: "role stage fixture", class: "implement", backlog: true, owner: "claude-impl" });
    const id = Number(/#(\d+)/.exec(proposed)![1]);
    const planned = JSON.parse(await task(planner, "hub_backlog_plan", { id, revision: 0, fields: { priority: 1 }, reason: "fixture planner chose its work" }));
    const pulled = JSON.parse(await task(planner, "hub_backlog_pull", { id, revision: planned.planningRevision, reason: "fixture planner pulls its reserved work" }));
    expect(pulled).toMatchObject({ owner: "claude-impl", planner: "codex-plan", plannerReason: "kept" });
    await until(() => rows(f.claudeCalls).length > 0, "owned Claude task child started");
    const child = rows(f.claudeCalls)[0]!;
    expect(child).toMatchObject({ peer: "claude-impl", cwd: join(f.root, ".worktrees", "claude-impl") });
    expect(existsSync(join(f.root, "implemented.ts"))).toBe(false);
    expect(readFileSync(join(child.cwd, "implemented.ts"), "utf8")).toBe("fixture implementation\n");
    const tools = await f.connect({ role: "tools", peer: "claude-impl", projectRoot: f.root, launchId: child.launchId });
    await task(tools, "hub_task_accept", { id });
    await task(tools, "hub_task_done", { id, summary: "fixture implementation delivered", deliverables: [{ path: "implemented.ts", format: "ts" }] });
    await until(() => f.record(id).state === "approved", "fresh reviewer verdict recorded");
    const history = JSON.parse(f.record(id).history);
    expect(history.find((entry: any) => entry.event === "backlogged")).toMatchObject({ by: "codex-plan", planner: "codex-plan", plannerReason: "rotation" });
    expect(history.find((entry: any) => entry.event === "planned")).toMatchObject({ by: "codex-plan" });
    expect(history.find((entry: any) => entry.event === "assigned")).toMatchObject({ owner: "claude-impl", planner: "codex-plan", plannerReason: "kept" });
    expect(history.find((entry: any) => entry.event === "accepted")).toMatchObject({ by: "claude-impl" });
    expect(history.find((entry: any) => entry.event === "done")).toMatchObject({ by: "claude-impl", reviewerFamily: "codex", reviewerReason: "rotation" });
    expect(history.find((entry: any) => entry.event === "approved")).toMatchObject({ by: "codex-review", reviewContext: "fresh", reviewerFamily: "codex", reviewerReason: "rotation" });
    const review = rows(f.reviewCalls).find(call => call.argv);
    expect(review?.peer).toBe("codex-review"); expect(review?.argv).toContain("--ephemeral");
    const shown = JSON.parse(await task(planner, "hub_task_show", { id }));
    const consoleShown = JSON.parse(await task(f.console_, "task_show", { id }));
    for (const view of [shown, consoleShown]) expect(view).toMatchObject({ planner: "codex-plan", plannerReason: "kept", reviewer: "codex-review", reviewerReason: "rotation" });
    const status = await f.status();
    expect(status.roleInfo["codex-plan"]).toMatchObject({ form: "headless", flowRoles: ["planner"], capableRoles: ["planner", "implementer", "verifier", "reviewer", "conductor"] });
    expect(status.roleInfo["claude-impl"]).toMatchObject({ form: "headless", capableRoles: ["implementer", "verifier"] });
    expect(status.roleInfo["claude-plan"].form).toBe("channel");
    expect(status.roleInfo["claude-terminal"].form).toBe("terminal-implementer");
    expect(status.roleInfo["codex-review"]).toMatchObject({ form: "headless", capableRoles: ["reviewer"] });
    expect(status.ownerIsolation["claude-impl"]).toBe(true);
    expect(status.ownerIsolation["codex-plan"]).toBe(false);
    expect(status.ownerIsolationNotes["codex-plan"]).toBe("no declared write worktree");
    for (const extra of Object.keys(f.instances)) expect(typeof status.ownerIsolation[extra]).toBe("boolean");
    const snapshot = await f.console_.request({ t: "ui_snapshot" });
    expect(snapshot.status.roleInfo).toEqual(status.roleInfo);
    expect(snapshot.status.ownerIsolation).toEqual(status.ownerIsolation);
    expect(snapshot.tasks.find((row: any) => row.id === id)).toMatchObject({ planner: "codex-plan", plannerReason: "kept", owner: "claude-impl", reviewer: "codex-review", reviewerReason: "rotation" });
  } finally { await f.close(); }
}, 20_000);

test("#525-6 authenticated Claude planner facts withhold mutation grants in every mode while builtin behavior remains unchanged", async () => {
  const f = await fixture();
  try {
    const planner = await f.channel("claude-plan"), builtin = await f.channel("claude");
    for (const mode of ["ask", "ask-when-needed", "never-ask"]) {
      for (const peer of ["claude-plan", "claude"]) expect(await f.console_.request({ t: "permission", peer, mode, confirmed: true })).toMatchObject({ ok: true });
      for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]) {
        const planReply = await planner.facts(tool), builtinReply = await builtin.facts(tool);
        expect(planReply).toMatchObject({ ok: true, permission: "ask", mutationGrants: false });
        // Older hooks only know permission: the daemon must withhold their automatic mutation grant too.
        expect(planReply.permission).not.toBe("never-ask");
        expect(builtinReply).toMatchObject({ permission: mode });
        expect(builtinReply).not.toHaveProperty("mutationGrants");
      }
      expect((await f.status()).peers["claude-plan"].permissionMode ?? "ask").toBe(mode);
    }
    const privateText = "PII_FIXTURE private fixture text";
    const proposed = await f.console_.request({ t: "task", op: "hub_task_propose", args: { title: privateText, class: "implement" } });
    expect(proposed, proposed.error).toMatchObject({ ok: true });
    const id = Number(/#(\d+)/.exec(String(proposed.text))![1]);
    const shown = await planner.client.request({ t: "task", op: "hub_task_show", args: { id } });
    expect(shown).toMatchObject({ ok: true });
    const view = JSON.parse(String(shown.text));
    expect(view).toMatchObject({ title: "[pii]", detail: "[pii]", history: [] });
    expect(JSON.stringify(view)).not.toContain(privateText);
    const snapshot = await f.console_.request({ t: "ui_snapshot" });
    expect(JSON.stringify(snapshot.tasks.find((row: any) => row.id === id))).not.toContain(privateText);
  } finally { await f.close(); }
}, 20_000);

async function setLivePolicyRoles(f: Awaited<ReturnType<typeof fixture>>, peer: string, roles: string[]) {
  const file = join(f.root, ".agenthub", "config.local.json"), config = JSON.parse(readFileSync(file, "utf8"));
  config.roles[peer] = roles; writeFileSync(file, JSON.stringify(config));
  const preview = await f.console_.request({ t: "settings_reload" }); expect(preview, preview.error).toMatchObject({ ok: true });
  let applied: unknown;
  if (preview.confirmation) {
    applied = await f.console_.request({ t: "settings_reload", confirm: preview.confirmation.token });
    expect(applied).toMatchObject({ ok: true });
  }
  const after = await f.status();
  expect(after.roleInfo[peer].flowRoles, JSON.stringify({ preview, applied, planner: after.planner, storedPlanner: JSON.parse(readFileSync(file, "utf8")).planner })).toContain("planner");
}

for (const peer of ["codex-flex", "codex-moving"]) test(`#525-6 a live role transition rechecks the planner thread ceiling for ${peer}`, async () => {
  const f = await fixture();
  let socket: WebSocket | undefined;
  try {
    expect(await f.console_.request({ t: "settings_set", key: "planner", value: null })).toMatchObject({ ok: true });
    const started = await f.console_.request({ t: "start", peer }); expect(started).toMatchObject({ ok: true });
    expect((await f.status()).roleInfo[peer].flowRoles).not.toContain("planner");
    await setLivePolicyRoles(f, peer, ["planner"]);
    expect((await f.status()).roleInfo[peer].flowRoles).toContain("planner");
    const before = rows(f.appRequests).filter(row => row.method === "thread/start").length;
    const replies: any[] = []; let closed = false;
    socket = new WebSocket(started.proxyUrl); socket.onmessage = event => replies.push(JSON.parse(String(event.data))); socket.onclose = () => { closed = true; };
    await new Promise<void>((resolve_, reject) => { socket!.onopen = () => resolve_(); socket!.onerror = () => reject(new Error("live-role proxy connection failed")); });
    socket.send(JSON.stringify({ id: 100, method: "thread/start", params: { sandbox: "workspace-write" } }));
    if (peer === "codex-flex") {
      await until(() => replies.some(row => row.id === 100), "live planner reply");
      expect(replies.find(row => row.id === 100)).toMatchObject({ result: { sandbox: { type: "readOnly" } } });
      expect(rows(f.appRequests).filter(row => row.method === "thread/start").at(-1)?.params.sandbox).toBe("read-only");
    } else {
      await until(() => closed, "planner worktree link refused");
      expect(replies.find(row => row.id === 100)?.error).toBeDefined();
      expect(rows(f.appRequests).filter(row => row.method === "thread/start")).toHaveLength(before);
      expect(f.daemon.bus.stateOf(peer)).toBe("offline");
    }
  } finally { socket?.close(); await f.close(); }
}, 20_000);

test("#525-6 a role change while startup awaits cannot admit a planner in an old writing worktree", async () => {
  const f = await fixture(), original = CodexPeer.prototype.start;
  let entered = false, release!: () => void, starting: Promise<any> | undefined;
  const held = new Promise<void>(resolve_ => { release = resolve_; });
  CodexPeer.prototype.start = async function () { entered = true; await held; await original.call(this); };
  try {
    expect(await f.console_.request({ t: "settings_set", key: "planner", value: null })).toMatchObject({ ok: true });
    starting = f.console_.request({ t: "start", peer: "codex-moving" }).catch(error => ({ ok: false, error: String(error) }));
    await until(() => entered, "native startup held");
    await setLivePolicyRoles(f, "codex-moving", ["planner"]);
    release();
    expect(await starting).toMatchObject({ ok: false, error: "instance execution policy changed during startup" });
    expect(f.daemon.bus.stateOf("codex-moving")).toBe("offline");
    expect(rows(f.appRequests).filter(row => row.method === "thread/start" || row.method === "turn/start")).toHaveLength(0);
  } finally { release(); await starting; CodexPeer.prototype.start = original; await f.close(); }
}, 20_000);

test("#525-6 builtin form reports the active adapter port and keeps an explicit unknown form unknown", async () => {
  const f = await fixture();
  const peer: PeerAdapter = { id: "kimi", state: "idle", form: "headless", start: async () => {}, stop: async () => {}, deliver: async () => {} };
  try {
    f.daemon.bus.add(peer);
    expect((await f.status()).roleInfo.kimi.form).toBe("headless");
    Object.defineProperty(peer, "form", { value: undefined });
    expect((await f.status()).roleInfo.kimi).not.toHaveProperty("form");
  } finally { await f.close(); }
}, 20_000);
