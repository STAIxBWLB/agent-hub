import { expect, test } from "bun:test";
import { classifyPr, MONOLITH, summarize } from "../scripts/spec-dogfood-report.ts";

// #1064 T6: the co-change share is the AC11 metric, so its classification is pinned here.
const bus = { id: "bus", path: "docs/design/bus.md" }, board = { id: "task-board", path: "docs/design/task-board.md" };

test("#1064 T6 a PR touching no dogfood path does not count, whatever else it changes", () => {
  expect(classifyPr(["README.md", "docs/design/bus.md"], [])).toEqual({ touches: false, specChanged: false, ids: [] });
});

test("#1064 T6 in the dogfood window a PR co-changes when it changes any covering spec file, and not the monolith", () => {
  expect(classifyPr(["src/hub/bus.ts", "docs/design/bus.md"], [bus])).toEqual({ touches: true, specChanged: true, ids: ["bus"] });
  expect(classifyPr(["src/hub/bus.ts", "src/hub/tasks.ts", "docs/design/task-board.md"], [bus, board])).toMatchObject({ specChanged: true, ids: ["bus", "task-board"] });
  expect(classifyPr(["src/hub/bus.ts", MONOLITH], [bus])).toMatchObject({ touches: true, specChanged: false });
});

test("#1064 T6 in the baseline window only the monolith counts as the owning document", () => {
  expect(classifyPr(["src/hub/bus.ts", MONOLITH], [bus], MONOLITH)).toMatchObject({ touches: true, specChanged: true });
  expect(classifyPr(["src/hub/bus.ts", "docs/design/bus.md"], [bus], MONOLITH)).toMatchObject({ touches: true, specChanged: false });
});

test("#1064 T6 summarize counts touching PRs and the share, with no share when nothing touched", () => {
  expect(summarize([{ touches: true, specChanged: true, ids: ["bus"] }, { touches: true, specChanged: false, ids: ["bus"] }, { touches: false, specChanged: false, ids: [] }]))
    .toEqual({ prs: 3, touching: 2, coChanged: 1, share: 0.5 });
  expect(summarize([{ touches: false, specChanged: false, ids: [] }])).toEqual({ prs: 1, touching: 0, coChanged: 0, share: null });
});
