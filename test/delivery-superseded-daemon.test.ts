import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { newEnvelope } from "../src/hub/envelope.ts";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-superseded-"));
  const file = join(dir, "hub.db"), board = new Board(file);
  const task = board.propose("user", { title: "private title", class: "implement" });
  board.update(task.id, "user", "assigned", { owner: "codex", reviewer: "claude", state: "in_progress" });
  board.update(task.id, "codex", "done", { state: "in_review" });
  const journal = new DeliveryJournal({ file, projectRoot: dir, projectId: "superseded", instanceId: "old" });
  const notice = (kind: "task" | "review" = "task") => newEnvelope("hub", "private title", { kind, refs: { task: String(task.id), ...(kind === "task" ? { taskRecipient: "reviewer" as const } : {}) }, to: ["claude"] });
  function held(id: string, originals: ReturnType<typeof notice>[], peer = "claude") {
    journal.createDelivery({ id, peer, state: "needs_review", createdAt: Date.now(), originals, out: originals });
  }
  return { dir, file, board, task, journal, notice, held };
}
async function start(f: Awaited<ReturnType<typeof fixture>>) {
  return startDaemon({ cwd: f.dir, stateDir: f.dir, projectId: "superseded", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false } } });
}

test("AC2/AC3: restored obsolete notices settle as hub, mixed/live rows stay held; approval clears a held review (#434)", async () => {
  const f = await fixture();
  f.held("presence", [newEnvelope("hub", "private memory", { kind: "presence" })]);
  const approved = f.board.propose("user", { title: "already approved", class: "implement" });
  f.board.update(approved.id, "user", "accepted", { state: "in_progress" });
  f.board.update(approved.id, "user", "done", { state: "approved" });
  f.held("approved-assignment", [newEnvelope("hub", "approved", { kind: "task", refs: { task: String(approved.id) } })]);
  f.held("reviewer-reminder", [f.notice()]); // sweepNotice uses kind task for an active reviewer too
  f.held("moved-owner", [newEnvelope("hub", "assignment", { kind: "task", refs: { task: String(f.task.id), taskRecipient: "owner" } })]);
  f.held("planner-coordination", [newEnvelope("hub", "coordinate", { kind: "task", refs: { task: String(f.task.id), taskRecipient: "planner" } })], "pi");
  f.held("legacy-unknown", [newEnvelope("hub", "unknown audience", { kind: "task", refs: { task: String(f.task.id) } })], "pi");
  f.held("live-review", [f.notice("review")]);
  f.held("mixed", [f.notice(), newEnvelope("pi", "peer chat")]);
  f.journal.close(); f.board.close();
  const daemon = await start(f), client = await ControlClient.connect(f.dir, { role: "console" });
  try {
    const notices = readFileSync(join(f.dir, "hub.log"), "utf8");
    expect(notices).toContain("live-review"); expect(notices).toContain("mixed");
    expect(notices).not.toContain("private title");
    expect(daemon.bus.queueShow("presence")?.state).toBe("completed");
    expect(daemon.bus.queueShow("approved-assignment")?.state).toBe("completed");
    expect(daemon.bus.queueShow("moved-owner")?.state).toBe("completed");
    expect(daemon.bus.queueShow("planner-coordination")?.state).toBe("needs_review");
    expect(daemon.bus.queueShow("legacy-unknown")?.state).toBe("needs_review");
    expect(daemon.bus.queueShow("live-review")?.state).toBe("needs_review");
    expect(daemon.bus.queueShow("reviewer-reminder")?.state).toBe("needs_review");
    expect(daemon.bus.queueShow("mixed")?.state).toBe("needs_review");
    expect((await client.request({ t: "status" })).status.peers.claude.heldRows.map((row: any) => row.id).sort()).toEqual(["live-review", "mixed", "reviewer-reminder"]);
    const route = await client.request({ t: "task", op: "route_explain", args: { id: f.task.id } });
    expect(JSON.stringify(route)).toContain("live-review"); expect(JSON.stringify(route)).toContain("mixed");
    const reviewed = await client.request({ t: "task", op: "hub_review", args: { id: f.task.id, verdict: "approved" } });
    expect(reviewed.ok).toBe(true);
    expect(daemon.bus.queueShow("live-review")?.state).toBe("completed");
    expect(daemon.bus.queueShow("reviewer-reminder")?.state).toBe("completed");
    expect(daemon.bus.queueShow("planner-coordination")?.state).toBe("completed");
    expect(daemon.bus.queueShow("legacy-unknown")?.state).toBe("completed");
    expect(daemon.bus.queueShow("mixed")?.state).toBe("needs_review");
    const inspection = new DeliveryJournal({ file: f.file, projectRoot: f.dir, projectId: "superseded", instanceId: (await client.request({ t: "status" })).status.instanceId });
    try { expect(inspection.resolution("live-review")).toMatchObject({ actor: "hub", reason: `superseded: task #${f.task.id} approved` }); }
    finally { inspection.close(); }
  } finally { await client.close(); await daemon.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("AC2: a superseded hold settles on receipt and drains queued work (#434)", async () => {
  const f = await fixture(); f.journal.close(); f.board.close();
  const daemon = await start(f);
  const { BasePeer } = await import("../src/hub/peers.ts");
  class UncertainPeer extends BasePeer {
    async deliver(_envs: unknown[], id?: string) { if (id) this.delivery({ id, state: "needs_review" }); }
    async start() { this.setState("idle"); }
    async stop() { this.setState("offline"); }
  }
  try {
    const peer = new UncertainPeer("claude"); daemon.bus.add(peer); await peer.start();
    const env = newEnvelope("hub", "private memory", { kind: "presence", to: ["claude"] });
    daemon.bus.publish(env);
    for (let i = 0; i < 50 && !daemon.bus.queueList("claude").some(row => row.originals.some(original => original.id === env.id) && row.state === "completed"); i++) await Bun.sleep(1);
    expect(daemon.bus.queueList("claude").find(row => row.originals.some(original => original.id === env.id))?.state).toBe("completed");
    expect(daemon.bus.queueSummary("claude").heldBy).toBeUndefined();
    expect(daemon.bus.queued("claude")).toBe(0);
  } finally { await daemon.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("AC3: releasing recovery classifies restored obsolete holds without an attached peer (#434)", async () => {
  const f = await fixture();
  const { Bus } = await import("../src/hub/bus.ts");
  const { supersededDeliveryReason } = await import("../src/hub/delivery-superseded.ts");
  f.held("offline-presence", [newEnvelope("hub", "private memory", { kind: "presence" })]);
  const bus = new Bus({ journal: f.journal, batchMs: 0 });
  bus.setRecoveryHold(true);
  bus.onQueues = () => {
    if (bus.isRecoveryHeld) return;
    for (const row of bus.queueList()) {
      if (row.state !== "needs_review") continue;
      const reason = supersededDeliveryReason(row.originals, f.board, row.peer);
      if (reason) bus.resolveDelivery(row.id, row.revision, "completed", reason, "hub");
    }
  };
  try {
    expect(bus.peers.size).toBe(0);
    expect(bus.queueShow("offline-presence")?.state).toBe("needs_review");
    bus.setRecoveryHold(false);
    expect(bus.queueShow("offline-presence")?.state).toBe("completed");
    expect(f.journal.resolution("offline-presence")?.actor).toBe("hub");
  } finally { bus.closeJournal(); f.board.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("a held kind task reviewer reminder settles when the reviewer changes (#434 review)", async () => {
  const f = await fixture(); f.held("reviewer-reminder", [f.notice()]);
  f.journal.close(); f.board.close();
  const daemon = await start(f), client = await ControlClient.connect(f.dir, { role: "console" });
  try {
    expect(daemon.bus.queueShow("reviewer-reminder")?.state).toBe("needs_review");
    const { BasePeer } = await import("../src/hub/peers.ts");
    class AvailableReviewer extends BasePeer {
      async deliver() {}
      async start() { this.setState("idle"); }
      async stop() { this.setState("offline"); }
    }
    const reviewer = new AvailableReviewer("pi"); daemon.bus.add(reviewer); await reviewer.start();
    const reassigned = await client.request({ t: "task", op: "task_assign", args: { id: f.task.id, peer: "pi", role: "reviewer" } });
    expect(reassigned).toMatchObject({ ok: true });
    expect(daemon.bus.queueShow("reviewer-reminder")?.state).toBe("completed");
  } finally { await client.close(); await daemon.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});
