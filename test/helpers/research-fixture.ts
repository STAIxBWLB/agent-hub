import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../../src/hub/board.ts";
import type { StampedEvent } from "../../src/hub/events.ts";

/** #1277: a research fixture project with a real hub.db (board and journal tables) and an events list whose times are fixed, so every expected figure can be computed by hand. */
export const T0 = Date.parse("2026-10-10T00:00:00Z");
export const iso = (ms: number): string => new Date(ms).toISOString();
export const minutes = (n: number): number => T0 + n * 60_000;

export const tempDir = (dirs: string[], name: string): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), `ahub-r2-${name}-`))); dirs.push(d); return d; };
export const cleanDirs = (dirs: string[]): void => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); };

export const ev = (min: number, e: Record<string, unknown>): StampedEvent => ({ v: 1, at: iso(minutes(min)), ...e } as StampedEvent);
export const taskEvent = (min: number, id: number, event: string, state: string, extra: Record<string, unknown> = {}): StampedEvent =>
  ev(min, { type: "task", id, event, by: "hub", state, owner: null, reviewer: null, class: "implement", pii: false, ...extra });

/** Write the board rows a fixture needs directly: the history is exactly what the test says, with no clock or state machine in between. */
export function boardWith(stateDir: string, rows: { id: number; history: unknown[]; sdlc?: unknown; title?: string }[], deliveries: { project: string; task: number; state: string; createdAt: number; updatedAt: number; body?: string }[] = []): void {
  mkdirSync(stateDir, { recursive: true });
  const board = new Board(join(stateDir, "hub.db"));
  board.close();
  const db = new Database(join(stateDir, "hub.db"));
  try {
    for (const r of rows) db.query("INSERT INTO tasks (id, title, class, state, history, sdlc, created, updated) VALUES (?, ?, 'implement', 'approved', ?, ?, 0, 0)").run(r.id, r.title ?? `title-${r.id}`, JSON.stringify(r.history), r.sdlc === undefined ? null : JSON.stringify(r.sdlc));
    // The journal's own tables, as it creates them: the reader checks the meta row's review-input coverage before it claims any delivery figure is complete.
    db.run("CREATE TABLE IF NOT EXISTS delivery_meta (project_id TEXT PRIMARY KEY, review_input_coverage_complete INTEGER NOT NULL DEFAULT 0)");
    for (const project of new Set(deliveries.map(d => d.project))) db.query("INSERT OR REPLACE INTO delivery_meta (project_id, review_input_coverage_complete) VALUES (?, 1)").run(project);
    // The journal creates its own table; the fixture needs only the columns the research reader selects.
    db.run("CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, peer TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, originals TEXT NOT NULL, out_json TEXT NOT NULL, reason TEXT, attempt INTEGER, previous_id TEXT)");
    let n = 0;
    for (const d of deliveries) db.query("INSERT INTO deliveries (id, project_id, peer, state, revision, created_at, updated_at, originals, out_json) VALUES (?, ?, 'codex', ?, 1, ?, ?, ?, '[]')").run(`d${++n}`, d.project, d.state, d.createdAt, d.updatedAt, JSON.stringify([{ refs: { task: String(d.task) }, ...(d.body ? { body: d.body } : {}) }]));
  } finally { db.close(); }
}

export const PROJECT = "project-one";
export const familyOf = (peer: string): string | undefined => ({ codex: "codex", "codex-review": "codex", claude: "claude", kimi: "kimi" } as Record<string, string>)[peer];

const A = "a".repeat(40), B = "b".repeat(40);

/**
 * Task 1 is approved after one change request: proposed 0, declined 1, escalated 2, started 3, done 5, changes requested 10, done 12, approved 20, merged 60 (minutes).
 * Tasks 2 to 4 are cancelled: 2 with an explicit closed cause, 3 after a decline and an escalation but no cause, 4 with a cause outside the vocabulary.
 */
export function scenarioEvents() {
  return [
    taskEvent(0, 1, "proposed", "proposed"), taskEvent(1, 1, "declined", "proposed"), taskEvent(2, 1, "escalated", "proposed"),
    taskEvent(3, 1, "accepted", "in_progress", { owner: "codex", reviewer: "claude" }),
    ev(4, { type: "envelope", id: "e1", from: "hub", priority: "normal", hop: 0, task: "1" }), ev(4, { type: "envelope", id: "e2", from: "hub", priority: "normal", hop: 0, task: "1" }),
    ev(4, { type: "envelope", id: "e3", from: "hub", priority: "normal", hop: 0, task: "1", dropped: "fyi" }),
    ev(4, { type: "memory_brief", peer: "codex", task: 1, native: 2, fails: 1, claudeMem: 1 }),
    ev(4, { type: "cohort", id: 1, event: "formed", silent: true, tasks: [1], owners: [] }),
    taskEvent(5, 1, "done", "in_review", { owner: "codex", reviewer: "claude" }),
    taskEvent(10, 1, "changes_requested", "changes_requested", { owner: "codex", reviewer: "claude" }),
    taskEvent(12, 1, "done", "in_review", { owner: "codex", reviewer: "claude" }),
    taskEvent(20, 1, "approved", "approved", { owner: "codex", reviewer: "claude" }),
    taskEvent(30, 2, "proposed", "proposed"), taskEvent(31, 2, "accepted", "in_progress", { owner: "kimi" }), taskEvent(40, 2, "cancelled", "cancelled", { owner: "kimi" }),
    taskEvent(50, 3, "proposed", "proposed"), taskEvent(51, 3, "declined", "proposed"), taskEvent(52, 3, "escalated", "proposed"),
    taskEvent(53, 3, "accepted", "in_progress", { owner: "codex-review" }), taskEvent(60, 3, "cancelled", "cancelled", { owner: "codex-review" }),
    taskEvent(70, 4, "proposed", "proposed"), taskEvent(71, 4, "accepted", "in_progress", { owner: "claude" }), taskEvent(72, 4, "cancelled", "cancelled", { owner: "claude" }),
  ];
}
const finding = (id: string, pass: string, severity: string, disposition: string) => ({ id, pass, severity, disposition });
export function scenarioBoard() {
  return [
    { id: 1, sdlc: { merge: { state: "merged", cost: { mergedAt: minutes(60), ciRuns: 3, ciReruns: 1, reviews: 2 } } }, history: [
      { at: minutes(5), by: "codex", event: "done", reviewCost: { head: A, review: { scope: "full" } }, specReport: { complete: true, errors: 0, unchanged: [{ reason: "r" }, {}], changed: [{}] } },
      { at: minutes(10), by: "claude", event: "changes_requested", reviewerFamily: "claude", reviewContext: "continuing", reviewFindings: { head: A, items: [finding("a", "bugs", "important", "open"), finding("b", "security", "nit", "open")] } },
      { at: minutes(12), by: "codex", event: "done" },
      { at: minutes(15), by: "hub", event: "idle nudge", sweep: {} }, { at: minutes(16), by: "hub", event: "idle nudge", sweep: {} },
      { at: minutes(20), by: "claude", event: "approved", reviewerFamily: "claude", reviewContext: "fresh", reviewScope: "code", reviewFindings: { head: B, items: [finding("a", "bugs", "important", "fixed"), finding("c", "compliance", "nit", "false_positive")] } },
    ] },
    { id: 2, history: [{ at: minutes(40), by: "user", event: "cancelled", cause: "stale" }] },
    { id: 3, history: [{ at: minutes(51), by: "codex-review", event: "declined" }, { at: minutes(52), by: "hub", event: "escalated" }, { at: minutes(60), by: "user", event: "cancelled" }] },
    { id: 4, history: [{ at: minutes(72), by: "user", event: "cancelled", cause: "bogus" }] },
  ];
}
export const scenarioDeliveries = () => [
  { project: PROJECT, task: 99, state: "completed", createdAt: minutes(-10), updatedAt: minutes(-9) },
  { project: PROJECT, task: 1, state: "completed", createdAt: minutes(2), updatedAt: minutes(3) },
  { project: PROJECT, task: 1, state: "completed", createdAt: minutes(6), updatedAt: minutes(9) },
  { project: PROJECT, task: 1, state: "needs_review", createdAt: minutes(7), updatedAt: minutes(7) },
  { project: PROJECT, task: 1, state: "failed", createdAt: minutes(8), updatedAt: minutes(8) },
];
