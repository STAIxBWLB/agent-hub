import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, type NoteInput, type View } from "@staix/agent-mem";
import { memoryRead, validateMemoryRead, type MemoryScreen } from "../src/hub/read-tools.ts";
import { withoutPii } from "../src/hub/memory-policy.ts";
import { currentRouting } from "../src/hub/routing.ts";
import { Capture } from "../src/memory/capture.ts";
import type { MemoryClient } from "../src/memory/client.ts";
import { TASK_TOOLS, profileTaskTools } from "../src/hub/hub-tools.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const pass: MemoryScreen = rows => rows;
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ahub-memory-read-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const store = new MemoryStore({ home });
  cleanup.push(() => store.close());
  const add = (v: Partial<NoteInput> = {}) => store.note({ op: "note", project: "agent-hub", tier: "long", kind: "decision", scope: "project", text: "safe note", source: "hub", peer: "codex", about: [], ...v });
  const read = (op: string, a: Record<string, unknown>, screen = pass) => memoryRead(store, "agent-hub", screen, `hub_memory_${op}`, a);
  return { store, add, read };
}

test("memory read validates UTF-8 limits and unknown fields before storage or screening", () => {
  let screens = 0;
  const screen: MemoryScreen = rows => { screens++; return rows; };
  for (const [op, args] of [
    ["search", { query: "가".repeat(67) }], ["search", { query: "ok", limit: 21 }], ["search", { query: "ok", project: "other" }],
    ["show", { ids: ["가".repeat(22)] }], ["show", { ids: Array(9).fill("abcdef") }], ["show", { ids: ["short"] }],
    ["graph", { starts: ["가".repeat(67)] }], ["graph", { starts: Array(9).fill("path:a") }], ["graph", { starts: ["a"], hops: 3 }],
    ["graph", { starts: ["a"], limit: 121 }],
  ] as const) expect(() => memoryRead(undefined, "agent-hub", screen, `hub_memory_${op}`, args)).toThrow("memory read unavailable");
  expect(screens).toBe(0);
  expect(() => validateMemoryRead("hub_memory_search", { query: "가".repeat(66) + "ab" })).not.toThrow();
});

test("memory reads screen query, complete records and provenance before visible-only counts", () => {
  const { add, read } = fixture();
  const own = add({ kind: "fail", text: "safe fail" });
  const shared = add({ project: "other", scope: "shared", text: "shared contract", kind: "contract" });
  const other = add({ project: "other", text: "other project private" });
  const hidden = add({ text: "900101-1234567" });
  add({ text: "ordinary text", peer: "900101-1234567" });
  const routing = currentRouting(import.meta.dir);
  const screen: MemoryScreen = rows => withoutPii(rows, routing, import.meta.dir);
  const output = read("search", { query: "", limit: 1 }, screen);
  const parsed = JSON.parse(output);
  expect(parsed.lines).toHaveLength(1);
  expect(parsed.lines[0]).toContain(own);
  expect(parsed.truncated).toBe(1);
  expect(output).not.toContain(hidden);
  expect(read("show", { ids: [shared] }, screen)).toContain(shared);
  const unknown = read("show", { ids: ["000000"] }, screen);
  expect(read("show", { ids: [other] }, screen)).toBe(unknown);
  expect(read("show", { ids: [hidden] }, screen)).toBe(unknown);
  expect(() => read("search", { query: "900101-1234567" }, screen)).toThrow("memory read unavailable");
});

test("memory show resolves visible prefixes and original promoted ids with identical ambiguity refusal", () => {
  const { store, add, read } = fixture();
  const original = add({ tier: "short", text: "keep this contract", kind: "contract" });
  const promoted = store.promote(original, "user")!;
  expect(read("show", { ids: [original] })).toContain(promoted);
  expect(read("show", { ids: [promoted.slice(0, 8)] })).toContain(promoted);
  const base = store.list({ project: "agent-hub" })[0]!;
  const rows: View[] = [{ ...base, id: "abcdef111111" }, { ...base, id: "abcdef222222" }];
  const fake = { list: () => rows } as unknown as MemoryStore;
  expect(memoryRead(fake, "agent-hub", pass, "hub_memory_show", { ids: ["abcdef"] })).toBe(read("show", { ids: ["unknown"] }));
  expect(memoryRead(fake, "agent-hub", pass, "hub_memory_show", { ids: ["abcdef111111"] })).toContain("abcdef111111");
});

test("memory result budgets include metadata, mark UTF-8 excerpts and preserve complete headers", () => {
  const { add, read } = fixture();
  const ids = Array.from({ length: 8 }, (_, i) => add({ title: `한글 ${i}`, text: "가나다 ".repeat(950), kind: i === 0 ? "fail" : "contract" }));
  for (const [op, args, cap] of [["search", { query: "", limit: 20 }, 4096], ["show", { ids }, 8192]] as const) {
    const output = read(op, args);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(cap);
    expect(output).not.toContain("�");
    expect(output).toContain("[incomplete]");
    const parsed = JSON.parse(output);
    expect(parsed.lines[0]).toMatch(/mem:[a-f0-9]{32} (fail|contract) long source:hub peer:codex project:agent-hub at:/);
    expect(parsed.truncated).toBe(ids.length - parsed.lines.length);
    expect(read(op, args)).toBe(output);
  }
});

test("all over-budget eligible headers yield an empty bounded result with the visible truncated count", () => {
  const { store, add } = fixture(); add();
  const row = store.list()[0]!;
  const fake = { list: () => Array.from({ length: 5 }, (_, i) => ({ ...row, id: String(i).repeat(32), peer: "가".repeat(5000) })) } as unknown as MemoryStore;
  const output = memoryRead(fake, "agent-hub", pass, "hub_memory_search", { query: "" });
  expect(JSON.parse(output)).toEqual({ lines: [], truncated: 5 });
});

test("dense graph caps nodes, edges and bytes, orders fails first and never returns dangling edges", () => {
  const { add, read } = fixture();
  for (let i = 0; i < 145; i++) add({ text: `visible ${i}`, kind: i === 0 ? "fail" : "decision", about: Array.from({ length: 20 }, (_, j) => `path:src/file-${j}.ts`) });
  const hidden = add({ text: "withheld", about: ["path:src/file-0.ts"] });
  const screen: MemoryScreen = rows => rows.filter(v => !v.text.includes("withheld"));
  const output = read("graph", { starts: ["path:src/file-0.ts"], hops: 2, limit: 120 }, screen);
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(6144);
  expect(output).not.toContain(hidden);
  const graph = JSON.parse(output);
  expect(graph.nodes.length).toBeLessThanOrEqual(120);
  expect(graph.edges.length).toBeLessThanOrEqual(240);
  expect(graph.edges.length).toBeGreaterThan(0);
  expect(graph.nodes[0].kind).toBe("fail");
  const ids = new Set(graph.nodes.map((n: { id: string }) => n.id));
  expect(graph.edges.every((e: { from: string; to: string }) => ids.has(e.from) && ids.has(e.to))).toBe(true);
  expect(graph.truncated).toBeGreaterThan(0);
  expect(read("graph", { starts: ["path:src/file-0.ts"], hops: 2, limit: 120 }, screen)).toBe(output);
});

test("memory tools appear in all shared catalogs and never capture arguments or results", () => {
  const calls: unknown[] = [];
  const client = { request: (...args: unknown[]) => { calls.push(args); return Promise.resolve(); } } as unknown as MemoryClient;
  const capture = new Capture(client, { project: "agent-hub", cwd: import.meta.dir });
  capture.init("test-session", "prompt"); calls.length = 0;
  for (const name of ["hub_memory_search", "hub_memory_show", "hub_memory_graph"]) {
    expect(TASK_TOOLS.some(t => t.name === name)).toBe(true);
    expect(profileTaskTools("dev").some(t => t.name === name)).toBe(true);
    for (const tool of [name, `mcp__agent-hub__${name}`]) capture.observe({ tool, args: "private query", output: "private result", id: "call", paths: [] });
  }
  expect(calls).toEqual([]);
  capture.observe({ tool: "read", args: "{}", output: "safe result", id: "ordinary", paths: [] });
  expect(calls).toHaveLength(1);
});
