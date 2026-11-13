import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Task } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { USER, type Envelope } from "../src/hub/envelope.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { Conductor, type ConductorHooks } from "../src/hub/conductor.ts";

// #1430: an unreserved planner pull names what routing refused instead of dropping it, and every refusal names the route out.
class Peer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) {}
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

/** codex and kimi implement and claude plans; both are attached and idle, and the PII constraint is what routing refuses. */
async function rig() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-planner-refusal-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 });
  const routing = loadRouting(dir);
  const tasks = new Tasks({ board, bus, cwd: dir, project: "planner-refusal", notify: () => {},
    routing: () => ({ ...routing, signals: { ...routing.signals, pii_patterns: ["PRIVATE-919"] }, constraints: { ...routing.constraints, pii: "local_only" as const }, classes: { ...routing.classes, implement: { ...routing.classes.implement, peers: ["codex", "kimi"] } } }),
    roles: { claude: ["planner"], codex: ["implementer"], kimi: ["implementer"] }, wipLimit: () => 1 } as never);
  for (const id of ["codex", "kimi", "claude"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  return { tasks };
}

test("an unreserved planner pull names each routing refusal and the reserve-then-pull route (#1430)", async () => {
  const r = await rig();
  const task = await r.tasks.propose(USER, { title: "PRIVATE-919 title", class: "implement", backlog: true });
  const refused = await r.tasks.pullPlanned("claude", { id: task.id, revision: 0, reason: "pull it" }).then(() => "", (error: Error) => error.message);
  expect(refused).toContain("codex: pii: on-prem peers only");
  expect(refused).toContain("kimi: pii: on-prem peers only"); // the peer id and its routing reason, which pullPlanned used to drop
  expect(refused).toContain("hub_backlog_plan fields.reserved");
  expect(refused).toContain("then pull again");
  expect(refused).not.toContain("PRIVATE-919"); // peer ids and reasons only (#531)
});

test("hub_task_assign on a backlog card names the reserve-then-pull route (#1430)", async () => {
  const staged = (): Task => ({ id: 4, title: "staged", detail: "", class: "implement", state: "backlog", owner: null, reviewer: null, refs: {}, signals: [], rejections: 0, history: [{ at: 1, by: "claude", event: "backlogged" }], created: 1, updated: 1 });
  const assigned: string[] = [];
  const hooks: ConductorHooks = {
    roles: () => ({ claude: ["conductor"] }), capabilities: () => ({}), status: () => ({}) as never,
    task: () => staged(), publicView: task => ({ ...task }), assign: async () => { assigned.push("assign"); }, escalate: async () => {},
    preview: () => "", startMode: () => "headless", start: async () => ({}), known: () => true, pause: () => {}, release: () => {}, audit: () => {},
  };
  const conductor = new Conductor({} as never, hooks);
  const refused = await conductor.execute("claude", "hub_task_assign", { id: 4, peer: "pi" }).then(() => "", (error: Error) => error.message);
  expect(refused).toContain("hub_backlog_plan fields.reserved");
  expect(refused).toContain("then pull again");
  expect(assigned).toEqual([]); // refused before any assignment write
});


test("routing reasons remain visible alongside another peer's WIP refusal (#1430)", async () => {
  const r = await rig();
  await r.tasks.propose(USER, { title: "ordinary occupied task", class: "implement", owner: "codex" });
  const task = await r.tasks.propose(USER, { title: "PRIVATE-919 hidden task", class: "implement", backlog: true });
  const refused = await r.tasks.pullPlanned("claude", { id: task.id, revision: 0, reason: "ready" }).then(() => "", (error: Error) => error.message);
  expect(refused).toContain("codex WIP full (1/1)");
  expect(refused).toContain("kimi: pii: on-prem peers only");
  expect(refused).not.toContain("PRIVATE-919");
});
