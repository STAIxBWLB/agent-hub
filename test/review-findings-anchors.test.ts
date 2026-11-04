import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import type { ReviewAnchor, ReviewSelector } from "@staix/agent-console/contract";
import type { ReviewFinding } from "../src/hub/review-findings.ts";

const HEAD = "a".repeat(40), cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function rig() {
  const cwd = mkdtempSync(join(tmpdir(), "review-anchor-flow-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({batchMs: 0});
  const observers: string[] = [], routing = loadRouting(cwd), piiPaths = ["private/**"];
  const tasks = new Tasks({board, bus, cwd, project: "anchor-fixture", repository: "fixture/repo", routing: () => routing,
    piiPaths, notify: line => observers.push(line), share: (_by, line) => observers.push(line),
    sdlc: {config: () => sdlcConfig({mode: "off", required_checks: []}), gh: async args => { observers.push(JSON.stringify(args)); return {code: 1, stdout: ""}; }} });
  cleanup.push(() => {tasks.stopCiWatchers(); bus.closeJournal(); board.close(); rmSync(cwd, {recursive: true, force: true});});
  const create = () => {
    const task = board.propose("user", {title: "synthetic anchored review", class: "implement", refs: {paths: ["report.md", "private/report.md"], commit: HEAD}});
    board.update(task.id, "user", "accepted", {state: "in_progress", owner: "codex", reviewer: "claude"});
    return board.update(task.id, "codex", "done", {state: "in_review"});
  };
  return {board, tasks, create, observers, piiPaths};
}
const finding = (anchor: unknown, path = "report.md") => ({id: "bounded-anchor", pass: "bugs", severity: "important", disposition: "open", path, anchor});

test("Tasks.review stores every published selector and retains the Important obligation on later heads", async () => {
  const r = rig();
  const selectors: ReviewSelector[] = [
    {kind: "lineRange", startLine: 1, endLine: 2},
    {kind: "textQuote", exact: "QUOTE_REVIEW_CANARY", prefix: "", suffix: ""},
    {kind: "diffHunk", hunkHeader: "@@ -1 +1 @@"},
    {kind: "structural", scheme: "heading", ref: "Methods"},
    {kind: "region", x: 1, y: 2, width: 10, height: 5},
  ];
  for (const selector of selectors) {
    const task = r.create(), anchor: ReviewAnchor = {path: "report.md", contentHash: "b".repeat(64), selectors: [selector]};
    const rejected = await r.tasks.review("claude", task.id, "changes_requested", "synthetic finding", undefined, HEAD, undefined, [finding(anchor)]);
    expect(rejected.history.findLast(entry => entry.reviewFindings)?.reviewFindings?.items[0]?.anchor).toEqual(anchor);
    const nextHead = "c".repeat(40);
    r.board.update(task.id, "codex", "accepted", {state: "in_progress"});
    r.board.update(task.id, "codex", "done", {state: "in_review", refs: {...task.refs, commit: nextHead}});
    expect((await r.tasks.lifecycleStatus(task.id)).findings?.openImportant).toBe(1);
  }
  expect(r.observers.join("\n")).not.toContain("QUOTE_REVIEW_CANARY");
});

test("Tasks.review rejects malformed anchors before effects and removes private-path quote selectors", async () => {
  const r = rig(), task = r.create(), before = r.board.get(task.id);
  await expect(r.tasks.review("claude", task.id, "changes_requested", undefined, undefined, HEAD, undefined,
    [finding({path: "elsewhere.md", selectors: [{kind: "lineRange", startLine: 1, endLine: 1}]})])).rejects.toThrow();
  expect(r.board.get(task.id)).toEqual(before);
  const anchor = {path: "private/report.md", selectors: [
    {kind: "lineRange", startLine: 2, endLine: 2},
    {kind: "textQuote", exact: "PRIVATE_QUOTE_CANARY", prefix: "", suffix: ""},
  ]};
  const reviewed = await r.tasks.review("claude", task.id, "changes_requested", undefined, undefined, HEAD, undefined, [finding(anchor, anchor.path)]);
  const stored = reviewed.history.findLast(entry => entry.reviewFindings)?.reviewFindings?.items[0]?.anchor;
  expect(stored?.selectors).toEqual([{kind: "lineRange", startLine: 2, endLine: 2}]);
  expect(JSON.stringify(reviewed)).not.toContain("PRIVATE_QUOTE_CANARY");
  expect(r.observers.join("\n")).not.toContain("PRIVATE_QUOTE_CANARY");
  const another = r.create(), previous = r.board.get(another.id);
  await expect(r.tasks.review("claude", another.id, "changes_requested", undefined, undefined, HEAD, undefined,
    [finding({...anchor, selectors: [anchor.selectors[1]]}, anchor.path)])).rejects.toThrow();
  expect(r.board.get(another.id)).toEqual(previous);
});

test("finding placement rendering never points an outdated or unavailable finding at old lines", async () => {
  const {renderFindingAnchor} = await import("../src/hub/review-brief.ts");
  const item: ReviewFinding = {id: "placement", pass: "bugs", severity: "important", disposition: "open", anchor: {path: "report.md", selectors: [
    {kind: "lineRange", startLine: 7, endLine: 8}, {kind: "textQuote", exact: "RENDER_QUOTE_CANARY", prefix: "", suffix: ""},
  ]}};
  const input = structuredClone(item);
  expect(renderFindingAnchor(input, {status: "anchored"})).toContain("report.md:7-8 (anchored)");
  expect(renderFindingAnchor(input, {status: "moved", range: {startLine: 20, endLine: 21}})).toContain("report.md:20-21 (moved)");
  expect(renderFindingAnchor(input, {status: "outdated"})).toContain("report.md (outdated)");
  expect(renderFindingAnchor(input, {status: "outdated"})).not.toContain("7-8");
  const unavailable = renderFindingAnchor(input, {status: "unavailable"});
  expect(unavailable).not.toContain("report.md"); expect(unavailable).not.toContain("RENDER_QUOTE_CANARY");
  expect(renderFindingAnchor({id: "legacy", pass: "bugs", severity: "important", disposition: "open"}, {status: "unavailable"})).toBe("");
  expect(input).toEqual(item);
});

test("a later private-path upgrade withholds old anchor quotes even when finding.path was omitted", async () => {
  const r = rig(), task = r.create();
  const input = {id: "late-private", pass: "bugs", severity: "important", disposition: "open", anchor: {path: "report.md", selectors: [
    {kind: "textQuote", exact: "LATER_PRIVATE_QUOTE_CANARY", prefix: "", suffix: ""},
  ]}};
  const stored = await r.tasks.review("claude", task.id, "changes_requested", undefined, undefined, HEAD, undefined, [input]);
  expect(JSON.stringify(r.tasks.publicView(stored, true))).toContain("LATER_PRIVATE_QUOTE_CANARY");
  r.piiPaths.push("report.md");
  const view = r.tasks.publicView(r.board.get(task.id)!, true);
  expect(JSON.stringify(view)).not.toContain("LATER_PRIVATE_QUOTE_CANARY");
  expect(JSON.stringify(view)).toContain('"withheld":true');
  expect(JSON.stringify(r.board.get(task.id))).toContain("LATER_PRIVATE_QUOTE_CANARY");
});
