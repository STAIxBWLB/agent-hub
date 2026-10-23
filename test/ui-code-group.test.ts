import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { codeGroup, CODE_GROUP_MAX } from "../src/hub/task-code-group.ts";
import { contrast } from "../src/ui/peer-palette.ts";

// #684 2c: the dashboard task sheet's Code group. The hub classifies; the page draws and opens the Memory tab on a symbol node.
const HEAD = "a".repeat(40);
const sym = (name: string, path = "src/hub/tasks.ts", kind = "function") => ({ id: `symbol:${name}@${path}`, name, path, kind });
const receipt = (symbols: unknown[], over: Record<string, unknown> = {}) => ({ head: HEAD, mergeBase: "b".repeat(40), state: "known", complete: true, countsFloor: true, symbols, ...over });
const allow = () => true;

test("each changed symbol is matching or unplanned against the plan, and a plan name nothing changed under is untouched (hub side)", () => {
  const group = codeGroup({ id: 1 }, receipt([sym("Tasks.offerReady"), sym("Tasks.review"), sym("helper")]), ["offerReady()", "Tasks.accept", "A.run"], allow, false)!;
  expect(group.state).toBe("known");
  expect(group.symbols.map(s => [s.name, s.mark])).toEqual([["Tasks.offerReady", "matching"], ["Tasks.review", "unplanned"], ["helper", "unplanned"]]);
  expect(group.untouched).toEqual(["Tasks.accept", "A.run"]);
  expect(group.head).toBe("aaaaaaaa");
  expect(group.complete).toBe(true);
  expect(group.symbols[0]!.id).toBe("symbol:Tasks.offerReady@src/hub/tasks.ts");
});

test("a private task has no group, unknown facts say unknown, and a stored receipt is never read as public (hub side)", () => {
  expect(codeGroup({ id: 2 }, receipt([sym("x")]), ["x"], allow, true)).toBeUndefined();
  for (const unknown of [undefined, null, "known", receipt([], { state: "unknown", complete: false }), receipt([sym("x")], { repositoryKey: "k" }), { ...receipt([sym("x")]), symbols: "no" }]) {
    expect(codeGroup({ id: 3 }, unknown, ["x"], allow, false), JSON.stringify(unknown)).toEqual({ state: "unknown", complete: false, symbols: [], untouched: [], more: 0, counts: { matching: 0, unplanned: 0, untouched: 0 }, planWithheld: 0 });
  }
});

test("plan names and ids that fail the hub screen or the shape are dropped, never shown (hub side)", () => {
  const secret = (text: string) => !text.includes("SECRET");
  const group = codeGroup({ id: 4 }, receipt([sym("ok"), { ...sym("bad"), id: "symbol:other@src/x.ts" }, { ...sym("c\u0007trl") }]), ["ok", "SECRET plan name", "untouched one"], secret, false)!;
  expect(group.symbols.map(s => s.name)).toEqual(["ok"]);
  expect(group.untouched).toEqual(["untouched one"]);
  expect(group.complete).toBe(false); // two listed symbols were refused and one plan name withheld
  expect(group.planWithheld).toBe(1);
  expect(JSON.stringify(group)).not.toContain("SECRET");
});

test("a long plan name is read at the stored bound and a withheld one marks the group incomplete, never turning a matching symbol into unplanned (finding, bot thread)", () => {
  const long = "Ns".repeat(126) + ".run"; // 256 characters, over the old 200 bound and under the stored 300
  expect(long.length).toBeGreaterThan(200); expect(long.length).toBeLessThanOrEqual(300);
  const changed = receipt([sym(long)]);
  const kept = codeGroup({ id: 6 }, changed, [long], allow, false)!;
  expect(kept.symbols[0]!.mark).toBe("matching");
  expect(kept.untouched).toEqual([]);
  expect(kept.complete).toBe(true);
  expect(kept.planWithheld).toBe(0);
  // The same symbol with its plan name failing the screen: it is not called a departure, the group says a name was withheld and is incomplete.
  const hidden = codeGroup({ id: 6 }, changed, [long], text => !text.includes("Ns"), false)!;
  expect(hidden.planWithheld).toBe(1);
  expect(hidden.complete).toBe(false);
  expect(hidden.counts).toEqual({ matching: 0, unplanned: 1, untouched: 0 });
  // A name over the stored bound is malformed, so it is counted too and is never silently dropped.
  const tooLong = codeGroup({ id: 6 }, receipt([sym("x")]), ["y".repeat(301)], allow, false)!;
  expect(tooLong).toMatchObject({ planWithheld: 1, complete: false });
  // Every stored name is read: 50 names are the stored bound, a 51st is withheld, and the first 50 still match.
  const fifty = Array.from({ length: 50 }, (_, i) => `Plan.name${i}`);
  const full = codeGroup({ id: 6 }, receipt([sym("Plan.name49")]), [...fifty, "extra"], allow, false)!;
  expect(full.symbols[0]!.mark).toBe("matching");
  expect(full.planWithheld).toBe(1);
  expect(full.counts).toEqual({ matching: 1, unplanned: 0, untouched: 49 }); // the total of the 50 stored names less the one that matched
  expect(full.untouched).toHaveLength(CODE_GROUP_MAX); // the list is capped; the rest is counted in more and counts
  expect(full.more).toBe(9);
});

test("the sheet's counts are the totals and not the listed part (nit)", () => {
  const many = Array.from({ length: CODE_GROUP_MAX + 9 }, (_, i) => sym(`fn${i}`));
  // Planned names sit past the cap (fn44, fn47), so the listed part holds none of the matching symbols and the totals are the only place they show.
  const group = codeGroup({ id: 7 }, receipt(many), ["fn44", "fn47", "gone"], allow, false)!;
  expect(group.symbols).toHaveLength(CODE_GROUP_MAX);
  expect(group.symbols.filter(s => s.mark === "matching")).toHaveLength(0);
  expect(group.counts).toEqual({ matching: 2, unplanned: CODE_GROUP_MAX + 7, untouched: 1 });
  expect(group.more).toBe(9);
});

test("the group is capped and says how many more exist (hub side)", () => {
  const many = Array.from({ length: CODE_GROUP_MAX + 7 }, (_, i) => sym(`fn${i}`));
  const group = codeGroup({ id: 5 }, receipt(many), [], allow, false)!;
  expect(group.symbols).toHaveLength(CODE_GROUP_MAX);
  expect(group.more).toBe(7);
});

// --- the page: its own functions run over a snapshot fixture in a minimal DOM ---
class Node {
  children: Node[] = []; textContent = ""; className = ""; type = ""; title = ""; dataset: Record<string, string> = {}; attrs: Record<string, string> = {}; handlers: Record<string, () => void> = {}; value = "";
  constructor(readonly tag = "div") {}
  append(...nodes: Node[]) { this.children.push(...nodes); }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  addEventListener(name: string, handler: () => void) { this.handlers[name] = handler; }
  text(): string { return [this.textContent, ...this.children.map(child => child.text())].join(" "); }
  all(): Node[] { return [this, ...this.children.flatMap(child => child.all())]; }
}
function pageRig() {
  const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
  const start = html.indexOf("function codeGroupSection("), end = html.indexOf("function taskDetail(");
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const calls: string[] = [], memoryQuery = { node: "", q: "" }, input = new Node("input");
  const api = runInNewContext(`${html.slice(start, end)};({ codeGroupSection, openMemoryAt })`, {
    el: (tag: string, text?: string, cls?: string) => { const n = new Node(tag); if (text !== undefined) n.textContent = String(text); if (cls) n.className = cls; return n; },
    $: () => input, memoryQuery, closeTaskDetail: () => calls.push("close"), switchView: (view: string) => calls.push("view:" + view), rerenderMemory: () => calls.push("rerender"),
  }) as { codeGroupSection(task: unknown): Node | null; openMemoryAt(node: unknown): void };
  return { api, calls, memoryQuery };
}
const taskWith = (group: unknown) => ({ id: 9, title: "Fix #9", codeGroup: group });

test("the sheet draws each symbol as a button with its mark, and unknown reads unknown (no code facts)", () => {
  const { api } = pageRig();
  const known = api.codeGroupSection(taskWith(codeGroup({ id: 9 }, receipt([sym("Tasks.offerReady"), sym("stray")]), ["offerReady", "ghost"], allow, false)))!;
  const buttons = known.all().filter(n => n.tag === "button");
  expect(buttons.map(b => b.textContent)).toEqual(["Tasks.offerReady", "stray"]);
  expect(buttons.map(b => b.className)).toEqual(["code-symbol matching", "code-symbol unplanned"]);
  expect(buttons[0]!.dataset.symbolNode).toBe("symbol:Tasks.offerReady@src/hub/tasks.ts");
  expect(buttons[0]!.attrs["aria-label"]).toContain("open in Memory");
  expect(known.text()).toContain("ghost");
  expect(known.text()).toContain("untouched");
  expect(known.text()).toContain("advisory: deleted symbols are not reported");
  expect(known.text()).toContain("1 matching, 1 unplanned, 1 untouched");
  const unknown = api.codeGroupSection(taskWith(codeGroup({ id: 9 }, undefined, [], allow, false)))!;
  expect(unknown.text()).toContain("unknown (no code facts)");
  expect(unknown.all().filter(n => n.tag === "button")).toEqual([]);
  expect(api.codeGroupSection(taskWith({ state: "known", complete: true, symbols: [], untouched: [], more: 0 }))!.text()).toContain("none observed");
});

test("the sheet says a withheld plan name may hide a plan match, and counts the totals (finding, nit)", () => {
  const { api } = pageRig();
  const many = Array.from({ length: CODE_GROUP_MAX + 3 }, (_, i) => sym(`fn${i}`));
  const group = codeGroup({ id: 9 }, receipt(many), ["fn0", "Secret.name"], text => !text.includes("Secret"), false)!;
  const text = api.codeGroupSection(taskWith(group))!.text();
  expect(text).toContain("1 matching, " + (CODE_GROUP_MAX + 2) + " unplanned, 0 untouched");
  expect(text).toContain("3 more not shown");
  expect(text).toContain("1 plan name is withheld, so a symbol marked unplanned may be in the plan");
  expect(text).toContain("incomplete");
  expect(text).not.toContain("Secret");
  const clean = api.codeGroupSection(taskWith(codeGroup({ id: 9 }, receipt([sym("a")]), ["a"], allow, false)))!.text();
  expect(clean).not.toContain("withheld");
  expect(clean).not.toContain("incomplete");
});

test("a task without a group (a private task) shows nothing at all, whatever else it carries", () => {
  const { api } = pageRig();
  expect(api.codeGroupSection({ id: 10, title: "[pii]", codeSymbols: { state: "known", symbols: [sym("PRIVATE-MARKER")] }, plan: { symbols: ["PRIVATE-MARKER"] } })).toBeNull();
  expect(api.codeGroupSection(taskWith(undefined))).toBeNull();
});

test("a symbol click closes the sheet and opens the Memory tab with that canonical node as the graph start", () => {
  const { api, calls, memoryQuery } = pageRig();
  const section = api.codeGroupSection(taskWith(codeGroup({ id: 9 }, receipt([sym("Tasks.offerReady")]), [], allow, false)))!;
  section.all().find(n => n.tag === "button")!.handlers.click!();
  expect(memoryQuery.node).toBe("symbol:Tasks.offerReady@src/hub/tasks.ts");
  expect(calls).toEqual(["close", "view:memory", "rerender"]);
  // Only a symbol node is ever opened this way.
  for (const bad of ["mem:abc", "goal:1", "", undefined, 7, {}]) { api.openMemoryAt(bad); }
  expect(memoryQuery.node).toBe("symbol:Tasks.offerReady@src/hub/tasks.ts");
  expect(calls).toHaveLength(3);
});

test("the Code group's colours are tokens that pass contrast in both themes, and its rows wrap at phone width", () => {
  const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
  const css = html.match(/<style>([\s\S]*?)<\/style>/)![1]!.replace(/\/\*[\s\S]*?\*\//g, "");
  const light = /:root\{([^}]+)\}/.exec(css)![1]!, dark = /:root\[data-theme="dark"\]\{([^}]+)\}/.exec(css)![1]!;
  const tokens = (block: string) => new Map([...block.matchAll(/--([a-z0-9-]+):#([0-9a-f]{6})\b/g)].map(m => [m[1]!, "#" + m[2]!]));
  const rules = [...css.matchAll(/((?:button|span)?\.code-symbol[^{]*|\.code-symbols)\{([^}]*)\}/g)].map(m => ({ selector: m[1]!, body: m[2]! }));
  expect(rules.length).toBeGreaterThanOrEqual(4);
  const used = (body: string, prop: string) => new RegExp("(?:^|;)" + prop + ":var\\(--([a-z0-9-]+)\\)").exec(body)?.[1];
  const pairs: [string, string, string][] = [];
  for (const { selector, body } of rules) { const fg = used(body, "color"), bg = used(body, "background"); if (fg && bg) pairs.push([selector, fg, bg]); else if (fg) pairs.push([selector, fg, "panel"]); }
  expect(pairs.map(p => p[0]).join(" ")).toContain("unplanned");
  expect(pairs.map(p => p[0]).join(" ")).toContain("untouched");
  for (const [theme, block] of [["light", light], ["dark", dark]] as const) {
    const t = tokens(block);
    for (const [selector, fg, bg] of pairs) expect(contrast(t.get(fg)!, t.get(bg)!), `${theme} ${selector} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  }
  expect(css).toMatch(/\.code-symbol\{[^}]*overflow-wrap:anywhere/);
  expect(css).toMatch(/\.code-symbol\{[^}]*min-height:44px/);
  expect(css).toMatch(/\.code-symbol\{[^}]*min-width:44px/); // a one-letter symbol is still a 44 px target
  // The unplanned button keeps a hover state: its own :hover rule follows the rule that overrides the base background.
  expect(css.indexOf("button.code-symbol.unplanned:hover{")).toBeGreaterThan(css.indexOf("button.code-symbol.unplanned{"));
  expect(css).toMatch(/button\.code-symbol\.unplanned:hover\{background:var\(--hover\)\}/);
  // No colour literal anywhere in the new rules.
  expect(rules.map(r => r.body).join(";")).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
});

// --- the real daemon: the snapshot carries codeGroup for a public task with an observation, nothing for a private one ---
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { HOST_CODE_SYMBOLS, buildTaskCodeSymbols } from "../src/hub/task-code-symbols.ts";
import type { ReviewBrief } from "../src/hub/review-brief.ts";

const BASE = "c".repeat(40);
const brief = (head: string, name: string): ReviewBrief => ({ head, base: "origin/main", mergeBase: BASE, reviewable: [{ path: "a.ts", status: "M" }], excluded: [], withheld: 0, rules: [], rulesMissing: [], ruleGroups: [], unlisted: [],
  symbols: { state: "known", complete: true, planned: [], unplanned: [], unseen: [], files: [{ path: "a.ts", symbols: [{ path: "a.ts", name, kind: "fn", line: 1, ambiguous: false, change: "unknown" }] }] } } as ReviewBrief);
const freePort = () => { const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }), port = server.port!; server.stop(true); return port; };

test("the daemon's UI snapshot carries codeGroup for a public task, an unknown group without facts, and none for a private task", async () => {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-code-group-snapshot-"))), stateDir = join(cwd, ".agenthub/state"); mkdirSync(stateDir, { recursive: true });
  const board = new Board(join(stateDir, "hub.db"));
  const observed = board.propose("user", { title: "observed fixture", class: "implement", refs: { commit: HEAD, paths: ["a.ts"] }, plan: { symbols: ["Alpha.first", "Ghost.plan"] } });
  const bare = board.propose("user", { title: "no facts fixture", class: "implement", refs: { commit: HEAD } });
  const privateTask = board.propose("user", { title: "private fixture", class: "implement", signals: ["pii_path"], refs: { commit: HEAD, paths: ["a.ts"] }, plan: { symbols: ["PRIVATE-PLAN-MARKER"] } });
  board.update(observed.id, "user", "fixture", { owner: "codex", state: "in_progress", codeSymbols: buildTaskCodeSymbols(brief(HEAD, "Alpha.first"), `path:${cwd}`, () => true) }, undefined, {}, undefined, HOST_CODE_SYMBOLS);
  board.update(bare.id, "user", "fixture", { owner: "codex", state: "in_progress" });
  board.update(privateTask.id, "user", "fixture", { owner: "local", state: "in_progress" });
  board.close();
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: freePort(), codexProxyPort: freePort(),
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false } } });
  let client: ControlClient | undefined;
  try {
    client = await ControlClient.connect(stateDir, { role: "console", projectRoot: cwd });
    const snapshot = await client.request({ t: "ui_snapshot", after: 0 });
    const by = (id: number) => snapshot.tasks.find((t: { id: number }) => t.id === id);
    expect(by(observed.id).codeGroup).toMatchObject({ state: "known", head: HEAD.slice(0, 8), symbols: [{ name: "Alpha.first", mark: "matching", id: "symbol:Alpha.first@a.ts" }], untouched: ["Ghost.plan"] });
    expect(by(bare.id).codeGroup).toEqual({ state: "unknown", complete: false, symbols: [], untouched: [], more: 0, counts: { matching: 0, unplanned: 0, untouched: 0 }, planWithheld: 0 });
    expect(by(privateTask.id).codeGroup).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE-PLAN-MARKER");
    expect(JSON.stringify(snapshot.tasks)).not.toContain("repositoryKey");
  } finally { client?.close(); await daemon.stop(); rmSync(cwd, { recursive: true, force: true }); }
});

test("a symbol node reaches the Memory view's graph start through the snapshot input (node cap lifted only for symbol nodes)", async () => {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-code-group-node-"))), stateDir = join(cwd, ".agenthub/state"), previous = process.env.AGENTHUB_HOME;
  mkdirSync(stateDir, { recursive: true });
  process.env.AGENTHUB_HOME = join(cwd, "home");
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: freePort(), codexProxyPort: freePort(),
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: true }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false } } });
  let client: ControlClient | undefined;
  try {
    client = await ControlClient.connect(stateDir, { role: "console", projectRoot: cwd });
    const long = "symbol:" + "n".repeat(300) + "@src/x.ts";
    for (const [node, expected] of [["symbol:Alpha.first@a.ts", "symbol:Alpha.first@a.ts"], [long, long], ["mem:" + "x".repeat(300), undefined], ["symbol:" + "n".repeat(600), undefined]] as const) {
      const reply = await client.request({ t: "ui_snapshot", after: 0, memory: { node } });
      expect(reply.memory?.node, node.slice(0, 24)).toBe(expected);
      if (expected) expect(reply.memory.graph).toBeDefined();
    }
  } finally { client?.close(); await daemon.stop(); rmSync(cwd, { recursive: true, force: true }); if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; }
});
