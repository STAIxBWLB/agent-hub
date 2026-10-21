import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectAdapterCatalog, definitionOf } from "../src/adapters/registry.ts";
import { crashPlan } from "../src/hub/crash.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { Registry } from "../src/hub/registry.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { makeUpgradePlan } from "../src/cli/upgrade-runtime.ts";
import { VERSION } from "../src/version.ts";

const adapters = { fixture: { transport: "acp", command: "never-execute-fixture-agent", args: ["stdio"], displayName: "Fixture ACP", roles: ["implementer"], identity: { name: "Fixture", version: "1" } } };
const instances = { "fixture-extra": { kind: "fixture", roles: ["implementer"], start_mode: "headless" as const } };
const catalog = () => createProjectAdapterCatalog(adapters);

for (const peer of ["fixture", "fixture-extra"]) test(`configured ACP crash recovery retains exact ${peer} conversation without model overrides`, () => {
  const plan = crashPlan([{ peer, meta: { sessionId: "recorded-session:17", launch: { model: "UNTRUSTED-MODEL", route: "other-route", kind: "codex" } } }], instances, catalog());
  expect(plan).toHaveLength(1);
  expect(plan[0]).toMatchObject({ peer, resume: { sessionId: "recorded-session:17" } });
  expect(plan[0]!.resume).toEqual({ sessionId: "recorded-session:17" });
  expect(plan[0]!.fresh).toBeUndefined();
  expect(JSON.stringify(plan)).not.toContain("UNTRUSTED-MODEL");
});

for (const id of [undefined, "", 7, {}, "invalid\nidentity", "x".repeat(4097)]) test(`configured ACP invalid crash identity ${typeof id === "string" ? id.length : typeof id} remains manual without fresh fallback`, () => {
  for (const peer of ["fixture", "fixture-extra"]) {
    const [step] = crashPlan([{ peer, meta: { sessionId: id, launch: { model: "UNTRUSTED-MODEL" } } }], instances, catalog());
    expect(step?.resume).toBeUndefined(); expect(step?.fresh).toBeUndefined();
    expect(step?.how).toContain("identity unavailable");
    expect(step?.how).toContain(peer === "fixture" ? "ahub fixture" : "ahub fixture --as fixture-extra");
  }
});

test("configured crash recovery is project-local and keeps fixed native identity parsing", () => {
  const configured = catalog();
  expect(configured.definitionOf("fixture")).toBeDefined();
  expect(definitionOf("fixture")).toBeUndefined();
  expect(createProjectAdapterCatalog().definitionOf("fixture")).toBeUndefined();
  expect(crashPlan([{ peer: "fixture", meta: { sessionId: "native-session" } }])[0]?.resume).toBeUndefined();
  const [fixed] = crashPlan([{ peer: "qwen", meta: { sessionId: "unsafe/native/path", launch: { model: "chosen" } } }], undefined, configured);
  expect(fixed?.resume).toBeUndefined(); expect(fixed?.fresh).toBeUndefined();
  expect(fixed?.how).toContain("identity unavailable");
});

test("controlled recovery planning refuses configured ACP before runtime or terminal effects", async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ahub-configured-recovery-")));
  const previousHome = process.env.AGENTHUB_HOME;
  const home = join(temp, "home"), root = join(temp, "project");
  mkdirSync(root); process.env.AGENTHUB_HOME = home;
  const requests: { t: string; op?: string }[] = [], commands: string[][] = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    expect(hubGitSync(["init", "-q", root], { encoding: "utf8" }).status).toBe(0);
    mkdirSync(join(root, ".agenthub"));
    writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ adapters, instances }));
    const registry = new Registry(join(home, "registry.db"));
    const project = (() => { try { return registry.register(root); } finally { registry.close(); } })();
    mkdirSync(project.stateDir, { recursive: true });
    const peers = Object.fromEntries(["fixture", "fixture-extra"].map(id => [id, { id, state: "idle", sessionId: `saved-${id}` }]));
    server = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch(request, native) { return native.upgrade(request, { data: {} }) ? undefined : new Response("upgrade required", { status: 400 }); },
      websocket: { message(socket, raw) {
        const msg = JSON.parse(String(raw)); requests.push({ t: msg.t, ...(msg.op ? { op: msg.op } : {}) });
        const identity = { projectId: project.id, instanceId: "configured-source", cwd: root, protocol: PROTOCOL };
        if (msg.t === "hello") return void socket.send(JSON.stringify({ rid: msg.rid, t: "welcome", ok: true, ...identity }));
        if (msg.t === "status") return void socket.send(JSON.stringify({ rid: msg.rid, t: "status", ok: true, status: { ...identity, pid: process.pid, version: VERSION, features: ["peer_instances", "configured_acp"], peers } }));
        if (msg.t === "recovery" && msg.op === "inspect") return void socket.send(JSON.stringify({ rid: msg.rid, t: "recovery", ok: true, recovery: { ready: true, peers } }));
        socket.send(JSON.stringify({ rid: msg.rid, t: msg.t, ok: false, error: "fixture refuses effects" }));
      } },
    });
    writeFileSync(join(project.stateDir, "control-token"), "configured-recovery-fixture-token");
    writeFileSync(join(project.stateDir, "status.json"), JSON.stringify({ controlPort: server.port, pid: process.pid, protocol: PROTOCOL, projectId: project.id, instanceId: "configured-source", cwd: root }));
    const plan = await makeUpgradePlan("restart", VERSION, root, async argv => { commands.push(argv); throw new Error("no terminal or native command is allowed"); });
    expect(plan.projects).toHaveLength(1);
    const planned = plan.projects[0]!;
    expect(planned.source.state).toBe("running");
    expect(planned.source.peers.map(peer => peer.id).sort()).toEqual(["fixture", "fixture-extra"]);
    const refusal = catalog().definitionOf("fixture")!.session.recoveryRefusal!({ id: "fixture", state: "idle", sessionId: "saved-fixture" });
    expect(planned.blockers).toContain(refusal!);
    expect(planned.terminals).toEqual([]); expect(planned.freshStart).toBeUndefined();
    expect(requests.some(request => request.t === "recovery" && request.op === "inspect")).toBe(true);
    expect(requests.every(request => request.t === "hello" || request.t === "status" || request.t === "recovery" && request.op === "inspect")).toBe(true);
    expect(commands).toEqual([]);
    expect(definitionOf("fixture")).toBeUndefined();
  } finally {
    server?.stop(true); rmSync(temp, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previousHome;
  }
}, 20_000);
