import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { USER } from "../src/hub/envelope.ts";
import { LINEAGE_LIMITS, type LineageResult } from "../src/hub/execution-lineage.ts";

// #1220 T3 / AC6: the bounded read measured on a large synthetic board. The page a task root admits must not grow
// with the board around it, and its cost stays inside the ceilings recorded in docs/dogfood.md.
const projectKey = "ahub-lineage-fixture";
const foreign = (index: number) => ({ v: 1 as const, tool: "ares" as const, projectKey: "foreign-producer-project", kind: "claim" as const, id: `opaque-${index}`, revision: `r${index}` });

class Peer extends BasePeer { async start() { this.setState("idle"); } async stop() {} async deliver() {} }

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-lineage-perf-"));
  const board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 });
  for (const id of ["claude", "codex", "kimi"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const root = board.propose(USER, { title: "lineage root", class: "implement" });
  board.update(root.id, USER, "assigned", { state: "in_progress", owner: "codex", reviewer: "claude", planner: "pi" });
  const routing = loadRouting(dir);
  const tasks = new Tasks({ board, bus, cwd: dir, project: "fixture", roles: { codex: ["implementer"], claude: ["reviewer"], kimi: ["implementer"] },
    notify: () => {}, routing: () => routing, privateTurn: () => false, reviewObserverInput: () => false, sweepHeld: () => false,
    executionLineage: { projectKey, cursorKey: "fixture-private-cursor-key-0000001", readDelivery: () => undefined } });
  return { board, tasks, root, dir,
    read: (query: Parameters<Tasks["executionLineage"]>[1]) => tasks.executionLineage("codex", query),
    filler: (count: number) => { for (let i = 0; i < count; i++) board.propose(USER, { title: `filler ${i}`, class: "implement" }); },
    close() { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function sample(read: () => LineageResult, count = 200) {
  const ms: number[] = [], sizes: number[] = [];
  for (let i = 0; i < count; i++) {
    const started = performance.now();
    const page = read();
    ms.push(performance.now() - started);
    if (page.state === "available") sizes.push(Buffer.byteLength(JSON.stringify(page)));
  }
  ms.sort((a, b) => a - b); sizes.sort((a, b) => a - b);
  return { p50: ms[Math.ceil(ms.length * 0.5) - 1]!, p95: ms[Math.ceil(ms.length * 0.95) - 1]!, max: ms.at(-1)!, maxBytes: sizes.at(-1) ?? 0 };
}

test("a lineage read stays bounded in latency and size while the synthetic board grows", async () => {
  const f = await fixture();
  try {
    const smallBoard = f.read({ taskId: f.root.id });
    const empty = sample(() => f.read({ taskId: f.root.id }));
    f.filler(2000);
    const large = sample(() => f.read({ taskId: f.root.id }));
    // The same admitted page on a board 2000 tasks deeper: this root's neighborhood is what the read costs, not the board.
    expect(large.maxBytes).toBe(empty.maxBytes);
    expect(f.read({ taskId: f.root.id })).toEqual(smallBoard);
    expect(empty.p95).toBeLessThan(250);
    expect(large.p95).toBeLessThan(250);
    expect(large.maxBytes).toBeLessThanOrEqual(LINEAGE_LIMITS.bytes);
  } finally { f.close(); }
}, 30_000);

test("the per-task declared-link ceiling is projected within the node, edge and byte caps", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 64; i++) {
      const task = f.board.get(f.root.id)!;
      await f.tasks.linkExecutionReference("codex", { taskId: task.id, taskCreated: task.created, flowRevision: task.history.length, reference: foreign(i) });
    }
    const measured = sample(() => f.read({ taskId: f.root.id }));
    expect(measured.p95).toBeLessThan(250);
    expect(measured.maxBytes).toBeLessThanOrEqual(LINEAGE_LIMITS.bytes);
    const page = f.read({ taskId: f.root.id });
    if (page.state !== "available") throw new Error(`expected an available page, got ${JSON.stringify(page)}`);
    expect(page.nodes).toHaveLength(65);
    expect(page.edges).toHaveLength(64);
    expect(page.truncated).toBe(false);
    expect(page.edges.every((edge) => edge.relation === "declared-external" && edge.strength === "declared")).toBe(true);
  } finally { f.close(); }
}, 30_000);

test("a smaller bound truncates with an opaque source-bound cursor and a byte bound stays inside its budget", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 64; i++) {
      const task = f.board.get(f.root.id)!;
      await f.tasks.linkExecutionReference("codex", { taskId: task.id, taskCreated: task.created, flowRevision: task.history.length, reference: foreign(i) });
    }
    const first = f.read({ taskId: f.root.id, nodes: 5 });
    if (first.state !== "available") throw new Error(`expected an available page, got ${JSON.stringify(first)}`);
    expect(first.nodes).toHaveLength(5);
    expect(first.truncated).toBe(true);
    expect(first.cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.byteLength(first.cursor!)).toBeLessThanOrEqual(LINEAGE_LIMITS.cursor);
    const next = f.read({ taskId: f.root.id, nodes: 5, cursor: first.cursor });
    if (next.state !== "available") throw new Error(`expected the next page, got ${JSON.stringify(next)}`);
    expect(next.nodes).not.toContainEqual(first.nodes[0]!);
    // A cursor is bound to the page it came from: the same cursor under another node bound is refused, not reused.
    expect(f.read({ taskId: f.root.id, nodes: 6, cursor: first.cursor }).state).toBe("unavailable");
    const byteBound = f.read({ taskId: f.root.id, bytes: LINEAGE_LIMITS.minimumBytes });
    if (byteBound.state !== "available") throw new Error(`expected a byte-bounded page, got ${JSON.stringify(byteBound)}`);
    expect(Buffer.byteLength(JSON.stringify(byteBound))).toBeLessThanOrEqual(LINEAGE_LIMITS.minimumBytes);
    expect(byteBound.truncated).toBe(true);
    const measuredBytes = sample(() => f.read({ taskId: f.root.id, bytes: LINEAGE_LIMITS.minimumBytes }));
    expect(measuredBytes.p95).toBeLessThan(250);
    expect(measuredBytes.maxBytes).toBeLessThanOrEqual(LINEAGE_LIMITS.minimumBytes);
  } finally { f.close(); }
}, 30_000);

