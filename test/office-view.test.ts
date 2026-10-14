import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { officeModel } from "../src/ui/office-model.ts";
import { taskProgress } from "../src/ui/task-progress.ts";
import { boardColumns } from "../src/ui/task-board.ts";
import { PEER_PALETTE } from "../src/ui/peer-palette.ts";
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
  open = false; focused = 0;
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused++; }
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
  append(...nodes: Node[]) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
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
  const board = html.slice(html.indexOf("let boardViewState ="),html.indexOf("function render(snapshot)"));
  const scope = ["canMutate", "context"].map(name=>html.split("\n").find(line=>line.startsWith("function "+name+"("))!).join("\n");
  const renderSlice = html.slice(html.indexOf("function render(snapshot)"), html.indexOf("async function poll("));
  const nodes = new Map<string, Node>();
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id)!; };
  const el = (tag: string, text?: unknown, cls?: string) => { const node = new Node(); node.tag = tag; if (text !== undefined) node.textContent = String(text); node.className = cls ?? ""; return node; };
  const context = {
    get, el, officeModel, taskProgress, boardColumns, peerPalette: PEER_PALETTE, location: {origin:"http://127.0.0.1:4000"},
    officeView: { get: view, set: () => {} },
    document: { createElement: (tag: string) => { const node = new Node(); node.tag = tag; return node; }, createElementNS: (_ns: string, tag: string) => { const node = new Node(); node.tag = tag; return node; } },
  };
  const api = runInNewContext(`
    let stopped=false, managerMode=false, selectedProjectId='', selectedInstanceId='', snapshotValid=true, viewGeneration=0, lastSnapshot=null, eventCount=0, cursor=0, draftChoicesPending=false, officePrev=null;
    let currentView="office";const dashboardCookie={get(){return ""},set(){}};const applyDashboardView=()=>{get("office-section").hidden=currentView!=="office"},switchView=view=>{currentView=view};const pendingButtons=new WeakSet(), pendingStarts=new Map(), signatures=new Map();
    const peerRows=new Map(), taskRows=new Map(), officeDesks=new Map(), officeCards=new Map();
    const $=get;
    const update=(id,data,render)=>{const signature=JSON.stringify(data);if(signatures.get(id)===signature)return;signatures.set(id,signature);const target=$(id);target.replaceChildren();render(target);};
    const empty=(target,text)=>target.append(el('p',text));
    const badge=(text)=>el('span',text),dot=()=>el('span'),peerDot={},taskBadge={};
    const button=(text)=>{const node=el('button',text);node.type='button';return node;};
    const notice=()=>{},syncStarts=()=>{},renderStarts=()=>{},renderTaskProgress=()=>{},renderApprovals=()=>{},renderBench=()=>{},renderMemory=()=>{},renderSettings=()=>{},renderTaskStage=()=>el('div'),peerOptions=()=>{},restoreDraft=()=>{},refreshRelativeTimes=()=>{},refreshStreamEmpty=()=>{},applyStreamFilter=()=>{},syncMutationControls=()=>{};
    const time=()=>'',rel=()=>'soon';
    const action=async()=>false;
    ${scope}
    ${board}
    ${scene}
    ${renderSlice}
    ({
      draw(snap){ lastSnapshot=snap; render(snap); },
      filter(state){ officeFilter(state); },
      view(){ return currentView; },
      scene(){ return officeScene; },
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
  expect(served).toContain('<section id="office-section" aria-labelledby="office-title" data-view="office" hidden>');
  const control = served.match(/<select id="office-view">([\s\S]*?)<\/select>/)![1]!;
  expect([...control.matchAll(/value="(\w+)"/g)].map((match) => match[1])).toEqual(["off", "flat", "isometric"]);
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
  const cookie = html.match(/const dashboardCookie = [\s\S]*?\n\};/)![0];
  const source = cookie + html.slice(start, html.indexOf("})();", start) + 5) + ";officeView";
  for (const saved of ["off", "flat", "isometric", "bogus"]) {
    let cookie = "other=1; agent-hub-office=" + saved;
    const writes: string[] = [];
    const document = { get cookie() { return cookie; }, set cookie(value: string) { writes.push(value); cookie = value; } };
    const view = runInNewContext(source, { document });
    expect(view.get()).toBe(["off", "flat", "isometric"].includes(saved) ? saved : "off");
    view.set("isometric");
    expect(writes[0]).toBe("agent-hub-office=isometric; Path=/; Max-Age=31536000; SameSite=Strict");
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
  expect(text).toContain("To do");
  expect(text).toContain(String(counts.proposed + counts.waiting));
  expect(text).toContain(String(counts.in_review));
  expect(text).toContain(String(counts.approved));
  expect(text).toContain("quota exhausted"); // the break sign carries the reason
  api.draw(JSON.parse(JSON.stringify(snapshot)));
  expect(office.replacements).toBe(1); // an identical snapshot causes no DOM write
  api.draw(snapshot);
  expect(office.replacements).toBe(1);
});

test("off keeps its mode guidance visible and leaves the other view contents available", () => {
  const { api, get } = startOfficeRuntime(() => "off");
  api.draw(snapshot);
  expect(get("office-section").hidden).toBe(false);
  expect(get("office").text()).toContain("Office is off. Choose Flat or Isometric above.");
  expect(get("office").findAll(node=>node.tag==="svg")).toHaveLength(0);
  expect(get("peers").children.length).toBeGreaterThan(0); // the lists render regardless
  expect(get("tasks").children.length).toBeGreaterThan(0);
});

test("activating a desk or card scrolls to and highlights the matching list row", () => {
  const { api, get } = startOfficeRuntime(() => "flat");
  api.draw(snapshot);
  const desk = api.maps.officeDesks.get("codex")!;
  const peerRow = api.maps.peerRows.get("codex")!;
  desk.fire("click");
  expect(api.view()).toBe("agents");expect(peerRow.focused).toBe(1);
  expect(peerRow.scrolled).toBe(1);
  expect(peerRow.classList.contains("spotlight")).toBe(true);
  desk.fire("keydown", { key: "Enter", preventDefault() {} });
  expect(peerRow.scrolled).toBe(2);
  const card = api.maps.officeCards.get(5)!; // a review-room card, not at a desk
  const taskRow = api.maps.taskRows.get(5)!;
  card.fire("keydown", { key: " ", preventDefault() {} });
  expect(api.view()).toBe("board");expect(get("task-detail-dialog").open).toBe(true);expect(get("task-detail-title").textContent).toBe("Task #5");
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
    const closeTaskDetail=()=>{},renderNeedsAttention=()=>{},applyDashboardView=()=>{}; const saveDraft=()=>{},restoreDraft=()=>{},syncMutationControls=()=>{},peerOptions=()=>{},notice=()=>{};
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
  expect(arcs[0]!.attrs.class).toContain("office-arc-important"); // priority/dropped classes live on the arc group
  expect(arcs[0]!.attrs["aria-hidden"]).toBe("true");
  expect(arcs[0]!.findAll((node) => node.attrs.class === "office-arc-head")).toHaveLength(1); // arrowhead at the target
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

test("phase 3: the exact task bubble, finishing-a-turn and the check-running mark render", () => {
  const { api, get } = startOfficeRuntime(() => "flat");
  api.draw({
    status: {
      peers: {
        codex: { state: "busy", queued: 0, turn: { since: 1, task: 5, attribution: "delivery" } },
        kimi: { state: "paused", paused: "quota exhausted", queued: 0, turn: { since: 1, task: 6, attribution: "single_open" } },
      },
    },
    tasks: [
      { id: 4, title: "one", class: "implement", state: "in_progress", owner: "codex", checking: true },
      { id: 5, title: "two", class: "review", state: "in_progress", owner: "codex" },
      { id: 6, title: "three", class: "implement", state: "in_progress", owner: "kimi" },
    ],
    permissions: [],
    budget: {},
    events: [],
  });
  const codex = api.maps.officeDesks.get("codex")!;
  expect(codex.text()).toContain("#5 review"); // the turn's task, not the two in_progress tasks
  expect(codex.attrs["aria-label"]).toBe("codex: busy on task #5 review");
  const kimi = api.maps.officeDesks.get("kimi")!;
  expect(kimi.text()).toContain("finishing a turn"); // under the Break sign
  expect(kimi.text().indexOf("Break: quota exhausted")).toBeLessThan(kimi.text().indexOf("finishing a turn"));
  const card = api.maps.officeCards.get(4)!;
  expect(card.attrs.class).toContain("office-card-checking");
  expect(card.text()).toContain("⟳");
  expect(card.attrs["aria-label"]).toContain("check running");
  expect(get("office").findAll((node) => (node.attrs.class ?? "").includes("office-checking"))).toHaveLength(1);
});

test("phase 3: warning lines draw between the desks a link names", () => {
  const { api, get } = startOfficeRuntime(() => "flat");
  api.draw({
    ...snapshot,
    links: [
      { kind: "overlap", tasks: [4, 5], peers: ["codex", "claude"] },
      { kind: "conflict", tasks: [2, 4], peers: ["kimi", "codex"] },
      { kind: "cohort", tasks: [4, 5], peers: ["codex", "ghost"] }, // a peer without a desk: no line
    ],
  });
  const links = get("office").findAll((node) => (node.attrs.class ?? "").split(" ").includes("office-link"));
  expect(links).toHaveLength(2);
  expect(links[0]!.attrs.class).toContain("office-link-overlap");
  expect(links[0]!.text()).toContain("overlap #4 #5");
  expect(links[0]!.findAll((node) => node.attrs.class === "office-link-line")).toHaveLength(1);
  expect(links[1]!.attrs.class).toContain("office-link-conflict");
  expect(links[0]!.attrs["aria-hidden"]).toBe("true");
  // The link is state-driven: it stays while the link exists and leaves when it is gone.
  api.draw({ ...snapshot, links: [] });
  expect(get("office").findAll((node) => (node.attrs.class ?? "").split(" ").includes("office-link") && !node.classList.contains("office-leaving"))).toHaveLength(0);
});

test("isometric renders the same model with the same focus order and accessible names (AC7)", () => {
  const flat = startOfficeRuntime(() => "flat");
  flat.api.draw(snapshot);
  const iso = startOfficeRuntime(() => "isometric");
  iso.api.draw(snapshot);
  const focusOrder = (office: Node) => office.findAll((node) => node.attrs.tabindex === "0").map((node) => node.attrs["aria-label"]);
  const flatOrder = focusOrder(flat.get("office"));
  expect(flatOrder.length).toBeGreaterThan(0);
  expect(focusOrder(iso.get("office"))).toEqual(flatOrder); // same DOM order, same names
  expect(iso.get("office").text()).toContain("codex"); // upright labels, unrotated
  // Geometry: codex is desk slot 1 at grid (12, 3); iso maps x' = (x - y) cos 30, y' = (x + y) sin 30.
  const flatDesk = flat.api.maps.officeDesks.get("codex")!;
  expect(flatDesk.style.transform).toBe("translate(12px,3px)");
  const flatTile = flatDesk.findAll((node: Node) => node.attrs.class === "office-desk-surface")[0]!;
  expect(flatTile.tag).toBe("rect");
  expect(flatDesk.findAll((node: Node) => node.attrs.class === "office-avatar").length).toBeGreaterThan(0); // avatar inside the tile
  const isoDesk = iso.api.maps.officeDesks.get("codex")!;
  expect(isoDesk.style.transform).toBe(`translate(${(12 - 3) * 0.8660254}px,${(12 + 3) * 0.5}px)`);
  const tile = isoDesk.findAll((node: Node) => node.attrs.class === "office-desk-surface")[0]!;
  expect(tile.tag).toBe("polygon");
  expect(tile.attrs.points).toBe("0,0 8.66,5 -1.73,11 -10.39,6"); // desk top is 10 x 12 grid units
  // The extruded desk: two thin front legs, a standing avatar behind it, a name plate on the front edge.
  expect(isoDesk.findAll((node: Node) => node.attrs.class === "office-desk-leg")).toHaveLength(2);
  expect(isoDesk.findAll((node: Node) => node.attrs.class === "office-nameplate")).toHaveLength(1);
  expect(isoDesk.findAll((node: Node) => node.attrs.class === "office-avatar")[0]!.attrs.cy).toBe("-3.7");
  // Room posts and decorative empty shelf boxes are removed in #394.
  expect(iso.get("office").findAll((node: Node) => node.attrs.class === "office-room-wire")).toHaveLength(0);
  expect(iso.get("office").findAll((node: Node) => node.attrs.class === "office-box-top")).toHaveLength(0);
  // The viewBox covers the projected extents with a margin.
  const model=officeModel(snapshot,null,{cols:4});
  const w=model.width,h=model.height; // geometry is validated in office-model.test.ts
  expect(flat.get("office").findAll((node) => node.tag === "svg")[0]!.attrs.viewBox).toBe(`0 0 ${w} ${h}`);
  const isoBox = iso.get("office").findAll((node) => node.tag === "svg")[0]!.attrs.viewBox!.split(" ").map(Number);
  const isoModel=officeModel(snapshot,null,{cols:2});
  const corners=[...isoModel.rooms,...isoModel.desks].flatMap(tile=>[[tile.x,tile.y],[tile.x+tile.w,tile.y],[tile.x,tile.y+tile.h],[tile.x+tile.w,tile.y+tile.h]]).map(([x,y])=>[(x!-y!)*0.8660254,(x!+y!)*0.5]);
  const xs=corners.map(point=>point[0]!),ys=corners.map(point=>point[1]!);
  expect(isoBox[0]).toBeCloseTo(Math.min(...xs)-3);
  expect(isoBox[1]).toBeCloseTo(Math.min(...ys)-6);
  expect(isoBox[2]).toBeCloseTo(Math.max(...xs)-Math.min(...xs)+6);
  expect(isoBox[3]).toBeCloseTo(Math.max(...ys)-Math.min(...ys)+9);
});

test("motion and the settle rule work under isometric, and a view switch jumps", () => {
  let view = "flat";
  const { api, get } = startOfficeRuntime(() => view);
  api.draw(snapshot);
  const svg = () => get("office").children[0]!;
  expect(svg().attrs.class).toContain("office-settle");
  const card = api.maps.officeCards.get(4)!;
  const flatAt = card.style.transform;
  view = "isometric";
  api.draw(snapshot); // same model, new projection: repaint in place, no animation
  expect(api.maps.officeCards.get(4)).toBe(card);
  expect(card.style.transform).not.toBe(flatAt);
  expect(svg().attrs.class).toContain("office-settle");
  // A card move under isometric keeps its node and animates by transform as in flat.
  const moved = { ...snapshot, tasks: snapshot.tasks.map((task) => task.id === 4 ? { ...task, state: "proposed", owner: "" } : task) };
  api.draw(moved);
  expect(api.maps.officeCards.get(4)).toBe(card);
  expect(svg().attrs.class).not.toContain("office-settle");
  const isoAt = card.style.transform;
  expect(isoAt).toMatch(/^translate\(-?\d/);
  // Back to flat: the card returns to the flat coordinate of its room slot.
  view = "flat";
  api.draw(moved);
  expect(card.style.transform).not.toBe(isoAt);
});

test("the polished flat scene: avatar, outline glyphs, hand shape and populated Done shelf", () => {
  const { api, get } = startOfficeRuntime(() => "flat");
  api.draw({ ...snapshot, permissions: [{ peer: "claude" }],tasks:[...snapshot.tasks,...Array.from({length:6},(_,index)=>({id:100+index,title:"done",state:"approved",class:"implement"}))] });
  const claude = api.maps.officeDesks.get("claude")!;
  expect(claude.findAll((node: Node) => node.attrs.class === "office-avatar")).toHaveLength(2); // head + shoulders
  expect(claude.findAll((node: Node) => node.attrs.class === "office-handshape")).toHaveLength(2); // condition glyph + approval mark
  expect(claude.text()).toContain("waiting on approval"); // the label still carries the state in words
  expect(api.maps.officeDesks.get("kimi")!.findAll((node: Node) => node.attrs.class === "office-glyph-shape")).toHaveLength(1);
  const office = get("office");

  expect(office.findAll((node) => node.attrs.class === "office-shelf-card")).toHaveLength(6);
  expect(office.text()).toContain("Done");
});

function mergeOfficeRuntime(reduced: { value: boolean }, clock: { value: number }) {
  const nodes = new Map<string, Node>(), get = (id: string) => { if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id)!; };
  const taskRows = new Map<number, Node>(), peerRows = new Map<string, Node>(), opened:number[]=[],views:string[]=[],focuses:(string|null)[]=[];
  const api = runInNewContext(`let officePrev=null,stopped=false,snapshotValid=true,lastSnapshot={};const signatures=new Map(),officeDesks=new Map(),officeCards=new Map();const $=get;${scene};({draw:drawOffice,prune:()=>officePrune(officeScene,Date.now()),activate:activateOfficeTask,scene:()=>officeScene})`, {
    get, taskRows, peerRows, officeModel, officeView: { get: () => "flat" },
    Date: class extends Date { static override now() { return clock.value; } },
    matchMedia: () => ({ matches: reduced.value }),
    document: { createElementNS: (_ns: string, tag: string) => { const node=new Node();node.tag=tag;return node; } },
    render: () => { taskRows.set(4,new Node()); },setColumnFocus:(column:string|null)=>{focuses.push(column);views.push("board")},switchView:(view:string)=>views.push(view),openTaskDetail:(id:number)=>opened.push(id),
  });
  return { api, get, taskRows, peerRows, opened, views, focuses };
}

test("Office mode control belongs to its dedicated view and remains outside the scene (#391)", () => {
 const section=html.slice(html.indexOf('<section id="office-section"'),html.indexOf('</section>',html.indexOf('<section id="office-section"')));
 expect(section).toContain('data-view="office"');expect(section).toContain('id="office-view"');
 expect(section.indexOf('id="office-view"')).toBeLessThan(section.indexOf('id="office"'));
});

test("office settled paints and reduced motion do not retain departed or appearance nodes (#264 merge)", () => {
  const reduced={value:false},clock={value:20000},{api,get}=mergeOfficeRuntime(reduced,clock);
  const first=officeModel(snapshot,null,{cols:4,now:clock.value});api.draw(get("office"),first);
  expect(get("office").findAll(node=>node.classList.contains("office-appear"))).toHaveLength(0);
  reduced.value=true;
  const gone=officeModel({...snapshot,tasks:[]},first,{cols:4,now:clock.value+1});api.draw(get("office"),{...gone,settle:false});
  expect(get("office").findAll(node=>node.classList.contains("office-leaving"))).toHaveLength(0);
});

test("expired arcs are skipped and reduced motion marks expire without animationend (#264 merge)", () => {
  const reduced={value:true},clock={value:20000},{api,get}=mergeOfficeRuntime(reduced,clock);
  const first=officeModel(snapshot,null,{cols:4,now:clock.value});
  const arc={seq:1,from:"codex",to:["claude"],kind:"chat",priority:"status",task:"",dropped:"",until:19000};
  api.draw(get("office"),{...first,arcs:[arc]});
  const arcs=()=>get("office").findAll(node=>(node.attrs.class??"").split(" ").includes("office-arc"));
  expect(arcs()).toHaveLength(0);
  api.draw(get("office"),{...first,arcs:[{...arc,until:21000}]});expect(arcs()).toHaveLength(1);
  clock.value=22000;api.prune();expect(arcs()).toHaveLength(0);
});

test("office task activation reveals filtered rows and card/desk handlers live in sibling layers (#264 merge)", () => {
  const {api,get,taskRows,opened,views,focuses}=mergeOfficeRuntime({value:false},{value:20000});
  api.activate(4);expect(taskRows.has(4)).toBe(true);expect(taskRows.get(4)?.scrolled).toBe(1);
  expect(opened).toEqual([4]);expect(views).toEqual(["board"]);expect(focuses).toEqual([null]);
  const original=taskRows.get(4)!;api.activate(999);expect(opened).toEqual([4]);expect(original.scrolled).toBe(1);expect(taskRows.get(4)?.scrolled).toBe(0);
  const model=officeModel(snapshot,null,{cols:4,now:20000});api.draw(get("office"),model);
  const scene=api.scene();expect(scene.els.get("card:4").node.parent).toBe(scene.layers.cards);
  expect(scene.layers.cards.parent).toBe(scene.layers.desks.parent);
});

test("parallel warning kinds draw distinguishable coordinates (#264 merge)", () => {
  const {api,get}=mergeOfficeRuntime({value:false},{value:20000});
  const model=officeModel({...snapshot,links:["overlap","cohort","conflict"].map(kind=>({kind,tasks:[4,5],peers:["codex","claude"]}))},null,{cols:4,now:20000});
  api.draw(get("office"),model);
  const lines=get("office").findAll(node=>node.attrs.class==="office-link-line");
  expect(lines).toHaveLength(3);expect(new Set(lines.map(line=>line.attrs.y1)).size).toBe(3);
});


test("backlog rows show no assignment action before they are pulled (#264 merge)", () => {
  const {api,get}=startOfficeRuntime(()=>"off");
  api.draw({...snapshot,tasks:[{id:90,title:"staged",class:"implement",state:"backlog"}]});
  expect(get("tasks").text()).toContain("staged");
  const openExact=()=>get("tasks").findAll(node=>node.tag==="article" && (node.attrs["aria-label"]?.startsWith("#90 ") ?? false))[0]!.fire("click");
  openExact();expect(get("task-detail-dialog").open).toBe(true);expect(get("task-detail-title").textContent).toBe("Task #90");
  const detail=get("task-detail-content");expect(detail.text()).toContain("staged");
  expect(detail.findAll(node=>node.tag==="button" && node.textContent==="Assign")).toHaveLength(0);
  expect(detail.findAll(node=>node.tag==="select" && node.attrs["aria-label"]==="Assign task 90")).toHaveLength(0);
  api.draw({...snapshot,tasks:[{id:90,title:"staged",class:"implement",state:"proposed",started:false}]});openExact();
  expect(detail.findAll(node=>node.tag==="button" && node.textContent==="Assign")).toHaveLength(1);
});


test("project reset removes old office SVG and prevents view changes replaying the old snapshot (#264 merge)", () => {
  const nodes=new Map<string,Node>(),get=(id:string)=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id)!;};
  const old=new Node();old.tag="svg";get("office").append(old);
  const control=new Node();let rendered=0,applied=0,activeView="board",mode="flat";
  const reset=html.slice(html.indexOf("function resetView("),html.indexOf("function projectName("));
  const start=html.indexOf("officeControl.addEventListener('change'");const change=html.slice(start,html.indexOf("\n",start));
  const api=runInNewContext(`let selectedProjectId='old',selectedInstanceId='old',snapshotValid=true,cursor=1,eventCount=1,viewGeneration=0,streamFilter='',draftChoicesPending=false,officePrev={},officeScene={},lastSnapshot={projectId:'old'};const officeDesks=new Map(),officeCards=new Map(),signatures=new Map();const managerMode=true,$=get;const closeTaskDetail=()=>{},renderNeedsAttention=()=>{},applyDashboardView=applyView; const saveDraft=()=>{},restoreDraft=()=>{},syncMutationControls=()=>{},peerOptions=()=>{},notice=()=>{},empty=(node,text)=>{node.textContent=text};${reset};${change};({reset:resetView,snapshot:()=>lastSnapshot})`,{
    get,officeControl:control,officeView:{get:()=>mode,set:(value:string)=>{mode=value}},applyView:()=>{applied++;get("office-section").hidden=activeView!=="office"},document:{getElementById:get},render:()=>{rendered++;},
  });
  api.reset("stopped","next");expect(get("office").children).toHaveLength(0);expect(api.snapshot()).toBeNull();
  expect(get("office-section").hidden).toBe(true);
  activeView="office";control.value="off";const before=applied;control.fire("change");
  expect(rendered).toBe(0);expect(mode).toBe("off");expect(applied).toBe(before+1);expect(get("office-section").hidden).toBe(false);
  expect(get("peers").text()).toContain("No project selected");
});


test("office task focus and combined Work filter follow five-column board cards (#263 integration)", () => {
  const {api,get}=startOfficeRuntime(()=>"flat");
  const current={...snapshot,tasks:[...snapshot.tasks,{id:6,title:"rework",class:"implement",state:"changes_requested",owner:"codex",deps:[]}]};
  api.draw(current);api.filter("work");expect([...api.maps.taskRows.keys()].sort()).toEqual([4,6]);
  const row=api.maps.taskRows.get(4)!;row.fire("focus");expect(api.maps.officeCards.get(4)!.classList.contains("office-spotlight")).toBe(true);
  get("task-peer-filter").value="kimi";api.draw(current);expect(api.maps.taskRows.has(4)).toBe(false);
  api.maps.officeCards.get(4)!.fire("click");expect(api.maps.taskRows.has(4)).toBe(true);
  expect(api.maps.taskRows.get(4)!.scrolled).toBe(1);expect(get("task-peer-filter").value).toBe("");
});

const hasOfficeClass=(name:string)=>(node:Node)=>(node.attrs.class ?? "").split(" ").includes(name);
function officeRect(node:Node){
 const [x,y]=/translate\(([-\d.]+)px,([-\d.]+)px\)/.exec(node.style.transform)!.slice(1).map(Number);
 const rect=node.findAll(hasOfficeClass("office-card"))[0]!;
 return{x:x!+Number(rect.attrs.x || 0),y:y!+Number(rect.attrs.y || 0),w:Number(rect.attrs.width),h:Number(rect.attrs.height)};
}
test("Office fixed scale uses projected viewBox width and stable readable type (#394)",()=>{
 const data={...snapshot,status:{peers:{claude:{state:"idle",queued:0},codex:{state:"busy",queued:1}}}};
 for(const view of ["flat","isometric"]){
  const f=startOfficeRuntime(()=>view);f.get("office-section").clientWidth=1180;f.api.draw(data);
  const svg=f.api.scene().svg as Node,box=svg.attrs.viewBox!.split(" ").map(Number),width=Number(svg.attrs.width);
  expect(width).toBeCloseTo(box[2]!*12);expect(width).toBeLessThanOrEqual(1180);expect(svg.attrs.height).toBeUndefined();
  f.get("office-section").clientWidth=1820;f.api.draw(data);expect(Number(svg.attrs.width)).toBe(width);expect(svg.attrs.viewBox!.split(" ").map(Number)).toEqual(box);
 }
 const css=html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
 const rule=(name:string)=>[...css.matchAll(/([^{}]+)\{([^}]+)\}/g)].find(match=>match[1]!.split(",").some(selector=>selector.trim()==="."+name))![2]!;
 const sceneRule=rule("office-scene");expect(sceneRule).toContain("max-width:100%");expect(sceneRule).not.toMatch(/(?:^|;)width:100%/);expect(sceneRule).toContain("height:auto");
 for(const [name,pixels] of [["office-room-title",13],["office-name",13],["office-room-count",12],["office-card-text",12],["office-state",12],["office-meta",12]] as const){
  const font=Number(/font-size:([\d.]+)px/.exec(rule(name))![1]);expect(Math.abs(font*12-pixels)).toBeLessThanOrEqual(1);
 }
 expect(rule("office-room-title")).not.toMatch(/letter-spacing|text-transform/);expect(rule("office-room-title")).toContain("fill:var(--ink)");
 const waiting=[...css.matchAll(/([^{}]+)\{([^}]+)\}/g)].find(match=>match[1]!.split(",").some(selector=>selector.trim()===".office-waiting .office-desk-surface"));
 expect(waiting?.[2]).not.toMatch(/stroke-width:(?!1px(?:;|$))[^;]+/);
 expect(css).toContain("vector-effect:non-scaling-stroke");expect(css).toContain("stroke-width:1px");expect(css).toContain("stroke-width:2px");
});

test("Office room headers form the final overlay layer with count pills (#394)",()=>{
 for(const view of ["flat","isometric"]){
  const f=startOfficeRuntime(()=>view);f.api.draw(snapshot);const scene=f.api.scene();
  expect(scene.svg.children.at(-1)).toBe(scene.layers.headers);
  expect((scene.layers.headers as Node).findAll(hasOfficeClass("office-room-title")).map(node=>node.textContent)).toEqual(["To do","Work floor","Review","Done"]);
  expect((scene.layers.headers as Node).findAll(hasOfficeClass("office-room-count"))).toHaveLength(4);
  expect((scene.layers.rooms as Node).findAll(hasOfficeClass("office-room-title"))).toHaveLength(0);
  expect((scene.layers.rooms as Node).findAll(hasOfficeClass("office-room-wire"))).toHaveLength(0);
  expect((scene.layers.headers as Node).findAll(node=>node.tag==="rect")).toHaveLength(4);
 }
});

test("Office empty rooms and Done shelf contain no decorative slots (#394)",()=>{
 for(const view of ["flat","isometric"]){
  for(const count of [0,1,3,12]){
   const f=startOfficeRuntime(()=>view);f.api.draw({...snapshot,tasks:Array.from({length:count},(_,index)=>({id:index+1,title:"finished",state:"approved",class:"implement"}))});
   const office=f.get("office"),slotClass=view==="flat"?"office-shelf-card":"office-box-top";
   expect(office.findAll(hasOfficeClass(slotClass))).toHaveLength(Math.min(count,view==="flat"?6:3));
   expect(office.findAll(node=>node.textContent==="No tasks")).toHaveLength(count?3:4);
  }
 }
});

test("Office cards expose full public titles while clipping readable labels at words (#394)",()=>{
 const title="Improve routing reliability during release readiness checks";
 for(const view of ["flat","isometric"]){
  const f=startOfficeRuntime(()=>view);f.api.draw({...snapshot,tasks:[{id:101,title,state:"proposed",class:"implement"}]});
  const card=f.api.maps.officeCards.get(101)! as Node;expect(card.attrs["aria-label"]).toContain(title);
  expect(card.findAll(node=>node.tag==="title")[0]!.textContent).toContain(title);
  const label=card.findAll(hasOfficeClass("office-card-text"))[0]!.children.map(node=>node.textContent).join("");expect(label).toContain("#101");expect(label).toContain("Improve routing");expect(label.length).toBeGreaterThan(18);
  if(label.endsWith("...")){const clipped=label.slice(0,-3).trim();expect(("#101 "+title).startsWith(clipped+" ")).toBe(true);}
  card.fire("keydown",{key:"Enter",preventDefault(){}});expect(f.get("task-detail-dialog").open).toBe(true);expect(f.get("task-detail-content").text()).toContain(title);
 }
});

test("isometric room cards stay inside tiles without overlap and account for omitted tasks (#394)",()=>{
 for(const count of [0,4,12]){
  const data={...snapshot,status:{peers:{claude:{state:"idle",queued:0},codex:{state:"idle",queued:0}}},tasks:Array.from({length:count},(_,index)=>({id:index+1,title:"Readable task title "+index,state:"proposed",class:"implement"}))};
  const f=startOfficeRuntime(()=>"isometric");f.api.draw(data);const model=officeModel(data,null,{cols:2}),room=model.rooms.find(item=>item.id==="todo")!;
  const cards=[...f.api.maps.officeCards.values()] as Node[],rects=cards.map(officeRect);
  if(count)expect(cards.length).toBeGreaterThan(0);else expect(cards).toHaveLength(0);
  for(const rect of rects){
   expect(rect.w).toBeGreaterThan(0);expect(rect.h).toBeGreaterThan(0);
   for(const [x,y] of [[rect.x,rect.y],[rect.x+rect.w,rect.y],[rect.x,rect.y+rect.h],[rect.x+rect.w,rect.y+rect.h]]){
    const gx=y+x/(2*0.8660254),gy=y-x/(2*0.8660254);
    expect(gx).toBeGreaterThanOrEqual(room.x+1-0.00001);expect(gx).toBeLessThanOrEqual(room.x+room.w-1+0.00001);
    expect(gy).toBeGreaterThanOrEqual(room.y+1-0.00001);expect(gy).toBeLessThanOrEqual(room.y+room.h-1+0.00001);
   }
  }
  for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++){
   const a=rects[i]!,b=rects[j]!;expect(a.x+a.w<=b.x || b.x+b.w<=a.x || a.y+a.h<=b.y || b.y+b.h<=a.y).toBe(true);
  }
  const order=(f.api.scene().layers.cards as Node).children.map(officeRect).map(rect=>rect.y);expect(order).toEqual([...order].sort((a,b)=>a-b));
  const roomNode=(f.api.scene().layers.rooms as Node).findAll(hasOfficeClass("office-roombox-todo"))[0]!,more=roomNode.findAll(hasOfficeClass("office-more"));
  const omitted=count-cards.length;if(omitted){expect(more).toHaveLength(1);expect(more[0]!.textContent).toBe("+"+omitted+" more");more[0]!.parent!.fire("keydown",{key:"Enter",preventDefault(){}});expect(f.get("task-filter").value).toBe("proposed");expect([...f.api.maps.taskRows.keys()]).toHaveLength(count);}else expect(more).toHaveLength(0);
  const rooms=model.rooms;expect(rooms[1]!.x-(rooms[0]!.x+rooms[0]!.w)).toBeGreaterThanOrEqual(1);
 }
});

test("Office room empty marker refreshes when placements change but total count stays constant (#394)",()=>{
 const f=startOfficeRuntime(()=>"flat"),task={id:77,title:"moves to desk",state:"in_progress",class:"implement",owner:"ghost"};
 const draw=(owner:string)=>f.api.draw({...snapshot,tasks:[{...task,owner}]});
 const room=()=>((f.api.scene().layers.rooms as Node).findAll(hasOfficeClass("office-roombox-work"))[0]!);
 const count=()=>((f.api.scene().layers.headers as Node).children[1]!.findAll(hasOfficeClass("office-room-count"))[0]!.textContent);
 draw("ghost");expect(count()).toBe("1");expect(room().findAll(hasOfficeClass("office-empty"))).toHaveLength(0);expect(f.api.maps.officeCards.has(77)).toBe(true);
 draw("codex");expect(count()).toBe("1");expect(room().findAll(hasOfficeClass("office-empty"))[0]!.textContent).toBe("No tasks");expect(f.api.maps.officeDesks.get("codex")).toBeDefined();
 draw("ghost");expect(count()).toBe("1");expect(room().findAll(hasOfficeClass("office-empty"))).toHaveLength(0);
});


test("Office text palette meets 4.5 contrast in light and dark themes (#394)",()=>{
 const css=html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
 const luminance=(hex:string)=>{
  const channels=[0,2,4].map(offset=>parseInt(hex.slice(offset,offset+2),16)/255).map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4);
  return channels[0]!*0.2126+channels[1]!*0.7152+channels[2]!*0.0722;
 };
 for(const pattern of [/:root\{([^}]+)\}/,/:root\[data-theme="dark"\]\{([^}]+)\}/]){
  const tokens=new Map([...pattern.exec(css)![1]!.matchAll(/--([a-z-]+):#([0-9a-f]{6})/g)].map(match=>[match[1]!,match[2]!]));
  for(const [foreground,background] of [["ink","panel-soft"],["ink","panel"],["ink","control"],["muted","panel"],["muted","panel-soft"],["blue","control"],["blue","panel-soft"],["red","panel"],["green","panel"],["amber","panel"]]){
   const a=luminance(tokens.get(foreground!)!),b=luminance(tokens.get(background!)!);expect((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)).toBeGreaterThanOrEqual(4.5);
  }
 }
});

test("isometric cards paint by depth across occupied rooms (#394)",()=>{
 const tasks=Array.from({length:12},(_,index)=>({id:index+1,title:"Depth order task "+(index+1),class:"implement",state:index<4?"proposed":index<8?"in_progress":"in_review",...(index>=4&&index<8?{owner:"ghost"}:{})}));
 const data={...snapshot,status:{peers:{claude:{state:"idle",queued:0},codex:{state:"idle",queued:0}}},tasks};
 const f=startOfficeRuntime(()=>"isometric");f.api.draw(data);const layer=f.api.scene().layers.cards as Node;
 const ids=layer.children.map(node=>Number(/^#(\d+) /.exec(node.attrs["aria-label"]!)![1]));
 expect(ids).toHaveLength(9);expect([...ids].sort((a,b)=>a-b)).toEqual([1,2,3,5,6,7,9,10,11]);
 const y=layer.children.map(officeRect).map(rect=>rect.y);expect(y).toEqual([...y].sort((a,b)=>a-b));
 // Construction visits Work before Review; depth order must interleave their visible chips.
 expect(ids.indexOf(9)).toBeLessThan(ids.indexOf(7));
});
