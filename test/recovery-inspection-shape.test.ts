import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectRecovery } from "../src/cli/upgrade-runtime.ts";
import { DAEMON_FEATURES, PROTOCOL, PROTOCOL_MIN } from "../src/hub/control-client.ts";
import { negotiateProtocol, protocolWindow } from "../src/hub/protocol-window.ts";
import { realPath } from "../src/hub/project.ts";
import { Registry } from "../src/hub/registry.ts";
import { VERSION } from "../src/version.ts";

/** Authenticated wire fixture only: no daemon, model, native CLI or external service is started. */
function fixture(recovery: unknown) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-inspection-shape-")));
  const home = join(root, "home"), hubHome = join(root, "hub-home"), projectRoot = join(root, "project");
  for (const directory of [home, hubHome, join(projectRoot, ".agenthub/state")]) mkdirSync(directory, { recursive: true });
  const previous = { HOME: process.env.HOME, AGENTHUB_HOME: process.env.AGENTHUB_HOME };
  process.env.HOME = home; process.env.AGENTHUB_HOME = hubHome;
  writeFileSync(join(projectRoot, ".agenthub/config.json"), "{}");
  const registry = new Registry();
  const project = registry.register(projectRoot); registry.close();
  const token = "inspection-shape-fixture-token", instanceId = "inspection-shape-fixture";
  const status = { projectId: project.id, cwd: project.root, instanceId, pid: process.pid, version: VERSION,
    protocol: PROTOCOL_MIN, protocolMin: PROTOCOL_MIN, protocolMax: PROTOCOL, features: [...DAEMON_FEATURES], peers: {} };
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve<{ authenticated: boolean }>({ hostname: "127.0.0.1", port: 0,
    fetch(request, current) {
      if (current.upgrade(request, { data: { authenticated: false } })) return;
      return new Response("fixture websocket only", { status: 400 });
    }, websocket: { message(socket, bytes) {
      const message = JSON.parse(String(bytes)); requests.push(message);
      const reply = (body: Record<string, unknown>) => socket.send(JSON.stringify({ rid: message.rid, ...body }));
      if (!socket.data.authenticated) {
        if (message.t !== "hello" || message.token !== token) { socket.close(4401, "fixture authentication refused"); return; }
        const offered = protocolWindow(message.v, message.vMin), selected = offered && negotiateProtocol({ v: PROTOCOL, vMin: PROTOCOL_MIN }, offered);
        if (selected === undefined) { socket.close(4426, "fixture protocol mismatch"); return; }
        socket.data.authenticated = true;
        reply({ ok: true, t: "welcome", projectId: project.id, cwd: project.root, instanceId, protocol: selected, features: [...DAEMON_FEATURES] });
      } else if (message.t === "status") reply({ ok: true, status });
      else if (message.t === "recovery" && message.op === "inspect") reply({ ok: true, ...(recovery === undefined ? {} : { recovery }) });
      else reply({ ok: false, error: "unexpected fixture request" });
    } } });
  writeFileSync(join(project.stateDir, "status.json"), JSON.stringify({ ...status, controlPort: server.port }));
  writeFileSync(join(project.stateDir, "control-token"), token);
  return { project, instanceId, requests, async close() {
    await server.stop(true);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  } };
}

const malformed: { name: string; recovery: unknown }[] = [
  { name: "missing recovery", recovery: undefined }, { name: "null recovery", recovery: null },
  { name: "array recovery", recovery: [] }, { name: "primitive recovery", recovery: "unavailable" },
  { name: "missing peers", recovery: {} }, { name: "null peers", recovery: { peers: null } },
  { name: "empty array peers", recovery: { peers: [] } },
  { name: "array peers with a valid-looking row", recovery: { peers: [{ id: "claude", state: "idle" }] } },
  { name: "primitive peers", recovery: { peers: true } }, { name: "null peer row", recovery: { peers: { claude: null } } },
  { name: "array peer row", recovery: { peers: { claude: [] } } },
  { name: "primitive peer row", recovery: { peers: { claude: 1 } } },
  { name: "missing peer id", recovery: { peers: { claude: { state: "idle" } } } },
  { name: "non-string peer id", recovery: { peers: { claude: { id: 1, state: "idle" } } } },
  { name: "missing peer state", recovery: { peers: { claude: { id: "claude" } } } },
  { name: "non-string peer state", recovery: { peers: { claude: { id: "claude", state: false } } } },
];

for (const sample of malformed) test(`#607 authenticated ${sample.name} never proves an empty recovery roster`, async () => {
  const f = fixture(sample.recovery);
  try {
    const observed = await inspectRecovery(f.project);
    expect(observed).toMatchObject({ state: "unavailable", instanceId: f.instanceId, version: VERSION,
      protocol: PROTOCOL, protocolMin: PROTOCOL_MIN, protocolMax: PROTOCOL, peers: [], blockers: ["source recovery metadata is unavailable"] });
    expect(observed.recovery).toBeUndefined();
    await expect(inspectRecovery(f.project, DAEMON_FEATURES)).rejects.toThrow("source recovery metadata is unavailable");
    const reads = f.requests.filter(request => request.t === "recovery");
    expect(reads).toHaveLength(2);
    expect(reads[0]).not.toHaveProperty("targetFeatures");
    expect(reads[1]).toMatchObject({ op: "inspect", expectedInstanceId: f.instanceId, targetFeatures: [...DAEMON_FEATURES] });
    expect(f.requests.every(request => request.t === "hello" || request.t === "status" || request.t === "recovery" && request.op === "inspect")).toBe(true);
  } finally { await f.close(); }
});

test("#607 an explicitly authenticated empty peers object is a valid running recovery roster", async () => {
  const f = fixture({ peers: {}, ready: true, blockers: [] });
  try {
    for (const features of [undefined, DAEMON_FEATURES]) {
      const observed = await inspectRecovery(f.project, features);
      expect(observed).toMatchObject({ state: "running", instanceId: f.instanceId, version: VERSION, peers: [], blockers: [], recovery: { ready: true } });
    }
  } finally { await f.close(); }
});

test("#607 a valid explicit peer row is retained rather than silently replaced with an empty roster", async () => {
  const f = fixture({ peers: { claude: { id: "claude", state: "offline", sessionId: "fixture-session" } }, ready: true });
  try {
    const observed = await inspectRecovery(f.project, DAEMON_FEATURES);
    expect(observed.state).toBe("running"); expect(observed.peers).toEqual([{ id: "claude", state: "offline", sessionId: "fixture-session" }]);
  } finally { await f.close(); }
});
