import { afterEach, expect, test } from "bun:test";
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

  const daily = rollup.daily(14);
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
