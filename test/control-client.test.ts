import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient, INVOCATION_CONTROL_TIMEOUT_MS, controlRequestTimeout, PROTOCOL, readControl, RECOVERY_SOURCE_PROTOCOLS } from "../src/hub/control-client.ts";

const ROOT = "/tmp/agent-hub-control-test";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

async function server(mode: "silent" | "malformed" | "wrong-welcome") {
  const stateDir = mkdtempSync(join(tmpdir(), "agent-hub-control-"));
  const token = "control-test-token";
  const srv = Bun.serve<{ }>( {
    hostname: "127.0.0.1",
    port: 0,
    fetch(_req, s) { return s.upgrade(_req, { data: {} }) ? undefined : new Response("no"); },
    websocket: {
      open(ws) {
        if (mode === "malformed") ws.send("not-json");
      },
      message(ws, data) {
        if (mode === "wrong-welcome") {
          const msg = JSON.parse(String(data));
          ws.send(JSON.stringify({ rid: msg.rid, t: "welcome", projectId: "other", instanceId: "other", cwd: "/other" }));
        }
      },
    },
  });
  writeFileSync(join(stateDir, "control-token"), `${token}\n`);
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: srv.port, protocol: PROTOCOL, projectId: "p1", instanceId: "i1", cwd: ROOT }));
  cleanup.push(() => srv.stop(true));
  return { stateDir, token };
}

test("readControl rejects malformed or unsafe manifests", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-hub-control-invalid-"));
  writeFileSync(join(dir, "control-token"), "\n");
  writeFileSync(join(dir, "status.json"), JSON.stringify({ controlPort: 0 }));
  expect(readControl(dir)).toBeUndefined();
  writeFileSync(join(dir, "control-token"), "token\n");
  writeFileSync(join(dir, "status.json"), JSON.stringify({ controlPort: 70000 }));
  expect(readControl(dir)).toBeUndefined();
});

test("connect has a bounded timeout when the hub never answers hello", async () => {
  const { stateDir } = await server("silent");
  const started = Date.now();
  await expect(ControlClient.connect(stateDir, { role: "console", projectRoot: ROOT }, 50)).rejects.toThrow(/timed out|closed/);
  expect(Date.now() - started).toBeLessThan(1000);
});

test("connect rejects malformed JSON and a welcome for another project", async () => {
  const malformed = await server("malformed");
  await expect(ControlClient.connect(malformed.stateDir, { role: "console", projectRoot: ROOT }, 200)).rejects.toThrow("invalid hub response");
  const wrong = await server("wrong-welcome");
  await expect(ControlClient.connect(wrong.stateDir, { role: "console", projectRoot: ROOT }, 200)).rejects.toThrow(/different project or instance/);
});

test("manifest identity mismatch refuses before opening a socket", async () => {
  const { stateDir } = await server("silent");
  await expect(ControlClient.connect(stateDir, { role: "console", projectId: "wrong", projectRoot: ROOT }, 200)).rejects.toThrow(/does not match/);
});

test.each([9, 10, 11, 12, 13, 14, 15])("a matching source protocol (%i) can be selected explicitly for upgrade preflight", async (source) => {
  expect(PROTOCOL).toBe(16);
  expect(RECOVERY_SOURCE_PROTOCOLS).toContain(source); // Target 16 retains authenticated recovery from every supported source, including released 0.12.19 (15).
  const stateDir = mkdtempSync(join(tmpdir(), "agent-hub-control-legacy-"));
  const srv = Bun.serve<{ }>( {
    hostname: "127.0.0.1",
    port: 0,
    fetch(_req, s) { return s.upgrade(_req, { data: {} }) ? undefined : new Response("no"); },
        websocket: { message(ws, data) { const msg = JSON.parse(String(data)); ws.send(JSON.stringify({ rid: msg.rid, t: msg.t === "hello" ? "welcome" : "status", ok: true, protocol: source, projectId: "p1", instanceId: "i1", cwd: ROOT })); } },
  });
  writeFileSync(join(stateDir, "control-token"), "legacy-token\n");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: srv.port, protocol: source, projectId: "p1", instanceId: "i1", cwd: ROOT }));
  cleanup.push(() => srv.stop(true));
  await expect(ControlClient.connect(stateDir, { role: "console", projectRoot: ROOT }, 200)).rejects.toThrow(/wire version mismatch/);
  const client = await ControlClient.connect(stateDir, { role: "console", projectRoot: ROOT }, 200, source);
  expect((await client.request({ t: "status" })).ok).toBe(true);
  client.close();
});

test("source matching cannot downgrade to unsupported legacy protocols", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agent-hub-control-unsupported-"));
  await expect(ControlClient.connect(stateDir, { role: "console" }, 200, 5)).rejects.toThrow(/unsupported recovery source protocol/);
});


test("C3 every control-client invocation path covers the supported person approval window plus margin", () => {
  const invocation = { t: "task", op: "hub_invoke", args: {} };
  expect(INVOCATION_CONTROL_TIMEOUT_MS).toBeGreaterThan(3_600_000);
  for (const requested of [undefined, 30_000, 50, -1, Infinity]) expect(controlRequestTimeout(invocation, requested)).toBe(INVOCATION_CONTROL_TIMEOUT_MS);
  expect(controlRequestTimeout(invocation, INVOCATION_CONTROL_TIMEOUT_MS + 1000)).toBe(INVOCATION_CONTROL_TIMEOUT_MS + 1000);
  expect(controlRequestTimeout(invocation, 0)).toBe(0);
  expect(controlRequestTimeout({ t: "task", op: "hub_task_list" })).toBe(30_000);
  expect(controlRequestTimeout({ t: "send", op: "hub_invoke" }, 100)).toBe(100);
});

test("C3 invocation deadline uses the approval-sized timer and sends request-scoped cancellation when it expires", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-invocation-control-"));
  const seen: Record<string, any>[] = [];
  const srv = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(_req, server) { return server.upgrade(_req) ? undefined : new Response("no"); },
    websocket: { message(ws, data) {
      const msg = JSON.parse(String(data)); seen.push(msg);
      if (msg.t === "hello") ws.send(JSON.stringify({ t: "welcome", rid: msg.rid, ok: true, projectId: "p1", instanceId: "i1", cwd: ROOT }));
    } },
  });
  cleanup.push(() => srv.stop(true));
  writeFileSync(join(dir, "control-token"), "test-token\n");
  writeFileSync(join(dir, "status.json"), JSON.stringify({ controlPort: srv.port, protocol: PROTOCOL, projectId: "p1", instanceId: "i1", cwd: ROOT }));
  const client = await ControlClient.connect(dir, { role: "tools", peer: "codex" }); cleanup.push(() => client.close());
  const original = globalThis.setTimeout, timers: ReturnType<typeof setTimeout>[] = [];
  let expire!: () => void, registered = 0;
  globalThis.setTimeout = ((handler: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    const timer = original(handler, delay, ...args);
    if (delay === INVOCATION_CONTROL_TIMEOUT_MS) { registered = delay; expire = () => handler(...args); timers.push(timer); }
    return timer;
  }) as typeof setTimeout;
  try {
    const pending = client.request({ t: "task", op: "hub_invoke", args: {} }, 30_000);
    expect(registered).toBeGreaterThan(3_600_000); expect(typeof expire).toBe("function");
    for (let i = 0; i < 800 && !seen.some(msg => msg.t === "task"); i++) await Bun.sleep(5);
    const request = seen.find(msg => msg.t === "task"); expect(request).toBeDefined();
    expire(); const result = await pending;
    expect(result.ok).toBe(false); expect(result.error).toContain("admission unconfirmed");
    for (let i = 0; i < 800 && !seen.some(msg => msg.t === "request_cancel"); i++) await Bun.sleep(5);
    expect(seen.find(msg => msg.t === "request_cancel")).toEqual({ t: "request_cancel", request: request!.rid });
    expect(client.isOpen).toBe(true);
  } finally { globalThis.setTimeout = original; for (const timer of timers) clearTimeout(timer); }
});
