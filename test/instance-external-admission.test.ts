import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { definitionOf } from "../src/adapters/registry.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const instances = { "codex-review": { kind: "codex", roles: ["reviewer"] } };
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-external-instance-")), stateDir = join(root, "state");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, instances, batch_ms: 0, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  cleanup.push(() => daemon.stop());
  const connect = async (hello: Parameters<typeof ControlClient.connect>[1]) => {
    const client = await ControlClient.connect(stateDir, { ...hello, projectRoot: root }); cleanup.push(() => client.close()); return client;
  };
  const console_ = await connect({ role: "console" });
  return { root, stateDir, daemon, connect, console_ };
}
async function until(check: () => boolean) { for (let n = 0; n < 300 && !check(); n++) await Bun.sleep(10); expect(check()).toBe(true); }

test("unrelated native instances preserve external WebSocket and tool-peer admission and delivery", async () => {
  const f = await fixture(), external = await f.connect({ role: "peer", peer: "external-helper", channel: true });
  const frames: any[] = []; external.onPush = message => frames.push(message);
  await until(() => f.daemon.bus.stateOf("external-helper") === "idle");
  expect(await f.console_.request({ t: "send", to: ["external-helper"], body: "external-only delivery" })).toMatchObject({ ok: true });
  await until(() => frames.some(frame => frame.t === "deliver" && frame.envs?.some((env: { body: string }) => env.body.includes("external-only delivery"))));
  const tools = await f.connect({ role: "tools", peer: "external-tools" });
  expect(await tools.request({ t: "task", op: "hub_task_list", args: {} })).toMatchObject({ ok: true });
});

test("external ids never inherit a native kind and cannot claim a declared native instance", async () => {
  const f = await fixture(), external = await f.connect({ role: "peer", peer: "codex-unlisted", channel: true });
  await until(() => f.daemon.bus.stateOf("codex-unlisted") === "idle");
  expect(definitionOf("codex-unlisted", instances)).toBeUndefined();
  const owner = f.daemon.bus.peers.get("codex-unlisted");
  expect((await f.console_.request({ t: "start", peer: "codex-unlisted" })).ok).toBe(false);
  expect((await f.console_.request({ t: "watch", peer: "codex-unlisted" })).ok).toBe(false);
  expect(f.daemon.bus.peers.get("codex-unlisted")).toBe(owner);
  expect(external.features).toContain("peer_instances");
  await expect(ControlClient.connect(f.stateDir, { role: "peer", peer: "codex-review", channel: true, projectRoot: f.root })).rejects.toMatchObject({ code: 4403 });
});


test("native declarations do not remove an attached external helper from explicit task assignment", async () => {
  const f = await fixture();
  await f.connect({ role: "peer", peer: "external-helper", channel: true });
  await until(() => f.daemon.bus.stateOf("external-helper") === "idle");
  expect(await f.console_.request({ t: "task", op: "hub_task_propose", args: { title: "External helper summary", class: "summarize", owner: "external-helper" } })).toMatchObject({ ok: true });
  const snapshot = await f.console_.request({ t: "ui_snapshot" });
  expect(snapshot.tasks).toContainEqual(expect.objectContaining({ title: "External helper summary", owner: "external-helper" }));
});


test("native declarations never retain console or reserved recipients as off-roster deliveries", async () => {
  const f = await fixture(), offRoster: string[] = [];
  f.daemon.bus.tap(event => { if (event.t === "off_roster") offRoster.push(...event.peers); });
  for (const peer of ["user", "hub", "digest"]) {
    const envelope = newEnvelope("external-helper", "console return", { to: [peer] });
    expect(f.daemon.bus.isRostered(peer)).toBe(true);
    expect(f.daemon.bus.offRosterRecipients(envelope)).toEqual([]);
    expect(f.daemon.bus.publish(envelope)).toEqual([]);
    expect(f.daemon.bus.queued(peer)).toBe(0);
  }
  expect(offRoster).toEqual([]);
});
