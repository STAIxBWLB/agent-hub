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
  const notice = (kind: "task" | "review" = "task") => newEnvelope("hub", "private title", { kind, refs: { task: String(task.id) }, to: ["claude"] });
  function held(id: string, originals: ReturnType<typeof notice>[]) {
    journal.createDelivery({ id, peer: "claude", state: "needs_review", createdAt: Date.now(), originals, out: originals });
  }
  return { dir, file, board, task, journal, notice, held };
}
async function start(f: Awaited<ReturnType<typeof fixture>>) {
  return startDaemon({ cwd: f.dir, stateDir: f.dir, projectId: "superseded", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false } } });
}

test("AC2/AC3: restored obsolete notices settle as hub, mixed/live rows stay held; approval clears a held review (#434)", async () => {
  const f = await fixture();
  f.held("presence", [newEnvelope("hub", "private memory", { kind: "presence" })]);
  f.held("approved-assignment", [f.notice()]); // assignment to claude, who is not owner
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
    expect(daemon.bus.queueShow("live-review")?.state).toBe("needs_review");
    expect(daemon.bus.queueShow("mixed")?.state).toBe("needs_review");
    expect((await client.request({ t: "status" })).status.peers.claude.heldRows.map((row: any) => row.id)).toEqual(["live-review", "mixed"]);
    const route = await client.request({ t: "task", op: "route_explain", args: { id: f.task.id } });
    expect(JSON.stringify(route)).toContain("live-review"); expect(JSON.stringify(route)).toContain("mixed");
    const reviewed = await client.request({ t: "task", op: "hub_review", args: { id: f.task.id, verdict: "approved" } });
    expect(reviewed.ok).toBe(true);
    expect(daemon.bus.queueShow("live-review")?.state).toBe("completed");
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
