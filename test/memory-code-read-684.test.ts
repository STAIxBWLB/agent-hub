import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, type NoteInput } from "@staix/agent-mem";
import { memoryRead, type MemoryScreen } from "../src/hub/read-tools.ts";
import { deriveMemoryCodeOverlay, unavailableMemoryCodeOverlay, type MemoryCodeOverlay, type MemoryCodeNode, type MemoryCodeEdge } from "../src/hub/memory-code-overlay.ts";
const HEAD = "a".repeat(40), SEED = "symbol:target@src/a.ts", NEAR = "symbol:caller@src/b.ts", PROJECT = "fixture";
const cleanup: Array<() => void> = [], pass: MemoryScreen = rows => rows;
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ahub-code-read-")); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const store = new MemoryStore({ home }); cleanup.push(() => store.close());
  const add = (extra: Partial<NoteInput> = {}) => store.note({ op: "note", project: PROJECT, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "authored memory", about: [], ...extra });
  const logs = () => ["log", "local"].flatMap(dir => readdirSync(join(store.dir, dir)).sort().map(file => readFileSync(join(store.dir, dir, file))));
  const read = (code?: MemoryCodeOverlay, limit = 60, screen = pass) => memoryRead(store, PROJECT, screen, "hub_memory_graph", { starts: [SEED], hops: 1, limit }, () => false, code);
  const derive = (name = "caller", noteText?: string) => deriveMemoryCodeOverlay([SEED], { context: () => ({ cwd: "/fixture", project: PROJECT, repo: "owner/repo" }), head: () => HEAD, valid: () => true, publicMetadataText: () => true, now: () => 0,
    neighbours: async (_repo, _head, selector, depth) => { expect(selector).toBe("src/a.ts:target"); expect(depth).toBe(1); return { state: "known", value: { callers: [{ name, path: "src/b.ts", kind: "fn", line: 1, ambiguous: false, change: "unknown" }], callees: [], countsFloor: true, hiddenAmbiguous: 0 } }; },
    related: (nodes, limit) => store.related(PROJECT, [...nodes], limit).map(note => ({ id: `mem:${note.id}`, line: noteText ?? note.text, kind: note.kind, about: note.about })),
  });
  return { store, add, logs, read, derive };
}
interface Output { nodes: Array<{ id: string; type: string; label: string; kind?: string; derived?: true; head?: string; codeNeighbour?: true }>; edges: Array<{ from: string; to: string; rel: string; derived?: true; head?: string }>; truncated: number; code?: { state: string; head?: string; truncated: boolean; countsFloor: boolean }; error?: string }
const parse = (raw: string) => JSON.parse(raw) as Output;
test("#367 production graph read composes SHA-stamped calls and authored neighbour fail notes without storing them", async () => {
  const f = fixture(), direct = f.add({ about: [SEED] }), fail = f.add({ kind: "fail", text: "avoid this caller failure", about: [NEAR] });
  const before = f.logs(), candidate = join(f.store.dir, "candidates.db"); writeFileSync(candidate, "candidate sentinel");
  const base = f.store.graph(PROJECT, SEED, 1, 200), overlay = await f.derive(), output = parse(f.read(overlay));
  expect(output.error).toBeUndefined(); expect(output.code).toEqual({ state: "known", head: HEAD, truncated: false, countsFloor: true });
  expect(output.edges).toContainEqual({ from: NEAR, to: SEED, rel: "calls", derived: true, head: HEAD });
  expect(output.nodes.find(node => node.id === NEAR)).toMatchObject({ derived: true, head: HEAD });
  expect(output.nodes.find(node => node.id === `mem:${fail}`)).toMatchObject({ kind: "fail", codeNeighbour: true });
  expect(output.nodes[0]?.id).toBe(`mem:${fail}`);
  expect(output.edges).toContainEqual({ from: `mem:${fail}`, to: NEAR, rel: "rules_out" });
  expect(output.nodes.some(node => node.id === `mem:${direct}`)).toBe(true);
  expect(f.store.graph(PROJECT, SEED, 1, 200)).toEqual(base); expect(f.logs()).toEqual(before); expect(readFileSync(candidate, "utf8")).toBe("candidate sentinel");
});
test("#367 unknown overlay preserves stored graph evidence and exposes neutral unknown coverage", () => {
  const f = fixture(); f.add({ kind: "fail", text: "stored fail", about: [SEED] });
  const baseline = parse(f.read()), before = f.logs(), output = parse(f.read(unavailableMemoryCodeOverlay()));
  expect(output.nodes).toEqual(baseline.nodes); expect(output.edges).toEqual(baseline.edges);
  expect(output.code).toEqual({ state: "unknown", truncated: false, countsFloor: false }); expect(f.logs()).toEqual(before);
});
test("#367 final graph screen withholds newly private neighbour metadata and the attached note", async () => {
  const f = fixture(), privateNode = "symbol:PRIVATE_MARKER@src/b.ts";
  const note = f.add({ kind: "fail", text: "previously public note", about: [privateNode] });
  const overlay = await f.derive("PRIVATE_MARKER"), before = f.logs();
  const screen: MemoryScreen = rows => rows.filter(row => !`${row.title ?? ""}\n${row.text}`.includes("PRIVATE_MARKER"));
  const output = f.read(overlay, 60, screen), parsed = parse(output);
  expect(parsed.error).toBeUndefined(); expect(output).not.toContain("PRIVATE_MARKER"); expect(output).not.toContain(note); expect(parsed.edges.some(edge => edge.derived)).toBe(false); expect(f.logs()).toEqual(before);
});
test("#367 current full note screening can hide a neighbour note while retaining public code calls", async () => {
  const f = fixture(), hidden = f.add({ kind: "fail", text: "LATE_NOTE_POLICY", about: [NEAR] });
  const overlay = await f.derive("caller", "safe historical excerpt");
  const screen: MemoryScreen = rows => rows.filter(row => !`${row.title ?? ""}\n${row.text}`.includes("LATE_NOTE_POLICY"));
  const output = f.read(overlay, 60, screen), parsed = parse(output);
  expect(parsed.error).toBeUndefined(); expect(output).not.toContain(hidden); expect(output).not.toContain("LATE_NOTE_POLICY");
  expect(parsed.edges).toContainEqual({ from: NEAR, to: SEED, rel: "calls", derived: true, head: HEAD });
});
test("#367 combined graph projection caps serialized UTF-8 bytes, nodes and edges after code metadata", () => {
  const f = fixture();
  for (let i = 0; i < 35; i++) f.add({ kind: "fail", text: `한글 \\" quoted ${i} ` + "가".repeat(100), about: [SEED] });
  const nodes: MemoryCodeNode[] = [SEED, ...Array.from({ length: 31 }, (_, index) => `symbol:N${index}@src/n.ts`)].map(id => ({ id, type: "symbol", label: '한글 "quoted" ' + id, derived: true, head: HEAD }));
  const edges: MemoryCodeEdge[] = nodes.flatMap(from => nodes.filter(to => to.id !== from.id).map(to => ({ from: from.id, to: to.id, rel: "calls", derived: true, head: HEAD })));
  const code: MemoryCodeOverlay = { state: "known", head: HEAD, nodes, edges, notes: [], queried: 1, unknown: 0, truncated: false, countsFloor: true };
  const before = f.logs();
  for (const limit of [9, 120]) {
    const raw = f.read(code, limit), output = parse(raw), kept = new Set(output.nodes.map(node => node.id));
    expect(output.error).toBeUndefined(); expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(6144); expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(raw.length);
    expect(output.nodes.length).toBeLessThanOrEqual(limit); expect(output.edges.length).toBeLessThanOrEqual(240); expect(output.truncated).toBeGreaterThan(0); expect(output.code?.head).toBe(HEAD);
    expect(output.edges.every(edge => kept.has(edge.from) && kept.has(edge.to))).toBe(true); expect(raw).not.toContain("�");
  }
  expect(f.logs()).toEqual(before);
});
test("#367 dense code relations retain bounded reachable edges instead of dropping the whole optional projection", () => {
  const f = fixture();
  const nodes: MemoryCodeNode[] = [SEED, ...Array.from({ length: 31 }, (_, index) => `symbol:N${index}@a.ts`)].map(id => ({ id, type: "symbol", label: id.slice(7), derived: true, head: HEAD }));
  const edges: MemoryCodeEdge[] = nodes.flatMap(from => nodes.filter(to => to.id !== from.id).map(to => ({ from: from.id, to: to.id, rel: "calls", derived: true, head: HEAD })));
  const code: MemoryCodeOverlay = { state: "known", head: HEAD, nodes, edges, notes: [], queried: 1, unknown: 0, truncated: false, countsFloor: true };
  const raw = f.read(code, 120), output = parse(raw), kept = new Set(output.nodes.map(node => node.id));
  expect(output.error).toBeUndefined(); expect(output.edges.length).toBeGreaterThan(0); expect(output.edges.length).toBeLessThanOrEqual(240); expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(6144); expect(output.truncated).toBeGreaterThan(0);
  expect(output.edges.every(edge => edge.derived === true && edge.head === HEAD && kept.has(edge.from) && kept.has(edge.to))).toBe(true);
});
