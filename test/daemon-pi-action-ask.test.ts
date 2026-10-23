import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import type { PiPeer } from "../src/adapters/pi.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function until(check: () => boolean) {
  for (let n = 0; n < 500 && !check(); n++) await Bun.sleep(10);
  expect(check()).toBe(true);
}
async function rig(unattended = false, crash = false) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-pi-actions-"));
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  const exitTrigger = join(cwd, "exit-native");
  const policy = { budgets: { publish: 2 } };
  mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub/config.local.json"), JSON.stringify({ action_policy: policy }));
  const daemon = await startDaemon({ cwd, stateDir: cwd, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    permissionTimeoutMs: 500, unattended, boundedTools: { specAvailable: async () => ({ available: true }), fetchSpec: async () => { throw new Error("unexpected spec read"); } },
    config: { ...DEFAULT_CONFIG, batch_ms: 0, action_policy: policy as never,
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: true, cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts"), ...(crash ? ["--exit-trigger", exitTrigger, "--exit-code", "7"] : [])] } } });
  cleanups.push(() => daemon.stop());
  const client = await ControlClient.connect(cwd, { role: "console" }); cleanups.push(() => client.close());
  const asks: any[] = []; client.onPush = row => { if (row.t === "permission") asks.push(row); }; client.send({ t: "tail" });
  expect((await client.request({ t: "start", peer: "pi", args: { mode: "headless" } })).ok).toBe(true);
  await until(() => daemon.bus.stateOf("pi") === "idle");
  const peer = daemon.bus.peers.get("pi") as PiPeer;
  // Launch capabilities stay private to this fixture, as in pi-daemon.test.ts.
  const bridge = (peer as any).tuiLaunch.env;
  const call = async (command: string, id: string) => (await fetch(`${bridge.AGENTHUB_PI_BRIDGE_URL}/tool`, {
    method: "POST", headers: { authorization: `Bearer ${bridge.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "bash", args: { command }, toolCallId: id, sessionId: peer.recoveryMetadata().sessionId, generation: (peer as any).budgetGeneration }),
  })).json() as Promise<{ text: string }>;
  const status = async () => (await client.request({ t: "status" })).status.actionPolicyInfo.pi;
  const mode = async (value: string) => expect((await client.request({ t: "permission", peer: "pi", mode: value, confirmed: true })).permissionMode).toBe(value);
  return { cwd, daemon, client, asks, call, status, mode, exitTrigger };
}

test("Pi classed calls ask before every native mode, including unattended, while plain calls retain the mode", async () => {
  for (const unattended of [false, true]) {
    const r = await rig(unattended);
    expect((await r.status()).enforceable).toBe(true);
    for (const mode of ["ask", "ask-when-needed", "never-ask"]) {
      await r.mode(mode);
      const n = r.asks.length, marker = `denied-${mode}`;
      let settled: { text: string } | undefined;
      const pending = r.call(`printf denied > ${marker}; git push`, marker).then(result => { settled = result; return result; });
      await until(() => r.asks.length > n || settled !== undefined);
      expect(r.asks.length, JSON.stringify(settled)).toBeGreaterThan(n);
      expect(r.asks[n].title).toContain("Action approval (publish)");
      expect(r.asks[n].options.every((o: any) => o.kind !== "allow_always")).toBe(true);
      r.client.send({ t: "permit", id: r.asks[n].id, option: "deny" });
      expect((await pending).text).toContain("did not approve");
      expect(existsSync(join(r.cwd, marker))).toBe(false);
      expect((await r.status()).remaining.publish).toBe(0);
    }
    await r.mode("never-ask");
    const before = r.asks.length;
    await r.call("printf ordinary", "plain");
    expect(r.asks).toHaveLength(before);
    await r.daemon.stop();
  }
}, 20_000);

test("Pi call receipts do not spend a class budget twice, exhaustion asks, and restart revokes it", async () => {
  const r = await rig(); await r.mode("never-ask");
  const command = "printf approved > approved-marker; git push";
  const first = r.call(command, "same-call");
  await until(() => r.asks.length === 1);
  const grant = r.asks[0].options.find((o: any) => o.optionId === "agent-hub:action-budget");
  expect(grant?.kind).toBe("allow_once");
  r.client.send({ t: "permit", id: r.asks[0].id, option: grant.optionId });
  const result = await first;
  expect((await r.status()).remaining.publish).toBe(1);
  expect(await r.call(command, "same-call")).toEqual(result);
  expect((await r.status()).remaining.publish).toBe(1); expect(r.asks).toHaveLength(1);
  await r.call("git push", "second");
  expect((await r.status()).remaining.publish).toBe(0); expect(r.asks).toHaveLength(1);
  const third = r.call("git push", "third"); await until(() => r.asks.length === 2);
  r.client.send({ t: "permit", id: r.asks[1].id, option: "deny" }); await third;
  expect((await r.client.request({ t: "peer_stop", peer: "pi" })).ok).toBe(true);
  expect((await r.status()).remaining.publish).toBe(0);
  expect((await r.status()).enforceable).toBe(false);
});

test("Pi timed-out or stopped approval cannot execute or seed a class allowance", async () => {
  const r = await rig(true); await r.mode("never-ask");
  const timed = r.call("printf timed > timeout-marker; git push", "timeout");
  await until(() => r.asks.length === 1);
  expect((await timed).text).toContain("approval expired");
  expect(existsSync(join(r.cwd, "timeout-marker"))).toBe(false);
  const pending = r.call("printf stale > stopped-marker; git push", "stopped");
  await until(() => r.asks.length === 2);
  const ask = r.asks[1];
  expect((await r.client.request({ t: "peer_stop", peer: "pi" })).ok).toBe(true);
  r.client.send({ t: "permit", id: ask.id, option: "agent-hub:action-budget" });
  await pending;
  expect(existsSync(join(r.cwd, "stopped-marker"))).toBe(false);
  expect((await r.status()).remaining.publish).toBe(0);
});


test("a crashed Pi has no enforceable live tool path even when it was not stopped by the person", async () => {
  const r = await rig(false, true);
  expect((await r.status()).enforceable).toBe(true);
  writeFileSync(r.exitTrigger, "exit");
  await until(() => r.daemon.bus.stateOf("pi") === "offline");
  const status = await r.status();
  expect(status.enforceable).toBe(false);
  expect(status.note).toContain("always-ask not enforceable");
  expect((await r.call("printf must-not-run > crash-marker; git push", "after-crash")).text).toContain("stopped");
  expect(existsSync(join(r.cwd, "crash-marker"))).toBe(false);
});
