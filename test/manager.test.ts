import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManager, startManager, stopManager, type Lifecycle, type ProjectRecord } from "../src/hub/manager.ts";

import { ControlClient, PROTOCOL } from "../src/hub/control-client.ts";
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

test("unified delegated tickets retain content restrictions through authenticated open and local reuse", async () => {
  const { home, registry, lifecycle } = setup();
  await startManager({ home, registry, lifecycle });
  const status = JSON.parse(readFileSync(join(home, "manager/status.json"), "utf8"));
  const token = readFileSync(join(home, "manager/control-token"), "utf8").trim();
  const opened = await fetch(`http://127.0.0.1:${status.port}/open`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ liveTest: true }) });
  const result = await opened.json() as { liveTest: boolean; url: string };
  expect(result.liveTest).toBe(true);
  for (const url of [result.url, await openManager({ home, registry, lifecycle, liveTest: true })]) {
    const target = new URL(url), origin = target.origin;
    const headers = { origin, "content-type": "application/json" };
    const session = await fetch(`${origin}/session`, { method: "POST", headers, body: JSON.stringify({ ticket: target.hash.slice(1) }) });
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    const denied = await fetch(`${origin}/action`, { method: "POST", headers: { ...headers, cookie }, body: JSON.stringify({ action: "send", projectId: "p1", instanceId: "i1", body: "must not be user", liveTest: false }) });
    expect(denied.status).toBe(403);
  }
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


async function scriptedAction(refusal?: Record<string, unknown>, manualDeadlines = false) {
  const fixture = setup();
  const project = fixture.registry.get("p1") as ProjectRecord;
  const requests: any[] = [], limits: [string, number][] = [];
  const replies = new Map<string, (result: Record<string, unknown>) => void>();
  const observed = new Map<string, () => void>();
  const deadlines = new Map<string, () => void>(), actualLimits: [string, number][] = [];
  const hub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response("no", { status: 400 }); }, websocket: {
    message(ws, data) {
      const message = JSON.parse(String(data)); requests.push(message);
      if (message.t === "hello") { ws.send(JSON.stringify({ rid: message.rid, t: "welcome", cwd: project.root, projectId: project.id, instanceId: "i1" })); return; }
      const kind = message.action.action;
      replies.set(kind, result => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ rid: message.rid, ...result })); });
      observed.get(kind)?.();
      if (refusal && kind === "start_peer") replies.get(kind)!(refusal);
    },
  } });
  mkdirSync(project.stateDir, { recursive: true });
  writeFileSync(join(project.stateDir, "status.json"), JSON.stringify({ pid: process.pid, controlPort: hub.port, protocol: PROTOCOL, cwd: project.root, projectId: project.id, instanceId: "i1" }));
  writeFileSync(join(project.stateDir, "control-token"), "scripted-token");
  await startManager({ ...fixture, forwardTimeoutMs: (action, nominalMs) => { limits.push([action, nominalMs]); return nominalMs / 100; } });
  const url = await openManager(fixture), origin = new URL(url).origin;
  const session = await fetch(`${origin}/session`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ticket: new URL(url).hash.slice(1) }) });
  const cookie = session.headers.get("set-cookie")!;
  const request = ControlClient.prototype.request;
  // Drive only action deadlines after wire arrival. Handshake/HTTP I/O keeps its real watchdog.
  const requestSpy = manualDeadlines ? spyOn(ControlClient.prototype, "request").mockImplementation(function(this: ControlClient, message, ms = 30000) {
    if (message.t !== "ui_action") return request.call(this, message, ms);
    actualLimits.push([String((message.action as {action: string}).action), ms]);
    const schedule = globalThis.setTimeout;
    const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
      if (delay !== ms) return schedule(callback, delay, ...args);
      deadlines.set(String((message.action as {action: string}).action), () => callback(...args));
      return schedule(() => {}, 0);
    }) as typeof setTimeout);
    try { return request.call(this, message, ms); } finally { timerSpy.mockRestore(); }
  }) : undefined;
  const action = async (kind: string, extra: Record<string, unknown> = {}) => (await fetch(`${origin}/action`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ action: kind, projectId: project.id, instanceId: "i1", peer: "pi", ...extra }) })).json() as Promise<any>;
  const arrived = (kind: string) => replies.has(kind) ? Promise.resolve() : new Promise<void>(resolve => observed.set(kind, resolve));
  const reply = (kind: string, result: Record<string, unknown>) => replies.get(kind)!(result);
  return { ...fixture, hub, action, requests, limits, actualLimits, arrived, reply,
    expire: (kind: string) => { const deadline = deadlines.get(kind); expect(deadline, `${kind} deadline armed`).toBeDefined(); deadlines.delete(kind); deadline!(); },
    restore: () => requestSpy?.mockRestore() };
}

test("manager forwards scoped delivery evidence reads beyond ordinary deadlines and rejects stale targets (#257)", async () => {
  const f = await scriptedAction();
  try {
    for (const kind of ["sdlc_queue", "sdlc_release"]) {
      const reading = f.action(kind, { repo: "owner/repo", liveIssues: [273] });
      const arrived = await Promise.race([f.arrived(kind).then(() => "arrived"), reading.then(() => "returned")]);
      expect(arrived).toBe("arrived");
      const ordinary = f.action("pause");
      await f.arrived("pause");
      expect((await ordinary).ok).toBe(false);
      f.reply(kind, { ok: true, report: { repo: "owner/repo", native: "unverified" } });
      expect(await reading).toEqual({ ok: true, report: { repo: "owner/repo", native: "unverified" } });
    }
    expect(f.limits).toEqual([["sdlc_queue", 30_000], ["pause", 10_000], ["sdlc_release", 30_000], ["pause", 10_000]]);
    const forwarded = f.requests.filter(request => request.t === "ui_action" && String(request.action.action).startsWith("sdlc_"));
    expect(forwarded).toHaveLength(2);
    for (const request of forwarded) expect(request).toMatchObject({ instanceId: "i1", action: { projectId: "p1", instanceId: "i1", repo: "owner/repo", liveIssues: [273] } });
    const before = f.requests.filter(request => request.t === "ui_action").length;
    expect((await f.action("sdlc_queue", { instanceId: "stale" })).ok).toBe(false);
    expect((await f.action("sdlc_release", { projectId: "other" })).ok).toBe(false);
    expect((await f.action("sdlc_ship")).ok).toBe(false);
    expect(f.requests.filter(request => request.t === "ui_action")).toHaveLength(before);
  } finally { await stopManager({ home: f.home }); f.hub.stop(true); }
});

test("unified peer start outwaits 10 seconds using the provider cap, with ordinary authority", async () => {
  // Hold the start reply until the ordinary action's old deadline is observed; no sleep between deadline fractions.
  const f = await scriptedAction();
  try {
    const starting = f.action("start_peer");
    await f.arrived("start_peer");
    const oldDeadline = await f.action("pause");
    expect(oldDeadline.ok).toBe(false); expect(oldDeadline.error).toContain("no answer from the hub");
    f.reply("start_peer", { ok: true, text: "peer start confirmed" });
    expect(await starting).toMatchObject({ ok: true, text: "peer start confirmed" });
    expect(f.limits).toEqual([["start_peer", MAX_COMMAND_MS + 5_000], ["pause", 10_000]]);
    expect(f.requests.filter(r => r.t !== "hello")).toEqual([
      expect.objectContaining({ t: "ui_action", action: expect.objectContaining({ action: "start_peer" }) }),
      expect.objectContaining({ t: "ui_action", action: expect.objectContaining({ action: "pause" }) }),
    ]);
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


test("a hub refusal of start_peer remains a known failure with its command", async () => {
  const refusal = { ok: false, error: "a terminal for pi was opened 4s ago; wait for it to attach, or run ahub pi", command: "ahub pi" };
  const f = await scriptedAction(refusal);
  try {
    const result = await f.action("start_peer");
    expect(result).toMatchObject(refusal); expect(result.unconfirmed).toBeUndefined();
    expect(f.limits).toEqual([["start_peer", MAX_COMMAND_MS + 5_000]]);
  } finally { await stopManager({ home: f.home }); f.hub.stop(true); }
});

test("unified split accepts a confirmed response beyond the generic action deadline",async()=>{
 const f=await scriptedAction(undefined,true);try{
  const split=f.action("backlog_split");
  // Assertion failures tear down in-flight HTTP requests; handle their rejection at creation.
  void split.catch(()=>{});
  await f.arrived("backlog_split");
  expect(f.limits).toEqual([["backlog_split",16000]]);
  expect(f.actualLimits).toEqual([["backlog_split",160]]);
  expect(f.requests.some(r=>r.action?.action==="backlog_split")).toBe(true);
  const ordinary=f.action("pause");void ordinary.catch(()=>{});await f.arrived("pause");
  // Both requests are in flight before the ordinary deadline advances; split's later deadline stays pending.
  expect(f.limits).toEqual([["backlog_split",16000],["pause",10000]]);
  expect(f.actualLimits).toEqual([["backlog_split",160],["pause",100]]);
  f.expire("pause");expect((await ordinary).ok).toBe(false);
  f.reply("backlog_split",{ok:true,text:"children committed"});expect(await split).toMatchObject({ok:true,text:"children committed"});
 }finally{f.restore();await stopManager({home:f.home});f.hub.stop(true)}
});
test("unified split missed reply is unconfirmed and requires task readback before retry",async()=>{
 const f=await scriptedAction();try{const result=await f.action("backlog_split");expect(result.unconfirmed).toBe(true);expect(result).toMatchObject({ok:false,unconfirmed:true});expect(result.text).toContain("Reload the task");}finally{await stopManager({home:f.home});f.hub.stop(true)}
});
