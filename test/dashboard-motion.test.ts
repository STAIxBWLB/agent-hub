import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { boardColumns } from "../src/ui/task-board.ts";
import { taskProgress } from "../src/ui/task-progress.ts";
import { PEER_PALETTE } from "../src/ui/peer-palette.ts";

// #469 R6: keyed rendering, quiet motion, and the loading, empty, disconnected and toast states.

const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!.replace(/\/\*[\s\S]*?\*\//g, "");

/** A small DOM with parents, so a node that leaves the page is "disconnected" and a focused node that leaves loses focus, as in a browser. */
const focus: { active: Node | null } = { active: null };
class Node {
  children: Node[] = []; parent: Node | null = null; attrs: Record<string, string> = {}; dataset: Record<string, string> = {};
  handlers = new Map<string, ((event: any) => unknown)[]>(); textContent = ""; className = ""; id = ""; value = ""; hidden = false; disabled = false;
  draggable = false; title = ""; type = ""; open = false; tabIndex = -1; focuses = 0;
  classes = new Set<string>();
  classList = { add: (name: string) => { this.classes.add(name); }, remove: (name: string) => { this.classes.delete(name); }, toggle: (name: string, on?: boolean) => { if (on ?? !this.classes.has(name)) this.classes.add(name); else this.classes.delete(name); }, contains: (name: string) => this.classes.has(name) };
  root = false;
  constructor(readonly tag = "div") {}
  get isConnected(): boolean { let at: Node | null = this; while (at) { if (at.root) return true; at = at.parent; } return false; }
  contains(node: Node | null): boolean { let at = node; while (at) { if (at === this) return true; at = at.parent; } return false; }
  private drop(nodes: Node[]) { for (const node of nodes) { node.parent = null; } if (focus.active && !focus.active.isConnected) focus.active = null; }
  append(...nodes: Node[]) { for (const node of nodes) { node.parent?.children.splice(node.parent.children.indexOf(node), 1); node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes: Node[]) { const old = this.children; this.children = []; this.drop(old); this.append(...nodes); }
  /** As in a browser: leaves the parent, loses focus when it held it, and is a no-op on a node that has no parent. */
  remove() { const parent = this.parent; if (!parent) return; parent.children.splice(parent.children.indexOf(this), 1); this.parent = null; if (focus.active && !focus.active.isConnected) focus.active = null; }
  get childNodes(): Node[] { return this.children; }
  cloneNode(deep = false): Node { const copy = new Node(this.tag); copy.className = this.className; copy.textContent = this.textContent; for (const name of this.classes) copy.classes.add(name); copy.attrs = { ...this.attrs }; if (deep) copy.append(...this.children.map(child => child.cloneNode(true))); return copy; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  getAttribute(key: string) { return this.attrs[key] ?? null; }
  addEventListener(name: string, fn: (event: any) => unknown) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]); }
  emit(name: string, event: any = {}) { for (const fn of this.handlers.get(name) ?? []) fn(event); }
  focus() { this.focuses++; if (this.isConnected) focus.active = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  set innerHTML(_value: string) { throw new Error("unsafe HTML rendering"); }
}
const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)];
const documentStub = { get activeElement() { return focus.active; }, createElement: (tag: string) => new Node(tag), createElementNS: (_ns: string, tag: string) => new Node(tag) };
const el = (tag: string, text?: unknown, cls = "") => { const node = new Node(tag); if (text !== undefined) node.textContent = String(text); node.className = cls; for (const name of cls.split(" ").filter(Boolean)) node.classes.add(name); return node; };
const lineOf = (name: string) => html.split("\n").find(line => line.startsWith("function " + name + "("))!;

/** The real board code and the real update() from the page, on the fake DOM above. */
function boardWithRealUpdate() {
  focus.active = null;
  const source = html.slice(html.indexOf("let boardViewState ="), html.indexOf("function render(snapshot) {"));
  const nodes = new Map<string, Node>(), get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id)!; };
  get("tasks").root = true; get("task-lanes").value = "columns";
  const scope = { projectId: "project", instanceId: "instance", generation: 1 };
  const api = runInNewContext(`let stopped=false,managerMode=true,snapshotValid=true,currentView="board";const dashboardCookie=cookiePrefs;const switchView=()=>{},applyDashboardView=()=>{};const taskRows=new Map(),officeCards=new Map(),signatures=new Map(); ${lineOf("update")} ${source}; ({draw:renderBoard,rows:taskRows})`, {
    cookiePrefs: { get: () => "", set: () => {} }, location: { origin: "http://127.0.0.1:4000" }, context: () => ({ ...scope }), canMutate: () => true,
    document: documentStub, $: get, el, boardColumns, taskProgress, peerPalette: PEER_PALETTE, badge: (text: string, cls = "") => el("span", text, "badge" + (cls ? " " + cls : "")),
    renderTaskProgress: () => {}, renderTaskStage: (stage: { label: string }) => el("p", stage.label), renderPlanning: () => {},
    empty: (target: Node, text: string) => target.append(el("p", text, "empty")), peerOptions: (select: Node) => { select.value = ""; }, notice: () => {}, action: async () => true,
  } as any);
  const peers = { codex: { state: "idle", attached: true }, claude: { state: "busy", attached: true } };
  const tasks = () => [
    { id: 1, state: "proposed", title: "one", class: "implement", owner: "codex" },
    { id: 2, state: "in_progress", title: "two", class: "implement", owner: "claude" },
    { id: 3, state: "in_review", title: "three", class: "implement", owner: "codex", reviewer: "claude" },
    { id: 4, state: "approved", title: "four", class: "implement", owner: "codex" },
  ];
  const snapshot = (list = tasks()) => ({ projectId: scope.projectId, instanceId: scope.instanceId, boardCapabilities: { backlog: true }, boardLegend: [], tasks: list });
  const draw = (list = tasks()) => api.draw(snapshot(list), peers, Object.keys(peers));
  const cards = () => new Map(all(get("tasks")).filter(node => node.tag === "article").map(node => [Number(/#(\d+)/.exec(node.attrs["aria-label"] ?? "")![1]), node]));
  return { api, get, draw, cards, tasks };
}

test("a poll that changes one task keeps the other cards' DOM nodes and a focused card keeps focus (#469 R6 AC8)", () => {
  const { draw, cards, tasks } = boardWithRealUpdate();
  draw();
  const before = cards();
  expect([...before.keys()].sort()).toEqual([1, 2, 3, 4]);
  // Focus card 1 (it is attached to the page), then change card 2 only.
  before.get(1)!.focus(); expect(focus.active).toBe(before.get(1)!);
  const changed = tasks(); changed[1]!.title = "two, renamed";
  draw(changed);
  const after = cards();
  for (const id of [1, 3, 4]) expect(after.get(id), "card " + id + " is the same node").toBe(before.get(id)!);
  expect(after.get(2), "the changed card is a new node").not.toBe(before.get(2)!);
  expect(after.get(2)!.attrs["aria-label"]).toContain("two, renamed");
  expect(focus.active, "the focused card kept focus").toBe(before.get(1)!);
  expect(before.get(1)!.isConnected).toBe(true);
});

test("a focused card that itself changes hands its focus to the node that replaces it (#469 R6 AC8)", () => {
  const { draw, cards, tasks } = boardWithRealUpdate();
  draw();
  const before = cards(); before.get(2)!.focus();
  const changed = tasks(); changed[1]!.title = "two, renamed";
  draw(changed);
  const after = cards();
  expect(after.get(2)).not.toBe(before.get(2)!);
  expect(focus.active, "focus moved to the replacement").toBe(after.get(2)!);
});

test("an unchanged poll does not touch the board at all, and a gone card is removed without a trace (#469 R6 AC8)", () => {
  const { draw, cards, tasks, get } = boardWithRealUpdate();
  draw();
  const before = cards(), children = get("tasks").children;
  draw(); // same JSON: update() returns before building anything
  expect(get("tasks").children).toBe(children);
  expect(cards().get(1)).toBe(before.get(1)!);
  draw(tasks().filter(task => task.id !== 3));
  const after = cards();
  expect([...after.keys()].sort()).toEqual([1, 2, 4]);
  for (const id of [1, 2, 4]) expect(after.get(id)).toBe(before.get(id)!);
});

test("a card is rebuilt when a capability its buttons depend on changes (#469 R6)", () => {
  const { api, get, cards, tasks } = (() => { const f = boardWithRealUpdate(); return { ...f }; })();
  const peers = { codex: { state: "idle", attached: true } };
  const list = [{ id: 1, state: "backlog", title: "idea", class: "plan", owner: "codex" }, ...tasks().slice(1, 2)];
  const draw = (backlog: boolean) => api.draw({ projectId: "project", instanceId: "instance", boardCapabilities: { backlog }, boardLegend: [], tasks: list }, peers, ["codex"]);
  draw(true); const before = cards().get(1)!;
  draw(true); expect(cards().get(1)).toBe(before);
  draw(false); expect(cards().get(1), "the capability changed, so the card is rebuilt").not.toBe(before);
  expect(get("tasks").children.length).toBeGreaterThan(0);
});

test("a card that moves to another column is a new arrival and fades in; the first render does not animate (#469 R6)", () => {
  const { draw, cards, tasks } = boardWithRealUpdate();
  draw();
  expect([...cards().values()].some(node => node.classes.has("is-new")), "the first render is not an arrival").toBe(false);
  const moved = tasks(); moved[0]!.state = "in_progress";
  draw(moved);
  const after = cards();
  expect(after.get(1)!.classes.has("is-new")).toBe(true);
  expect(after.get(3)!.classes.has("is-new")).toBe(false);
  after.get(1)!.emit("animationend");
  expect(after.get(1)!.classes.has("is-new")).toBe(false);
});

test("keyed passes hand out the same node for the same signature and drop keys that are gone (peer rows and memory rows use them) (#469 R6 AC8)", () => {
  const source = html.slice(html.indexOf("const keyedCaches ="), html.indexOf("function keyedStart(") );
  const fn = html.slice(html.indexOf("function keyedStart("), html.indexOf("\n}\n", html.indexOf("function keyedStart(")) + 3);
  const api = runInNewContext(`${source}\nconst update={keep:null};${fn}; ({keyedStart,keyedCaches})`, { document: documentStub }) as any;
  const first = api.keyedStart("peers");
  const a = first("codex", "s1", () => el("div")), b = first("claude", "s1", () => el("div"));
  first.end();
  const second = api.keyedStart("peers");
  expect(second("codex", "s1", () => el("div"))).toBe(a);
  expect(second("claude", "s2", () => el("div"))).not.toBe(b);
  second.end();
  const third = api.keyedStart("peers");
  third("codex", "s1", () => el("div")); third.end();
  expect([...api.keyedCaches.get("peers").nodes.keys()]).toEqual(["codex"]);
  // The page renders peer rows and memory rows (goals and entries) through it, and resets the caches with the view.
  expect(html).toContain("keyedStart('peers')");
  expect(html.match(/keyedStart\('memory'\)/g)).toHaveLength(2);
  expect(html).toContain("keyedStart('cards',true)");
  expect(html).toContain("keyedCaches.clear()");
  // The JSON-signature fast path and the poll interval are as they were.
  expect(lineOf("update")).toContain("if (signatures.get(id) === signature) return;");
  expect(html.match(/setTimeout\(poll, 1000\)/g)).toHaveLength(2);
});

test("motion animates only transform and opacity, 120 to 200 ms, no new infinite loop, and everything is off under reduced motion (#469 R6 AC9)", () => {
  // Every transition: none, or properties from {transform, opacity} (the Office scene's own .8 s transform move is pinned elsewhere).
  const transitions = [...css.matchAll(/([^{}]+)\{[^{}]*?transition:([^;}]+)/g)].map(match => ({ selector: match[1]!.trim(), value: match[2]!.trim() }));
  expect(transitions.length).toBeGreaterThan(3);
  for (const { selector, value } of transitions) {
    if (/^none\b/.test(value)) continue;
    for (const part of value.split(",")) {
      const [property, duration] = part.trim().split(/\s+/);
      expect(["transform", "opacity"], selector + " transitions " + property).toContain(property!);
      const ms = duration!.endsWith("ms") ? parseFloat(duration!) : parseFloat(duration!) * 1000;
      if (!selector.includes("office")) expect(ms, selector + " duration").toBeGreaterThanOrEqual(120);
      expect(ms, selector + " duration").toBeLessThanOrEqual(selector.includes("office") ? 800 : 200);
    }
  }
  // Every keyframe moves transform and opacity only.
  const frames = [...css.matchAll(/@keyframes ([a-z-]+)\{((?:[^{}]|\{[^{}]*\})*)\}/g)];
  expect(frames.map(frame => frame[1]).sort()).toEqual(["card-in", "office-appear", "office-fade", "office-pulse", "sheet-in", "toast-in", "view-in"]);
  for (const frame of frames) for (const declaration of [...frame[2]!.matchAll(/([a-z-]+):/g)].map(match => match[1]!).filter(name => !/^(from|to)$/.test(name))) expect(["transform", "opacity"], frame[1] + " animates " + declaration).toContain(declaration);
  // Every animation on a rule is one of those keyframes, 120 to 200 ms (the Office ones keep their pinned timings), and the only infinite one is the Office pulse.
  const animations = [...css.matchAll(/([^{}]+)\{[^{}]*?animation:([^;}]+)/g)].map(match => ({ selector: match[1]!.trim(), value: match[2]!.trim() })).filter(item => item.value !== "none" && item.value !== "none!important");
  for (const { selector, value } of animations) {
    const name = value.split(/\s+/)[0]!;
    expect(frames.map(frame => frame[1]!), selector).toContain(name);
    if (!name.startsWith("office-")) { const ms = parseFloat(/(\d*\.?\d+)s/.exec(value)![1]!) * 1000; expect(ms, selector).toBeGreaterThanOrEqual(120); expect(ms, selector).toBeLessThanOrEqual(200); }
    if (/infinite/.test(value)) expect(name, selector + " loops").toBe("office-pulse");
  }
  expect(animations.filter(item => /infinite/.test(item.value))).toHaveLength(1);
  // One rule turns every transition and animation off under reduced motion, whichever rule declares it.
  expect(css).toMatch(/@media\(prefers-reduced-motion:reduce\)\{\*,\*::before,\*::after\{[^}]*transition:none!important[^}]*animation:none!important/);
  // Hover and press feedback, the view fade, card entry and the toast are declared.
  expect(css).toContain("button:active:not(:disabled){transform:translateY(1px)}");
  expect(css).toContain("main section[data-view]:not([hidden]){animation:view-in");
  expect(css).toContain(".task-card.is-new{animation:card-in");
});

test("before the first snapshot the board and the peers show skeleton blocks shaped like them, which the first render replaces (#469 R6 AC9)", () => {
  const tasks = /<div id="tasks"[^>]*>([\s\S]*?)<\/div><\/section>/.exec(html);
  const board = /<div id="tasks" class="task-list">(<div class="skeleton skeleton-board"[\s\S]*?)<p class="empty">Loading the board/.exec(html)![1]!;
  expect(tasks).not.toBeNull();
  expect(board.match(/class="skeleton-col"/g)).toHaveLength(5); // one per board column
  expect(board).toContain('aria-hidden="true"');
  expect(/<div id="peers"><div class="skeleton" aria-hidden="true">(?:<span class="skeleton-bar skeleton-tall"><\/span>){3}<\/div><p class="empty">Loading peers/.test(html)).toBe(true);
  expect(css).not.toMatch(/\.skeleton[^{]*\{[^}]*animation/); // they do not animate, so they add no loop
  // The first snapshot's render replaces them: update() empties the container before it renders.
  const { draw, get } = boardWithRealUpdate(); get("tasks").append(el("div", undefined, "skeleton"));
  draw(); expect(all(get("tasks")).some(node => node.className === "skeleton")).toBe(false);
});

test("an empty view says what fills it and the command that does it (#469 R6 AC9)", () => {
  const { draw, get } = boardWithRealUpdate();
  draw([]);
  expect(all(get("tasks")).find(node => node.className === "empty")!.textContent).toBe("No tasks yet. Plan one with the Plan button, or run ahub task propose <title>.");
  for (const [text, command] of [
    ["No peers connected. Start one below, or run ahub claude or ahub codex in a terminal.", "ahub claude"],
    ["No events yet. Messages, task changes and peer states appear here. Send one with ahub say <text>.", "ahub say"],
    ["No approvals waiting. A peer that asks for a permission appears here; answer with ahub permit.", "ahub permit"],
    ["Hub memory is off for this project, or nothing is stored yet. Save a note with ahub remember <text>.", "ahub remember"],
    ["No ' + memory.tier + '-term entries match. Save one with ahub remember <text>.", "ahub remember"],
    ["No long-term tasks. A person creates one with ahub goal new <title>.", "ahub goal new"],
  ] as const) { expect(html, text).toContain(text); expect(text).toContain(command); }
  // Every command named is a real one in the help text.
  const help = readFileSync(new URL("../src/cli/help.ts", import.meta.url), "utf8");
  for (const command of ["ahub task propose", "ahub say", "ahub permit", "ahub remember", "ahub goal new", "ahub claude", "ahub codex"]) expect(help, command).toContain(command);
});

test("a lost connection dims the content, keeps it readable and says when the last snapshot came and that polling continues (#469 R6 AC9)", () => {
  const nodes = new Map<string, Node>(), get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id)!; };
  get("disconnected").hidden = true;
  const api = runInNewContext(`let lastSnapshotAt=0; const $=get; ${lineOf("setText")}\n${/function setDisconnected\(down\) \{[\s\S]*?\n\}/.exec(html)![0]}; ({down:setDisconnected,at:(v)=>{lastSnapshotAt=v}})`, { get, Date } as any) as any;
  api.down(true);
  expect(get("main-content").dataset.stale).toBe("true");
  expect(get("disconnected").hidden).toBe(false);
  expect(get("disconnected").textContent).toBe("No snapshot received yet. Polling continues every second.");
  api.at(Date.UTC(2026, 9, 21, 12, 0, 0)); api.down(true);
  expect(get("disconnected").textContent).toMatch(/^Last snapshot at .+\. Polling continues every second\.$/);
  api.down(false);
  expect(get("main-content").dataset.stale).toBeUndefined();
  expect(get("disconnected").hidden).toBe(true);
  // The poll wires it: a failed poll sets it, a good one clears it, and the page dims only opacity and keeps text readable.
  expect(html).toContain("setConnection('Disconnected / retrying: ' + error.message, 'down'); setDisconnected(true);");
  expect(html).toContain("setConnection('Live / updated ' + new Date().toLocaleTimeString(), 'live'); setDisconnected(false);");
  expect(css).toMatch(/main\[data-stale\]>:not\(#notice\):not\(#disconnected\)\{opacity:\.6;/);
});

test("notices are an aria-live toast stack: errors stay until dismissed, a success fades after 4 s, reduced motion keeps it (#469 R6 AC9)", () => {
  expect(html).toContain('<div id="notice" class="notice" role="status" aria-live="polite" aria-label="Notices"></div>');
  const run = (reduced: boolean) => {
    const stack = new Node(); stack.root = true;
    let now = 0, seq = 0; const timers = new Map<number, { at: number; fn: () => void }>();
    const advance = (ms: number) => { now += ms; for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (timer.at <= now) { timers.delete(id); timer.fn(); } };
    const code = /function notice\(text, error = false\) \{[\s\S]*?\n\}/.exec(html)![0];
    const api = runInNewContext(`${code}; ({notice})`, { $: () => stack, el, setTimeout: (fn: () => void, ms: number) => { timers.set(++seq, { at: now + ms, fn }); return seq; }, globalThis: { matchMedia: () => ({ matches: reduced }) } } as any) as any;
    return { stack, notice: api.notice as (text: string, error?: boolean) => void, advance };
  };
  const live = run(false);
  live.notice("Action accepted."); live.notice("Provider refused the start", true);
  expect(live.stack.children.map(toast => toast.className)).toEqual(["toast", "toast error"]);
  const dismiss = live.stack.children[1]!.children[1]!; expect(dismiss.tag).toBe("button"); expect(dismiss.attrs["aria-label"]).toContain("Provider refused the start");
  live.advance(3999); expect(live.stack.children).toHaveLength(2);
  live.advance(1); expect(live.stack.children[0]!.className).toContain("toast-out"); // the fade starts at 4 s
  live.advance(200); expect(live.stack.children.map(toast => toast.children[0]!.textContent)).toEqual(["Provider refused the start"]); // the success is gone, the error stays
  live.advance(60_000); expect(live.stack.children).toHaveLength(1);
  dismiss.emit("click"); expect(live.stack.children).toHaveLength(0);
  // The same text again replaces its toast, an empty text clears the stack, and the stack holds four.
  live.notice("same"); live.notice("same"); expect(live.stack.children).toHaveLength(1);
  for (const n of [1, 2, 3, 4, 5]) live.notice("n" + n, true);
  expect(live.stack.children).toHaveLength(4); live.notice(""); expect(live.stack.children).toHaveLength(0);
  // Under reduced motion a success stays.
  const still = run(true); still.notice("Action accepted."); still.advance(60_000);
  expect(still.stack.children.map(toast => toast.children[0]!.textContent)).toEqual(["Action accepted."]);
});

// #296: the first-load blocks come back on a project switch until THAT project's snapshot renders, and "No project selected" is only for
// the case where no running project is selected. The blocks are the page's own shipped markup, cloned at load, so nothing is written twice.
function resetHarness() {
  const start = html.indexOf("const firstLoad ="), end = html.indexOf("function projectName(");
  const nodes = new Map<string, Node>(), get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id)!; };
  // The two containers hold exactly the markup the page ships, built from the real HTML by a tiny parser of the skeleton shape.
  const make = (tag: string, cls: string, ...kids: Node[]) => { const node = el(tag, undefined, cls); node.append(...kids); return node; };
  const bars = (n: number, tall = 0) => Array.from({ length: n }, (_, i) => make("span", "skeleton-bar" + (i >= n - tall ? " skeleton-tall" : "")));
  get("tasks").append(make("div", "skeleton skeleton-board", ...[3, 2, 2, 1, 2].map(n => make("div", "skeleton-col", ...bars(n, n - 1)))), el("p", "Loading the board...", "empty"));
  get("peers").append(make("div", "skeleton", ...bars(3, 3)), el("p", "Loading peers...", "empty"));
  const api = runInNewContext(`let selectedProjectId='',selectedInstanceId='',snapshotValid=true,cursor=1,eventCount=1,viewGeneration=0,streamFilter='',draftChoicesPending=false,officePrev=null,officeScene=null,lastSnapshot=null;
    const officeDesks=new Map(),officeCards=new Map(),signatures=new Map(),managerMode=true,$=get;
    const closeTaskDetail=()=>{},renderNeedsAttention=()=>{},applyDashboardView=()=>{},saveDraft=()=>{},restoreDraft=()=>{},syncMutationControls=()=>{},peerOptions=()=>{},notice=()=>{};
    ${html.slice(start, end)}
    ({reset:resetView})`, { get, empty: (target: Node, text: string) => target.append(el("p", text, "empty")) } as any) as { reset: (id: string, instance: string) => void };
  return { api, get, columns: () => all(get("tasks")).filter(node => node.className === "skeleton-col").length, bars: () => all(get("peers")).filter(node => node.className.includes("skeleton-bar")).length, text: (id: string) => all(get(id)).map(node => node.textContent).filter(Boolean).join("|") };
}

test("a project switch keeps the board and peer skeletons until that project's snapshot renders (#296)", () => {
  const f = resetHarness();
  expect(f.columns()).toBe(5); expect(f.bars()).toBe(3); // the page as shipped
  f.api.reset("project-a", "instance-a"); // a running project is selected and its first /snapshot has not arrived
  expect(f.columns(), "board skeleton survives the reset").toBe(5); expect(f.bars(), "peer skeleton survives the reset").toBe(3);
  expect(f.text("tasks")).toContain("Loading the board"); expect(f.text("peers")).toContain("Loading peers");
  expect(f.text("tasks")).not.toContain("No project selected"); expect(f.text("peers")).not.toContain("No project selected");
  // A second switch shows them again, as new nodes (a node can sit in the page once).
  const before = all(f.get("tasks")).filter(node => node.className === "skeleton-col");
  f.api.reset("project-b", "instance-b");
  const after = all(f.get("tasks")).filter(node => node.className === "skeleton-col");
  expect(after).toHaveLength(5); expect(after.some(node => before.includes(node))).toBe(false);
});

test("No project selected is only for the case where no running project is selected (#296)", () => {
  const f = resetHarness();
  f.api.reset("", ""); // nothing selected
  expect(f.columns()).toBe(0); expect(f.text("tasks")).toBe("No project selected."); expect(f.text("peers")).toBe("No project selected.");
  const g = resetHarness();
  g.api.reset("project-a", ""); // a project that has no running instance never gets a snapshot, so it must not wait on a skeleton forever
  expect(g.columns()).toBe(0); expect(g.text("tasks")).toBe("No project selected.");
});

test("a toast that is removed or expires does not take focus from a surviving toast's Dismiss button (#296)", () => {
  const run = () => {
    focus.active = null;
    const stack = new Node(); stack.root = true;
    let now = 0, seq = 0; const timers = new Map<number, { at: number; fn: () => void }>();
    const advance = (ms: number) => { now += ms; for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (timer.at <= now) { timers.delete(id); timer.fn(); } };
    const code = /function notice\(text, error = false\) \{[\s\S]*?\n\}/.exec(html)![0];
    const api = runInNewContext(`${code}; ({notice})`, { $: () => stack, el, setTimeout: (fn: () => void, ms: number) => { timers.set(++seq, { at: now + ms, fn }); return seq; }, globalThis: { matchMedia: () => ({ matches: false }) } } as any) as any;
    const dismissOf = (index: number) => stack.children[index]!.children[1]!;
    return { stack, notice: api.notice as (text: string, error?: boolean) => void, advance, dismissOf };
  };
  // 1. Another toast is dismissed by hand.
  let r = run();
  r.notice("first", true); r.notice("second", true);
  const first = r.stack.children[0]!, firstDismiss = r.dismissOf(0); firstDismiss.focus(); expect(focus.active).toBe(firstDismiss);
  r.dismissOf(1).emit("click");
  expect(r.stack.children).toEqual([first]); expect(first.isConnected).toBe(true); expect(focus.active, "dismissing another toast").toBe(firstDismiss);
  // 2. A new toast arrives: the survivors keep their nodes and focus.
  r = run(); r.notice("kept", true);
  const kept = r.stack.children[0]!, keptDismiss = r.dismissOf(0); keptDismiss.focus();
  r.notice("newcomer", true);
  expect(r.stack.children[0], "the survivor is the same node").toBe(kept); expect(focus.active, "a new toast arriving").toBe(keptDismiss);
  // 3. A success toast expires while a surviving error toast's Dismiss is focused.
  r = run(); r.notice("stays", true); r.notice("fades");
  const stays = r.stack.children[0]!, staysDismiss = r.dismissOf(0); staysDismiss.focus();
  r.advance(4000); r.advance(200); // the fade starts at 4 s and the removal follows it 160 ms later
  expect(r.stack.children).toEqual([stays]); expect(focus.active, "an expiring toast").toBe(staysDismiss);
  // 4. Over four toasts, only the oldest goes, with no rebuild of the others.
  r = run(); for (const n of [1, 2, 3, 4]) r.notice("t" + n, true);
  const survivors = r.stack.children.slice(1), thirdDismiss = r.dismissOf(2); thirdDismiss.focus();
  r.notice("t5", true);
  expect(r.stack.children).toHaveLength(4); expect(r.stack.children.slice(0, 3)).toEqual(survivors);
  expect(r.stack.children.map(toast => toast.children[0]!.textContent)).toEqual(["t2", "t3", "t4", "t5"]); expect(focus.active, "overflow").toBe(thirdDismiss);
  // 5. The same text again replaces its own toast and nothing else.
  r = run(); r.notice("a", true); r.notice("b", true);
  const b = r.stack.children[1]!, bDismiss = r.dismissOf(1); bDismiss.focus();
  r.notice("a", true);
  expect(r.stack.children[0], "b is untouched").toBe(b); expect(focus.active).toBe(bDismiss);
  expect(r.stack.children.map(toast => toast.children[0]!.textContent)).toEqual(["b", "a"]);
});
