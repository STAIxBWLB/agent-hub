import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { contrast } from "../src/ui/peer-palette.ts";
const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
const HEAD = "a".repeat(40), SEED = "symbol:target@a.ts", NEAR = "symbol:caller@b.ts", ID = "1".repeat(32);
class Node {
  children: Node[] = []; textContent = ""; className = ""; type = ""; value = ""; checked = false; disabled = false; dataset: Record<string, string> = {}; attrs: Record<string, string> = {}; handlers: Record<string, (event?: unknown) => void> = {};
  constructor(readonly tag = "div") {}
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.children = [...nodes]; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(key: string, handler: (event?: unknown) => void) { this.handlers[key] = handler; }
  get options() { return this.children; }
  text(): string { return [this.textContent, ...this.children.map(node => node.text())].join(" "); }
  all(): Node[] { return [this, ...this.children.flatMap(node => node.all())]; }
}
function rig() {
  const nodes = new Map<string, Node>(), get = (id: string) => { let node = nodes.get(id); if (!node) { node = new Node(id); nodes.set(id, node); } return node; };
  const el = (tag: string, text?: unknown, cls?: string) => { const node = new Node(tag); if (text !== undefined) node.textContent = String(text); if (cls) node.className = cls; return node; };
  const context = { $: get, el, viewGeneration: 0, currentView: "memory", document: { hidden: false, createElementNS: (_ns: string, tag: string) => new Node(tag) }, time: (at: string) => at,
    badge: (text: string) => el("span", text), empty: (target: Node, text: string) => target.append(el("p", text)),
    update: (id: string, _data: unknown, render: (target: Node) => void) => { get(id).replaceChildren(); render(get(id)); },
    keyedStart: () => Object.assign((_id: string, _signature: string, make: () => Node) => make(), { end() {} }),
  };
  const start = html.indexOf("const memoryQuery ="), end = html.indexOf("let memorySearch;", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const api = runInNewContext(`${html.slice(start, end)};({memoryQuery,memoryInput,memoryPresentation,memoryCodeToggle,renderMemory,selectMemoryNode})`, context) as {
    memoryQuery: { node: string; codeNeighbours: boolean; tier: string; kind: string; peer: string }; memoryInput(): Record<string, unknown>;
    memoryPresentation(memory: unknown): { graph: { nodes: any[]; edges: any[] }; entries: any[]; noteIds: string[]; coverage: string };
    memoryCodeToggle(): void; renderMemory(memory: unknown): void; selectMemoryNode(node: string): void;
  };
  api.memoryInput();
  return { api, get, context };
}
function fixture() {
  return { node: SEED, tier: "long", counts: { long: 1, short: 0 }, peers: [], machines: [], machine: "local", entries: [{ id: ID, title: "Existing failure", text: "authored note", kind: "fail", peer: "person", at: "2026-10-24", machine: "local" }],
    graph: { nodes: [{ id: SEED, type: "symbol", label: "target" }, { id: `mem:${ID}`, type: "memory", label: "Existing failure", kind: "fail" }], edges: [{ from: `mem:${ID}`, to: SEED, rel: "rules_out" }] },
    code: { state: "known", head: HEAD, truncated: false, countsFloor: true, nodes: [SEED, NEAR].map(id => ({ id, type: "symbol", label: id.slice(7), derived: true, head: HEAD })), edges: [{ from: NEAR, to: SEED, rel: "calls", derived: true, head: HEAD }], notes: [{ id: `mem:${ID}`, line: "existing failure", kind: "fail", tier: "long", peer: "person", machine: "local", about: [NEAR] }] } };
}
function enable(api: ReturnType<typeof rig>["api"]) { api.memoryQuery.node = SEED; api.memoryQuery.codeNeighbours = true; }
test("#367 UI code-neighbour toggle is opt-in, symbol-only and reset on project change", () => {
  const { api, get, context } = rig();
  expect(api.memoryInput().codeNeighbours).toBeUndefined(); api.memoryCodeToggle(); expect(get("memory-code-neighbours").disabled).toBe(true); expect(get("memory-code-help").text()).toContain("Select a symbol");
  api.memoryQuery.node = SEED; api.memoryCodeToggle(); expect(get("memory-code-neighbours").disabled).toBe(false);
  get("memory-code-neighbours").checked = true; get("memory-code-neighbours").handlers.change!(); expect(api.memoryInput().codeNeighbours).toBe(true);
  api.memoryQuery.node = `mem:${ID}`; expect(api.memoryInput().codeNeighbours).toBeUndefined(); api.memoryCodeToggle(); expect(get("memory-code-neighbours").disabled).toBe(true);
  context.viewGeneration++; expect(api.memoryInput().codeNeighbours).toBeUndefined(); expect(api.memoryQuery.codeNeighbours).toBe(false);
  expect(html).toContain('aria-describedby="memory-code-help"'); expect(html).toContain('type="checkbox"');
});
test("#367 opt-out and stale-selection snapshots preserve the stored graph and list exactly", () => {
  const { api } = rig(), memory = fixture(); api.memoryQuery.node = SEED;
  expect(api.memoryPresentation(memory).graph).toBe(memory.graph); expect(api.memoryPresentation(memory).entries).toBe(memory.entries);
  enable(api); api.memoryQuery.node = "symbol:another@other.ts";
  expect(api.memoryPresentation(memory)).toMatchObject({ graph: memory.graph, entries: memory.entries, noteIds: [], coverage: "" });
});
test("#367 derived call edges are dashed and SHA-labelled; authored note relations stay solid", () => {
  const { api, get } = rig(), memory = fixture(); enable(api); api.renderMemory(memory);
  const graph = get("memory-graph"), lines = graph.all().filter(node => node.tag === "line"), derived = lines.find(node => node.attrs.class?.includes("derived"))!;
  expect(derived.attrs.class).toBe("medge calls derived"); expect(derived.text()).toContain(HEAD);
  expect(lines.filter(node => node.attrs.class === "medge rules_out")).toHaveLength(2);
  expect(graph.text()).toContain(`calls ${SEED} (derived at ${HEAD})`); expect(graph.text()).toContain("lower-bound counts");
  expect(graph.all().find(node => node.attrs.class?.includes("code-neighbour-note"))).toBeDefined();
  expect(get("memory-list").all().find(node => node.className.includes("code-neighbour-note"))).toBeDefined();
  const callNode = graph.all().find(node => node.attrs["aria-label"] === "symbol caller@b.ts")!; expect(callNode.attrs.tabindex).toBe("0"); callNode.handlers.click!(); expect(api.memoryQuery.node).toBe(NEAR);
});
test("#367 fallback neighbour notes use literal text and existing about/rules_out semantics", () => {
  const { api, get } = rig(), memory = fixture(); enable(api);
  memory.code.notes.push({ id: `mem:${"2".repeat(32)}`, line: '<img src=x onerror="throw 1">', kind: "finding", tier: "long", peer: "person", machine: "local", about: [NEAR] });
  api.renderMemory(memory);
  const list = get("memory-list"); expect(list.text()).toContain('<img src=x onerror="throw 1">'); expect(list.all().some(node => node.tag === "img")).toBe(false); expect(list.text()).toContain("via code neighbour at " + HEAD);
  const presentation = api.memoryPresentation(memory);
  expect(presentation.entries[0]?.kind).toBe("fail"); expect(presentation.graph.edges.find(edge => edge.from === `mem:${"2".repeat(32)}`)).toEqual({ from: `mem:${"2".repeat(32)}`, to: NEAR, rel: "about" });
  expect(presentation.graph.nodes.find(node => node.id === `mem:${"2".repeat(32)}`)?.head).toBeUndefined();
});
test("#367 unknown without valid SHA renders no supplied private names; partial coverage is explicit", () => {
  const { api, get } = rig(), memory = fixture(); enable(api);
  const privatePayload = { ...memory, code: { ...memory.code, state: "unknown", head: undefined, nodes: [{ id: "symbol:PRIVATE_MARKER@private.ts", label: "PRIVATE_MARKER", type: "symbol" }], notes: [{ id: `mem:${"3".repeat(32)}`, line: "PRIVATE_MARKER", about: [NEAR] }] } };
  api.renderMemory(privatePayload); expect(get("memory-graph").text()).toContain("unknown (no current code facts)"); expect(get("memory-graph").text()).not.toContain("PRIVATE_MARKER"); expect(get("memory-list").text()).not.toContain("PRIVATE_MARKER");
  memory.code.state = "unknown"; memory.code.truncated = true; api.renderMemory(memory);
  expect(get("memory-graph").text()).toContain("unknown; truncated; lower-bound counts at " + HEAD); expect(get("memory-graph").text()).toContain(NEAR);
});
test("#367 combined display respects node200/list50 caps, deduplication and kept endpoints", () => {
  const { api } = rig(), memory = fixture(); enable(api);
  memory.graph.nodes.push(...Array.from({ length: 199 }, (_, i) => ({ id: `path:file${i}.ts`, type: "path", label: `file${i}` })));
  memory.entries.push(...Array.from({ length: 50 }, (_, i) => ({ id: String(i + 5).padStart(32, "0"), title: "ordinary", text: "ordinary note", kind: "finding", peer: "person", at: "2026-10-24", machine: "local" })));
  memory.code.edges.push(memory.code.edges[0]!);
  const out = api.memoryPresentation(memory), ids = new Set(out.graph.nodes.map(node => node.id));
  expect(out.graph.nodes).toHaveLength(200); expect(out.entries).toHaveLength(50); expect(out.entries[0]?.kind).toBe("fail"); expect(out.graph.edges.filter(edge => edge.rel === "calls")).toHaveLength(1); expect(out.graph.edges.every(edge => ids.has(edge.from) && ids.has(edge.to))).toBe(true); expect(out.coverage).toContain("display truncated:");
});
test("#367 derived edges and highlights use theme tokens with phone-friendly wrapping", () => {
  expect(html).toContain('.medge.derived{stroke:var(--ink);stroke-dasharray:6 4}'); expect(html).toContain('overflow-wrap:anywhere'); expect(html).toContain('flex:1 1 210px;min-height:44px');
  for (const selector of [":root{", ':root[data-theme="dark"]{']) {
    const start = html.indexOf(selector), block = html.slice(start, html.indexOf("}", start));
    const colour = (key: string) => block.match(new RegExp(`--${key}:(#[a-f0-9]+)`))![1]!;
    expect(contrast(colour("ink"), colour("panel-soft"))).toBeGreaterThanOrEqual(3);
    expect(contrast(colour("focus"), colour("panel-soft"))).toBeGreaterThanOrEqual(3);
  }
});

test("#367 hidden or non-Memory views request no code work and note filters are respected", () => {
  const { api, context } = rig(), memory = fixture(); enable(api);
  context.currentView = "board"; expect(api.memoryInput().codeNeighbours).toBeUndefined();
  context.currentView = "memory"; context.document.hidden = true; expect(api.memoryInput().codeNeighbours).toBeUndefined();
  context.document.hidden = false; expect(api.memoryInput().codeNeighbours).toBe(true);
  api.memoryQuery.kind = "decision"; expect(api.memoryPresentation(memory).noteIds).toEqual([]);
  api.memoryQuery.kind = ""; api.memoryQuery.peer = "someone-else"; expect(api.memoryPresentation(memory).noteIds).toEqual([]);
  api.memoryQuery.peer = ""; api.memoryQuery.tier = "short"; expect(api.memoryPresentation(memory).noteIds).toEqual([]);
  api.memoryQuery.tier = "long"; expect(api.memoryPresentation(memory).noteIds).toContain(`mem:${ID}`);
  api.selectMemoryNode(`mem:${ID}`); expect(api.memoryQuery.codeNeighbours).toBe(false);
});
