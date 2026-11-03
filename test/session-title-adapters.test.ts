import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS, definitionOf } from "../src/adapters/registry.ts";
import { LocalPeer } from "../src/adapters/local-worker.ts";
import { OmniRoute } from "../src/omniroute/client.ts";
import { TASK_TOOLS, TASK_TOOL_NAMES, profileTaskTools, sessionTitleTools, SESSION_TITLE_TOOL } from "../src/hub/hub-tools.ts";
import { PROFILE_NAMES } from "../src/hub/profiles.ts";
import { Capture } from "../src/memory/capture.ts";
import type { MemoryClient } from "../src/memory/client.ts";
import { rosterPiFixture } from "./fakes/pi-roster-tui.ts";
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const barrier = () => { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; };

test("#1055 only hub-title definitions explicitly receive the title tool; global native tool lists never do", () => {
  expect(ADAPTERS.filter(definition => definition.title === "hub").map(definition => definition.kind).sort()).toEqual(["local", "pi"]);
  expect(TASK_TOOLS.some(tool => tool.name === "hub_set_title")).toBe(false);
  expect(TASK_TOOL_NAMES.has("hub_set_title")).toBe(true);
  expect(SESSION_TITLE_TOOL.inputSchema.properties.title).toMatchObject({ type: "string", description: expect.stringContaining("1-80 characters after doingText normalization") });
  expect(SESSION_TITLE_TOOL.inputSchema.properties.title).not.toHaveProperty("maxLength");
  expect(SESSION_TITLE_TOOL.inputSchema.properties.title).not.toHaveProperty("minLength");
  for (const profile of PROFILE_NAMES) for (const definition of ADAPTERS) {
    const global = profileTaskTools(profile);
    expect(global.some(tool => tool.name === "hub_set_title")).toBe(false);
    const selected = sessionTitleTools(global, definition.title === "hub");
    expect(selected.filter(tool => tool.name === "hub_set_title")).toHaveLength(definition.title === "hub" ? 1 : 0);
    expect(sessionTitleTools(selected).some(tool => tool.name === "hub_set_title")).toBe(false);
  }
  expect(definitionOf("pi")!.title).toBe("hub");
});

test("#1055 local title is conditional, person replaceable and belongs only to this in-memory session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-title-local-")); cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const make = () => new LocalPeer("local", { cwd, fixedModel: "fixture", omni: new OmniRoute({ urls: [], access_hosts: [] }), tools: { deny: [], permit: async () => false } });
  const peer = make(), observed: unknown[][] = []; peer.onDoing = (...args) => { observed.push(args); }; await peer.start(); cleanup.push(() => peer.stop());
  expect(peer.sessionTitle).toBe("");
  expect(await peer.setSessionTitle("agent title", true, () => false)).toEqual({ ok: false, reason: "invalid" });
  expect(peer.sessionTitle).toBe("");
  expect(await peer.setSessionTitle("agent title", true)).toEqual({ ok: true });
  expect(await peer.setSessionTitle("agent second title", true)).toEqual({ ok: false, reason: "already_named" });
  expect(await peer.setSessionTitle("person title", false)).toEqual({ ok: true });
  expect(await peer.setSessionTitle("late agent title", true)).toEqual({ ok: false, reason: "already_named" });
  expect(peer.sessionTitle).toBe("person title");
  expect(observed).toEqual([["title", "agent title"], ["title", "person title"]]);
  expect(make().sessionTitle).toBe("");
});

test("#1055 title tool arguments and results never reach capture, plain or MCP qualified", () => {
  const calls: unknown[] = [], client = { appendCapture: (row: unknown) => { calls.push(row); return Promise.resolve(); } } as unknown as MemoryClient;
  const capture = new Capture(client, { project: "fixture", cwd: import.meta.dir }); capture.init("fixture-session", "fixture"); calls.length = 0;
  for (const tool of ["hub_set_title", "mcp__agent-hub__hub_set_title"]) capture.observe({ tool, args: "TITLE_CANARY", output: "TITLE_CANARY", id: tool, paths: [] });
  expect(calls).toEqual([]);
  capture.observe({ tool: "read", args: "read file", output: "file", id: "positive", paths: [] });
  expect(calls).toHaveLength(1);
});

test("#1055 Pi title setter waits for native confirmation and refuses missing readback", async () => {
  const f = await rosterPiFixture(); cleanup.push(f.cleanup);
  expect(f.peer.sessionTitle).toBe("");
  const writing = f.peer.setSessionTitle("native title", true), command = await f.next();
  expect(command).toMatchObject({ type: "set_session_title", title: "native title", onlyIfUnnamed: true, sessionId: f.sessionId, generation: 0 });
  let settled = false; void writing.then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
  await f.ack(command, { ok: true, sessionId: f.sessionId, sessionName: "native title" });
  expect(await writing).toEqual({ ok: true }); expect(f.peer.sessionTitle).toBe("native title");
  const missing = f.peer.setSessionTitle("person replacement", false), second = await f.next(); await f.ack(second);
  expect(await missing).toEqual({ ok: false, reason: "invalid" }); expect(f.peer.sessionTitle).toBe("native title");
  const stale = f.peer.setSessionTitle("wrong session", false), third = await f.next(); await f.ack(third, { ok: true, sessionId: "different", sessionName: "wrong session" });
  expect(await stale).toEqual({ ok: false, reason: "invalid" }); expect(f.peer.sessionTitle).toBe("native title");
});

test("#1055 the real Pi extension checks the current native name at write and preserves a manual rename", async () => {
  const first = barrier(), renamed = barrier(), acks: Record<string, unknown>[] = [], nativeTitles: Record<string, unknown>[] = [];
  const commands = [
    { id: "first", type: "set_session_title", title: "agent title", onlyIfUnnamed: true, sessionId: "title-session", generation: 0 },
    { id: "late-agent", type: "set_session_title", title: "late agent title", onlyIfUnnamed: true, sessionId: "title-session", generation: 0 },
    { id: "person", type: "set_session_title", title: "person replacement", onlyIfUnnamed: false, sessionId: "title-session", generation: 0 },
    { id: "agent-after-person", type: "set_session_title", title: "agent overwrite", onlyIfUnnamed: true, sessionId: "title-session", generation: 0 },
    { id: "stale-session", type: "set_session_title", title: "stale title", onlyIfUnnamed: false, sessionId: "other-session", generation: 0 },
    { id: "stale-turn", type: "set_session_title", title: "stale turn title", onlyIfUnnamed: false, sessionId: "title-session", generation: 1 },
    { id: "shutdown", type: "shutdown" },
  ];
  let index = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const route = new URL(request.url).pathname;
    if (route === "/driver") { renamed.release(); return Response.json({ ok: true }); }
    if (route === "/commands") { if (index === 1) await renamed.promise; return Response.json({ command: commands[index++] ?? null }); }
    const body = await request.json() as Record<string, unknown>;
    if (route === "/ack") { acks.push(body); if (body.id === "first") first.release(); }
    if (route === "/event" && body.type === "session_title") nativeTitles.push(body);
    return Response.json({ ok: true });
  } });
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fakes/pi-title-driver.ts"), join(import.meta.dir, "../src/pi/extension.ts")], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, AGENTHUB_PI_BRIDGE_URL: `http://127.0.0.1:${server.port}`, AGENTHUB_PI_BRIDGE_TOKEN: "fixture", AGENTHUB_PI_TOOLS: "[]" } });
  try {
    await first.promise; child.stdin.write("manual\n"); await child.stdin.flush();
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]); expect(await child.exited).toBe(0); expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ title: "person replacement", writes: ["agent title", "person replacement"] });
    expect(nativeTitles.some(event => event.sessionName === "person native name")).toBe(true);
    expect(acks.find(ack => ack.id === "late-agent")).toMatchObject({ result: { ok: false, reason: "already_named", sessionName: "person native name" } });
    expect(acks.find(ack => ack.id === "agent-after-person")).toMatchObject({ result: { ok: false, reason: "already_named", sessionName: "person replacement" } });
    for (const id of ["stale-session", "stale-turn"]) expect(acks.find(ack => ack.id === id)).toMatchObject({ result: { ok: false, reason: "invalid" } });
  } finally { renamed.release(); if (child.exitCode === null) { child.kill(); await child.exited; } server.stop(true); }
}, 10_000);

test("#1055 a queued Pi title command is withdrawn when host admission changes", async () => {
  const f = await rosterPiFixture(); cleanup.push(f.cleanup);
  let allowed = true;
  const stale = f.peer.setSessionTitle("must not reach native", true, () => allowed);
  allowed = false;
  const admitted = f.peer.setSessionTitle("current title", true), command = await f.next();
  expect(command.title).toBe("current title");
  expect(await stale).toEqual({ ok: false, reason: "invalid" });
  await f.ack(command, { ok: true, sessionId: f.sessionId, sessionName: "current title" });
  expect(await admitted).toEqual({ ok: true });
});

test("#1055 an older Pi title ACK cannot replace a newer native manual-name observation", async () => {
  const f = await rosterPiFixture(); cleanup.push(f.cleanup);
  const writing = f.peer.setSessionTitle("agent title", true), command = await f.next();
  await f.post("/event", { type: "session_title", sessionId: f.sessionId, titleRevision: 2, sessionName: "newer manual name" });
  expect(f.peer.sessionTitle).toBe("newer manual name");
  await f.ack(command, { ok: true, sessionId: f.sessionId, titleRevision: 1, sessionName: "agent title" });
  expect(await writing).toEqual({ ok: true });
  expect(f.peer.sessionTitle).toBe("newer manual name");
  await f.post("/event", { type: "session_title", sessionId: "other-session", titleRevision: 3, sessionName: "foreign title" });
  expect(f.peer.sessionTitle).toBe("newer manual name");
});

test("#1055 a delayed unversioned native get_state cannot undo a newer manual title event", async () => {
  const { PiPeer } = await import("../src/adapters/pi.ts");
  const cwd = mkdtempSync(join(tmpdir(), "ahub-title-snapshot-")); cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const peer = new PiPeer("pi", { cwd, stateDir: cwd, mode: "headless", backend: "mlx", cmd: [process.execPath, join(import.meta.dir, "fakes/pi-title-snapshot.ts")], tools: [], executeTool: async () => "ok", relay: { url: "http://127.0.0.1:9/v1", token: "fixture", models: [] } });
  const observed: unknown[][] = []; peer.onDoing = (...args) => { observed.push(args); };
  cleanup.push(() => peer.stop()); await peer.start();
  expect(peer.sessionTitle).toBe("");
  await expect(peer.captureResume()).rejects.toThrow("title changed during capture");
  expect(peer.sessionTitle).toBe("newer native manual title");
  expect(observed.at(-1)).toEqual(["title", "newer native manual title"]);
});

for (const naming of ["person", "native", "unnamed"] as const) test(`#1055 cached empty-session recovery proof follows subsequent ${naming} title activity`, async () => {
  const f = await rosterPiFixture(); cleanup.push(f.cleanup);
  const reading = f.peer.captureResume(), snapshot = await f.next();
  expect(snapshot.type).toBe("get_session_state");
  await f.ack(snapshot, { sessionId: f.sessionId, sessionFile: f.sessionFile, idle: true, empty: true, sessionName: "", titleRevision: 0 });
  const empty = await reading;
  expect(empty).toMatchObject({ sessionId: f.sessionId });
  expect(empty).not.toHaveProperty("sessionFile");
  expect(f.peer.pendingResume).toEqual({ sessionId: f.sessionId });
  if (naming === "person") {
    const writing = f.peer.setSessionTitle("person title before the first prompt", false), command = await f.next();
    await f.ack(command, { ok: true, sessionId: f.sessionId, sessionName: "person title before the first prompt", titleRevision: 1 });
    expect(await writing).toEqual({ ok: true });
  } else if (naming === "native") {
    await f.post("/event", { type: "session_title", sessionId: f.sessionId, sessionName: "native manual title before the first prompt", titleRevision: 1 });
    expect(f.peer.sessionTitle).toBe("native manual title before the first prompt");
  }
  if (naming !== "unnamed") expect(f.peer.pendingResume.sessionId).not.toBe(f.sessionId);
  f.owner.kill(); await f.owner.exited; await f.post("/event", { type: "session_shutdown" });
  if (naming === "unnamed") {
    await expect(f.peer.captureResume()).resolves.toMatchObject({ sessionId: f.sessionId });
    expect(await f.peer.captureResume()).not.toHaveProperty("sessionFile");
  } else {
    await expect(f.peer.captureResume()).rejects.toThrow("no verified persisted resume state");
  }
});

test("#1055 a versioned empty TUI snapshot older than a new native title cannot certify empty recovery", async () => {
  const f = await rosterPiFixture(); cleanup.push(f.cleanup);
  const reading = f.peer.captureResume();
  const outcome = reading.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
  const command = await f.next();
  await f.post("/event", { type: "session_title", sessionId: f.sessionId, sessionName: "native title newer than the snapshot", titleRevision: 1 });
  await f.ack(command, { sessionId: f.sessionId, sessionFile: f.sessionFile, idle: true, empty: true, sessionName: "", titleRevision: 0 });
  const result = await outcome;
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("stale title snapshot unexpectedly certified empty recovery");
  expect(result.error).toBeInstanceOf(Error);
  expect((result.error as Error).message).toContain("title changed during capture");
  expect(f.peer.sessionTitle).toBe("native title newer than the snapshot");
  expect(f.peer.pendingResume.sessionId).not.toBe(f.sessionId);
  f.owner.kill(); await f.owner.exited; await f.post("/event", { type: "session_shutdown" });
  await expect(f.peer.captureResume()).rejects.toThrow("no verified persisted resume state");
});
