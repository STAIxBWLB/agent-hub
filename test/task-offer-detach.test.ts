import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function until(check: () => boolean) { for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(5); expect(check()).toBe(true); }
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-offer-detach-")), stateDir = join(root, "state");
  const options = { cwd: root, stateDir, projectId: "offer-detach", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { enabled: false, keep: 1 } } };
  let daemon = await startDaemon({ ...options, instanceId: "before-detach" });
  let console_ = await ControlClient.connect(stateDir, { role: "console" }), peer: ControlClient | undefined;
  cleanup.push(async () => { peer?.close(); console_.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true }); });
  const attach = async () => {
    peer = await ControlClient.connect(stateDir, { role: "peer", peer: "claude", channel: false });
    await until(() => daemon.bus.peers.get("claude")?.state === "idle"); return peer;
  };
  const status = async () => (await console_.request({ t: "status" })).status;
  const propose = async () => {
    expect((await console_.request({ t: "task", op: "hub_task_propose", args: { title: "unread offer fixture", class: "implement", owner: "claude" } })).ok).toBe(true);
    const view = await status(); expect(view.pendingTaskOffers).toHaveLength(1); return view.pendingTaskOffers[0];
  };
  const detach = async () => { peer?.close(); peer = undefined; await until(() => daemon.bus.peers.get("claude")?.state === "offline"); };
  return { get daemon() { return daemon; }, get console_() { return console_; }, attach, status, propose, detach,
    async restart() { await detach(); console_.close(); await daemon.stop(); daemon = await startDaemon({ ...options, instanceId: "after-detach" }); console_ = await ControlClient.connect(stateDir, { role: "console" }); } };
}

for (const finish of ["read", "accept", "decline", "unassign"] as const) test(`unread pull-only offer attention survives detach until ${finish} (#438)`, async () => {
  const f = await fixture(); await f.attach(); const offer = await f.propose();
  const queued = f.daemon.bus.queueIds("claude"); await f.detach();
  const detached = await f.status();
  expect(detached.pendingTaskOffers).toContainEqual(expect.objectContaining({ task: offer.task, peer: "claude", envelopeId: offer.envelopeId }));
  expect(f.daemon.bus.queueIds("claude")).toEqual(queued);
  expect(JSON.stringify(detached.pendingTaskOffers)).not.toContain("unread offer fixture");
  const peer = await f.attach();
  expect((await peer.request({ t: "task", op: "hub_task_list", args: {} })).ok).toBe(true);
  expect((await f.status()).pendingTaskOffers).toContainEqual(expect.objectContaining({ envelopeId: offer.envelopeId }));
  const result = finish === "read" ? await peer.request({ t: "inbox" })
    : finish === "unassign" ? await f.console_.request({ t: "task", op: "task_unassign", args: { id: offer.task, role: "owner" } })
    : await peer.request({ t: "task", op: finish === "accept" ? "hub_task_accept" : "hub_task_decline", args: { id: offer.task, ...(finish === "decline" ? { reason: "fixture handoff" } : {}) } });
  expect(result.ok).toBe(true);
  expect((await f.status()).pendingTaskOffers.some((row: any) => row.task === offer.task)).toBe(false);
});

test("unread pull-only offer attention survives daemon restart without an attached session (#438)", async () => {
  const f = await fixture(); await f.attach(); const offer = await f.propose();
  await f.restart();
  expect(f.daemon.bus.peers.has("claude")).toBe(false);
  expect((await f.status()).pendingTaskOffers).toContainEqual(expect.objectContaining({ task: offer.task, peer: "claude", envelopeId: offer.envelopeId }));
  const peer = await f.attach(); expect((await peer.request({ t: "inbox" })).ok).toBe(true);
  expect((await f.status()).pendingTaskOffers.some((row: any) => row.task === offer.task)).toBe(false);
});

test("repeated daemon status reads do not decode the proposed task list after warmup (#438)", async () => {
  const f = await fixture(); await f.attach(); await f.propose(); await f.status();
  const list = Board.prototype.list; let proposedDecodes = 0;
  Board.prototype.list = function(this: Board, ...args: Parameters<Board["list"]>) { if (args[0] === "proposed") proposedDecodes++; return list.apply(this, args); };
  try {
    for (let i = 0; i < 3; i++) expect((await f.status()).pendingTaskOffers).toHaveLength(1);
    expect(proposedDecodes).toBe(0);
  } finally { Board.prototype.list = list; }
});
