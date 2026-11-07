import { expect, test } from "bun:test";
import { classifyPr, isReleaseMerge, MONOLITH, summarize, windowInstant } from "../scripts/spec-dogfood-report.ts";

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

test("#1064 T6 a release PR's merge commit is not a PR of its own, an ordinary squash or merge is", () => {
  expect(isReleaseMerge("Merge pull request #1252 from STAIxBWLB/release/0.34.0")).toBe(true);
  expect(isReleaseMerge("feat(upgrade): confirmed reattach of orphaned-but-connected Orca terminals (#1249)")).toBe(false);
  expect(isReleaseMerge("Merge pull request #900 from STAIxBWLB/feat/rooms")).toBe(false);
});

test("#1064 T6 a date-only window bound is midnight UTC, an explicit instant or offset is kept, and garbage is refused", () => {
  expect(windowInstant("2026-10-05")).toBe("2026-10-05T00:00:00.000Z");
  expect(windowInstant("2026-11-02T19:41:16Z")).toBe("2026-11-02T19:41:16.000Z");
  expect(windowInstant("2026-11-02T19:41:16+09:00")).toBe("2026-11-02T10:41:16.000Z");
  expect(() => windowInstant("last week")).toThrow("not a date or an ISO instant");
  expect(() => windowInstant("2026-11-02T19:41:16")).toThrow("with Z or an offset");   // no zone: would be read in the local timezone
});
