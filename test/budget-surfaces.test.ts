import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { projectionText, windowLeft, type ExhaustionProjection } from "../src/hub/budget-projection.ts";
import { publicPeerBudget } from "../src/hub/conductor.ts";
import { renderDashboard } from "../src/hub/ui.ts";
import { renderBudget } from "../src/cli/output.ts";
import { usageCells } from "../src/cli/console-usage.ts";

// #1513 AC2: the dashboard, the console and `ahub budget` render one window view, so they cannot disagree.
const now = 1_760_000_000_000;
const projection: ExhaustionProjection = { state: "projected", at: now + 3_600_000, basis: "lookback" };
const window = { id: "5h" as const, kind: "native" as const, used: 0.4, at: now, stale: false, superseded: false, resetsAt: now + 7_200_000, source: "codex", left: windowLeft(0.4), projection };
const text = (projection: ExhaustionProjection) => projectionText(projection, () => "in 1h");

test("#1513 AC2 the public budget projection carries the remainder and the forecast", () => {
  const publicBudget = publicPeerBudget({ codex: { windows: [window] } }, () => true) as any;
  expect(publicBudget.codex.windows[0]).toMatchObject({ left: 0.6, projection: { state: "projected", at: now + 3_600_000 } });
  // An older hub sends neither field, and the projection must not invent one.
  const legacy = publicPeerBudget({ codex: { windows: [{ id: "5h" as const, kind: "native", used: 0.4, at: now, stale: false, source: "codex" }] } }, () => true) as any;
  expect(legacy.codex.windows[0].left).toBeUndefined();
  expect(legacy.codex.windows[0].projection).toBeUndefined();
});

test("#1513 AC2 the budget table prints LEFT and the same forecast the console and the page print", () => {
  const table = JSON.stringify(renderBudget({ budget: { codex: { windows: [window] } }, gate: 0.8 } as any, 200, now));
  expect(table).toContain("LEFT");
  expect(table).toContain("REACHES");
  expect(table).toContain("60%");
  expect(table).toContain("reaches its limit in 1h");
  // Unknown never becomes a date, on any surface.
  const unknown = JSON.stringify(renderBudget({ budget: { codex: { windows: [{ ...window, projection: { state: "unknown", cause: "no_burn" } }] } }, gate: 0.8 } as any, 200, now));
  expect(unknown).toContain("no forecast: no burn yet");
});

test("#1513 AC2 the console cell carries the same remainder and forecast", () => {
  const cells = usageCells(undefined, "codex", { windows: [window] }, at => "in " + (at === now + 3_600_000 ? "1h" : "2h"));
  expect(cells[5]).toContain("40%");
  expect(cells[5]).toContain("60% left");
  expect(cells[5]).toContain("reaches its limit 1h");
});

test("#1513 AC2 the page renders the same sentence from the same causes", () => {
  const html = renderDashboard().html;
  const start = html.indexOf("const PROJECTION_CAUSE");
  const fnStart = html.indexOf("function projectionText", start);
  expect(start).toBeGreaterThan(0);
  expect(fnStart).toBeGreaterThan(start);
  const end = html.indexOf("\n}", fnStart) + 2;
  const block = html.slice(start, end);
  expect(block).not.toContain("innerHTML");
  const pageText = runInNewContext(`(() => { ${block} return projectionText; })()`) as (p: unknown, when: (at: number) => string) => string;
  for (const value of [projection, { state: "unknown", cause: "few_points" }, { state: "unknown", cause: "no_burn" }, { state: "unknown", cause: "reset_first" }, { state: "unknown", cause: "unknown_usage" }, { state: "projected", at: now + 60_000, basis: "window" }] as ExhaustionProjection[])
    expect(pageText(value, () => "in 1h")).toBe(projectionText(value, () => "in 1h"));
  // The row itself is wired to the page's window loop, or the sentence would have no reader.
  expect(html).toContain("projectionText(window.projection, rel)");
  expect(html).toContain("% left");
});
