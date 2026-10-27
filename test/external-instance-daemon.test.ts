import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startDaemon } from "../src/hub/daemon.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { AcpPeer, isAcpPeer } from "../src/adapters/acp.ts";
import { AcpOwnedGroup } from "../src/adapters/acp-owned-group.ts";
import { fakePaths } from "../src/adapters/conformance/fake-paths.ts";

const MODULE_IDS = ["fixture-writer", "fixture-verifier", "fixture-reviewer"] as const;
const roles = ["implementer", "verifier", "reviewer"] as const;
interface FactoryRecord { instance: string; projectRoot: string; stateDir: string; instanceStateDir?: string; cwd: string; mcpServers: { env: { name: string; value: string }[] }[] }
function rows<T>(file: string): T[] { return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as T) : []; }
async function until(condition: () => boolean, label: string) {
  for (let attempt = 0; attempt < 500 && !condition(); attempt++) await Bun.sleep(10);
  expect(condition(), label).toBe(true);
}
async function fixture(factoryMutation = "") {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-external-instances-"))), stateDir = join(root, ".agenthub", "state");
  const previousHome = process.env.HOME, clients: ControlClient[] = [];
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: ControlClient | undefined;
  const close = async () => {
    try { for (const tools of clients) tools.close(); client?.close(); await daemon?.stop(); }
    finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; rmSync(root, { recursive: true, force: true }); }
  };
  try {
    const home = join(root, "home"); mkdirSync(home); process.env.HOME = home;
    const git = (...args: string[]) => {
      const result = hubGitSync(["-C", root, ...args], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(`fixture git failed: ${result.stderr}`);
      return result.stdout;
    };
    git("init", "-q"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
    mkdirSync(join(root, ".agenthub", "adapters"), { recursive: true });
    for (const id of [...MODULE_IDS, "codex-builtin"]) git("worktree", "add", "-b", id, join(root, ".worktrees", id), "HEAD");
    // The shared fake uses s1 in every process. Scope its emitted fake id to the actual peer marker,
    // preserving all real handshake/mode/permission behavior and its intentionally missing load echo.
    const native = join(root, "fake-native.ts");
    writeFileSync(native, `const original=process.stdout.write.bind(process.stdout);
const session="native-"+process.env.AGENTHUB_PEER_ID;
function scoped(value){if(Array.isArray(value))return value.map(scoped);if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,key==="sessionId"&&item==="s1"?session:scoped(item)]));return value;}
process.stdout.write=(chunk,...args)=>original(JSON.stringify(scoped(JSON.parse(String(chunk))))+"\\n",...args);
await import(${JSON.stringify(pathToFileURL(fakePaths.acpServer).href)});\n`);
    const factories = join(root, "factory.jsonl"), imports = join(root, "imports"), moduleFile = join(root, ".agenthub", "adapters", "fixture.mjs");
    const source = `import {appendFileSync} from "node:fs";
import {ADAPTER_API,AcpPeer} from "@staix/agent-hub/adapter";
appendFileSync(${JSON.stringify(imports)},"imported\\n");
export const definition={api:ADAPTER_API,kind:"fixture",family:"fixture",displayName:"External instance fixture",transport:"acp",roles:["implementer","verifier","reviewer"],optional:true,defaultOnRoster:false,
headlessInstances:{form:"headless",roles:["implementer","verifier","reviewer"]},trust:{onPrem:false,hubSandboxed:false},identity:{mcp:"acp-session"},permission:{genericAcp:{modes:{ask:"default"},readOnly:"plan"}},
start:{forms:["headless"],defaultForm:"headless",daemonPort:"acp",conductorStartable:true,hubSwitches:[],ownedFlags:[],
launch:ctx=>({cmd:${JSON.stringify(process.execPath)},args:[${JSON.stringify(native)},"--agent-name","External instance fixture","--agent-version","1","--modes","default,plan","--record-protocol",${JSON.stringify(root)}+"/"+ctx.instance+".protocol"],metadata:{packageEntrypoint:ctx.entrypoint,argv:[],command:"fixture",env:{}}}),
create:ctx=>{appendFileSync(${JSON.stringify(factories)},JSON.stringify({instance:ctx.instance,projectRoot:ctx.projectRoot,stateDir:ctx.stateDir,instanceStateDir:ctx.instanceStateDir,cwd:ctx.daemon.acp.cwd,mcpServers:ctx.mcpServers})+"\\n");${factoryMutation}return new AcpPeer(ctx.instance,ctx.daemon.acp);}},
session:{idField:"sessionId",currentId:peer=>peer.sessionId},turnEnd:"adapter",cli:{command:"fixture",startWords:()=>["fixture"]},display:{palette:{fg:"white",bg:"black"}}};`;
    writeFileSync(moduleFile, source, { mode: 0o600 });
    const bin = join(root, "fake-codex");
    writeFileSync(bin, `#!${process.execPath}\nawait import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "fakes/codex-bin.ts")).href)});\n`, { mode: 0o700 });
    const instances = Object.fromEntries(MODULE_IDS.map((id, index) => [id, { kind: "fixture", roles: [roles[index]!], start_mode: "headless", worktree: `.worktrees/${id}`, ...(id === "fixture-reviewer" ? { readOnly: true } : {}) }]));
    const declarations: Record<string, Record<string, unknown>> = { ...instances, "codex-builtin": { kind: "codex", roles: ["implementer"], worktree: ".worktrees/codex-builtin" } };
    const local = { adapter_modules: [{ path: ".agenthub/adapters/fixture.mjs", sha256: createHash("sha256").update(source).digest("hex") }], instances: declarations, roster: Object.fromEntries([...MODULE_IDS, "codex-builtin"].map(id => [id, true])), codex_bin: bin };
    const localFile = join(root, ".agenthub", "config.local.json");
    writeFileSync(localFile, JSON.stringify(local), { mode: 0o600 });
    writeFileSync(join(root, ".agenthub", "config.json"), JSON.stringify({ batch_ms: 0, memory: { enabled: false, native: false }, inference: { enabled: false }, snapshots: { enabled: false }, approvals: { notify: false }, mlx: { enabled: false }, pi: { enabled: false, auto_start: false } }));
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0 });
    client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
    const records = () => rows<FactoryRecord>(factories);
    const tools = async (id: string) => {
      const record = records().findLast(row => row.instance === id)!;
      const launchId = record.mcpServers.flatMap(server => server.env).find(row => row.name === "AGENTHUB_LAUNCH_ID")?.value;
      const connection = await ControlClient.connect(stateDir, { role: "tools", peer: id, projectRoot: root, launchId }); clients.push(connection); return connection;
    };
    const protocol = (id: string) => rows<{ method: string; params?: any }>(join(root, `${id}.protocol`));
    return { root, stateDir, daemon, client, local, localFile, moduleFile, imports, records, protocol, tools, git, close };
  } catch (error) { await close(); throw error; }
}

async function refusedTask(tools: ControlClient) {
  return tools.request({ t: "task", op: "hub_task_propose", args: { title: "stale external owner must never mutate board", class: "implement" } }).catch(() => ({ ok: false }));
}

test("#754 A1 mixed builtin and module instances bind separate roots, native sessions, state and MCP identities", async () => {
  const f = await fixture(); let tui: WebSocket | undefined;
  try {
    for (const id of MODULE_IDS) expect(await f.client.request({ t: "start", peer: id })).toMatchObject({ ok: true });
    const builtin = await f.client.request({ t: "start", peer: "codex-builtin" });
    expect(builtin).toMatchObject({ ok: true, executionCwd: join(f.root, ".worktrees", "codex-builtin") });
    const replies: any[] = [];
    tui = new WebSocket(builtin.proxyUrl); tui.onmessage = event => replies.push(JSON.parse(String(event.data)));
    await new Promise<void>((resolve, reject) => { tui!.onopen = () => resolve(); tui!.onerror = () => reject(new Error("fake builtin proxy failed")); });
    tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "mixed-instance-fixture" } } }));
    await until(() => replies.some(row => row.id === 1), "builtin initialize");
    tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
    await until(() => replies.some(row => row.id === 2 && row.result?.thread?.id), "builtin native thread");
    const records = f.records(); expect(records).toHaveLength(3);
    expect(new Set(records.map(row => row.instanceStateDir)).size).toBe(3);
    const launchIds = records.map(row => row.mcpServers.flatMap(server => server.env).find(row => row.name === "AGENTHUB_LAUNCH_ID")?.value);
    expect(launchIds.every(Boolean)).toBe(true); expect(new Set(launchIds).size).toBe(3);
    const status = (await f.client.request({ t: "status" })).status;
    for (const record of records) {
      expect(record.instanceStateDir).toBeDefined(); expect(record.instanceStateDir).not.toBe(f.stateDir);
      expect(record.stateDir).toBe(f.stateDir); expect(record.projectRoot).toBe(f.root); expect(record.cwd).toBe(join(f.root, ".worktrees", record.instance));
      expect(record.mcpServers.flatMap(server => server.env)).toContainEqual({ name: "AGENTHUB_PEER_ID", value: record.instance });
      expect(record.mcpServers.flatMap(server => server.env)).toContainEqual({ name: "AGENTHUB_STATE_DIR", value: f.stateDir });
      expect(status.peers[record.instance].externalInstance).toMatchObject({ schema: 1, projectRoot: f.root, instance: record.instance, kind: "fixture", executionCwd: record.cwd });
      expect(status.externalInstanceCatalog.instances.find((row: any) => row.id === record.instance)).toMatchObject({ availability: "ready" });
    }
    const sessions = MODULE_IDS.map(id => f.daemon.bus.peers.get(id)?.nativeSession);
    expect(sessions.every(Boolean)).toBe(true); expect(new Set(sessions).size).toBe(3);
    expect(status.roleInfo["fixture-reviewer"].flowRoles).toEqual(["reviewer"]);
    expect(f.protocol("fixture-reviewer")).toContainEqual(expect.objectContaining({ method: "session/set_mode", params: expect.objectContaining({ modeId: "plan" }) }));
    expect(readFileSync(f.imports, "utf8")).toBe("imported\n");
  } finally { tui?.close(); await f.close(); }
}, 20_000);

test("#754 A2 pin and declaration changes revoke a previously authenticated owner before task effects", async () => {
  for (const changed of ["pin", "declaration"] as const) {
    const f = await fixture();
    try {
      expect(await f.client.request({ t: "start", peer: "fixture-writer" })).toMatchObject({ ok: true });
      const tools = await f.tools("fixture-writer");
      const before = await f.client.request({ t: "task", op: "hub_task_list", args: {} });
      if (changed === "pin") writeFileSync(f.moduleFile, 'throw new Error("CHANGED_MODULE_MUST_NOT_IMPORT");');
      else writeFileSync(f.localFile, JSON.stringify({ ...f.local, instances: { ...f.local.instances, "fixture-writer": { ...f.local.instances["fixture-writer"], worktree: ".worktrees/fixture-verifier" } } }));
      expect((await refusedTask(tools)).ok).toBe(false);
      expect(JSON.parse((await f.client.request({ t: "task", op: "hub_task_list", args: {} })).text)).toEqual(JSON.parse(before.text));
      expect(readFileSync(f.imports, "utf8")).toBe("imported\n");
    } finally { await f.close(); }
  }
}, 20_000);

test("#754 A3 continuing reviewer is read-only and cannot request fresh or native selectors", async () => {
  const f = await fixture();
  try {
    for (const args of [{ fresh: true }, { model: "native-model" }, { route: "native-route" }, { unattended: true }]) {
      expect((await f.client.request({ t: "start", peer: "fixture-reviewer", args })).ok).toBe(false);
    }
    expect(f.records()).toHaveLength(0);
    expect(await f.client.request({ t: "start", peer: "fixture-reviewer" })).toMatchObject({ ok: true });
    const tools = await f.tools("fixture-reviewer"), before = await f.client.request({ t: "task", op: "hub_task_list", args: {} });
    expect((await refusedTask(tools)).ok).toBe(false);
    expect(JSON.parse((await f.client.request({ t: "task", op: "hub_task_list", args: {} })).text)).toEqual(JSON.parse(before.text));
    expect((await f.client.request({ t: "permission", peer: "fixture-reviewer", mode: "never-ask", confirmed: true })).ok).toBe(false);
  } finally { await f.close(); }
}, 20_000);

test("#754 A5 roster teardown retains pending owner, queue and pause until verified stopped", async () => {
  const f = await fixture(), original = AcpOwnedGroup.prototype.stop;
  let stopCalls = 0;
  try {
    const id = "fixture-writer";
    expect(await f.client.request({ t: "start", peer: id })).toMatchObject({ ok: true });
    const owner = f.daemon.bus.peers.get(id); if (!isAcpPeer(owner)) throw new Error("module owner missing");
    const tools = await f.tools(id);
    f.daemon.bus.pause(id);
    expect((await f.client.request({ t: "send", to: [id], body: "retained queued fixture work" })).ok).toBe(true);
    const queued = f.daemon.bus.queueIds(id); expect(queued.length).toBeGreaterThan(0);
    AcpOwnedGroup.prototype.stop = async function (options) { if (++stopCalls === 1) throw new Error("fixture stop evidence unavailable"); return original.call(this, options); };
    expect((await f.client.request({ t: "settings_set", key: `roster.${id}`, value: false, confirm: id })).ok).toBe(false);
    expect(owner.pendingOwnedProcess).toBe(true); expect(owner.state).toBe("offline");
    expect(f.daemon.bus.peers.get(id)).toBe(owner); expect(f.daemon.bus.queueIds(id)).toEqual(queued);
    const count = f.records().length;
    expect((await f.client.request({ t: "start", peer: id })).ok).toBe(false); expect(f.records()).toHaveLength(count);
    expect((await refusedTask(tools)).ok).toBe(false);
    expect((await f.client.request({ t: "peer_stop", peer: id })).ok).toBe(true);
    expect(owner.pendingOwnedProcess).toBe(false);
    expect((await f.client.request({ t: "settings_set", key: `roster.${id}`, value: false, confirm: id })).ok).toBe(true);
    expect(f.daemon.bus.queueIds(id)).toEqual(queued); expect(f.daemon.bus.isPaused(id)).toBe(true);
    expect((await f.client.request({ t: "settings_set", key: `roster.${id}`, value: true })).ok).toBe(true);
    expect(f.daemon.bus.stateOf(id)).toBe("offline"); expect(f.records()).toHaveLength(count); expect(f.daemon.bus.queueIds(id)).toEqual(queued);
  } finally { AcpOwnedGroup.prototype.stop = original; await f.close(); }
}, 20_000);

test("#754 A7 live recovery and incompatible targets refuse before holds, stopped records remain bound", async () => {
  const f = await fixture();
  try {
    const id = "fixture-writer", request = { t: "recovery", expectedInstanceId: f.client.instanceId, targetFeatures: DAEMON_FEATURES };
    expect(await f.client.request({ t: "start", peer: id })).toMatchObject({ ok: true });
    expect((await f.client.request({ ...request, op: "prepare", operationId: "external-live-refusal" })).ok).toBe(false);
    expect(f.daemon.bus.isRecoveryHeld).toBe(false);
    expect((await f.client.request({ t: "peer_stop", peer: id })).ok).toBe(true);
    const incompatible = await f.client.request({ ...request, op: "prepare", operationId: "external-feature-refusal", targetFeatures: DAEMON_FEATURES.filter(feature => feature !== "external_adapter_instances") });
    expect(incompatible.ok).toBe(false); expect(incompatible.error).toContain("external_adapter_instances"); expect(f.daemon.bus.isRecoveryHeld).toBe(false);
    const inspected = await f.client.request({ ...request, op: "inspect" });
    expect(inspected.ok).toBe(true);
    expect(inspected.recovery.peers[id]).toMatchObject({ id, state: "offline", externalInstance: { schema: 1, instance: id, kind: "fixture", projectRoot: f.root, executionCwd: join(f.root, ".worktrees", id) } });
    const records = f.records().length;
    const before = f.protocol(id);
    const arbitraryResume = await f.client.request({ t: "start", peer: id, args: { sessionId: "unrecorded-native-session" } });
    expect(arbitraryResume.ok).toBe(false);
    expect(f.records()).toHaveLength(records);
    expect(f.protocol(id)).toEqual(before); // foreign conversation is refused before factory or native effects
    const recordedSession = inspected.recovery.peers[id].sessionId;
    expect(recordedSession).toBe(`native-${id}`);
    const failedResume = await f.client.request({ t: "start", peer: id, args: { sessionId: recordedSession } });
    expect(failedResume.ok).toBe(false);
    const protocol = f.protocol(id);
    expect(protocol.some(row => row.method === "session/load" && row.params?.sessionId === recordedSession)).toBe(true);
    expect(protocol.filter(row => row.method === "session/new")).toHaveLength(1); // no fresh fallback after the missing load echo
    expect(f.records()).toHaveLength(records + 1);
  } finally { await f.close(); }
}, 20_000);


test("#754 ACP startup may authenticate its pending MCP socket without granting tools before bus admission", async () => {
  const f = await fixture(), original = AcpPeer.prototype.start;
  let nativeStarted = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let starting: Promise<any> | undefined;
  try {
    AcpPeer.prototype.start = async function () {
      await original.call(this);
      if (this.id === "fixture-writer") { nativeStarted = true; await held; }
    };
    starting = f.client.request({ t: "start", peer: "fixture-writer" });
    await until(() => nativeStarted, "real managed ACP handshake held before bus admission");
    expect(f.daemon.bus.peers.has("fixture-writer")).toBe(false);
    const tools = await f.tools("fixture-writer");
    const before = await f.client.request({ t: "task", op: "hub_task_list", args: {} });
    expect((await refusedTask(tools)).ok).toBe(false);
    expect(JSON.parse((await f.client.request({ t: "task", op: "hub_task_list", args: {} })).text)).toEqual(JSON.parse(before.text));
    release(); expect(await starting).toMatchObject({ ok: true });
    expect(f.daemon.bus.peers.has("fixture-writer")).toBe(true);
    expect((await tools.request({ t: "task", op: "hub_task_list", args: {} })).ok).toBe(true); // same authenticated socket, no reconnect
  } finally {
    release(); AcpPeer.prototype.start = original;
    await starting?.catch(() => undefined); await f.close();
  }
}, 20_000);


test("#754 replacing a live owner's exact path with another registered worktree revokes its authority", async () => {
  const f = await fixture();
  try {
    const id = "fixture-writer", cwd = join(f.root, ".worktrees", id);
    expect(await f.client.request({ t: "start", peer: id })).toMatchObject({ ok: true });
    const tools = await f.tools(id), owner = f.daemon.bus.peers.get(id);
    expect((await f.client.request({ t: "status" })).status.ownerIsolation[id]).toBe(true);
    const factories = f.records().length, protocol = f.protocol(id);
    const before = await f.client.request({ t: "task", op: "hub_task_list", args: {} });
    f.git("worktree", "move", cwd, join(f.root, ".worktrees", "retired-writer"));
    f.git("worktree", "add", "-b", "replacement-writer", cwd, "HEAD");
    expect((await refusedTask(tools)).ok).toBe(false);
    expect((await f.client.request({ t: "status" })).status.ownerIsolation[id]).toBe(false);
    expect(f.daemon.bus.peers.get(id)).toBe(owner);
    expect(f.records()).toHaveLength(factories); expect(f.protocol(id)).toEqual(protocol);
    expect(JSON.parse((await f.client.request({ t: "task", op: "hub_task_list", args: {} })).text)).toEqual(JSON.parse(before.text));
  } finally { await f.close(); }
}, 20_000);

test("#754 a factory cannot mutate the host's locked read-only policy or native mode map", async () => {
  for (const mutation of ["ctx.daemon.acp.nativePolicy.lockedReadOnly=false;", "ctx.daemon.acp.nativePolicy.modes.ask='plan';"]) {
    const f = await fixture(mutation);
    try {
      expect((await f.client.request({ t: "start", peer: "fixture-reviewer" })).ok).toBe(false);
      expect(f.records()).toHaveLength(1); // the module factory attempted the frozen write
      expect(f.protocol("fixture-reviewer")).toEqual([]); // no child/native handshake was started
      expect(f.daemon.bus.peers.has("fixture-reviewer")).toBe(false);
    } finally { await f.close(); }
  }
}, 20_000);

test("#754 supported restart preserves stopped module bindings while a builtin channel reattaches normally", async () => {
  const f = await fixture(), operationId = "external-supported-restart";
  let target: Awaited<ReturnType<typeof startDaemon>> | undefined, consoleTwo: ControlClient | undefined, builtinOne: ControlClient | undefined, builtinTwo: ControlClient | undefined;
  const previousOperation = process.env.AGENTHUB_RECOVERY_OPERATION;
  try {
    const id = "fixture-writer";
    expect(await f.client.request({ t: "start", peer: id })).toMatchObject({ ok: true });
    expect((await f.client.request({ t: "peer_stop", peer: id })).ok).toBe(true);
    // A fake authenticated builtin channel exercises the normal reattachment/release fence,
    // without a native account, a terminal launch or any manufactured module restoration proof.
    builtinOne = await ControlClient.connect(f.stateDir, { role: "peer", peer: "claude", channel: false, projectRoot: f.root });
    await until(() => f.daemon.bus.stateOf("claude") === "idle", "source builtin channel attached");
    const count = f.records().length, protocol = f.protocol(id);
    const projectId = (await f.client.request({ t: "status" })).status.projectId;
    const request = { t: "recovery", operationId, expectedInstanceId: f.client.instanceId, targetFeatures: DAEMON_FEATURES };
    const prepared = await f.client.request({ ...request, op: "prepare" });
    expect(prepared).toMatchObject({ ok: true, recovery: { phase: "prepared", ready: true } });
    const binding = prepared.recovery.peers[id].externalInstance;
    expect(binding).toMatchObject({ schema: 1, instance: id, executionCwd: join(f.root, ".worktrees", id) });
    expect((await f.client.request({ ...request, op: "commit" })).committed).toBe(true);
    await f.daemon.stopped;
    f.client.close(); builtinOne.close();
    try {
      process.env.AGENTHUB_RECOVERY_OPERATION = operationId;
      target = await startDaemon({ cwd: f.root, stateDir: f.stateDir, projectId, controlPort: 0, codexAppPort: 0, codexProxyPort: 0 });
    } finally {
      if (previousOperation === undefined) delete process.env.AGENTHUB_RECOVERY_OPERATION; else process.env.AGENTHUB_RECOVERY_OPERATION = previousOperation;
    }
    consoleTwo = await ControlClient.connect(f.stateDir, { role: "console", projectRoot: f.root });
    const targetRequest = { t: "recovery", operationId, expectedInstanceId: consoleTwo.instanceId, targetFeatures: DAEMON_FEATURES };
    const inspected = await consoleTwo.request({ ...targetRequest, op: "inspect" });
    expect(inspected).toMatchObject({ ok: true, recovery: { phase: "restored" } });
    expect(inspected.recovery.peers[id]).toMatchObject({ state: "offline", sessionId: `native-${id}`, externalInstance: binding });
    expect(inspected.recovery.integrity.current).toEqual(inspected.recovery.integrity.expected);
    const missingBuiltin = await consoleTwo.request({ ...targetRequest, op: "release" });
    expect(missingBuiltin.ok).toBe(false); expect(missingBuiltin.error).toContain("claude");
    builtinTwo = await ControlClient.connect(f.stateDir, { role: "peer", peer: "claude", channel: false, projectRoot: f.root });
    await until(() => target!.bus.stateOf("claude") === "idle", "target builtin channel reattached");
    expect((await consoleTwo.request({ ...targetRequest, op: "release" })).released).toBe(true);
    expect(target.bus.isRecoveryHeld).toBe(false);
    for (const moduleId of MODULE_IDS) expect(target.bus.stateOf(moduleId)).toBe("offline");
    expect(f.records()).toHaveLength(count); expect(f.protocol(id)).toEqual(protocol); // no automatic module factory/session resume
    expect((await consoleTwo.request({ t: "status" })).status.recovery.phase).toBe("released");
  } finally {
    if (previousOperation === undefined) delete process.env.AGENTHUB_RECOVERY_OPERATION; else process.env.AGENTHUB_RECOVERY_OPERATION = previousOperation;
    builtinOne?.close(); builtinTwo?.close(); consoleTwo?.close(); await target?.stop(); await f.close();
  }
}, 20_000);

test("#754 external products cannot declare builtin native proof ports even with undefined values", async () => {
  const mutation = 'const product=new AcpPeer(ctx.instance,ctx.daemon.acp);Object.defineProperty(product,"frontendProxy",{value:undefined});return product;';
  const f = await fixture(mutation);
  try {
    expect((await f.client.request({ t: "start", peer: "fixture-writer" })).ok).toBe(false);
    expect(f.records()).toHaveLength(1);
    expect(f.protocol("fixture-writer")).toEqual([]);
    expect(f.daemon.bus.peers.has("fixture-writer")).toBe(false);
  } finally { await f.close(); }
}, 20_000);
