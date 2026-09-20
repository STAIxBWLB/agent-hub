import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient, PROTOCOL, readControl } from "../src/hub/control-client.ts";

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

test("matching source protocol can be selected explicitly for upgrade preflight", async () => {
  expect(PROTOCOL).toBe(10);
  const stateDir = mkdtempSync(join(tmpdir(), "agent-hub-control-legacy-"));
  const srv = Bun.serve<{ }>( {
    hostname: "127.0.0.1",
    port: 0,
    fetch(_req, s) { return s.upgrade(_req, { data: {} }) ? undefined : new Response("no"); },
        websocket: { message(ws, data) { const msg = JSON.parse(String(data)); ws.send(JSON.stringify({ rid: msg.rid, t: msg.t === "hello" ? "welcome" : "status", ok: true, protocol: 9, projectId: "p1", instanceId: "i1", cwd: ROOT })); } },
  });
  writeFileSync(join(stateDir, "control-token"), "legacy-token\n");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: srv.port, protocol: 9, projectId: "p1", instanceId: "i1", cwd: ROOT }));
  cleanup.push(() => srv.stop(true));
  await expect(ControlClient.connect(stateDir, { role: "console", projectRoot: ROOT }, 200)).rejects.toThrow(/wire version mismatch/);
  const client = await ControlClient.connect(stateDir, { role: "console", projectRoot: ROOT }, 200, 9);
  expect((await client.request({ t: "status" })).ok).toBe(true);
  client.close();
});

test("source matching cannot downgrade to unsupported legacy protocols", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agent-hub-control-unsupported-"));
  await expect(ControlClient.connect(stateDir, { role: "console" }, 200, 5)).rejects.toThrow(/unsupported recovery source protocol/);
});
