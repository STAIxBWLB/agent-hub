import { afterEach, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { MemoryStore } from "@staix/agent-mem";
import { deriveMemoryCodeOverlay, unavailableMemoryCodeOverlay } from "../src/hub/memory-code-overlay.ts";
import { canonicalMemorySymbolNode } from "../src/hub/memory-symbols.ts";
import { taskMemoryQueryNodes } from "../src/hub/memory-plan-guard.ts";
import { withoutPii } from "../src/hub/memory-policy.ts";
import { currentRouting } from "../src/hub/routing.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { Bus } from "../src/hub/bus.ts";
import { Board } from "../src/hub/board.ts";
import { USER } from "../src/hub/envelope.ts";
import { memoryRead, validateMemoryRead } from "../src/hub/read-tools.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import { symbolFields } from "../src/cli/console-symbols.ts";
const source = readFileSync(new URL("../src/hub/daemon.ts", import.meta.url), "utf8"), HEAD = "a".repeat(40), cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-code-host-")), store = new MemoryStore({ home: join(cwd, "memory") }), board = new Board(join(cwd, "hub.db"));
  cleanup.push(() => { board.close(); store.close(); rmSync(cwd, { recursive: true, force: true }); });
  const routing = currentRouting(cwd), bus = new Bus({ batchMs: 0 }); cleanup.push(() => bus.closeJournal());
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", repository: "o/r", routing: () => routing, notify: () => {}, store: { store, project: "fixture", repo: "o/r" } });
  let blocked = "";
  const screenMemory = <T extends { title: string | null; text: string }>(rows: T[]) => withoutPii(rows, routing, cwd).filter(row => !blocked || !`${row.title ?? ""} ${row.text}`.includes(blocked));
  const publicMetadataText = (text: string) => screenMemory([{ title: null, text }]).length === 1;
  let queries = 0, probes = 0, now = 0, hook = () => {}, head = HEAD;
  const ports = { Buffer, performance: { now: () => now }, opts: { cwd }, memoryProject: "fixture", memoryRepo: "o/r", config: { local: { deny: [] }, memory: { brief_items: 8 } }, memoryStore: store,
    deriveMemoryCodeOverlay, unavailableMemoryCodeOverlay, canonicalMemorySymbolNode, readMemoryCodeHead: () => { probes++; const observed = head; return { head: observed, current: () => head }; }, stopping: false,
    checkMemory: () => {}, tasks, boundedSafe: publicMetadataText,
    screenMemory, memoryLine: (v: any) => `mem:${v.id.slice(0,8)} ${v.kind}: ${v.text}`, board, turns: new Map(), contextPii: () => false,
    taskNodes: (t: any) => taskMemoryQueryNodes(t, { cwd, project: "fixture", repo: "o/r" }),
    codeFacts: { neighbours: async (_cwd: string, at: string, selector: string, depth: number) => {
      queries++; expect(at).toBe(HEAD); expect(selector).toBe("src/a.ts:target"); expect(depth).toBe(1); hook();
      return { state: "known", value: { callers: [], callees: [{ name: "callee", path: "src/b.ts", kind: "fn", line: 1, ambiguous: false, change: "unknown" }], hiddenAmbiguous: 0, countsFloor: false } };
    } },
  };
  const start = source.indexOf("  const memoryCodeCache"), end = source.indexOf("  const leaseNoticed", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end) + "\nglobalThis.read = taskMemoryResult; globalThis.code = memoryCode; globalThis.publish = currentMemoryCode;");
  const context = runInNewContext(code + "\n({ read, code, publish })", ports) as { read(task: any, cacheOnly?: boolean): Promise<any>; code(starts: string[]): Promise<any>; publish(code: any): any };
  return { ...context, board, store, ports, queries: () => queries, probes: () => probes, time(value: number) { now = value; }, hook(fn: () => void) { hook = fn; }, block(value: string) { blocked = value; }, head(value: string) { head = value; } };
}
test("#367 daemon brief joins planned and one-hop fail/decision notes before ordinary notes", async () => {
  const f = fixture();
  const task = f.board.propose(USER, { title: "target", class: "implement", plan: { symbols: ["target@src/a.ts"] } });
  const add = (text: string, kind: "fail" | "decision" | "finding", about: string) => f.store.note({ op: "note", project: "fixture", scope: "project", tier: "long", peer: "person", source: "person", text, kind, about: [about] });
  add("direct finding", "finding", "symbol:target@src/a.ts"); add("neighbour fail", "fail", "symbol:callee@src/b.ts"); add("neighbour decision", "decision", "symbol:callee@src/b.ts");
  const out = await f.read(task);
  expect(f.queries()).toBe(1); expect(out.state).toBe("known"); expect(out.items.map((v: any) => v.kind)).toEqual(["fail", "decision", "finding"]);
});
test("#367 daemon skips PII before queries and withholds changed task/head results", async () => {
  const f = fixture(), task = f.board.propose(USER, { title: "target", class: "implement", plan: { symbols: ["target@src/a.ts"] } });
  const privateTask = f.board.update(task.id, USER, "signals", { signals: ["pii"] });
  expect(await f.read(privateTask)).toMatchObject({ state: "unknown", items: [] }); expect(f.queries()).toBe(0);
  const ordinary = f.board.update(task.id, USER, "signals", { signals: [] });
  f.hook(() => { f.board.update(task.id, USER, "changed", { plan: { symbols: ["other@src/a.ts"] } }); });
  expect(await f.read(ordinary)).toMatchObject({ state: "unknown", items: [] }); expect(f.queries()).toBe(1);
  f.hook(() => f.head("b".repeat(40))); f.time(5000);
  expect(await f.code(["symbol:target@src/a.ts"])).toMatchObject({ state: "unknown", nodes: [], edges: [], notes: [] });
});

test("#367 model graph fences invalid/private inputs before code queries and rechecks capability after await", async () => {
  const f = fixture(); let allowed = true, calls = 0;
  const start = source.indexOf('    if (MEMORY_READ_TOOLS.has(op)) {\n      validateMemoryRead'), end = source.indexOf('    if (op === "hub_memory_correct")', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  const ports = { ...f.ports, MEMORY_READ_TOOLS: new Set(["hub_memory_graph"]), validateMemoryRead, memoryRead, PreEffectToolRefusal,
    need: () => { if (!allowed) throw new PreEffectToolRefusal("unavailable"); }, connectionGeneration: () => "session", by: "codex", may: () => allowed,
    staleness: () => () => false, currentMemoryCode: f.publish, memoryCode: async () => { calls++; allowed = false; return unavailableMemoryCodeOverlay(); } };
  const invoke = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.invoke = async (op, a) => {${block}};`), ports) as (op: string, a: object) => Promise<string>;
  await expect(invoke("hub_memory_graph", { starts: ["symbol:target@src/a.ts"], foreign: true })).rejects.toThrow(); expect(calls).toBe(0);
  await expect(invoke("hub_memory_graph", { starts: ["900101-1234567", "symbol:target@src/a.ts"] })).rejects.toThrow(); expect(calls).toBe(0);
  await expect(invoke("hub_memory_graph", { starts: ["symbol:target@src/a.ts"] })).rejects.toThrow("memory read unavailable"); expect(calls).toBe(1);
});
test("#367 console related-note line is bounded, unknown-aware and private-task silent", () => {
  const task = { id: 1, state: "in_progress", title: "public", relatedMemory: { state: "known", count: 3 } };
  expect(symbolFields(task)).toContainEqual(["related notes", 3]);
  expect(symbolFields({ ...task, relatedMemory: { state: "unknown", count: 3 } })).toContainEqual(["related notes", "unknown"]);
  expect(symbolFields({ ...task, signals: ["pii"] })).toEqual([]);
});

test("#367 foreign or inconsistent code scope keeps the existing direct brief without querying the hub tree", async () => {
  const f = fixture();
  const note = f.store.note({ op: "note", project: "fixture", scope: "project", tier: "long", kind: "fail", peer: "person", source: "person", text: "direct plan fail", about: ["symbol:target@src/a.ts"] });
  const foreign = f.board.propose(USER, { title: "target", class: "implement", refs: { repo: "other/repo" }, plan: { symbols: ["target@src/a.ts"] } });
  expect(await f.read(foreign)).toMatchObject({ state: "unknown", items: [{ id: `mem:${note}` }] }); expect(f.queries()).toBe(0);
  const draft = f.board.propose(USER, { title: "target", class: "implement", refs: { repo: "o/r" }, plan: { symbols: ["target@src/a.ts"] } });
  const mixed = f.board.update(draft.id, USER, "identity", { sdlc: { stage: "intent", repo: "other/repo" } });
  expect(await f.read(mixed)).toMatchObject({ state: "unknown", items: [{ id: `mem:${note}` }] }); expect(f.queries()).toBe(0);
});
test("#367 full direct rows are screened again after awaited code preparation", async () => {
  const f = fixture(), task = f.board.propose(USER, { title: "target", class: "implement", plan: { symbols: ["target@src/a.ts"] } });
  f.store.note({ op: "note", project: "fixture", scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "ordinary ".repeat(40) + "LATE_POLICY", about: ["symbol:target@src/a.ts"] });
  f.hook(() => f.block("LATE_POLICY"));
  expect((await f.read(task)).items).toEqual([]); expect(f.queries()).toBe(1);
});

test("#367 async dashboard prepares outside core snapshot and rechecks policy at publication", async () => {
  const f = fixture(), events: string[] = [];
  f.store.note({ op: "note", project: "fixture", scope: "project", tier: "long", kind: "fail", peer: "person", source: "person", text: "ordinary ".repeat(40) + "LATE_POLICY", about: ["symbol:callee@src/b.ts"] });
  const overlay = await f.code(["symbol:target@src/a.ts"]); expect(overlay.notes).toHaveLength(1);
  const start = source.indexOf("  async function uiMemorySnapshot("), end = source.indexOf("  function uiSnapshot(", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const ports = { ...f.ports, currentMemoryCode: f.publish,
    memoryCode: async () => { events.push("prepare"); queueMicrotask(() => f.block("LATE_POLICY")); return overlay; },
    uiSnapshot: () => { events.push("snapshot"); return { memory: { node: "symbol:target@src/a.ts" } }; } };
  const invoke = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end) + "\nglobalThis.invoke = uiMemorySnapshot;"), ports) as (after: number, input: object) => Promise<any>;
  const out = await invoke(0, { view: "memory", memory: { node: "symbol:target@src/a.ts", codeNeighbours: true } });
  expect(events).toEqual(["prepare", "snapshot"]); expect(out.memory.code).toMatchObject({ state: "unknown", nodes: [], edges: [], notes: [] });
  events.length = 0; expect((await invoke(0, { memory: { node: "symbol:target@src/a.ts" } })).memory.code).toBeUndefined(); expect(events).toEqual(["snapshot"]);
});

test("#367 console counts are cache-only and direct notes survive overlay task invalidation", async () => {
  const f = fixture(), task = f.board.propose(USER, { title: "target", class: "implement", plan: { symbols: ["target@src/a.ts"] } });
  const id = f.store.note({ op: "note", project: "fixture", scope: "project", tier: "long", kind: "fail", peer: "person", source: "person", text: "direct fail", about: ["symbol:target@src/a.ts"] });
  expect(await f.read(task, true)).toMatchObject({ state: "unknown", items: [{ id: `mem:${id}` }] }); expect(f.queries()).toBe(0); expect(f.probes()).toBe(0);
  f.hook(() => { f.board.update(task.id, USER, "changed", { plan: { symbols: ["other@src/a.ts"] } }); });
  expect(await f.read(task)).toMatchObject({ state: "unknown", items: [{ id: `mem:${id}` }] }); expect(f.queries()).toBe(1);
});
test("#367 optional cache holds unknowns briefly and rechecks HEAD without repeated native probes", async () => {
  const f = fixture(); f.ports.codeFacts.neighbours = async () => ({ state: "unknown" }) as any;
  await f.code(["symbol:target@src/a.ts"]); await f.code(["symbol:target@src/a.ts"]);
  expect(f.probes()).toBe(1);
  f.time(5001); await f.code(["symbol:target@src/a.ts"]); expect(f.probes()).toBe(2);
  f.head("b".repeat(40)); expect(await f.code(["symbol:target@src/a.ts"])).toMatchObject({ state: "unknown", nodes: [], edges: [] }); expect(f.probes()).toBe(2);
});
test("#367 optional native brief cap is snapshotted before code waits", async () => {
  const f = fixture(), task = f.board.propose(USER, { title: "target", class: "implement", plan: { symbols: ["target@src/a.ts"] } });
  for (let i = 0; i < 3; i++) f.store.note({ op: "note", project: "fixture", scope: "project", tier: "long", kind: "fail", peer: "person", source: "person", text: `direct fail ${i}`, about: ["symbol:target@src/a.ts"] });
  f.hook(() => { f.ports.config.memory.brief_items = 1; });
  expect((await f.read(task)).items).toHaveLength(3);
});
test("#367 a PII-turn owner skips optional code but retains screened direct advice", async () => {
  const f = fixture(), draft = f.board.propose(USER, { title: "target", class: "implement", plan: { symbols: ["target@src/a.ts"] } });
  const task = f.board.update(draft.id, USER, "accepted", { owner: "codex", state: "in_progress" });
  const id = f.store.note({ op: "note", project: "fixture", scope: "project", tier: "long", kind: "fail", peer: "person", source: "person", text: "direct fail", about: ["symbol:target@src/a.ts"] });
  f.ports.turns.set("codex", { private: true });
  expect(await f.read(task)).toMatchObject({ state: "unknown", items: [{ id: `mem:${id}` }] }); expect(f.queries()).toBe(0); expect(f.probes()).toBe(0);
});
test("#367 cached code topology refreshes newly attached notes without another code query", async () => {
  const f = fixture(), task = f.board.propose(USER, { title: "target", class: "implement", plan: { symbols: ["target@src/a.ts"] } });
  await f.read(task); expect(f.queries()).toBe(1);
  const id = f.store.note({ op: "note", project: "fixture", scope: "project", tier: "long", kind: "fail", peer: "person", source: "person", text: "new neighbour fail", about: ["symbol:callee@src/b.ts"] });
  expect((await f.read(task, true)).items.map((item: any) => item.id)).toContain(`mem:${id}`); expect(f.queries()).toBe(1); expect(f.probes()).toBe(1);
});

test("#367 optional preparation exceptions cannot suppress direct brief fails", async () => {
  const f = fixture(), task = f.board.propose(USER, { title: "target", class: "implement", plan: { symbols: ["target@src/a.ts"] } });
  const id = f.store.note({ op: "note", project: "fixture", scope: "project", tier: "long", kind: "fail", peer: "person", source: "person", text: "direct fail", about: ["symbol:target@src/a.ts"] });
  f.ports.readMemoryCodeHead = () => { throw Error("unavailable optional head provider"); };
  expect(await f.read(task)).toMatchObject({ state: "unknown", items: [{ id: `mem:${id}` }] }); expect(f.queries()).toBe(0);
});
