import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiPeer } from "../src/adapters/pi.ts";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { HUB, newEnvelope } from "../src/hub/envelope.ts";

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>(resolve => { release = resolve; });
  return { reached, release };
}

for (const durable of [false, true]) for (const noticeKind of ["move", "cancel"] as const) {
  test(`Pi receives a ${noticeKind} notice published during chat condensation in its first native prompt: durable=${durable} (#1447 T4)`, async () => {
    const root = mkdtempSync(join(tmpdir(), "ahub-pi-task-move-"));
    const journal = durable ? new DeliveryJournal({ file: join(root, "hub.db"), projectRoot: root, projectId: "pi-task-move", instanceId: "condense-preview" }) : undefined;
    const condensing = barrier(), releaseCondense = barrier(), firstDelivered = barrier(), secondDelivered = barrier();
    let preparations = 0;
    const bus = new Bus({ batchMs: 0, journal, condense: async envs => {
      if (++preparations === 1) { condensing.release(); await releaseCondense.reached; }
      return envs;
    } });
    const peer = new PiPeer("pi", {
      cwd: root, stateDir: root, mode: "headless", backend: "dgx",
      cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts")],
      relay: { url: "http://127.0.0.1:9/v1", token: "fixture-relay", models: [{ id: "dgx/coding" }] },
      tools: [], executeTool: async () => "ok",
    });
    const prompts: string[] = [], steers: string[] = [];
    // Observe actual outbound commands and delegate them unchanged to the existing native fake.
    // This is host test instrumentation, not another fake protocol or bridge producer.
    const transport = peer as unknown as { sendRpc(command: Record<string, unknown>): Promise<unknown> };
    const sendRpc = transport.sendRpc.bind(peer);
    transport.sendRpc = command => {
      if (command.type === "prompt") prompts.push(String(command.message));
      if (command.type === "steer") steers.push(String(command.message));
      return sendRpc(command);
    };
    const deliver = peer.deliver.bind(peer);
    let deliveries = 0;
    peer.deliver = async (envs, deliveryId) => {
      await deliver(envs, deliveryId);
      if (++deliveries === 1) firstDelivered.release();
      else if (deliveries === 2) secondDelivered.release();
    };
    try {
      await peer.start(); bus.add(peer);
      const unrelated = newEnvelope(HUB, "UNRELATED_HELD_BODY", { to: ["codex"], kind: "task", refs: { task: "99" } });
      const held = journal?.createDelivery({ id: "unrelated-held", peer: "codex", state: "needs_review", createdAt: unrelated.ts, originals: [unrelated], out: [unrelated] });
      const recall = "PREFACE_ONCE_CANARY";
      bus.preface("pi", recall);
      const chat = newEnvelope("user", "QUEUED_CHAT_CANARY", { to: ["pi"], refs: { task: "41" } });
      bus.publish(chat);
      await condensing.reached;
      expect(peer.state).toBe("idle"); expect(prompts).toEqual([]);
      const noticeText = noticeKind === "move" ? "TASK_MOVE_CANARY: Task 41 moved to another owner. Stop working on it."
        : "TASK_CANCEL_CANARY: Task 41 cancelled. Stop working on it.";
      const notice = newEnvelope(HUB, noticeText, { to: ["pi"], kind: "task", priority: "important",
        refs: { task: "41", ...(noticeKind === "cancel" ? { taskCancelled: 7 } : {}) } });
      expect(bus.publish(notice)).toContain("pi");
      expect(bus.attemptState()).toEqual({});
      if (journal) expect(journal.get("unrelated-held")).toEqual(held);
      releaseCondense.release();
      await firstDelivered.reached;
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain(noticeText);
      expect(prompts[0]).toContain(chat.body);
      expect(prompts[0]!.indexOf(noticeText)).toBeLessThan(prompts[0]!.indexOf(chat.body));
      expect(prompts[0]!.split(recall)).toHaveLength(2);
      expect(steers).toEqual([]); // Workflow notices remain queued delivery, never native steer.
      expect(bus.queueIds("pi")).not.toContain(notice.id);
      expect(bus.queueIds("pi")).not.toContain(chat.id);
      expect(bus.attemptState()).toEqual({}); // Discarding a prepared chat batch is not a failed delivery.
      if (journal) expect(journal.get("unrelated-held")).toEqual(held);

      const launch = peer.tuiLaunch!;
      const event = async (body: object) => {
        const response = await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/event`, { method: "POST",
          headers: { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
        expect(response.ok).toBe(true); await response.text();
      };
      await event({ type: "agent_start", generation: 1 });
      const later = newEnvelope("user", "NEXT_CHAT_CANARY", { to: ["pi"] });
      bus.publish(later);
      await event({ type: "agent_end", generation: 1, text: "acknowledged" });
      await event({ type: "agent_settled", generation: 1 });
      await secondDelivered.reached;
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain(later.body);
      expect(prompts[1]).not.toContain(recall);
      expect(prompts[1]).not.toContain(noticeText);
      expect(bus.attemptState()).toEqual({});
      if (journal) {
        expect(journal.get("unrelated-held")).toEqual(held);
        const completed = journal.list("pi").filter(row => row.state === "completed");
        expect(completed.some(row => row.originals.some(env => env.id === notice.id) && row.originals.some(env => env.id === chat.id))).toBe(true);
      }
    } finally {
      releaseCondense.release();
      try { await peer.stop("fixture cleanup"); }
      finally { bus.closeJournal(); rmSync(root, { recursive: true, force: true }); }
    }
  }, 20_000);
}
