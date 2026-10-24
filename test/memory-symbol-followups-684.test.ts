import type { CodeFactResult, CodeSymbol } from "../src/hub/code-facts.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { MemoryStore } from "@staix/agent-mem";
import { type MemorySymbolNodes, resolveMemorySymbolNodes } from "../src/hub/memory-symbols.ts";
import { matchingPlanFails, planGuardNodes, taskMemoryQueryNodes } from "../src/hub/memory-plan-guard.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { isDenied } from "../src/local/deny.ts";
import { matchesPolicy } from "../src/hub/path-policy.ts";
import { withCodeSymbols, type ReviewBrief } from "../src/hub/review-brief.ts";
const HEAD = "a".repeat(40), BASE = "b".repeat(40), cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function temp() { const root = mkdtempSync(join(tmpdir(), "ahub684-followups-")); cleanup.push(() => rmSync(root, { recursive: true, force: true })); return root; }
const context = { cwd: "/fixture", project: "fixture", repo: "o/r", allowed: () => true };

test("#684 one symbol prepare caches unknown exists results by query name across paths", async () => {
  let calls = 0;
  const result = await resolveMemorySymbolNodes(["symbol:run@a.ts", "symbol:run@b.ts"], context, async () => { calls++; return { state: "unknown" }; });
  expect(calls).toBe(1); expect(result).toMatchObject({ state: "unknown", nodes: [], unknown: 2 });
});

function brief(head: string): ReviewBrief {
  return { head, base: "origin/main", mergeBase: BASE, reviewable: [{ path: "a.ts", status: "M" }, { path: "b.ts", status: "M" }], excluded: [], withheld: 0, rules: [], rulesMissing: [], ruleGroups: [], unlisted: [] };
}

test("#684 real no-reviewer done reuses prepareOnly symbols and performs one unknown exists query", async () => {
  const cwd = temp(), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 }), store = new MemoryStore({ home: join(cwd, "mem") });
  cleanup.push(() => { bus.closeJournal(); board.close(); store.close(); });
  writeFileSync(join(cwd, "a.ts"), "export function run() {}\n"); writeFileSync(join(cwd, "b.ts"), "export function run() {}\n");
  let exists = 0, prepared = 0, hooks = 0;
  const reviewSymbols = new Map<string, CodeFactResult<CodeSymbol[]>>(), memorySymbols = new Map<string, MemorySymbolNodes>();
  const source = readFileSync(new URL("../src/hub/daemon.ts", import.meta.url), "utf8"), marker = "prepareReviewBrief: async task => {";
  const start = source.indexOf(marker) + marker.length, end = source.indexOf("    memorySymbolNodes: task => {", start);
  expect(start).toBeGreaterThan(marker.length); expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end).replace(/\n    },\s*$/, "");
  const ports: Record<string, unknown> = { tasks: undefined, executionRoot: () => cwd,
    buildReviewBrief: (_root: string, head: string, policy: { privatePath(path: string): boolean; nameable(text: string): boolean }) => { expect(policy.privatePath("a.ts")).toBe(false); expect(policy.nameable("run")).toBe(true); return brief(head); },
    config: { local: { deny: [] }, pii: { paths: [] } }, isDenied, matchesPolicy, board, reviewSymbols, memorySymbols, memoryStore: store,
    memoryProject: "fixture", memoryRepo: "o/r", resolveMemorySymbolNodes,
    codeFacts: { changedSymbols: async () => { prepared++; return { state: "known", value: ["a.ts", "b.ts"].map(path => ({ name: "run", kind: "fn", path, line: 1, ambiguous: false, change: "unknown" })) }; }, exists: async () => { exists++; return { state: "unknown" }; } },
  };
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const prepare = runInNewContext(transpiler.transformSync(`globalThis.prepare = async task => {${body}};`), ports) as NonNullable<TasksDeps["prepareReviewBrief"]>;
  expect(typeof prepare).toBe("function");
  let tasks: Tasks;
  tasks = new Tasks({ cwd, board, bus, project: "fixture", notify: () => {}, routing: () => loadRouting(cwd), store: { store, project: "fixture", repo: "o/r" }, prepareReviewBrief: async task => { hooks++; await prepare(task); },
    reviewBrief: task => withCodeSymbols(brief(task.refs.commit!), reviewSymbols.get(JSON.stringify([cwd, task.refs.commit, BASE])) ?? { state: "unknown" }, task.plan?.symbols, tasks.publicMetadataText),
    memorySymbolNodes: task => memorySymbols.get(JSON.stringify([cwd, task.refs.commit, BASE])) });
  ports.tasks = tasks;
  const task = board.propose(USER, { title: "one bounded symbol pass", class: "implement", refs: { paths: ["a.ts", "b.ts"], commit: HEAD } });
  board.update(task.id, "codex", "accepted", { state: "in_progress", owner: "codex", reviewer: null });
  const done = await tasks.done("codex", task.id, "done");
  expect(done.state).toBe("approved"); expect(hooks).toBe(2); expect(prepared).toBe(1); expect(exists).toBe(1);
  expect(memorySymbols.get(JSON.stringify([cwd, HEAD, BASE]))).toMatchObject({ state: "unknown", unknown: 2, nodes: [] });
});

test("#684 raw-signature notes and normalized notes are both queried without rewriting either", () => {
  const cwd = temp(), store = new MemoryStore({ home: cwd }); cleanup.push(() => store.close());
  const task = { id: 1, created: 10, title: "legacy symbol", refs: {}, plan: { symbols: ["foo(a: string)@src/x.ts"] } }, ctx = { ...context, cwd };
  const raw = "symbol:foo(a: string)@src/x.ts", normalized = "symbol:foo@src/x.ts";
  const note = (about: string, kind: "fail" | "decision") => store.note({ op: "note", project: "fixture", scope: "project", tier: "long", kind, peer: "person", source: "person", text: about, about: [about] });
  const rawId = note(raw, "fail"), normalizedId = note(normalized, "decision"), before = readFileSync(join(store.dir, "log", `${store.machine.id}.jsonl`), "utf8");
  expect(planGuardNodes(task, ctx)).toEqual(expect.arrayContaining([raw, normalized]));
  expect(matchingPlanFails(task, store.list({ project: "fixture" }), ctx).map(note => note.id)).toEqual([rawId]);
  expect(store.related("fixture", taskMemoryQueryNodes(task, ctx), 10).map(note => note.id)).toEqual([rawId, normalizedId]);
  expect(store.get(rawId)?.about).toEqual([raw]); expect(store.get(normalizedId)?.about).toEqual([normalized]);
  expect(readFileSync(join(store.dir, "log", `${store.machine.id}.jsonl`), "utf8")).toBe(before);
});
