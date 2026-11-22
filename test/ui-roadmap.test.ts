import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { DASHBOARD_VIEWS, renderDashboard } from "../src/hub/ui.ts";
import { roadmapModel, type RoadmapMilestoneInput } from "../src/ui/roadmap-model.ts";

/** A milestone view as the hub projects it, with only the fields the card projection reads. */
function view(id: number, overrides: Partial<RoadmapMilestoneInput> = {}): RoadmapMilestoneInput {
  return {
    id, title: "milestone " + id, outcome: "outcome " + id, state: "active", horizon: "now", order: 0,
    target: null, revision: 0, withheld: 0,
    rollup: {
      tasks: { approved: 0, total: 0 },
      issues: { closed: 0, total: 0, unknown: 0 },
      specs: { fresh: 0, stale: 0, unverified: 0, unknown: 0, total: 0 },
      releases: { shipped: 0, total: 0, unknown: 0 },
    },
    ...overrides,
  };
}

test("the roadmap lanes hold each milestone by horizon, ordered by its own order", () => {
  const model = roadmapModel([
    view(3, { horizon: "later", order: 1 }),
    view(1, { horizon: "now", order: 2 }),
    view(2, { horizon: "now", order: 1 }),
    view(4, { horizon: "next", order: 0 }),
  ]);
  expect(model.lanes.map(lane => [lane.id, lane.label, lane.cards.map(card => card.id)])).toEqual([
    ["now", "Now", [2, 1]],
    ["next", "Next", [4]],
    ["later", "Later", [3]],
  ]);
  expect(model.cards.map(card => card.id)).toEqual([4, 2, 3, 1]);
});

test("a horizon the hub does not define lands in Later instead of disappearing", () => {
  const model = roadmapModel([view(1, { horizon: "someday" })]);
  expect(model.lanes.map(lane => lane.cards.map(card => card.id))).toEqual([[], [], [1]]);
});

test("a card reports progress as unknown without members, never as zero", () => {
  const empty = roadmapModel([view(1)]).cards[0]!;
  expect(empty.percent).toBeNull();
  expect(empty.progress).toBe("no tasks yet");
  const partial = roadmapModel([view(2, { rollup: { ...view(2).rollup, tasks: { approved: 1, total: 3 } } })]).cards[0]!;
  expect(partial.percent).toBe(33);
  expect(partial.progress).toBe("1 of 3 tasks approved");
  const complete = roadmapModel([view(3, { rollup: { ...view(3).rollup, tasks: { approved: 2, total: 2 } } })]).cards[0]!;
  expect(complete.percent).toBe(100);
});

test("the chips carry spec freshness, trains and the withheld count, and a private member is a count", () => {
  const card = roadmapModel([view(7, {
    withheld: 2,
    rollup: {
      tasks: { approved: 3, total: 4 },
      issues: { closed: 1, total: 2, unknown: 1 },
      specs: { fresh: 1, stale: 2, unverified: 0, unknown: 3, total: 6 },
      releases: { shipped: 1, total: 2, unknown: 0 },
    },
  })]).cards[0]!;
  expect(card.chips).toEqual({ fresh: 1, stale: 2, unverified: 0, unknownSpecs: 3, trains: 2, withheld: 2 });
  expect(card.specText).toBe("specs fresh 1, stale 2, unknown 3");
  expect(card.issueText).toBe("issues 1/2 closed, 1 unknown");
  expect(card.target).toBe("");
});

test("the injected page model is the module's own projection", () => {
  const html = renderDashboard().html;
  const source = /const roadmapModel = ([\s\S]*?);\nconst officeModel = /.exec(html)?.[1];
  expect(source).toBeDefined();
  const pages = runInNewContext("(" + source + ")") as typeof roadmapModel;
  const views = [view(1, { horizon: "next", order: 3 }), view(2, { rollup: { ...view(2).rollup, tasks: { approved: 1, total: 4 } } })];
  expect(JSON.parse(JSON.stringify(pages(views)))).toEqual(JSON.parse(JSON.stringify(roadmapModel(views))));
});

test("the dashboard has eight views, key 8 is the roadmap, and every view has a nav button", () => {
  expect(DASHBOARD_VIEWS).toHaveLength(8);
  expect(DASHBOARD_VIEWS[7]).toBe("roadmap");
  const html = renderDashboard().html;
  for (const name of DASHBOARD_VIEWS) expect(html).toContain(`data-view-target="${name}"`);
  expect(html).toContain('<kbd>1</kbd>-<kbd>8</kbd>');
  expect(html).toContain('data-view="roadmap"');
});

test("the roadmap view writes text through textContent only", () => {
  const html = renderDashboard().html;
  const start = html.indexOf("// #1483 R5: the roadmap view.");
  const end = html.indexOf("function render(snapshot) {", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const block = html.slice(start, end);
  expect(block).not.toContain("innerHTML");
  expect(block).not.toContain("insertAdjacentHTML");
  expect(block).toContain("textContent");
});

test("a management action carries the revision it rendered and the hub refuses a stale one", () => {
  const html = renderDashboard().html;
  const start = html.indexOf("// #1483 R5: the roadmap view.");
  const block = html.slice(start, html.indexOf("function render(snapshot) {", start));
  // Every write payload names the revision the page rendered; the hub compares it before it writes.
  const payloads = block.match(/roadmapPost\(\{[^}]*\}\)/g) ?? [];
  const writes = payloads.filter(payload => /action:'roadmap_(edit|link|unlink|move|state)'/.test(payload) || /action:actionName, id:/.test(payload));
  // move, state, edit, and the one link/unlink call site that carries both verbs; creation has no revision to fence.
  expect(writes.length).toBe(4);
  for (const payload of writes) expect(payload).toMatch(/revision[:,}]/);
  // A drag carries the revision it rendered too, so a stale drop is refused rather than applied.
  expect(block).toContain("typeof payload.revision !== 'number'");
});
