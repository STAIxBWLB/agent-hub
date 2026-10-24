import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function fixture(legacy = false) {
  const root = mkdtempSync(join(tmpdir(), "ahub-task-planner-board-")), file = join(root, "board.db");
  const raw = <T>(read: (db: Database) => T): T => { const db = new Database(file); try { return read(db); } finally { db.close(); } };
  if (legacy) raw(db => {
    db.run(`CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',class TEXT NOT NULL,
      owner TEXT,reviewer TEXT,state TEXT NOT NULL,refs TEXT NOT NULL DEFAULT '{}',signals TEXT NOT NULL DEFAULT '[]',rejections INTEGER NOT NULL DEFAULT 0,
      history TEXT NOT NULL DEFAULT '[]',created INTEGER NOT NULL,updated INTEGER NOT NULL)`);
    db.run(`CREATE TABLE releases (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,goal TEXT NOT NULL,release_order INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'planning',planned_start INTEGER,cut INTEGER,ship INTEGER,activated_at INTEGER,frozen_at INTEGER,shipped_at INTEGER,
      created INTEGER NOT NULL,updated INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 0)`);
    db.query("INSERT INTO tasks(title,class,state,history,created,updated) VALUES(?,?,?,?,?,?)").run("legacy", "test", "proposed", JSON.stringify([{ at: 1, by: "user", event: "proposed" }]), 1, 1);
    db.query("INSERT INTO releases(name,goal,release_order,created,updated) VALUES(?,?,?,?,?)").run("legacy", "legacy", 0, 1, 1);
  });
  let board = new Board(file);
  cleanups.push(() => { board.close(); rmSync(root, { recursive: true, force: true }); });
  return { get board() { return board; }, raw, reopen() { board.close(); board = new Board(file); return board; } };
}

test("nullable task/release planner migration never backfills legacy identities or history", () => {
  const f = fixture(true);
  expect(f.board.get(1)?.planner).toBeNull(); expect(f.board.release(1)?.planner).toBeNull();
  expect(f.board.get(1)?.history).toEqual([{ at: 1, by: "user", event: "proposed" }]);
  expect(f.board.hasPlannerState()).toBe(false);
  f.raw(db => {
    expect((db.query("SELECT planner FROM tasks WHERE id=1").get() as any).planner).toBeNull();
    expect((db.query("SELECT planner FROM releases WHERE id=1").get() as any).planner).toBeNull();
    for (const table of ["tasks", "releases"]) {
      const column = (db.query(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number; dflt_value: unknown }[]).find(row => row.name === "planner");
      expect(column?.notnull).toBe(0); expect(column?.dflt_value).toBeNull();
    }
  });
  f.reopen(); expect(f.board.get(1)?.planner).toBeNull(); expect(f.board.release(1)?.planner).toBeNull();
  expect(f.board.propose("user", { title: "legacy signature", class: "test" }).history[0]).not.toHaveProperty("planner");
});

test("planner selection and reason persist with proposals, backlogs and assignment transitions", () => {
  const f = fixture();
  const proposed = f.board.propose("user", { title: "selected", class: "test", planner: "claude", plannerReason: "rotation" });
  expect(proposed.planner).toBe("claude"); expect(proposed.history[0]).toMatchObject({ planner: "claude", plannerReason: "rotation" });
  const backlog = f.board.propose("user", { title: "staged", class: "test", backlog: true, planner: "codex", plannerReason: "named" });
  expect(backlog.history[0]).toMatchObject({ event: "backlogged", planner: "codex", plannerReason: "named" });
  const assigned = f.board.update(proposed.id, "user", "assigned", { owner: "codex", planner: "claude" }, undefined, { plannerReason: "kept" });
  expect(assigned.history.at(-1)).toMatchObject({ owner: "codex", planner: "claude", plannerReason: "kept" });
  const cleared = f.board.update(proposed.id, "user", "planner cleared", { planner: null }, undefined, { plannerReason: "none" });
  expect(cleared.planner).toBeNull(); expect(cleared.history.at(-1)).toMatchObject({ planner: null, plannerReason: "none" });
  f.reopen(); expect(f.board.get(backlog.id)?.planner).toBe("codex"); expect(f.board.list().find(row => row.id === proposed.id)?.planner).toBeNull();
  expect(f.board.hasPlannerState()).toBe(true);
});

test("ownerless and assigned backlog pulls persist planner bindings inside their original revision fences", () => {
  const f = fixture();
  const first = f.board.propose("user", { title: "ownerless", class: "test", backlog: true });
  const pulled = f.board.pullPlanned(first.id, "claude", "codex", 0, "fixture", false, { planner: "claude", plannerReason: "named" });
  expect(pulled).toMatchObject({ state: "proposed", owner: null, planner: "claude" });
  expect(pulled.history.at(-1)).toMatchObject({ event: "backlog pulled", planner: "claude", plannerReason: "named" });
  const second = f.board.propose("user", { title: "assigned", class: "test", backlog: true });
  const observed: { owner: string | null; planner: string | null | undefined; event: string }[] = [];
  f.board.onChange = (task, event) => { observed.push({ owner: task.owner, planner: task.planner, event: event.event }); };
  const assigned = f.board.pullAssigned(second.id, "claude", "codex", 0, "fixture", false, null, "handoff", {}, second.history.length, { planner: "claude", plannerReason: "kept" });
  expect(assigned).toMatchObject({ owner: "codex", planner: "claude" });
  expect(assigned.history.slice(-2).map(row => ({ planner: row.planner, reason: row.plannerReason }))).toEqual([{ planner: "claude", reason: "kept" }, { planner: "claude", reason: "kept" }]);
  expect(observed).toEqual([{ owner: "codex", planner: "claude", event: "backlog pulled" }, { owner: "codex", planner: "claude", event: "assigned" }]);
  const third = f.board.propose("user", { title: "revision guarded", class: "test", backlog: true });
  expect(() => f.board.pullAssigned(third.id, "claude", "codex", 0, "fixture", false, null, "handoff", {}, third.history.length + 1, { planner: "claude", plannerReason: "named" })).toThrow("flow revision changed");
  expect(f.board.get(third.id)).toEqual(third);
});

test("release planner creation, changes and clearing preserve release revision checks", () => {
  const f = fixture(), release = f.board.newRelease("planned", "fixture", 0, "claude");
  expect(release.planner).toBe("claude");
  const changed = f.board.updateRelease(release.id, { planner: "codex" }, release.revision);
  expect(changed.planner).toBe("codex");
  expect(() => f.board.updateRelease(release.id, { planner: null }, release.revision)).toThrow("revision changed");
  f.reopen(); expect(f.board.release(release.id)?.planner).toBe("codex"); expect(f.board.hasPlannerState()).toBe(true);
  const cleared = f.board.updateRelease(release.id, { planner: null }, changed.revision);
  expect(cleared.planner).toBeNull(); expect(f.board.hasPlannerState()).toBe(false);
});

for (const receipt of [{ planAuthor: null }, { selfReview: false }, { selfReview: true }]) test(`planner recovery floor detects current receipt presence ${JSON.stringify(receipt)}`, () => {
  const f = fixture(), task = f.board.propose("user", { title: "receipt", class: "test" });
  f.raw(db => db.query("UPDATE tasks SET sdlc=? WHERE id=?").run(JSON.stringify({ stage: "plan", planReview: { planner: "claude", planningRevision: 0, recordedAt: 1, ...receipt } }), task.id));
  expect(f.board.hasPlannerState()).toBe(true);
});

for (const extra of [{ planAuthor: null }, { selfReview: true as const }]) test(`planner recovery floor retains flat history evidence after current receipt is cleared ${JSON.stringify(extra)}`, () => {
  const f = fixture(), task = f.board.propose("user", { title: "retained receipt", class: "test" });
  const saved = f.board.update(task.id, "claude", "plan reviewed", { sdlc: { stage: "plan" } }, "fixture", extra);
  expect(saved.history.at(-1)).toMatchObject(extra);
  f.board.update(task.id, "user", "receipt cleared", { sdlc: undefined });
  f.reopen(); expect(f.board.get(task.id)?.sdlc).toBeUndefined(); expect(f.board.hasPlannerState()).toBe(true);
});

test("planner recovery floor uses guarded SQL presence reads without hydrating task bodies", () => {
  const f = fixture(), task = f.board.propose("user", { title: "legacy receipt", class: "test" });
  f.raw(db => db.query("UPDATE tasks SET sdlc=?,history=? WHERE id=?").run(JSON.stringify({ stage: "plan", planReview: { planner: "claude", planningRevision: 0, recordedAt: 1 } }), '["legacy text",null,42]', task.id));
  const get = f.board.get, list = f.board.list;
  f.board.get = () => { throw new Error("task body hydrated"); }; f.board.list = () => { throw new Error("task bodies hydrated"); };
  try {
    expect(f.board.hasPlannerState()).toBe(false);
    f.raw(db => db.query("UPDATE tasks SET history=? WHERE id=?").run('[{"planAuthor":null}]', task.id));
    expect(f.board.hasPlannerState()).toBe(true);
    f.raw(db => db.query("UPDATE tasks SET sdlc=?,history=? WHERE id=?").run("{", "{", task.id));
    expect(f.board.hasPlannerState()).toBe(false);
  } finally { f.board.get = get; f.board.list = list; }
});

test("invalid planner metadata is refused before a task/release write", () => {
  const f = fixture(), task = f.board.propose("user", { title: "unchanged", class: "test" });
  expect(() => f.board.update(task.id, "user", "planner", { planner: "Not an id" })).toThrow("planner id");
  expect(() => f.board.update(task.id, "user", "planner", { planner: "claude" }, undefined, { plannerReason: "invalid" as never })).toThrow("planner reason");
  expect(() => f.board.newRelease("invalid", "fixture", 0, "Not an id")).toThrow("planner id");
  expect(f.board.get(task.id)).toEqual(task); expect(f.board.releases()).toEqual([]);
});
