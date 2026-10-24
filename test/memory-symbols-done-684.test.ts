import { afterEach, expect, test } from "bun:test";
import { MemoryStore, taskKey } from "@staix/agent-mem";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { USER } from "../src/hub/envelope.ts";
import type { ReviewBrief } from "../src/hub/review-brief.ts";
const HEAD = "a".repeat(40), BASE = "b".repeat(40), NODE = "symbol:Actual.run@a.ts";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function brief(): ReviewBrief {
  return { head: HEAD, base: "origin/main", mergeBase: BASE, reviewable: [{ path: "a.ts", status: "M" }], excluded: [], withheld: 0, rules: [], rulesMissing: [], ruleGroups: [], unlisted: [],
    symbols: { state: "known", complete: true, planned: [], unplanned: [], unseen: [], files: [{ path: "a.ts", symbols: [{ name: "Actual.run", kind: "fn", path: "a.ts", line: 1, ambiguous: false, change: "unknown" }] }] } };
}
function rig(extra: Partial<TasksDeps> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-memory-symbols-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const store = new MemoryStore({ home: join(cwd, "memory") });
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", notify: () => {}, routing: () => loadRouting(cwd),
    store: { store, project: "fixture", repo: "owner/repo" }, prepareReviewBrief: async () => {}, reviewBrief: () => brief(),
    memorySymbolNodes: () => ({ state: "known", nodes: [NODE], unknown: 0, truncated: false }), ...extra });
  const task = board.propose(USER, { title: "memory symbols", class: "implement", refs: { paths: ["a.ts"], commit: HEAD }, plan: { paths: ["a.ts"], symbols: ["Guessed.run(input)"] } });
  board.update(task.id, "codex", "accepted", { state: "in_progress", owner: "codex", reviewer: USER });
  cleanup.push(() => { bus.closeJournal(); board.close(); store.close(); rmSync(cwd, { recursive: true, force: true }); });
  return { cwd, board, store, tasks, task };
}

test("#684 completion anchors actual changed symbols and symbol-related retrieval reaches earlier task notes at memory hop two", async () => {
  const f = rig();
  await f.tasks.remember("codex", { kind: "fail", text: "earlier decision evidence", task: f.task.id });
  const earlier = f.store.list({ project: "fixture" })[0]!;
  expect(earlier.about.filter(node => node.startsWith("symbol:"))).toEqual(["symbol:Guessed.run@a.ts"]);
  await f.tasks.done("codex", f.task.id, "implementation finished");
  const completion = f.store.list({ project: "fixture" }).find(note => note.text.startsWith(`Task #${f.task.id} done`))!;
  expect(completion.about).toContain(NODE);
  expect(completion.about).toContain(`task:${taskKey("fixture", f.task)}`);
  expect(completion.about.join(" ")).not.toContain("Guessed");
  expect(f.store.get(earlier.id)?.about).toEqual(earlier.about);
  expect(f.store.related("fixture", [NODE], 20)).toContainEqual(expect.objectContaining({ id: earlier.id, hops: 2 }));
  // graph() counts literal edges; related() counts memory neighbourhoods. No core schema or traversal is changed.
  const graph = f.store.graph("fixture", NODE, 2);
  expect(graph.nodes.map(node => node.id)).toContain(`mem:${completion.id}`);
  expect(graph.nodes.map(node => node.id)).toContain(`task:${taskKey("fixture", f.task)}`);
  expect(graph.nodes.map(node => node.id)).not.toContain(`mem:${earlier.id}`);
});

test("#684 missing or nonmatching verified observations never fall back to planned symbols", async () => {
  for (const memorySymbolNodes of [undefined, () => ({ state: "known" as const, nodes: ["symbol:Guessed.run@a.ts"], unknown: 0, truncated: false })]) {
    const f = rig({ memorySymbolNodes });
    await f.tasks.done("codex", f.task.id, "finished without current verified symbols");
    const completion = f.store.list({ project: "fixture" }).find(note => note.text.startsWith(`Task #${f.task.id} done`))!;
    expect(completion.about.filter(node => node.startsWith("symbol:"))).toEqual([]);
    expect(completion.text).toContain("unknown");
  }
});

test("#684 private tasks do not query symbol ports or write completion memories", async () => {
  let queries = 0;
  const f = rig({ prepareReviewBrief: async () => { queries++; }, memorySymbolNodes: () => { queries++; return undefined; } });
  f.board.update(f.task.id, USER, "private fixture", { signals: ["pii"] });
  await f.tasks.done(USER, f.task.id, "private result");
  expect(queries).toBe(0); expect(f.store.list({ project: "fixture" })).toEqual([]);
});


test("#684 stale and foreign head observations cannot reach the completion memory symbol port", async () => {
  for (const patch of [{ refs: { paths: ["a.ts"], commit: "c".repeat(40) } }, { refs: { paths: ["a.ts"], commit: HEAD, repo: "other/repo" } }]) {
    let queries = 0;
    const f = rig({ memorySymbolNodes: () => { queries++; return { state: "known", nodes: [NODE], unknown: 0, truncated: false }; } });
    f.board.update(f.task.id, USER, "fixture identity moved", patch);
    await f.tasks.done("codex", f.task.id, "finished with unavailable provenance");
    const completion = f.store.list({ project: "fixture" }).find(note => note.text.startsWith(`Task #${f.task.id} done`))!;
    expect(queries).toBe(0); expect(completion.about.filter(node => node.startsWith("symbol:"))).toEqual([]);
    expect(completion.text).toContain("unknown");
  }
});
