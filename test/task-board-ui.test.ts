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
  getAttribute(key: string) { return this.attrs[key] ?? null; }
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
  const api = runInNewContext(`let stopped=false,managerMode=true,snapshotValid=true;const taskRows=new Map(),officeCards=new Map(); ${elSource} ${source}; ({draw:renderBoard,draggedCard})`, {
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


test("release UI keeps public ids and invalidates stale date edits until reload (#263)", () => {
  const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
  const source = html.slice(html.indexOf("let planningEdit ="), html.indexOf("function peerMark("));
  const nodes = new Map<string, Node>(), get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id)!; };
  const release = { id: 1, name: "[withheld]", goal: "safe", state: "planning", revision: 0 };
  const state = { snapshot: { tasks: [], releases: [release], planningCapabilities: { enabled: true } } }, calls: Record<string, unknown>[] = [];
  get("release-edit").value = "1";
  const el = (_tag: string, text?: string) => { const node = new Node(); node.textContent = text ?? ""; return node; };
  const api = runInNewContext(`const $=get;let boardViewState=state;${source};({load:loadReleasePlanning,render:renderPlanning,edit:()=>releaseEdit})`, {
    get, state, el, badge: (text: string) => el("span", text), boardContext: () => ({ projectId: "a" }), sameBoardContext: () => true,
    update: (id: string, _value: unknown, render: (node: Node) => void) => render(get(id)), empty: () => {},
    boardButton: (_text: string, payload: Record<string, unknown>) => { calls.push(payload); return new Node(); },
  });
  api.load(); expect(api.edit()).toMatchObject({ id: 1, revision: 0 }); expect(api.edit()).not.toHaveProperty("name");
  state.snapshot.releases = [{ ...release, revision: 1 }]; api.render(state.snapshot);
  expect(api.edit()).toBeNull(); expect(get("release-version").textContent).toContain("Reload");
  expect(calls).toEqual([{ action: "release_change", id: 1, revision: 1, fields: { state: "active" } }, { action: "release_change", id: 1, revision: 1, fields: { state: "dropped" } }]);
  api.load(); expect(api.edit()).toMatchObject({ id: 1, revision: 1 });
});

test("project reset clears release creation draft before switching projects (#263)", () => {
  const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
  const source = html.slice(html.indexOf("function resetView("), html.indexOf("function projectName("));
  const nodes = new Map<string, Node>(), get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id)!; };
  get("release-name").value="project-a";get("release-goal").value="old goal";get("release-order").value="7";
  runInNewContext(`let selectedProjectId='a',selectedInstanceId='old',snapshotValid=true,cursor=1,eventCount=1,viewGeneration=0,streamFilter='',draftChoicesPending=false,officePrev=null,officeScene=null,lastSnapshot={};const officeDesks=new Map(),officeCards=new Map(),signatures=new Map();const managerMode=true,$=get;const saveDraft=()=>{},restoreDraft=()=>{},syncMutationControls=()=>{},peerOptions=()=>{},notice=()=>{},empty=(node,text)=>{node.textContent=text};${source};resetView('b','next');`, { get });
  expect(get("release-name").value).toBe("");expect(get("release-goal").value).toBe("");expect(get("release-order").value).toBe("0");
});

test("WIP pull controls require an explicit capability and carry the task revision (#263)", () => {
  const {api,get,all,calls,peers,snapshot}=page();
  api.draw({...snapshot,planningCapabilities:{enabled:true}},peers,Object.keys(peers));
  expect(all(get("tasks")).filter(node=>node.tag==="button"&&node.textContent==="Pull within WIP")).toHaveLength(0);
  api.draw({...snapshot,planningCapabilities:{enabled:true,wipPull:true},tasks:snapshot.tasks.map(task=>({...task,planningRevision:7}))},peers,Object.keys(peers));
  const button=all(get("tasks")).find(node=>node.tag==="button"&&node.textContent==="Pull within WIP");expect(button).toBeDefined();button!.emit("click");
  expect(calls.at(-1)).toMatchObject({action:"planner_pull",id:1,revision:7});
});


test("planning date editors retain original UTC precision and parse changed local values (#263)", () => {
  const html=readFileSync(new URL("../src/ui/index.html",import.meta.url),"utf8"),source=html.slice(html.indexOf("const loadedPlanningDates ="),html.indexOf("const dateText ="));
  const nodes=new Map<string,Node>(),get=(id:string)=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id)!;};
  const api=runInNewContext(`const $=get;${source};({load:loadPlanningDate,read:plannedDateInput,format:localDateInput})`,{get});
  for(const stamp of [100,200,Date.UTC(2026,10,1,6,30,0,123),8_640_000_000_000_000]){
    api.load("due",stamp);expect(api.read("due")).toBe(stamp);expect(get("due").value).toMatch(/\.\d{3}$/);
  }
  api.load("due",100);get("due").value="2026-10-12T12:30:45.123";expect(api.read("due")).toBe(new Date(get("due").value).getTime());
  get("due").value="";expect(api.read("due")).toBeNull();
  api.load("due",null);expect(api.read("due")).toBeNull();
  // A simulated repeated wall hour parses to its first occurrence; the loaded second occurrence must survive.
  class AmbiguousDate extends Date {
    constructor(value:number|string){super(typeof value==="string" ? Date.parse(value+"Z")-3_600_000 : value);}
    getFullYear(){return this.getUTCFullYear();}getMonth(){return this.getUTCMonth();}getDate(){return this.getUTCDate();}
    getHours(){const hour=this.getUTCHours();return hour===5 ? 6 : hour;}getMinutes(){return this.getUTCMinutes();}getSeconds(){return this.getUTCSeconds();}
  }
  const repeated=runInNewContext(`const $=get;${source};({load:loadPlanningDate,read:plannedDateInput})`,{get,Date:AmbiguousDate});
  const secondOccurrence=Date.UTC(2026,10,1,6,30,0,123);repeated.load("due",secondOccurrence);expect(repeated.read("due")).toBe(secondOccurrence);
});


test("redacted release options retain distinguishable public ids (#263)", () => {
  const html=readFileSync(new URL("../src/ui/index.html",import.meta.url),"utf8"),source=html.slice(html.indexOf("let planningEdit ="),html.indexOf("function peerMark("));
  const nodes=new Map<string,Node>(),get=(id:string)=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id)!;};
  const snapshot={tasks:[],releases:[{id:1,name:"[withheld]",goal:"safe",state:"planning",revision:0},{id:2,name:"[withheld]",goal:"safe",state:"planning",revision:0}],planningCapabilities:{enabled:true}};
  const el=(_tag:string,text?:string)=>{const node=new Node();node.textContent=text??"";return node;};
  const api=runInNewContext(`const $=get;let boardViewState={snapshot};${source};({render:renderPlanning})`,{get,snapshot,el,badge:(text:string)=>el("span",text),boardContext:()=>({projectId:"a"}),sameBoardContext:()=>true,update:()=>{},empty:()=>{},boardButton:()=>new Node()});
  api.render(snapshot);
  for(const id of ["task-release-filter","planning-release","release-edit"])expect(get(id).children.slice(1).map(node=>[node.value,node.textContent])).toEqual([["1","#1 [withheld]"],["2","#2 [withheld]"]]);
});


test("task cards show public release membership and accessible identity (#263)",()=>{
 const {api,get,all,peers,snapshot}=page();
 api.draw({...snapshot,releases:[{id:2,name:"[withheld]"}],tasks:snapshot.tasks.map(task=>({...task,release:2}))},peers,Object.keys(peers));
 const card=all(get("tasks")).find(node=>node.tag==="article")!;expect(all(card).some(node=>node.textContent==="Release #2 [withheld]")).toBe(true);expect(card.attrs['aria-label']).toContain("Release #2 [withheld]");
});


test("board task guidance remains visible on a public PII stub without granting actions (#295)",()=>{
 const {api,get,all,peers,snapshot}=page();api.draw({...snapshot,tasks:[{id:1,state:"backlog",title:"[pii]",detail:"[pii]",class:"implement",role:"backend-engineer"}]},peers,Object.keys(peers));
 expect(all(get("tasks")).some(node=>node.textContent==="Task guidance: backend-engineer (grants no authority)")).toBe(true);expect(all(get("tasks")).filter(node=>node.tag==="button"&&node.textContent==="Assign")).toHaveLength(0);
});

test("task card accessible name announces catalog guidance",()=>{
 const {api,snapshot,peers,get,all}=page();const task={...snapshot.tasks[0]!,role:"backend-engineer"};api.draw({...snapshot,tasks:[task]},peers,Object.keys(peers));
 const card=all(get("tasks")).find(node=>node.tag==="article");expect(card?.getAttribute("aria-label")).toContain("Task guidance: backend-engineer (grants no authority)");
});

test("release audit previews disclose exact totals when IDs are bounded", () => {
  const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
  const source = html.slice(html.indexOf("let planningEdit ="), html.indexOf("function peerMark("));
  const nodes = new Map<string, Node>(), get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id)!; };
  const snapshot = { tasks: [], releases: [{ id: 1, name: "phase", goal: "safe", state: "planning", revision: 0, afterCut: [1, 2], afterCutCount: 40, afterCutUnknown: [3], afterCutUnknownCount: 50 }], planningCapabilities: { enabled: true } };
  const el = (_tag: string, text?: string) => { const node = new Node(); node.textContent = text ?? ""; return node; };
  const api = runInNewContext(`const $=get;let boardViewState={snapshot};${source};({render:renderPlanning})`, { get, snapshot, el, badge: (text: string) => el("span", text), boardContext: () => ({ projectId: "a" }), sameBoardContext: () => true, update: (id: string, _value: unknown, render: (node: Node) => void) => render(get(id)), empty: () => {}, boardButton: () => new Node() });
  api.render(snapshot);
  const text = get("releases").children.flatMap(row => row.children.map(node => node.textContent)).join("\n");
  expect(text).toContain("Approved after cut outside this release: #1, #2 (showing 2 of 40)");
  expect(text).toContain("Timing relative to release cut unknown: #3 (showing 1 of 50)");
});


test("release blocked counts refresh when an outside prerequisite changes", () => {
  const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
  const source = html.slice(html.indexOf("let planningEdit ="), html.indexOf("function peerMark("));
  const updateSource = html.match(/^function update\(.*$/m)![0];
  const nodes = new Map<string, Node>(), get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id)!; };
  const own = { id: 1, state: "proposed", title: "own", deps: [2] }, outside = { id: 2, state: "in_progress", title: "dependency" };
  const snapshot = { tasks: [own, outside], releases: [{ id: 1, name: "phase", goal: "safe", state: "planning", revision: 0, tasks: [own], afterCut: [], afterCutUnknown: [] }], planningCapabilities: { enabled: true } };
  const el = (_tag: string, text?: string) => { const node = new Node(); node.textContent = text ?? ""; return node; };
  const api = runInNewContext(`const $=get;const signatures=new Map();let boardViewState={snapshot};${updateSource}\n${source};({render:renderPlanning})`, { get, snapshot, el, badge: (text: string) => el("span", text), boardContext: () => ({ projectId: "a" }), sameBoardContext: () => true, empty: () => {}, boardButton: () => new Node() });
  const text = () => get("releases").children.flatMap(row => row.children.map(node => node.textContent)).join("\n");
  api.render(snapshot); expect(text()).toContain("1 remaining of 1 / 1 blocked");
  api.render({ ...snapshot, tasks: [own, { ...outside, state: "approved" }] });
  expect(text()).toContain("1 remaining of 1 / 0 blocked");
});
