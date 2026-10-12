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
  style: Record<string, string> = {};
  listeners: Record<string, ((event?: unknown) => void)[]> = {};
  dataset: Record<string, string> = {};
  parent: Node | null = null;
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
  append(...nodes: Node[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes: Node[]) { this.children = []; this.replacements++; this.append(...nodes); }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  getAttribute(key: string) { return this.attrs[key] ?? null; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
  addEventListener(name: string, listener: (event?: unknown) => void) { (this.listeners[name] ??= []).push(listener); }
  fire(name: string, event: unknown = { preventDefault() {}, key: "" }) { for (const listener of this.listeners[name] ?? []) listener(event); }
  scrollIntoView() { this.scrolled++; }
  walk(visit: (node: Node) => void): void { visit(this); for (const child of [...this.children]) child.walk(visit); }
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
  events: [],
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
  const scene = JSON.parse(JSON.stringify(browserModel(snapshot, null, { cols: 2, now: 1000 })));
  expect(scene).toEqual(JSON.parse(JSON.stringify(officeModel(snapshot, null, { cols: 2, now: 1000 }))));
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
  for (const forbidden of ["setInterval", "setTimeout", "requestAnimationFrame", "post(", "action(", "fetch(", "innerHTML"]) expect(scene).not.toContain(forbidden);
  expect(scene).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(scene).not.toMatch(/rgb\(|fill:|stroke:|style=/);
});

test("reduced motion removes every scene transition and animation", () => {
  const reduce = html.match(/@media\(prefers-reduced-motion:reduce\)\{([^}]*)\}/g)!.join("\n");
  expect(reduce).toContain(".office-scene");
  expect(reduce).toContain("transition:none!important");
  expect(reduce).toContain("animation:none!important");
  // Motion is transitions on transform/opacity and keyframe fades, at most one second.
  expect(html).toContain(".office-movable{transition:transform .8s ease}");
  expect(html).toContain("@keyframes office-fade{to{opacity:0}}");
  expect(html).toContain("@keyframes office-pulse{50%{opacity:.45}}");
  expect(html).toContain(".office-settle .office-movable{transition:none}");
  expect(html).not.toMatch(/office[^}]*transition:[^;}]*\d(\.\d)?\d{1,}s/); // no multi-second transitions
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
    let selectedProjectId='p1',selectedInstanceId='i1',snapshotValid=true,cursor=1,eventCount=1,viewGeneration=0,streamFilter='',draftChoicesPending=false,officePrev={slots:{codex:1}},officeScene={els:new Map([['desk:codex',1]])};
    const officeDesks=new Map([['codex',1]]),officeCards=new Map([[4,1]]);
    const managerMode=true,signatures=new Map(),$=get;
    const saveDraft=()=>{},restoreDraft=()=>{},syncMutationControls=()=>{},peerOptions=()=>{},notice=()=>{};
    const empty=(node,text)=>{node.textContent=text};
    ${reset}
    resetView('p2','i2');
    this.result = { officePrev, officeScene, desks: officeDesks.size, cards: officeCards.size };
  `, context) as unknown;
  expect((context as Record<string, unknown>).result).toEqual({ officePrev: null, officeScene: null, desks: 0, cards: 0 });
});

test("a card move keeps its node and animates by transform; the first paint settles", () => {
  const { api, get } = startOfficeRuntime(() => "flat");
  api.draw(snapshot);
  const svg = get("office").children[0]!;
  expect(svg.attrs.class).toContain("office-settle"); // first snapshot: final positions, no motion
  const card = api.maps.officeCards.get(4)!;
  expect(card.attrs.class).toContain("office-movable");
  const before = card.style.transform;
  const moved = { ...snapshot, tasks: snapshot.tasks.map((task) => task.id === 4 ? { ...task, state: "proposed", owner: "" } : task) };
  api.draw(moved);
  expect(api.maps.officeCards.get(4)).toBe(card); // same node: the CSS transition animates it
  expect(card.style.transform).not.toBe(before);
  expect(card.style.transform).toBeTruthy();
  expect(svg.attrs.class).not.toContain("office-settle"); // small change within the gap: motion allowed
  // Approving the card removes it from the scene with a fade, and animationend purges it.
  const done = { ...snapshot, tasks: snapshot.tasks.map((task) => task.id === 4 ? { ...task, state: "approved" } : task) };
  api.draw(done);
  expect(api.maps.officeCards.get(4)).toBeUndefined();
  expect(card.classList.contains("office-leaving")).toBe(true);
  card.fire("animationend");
  expect(card.parent).toBeNull();
});

test("message arcs, delivery marks and the busy latch draw from event rows with fade timing, once", () => {
  const { api, get } = startOfficeRuntime(() => "flat");
  api.draw(snapshot);
  const now = Date.now();
  const withEvents = {
    ...snapshot,
    events: [
      { seq: 1, event: { t: "envelope", env: { from: "codex", to: ["claude"], kind: "chat", priority: "important", ts: now, refs: { task: "4" } } } },
      { seq: 2, event: { t: "overflow", peer: "kimi", env: { from: "claude", to: ["kimi"], kind: "chat", ts: now } } },
      { seq: 3, event: { t: "state", peer: "claude", state: "busy" } },
    ],
  };
  api.draw(withEvents);
  const office = get("office");
  const hasClass = (cls: string) => (node: Node) => (node.attrs.class ?? "").split(" ").includes(cls);
  const arcs = office.findAll(hasClass("office-arc"));
  expect(arcs).toHaveLength(1);
  expect(arcs[0]!.text()).toContain("chat #4");
  expect(arcs[0]!.attrs.class).toContain("office-fadeout");
  expect(arcs[0]!.style.animationDelay).toMatch(/^\d+ms$/);
  expect(arcs[0]!.findAll(hasClass("office-arc-important"))).toHaveLength(1);
  expect(arcs[0]!.attrs["aria-hidden"]).toBe("true");
  const alerts = office.findAll(hasClass("office-alertmark"));
  expect(alerts).toHaveLength(1);
  expect(alerts[0]!.text()).toContain("! overflow");
  const latches = office.findAll(hasClass("office-latchmark"));
  expect(latches).toHaveLength(1); // claude is idle in the status, so the busy latch badge shows
  expect(latches[0]!.text()).toContain("busy");
  // Re-rendering the same snapshot adds nothing and writes nothing.
  const drawn = office.replacements;
  api.draw(withEvents);
  expect(office.findAll(hasClass("office-arc"))).toHaveLength(1);
  expect(office.replacements).toBe(drawn);
});

test("no arc is drawn for history on the first snapshot (no replay)", () => {
  const { api, get } = startOfficeRuntime(() => "flat");
  api.draw({
    ...snapshot,
    events: [{ seq: 1, event: { t: "envelope", env: { from: "codex", to: ["claude"], kind: "chat", priority: "status", ts: Date.now() } } }],
  });
  expect(get("office").findAll((node) => (node.attrs.class ?? "").includes("office-arc"))).toHaveLength(0);
});
