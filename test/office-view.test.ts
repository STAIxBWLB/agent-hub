import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { officeModel } from "../src/ui/office-model.ts";
import { taskProgress } from "../src/ui/task-progress.ts";
import { startDashboard } from "../src/hub/ui.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); });

const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
const scene = html.slice(html.indexOf("// office-scene-begin"), html.indexOf("// office-scene-end"));

class Node {
  children: Node[] = [];
  textContent = "";
  className = "";
  tag = "";
  attrs: Record<string, string> = {};
  listeners: Record<string, ((event?: unknown) => void)[]> = {};
  dataset: Record<string, string> = {};
  hidden = false;
  value = "";
  checked = false;
  clientWidth = 1200;
  replacements = 0;
  scrolled = 0;
  scrollTop = 0;
  scrollHeight = 0;
  tabIndex = -1;
  classes = new Set<string>();
  classList = {
    add: (name: string) => { this.classes.add(name); },
    remove: (name: string) => { this.classes.delete(name); },
    toggle: (name: string, force?: boolean) => { const on = force ?? !this.classes.has(name); if (on) this.classes.add(name); else this.classes.delete(name); },
    contains: (name: string) => this.classes.has(name),
  };
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.children = nodes; this.replacements++; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(name: string, listener: (event?: unknown) => void) { (this.listeners[name] ??= []).push(listener); }
  fire(name: string, event: unknown = { preventDefault() {}, key: "" }) { for (const listener of this.listeners[name] ?? []) listener(event); }
  scrollIntoView() { this.scrolled++; }
  walk(visit: (node: Node) => void): void { visit(this); for (const child of this.children) child.walk(visit); }
  findAll(predicate: (node: Node) => boolean): Node[] { const found: Node[] = []; this.walk((node) => { if (predicate(node)) found.push(node); }); return found; }
  text(): string { return [this.textContent, ...this.children.map((node) => node.text())].join(" "); }
}

const snapshot = {
  status: {
    peers: {
      claude: { state: "idle", queued: 0 },
      codex: { state: "busy", queued: 1 },
      kimi: { state: "paused", paused: "quota exhausted", queued: 0 },
    },
  },
  tasks: [
    { id: 2, title: "ready task", class: "test", state: "proposed", deps: [] },
    { id: 4, title: "build feature", class: "implement", state: "in_progress", owner: "codex", deps: [] },
    { id: 5, title: "review me", class: "review", state: "in_review", owner: "codex", reviewer: "claude", deps: [] },
  ],
  permissions: [] as { peer: string }[],
  budget: {},
  events: [] as unknown[],
};

/** Runs the real scene block and the real render() against a counting fake document. */
function startOfficeRuntime(view: () => string) {
  const renderSlice = html.slice(html.indexOf("function render(snapshot)"), html.indexOf("async function poll("));
  const nodes = new Map<string, Node>();
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id)!; };
  const el = (tag: string, text?: unknown, cls?: string) => { const node = new Node(); node.tag = tag; if (text !== undefined) node.textContent = String(text); node.className = cls ?? ""; return node; };
  const context = {
    get, el, officeModel, taskProgress,
    officeView: { get: view, set: () => {} },
    document: { createElement: () => new Node(), createElementNS: () => new Node() },
  };
  const api = runInNewContext(`
    let stopped=false, managerMode=false, selectedProjectId='', selectedInstanceId='', snapshotValid=true, viewGeneration=0, lastSnapshot=null, eventCount=0, cursor=0, draftChoicesPending=false, officePrev=null;
    const pendingButtons=new WeakSet(), pendingStarts=new Map(), signatures=new Map();
    const peerRows=new Map(), taskRows=new Map(), officeDesks=new Map(), officeCards=new Map();
    const $=get;
    const update=(id,data,render)=>{const signature=JSON.stringify(data);if(signatures.get(id)===signature)return;signatures.set(id,signature);const target=$(id);target.replaceChildren();render(target);};
    const empty=(target,text)=>target.append(el('p',text));
    const badge=(text)=>el('span',text),dot=()=>el('span'),peerDot={},taskBadge={};
    const button=(text)=>{const node=el('button',text);node.type='button';return node;};
    const notice=()=>{},syncStarts=()=>{},renderStarts=()=>{},renderTaskProgress=()=>{},renderApprovals=()=>{},renderBench=()=>{},renderSettings=()=>{},renderTaskStage=()=>el('div'),peerOptions=()=>{},restoreDraft=()=>{},refreshRelativeTimes=()=>{},refreshStreamEmpty=()=>{},applyStreamFilter=()=>{},syncMutationControls=()=>{};
    const time=()=>'',rel=()=>'soon';
    const action=async()=>false;
    ${scene}
    ${renderSlice}
    ({
      draw(snap){ lastSnapshot=snap; render(snap); },
      filter(state){ officeFilter(state); },
      maps: { peerRows, taskRows, officeDesks, officeCards },
    })`, context);
  return { api, get };
}

test("the served page injects the shared office model and stays within the CSP rules", async () => {
  const ui = startDashboard({ snapshot: () => ({}), action: () => ({}) });
  cleanup.push(ui.stop);
  const response = await fetch(ui.origin);
  const served = await response.text();
  const model = served.match(/const officeModel = ([\s\S]*?);\nconst officeView/)?.[1];
  expect(model).toBeDefined();
  const browserModel = runInNewContext("(" + model + ")");
  const scene = JSON.parse(JSON.stringify(browserModel(snapshot, null, { cols: 2 })));
  expect(scene).toEqual(JSON.parse(JSON.stringify(officeModel(snapshot, null, { cols: 2 }))));
  // The shell stays free of anything the CSP forbids, with the scene included.
  expect(served).not.toMatch(/\sstyle="/);
  expect(served).not.toMatch(/\son[a-z]+="/i);
  expect(served).not.toContain("data:");
  expect(served).not.toContain("innerHTML");
  const csp = response.headers.get("content-security-policy")!;
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).not.toContain("img-src");
  expect(csp).not.toContain("unsafe-inline");
  // Off is the default in the markup; Flat is the only other choice in this phase.
  expect(served).toContain('<section id="office-section" aria-labelledby="office-title" hidden>');
  const control = served.match(/<select id="office-view">([\s\S]*?)<\/select>/)![1]!;
  expect([...control.matchAll(/value="(\w+)"/g)].map((match) => match[1])).toEqual(["off", "flat"]);
});

test("the scene code has no timer, frame loop, request, action or colour literal", () => {
  expect(scene).toContain("createElementNS");
  for (const forbidden of ["setInterval", "requestAnimationFrame", "post(", "action(", "fetch(", "innerHTML"]) expect(scene).not.toContain(forbidden);
  expect(scene).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(scene).not.toMatch(/rgb\(|fill:|stroke:|style=/);
});

test("the office view choice persists in the agent-hub-office cookie with the theme cookie's terms", () => {
  const start = html.indexOf("const officeView = (() =>");
  const source = html.slice(start, html.indexOf("})();", start) + 5) + ";officeView";
  for (const saved of ["off", "flat", "isometric", "bogus"]) {
    let cookie = "other=1; agent-hub-office=" + saved;
    const writes: string[] = [];
    const document = { get cookie() { return cookie; }, set cookie(value: string) { writes.push(value); cookie = value; } };
    const view = runInNewContext(source, { document });
    expect(view.get()).toBe(saved === "flat" ? "flat" : "off");
    view.set("flat");
    expect(writes[0]).toBe("agent-hub-office=flat; Path=/; Max-Age=31536000; SameSite=Strict");
    view.set("bogus");
    expect(view.get()).toBe("off");
  }
  const blocked = runInNewContext(source, { document: { get cookie() { throw new Error("blocked"); }, set cookie(_value: string) { throw new Error("blocked"); } } });
  expect(blocked.get()).toBe("off");
  expect(() => blocked.set("flat")).not.toThrow();
  expect(html).not.toContain("localStorage");
});

test("flat renders focusable desks and cards with accessible names; an unchanged snapshot writes nothing", () => {
  const { api, get } = startOfficeRuntime(() => "flat");
  api.draw(snapshot);
  const office = get("office");
  expect(office.replacements).toBe(1);
  expect(get("office-section").hidden).toBe(false);
  const model = officeModel(snapshot, null, { cols: 4 });
  const buttons = office.findAll((node) => node.attrs.role === "button");
  const names = buttons.map((node) => node.attrs["aria-label"]);
  for (const desk of model.desks) expect(names).toContain(desk.name);
  expect(names).toContain("codex: busy on task #4 implement");
  expect(names).toContain(model.rooms.flatMap((room) => room.cards).map((card) => card.name)[0]!);
  for (const node of buttons) expect(node.attrs.tabindex).toBe("0");
  // Room counts on the scene equal the taskProgress counts of the same snapshot.
  const counts = taskProgress(snapshot.tasks).counts;
  const text = office.text();
  expect(text).toContain("To Do");
  expect(text).toContain(String(counts.proposed + counts.waiting));
  expect(text).toContain(String(counts.in_review));
  expect(text).toContain(String(counts.approved));
  expect(text).toContain("quota exhausted"); // the break sign carries the reason
  api.draw(JSON.parse(JSON.stringify(snapshot)));
  expect(office.replacements).toBe(1); // an identical snapshot causes no DOM write
  api.draw(snapshot);
  expect(office.replacements).toBe(1);
});

test("off renders nothing and leaves the lists alone; switching back to flat repaints", () => {
  const { api, get } = startOfficeRuntime(() => "off");
  api.draw(snapshot);
  expect(get("office-section").hidden).toBe(true);
  expect(get("office").children).toHaveLength(0);
  expect(get("office").replacements).toBe(0);
  expect(get("peers").children.length).toBeGreaterThan(0); // the lists render regardless
  expect(get("tasks").children.length).toBeGreaterThan(0);
});

test("activating a desk or card scrolls to and highlights the matching list row", () => {
  const { api } = startOfficeRuntime(() => "flat");
  api.draw(snapshot);
  const desk = api.maps.officeDesks.get("codex")!;
  const peerRow = api.maps.peerRows.get("codex")!;
  desk.fire("click");
  expect(peerRow.scrolled).toBe(1);
  expect(peerRow.classList.contains("spotlight")).toBe(true);
  desk.fire("keydown", { key: "Enter", preventDefault() {} });
  expect(peerRow.scrolled).toBe(2);
  const card = api.maps.officeCards.get(5)!; // a review-room card, not at a desk
  const taskRow = api.maps.taskRows.get(5)!;
  card.fire("keydown", { key: " ", preventDefault() {} });
  expect(taskRow.scrolled).toBe(1);
  expect(taskRow.classList.contains("spotlight")).toBe(true);
  expect(peerRow.classList.contains("spotlight")).toBe(false); // the highlight moves
  // A list row highlights its desk or card on focus and hover, and clears on blur/leave.
  peerRow.fire("mouseenter");
  expect(desk.classList.contains("office-spotlight")).toBe(true);
  peerRow.fire("mouseleave");
  expect(desk.classList.contains("office-spotlight")).toBe(false);
  taskRow.fire("focus");
  expect(card.classList.contains("office-spotlight")).toBe(true);
  taskRow.fire("blur");
  expect(card.classList.contains("office-spotlight")).toBe(false);
});

test("the '+N more' control filters the task list to the room's state", () => {
  const busy = {
    ...snapshot,
    tasks: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, title: `task ${i}`, class: "implement", state: "proposed", deps: [] })),
  };
  const { api, get } = startOfficeRuntime(() => "flat");
  api.draw(busy);
  const more = get("office").findAll((node) => (node.attrs["aria-label"] ?? "").includes("more proposed tasks"))[0]!;
  expect(more.text()).toContain("+2 more");
  more.fire("click");
  expect(get("task-filter").value).toBe("proposed");
  expect(get("tasks").text()).toContain("task 0");
});

test("resetView clears the scene's previous snapshot", () => {
  const reset = html.slice(html.indexOf("function resetView("), html.indexOf("function projectName("));
  const nodes = new Map<string, Node>();
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id)!; };
  const context = { get };
  runInNewContext(`
    let selectedProjectId='p1',selectedInstanceId='i1',snapshotValid=true,cursor=1,eventCount=1,viewGeneration=0,streamFilter='',draftChoicesPending=false,officePrev={slots:{codex:1}};
    const officeDesks=new Map([['codex',1]]),officeCards=new Map([[4,1]]);
    const managerMode=true,signatures=new Map(),$=get;
    const saveDraft=()=>{},restoreDraft=()=>{},syncMutationControls=()=>{},peerOptions=()=>{},notice=()=>{};
    const empty=(node,text)=>{node.textContent=text};
    ${reset}
    resetView('p2','i2');
    this.result = { officePrev, desks: officeDesks.size, cards: officeCards.size };
  `, context) as unknown;
  expect((context as Record<string, unknown>).result).toEqual({ officePrev: null, desks: 0, cards: 0 });
});
