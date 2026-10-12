import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { boardColumns } from "../src/ui/task-board.ts";
import { taskProgress } from "../src/ui/task-progress.ts";
import { PEER_PALETTE } from "../src/ui/peer-palette.ts";

class Node {
  children: Node[] = []; attrs: Record<string, string> = {}; dataset: Record<string, string> = {};
  handlers = new Map<string, ((event: any) => unknown)[]>(); value = ""; checked = false; disabled = false; className = ""; id = ""; textContent = ""; draggable = false; title = ""; type = "";
  classList = { add: (_name: string) => {}, remove: (_name: string) => {} };
  constructor(readonly tag = "div") {}
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.children = nodes; this.textContent = ""; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(name: string, fn: (event: any) => unknown) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]); }
  emit(name: string, event: any = {}) { for (const fn of this.handlers.get(name) ?? []) fn(event); }
  set innerHTML(_value: string) { throw new Error("unsafe HTML rendering"); }
}
function page() {
  const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
  const source = html.slice(html.indexOf("let boardViewState ="), html.indexOf("function render(snapshot) {"));
  const nodes = new Map<string, Node>(), get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id)!; };
  get("task-lanes").value = "columns";
  const scope = { projectId: "project", instanceId: "instance", generation: 1 }, calls: any[] = [];
  const el = (tag: string, text?: unknown, cls = "") => { const node = new Node(tag); if (text !== undefined) node.textContent = String(text); node.className = cls; return node; };
  const elSource = html.match(/const el = [^\n]+/)![0];
  const api = runInNewContext(`let stopped=false,managerMode=true,snapshotValid=true; ${elSource} ${source}; ({draw:renderBoard,draggedCard})`, {
    location: { origin: "http://127.0.0.1:4000" }, context: () => ({ ...scope }), canMutate: () => true,
    document: { createElement: (tag: string) => new Node(tag) }, $, boardColumns, taskProgress, peerPalette: PEER_PALETTE, badge: (text: string) => el("span", text),
    renderTaskProgress: () => {}, renderTaskStage: (stage: { label: string }) => el("p", stage.label),
    empty: (target: Node, text: string) => target.append(el("p", text)),
    update: (id: string, _value: unknown, render: (node: Node) => void) => { get(id).replaceChildren(); render(get(id)); },
    peerOptions: (select: Node) => { select.value = ""; }, notice: () => {},
    action: async (payload: unknown) => { calls.push(payload); return true; },
  });
  function $(id: string) { return get(id); }
  const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)];
  const peers = { codex: { state: "idle", attached: true }, claude: { state: "busy", attached: true } };
  const snapshot = { projectId: scope.projectId, instanceId: scope.instanceId, boardCapabilities: { backlog: true }, boardLegend: [{ peer: "codex", state: "idle", wip: 1, permissionMode: "ask", activeTasks: [2] }], tasks: [
    { id: 1, state: "backlog", title: "[pii]", detail: "[pii]", class: "implement" },
    { id: 2, state: "proposed", title: "<img src=x onerror=alert(1)>", class: "implement", owner: "codex", urgent: true },
    { id: 3, state: "in_review", title: "review", class: "implement", owner: "claude", reviewer: "codex" },
    { id: 4, state: "approved", title: "done", class: "implement", owner: "codex" },
  ] };
  api.draw(snapshot, peers, Object.keys(peers));
  return { api, scope, calls, get, all, peers, snapshot };
}

test("board DOM renders five columns public cards and keyboard actions without flow dragging (#263)", () => {
  const { get, all, calls } = page(), nodes = all(get("tasks"));
  expect(nodes.filter(node => node.tag === "h3").map(node => node.textContent)).toEqual(["Backlog", "To Do", "In Progress", "Review / QA", "Done"]);
  expect(nodes.filter(node => node.tag === "article").map(node => node.draggable)).toEqual([true, true, false, false]);
  expect(nodes.some(node => node.textContent === "<img src=x onerror=alert(1)>")).toBe(false); // title includes its explicit task id, kept as text
  expect(nodes.some(node => node.textContent.includes("#2 <img src=x onerror=alert(1)>"))).toBe(true);
  const pull = nodes.find(node => node.textContent === "Pull into To Do")!; pull.emit("click");
  expect(calls).toEqual([{ action: "backlog_pull", id: 1 }]);
  const assigned = nodes.find(node => node.tag === "select")!; assigned.value = "claude";
  nodes.find(node => node.textContent === "Assign")!.emit("click");
  expect(calls[1]).toEqual({ action: "assign", id: 2, peer: "claude" });
  expect(all(get("task-legend")).some(node => node.textContent === "WIP 1 / permission ask")).toBe(true);
});

test("board drops reject stale project instance generation foreign origins and flow moves (#263)", () => {
  const { api, scope, get, all, calls } = page();
  const payload = { ...scope, origin: "http://127.0.0.1:4000", id: 2 };
  const event = (data: unknown) => ({ preventDefault() {}, dataTransfer: { getData: () => JSON.stringify(data) } });
  expect(api.draggedCard(event(payload))?.id).toBe(2);
  for (const changed of [{ projectId: "other" }, { instanceId: "other" }, { generation: 99 }, { origin: "http://127.0.0.1:4001" }, { id: [] }]) expect(api.draggedCard(event({ ...payload, ...changed }))).toBeNull();
  const target = all(get("task-legend")).find(node => node.handlers.has("drop"))!;
  target.emit("drop", event({ ...payload, id: 3 })); expect(calls).toEqual([]);
  target.emit("drop", event(payload)); expect(calls).toEqual([{ action: "assign", peer: "codex", id: 2 }]);
  const pull = all(get("tasks")).find(node => node.textContent === "Pull into To Do")!;
  scope.generation++; pull.emit("click"); target.emit("drop", event({ ...payload, generation: scope.generation }));
  expect(calls).toHaveLength(1);
});

test("older snapshots cannot silently offer a requested backlog task or expose unsupported pull controls (#263)", () => {
  const { api, snapshot, peers, get, all } = page();
  api.draw({ ...snapshot, boardCapabilities: undefined }, peers, Object.keys(peers));
  expect(get("backlog-proposal").disabled).toBe(true);
  expect(all(get("tasks")).some(node => node.textContent === "Pull into To Do")).toBe(false);
});


test("agent lane headings assign eligible tasks and retain the flow floor (#263)", () => {
  const { api, snapshot, peers, get, all, calls, scope } = page();
  get("task-lanes").value = "agents";
  api.draw(snapshot, peers, Object.keys(peers));
  const heading = all(get("tasks")).find(node => node.tag === "h3" && node.textContent === "claude")!;
  const event = (id: number) => ({ preventDefault() {}, dataTransfer: { getData: () => JSON.stringify({ ...scope, origin: "http://127.0.0.1:4000", id }) } });
  heading.emit("drop", event(3));
  expect(calls).toEqual([]);
  heading.emit("drop", event(2));
  expect(calls).toEqual([{ action: "assign", peer: "claude", id: 2 }]);
  const unassigned = all(get("tasks")).find(node => node.tag === "h3" && node.textContent === "Unassigned")!;
  expect(unassigned.handlers.has("drop")).toBe(false);
});
