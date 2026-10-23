import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { emulatedBoundedTools } from "./fakes/bounded-capabilities.ts";
import { realPath } from "../src/hub/project.ts";
import { runInNewContext } from "node:vm";
import { contrast } from "../src/ui/peer-palette.ts";
import { mkdtempSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageRollup } from "../src/hub/usage-rollup.ts";
import type { HubEvent } from "../src/hub/events.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-usage-view-")); dirs.push(dir);
  const log = join(dir, "events.jsonl");
  let second = 0;
  const line = (e: HubEvent, day = 10) => JSON.stringify({ v: 1, at: new Date(Date.UTC(2026, 9, day, 0, 0, second++)).toISOString(), ...e }) + "\n";
  const write = (events: [HubEvent, number?][]) => appendFileSync(log, events.map(([e, d]) => line(e, d)).join(""));
  const open = () => new UsageRollup(join(dir, "hub.db"), log);
  return { dir, log, write, open };
}

const task = (id: number, state = "in_progress", extra: Record<string, unknown> = {}) => ({ type: "task", id, state, class: "implement", event: state, by: "codex", owner: "codex", reviewer: "claude", pii: false, ...extra }) as HubEvent;
const tokens = (peer: string, n: number, t?: number): HubEvent => ({ type: "tokens", peer, n, ...(t ? { task: t, attribution: "delivery" as const } : { attribution: "unattributed" as const }) });
const usage = (peer: string, id: string, c: Record<string, number>, t?: number, extra: Record<string, unknown> = {}): HubEvent =>
  ({ type: "usage", peer, source: "codex_appserver", id, ...c, ...(t ? { task: t, attribution: "delivery" as const } : { attribution: "unattributed" as const }), ...extra }) as HubEvent;

test("UsageRollup.daily returns stacked daily tokens per peer and day totals (#683 U4)", () => {
  const f = fixture();
  f.write([
    [task(1)], [task(2, "in_progress", { pii: true })],
    [tokens("codex", 1000, 1), 10], [usage("codex", "u1", { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 }, 1), 10],
    [tokens("claude", 2000, 1), 10],
    [tokens("jcode", 500), 11],
    [tokens("codex", 300, 2), 11], [usage("codex", "u2", { inputTokens: 300, outputTokens: 20, totalTokens: 320 }, 2, { pii: true }), 11],
  ]);
  const rollup = f.open();
  rollup.catchUp();

  const daily = rollup.daily(14, Date.UTC(2026, 9, 11, 12));
  expect(daily.days.length).toBe(2);
  expect(daily.peers).toContain("claude");
  expect(daily.peers).toContain("codex");
  expect(daily.peers).toContain("jcode");

  const day10 = daily.days.find(d => d.day === "2026-10-10");
  expect(day10).toBeDefined();
  expect(day10!.peers.codex).toEqual({ value: 1050, source: "native" });
  expect(day10!.peers.claude).toEqual({ value: 2000, source: "count" });
  expect(day10!.peers.jcode).toEqual({ value: null, source: "unknown" });
  expect(day10!.total.value).toBe(3050);
  expect(day10!.total.source).toBe("partial"); // jcode was unknown

  const day11 = daily.days.find(d => d.day === "2026-10-11");
  expect(day11).toBeDefined();
  expect(day11!.peers.codex).toEqual({ value: 320, source: "native" });
  expect(day11!.peers.jcode).toEqual({ value: 500, source: "count" });

  rollup.close();
});

test("dashboard index.html contains all Usage view components and design token rules (#683 U4)", () => {
  const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");

  // Section with Usage budgets & tokens exists and has required elements
  expect(html).toContain('id="budget-title"');
  expect(html).toContain('id="usage-lifetime-total"');
  expect(html).toContain('id="usage-lifetime-nocache"');
  expect(html).toContain('id="usage-lifetime-cache"');
  expect(html).toContain('id="usage-coverage-note"');
  expect(html).toContain('id="usage-daily-chart"');
  expect(html).toContain('id="usage-daily-legend"');
  expect(html).toContain('id="usage-paused-alert"');
  expect(html).toContain('id="usage-limits-tbody"');
  expect(html).toContain('id="usage-task-table"');
  expect(html).toContain('id="usage-task-tbody"');

  // CSS rules use tokens only (no hardcoded color literals outside :root)
  const dashboardCss = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
  const lightBlock = /:root\{([^}]+)\}/.exec(dashboardCss)![1]!;
  const darkBlock = /:root\[data-theme="dark"\]\{([^}]+)\}/.exec(dashboardCss)![1]!;
  const systemDarkBlock = /@media\(prefers-color-scheme:dark\)\{:root:not\(\[data-theme="light"\]\):not\(\[data-theme="dark"\]\)\{([^}]+)\}\}/.exec(dashboardCss)![1]!;
  const cssWithoutComments = dashboardCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const strip = (block: string) => block.replace(/\/\*[\s\S]*?\*\//g, "");
  const outside = cssWithoutComments.replace(strip(lightBlock), "").replace(strip(darkBlock), "").replace(strip(systemDarkBlock), "");
  const strays = [...outside.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g)].map(m => m[0]);
  expect(strays).toEqual([]);

  // Render loop calls renderUsage
  expect(html).toContain('renderUsage(snapshot.usage, snapshot.tasks, snapshot.budget)');
  expect(html).toContain('function renderUsage(');
  expect(html).toContain('function formatCounter(');

  // Responsive / phone width media query exists
  expect(html).toContain('@media(max-width:600px){.usage-summary-grid{grid-template-columns:1fr}}');
});

test("daily fills the calendar days inside the window as empty columns, never as zero, and never starts before the first record (#683 U4)", () => {
  const f = fixture();
  f.write([[tokens("codex", 1000), 10], [tokens("codex", 500), 13]]);
  const rollup = f.open();
  rollup.catchUp();
  const daily = rollup.daily(14, Date.UTC(2026, 9, 14, 6));
  expect(daily.days.map(d => d.day)).toEqual(["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"]);
  expect(daily.days.map(d => d.empty === true)).toEqual([false, true, true, false, true]);
  for (const gap of daily.days.filter(d => d.empty)) { expect(gap.total).toEqual({ value: null, source: "unknown" }); expect(gap.peers.codex).toEqual({ value: null, source: "unknown" }); }
  expect(rollup.daily(2, Date.UTC(2026, 9, 14, 6)).days.map(d => d.day)).toEqual(["2026-10-13", "2026-10-14"]);
  expect(f.open().daily(14, Date.UTC(2026, 9, 14)).days.length).toBe(5);
  rollup.close();
  const none = fixture(); const empty = none.open();
  expect(empty.daily(14).days).toEqual([]);
  empty.close();
});

// A minimal DOM: just what renderUsage touches, so the page's own functions run over a snapshot fixture.
class Node {
  children: Node[] = []; textContent = ""; className = ""; hidden = false; title = ""; colSpan = 0; style: Record<string, string> = {}; tag: string;
  classes = new Set<string>();
  constructor(tag = "div") { this.tag = tag; }
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.children = nodes; }
  classList = { toggle: (name: string, on: boolean) => { if (on) this.classes.add(name); else this.classes.delete(name); } };
  text(): string { return [this.textContent, ...this.children.map(child => child.text())].join(" "); }
  all(): Node[] { return [this, ...this.children.flatMap(child => child.all())]; }
}
const IDS = ["usage-lifetime-total", "usage-lifetime-total-sub", "usage-lifetime-nocache", "usage-lifetime-cache", "usage-coverage-note", "usage-daily-chart", "usage-daily-legend", "usage-daily-meta", "usage-paused-alert", "usage-budget-windows", "usage-limits-tbody", "usage-task-tbody", "usage-task-count"];
function usageRig() {
  const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
  const start = html.indexOf("function formatCounter("), end = html.indexOf("renderUsage(snapshot.usage");
  const source = html.slice(html.lastIndexOf("function formatCounter(", end), html.indexOf("\n}\n", html.indexOf("function renderUsage(")) + 3);
  expect(start).toBeGreaterThan(0);
  const nodes = new Map<string, Node>(IDS.map(id => [id, new Node()]));
  const api = runInNewContext(`${source};({ renderUsage, formatCounter })`, {
    $: (id: string) => nodes.get(id)!, el: (tag: string, text?: string, cls?: string) => { const n = new Node(tag); if (text !== undefined) n.textContent = String(text); if (cls) { n.className = cls; for (const c of cls.split(" ")) n.classes.add(c); } return n; },
    rel: (v: number) => "in " + v, time: (v: number) => "t" + v,
  }) as { renderUsage(usage: unknown, tasks: unknown, budget: unknown): void; formatCounter(c: unknown, exact?: boolean): string };
  const dom = () => [...nodes.values()].map(n => n.text()).join("\n");
  return { api, nodes, dom };
}
const counter = (value: number | null, source = "native") => ({ value, source: value === null ? "unknown" : source });
const MARKER = "PRIVATE-TITLE-MARKER-9f3a";
const fixtureSnapshot = (extra: Record<string, unknown> = {}) => ({
  usage: {
    behind: false,
    total: { since: "2026-10-01T00:00:00Z", peers: [], overall: { tokens: counter(12000, "partial"), withoutCache: counter(null), cacheRead: counter(3000) }, unknownPeers: { tokens: ["jcode"], withoutCache: ["jcode"], cacheRead: [] } },
    daily: { peers: ["claude", "codex"], days: [
      { day: "2026-10-10", peers: { claude: counter(2000, "count"), codex: counter(1050) }, total: counter(3050, "partial") },
      { day: "2026-10-11", peers: { claude: counter(null), codex: counter(null) }, total: counter(null), empty: true },
    ] },
    limits: { open: [{ peer: "codex", window: "5h", resetsAt: 5 }], history: [{ at: "2026-10-10T01:00:00Z", type: "budget_pause", peer: "codex", window: "5h", detail: { used: 0.91, resetsAt: 7 } }] },
    tasks: [
      { id: 7, pii: false, input: counter(10), output: counter(20), cacheRead: counter(null), cacheWrite: counter(null), total: counter(30), counted: counter(30) },
      { id: 8, pii: true, input: counter(1), output: counter(1), cacheRead: counter(null), cacheWrite: counter(null), total: counter(2), counted: counter(2) },
    ],
    ...extra,
  },
  tasks: [
    { id: 7, title: "Fix #7: public title", state: "in_progress", owner: "codex", refs: { branch: "fix/7" } },
    { id: 8, title: "[pii]", state: "in_progress", owner: "codex", refs: {} },
    { id: 9, title: "[pii]", state: "proposed", owner: null, refs: {} },
  ],
});

test("renderUsage from a snapshot fixture: a PII task shows only its id and tag, unknown is never zero (#683 U4 AC)", () => {
  const { api, nodes, dom } = usageRig();
  const snapshot = fixtureSnapshot();
  // A snapshot never carries a private title (publicView withholds it); a leak would have to come from the page, so a title that
  // still holds the marker in a PII row's board entry must not reach the DOM through any column.
  (snapshot.tasks[1] as { detail?: string }).detail = MARKER;
  api.renderUsage(snapshot.usage, snapshot.tasks, undefined);
  const text = dom();
  expect(text).not.toContain(MARKER);
  const rows = nodes.get("usage-task-tbody")!.children;
  const piiRows = rows.filter(row => row.text().includes("[pii]"));
  expect(piiRows.map(row => row.children[0]!.text().trim())).toEqual(["#9 [pii]", "#8 [pii]"]);
  expect(piiRows[1]!.all().some(n => n.classes.has("usage-tag") && n.classes.has("pii"))).toBe(true);
  expect(rows.find(row => row.text().includes("public title"))).toBeTruthy();
  // Unknown stays the word, never 0: the private-free cells with no value, the lifetime cache write and the "without cache" total.
  expect(nodes.get("usage-lifetime-nocache")!.textContent).toBe("unknown");
  expect(rows.at(-1)!.children[6]!.textContent).toBe("unknown");
  expect(nodes.get("usage-lifetime-total")!.textContent).toContain("at least");
  expect(nodes.get("usage-lifetime-total-sub")!.textContent).toBe("Unknown: jcode");
  for (const cell of rows.flatMap(row => row.children.slice(4))) expect(cell.textContent).not.toBe("0");
  // A day with no record is a gap that says so, not a zero column.
  expect(nodes.get("usage-daily-chart")!.text()).toContain("no record");
  expect(nodes.get("usage-daily-chart")!.all().filter(n => n.classes.has("usage-bar-segment")).length).toBe(2);
});

test("renderUsage says the figures are a lower bound while the roll-up is behind, and clears it once caught up (#683 U4)", () => {
  const { api, nodes } = usageRig();
  api.renderUsage(fixtureSnapshot({ behind: true }).usage, [], undefined);
  expect(nodes.get("usage-coverage-note")!.textContent).toContain("lower bound");
  expect(nodes.get("usage-coverage-note")!.classes.has("usage-behind")).toBe(true);
  api.renderUsage(fixtureSnapshot({ behind: false }).usage, [], undefined);
  expect(nodes.get("usage-coverage-note")!.textContent).not.toContain("lower bound");
  expect(nodes.get("usage-coverage-note")!.classes.has("usage-behind")).toBe(false);
  api.renderUsage(undefined, [], undefined); // a hidden view sends no usage: nothing changes and nothing throws
});

test("the Usage view's colours are token pairs that pass contrast in both themes, and it reflows at phone width (#683 U4 AC)", () => {
  const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
  const css = html.match(/<style>([\s\S]*?)<\/style>/)![1]!.replace(/\/\*[\s\S]*?\*\//g, "");
  const light = /:root\{([^}]+)\}/.exec(css)![1]!, dark = /:root\[data-theme="dark"\]\{([^}]+)\}/.exec(css)![1]!;
  const tokens = (block: string) => new Map([...block.matchAll(/--([a-z0-9-]+):#([0-9a-f]{6})\b/g)].map(m => [m[1]!, "#" + m[2]!]));
  const rules = [...css.matchAll(/(\.usage-[^{]+|\.meta\.usage-behind)\{([^}]*)\}/g)].map(m => ({ selector: m[1]!, body: m[2]! }));
  expect(rules.length).toBeGreaterThan(10);
  const used = (body: string, prop: string) => new RegExp("(?:^|;)" + prop + ":var\\(--([a-z0-9-]+)\\)").exec(body)?.[1];
  const pairs: [string, string, string, number][] = [];
  for (const { selector, body } of rules) {
    const fg = used(body, "color"), bg = used(body, "background") ?? used(body, "background-color");
    if (fg && bg) pairs.push([selector, fg, bg, 4.5]);
  }
  // The classes the finding names: the PII tag and the behind note carry text on a soft state surface.
  expect(pairs.map(p => p[0])).toContain(".usage-tag.pii");
  expect(pairs.map(p => p[0])).toContain(".meta.usage-behind");
  for (const [theme, block] of [["light", light], ["dark", dark]] as const) {
    const t = tokens(block);
    for (const [selector, fg, bg, need] of pairs) expect(contrast(t.get(fg)!, t.get(bg)!), `${theme} ${selector} ${fg} on ${bg}`).toBeGreaterThanOrEqual(need);
    // Text on the surfaces the view paints (cards, blocks, table heads, hover rows).
    for (const surface of ["panel", "panel-soft", "hover"]) for (const name of ["ink", "muted"]) expect(contrast(t.get(name)!, t.get(surface)!), `${theme} ${name} on ${surface}`).toBeGreaterThanOrEqual(4.5);
  }
  // Chart segments are painted from the peer colour token, which the palette test holds to 3:1 on every surface in both themes.
  expect(css).toContain(".peer-color-dot{");
  expect(html).toContain("seg.style.backgroundColor = 'var(--peer-color)'");
  // Phone width: the summary grid is one column and tables and the chart scroll inside themselves instead of the page.
  expect(css).toMatch(/@media\(max-width:600px\)\{\.usage-summary-grid\{grid-template-columns:1fr\}\}/);
  expect(css).toMatch(/\.usage-table-wrap\{overflow-x:auto;max-width:100%\}/);
  expect(css).toMatch(/\.usage-chart-wrap\{overflow-x:auto/);
  expect(css).toMatch(/\.usage-block\{[^}]*min-width:0/);
});

test("the daemon builds usage only while the Agents view is open, and says when the roll-up is behind (#683 U4)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-usage-snapshot-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home");
  const stateDir = join(root, ".agenthub/state"); mkdirSync(stateDir, { recursive: true });
  const daemon = await startDaemon({ boundedTools: emulatedBoundedTools(), cwd: root, stateDir, projectId: "usage-snapshot", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [] } } });
  const client = await ControlClient.connect(stateDir, { role: "console" });
  try {
    const url = new URL((await client.request({ t: "ui" })).url);
    const post = (path: string, body: unknown, cookie?: string) => fetch(`${url.origin}${path}`, { method: "POST", headers: { origin: url.origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const cookie = (await post("/session", { ticket: url.hash.slice(1) })).headers.get("set-cookie")!.split(";")[0]!;
    const snapshot = (input: Record<string, unknown>) => post("/snapshot", { after: 0, ...input }, cookie).then(response => response.json() as Promise<any>);
    expect((await snapshot({})).usage).toBeUndefined();
    expect((await snapshot({ view: "board" })).usage).toBeUndefined();
    expect((await snapshot({ view: "memory" })).usage).toBeUndefined();
    const open = (await snapshot({ view: "agents" })).usage;
    expect(open).toBeDefined();
    expect(open.behind).toBe(false);
    expect(open.daily.days).toEqual([]);
    expect(Array.isArray(open.tasks)).toBe(true);
    expect(JSON.stringify(open)).not.toMatch(/"title"/);
  } finally { client.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; }
});
