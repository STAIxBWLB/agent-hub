import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { ProgressObserver, type ProgressDeps } from "../src/hub/progress.ts";
import type { ToolObservation } from "../src/models/route/signals.ts";
import { startFakeModelServer } from "./fakes/model-server.ts";
import { DEFAULT_CONFIG, startDaemon, type HubConfig } from "../src/hub/daemon.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { parseRole } from "../src/hub/roles.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { ControlClient, PROTOCOL } from "../src/hub/control-client.ts";
import { TASK_TOOLS, IMPLEMENTER_HUB_TOOL_NAMES, projectToolList } from "../src/hub/hub-tools.ts";
import { ownerToolEffect } from "../src/hub/no-writes.ts";
import { Capture } from "../src/memory/capture.ts";
import type { MemoryClient } from "../src/memory/client.ts";
import { GUIDANCE_CURSOR_MAX_BYTES, guidanceVariantKey, parseGuidancePageResult, parseGuidanceDiffResult, type GuidanceVariantPayloadV1 } from "../src/hub/guidance-variants.ts";
import { renderGuidance, renderGuidanceReceipt } from "../src/cli/guidance.ts";
import { realPath } from "../src/hub/project.ts";
import { processSignature } from "../src/pi/process-signature.ts";
import vectors from "./fixtures/guidance-variant-v1.json";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-guidance-control-")), stateDir = join(root, "state");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(stateDir); mkdirSync(join(root, "kimi-home")); mkdirSync(join(root, ".agenthub/roles"), { recursive: true });
  writeFileSync(join(root, ".agenthub/roles/test-engineer.md"), vectors.baseline);
  writeFileSync(join(root, ".agenthub/config.local.json"), "{}");
  const board = new Board(join(stateDir, "hub.db")); cleanups.push(() => board.close());
  const task = board.propose("user", { title: "Synthetic guidance control task", class: "implement", role: "test-engineer" });
  const config = { ...DEFAULT_CONFIG, roster: {}, start: { agents: [] }, batch_ms: 0,
    memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
    mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, omniroute: { urls: [], access_hosts: [] },
    pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false },
    snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false },
    approvals: { ...DEFAULT_CONFIG.approvals, notify: false } };
  const daemon = await startDaemon({ cwd: root, stateDir, instanceId: "guidance-control-fixture", kimiHome: join(root, "kimi-home"), config,
    controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, memorySyncTrigger: () => {} }); cleanups.push(() => daemon.stop());
  const person = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => person.close());
  const lineage = await person.request({ t: "lineage_show", taskId: task.id });
  expect<boolean>(lineage.ok, lineage.error).toBe(true);
  const node = lineage.lineage.nodes.find((entry: { ref: { tool: string; kind: string } }) => entry.ref.tool === "ahub" && entry.ref.kind === "task");
  const projectKey: string = node.ref.projectKey;
  expect(projectKey).toMatch(/^ahub-[a-f0-9]{64}$/);
  const { id: _id, ...golden } = vectors.golden.record;
  const payload: GuidanceVariantPayloadV1 = { ...golden, v: 1, projectKey, taskId: task.id, taskCreated: task.created, flowRevision: task.history.length,
    author: "user", baseline: { ...golden.baseline, layer: "project" }, evidenceRefs: [] };
  const variant = { ...payload, id: guidanceVariantKey(payload) }, scope = { taskId: task.id, taskCreated: task.created }, selected = { ...scope, id: variant.id };
  return { root, stateDir, board, task, daemon, person, projectKey, variant, scope, selected };
}

test("new control operations and MCP tools use the same closed create/list/show/withdraw DTOs and answer every rid", async () => {
  const f = await fixture(); expect(f.person.features).toContain("guidance_views");
  const taskBefore = f.board.get(f.task.id);
  const created = await f.person.request({ t: "guidance_create", variant: f.variant });
  expect<boolean>(created.ok, created.error).toBe(true);
  expect(created.receipt).toEqual({ id: f.variant.id, taskId: f.task.id, experimentId: f.variant.experimentId, status: "declared", already: false });
  const replay = await f.person.request({ t: "task", op: "hub_guidance_create", args: { variant: f.variant } });
  expect<boolean>(replay.ok, replay.error).toBe(true); expect(JSON.parse(replay.text)).toEqual({ ok: true, receipt: { ...created.receipt, already: true } });
  const before = f.board.guidanceVariantsIntegrity();
  for (const [wire, tool, args, parse] of [
    ["guidance_list", "hub_guidance_list", f.scope, parseGuidancePageResult],
    ["guidance_show", "hub_guidance_show", f.selected, parseGuidanceDiffResult],
  ] as const) {
    const control = await f.person.request({ t: wire, ...args }), mcp = await f.person.request({ t: "task", op: tool, args });
    expect<boolean>(control.ok, control.error).toBe(true); expect<boolean>(mcp.ok, mcp.error).toBe(true);
    expect(parse(control.guidance).state).toBe("available"); expect(JSON.parse(mcp.text)).toEqual({ ok: true, guidance: control.guidance });
    expect(renderGuidance(control.guidance).join("\n")).not.toContain("source: Independent local conformance fixture.");
  }
  expect(f.board.guidanceVariantsIntegrity()).toEqual(before); expect(f.board.get(f.task.id)).toEqual(taskBefore);
  const wrapper = { ...f.selected, flowRevision: f.board.get(f.task.id)!.history.length };
  const withdrawn = await f.person.request({ t: "guidance_withdraw", ...wrapper });
  expect<boolean>(withdrawn.ok, withdrawn.error).toBe(true); expect(withdrawn.receipt.status).toBe("withdrawn");
  const repeated = await f.person.request({ t: "task", op: "hub_guidance_withdraw", args: wrapper });
  expect<boolean>(repeated.ok, repeated.error).toBe(true); expect(JSON.parse(repeated.text)).toEqual({ ok: true, receipt: { ...withdrawn.receipt, already: true } });
  const unknown = await f.person.request({ t: "guidance_unknown", ...f.scope }); expect(unknown.ok).toBe(false); expect(typeof unknown.error).toBe("string");
}, 20_000);

test("unauthorized/forged actors, malformed envelopes, stale epochs and private tasks receive neutral reads or refused writes", async () => {
  const f = await fixture(), peer = await ControlClient.connect(f.stateDir, { role: "tools", peer: "codex" }); cleanups.push(() => peer.close());
  const before = f.board.guidanceVariantsIntegrity();
  for (const args of [{ variant: { ...f.variant, unknown: true } }, { variant: f.variant, by: "user" }, { variant: f.variant, actor: "user" }]) {
    expect((await f.person.request({ t: "guidance_create", ...args })).ok).toBe(false);
    expect((await f.person.request({ t: "task", op: "hub_guidance_create", args })).ok).toBe(false);
  }
  expect((await peer.request({ t: "guidance_create", variant: f.variant })).ok).toBe(false);
  for (const taskId of [f.task.id, 999999]) {
    const denied = await peer.request({ t: "guidance_list", ...f.scope, taskId });
    expect(denied.ok).toBe(true); expect(denied.guidance).toEqual({ state: "unavailable" });
  }
  expect(f.board.guidanceVariantsIntegrity()).toEqual(before);
  expect((await f.person.request({ t: "guidance_create", variant: f.variant })).ok).toBe(true);
  const stale = await f.person.request({ t: "guidance_show", ...f.selected, taskCreated: f.task.created + 1 });
  expect(stale.guidance).toEqual({ state: "unavailable" });
  f.board.update(f.task.id, "user", "note", { signals: ["pii"] });
  const privateRead = await f.person.request({ t: "guidance_list", ...f.scope }); expect(privateRead.guidance).toEqual({ state: "unavailable" });
  const privateWrite = await f.person.request({ t: "guidance_withdraw", ...f.selected, flowRevision: f.board.get(f.task.id)!.history.length }); expect(privateWrite.ok).toBe(false);
}, 20_000);

test("guidance tool publication, capture and owner-progress rules are explicit for all four operations", () => {
  expect(TASK_TOOLS.find(tool => tool.name === "hub_guidance_list")!.inputSchema.properties.cursor).toEqual({ type: "string", maxLength: GUIDANCE_CURSOR_MAX_BYTES });
  const readOnly = projectToolList(TASK_TOOLS, true).map(tool => tool.name), ordinary = projectToolList(TASK_TOOLS).map(tool => tool.name);
  const captured: unknown[] = [], client = { appendCapture: async (value: unknown) => { captured.push(value); } } as unknown as MemoryClient;
  const capture = new Capture(client, { project: "fixture", cwd: "/fixture", deny: [] }); capture.init("fixture-session", "public fixture"); captured.length = 0;
  for (const tool of ["hub_guidance_create", "hub_guidance_list", "hub_guidance_show", "hub_guidance_withdraw"]) {
    expect(ordinary).toContain(tool); expect(IMPLEMENTER_HUB_TOOL_NAMES).toContain(tool); expect(ownerToolEffect(tool, {})).toBe(false);
    if (tool === "hub_guidance_list" || tool === "hub_guidance_show") expect(readOnly).toContain(tool); else expect(readOnly).not.toContain(tool);
    for (const name of [tool, `mcp__agent-hub__${tool}`]) capture.observe({ tool: name, args: "GUIDANCE_PRIVATE_ARGUMENT_CANARY", output: "GUIDANCE_PRIVATE_RESULT_CANARY", id: name, paths: [] });
  }
  expect(captured).toEqual([]);
});

async function cliFixture(run: (f: { cli(args: string[], agent?: boolean): Promise<{ code: number; stdout: string; stderr: string }>; requests: Record<string, any>[]; hellos: Record<string, any>[]; support(value: boolean): void; reply(value: unknown): void; receipt(value: unknown): void; proposal: string }) => Promise<void>) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-guidance-cli-"))), home = join(root, "home"), state = join(root, ".agenthub/state");
  mkdirSync(home); mkdirSync(state, { recursive: true }); writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const proposal = join(root, "proposal.json"); writeFileSync(proposal, JSON.stringify(vectors.golden.record));
  const requests: Record<string, any>[] = [], hellos: Record<string, any>[] = []; let supports = true, guidance: unknown = { state: "unavailable" }, receipt: unknown = { id: vectors.golden.expectedId, taskId: 42, experimentId: "experiment-a", status: "declared", already: false };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) { return server.upgrade(req) ? undefined : new Response("fixture"); }, websocket: { message(ws, raw) {
    const row = JSON.parse(String(raw));
    if (row.t === "hello") { hellos.push(row); ws.send(JSON.stringify({ t: "welcome", rid: row.rid, ok: true, cwd: root, protocol: PROTOCOL, projectId: "fixture", instanceId: "fixture", features: supports ? ["guidance_views"] : [] })); }
    else { requests.push(row); ws.send(JSON.stringify({ rid: row.rid, ok: true, ...(row.t === "guidance_list" || row.t === "guidance_show" ? { guidance } : { receipt }) })); }
  } } });
  writeFileSync(join(state, "control-token"), "fixture-token"); writeFileSync(join(state, "status.json"), JSON.stringify({ cwd: root, controlPort: server.port, protocol: PROTOCOL, projectId: "fixture", instanceId: "fixture", pid: process.pid, pidSignature: processSignature(process.pid) }));
  const cli = async (args: string[], agent = false) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd: root,
      env: { HOME: home, AGENTHUB_HOME: join(home, "hub"), AMEM_HOME: join(home, "amem"), XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"), TMPDIR: root, PATH: process.env.PATH, ...(agent ? { AGENTHUB_PEER_ID: "codex" } : {}) },
      stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, stdout, stderr }; }
    finally { clearTimeout(timer); await child.exited; }
  };
  try { await run({ cli, requests, hellos, proposal, support: value => { supports = value; }, reply: value => { guidance = value; }, receipt: value => { receipt = value; } }); }
  finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
}

test("real CLI defaults to human lines, emits only admitted JSON and refuses old hosts before dispatch", async () => {
  await cliFixture(async f => {
    const args = ["guidance", "list", "--task", "42", "--task-created", "100"];
    const human = await f.cli(args); expect(human.code, human.stderr).toBe(0); expect(human.stdout.trim()).toBe(renderGuidance({ state: "unavailable" }).join("\n"));
    const json = await f.cli([...args, "--json"]); expect(json.code, json.stderr).toBe(0); expect(JSON.parse(json.stdout)).toEqual({ state: "unavailable" });
    expect(f.requests.every(row => row.t === "guidance_list" && row.taskId === 42 && row.taskCreated === 100)).toBe(true);
    f.support(false); const before = f.requests.length, unsupported = await f.cli(args); expect(unsupported.code).toBe(1); expect(unsupported.stderr).toContain("upgrade and restart"); expect(f.requests).toHaveLength(before);
    f.support(true); f.reply({ state: "available", current: { taskId: 42, taskCreated: 100, flowRevision: 3 }, records: [], truncated: false, private: "GUIDANCE_RAW_CANARY" });
    const malformed = await f.cli([...args, "--json"]); expect(malformed.code).toBe(1); expect(malformed.stdout).toBe(""); expect(malformed.stderr).not.toContain("GUIDANCE_RAW_CANARY");
  });
}, 20_000);

test("CLI create preserves the complete record and authenticated tools hello; delegated live-test cannot create or withdraw", async () => {
  await cliFixture(async f => {
    const args = ["guidance", "create", "--file", f.proposal];
    const created = await f.cli([...args, "--json"], true); expect(created.code, created.stderr).toBe(0);
    expect(f.requests[0]).toMatchObject({ t: "guidance_create", variant: vectors.golden.record }); expect(f.hellos[0]).toMatchObject({ role: "tools", peer: "codex" });
    const receipt = { id: vectors.golden.expectedId, taskId: 42, experimentId: "experiment-a", status: "declared" as const, already: false };
    expect(JSON.parse(created.stdout)).toEqual(receipt);
    const human = await f.cli(args, true); expect(human.stdout.trim()).toBe(renderGuidanceReceipt(receipt).join("\n"));
    const before = f.hellos.length;
    for (const command of [args, ["guidance", "withdraw", "--task", "42", "--task-created", "100", "--revision", "3", "--id", vectors.golden.expectedId]]) {
      const refused = await f.cli(["--live-test", ...command], true); expect(refused.code).toBe(1); expect(refused.stderr).toContain("live-test");
    }
    expect(f.hellos).toHaveLength(before);
    f.receipt({ ...receipt, id: "f".repeat(64) }); const wrong = await f.cli([...args, "--json"], true); expect(wrong.code).toBe(1); expect(wrong.stdout).toBe(""); expect(wrong.stderr).toContain("unconfirmed");
  });
}, 20_000);


test("an authenticated read-only ACP owner cannot create or withdraw valid guidance through direct or MCP dispatch", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-guidance-readonly-"))), home = join(root, "home"), stateDir = join(root, "state");
  const previousHome = process.env.HOME;
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, person: ControlClient | undefined, tools: ControlClient | undefined, board: Board | undefined;
  try {
    mkdirSync(home); mkdirSync(join(home, "kimi")); mkdirSync(join(root, ".agenthub/roles"), { recursive: true });
    process.env.HOME = home;
    expect(hubGitSync(["init", "-q", root], { encoding: "utf8" }).status).toBe(0);
    expect(hubGitSync(["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "Fixture baseline"], { encoding: "utf8" }).status).toBe(0);
    expect(hubGitSync(["-C", root, "worktree", "add", "-qb", "fixture-check", join(root, ".worktrees/fixture-check")], { encoding: "utf8" }).status).toBe(0);
    writeFileSync(join(root, ".agenthub/roles/test-engineer.md"), vectors.baseline);
    const adapter = { transport: "acp" as const, command: process.execPath,
      args: [join(import.meta.dir, "fakes/acp-server.ts"), "--agent-name", "Fixture ACP", "--agent-version", "1", "--modes", "default,plan"],
      displayName: "Fixture ACP", roles: ["implementer", "verifier"], identity: { name: "Fixture ACP", version: "1" }, permission: { ask: "default" }, readOnly: "plan" };
    const local = { adapters: { fixture: adapter }, instances: { "fixture-check": { kind: "fixture", roles: ["implementer"], start_mode: "headless" as const, readOnly: true, worktree: ".worktrees/fixture-check" } }, roster: { fixture: false, "fixture-check": true } };
    writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify(local));
    const config: HubConfig = { ...DEFAULT_CONFIG, ...local, start: { agents: [] }, batch_ms: 0,
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false },
      approvals: { ...DEFAULT_CONFIG.approvals, notify: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      omniroute: { urls: [], access_hosts: [] }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false } };
    mkdirSync(stateDir);
    board = new Board(join(stateDir, "hub.db"));
    const task = board.propose("user", { title: "Read-only guidance owner fixture", class: "implement", role: "test-engineer" });
    board.update(task.id, "user", "accepted", { owner: "fixture-check", state: "in_progress" });
    const current = board.get(task.id)!;
    daemon = await startDaemon({ cwd: root, stateDir, config, kimiHome: join(home, "kimi"), controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, memorySyncTrigger: () => {} });
    person = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
    const started = await person.request({ t: "start", peer: "fixture-check" }); expect<boolean>(started.ok, started.error).toBe(true);
    tools = await ControlClient.connect(stateDir, { role: "tools", peer: "fixture-check", projectRoot: root });
    const lineage = await person.request({ t: "lineage_show", taskId: task.id }); expect<boolean>(lineage.ok, lineage.error).toBe(true);
    expect(lineage.lineage.state).toBe("available");
    const node = lineage.lineage.nodes.find((entry: { ref: { tool: string; kind: string } }) => entry.ref.tool === "ahub" && entry.ref.kind === "task");
    const projectKey: string = node.ref.projectKey;
    const role = parseRole(vectors.baseline, "test-engineer", "project"), routing = loadRouting(root);
    // Deliberately omit a read-only flag from this library fixture. A successful
    // same-actor/current-session declaration proves ordinary Tasks admission,
    // identity, owner base, catalog and privacy are valid before testing the
    // independent server guard that marks this actual configured peer read-only.
    const direct = new Tasks({ cwd: root, board, bus: daemon.bus, project: "fixture", catalog: { roles: new Map([[role.id, role]]), errors: [] },
      roles: { "fixture-check": ["implementer"] }, notify: () => {},
      routing: () => ({ ...routing, signals: { ...routing.signals, pii_screen: "off", pii_patterns: [] } }),
      executionLineage: { projectKey, cursorKey: "readonly-guidance-fixture-cursor-000001" } });
    const { id: _id, ...golden } = vectors.golden.record;
    const payload: GuidanceVariantPayloadV1 = { ...golden, v: 1, projectKey, taskId: current.id, taskCreated: current.created, flowRevision: current.history.length,
      author: "fixture-check", baseline: { ...golden.baseline, layer: "project" }, evidenceRefs: [] };
    const variant = { ...payload, id: guidanceVariantKey(payload) }, selector = { taskId: current.id, taskCreated: current.created, id: variant.id }, withdrawal = { ...selector, flowRevision: current.history.length };
    const admitted = await direct.guidanceVariantCreate("fixture-check", variant); expect(admitted.already).toBe(false);
    const before = board.guidanceVariantsIntegrity(), stored = board.guidanceVariants(projectKey, current.id, current.created, variant.experimentId);
    for (const message of [
      { t: "guidance_create", variant }, { t: "guidance_withdraw", ...withdrawal },
      { t: "task", op: "hub_guidance_create", args: { variant } }, { t: "task", op: "hub_guidance_withdraw", args: withdrawal },
    ]) {
      const refused = await tools.request(message); expect(refused.ok).toBe(false); expect(refused.error).toContain("read-only");
      expect(board.guidanceVariantsIntegrity()).toEqual(before);
    }
    const listed = await tools.request({ t: "guidance_list", taskId: current.id, taskCreated: current.created });
    expect<boolean>(listed.ok, listed.error).toBe(true); expect(parseGuidancePageResult(listed.guidance).state).toBe("available");
    const shown = await tools.request({ t: "guidance_show", ...selector }); expect<boolean>(shown.ok, shown.error).toBe(true);
    expect(parseGuidanceDiffResult(shown.guidance).state).toBe("available");
    expect(board.guidanceVariants(projectKey, current.id, current.created, variant.experimentId)).toEqual(stored);
    expect(board.get(current.id)).toEqual(current);
  } finally {
    try { tools?.close(); person?.close(); await daemon?.stop(); }
    finally {
      try { board?.close(); }
      finally {
        if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
}, 20_000);


test("actual hook, Pi executeTool and local callback paths exclude guidance from retained progress and escalation", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-guidance-progress-"))), home = join(root, "home"), stateDir = join(root, "state");
  const previousHome = process.env.HOME, previousClaude = process.env.CLAUDE_CONFIG_DIR, previousKey = process.env.OMNIROUTE_API_KEY;
  const originalObserve = ProgressObserver.prototype.observe;
  const observed: { peer: string; task: number; name: string }[] = [];
  let observer: ProgressObserver | undefined;
  ProgressObserver.prototype.observe = function(peer, task, observation) {
    observer = this; observed.push({ peer, task, name: observation.name });
    return originalObserve.call(this, peer, task, observation);
  };
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, person: ControlClient | undefined, claude: ControlClient | undefined, board: Board | undefined;
  let model: ReturnType<typeof startFakeModelServer> | undefined;
  let restoreSinks: (() => void) | undefined;
  try {
    mkdirSync(home); mkdirSync(join(home, "kimi")); mkdirSync(join(root, ".agenthub/roles"), { recursive: true });
    process.env.HOME = home; process.env.CLAUDE_CONFIG_DIR = join(home, "claude"); process.env.OMNIROUTE_API_KEY = "guidance-progress-fixture-key";
    mkdirSync(process.env.CLAUDE_CONFIG_DIR); writeFileSync(join(root, "read-fixture.txt"), "Read fixture content.");
    writeFileSync(join(root, ".agenthub/roles/test-engineer.md"), vectors.baseline);
    expect(hubGitSync(["init", "-q", root], { encoding: "utf8" }).status).toBe(0);
    model = startFakeModelServer({ key: "guidance-progress-fixture-key", models: ["vllm/test"], script: () => { throw new Error("progress fixture must not request model inference"); } });
    const config: HubConfig = { ...DEFAULT_CONFIG, coordination: "turn-free", roster: { claude: true, pi: true, local: true }, start: { agents: [] }, batch_ms: 0,
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false },
      task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [model.url], access_hosts: [] },
      pi: { ...DEFAULT_CONFIG.pi, enabled: true, auto_start: false, cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts")] } };
    mkdirSync(stateDir);
    board = new Board(join(stateDir, "hub.db"));
    const ownTasks = new Map<string, ReturnType<Board["propose"]>>();
    for (const peer of ["claude", "pi", "local"]) {
      const task = board.propose("user", { title: "Progress exclusion fixture", class: "implement", role: "test-engineer" });
      ownTasks.set(peer, board.update(task.id, "user", "accepted", { owner: peer, state: "in_progress" }));
    }
    daemon = await startDaemon({ cwd: root, stateDir, config, kimiHome: join(home, "kimi"), controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, memorySyncTrigger: () => {} });
    person = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
    claude = await ControlClient.connect(stateDir, { role: "peer", peer: "claude", projectRoot: root });
    const status = await person.request({ t: "status" });
    const piStart = await person.request({ t: "start", peer: "pi", args: { mode: "headless", backend: "dgx" } }); expect<boolean>(piStart.ok, piStart.error).toBe(true);
    const localStart = await person.request({ t: "start", peer: "local", args: { model: "vllm/test" } }); expect<boolean>(localStart.ok, localStart.error).toBe(true);
    const hook = (name: string) => claude!.request({ t: "facts", phase: "pre", tool: name, input: { file_path: join(root, "read-fixture.txt") }, sessionId: "guidance-progress-claude", nativeInstanceId: status.status.instanceId });
    const pi = daemon.bus.peers.get("pi")!;
    const piPort = pi as unknown as { nativeSession?: string; opts: { executeTool(name: string, raw: unknown, callId: string, sessionId?: string): Promise<unknown> } };
    const local = daemon.bus.peers.get("local") as unknown as { opts: { onTool(observation: ToolObservation, task?: string): void } };
    expect(typeof piPort.opts.executeTool).toBe("function"); expect(typeof local.opts.onTool).toBe("function");
    expect(typeof piPort.nativeSession).toBe("string");
    // Unrelated real-path positives establish that all three producer adapters
    // reach the actual daemon observer, rather than a privacy/identity refusal.
    expect((await hook("Read")).ok).toBe(true);
    await piPort.opts.executeTool("read", { path: "read-fixture.txt" }, "progress-positive-read", piPort.nativeSession);
    local.opts.onTool({ name: "read", resultText: "Read fixture content.", source: "local", turn: "local-positive" }, String(ownTasks.get("local")!.id));
    for (const peer of ["claude", "pi", "local"]) expect(observed.some(row => row.peer === peer && row.name.toLowerCase() === "read")).toBe(true);
    if (!observer) throw new Error("real progress observer was not reached");
    const runtime = observer as unknown as { states: Map<string, { peer: string; task: number; generation: number; observations: ToolObservation[]; turn: number; checking: boolean; attemptedTurns: Set<string>; escalation: object }>; d: ProgressDeps };
    const snapshot = () => [...runtime.states.values()].map(state => ({ peer: state.peer, task: state.task, generation: state.generation, observations: structuredClone(state.observations), turn: state.turn, checking: state.checking, attemptedTurns: [...state.attemptedTurns], escalation: structuredClone(state.escalation) }));
    const emitted: unknown[] = [], escalated: unknown[] = [], emit = runtime.d.emit, escalate = runtime.d.inference.escalate;
    runtime.d.emit = event => { emitted.push(event); emit(event); };
    runtime.d.inference.escalate = (conversation, turn) => { escalated.push({ conversation, turn }); return escalate(conversation, turn); };
    restoreSinks = () => { runtime.d.emit = emit; runtime.d.inference.escalate = escalate; };
    const piTask = ownTasks.get("pi")!, lineage = await person.request({ t: "lineage_show", taskId: piTask.id });
    expect<boolean>(lineage.ok, lineage.error).toBe(true); expect(lineage.lineage.state).toBe("available");
    const projectKey: string = lineage.lineage.nodes.find((entry: { ref: { tool: string; kind: string } }) => entry.ref.tool === "ahub" && entry.ref.kind === "task").ref.projectKey;
    const role = parseRole(vectors.baseline, "test-engineer", "project"), routing = loadRouting(root);
    const direct = new Tasks({ cwd: root, board, bus: daemon.bus, project: "fixture", catalog: { roles: new Map([[role.id, role]]), errors: [] }, roles: { pi: ["implementer", "verifier"] }, notify: () => {},
      routing: () => ({ ...routing, signals: { ...routing.signals, pii_screen: "off", pii_patterns: [] } }), executionLineage: { projectKey, cursorKey: "guidance-progress-fixture-cursor-000001" } });
    const { id: _id, ...golden } = vectors.golden.record;
    const payload: GuidanceVariantPayloadV1 = { ...golden, v: 1, projectKey, taskId: piTask.id, taskCreated: piTask.created, flowRevision: piTask.history.length, author: "pi", baseline: { ...golden.baseline, layer: "project" }, evidenceRefs: [] };
    const variant = { ...payload, id: guidanceVariantKey(payload) }; await direct.guidanceVariantCreate("pi", variant);
    const scope = { taskId: piTask.id, taskCreated: piTask.created }, selected = { ...scope, id: variant.id };
    const commands = [
      { name: "hub_guidance_create", input: { variant } }, { name: "hub_guidance_list", input: scope },
      { name: "hub_guidance_show", input: selected }, { name: "hub_guidance_withdraw", input: { ...selected, flowRevision: piTask.history.length } },
    ];
    const before = snapshot(), callsBefore = observed.length;
    for (const [index, command] of commands.entries()) for (const name of [command.name, `mcp__agent-hub__${command.name}`]) {
      expect((await hook(name)).ok).toBe(true);
      const output = await piPort.opts.executeTool(name, command.input, `progress-guidance-${index}-${name}`, piPort.nativeSession);
      if (name === command.name) expect(JSON.parse(String(output)).ok).toBe(true);
      local.opts.onTool({ name, resultText: "Guidance fixture result.", source: "local", turn: `local-guidance-${index}` }, String(ownTasks.get("local")!.id));
    }
    expect(observed).toHaveLength(callsBefore); expect(snapshot()).toEqual(before);
    expect(emitted).toEqual([]); expect(escalated).toEqual([]);
    expect(model.requests).toEqual([]);
  } finally {
    restoreSinks?.(); ProgressObserver.prototype.observe = originalObserve;
    try { claude?.close(); person?.close(); await daemon?.stop(); }
    finally {
      try { board?.close(); model?.stop(); }
      finally {
        if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
        if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousClaude;
        if (previousKey === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = previousKey;
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
}, 20_000);
