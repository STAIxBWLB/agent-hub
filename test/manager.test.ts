import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManager, startManager, stopManager, type Lifecycle, type ProjectRecord } from "../src/hub/manager.ts";

import { PROTOCOL } from "../src/hub/control-client.ts";
import { MAX_COMMAND_MS } from "../src/cli/terminal-recovery.ts";

const dirs: string[] = [];
afterEach(async () => { await stopManager({ home: dirs.at(-1) }); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const home = mkdtempSync(join(tmpdir(), "ahub-manager-")); dirs.push(home);
  const project: ProjectRecord = { id: "p1", root: "/tmp/project", stateDir: join(home, "state"), basePort: 4600, instanceId: "i1", pid: 42 };
  const registry = { get: (id: string) => id === project.id ? project : undefined, list: () => [project] } as any;
  const lifecycle: Lifecycle = {
    inspectProject: async () => ({ state: "running", status: { instanceId: "i1", peers: {} } }),
    startProject: async () => ({ started: true }),
    stopProject: async () => {},
  };
  return { home, registry, lifecycle };
}

test("manager starts with an authenticated one-time dashboard ticket", async () => {
  const { home, registry, lifecycle } = setup();
  await startManager({ home, registry, lifecycle });
  const files = join(home, "manager");
  const status = JSON.parse(readFileSync(join(files, "status.json"), "utf8"));
  const token = readFileSync(join(files, "control-token"), "utf8").trim();
  const denied = await fetch(`http://127.0.0.1:${status.port}/open`, { method: "POST" });
  expect(denied.status).toBe(401);
  const opened = await fetch(`http://127.0.0.1:${status.port}/open`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  expect(opened.status).toBe(200);
  expect(((await opened.json()) as { url?: string }).url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  expect(await openManager({ home, registry, lifecycle })).not.toBe(await openManager({ home, registry, lifecycle }));
});

test("listing isolates an unavailable project", async () => {
  const { home, registry, lifecycle } = setup();
  lifecycle.inspectProject = async () => { throw new Error("dead hub"); };
  await startManager({ home, registry, lifecycle });
  const status = JSON.parse(readFileSync(join(home, "manager", "status.json"), "utf8"));
  const token = readFileSync(join(home, "manager", "control-token"), "utf8").trim();
  const opened = await fetch(`http://127.0.0.1:${status.port}/open`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  const url = (await opened.json() as { url: string }).url;
  const origin = new URL(url).origin;
  const cookie = (await fetch(`${origin}/session`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ticket: url.split("#")[1] }) })).headers.get("set-cookie")!;
  const projects = await fetch(`${origin}/projects`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: "{}" });
  const body = await projects.json() as any;
  expect(body.projects[0].state).toBe("unavailable");
});

test("manager accepts the explicitly supported protocol-9 HTTP owner during protocol-10 refresh", async () => {
  const home = mkdtempSync(join(tmpdir(), "ahub-manager-v9-"));
  const instanceId = "legacy-manager-instance";
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      if (req.headers.get("authorization") !== "Bearer legacy") return new Response("unauthorized", { status: 401 });
      return Response.json({ ok: true, instanceId, url: "http://127.0.0.1:1/#ticket" });
    },
  });
  const managerDir = join(home, "manager");
  mkdirSync(managerDir, { recursive: true });
  writeFileSync(join(managerDir, "control-token"), "legacy\n");
  writeFileSync(join(managerDir, "status.json"), JSON.stringify({ port: server.port, protocol: 9, instanceId, pid: process.pid }));
  try {
    expect(await openManager({ home })).toBe("http://127.0.0.1:1/#ticket");
  } finally { server.stop(true); rmSync(home, { recursive: true, force: true }); }
});

// issue #56: the detached manager must not outlive its AGENTHUB_HOME.
test("the manager stops when its state directory vanishes", async () => {
  const { home, registry, lifecycle } = setup();
  const manager = await startManager({ home, registry, lifecycle, orphanWatchMs: 50 });
  rmSync(join(home, "manager"), { recursive: true, force: true });
  const bounded = new Promise<void>((_, reject) => setTimeout(() => reject(new Error("manager did not stop after losing its state dir")), 5_000));
  await Promise.race([manager.stopped, bounded]);
});


async function scriptedAction(replyDelayMs?: number) {
  const fixture = setup();
  const project = fixture.registry.get("p1") as ProjectRecord;
  const requests: any[] = [], limits: [string, number][] = [];
  const hub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response("no", { status: 400 }); }, websocket: {
    message(ws, data) {
      const message = JSON.parse(String(data)); requests.push(message);
      if (message.t === "hello") { ws.send(JSON.stringify({ rid: message.rid, t: "welcome", cwd: project.root, projectId: project.id, instanceId: "i1" })); return; }
      if (replyDelayMs !== undefined) setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ rid: message.rid, ok: true, text: "peer start confirmed" })); }, replyDelayMs);
    },
  } });
  mkdirSync(project.stateDir, { recursive: true });
  writeFileSync(join(project.stateDir, "status.json"), JSON.stringify({ pid: process.pid, controlPort: hub.port, protocol: PROTOCOL, cwd: project.root, projectId: project.id, instanceId: "i1" }));
  writeFileSync(join(project.stateDir, "control-token"), "scripted-token");
  await startManager({ ...fixture, forwardTimeoutMs: (action, nominalMs) => { limits.push([action, nominalMs]); return nominalMs / 100; } });
  const url = await openManager(fixture), origin = new URL(url).origin;
  const session = await fetch(`${origin}/session`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ticket: new URL(url).hash.slice(1) }) });
  const cookie = session.headers.get("set-cookie")!;
  const action = async (kind: string) => (await fetch(`${origin}/action`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ action: kind, projectId: project.id, instanceId: "i1", peer: "pi" }) })).json() as Promise<any>;
  return { ...fixture, hub, action, requests, limits };
}

test("unified peer start outwaits 10 seconds using the provider cap, with ordinary authority", async () => {
  // 100x clock: 150 ms models 15 s, beyond ordinary 10 s but inside the provider 30 s + 5 s margin.
  const f = await scriptedAction(150);
  try {
    expect(await f.action("start_peer")).toMatchObject({ ok: true, text: "peer start confirmed" });
    expect(f.limits).toEqual([["start_peer", MAX_COMMAND_MS + 5_000]]);
    expect(f.requests.filter(r => r.t !== "hello")).toEqual([expect.objectContaining({ t: "ui_action", action: expect.objectContaining({ action: "start_peer" }) })]);
    expect(f.requests.some(r => r.t === "ui" || r.settings === true)).toBe(false);
  } finally { await stopManager({ home: f.home }); f.hub.stop(true); }
});

test("a never-answering unified start is unconfirmed and points to Peers rather than failed", async () => {
  const f = await scriptedAction();
  try {
    const result = await f.action("start_peer");
    expect(result).toMatchObject({ ok: false, unconfirmed: true });
    expect(result.text).toContain("unconfirmed"); expect(result.text).toContain("Peers panel"); expect(result.text).not.toMatch(/failed/i);
    expect(f.limits).toEqual([["start_peer", MAX_COMMAND_MS + 5_000]]);
  } finally { await stopManager({ home: f.home }); f.hub.stop(true); }
});

test("another unified action keeps 10 seconds and its timeout remains a failure", async () => {
  const f = await scriptedAction();
  try {
    const result = await f.action("pause");
    expect(result.ok).toBe(false); expect(result.unconfirmed).toBeUndefined(); expect(result.error).toContain("no answer from the hub");
    expect(f.limits).toEqual([["pause", 10_000]]);
  } finally { await stopManager({ home: f.home }); f.hub.stop(true); }
});
