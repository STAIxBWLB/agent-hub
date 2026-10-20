import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Task } from "../src/hub/board.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { realPath } from "../src/hub/project.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-accepted-offer-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "hub.db"), board = new Board(file);
  const journal = new DeliveryJournal({ file, projectRoot: dir, projectId: "accepted-offer", instanceId: "previous-session" });
  const make = (accepted: boolean) => {
    const task = board.propose("user", { title: "private fixture task title", class: "implement" });
    const assigned = board.update(task.id, "user", "assigned", { owner: "jcode", reviewer: "claude" });
    const env = newEnvelope("hub", "private fixture task offer", { to: ["jcode"], kind: "task", refs: { task: String(task.id), taskRecipient: "owner", taskOffer: assigned.history.length } });
    board.recordTaskOffer(task.id, { owner: "jcode", envelopeId: env.id, assignmentFlowRevision: assigned.history.length }, assigned.history.length);
    if (accepted) board.update(task.id, "jcode", "accepted", { state: "in_progress" });
    return { task, env };
  };
  const held = (id: string, originals: Envelope[], reason = "previous session ended") => journal.createDelivery({ id, peer: "jcode", state: "needs_review", createdAt: Date.now(), originals, out: originals, reason });
  const close = () => { journal.close(); board.close(); };
  return { dir, file, board, journal, make, held, close };
}
async function start(f: ReturnType<typeof fixture>) {
  const daemon = await startDaemon({ cwd: f.dir, stateDir: f.dir, projectId: "accepted-offer", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, roster: { ...DEFAULT_CONFIG.roster, jcode: true }, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } });
  cleanups.push(() => daemon.stop());
  return daemon;
}
async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) await Bun.sleep(5);
  expect(condition()).toBe(true);
}

function resolution(f: ReturnType<typeof fixture>, instanceId: string, id: string) {
  const journal = new DeliveryJournal({ file: f.file, projectRoot: f.dir, projectId: "accepted-offer", instanceId });
  try { return { audit: journal.resolution(id), read: journal.offerRead("jcode", id) }; }
  finally { journal.close(); }
}

test("#434 a restarted Jcode's accepted offer settles on restore, but mixed, unaccepted, live reminders and requested stops stay held", async () => {
  const f = fixture(), accepted = f.make(true), pending = f.make(false);
  f.held("accepted", [accepted.env]);
  f.held("mixed", [accepted.env, newEnvelope("claude", "private peer chat", { to: ["jcode"] })]);
  f.held("pending", [pending.env]);
  f.held("requested", [accepted.env], "requested stop: ahub stop jcode");
  f.held("reminder", [newEnvelope("hub", "still useful guidance", { kind: "task", to: ["jcode"], refs: { task: String(accepted.task.id), taskRecipient: "owner" } })]);
  f.close();
  const daemon = await start(f), client = await ControlClient.connect(f.dir, { role: "console" });
  cleanups.push(() => client.close());
  expect(daemon.bus.queueShow("accepted")?.state).toBe("completed");
  for (const id of ["mixed", "pending", "requested", "reminder"]) expect(daemon.bus.queueShow(id)?.state).toBe("needs_review");
  const status = (await client.request({ t: "status" })).status;
  const proof = resolution(f, status.instanceId, "accepted");
  expect(proof.audit).toMatchObject({ actor: "hub", reason: `superseded: task #${accepted.task.id} accepted` });
  expect(JSON.stringify(proof.audit)).not.toContain("private");
  const journal = new DeliveryJournal({ file: f.file, projectRoot: f.dir, projectId: "accepted-offer", instanceId: status.instanceId });
  try { expect(journal.offerRead("jcode", accepted.env.id)).toBe(false); }
  finally { journal.close(); }
});

test("#434 actual task acceptance clears its held offer through board.onChange without a recipient session", async () => {
  const f = fixture(), pending = f.make(false);
  f.held("waiting-for-accept", [pending.env]); f.close();
  const daemon = await start(f), client = await ControlClient.connect(f.dir, { role: "console" });
  cleanups.push(() => client.close());
  expect(daemon.bus.queueShow("waiting-for-accept")?.state).toBe("needs_review");
  const accepted = await client.request({ t: "task", op: "hub_task_accept", args: { id: pending.task.id } });
  expect(accepted.ok).toBe(true);
  expect(daemon.bus.queueShow("waiting-for-accept")?.state).toBe("completed");
  const shown = await client.request({ t: "task", op: "hub_task_show", args: { id: pending.task.id } });
  expect(shown.ok).toBe(true); expect(shown.text).toContain("in_progress");
});

test("#434 a held receipt for an already accepted offer settles and releases the replacement peer's queue", async () => {
  const f = fixture(), accepted = f.make(true); f.close();
  const daemon = await start(f);
  class UncertainPeer extends BasePeer {
    async start() { this.setState("idle"); }
    async stop() { this.setState("offline"); }
    async deliver(_envs: Envelope[], id?: string) { if (id) this.delivery({ id, state: "needs_review" }); }
  }
  const replacement = new UncertainPeer("jcode"); daemon.bus.add(replacement); await replacement.start();
  daemon.bus.publish(accepted.env);
  await until(() => daemon.bus.queueList("jcode").some(row => row.originals.some(env => env.id === accepted.env.id)));
  const row = daemon.bus.queueList("jcode").find(row => row.originals.some(env => env.id === accepted.env.id))!;
  await until(() => daemon.bus.queueShow(row.id)?.state === "completed");
  expect(daemon.bus.queueSummary("jcode").heldBy).toBeUndefined();
  expect(daemon.bus.queued("jcode")).toBe(0);
});

test("#434 recovery release settles an accepted offer while preserving a manual pause and task state", async () => {
  const f = fixture(), accepted = f.make(true); f.close();
  const daemon = await start(f), client = await ControlClient.connect(f.dir, { role: "console" });
  cleanups.push(() => client.close());
  daemon.bus.setRecoveryHold(true); daemon.bus.pause("jcode");
  const instanceId = (await client.request({ t: "status" })).status.instanceId;
  const journal = new DeliveryJournal({ file: f.file, projectRoot: f.dir, projectId: "accepted-offer", instanceId });
  try {
    journal.createDelivery({ id: "recovered-offer", peer: "jcode", state: "needs_review", createdAt: Date.now(), originals: [accepted.env], out: [accepted.env] });
    expect(daemon.bus.queueShow("recovered-offer")?.state).toBe("needs_review");
    daemon.bus.setRecoveryHold(false);
    expect(daemon.bus.queueShow("recovered-offer")?.state).toBe("completed");
    expect(journal.resolution("recovered-offer")?.actor).toBe("hub");
    expect(daemon.bus.isPaused("jcode")).toBe(true);
    const board = new Board(f.file);
    try { expect(board.get(accepted.task.id)).toMatchObject({ owner: "jcode", state: "in_progress" }); }
    finally { board.close(); }
  } finally { journal.close(); }
});
