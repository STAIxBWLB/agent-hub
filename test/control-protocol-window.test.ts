import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient, controlProtocolWindow, PROTOCOL, PROTOCOL_MIN, RECOVERY_SOURCE_PROTOCOLS, readControl } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { openManager, refreshManager, startManager } from "../src/hub/manager.ts";

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });

function fixture(versions: Record<string, unknown>, welcome: "selected" | "absent" | number | string | null = "selected", required?: number) {
  const root = mkdtempSync(join(tmpdir(), "ahub-wire-window-"));
  const hellos: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, owner) { if (request.headers.has("origin")) return new Response("forbidden", { status: 403 }); return owner.upgrade(request) ? undefined : new Response("not websocket"); },
    websocket: { message(ws, data) {
      const message = JSON.parse(String(data));
      if (message.t === "hello") {
        if (message.token !== "fixture-token") return ws.close(4401, "bad token");
        hellos.push(message);
        if (required !== undefined && message.v !== required) return ws.close(4426, "wire version mismatch");
        ws.send(JSON.stringify({ rid: message.rid, t: "welcome", projectId: "project", instanceId: "instance", cwd: root,
          ...(welcome === "absent" ? {} : { protocol: welcome === "selected" ? message.v : welcome }), features: ["fixture_feature"] }));
      } else ws.send(JSON.stringify({ rid: message.rid, ok: true, t: message.t }));
    } } });
  writeFileSync(join(root, "control-token"), "fixture-token\n");
  writeFileSync(join(root, "status.json"), JSON.stringify({ controlPort: server.port, cwd: root, projectId: "project", instanceId: "instance", ...versions }));
  clean.push(() => { server.stop(true); rmSync(root, { recursive: true, force: true }); });
  return { root, hellos, connect: (protocol?: number) => ControlClient.connect(root, { role: "console", projectRoot: root }, 1000, protocol) };
}

test("control descriptors retain the compatibility floor and modern supported window", () => {
  const f = fixture({ protocol: 16, protocolMin: 16, protocolMax: 17 });
  expect(readControl(f.root)).toMatchObject({ protocol: 16, protocolMin: 16, protocolMax: 17 });
  expect(controlProtocolWindow(readControl(f.root)!)).toEqual({ v: 17, vMin: 16 });
  expect(controlProtocolWindow({ protocol: 16 })).toEqual({ v: 16, vMin: 16 });
  expect(controlProtocolWindow({})).toBeUndefined();
  for (const malformed of [{ protocol: "16" }, { protocol: null }, { protocol: 16, protocolMax: 17, protocolMin: 18 }, { protocol: 16, protocolMax: Infinity }])
    expect(controlProtocolWindow(malformed)).toBeUndefined();
});

test("normal control connections choose the highest common version without discarding feature capability checks", async () => {
  const f = fixture({ protocol: 16, protocolMin: 16, protocolMax: 18 });
  const client = await f.connect(); clean.push(() => client.close());
  expect(client.protocol).toBe(PROTOCOL); expect(client.features).toEqual(["fixture_feature"]);
  expect(f.hellos).toMatchObject([{ v: 17, vMin: 16 }]);
  expect(await client.request({ t: "status" })).toMatchObject({ ok: true });
});

test("legacy singleton and wholly unversioned descriptors offer16 once, with no downgrade retry", async () => {
  for (const descriptor of [{ protocol: 16 }, {}]) {
    const f = fixture(descriptor, "selected", 16), client = await f.connect(); clean.push(() => client.close());
    expect(client.protocol).toBe(16); expect(f.hellos).toMatchObject([{ v: 16, vMin: 16 }]);
  }
});

test("recovery protocol overrides stay explicit singletons including current17", async () => {
  expect(RECOVERY_SOURCE_PROTOCOLS).toContain(16);
  for (const version of RECOVERY_SOURCE_PROTOCOLS) {
    const f = fixture({ protocol: version }, "selected", version), client = await f.connect(version); clean.push(() => client.close());
    expect(client.protocol).toBe(version); expect(f.hellos).toMatchObject([{ v: version, vMin: version }]);
  }
  const modern = fixture({ protocol: 16, protocolMin: 16, protocolMax: 17 }), client = await modern.connect(17); clean.push(() => client.close());
  expect(modern.hellos).toMatchObject([{ v: 17, vMin: 17 }]);
});

test("disjoint ranges and exact recovery mismatches refuse4426 before opening a socket", async () => {
  for (const descriptor of [{ protocol: 15 }, { protocol: 18, protocolMin: 18, protocolMax: 19 }, { protocol: 16, protocolMin: 18, protocolMax: 17 }]) {
    const f = fixture(descriptor);
    await expect(f.connect()).rejects.toMatchObject({ code: 4426 }); expect(f.hellos).toEqual([]);
  }
  const f = fixture({ protocol: 16, protocolMin: 16, protocolMax: 17 });
  await expect(f.connect(9)).rejects.toMatchObject({ code: 4426 }); expect(f.hellos).toEqual([]);
});

test("welcome version must match when supplied, while legacy omitted versions remain accepted", async () => {
  for (const welcome of [16, "17", null]) {
    const f = fixture({ protocol: 16, protocolMin: 16, protocolMax: 17 }, welcome);
    await expect(f.connect()).rejects.toMatchObject({ code: 4426 }); expect(f.hellos).toHaveLength(1);
  }
  const f = fixture({ protocol: 16, protocolMin: 16, protocolMax: 17 }, "absent"), client = await f.connect(); clean.push(() => client.close());
  expect(client.protocol).toBe(17);
});

test("manager descriptor and authenticated health publish the same bridge window and refresh retains the current manager", async () => {
  const home = mkdtempSync(join(tmpdir(), "ahub-manager-window-"));
  const registry = { list: () => [], get: () => undefined } as unknown as NonNullable<Parameters<typeof startManager>[0]>["registry"];
  const handle = await startManager({ home, registry });
  clean.push(async () => { try { await handle.stop(); } finally { rmSync(home, { recursive: true, force: true }); } });
  const statusFile = join(home, "manager/status.json"), before = JSON.parse(readFileSync(statusFile, "utf8"));
  expect(before).toMatchObject({ protocol: 16, protocolMin: 16, protocolMax: 17 });
  const token = readFileSync(join(home, "manager/control-token"), "utf8").trim();
  const response = await fetch(`http://127.0.0.1:${before.port}/open`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  expect(await response.json()).toMatchObject({ protocol: 16, protocolMin: 16, protocolMax: 17, instanceId: before.instanceId });
  // A failed assertion must never launch the real CLI during a refresh regression.
  await refreshManager({ home, registry, cli: "/dev/null" });
  expect(JSON.parse(readFileSync(statusFile, "utf8")).instanceId).toBe(before.instanceId);
}, 20_000);

test("manager bootstrap still admits its explicit legacy protocol9 contract outside the normal control window", async () => {
  const home = mkdtempSync(join(tmpdir(), "ahub-manager-legacy-window-")), dir = join(home, "manager"); mkdirSync(dir);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (request.headers.has("origin")) return new Response("forbidden", { status: 403 });
    if (request.headers.get("authorization") !== "Bearer legacy-token") return new Response("unauthorized", { status: 401 });
    return Response.json({ ok: true, instanceId: "legacy-manager", protocol: 9, url: "http://127.0.0.1/legacy-manager-fixture" });
  } });
  clean.push(() => { server.stop(true); rmSync(home, { recursive: true, force: true }); });
  writeFileSync(join(dir, "control-token"), "legacy-token");
  writeFileSync(join(dir, "status.json"), JSON.stringify({ port: server.port, protocol: 9, instanceId: "legacy-manager", pid: process.pid }));
  expect(await openManager({ home, cli: "/dev/null" })).toBe("http://127.0.0.1/legacy-manager-fixture");
});

test("a real daemon advertises the legacy floor but welcomes each selected control protocol", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-wire-daemon-")), stateDir = join(root, "state"); mkdirSync(stateDir);
  const keys = ["HOME", "AGENTHUB_HOME", "AMEM_HOME", "CLAUDE_CONFIG_DIR", "KIMI_CODE_HOME"] as const, saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) { const dir = join(root, key); mkdirSync(dir); process.env[key] = dir; }
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  clean.push(async () => { try { await daemon?.stop(); } finally { for (const key of keys) { const value = saved[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); } });
  daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
    config: { ...DEFAULT_CONFIG, roster: {}, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, research: { ...DEFAULT_CONFIG.research, enabled: false },
      task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  expect(PROTOCOL).toBe(17); expect(PROTOCOL_MIN).toBe(16);
  expect(readControl(stateDir)).toMatchObject({ protocol: 16, protocolMin: 16, protocolMax: 17 });
  for (const explicit of [undefined, 16, 17]) {
    const client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root }, 3000, explicit); clean.push(() => client.close());
    expect(client.protocol).toBe(explicit ?? 17);
    expect((await client.request({ t: "status" })).status).toMatchObject({ protocol: 16, protocolMin: 16, protocolMax: 17 });
  }
}, 20_000);
