import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { dogfoodPiiInventory, dogfoodPrs, dogfoodTasks, readDogfood } from "../src/hub/dogfood-read.ts";
import type { SdlcGh } from "../src/hub/sdlc.ts";

// #1147: the scorecard read the newest 500 board rows with no window, so a board over 500 tasks never knew its PR flow.
const fixture = () => { const root = mkdtempSync(join(tmpdir(), "ahub-dogfood-read-")); return { root, close: () => rmSync(root, { recursive: true, force: true }) }; };
const at = (n: number) => new Date(n).toISOString();
type Row = { id: number; created: number; updated: number; signals?: string; sdlc?: string | null; history?: string };
function board(file: string, rows: Row[]) {
  const db = new Database(file);
  db.run("CREATE TABLE tasks(id INTEGER PRIMARY KEY, created INTEGER, updated INTEGER, signals TEXT NOT NULL DEFAULT '[]', sdlc TEXT, history TEXT NOT NULL DEFAULT '[]')");
  const insert = db.query("INSERT INTO tasks(id,created,updated,signals,sdlc,history) VALUES(?,?,?,?,?,?)");
  db.transaction(() => { for (const r of rows) insert.run(r.id, r.created, r.updated, r.signals ?? "[]", r.sdlc ?? null, r.history ?? "[]"); })();
  db.close();
}
/** 700 old tasks (outside the window), one PII task linked to merged PR 2 and one ordinary task linked to PR 3, both in the window. */
const bigBoard = (extra: Row[] = []): Row[] => [
  ...Array.from({ length: 700 }, (_, i) => ({ id: i + 1, created: 10, updated: 20 })),
  { id: 701, created: 5000, updated: 6000, signals: '["pii"]', sdlc: JSON.stringify({ repo: "o/r", pr: 2 }), history: '[{"at":5000,"by":"x","event":"proposed","note":"SECRET"}]' },
  { id: 702, created: 5000, updated: 6000, sdlc: JSON.stringify({ repo: "o/r", pr: 3 }), history: '[{"at":5000,"by":"x","event":"proposed"},{"at":5500,"by":"x","event":"approved"}]' },
  ...extra,
];
const ghWith = (calls: string[][]): SdlcGh => async args => {
  calls.push(args);
  if (args[0] === "repo") return { code: 0, stdout: '{"nameWithOwner":"o/r"}' };
  if (args[0] === "pr") return { code: 0, stdout: JSON.stringify([{ number: 2, mergedAt: at(7000), createdAt: at(5000) }, { number: 3, mergedAt: at(7000), createdAt: at(5000) }]) };
  if (String(args[1]).includes("actions/workflows")) return { code: 0, stdout: '{"total_count":0,"workflow_runs":[]}' };
  return { code: 1, stdout: "" };
};

test("a board over 500 tasks reads complete once windowed, and the old unwindowed read stays incomplete", () => {
  const f = fixture(); try {
    const file = join(f.root, "hub.db"); board(file, bigBoard());
    const whole = dogfoodTasks(file); expect(whole.complete).toBe(false); expect(whole.data).toHaveLength(500);
    const win = dogfoodTasks(file, { since: 1000, until: 10000 });
    expect(win).toMatchObject({ available: true, complete: true }); expect(win.data.map(t => t.id).sort()).toEqual([701, 702]);
    expect(JSON.stringify(win)).not.toContain("SECRET");
  } finally { f.close(); }
});

test("the window keeps tasks that overlap it and drops the rest", () => {
  const f = fixture(); try {
    const file = join(f.root, "hub.db");
    board(file, [{ id: 1, created: 100, updated: 900 }, { id: 2, created: 100, updated: 1000 }, { id: 3, created: 5000, updated: 6000 }, { id: 4, created: 10000, updated: 11000 }, { id: 5, created: 10001, updated: 11000 }]);
    expect(dogfoodTasks(file, { since: 1000, until: 10000 }).data.map(t => t.id).sort()).toEqual([2, 3, 4]);
  } finally { f.close(); }
});

test("a windowed read of a legacy board without created/updated columns falls back to the newest rows", () => {
  const f = fixture(); try {
    const file = join(f.root, "hub.db"), db = new Database(file); db.run("CREATE TABLE tasks(id INTEGER,sdlc TEXT,signals TEXT,history TEXT)"); db.query("INSERT INTO tasks VALUES(1,NULL,'[]','[]')").run(); db.close();
    expect(dogfoodTasks(file, { since: 1000, until: 10000 })).toMatchObject({ available: true, complete: true });
  } finally { f.close(); }
});

test("the PII inventory is read completely from outside the window and holds only ids and PR refs", () => {
  const f = fixture(); try {
    const file = join(f.root, "hub.db"); board(file, [...bigBoard(), { id: 703, created: 5, updated: 6, signals: '["pii_path"]', sdlc: JSON.stringify({ repo: "o/r", pr: 9 }), history: '[{"at":5,"by":"x","event":"proposed","note":"SECRET"}]' }]);
    const inv = dogfoodPiiInventory(file);
    expect(inv).toMatchObject({ available: true, complete: true });
    expect(inv.data).toEqual([{ id: 703, repo: "o/r", pr: 9 }, { id: 701, repo: "o/r", pr: 2 }]);
    expect(JSON.stringify(inv)).not.toContain("SECRET");
  } finally { f.close(); }
});

test("a row whose signals cannot be read, or a PII receipt that cannot be parsed, makes the inventory incomplete", () => {
  for (const bad of [{ signals: "not json" }, { signals: '{"pii":true}' }, { signals: "x".repeat(65537) }, { signals: '["pii"]', sdlc: "not json" }, { signals: '["pii"]', sdlc: JSON.stringify({ pr: 2, pad: "x".repeat(65536) }) }]) {
    const f = fixture(); try {
      const file = join(f.root, "hub.db"); board(file, [{ id: 1, created: 1, updated: 1, ...bad }]);
      expect(dogfoodPiiInventory(file).complete, JSON.stringify(bad).slice(0, 40)).toBe(false);
    } finally { f.close(); }
  }
  expect(dogfoodPiiInventory("/nonexistent/hub.db").available).toBe(false);
});

test("a PII inventory over its cap stays incomplete and forbids every per-PR read", async () => {
  const f = fixture(); try {
    const file = join(f.root, "hub.db");
    board(file, Array.from({ length: 2001 }, (_, i) => ({ id: i + 1, created: 5000, updated: 6000, signals: '["pii"]', sdlc: JSON.stringify({ repo: "o/r", pr: i + 100 }) })));
    const inv = dogfoodPiiInventory(file); expect(inv.complete).toBe(false); expect(inv.data).toHaveLength(2000);
    const calls: string[][] = [];
    const prs = await dogfoodPrs("o/r", dogfoodTasks(file, { since: 1000, until: 10000 }), 1000, 10000, ghWith(calls), inv);
    expect(prs.available).toBe(false); expect(calls).toHaveLength(0);
  } finally { f.close(); }
});

test("readDogfood on a board over 500 tasks reads the PRs, excludes the PII PR and never reads its number", async () => {
  const f = fixture(); try {
    board(join(f.root, "hub.db"), bigBoard());
    const calls: string[][] = [];
    const card = await readDogfood(f.root, f.root, 1000, 10000, ghWith(calls));
    expect(card.sources.tasks).toMatchObject({ available: true, complete: true });
    expect(card.sources.prs).toMatchObject({ available: true });
    expect(card.flow.prs.map(p => p.pr)).toEqual([3]);
    expect(card.piiTasks).toBe(1);
    expect(JSON.stringify(calls)).not.toMatch(/number=2\b/);
    expect(JSON.stringify(card)).not.toContain("SECRET");
  } finally { f.close(); }
});

test("without a PII inventory dogfoodPrs still treats an incomplete task list as an unknown privacy inventory", async () => {
  const f = fixture(); try {
    const file = join(f.root, "hub.db"); board(file, bigBoard());
    const calls: string[][] = [];
    const prs = await dogfoodPrs("o/r", dogfoodTasks(file), 1000, 10000, ghWith(calls));
    expect(prs.available).toBe(false); expect(calls).toHaveLength(0);
  } finally { f.close(); }
});

// #1147 review (connector P2): a PR merged in the window keeps every linked task, even one last updated before `since`.
const siblingGh = (mergedAt: number): SdlcGh => async args => {
  if (args[0] === "repo") return { code: 0, stdout: '{"nameWithOwner":"o/r"}' };
  if (args[0] === "pr") return { code: 0, stdout: JSON.stringify([{ number: 12, mergedAt: at(mergedAt), createdAt: at(100) }]) };
  return { code: 1, stdout: "" };
};
const link = JSON.stringify({ repo: "o/r", pr: 12 });
const siblings = (): Row[] => [
  // proposed at 100, rejected once at 500, approved at 900: last updated before the window (since = 1000)
  { id: 1, created: 100, updated: 900, sdlc: link, history: '[{"at":100,"by":"x","event":"proposed"},{"at":500,"by":"x","event":"changes_requested"},{"at":900,"by":"x","event":"approved"}]' },
  // proposed at 2000, approved at 4000: inside the window
  { id: 2, created: 2000, updated: 4000, sdlc: link, history: '[{"at":2000,"by":"x","event":"proposed"},{"at":4000,"by":"x","event":"approved"}]' },
];

test("a PR merged in the window keeps its out-of-window sibling task, so lead time and first-pass approval are not computed from a partial set", async () => {
  const f = fixture(); try {
    board(join(f.root, "hub.db"), siblings());
    const card = await readDogfood(f.root, f.root, 1000, 10000, siblingGh(5000));
    const row = card.flow.prs.find(p => p.pr === 12)!;
    expect(row.tasks).toEqual([1, 2]);
    expect(row.proposeToApproveMs).toBe(3900); // approval 4000 minus the earliest proposal 100, not 4000 - 2000
    expect(row.firstPassApproval).toBe(0);     // the dropped task's earlier rejection still counts
    expect(card.sources.tasks).toMatchObject({ available: true, complete: true });
  } finally { f.close(); }
});

test("when the PR's linked tasks overflow their bound the PR evidence is unknown, never a value from a partial set", async () => {
  const f = fixture(); try {
    const many = Array.from({ length: 501 }, (_, i) => ({ id: i + 1, created: 100, updated: 200, sdlc: link, history: '[{"at":100,"by":"x","event":"proposed"},{"at":150,"by":"x","event":"approved"}]' }));
    board(join(f.root, "hub.db"), [...many, { id: 600, created: 2000, updated: 4000, sdlc: link, history: '[{"at":2000,"by":"x","event":"proposed"},{"at":4000,"by":"x","event":"approved"}]' }]);
    const card = await readDogfood(f.root, f.root, 1000, 10000, siblingGh(5000));
    const row = card.flow.prs.find(p => p.pr === 12)!;
    expect(card.sources.tasks!.complete).toBe(false);
    expect([row.proposeToApproveMs, row.firstPassApproval, row.reviewRounds, row.importantFindings]).toEqual([null, null, null, null]);
  } finally { f.close(); }
});

test("a task linked to the same PR number in another repository is read but never joins this repository's PR", async () => {
  const f = fixture(); try {
    board(join(f.root, "hub.db"), [...siblings(), { id: 3, created: 100, updated: 200, sdlc: JSON.stringify({ repo: "other/repo", pr: 12 }), history: '[{"at":100,"by":"x","event":"proposed"},{"at":150,"by":"x","event":"changes_requested"}]' }]);
    const row = (await readDogfood(f.root, f.root, 1000, 10000, siblingGh(5000))).flow.prs.find(p => p.pr === 12)!;
    expect(row.tasks).toEqual([1, 2]);
    expect(row.proposeToApproveMs).toBe(3900);
  } finally { f.close(); }
});

test("a malformed receipt on an out-of-window row cannot break the linked-task read", () => {
  const f = fixture(); try {
    const file = join(f.root, "hub.db");
    board(file, [...siblings(), { id: 4, created: 100, updated: 200, sdlc: "not json" }]);
    const r = dogfoodTasks(file, { since: 1000, until: 10000 }, [12]);
    expect(r.available).toBe(true); expect(r.data.map(t => t.id).sort()).toEqual([1, 2]);
  } finally { f.close(); }
});
