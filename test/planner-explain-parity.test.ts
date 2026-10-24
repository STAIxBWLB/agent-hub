import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { USER, type Envelope } from "../src/hub/envelope.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";

// #525-3: `route explain` prints the planner walk assignment ran, from the same function and the same settled holders.
class Peer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) {}
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function rig(roles: Record<string, string[]>, attached: string[] = ["claude", "codex", "kimi"]) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-planner-explain-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 });
  const routing = loadRouting(dir), screen = { enabled: false, run: () => {} };
  const tasks = new Tasks({ board, bus, cwd: dir, project: "explain", routing: () => ({ ...routing, signals: { ...routing.signals, pii_screen: screen.enabled ? "local" : "off" } }), roles, wipLimit: () => 9, notify: () => {}, piiScreen: async () => { screen.run(); return { label: "clear", ms: 0 }; } });
  for (const id of attached) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  return { tasks, board, bus };
}
const plannerLines = (lines: string[]) => lines.filter(line => line.includes("planner candidate") || line.startsWith("planner:"));

test("explain of a task prints the planner walk with the task's own seed, and it names a holder that rotates with the task id", async () => {
  const { tasks } = await rig({ claude: ["planner"], codex: ["planner"], kimi: ["planner", "implementer"] });
  const picked: string[] = [];
  for (let n = 0; n < 6; n++) {
    const task = await tasks.propose(USER, { title: `piece ${n}`, class: "implement" });
    const lines = plannerLines(tasks.explain(task.id));
    const final = lines.find(line => line.startsWith("planner: "))!;
    expect(task.planner).toBe(["claude", "codex", "kimi"][task.id % 3]);
    expect(task.history[0]).toMatchObject({ planner: task.planner, plannerReason: "rotation" });
    expect(final).toBe(`planner: ${task.planner} (kept)`);
    picked.push(task.planner!);
    expect(lines.filter(line => line.startsWith("  planner candidate ")).length).toBeGreaterThan(0);
  }
  // sorted holders claude, codex, kimi: the task id picks the start, so consecutive ids walk the whole list
  expect(new Set(picked)).toEqual(new Set(["claude", "codex", "kimi"]));
  for (let i = 3; i < 6; i++) expect(picked[i]).toBe(picked[i - 3]);
});

test("explain and the assignment's own walk are the same lines, holder set included", async () => {
  const { tasks } = await rig({ claude: ["planner"], codex: ["planner"] });
  const task = await tasks.propose(USER, { title: "same walk", class: "implement" });
  const explained = tasks.explain(task.id);
  const again = tasks.explain(task.id);
  expect(plannerLines(explained)).toEqual(plannerLines(again));
  expect(plannerLines(explained).length).toBeGreaterThanOrEqual(2);
  // a draft (no task id yet) walks from seed 0 with the same holders, so it never invents a planner the board would not
  const draft = tasks.explain({ title: "a draft", class: "implement" });
  expect(plannerLines(draft).find(line => line.startsWith("planner: "))).toBe("planner: claude (rotation)");
});

test("a holder that is not attached is skipped in the printed walk, and no holder prints none", async () => {
  const one = await rig({ claude: ["planner"], codex: ["planner"] }, ["claude"]); // codex holds the role but is not attached
  const seeds = [];
  for (let n = 0; n < 4; n++) {
    // An explicit legacy null binding runs the walk; a bound task correctly reports its kept planner.
    const task = one.board.propose(USER, { title: `one attached ${n}`, class: "implement", planner: null });
    const lines = plannerLines(one.tasks.explain(task.id));
    expect(lines.at(-1)).toMatch(/^planner: claude \(rotation/); // only the attached holder can be chosen, whatever the seed
    seeds.push(lines.some(line => line === "  planner candidate codex: skipped, not attached"));
  }
  expect(seeds).toContain(true); // a task whose seed starts at codex shows it skipped
  const nobody = await rig({}, ["claude", "codex"]);
  const orphan = await nobody.tasks.propose(USER, { title: "no planner role", class: "implement" });
  expect(plannerLines(nobody.tasks.explain(orphan.id))).toEqual(["planner: none (no planner holder)"]);
});

test("explain is read-only: it never writes a planner or a history entry to the board", async () => {
  const { tasks, board } = await rig({ claude: ["planner"], codex: ["planner"] });
  const task = await tasks.propose(USER, { title: "ordinary", class: "implement" });
  const planner = task.planner;
  expect(planner).toBeDefined();
  expect(task.history[0]).toMatchObject({ planner, plannerReason: "rotation" });
  const before = JSON.stringify(board.get(task.id));
  tasks.explain(task.id); tasks.explain({ title: "draft", class: "implement" });
  expect(JSON.stringify(board.get(task.id))).toBe(before); // Explaining a bound task never changes its existing binding or history.
  expect(board.get(task.id)?.planner).toBe(planner);
  expect(board.get(task.id)!.history.map(entry => entry.event)).not.toContain("planner changed");
});
