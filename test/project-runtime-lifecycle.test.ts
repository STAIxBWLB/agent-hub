import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { stageCurrentRuntime, verifyPackage } from "../src/cli/recovery-package.ts";
import { PROTOCOL, PROTOCOL_MIN } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { Registry, type Project } from "../src/hub/registry.ts";
import { recordProjectRuntime, readProjectRuntime } from "../src/hub/project-runtime.ts";
import { projectRuntimeFile, type ProjectRuntimeSelection } from "../src/hub/project-runtime-state.ts";
import { processLiveness, processSignature } from "../src/pi/process-signature.ts";
import { VERSION } from "../src/version.ts";
import { ADAPTERS } from "../src/adapters/registry.ts";

const put = (root: string, name: string, text: string) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
type Owner = { fixture: string; pid: number; pidSignature: string; instanceId: string };

/** The capture factory is synthetic; Registry, control client, lifecycle and manager are production code. */
async function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-runtime-lifecycle-"))), id = randomUUID(), before = { ...process.env }, env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("ORCA_") || key.startsWith("AGENTHUB_") || key.startsWith("OMNIROUTE_") || key.startsWith("CF_ACCESS_")
    || /(?:_API_KEY|_ACCESS_TOKEN|_SECRET|_TOKEN)$/.test(key)) delete env[key];
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]) delete env[key];
  const bin = join(root, "bin"); mkdirSync(bin);
  for (const [name, command] of [["git", "/usr/bin/git"], ["ps", "/bin/ps"]]) {
    put(bin, name!, `#!/bin/sh\nexec ${command} "$@"\n`); chmodSync(join(bin, name!), 0o700);
  }
  Object.assign(env, { HOME: join(root, "home"), AGENTHUB_HOME: join(root, "hub-home"), AMEM_HOME: join(root, "amem-home"),
    CODEX_HOME: join(root, "codex-home"), CLAUDE_CONFIG_DIR: join(root, "claude-home"), KIMI_CODE_HOME: join(root, "kimi-home"),
    PI_CODING_AGENT_DIR: join(root, "pi-home"), QWEN_CODE_HOME: join(root, "qwen-home"), GEMINI_CLI_HOME: join(root, "gemini-home"),
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PATH: bin });
  for (const key of ["HOME", "AGENTHUB_HOME", "AMEM_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "KIMI_CODE_HOME", "PI_CODING_AGENT_DIR", "QWEN_CODE_HOME", "GEMINI_CLI_HOME"])
    mkdirSync(env[key]!, { recursive: true });
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(env, key)) delete process.env[key];
  Object.assign(process.env, env);
  const lifecycle = await import("../src/hub/lifecycle.ts"), manager = await import("../src/hub/manager.ts");
  let registry = new Registry(join(env.AGENTHUB_HOME!, "registry.db")), packages = 0;
  const owners: Owner[] = [], projects: Project[] = [];
  const fake = (marker: string) => `
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Registry } from ${JSON.stringify(resolve(import.meta.dir, "../src/hub/registry.ts"))};
import { processSignature } from ${JSON.stringify(resolve(import.meta.dir, "../src/pi/process-signature.ts"))};
const fixture = ${JSON.stringify(id)}, marker = ${JSON.stringify(marker)}, version = ${JSON.stringify(VERSION)};
const cwd = process.env.AGENTHUB_PROJECT_DIR, stateDir = process.env.AGENTHUB_STATE_DIR;
if (!cwd || !stateDir || !process.argv.includes('daemon')) throw new Error('fixture daemon arguments missing');
const registry = new Registry(), project = registry.list().find(row => row.root === cwd && row.stateDir === stateDir);
if (!project) throw new Error('fixture project registration missing');
const instanceId = randomUUID(), pidSignature = processSignature(process.pid), token = randomUUID();
if (!pidSignature) throw new Error('fixture process identity unavailable');
mkdirSync(stateDir, { recursive: true });
writeFileSync(join(stateDir, 'fixture-runtime-owner.json'), JSON.stringify({fixture,pid:process.pid,pidSignature,instanceId}));
let server, status, closing = false;
const stop = () => {
  if (closing) return; closing = true;
  try {
    const current = JSON.parse(readFileSync(join(stateDir, 'status.json'), 'utf8'));
    if (current.instanceId === instanceId) for (const file of ['status.json','control-token']) rmSync(join(stateDir,file), {force:true});
  } catch {}
  registry.release(project.id, instanceId); registry.close();
  try {
    const owner = JSON.parse(readFileSync(join(stateDir, 'fixture-runtime-owner.json'), 'utf8'));
    if (owner.fixture === fixture && owner.instanceId === instanceId) rmSync(join(stateDir, 'fixture-runtime-owner.json'), {force:true});
  } catch {}
  server?.stop(true); process.exit(0);
};
for (const signal of ['SIGINT','SIGTERM','SIGHUP','SIGQUIT']) process.on(signal, stop);
if (!registry.claim(project.id, instanceId, process.pid, pidSignature)) { stop(); throw new Error('fixture claim refused'); }
server = Bun.serve({ hostname:'127.0.0.1',port:0,
  fetch(req,server) {
    if (req.headers.has('origin')) return new Response('origin refused',{status:403});
    if (server.upgrade(req,{data:{authenticated:false,killing:false}})) return;
    return new Response('fixture control only',{status:404});
  },
  websocket: {
    message(ws,raw) {
      const msg = JSON.parse(String(raw));
      if (msg.t === 'hello') {
        if (msg.token !== token || msg.projectId !== project.id || msg.instanceId !== instanceId || msg.projectRoot !== cwd) { ws.close(4401,'fixture identity refused'); return; }
        ws.data.authenticated = true;
        ws.send(JSON.stringify({rid:msg.rid,t:'welcome',protocol:msg.v,projectId:project.id,instanceId,cwd})); return;
      }
      if (!ws.data.authenticated) { ws.close(4401,'authenticate first'); return; }
      if (msg.t === 'status') { ws.send(JSON.stringify({rid:msg.rid,ok:true,status})); return; }
      if (msg.t === 'kill' && msg.instanceId === instanceId) {
        ws.data.killing = true; ws.send(JSON.stringify({rid:msg.rid,ok:true}));
        setTimeout(stop,1000).unref(); return;
      }
      ws.send(JSON.stringify({rid:msg.rid,ok:false,error:'fixture has no agents or other operations'}));
    },
    close(ws) { if (ws.data.killing) queueMicrotask(stop); }
  }
});
status = {version,cwd,projectId:project.id,instanceId,pid:process.pid,pidSignature,controlPort:server.port,
  protocol:${PROTOCOL_MIN},protocolMin:${PROTOCOL_MIN},protocolMax:${PROTOCOL},peers:{},tasks:{},features:[],
  fixtureMarker:marker,runtimeRoot:resolve(import.meta.dir,'../..')};
writeFileSync(join(stateDir,'control-token'),token);
writeFileSync(join(stateDir,'status.json'),JSON.stringify(status));
`;
  const project = (name: string) => {
    const cwd = join(root, name);
    put(cwd, ".agenthub/config.json", JSON.stringify({ roster: Object.fromEntries(ADAPTERS.map(adapter => [adapter.kind, false])), roles: {},
      memory: { enabled: false }, inference: { enabled: false }, omniroute: { urls: [], access_hosts: [] }, mlx: { enabled: false },
      pi: { enabled: false, auto_start: false }, recovery: { auto_resume_after_crash: false }, snapshots: { enabled: false },
      task_sweep: { enabled: false }, approvals: { notify: false }, terminal: { open: [] } }));
    const value = registry.register(cwd); projects.push(value); return value;
  };
  const capture = (marker: string) => {
    const source = join(root, `fake-package-${++packages}`);
    put(source, "package.json", JSON.stringify({ name: "@staix/agent-hub", version: VERSION }));
    put(source, "src/cli/main.js", "// synthetic entry identity only\n"); put(source, "src/cli/main.ts", fake(marker));
    put(source, "plugins/agent-hub/.claude-plugin/plugin.json", JSON.stringify({ name: "agent-hub", version: VERSION }));
    for (const directory of ["templates", ".claude-plugin"]) mkdirSync(join(source, directory));
    for (const name of ["README.md", "LICENSE", "CHANGELOG.md"]) put(source, name, `fixture ${name}\n`);
    const runtime: ProjectRuntimeSelection = { ...stageCurrentRuntime(source, VERSION, env.AGENTHUB_HOME!, registry), kind: "restart" };
    return { source, runtime };
  };
  const bind = (p: Project, runtime: ProjectRuntimeSelection) => recordProjectRuntime(p, runtime, null, registry);
  const remember = (p: Project) => {
    const owner = JSON.parse(readFileSync(join(p.stateDir, "fixture-runtime-owner.json"), "utf8")) as Owner;
    expect(owner.fixture).toBe(id); owners.push(owner); return owner;
  };
  return { root, env, lifecycle, manager, project, capture, bind, remember, get registry() { return registry; },
    reopen() { registry.close(); registry = new Registry(join(env.AGENTHUB_HOME!, "registry.db")); },
    async close() {
      const failures: unknown[] = [];
      try {
        await manager.stopManager({ home: env.AGENTHUB_HOME });
        for (const p of projects) {
          const file = join(p.stateDir, "fixture-runtime-owner.json");
          if (existsSync(file)) {
            try { const owner = JSON.parse(readFileSync(file, "utf8")) as Owner; if (owner.fixture === id) owners.push(owner); } catch {}
          }
          try { await lifecycle.stopProject(registry.get(p.id) ?? p); }
          catch (error) {
            // A failed fixture handshake still leaves a fixture-owned identity, never authority over an arbitrary PID.
            const owned = owners.filter(owner => owner.fixture === id && processSignature(owner.pid) === owner.pidSignature);
            if (!owned.length) failures.push(error);
            for (const owner of owned) { try { process.kill(owner.pid, "SIGTERM"); } catch {} }
          }
        }
        for (const owner of owners) {
          for (let i = 0; i < 200 && processLiveness(owner.pid, owner.pidSignature) !== "gone"; i++) await Bun.sleep(5);
          if (processLiveness(owner.pid, owner.pidSignature) !== "gone") failures.push(new Error(`owned fixture daemon ${owner.pid} did not exit`));
        }
      } finally {
        registry.close();
        for (const key of Object.keys(process.env)) if (!Object.hasOwn(before, key)) delete process.env[key];
        Object.assign(process.env, before);
        if (!failures.length) rmSync(root, { recursive: true, force: true });
      }
      if (failures.length) throw new AggregateError(failures, `runtime lifecycle fixture cleanup failed; retained ${root}`);
    } };
}

test("#610 updated startProject reuses its fake captured daemon after stop, Registry reopen and mutable source removal", async () => {
  const f = await fixture();
  try {
    const p = f.project("project"), selected = f.capture("retained lifecycle capture"); f.bind(p, selected.runtime);
    expect(selected.runtime.root).not.toBe(resolve(import.meta.dir, ".."));
    const first = await f.lifecycle.startProject(p, { env: f.env }); f.remember(p);
    expect(first).toMatchObject({ version: VERSION, fixtureMarker: "retained lifecycle capture", runtimeRoot: selected.runtime.root });
    expect(readProjectRuntime(p)).toMatchObject({ ...selected.runtime, instanceId: first.instanceId });
    await f.lifecycle.stopProject(p, first.instanceId);
    expect(f.registry.get(p.id)?.instanceId).toBeNull(); expect(existsSync(join(p.stateDir, "status.json"))).toBe(false);
    f.reopen(); rmSync(selected.source, { recursive: true });
    const second = await f.lifecycle.startProject(f.registry.get(p.id)!, { env: f.env }); f.remember(p);
    expect(second).toMatchObject({ version: VERSION, fixtureMarker: "retained lifecycle capture", runtimeRoot: selected.runtime.root });
    expect(second.instanceId).not.toBe(first.instanceId);
    expect(readProjectRuntime(p)).toMatchObject({ ...selected.runtime, instanceId: second.instanceId });
  } finally { await f.close(); }
}, 20_000);

test("#610 actual manager dashboard Start keeps B's fake capture after A selects another same-version digest", async () => {
  const f = await fixture();
  try {
    const a = f.project("project-a"), b = f.project("project-b"), firstA = f.capture("A original"), retainedB = f.capture("B retained");
    f.bind(a, firstA.runtime); f.bind(b, retainedB.runtime);
    await f.manager.startManager({ home: f.env.AGENTHUB_HOME, registry: f.registry, lifecycle: f.lifecycle });
    const url = new URL(await f.manager.openManager({ home: f.env.AGENTHUB_HOME, registry: f.registry, lifecycle: f.lifecycle })), origin = url.origin;
    const session = await fetch(`${origin}/session`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ticket: url.hash.slice(1) }) });
    expect(session.status).toBe(200);
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    const action = async (input: Record<string, unknown>) => {
      const response = await fetch(`${origin}/action`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify(input) });
      expect(response.status).toBe(200); return response.json() as Promise<{ ok: boolean; instanceId?: string; error?: string }>;
    };
    const first = await action({ action: "start", projectId: b.id }); expect(first.ok, first.error).toBe(true); f.remember(b);
    expect((await f.lifecycle.inspectProject(f.registry.get(b.id)!)).status).toMatchObject({ fixtureMarker: "B retained", runtimeRoot: retainedB.runtime.root });
    expect((await action({ action: "stop", projectId: b.id, instanceId: first.instanceId })).ok).toBe(true);
    const bStopped = readFileSync(projectRuntimeFile(b), "utf8"), updatedA = f.capture("A updated"); f.bind(a, updatedA.runtime);
    expect(updatedA.runtime.digest).not.toBe(firstA.runtime.digest); expect(readFileSync(projectRuntimeFile(b), "utf8")).toBe(bStopped);
    const aBefore = readFileSync(projectRuntimeFile(a), "utf8"); rmSync(retainedB.source, { recursive: true });
    const second = await action({ action: "start", projectId: b.id }); expect(second.ok, second.error).toBe(true); f.remember(b);
    expect((await f.lifecycle.inspectProject(f.registry.get(b.id)!)).status).toMatchObject({ fixtureMarker: "B retained", runtimeRoot: retainedB.runtime.root });
    expect(readFileSync(projectRuntimeFile(a), "utf8")).toBe(aBefore);
    const bBefore = readFileSync(projectRuntimeFile(b), "utf8");
    const startedA = await action({ action: "start", projectId: a.id }); expect(startedA.ok, startedA.error).toBe(true); f.remember(a);
    expect((await f.lifecycle.inspectProject(f.registry.get(a.id)!)).status).toMatchObject({ fixtureMarker: "A updated", runtimeRoot: updatedA.runtime.root });
    expect(readFileSync(projectRuntimeFile(b), "utf8")).toBe(bBefore);
  } finally { await f.close(); }
}, 20_000);


test("#610 current mutable-source internal daemon cannot impersonate a byte-identical retained capture", async () => {
  const f = await fixture();
  let child: ReturnType<typeof Bun.spawn> | undefined, settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined, hardStop: ReturnType<typeof setTimeout> | undefined;
  try {
    const p = f.project("direct-internal-daemon"), source = realPath(resolve(import.meta.dir, ".."));
    // Explicit current-source negative leg: the product helper preserves only runtime assets and the exact first-party dependency.
    // This does not execute a published old binary, copy a node_modules tree or claim fake-package isolation for the real entrypoint.
    const runtime: ProjectRuntimeSelection = { ...stageCurrentRuntime(source, VERSION, f.env.AGENTHUB_HOME!, f.registry), kind: "restart" };
    expect(runtime.root).not.toBe(source); expect(runtime.digest).toBe(verifyPackage(source, VERSION)); f.bind(p, runtime);
    const before = readFileSync(projectRuntimeFile(p), "utf8");
    child = Bun.spawn([process.execPath, join(source, "src/cli/main.ts"), "--project", p.root, "daemon"],
      { cwd: p.root, env: f.env, stdout: "pipe", stderr: "pipe" });
    let expired = false;
    const exited = child.exited.then(code => { settled = true; return code; });
    timer = setTimeout(() => {
      expired = true; child!.kill("SIGTERM");
      hardStop = setTimeout(() => { if (!settled) child!.kill("SIGKILL"); }, 2000);
    }, 10_000);
    const stdoutPipe = child.stdout, stderrPipe = child.stderr;
    if (!stdoutPipe || typeof stdoutPipe === "number" || !stderrPipe || typeof stderrPipe === "number") throw new Error("fixture CLI requires piped output");
    const [code, stdout, stderr] = await Promise.all([exited, new Response(stdoutPipe).text(), new Response(stderrPipe).text()]);
    expect(expired, `${stdout}\n${stderr}`).toBe(false);
    expect(code).not.toBe(0);
    expect(stderr).toContain("start with ahub up so the recorded runtime is used");
    expect(existsSync(join(p.stateDir, "status.json"))).toBe(false);
    expect(existsSync(join(p.stateDir, "control-token"))).toBe(false);
    expect(f.registry.get(p.id)?.instanceId).toBeNull();
    expect(readFileSync(projectRuntimeFile(p), "utf8")).toBe(before);
  } finally {
    clearTimeout(timer); clearTimeout(hardStop);
    if (child && !settled) { child.kill("SIGKILL"); await child.exited; }
    await f.close();
  }
}, 20_000);
