import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewerPrintPeer } from "../src/adapters/reviewer-print.ts";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { parseRouting } from "../src/hub/routing.ts";
import type { Envelope } from "../src/hub/envelope.ts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const until = async (condition: () => boolean) => { for (let count = 0; count < 200 && !condition(); count++) await Bun.sleep(5); expect(condition()).toBe(true); };
class Sink extends BasePeer {
  constructor(id: string, readonly reviewing = false) { super(id, 5000); }
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[], id?: string) {
    this.setState("busy");
    if (id) this.delivery({ id, state: "accepted" });
    if (!this.reviewing) { if (id) this.delivery({ id, state: "completed" }); this.setState("idle"); }
  }
}

for (const failure of ["none", "publish", "notify"] as const) test(`actual delivery journal ${failure === "none" ? "completes after confirmed fallback" : "retains hold after failed " + failure}`, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-review-fallback-journal-")), board = new Board(join(cwd, "board.db"));
  const journal = new DeliveryJournal({ file: join(cwd, "journal.db"), projectRoot: cwd, projectId: "fixture", instanceId: "fixture" });
  const bus = new Bus({ batchMs: 0, journal });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  let tasks: Tasks, confirmed = false, notificationBroken = false;
  const peer = new ReviewerPrintPeer("claude-review", { cwd, mcpConfig: "{}", systemPrompt: "fixture", watchdogMs: 5000,
    backend: { id: "fixture", prepare: async () => ({ command: [process.execPath, "-e", "await new Response(Bun.stdin.stream()).text();"], args: [],
      isolation: { backend: "fixture", binary: process.execPath, version: "fixture", profile: "fixture", readOnly: true, strictMcp: true, ephemeral: true, evidence: ["fixture only"] } }) },
    verdictSince: () => false, bindingCurrent: (id, binding) => tasks.reviewBindingCurrent("claude-review", id, binding),
    onUnavailable: async (failed, current) => { if (failure === "notify") notificationBroken = true; let offered = false; await tasks.retryReviewer(failed.task, "claude-review", failed, current, () => { offered = true; }); confirmed = offered; return offered; } });
  const owner = new Sink("codex"), next = new Sink("claude-two", true);
  for (const instance of [owner, next, peer]) { bus.add(instance); await instance.start(); cleanup.push(() => instance.stop()); }
  tasks = new Tasks({ cwd, board, bus, project: "fixture", routing: () => parseRouting('[local]\nfixed_model="fixture"\n[classes.summarize]\npeers=["codex"]\n[classes.review]\npeers=["claude"]\n'),
    notify: () => { if (notificationBroken) throw new Error("fixture notification unavailable"); },
    instances: () => ({ "claude-review": { kind: "claude", roles: ["reviewer"], start_mode: "headless" }, "claude-two": { kind: "claude", roles: ["reviewer"], start_mode: "headless" } }),
    roles: { codex: ["implementer"], "claude-review": ["reviewer"], "claude-two": ["reviewer"] }, review: { adaptive: false, min_reviews: 5, pool: ["claude"] }, reviewOnly: id => id === "claude-review" || id === "claude-two" });
  const proposed = await tasks.propose("user", { title: "synthetic no verdict", class: "summarize", owner: "codex" });
  await tasks.accept("codex", proposed.id);
  if (failure === "notify") await tasks.assignTo(proposed.id, "claude-review", "user", false, "reviewer");
  if (failure === "publish") { const publish = bus.publish.bind(bus); bus.publish = env => { if (env.kind === "review" && env.to?.includes("claude-two")) throw new Error("fixture publication unavailable"); return publish(env); }; }
  await tasks.done("codex", proposed.id, "ready");
  const delivery = () => journal.list("claude-review").find(value => value.originals.some(env => env.kind === "review" && env.refs?.task === String(proposed.id)));
  await until(() => peer.state === "idle" && (delivery()?.state === "completed" || delivery()?.state === "needs_review"));
  expect(delivery()?.state).toBe(failure === "none" ? "completed" : "needs_review");
  expect(confirmed).toBe(failure === "none");
  expect(Boolean(bus.queueSummary("claude-review").heldBy)).toBe(failure !== "none");
  expect(board.get(proposed.id)?.reviewer).toBe(failure === "notify" ? "user" : "claude-two");
});
