import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { USER } from "../src/hub/envelope.ts";
import { executionReferenceKey, type ExecutionReferenceV1 } from "../src/hub/execution-reference.ts";
import { EXECUTION_LINK_LIMITS, ExecutionLinkError, executionLinkId, executionLinkReferences, executionReferenceDigest,
  parseExecutionLinkInput, parseExecutionLinkRecord, taskExecutionReference, type ExecutionLinkInput, type ExecutionLinkRecord } from "../src/hub/execution-links.ts";

const project = "synthetic-project";
const target = (id = "attempt-1", tool: ExecutionReferenceV1["tool"] = "ares"): ExecutionReferenceV1 =>
  ({ v: 1, tool, projectKey: tool === "ahub" ? project : "foreign-producer-project", kind: "attempt", id });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-execution-links-")), file = join(dir, "hub.db");
  let board = new Board(file);
  const proposed = board.propose(USER, { title: "synthetic lineage task", class: "implement" });
  board.update(proposed.id, USER, "assigned", { state: "in_progress", owner: "codex", reviewer: "claude", planner: "pi" });
  const current = () => board.get(proposed.id)!;
  const input = (reference = target()): ExecutionLinkInput => {
    const task = current();
    return { taskId: task.id, taskCreated: task.created, flowRevision: task.history.length, reference };
  };
  return { file, current, input, get board() { return board; },
    reopen() { board.close(); board = new Board(file); },
    close() { board.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function rejects(code: ExecutionLinkError["code"], fn: () => unknown) {
  try { fn(); throw new Error("expected execution link refusal"); }
  catch (error) {
    expect(error).toBeInstanceOf(ExecutionLinkError);
    expect((error as ExecutionLinkError).code).toBe(code);
    expect((error as Error).message).not.toContain("synthetic-secret-canary");
  }
}
function inject(raw: Database, input: ExecutionLinkInput): ExecutionLinkRecord {
  const refs = executionLinkReferences(project, input), id = executionLinkId(project, input);
  raw.query(`INSERT INTO execution_reference_links
    (id,project_id,task_id,task_created,from_json,from_sha256,reference_json,reference_sha256,recorded_by,recorded_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, project, input.taskId, input.taskCreated,
      executionReferenceKey(refs.from), executionReferenceDigest(refs.from), executionReferenceKey(refs.reference), executionReferenceDigest(refs.reference), "codex", 10);
  return { id, projectKey: project, taskId: input.taskId, taskCreated: input.taskCreated, ...refs, strength: "declared", recordedBy: "codex", recordedAt: 10 };
}

test("execution link parser rejects untrusted shape before invoking getters or proxy traps", () => {
  const input: ExecutionLinkInput = { taskId: 1, taskCreated: 2, flowRevision: 3, reference: target() };
  expect(parseExecutionLinkInput(input)).toEqual(input);
  let accesses = 0;
  const getter = { ...input, get reference() { accesses++; throw new Error("synthetic-secret-canary"); } };
  const proxy = new Proxy(input, { ownKeys() { accesses++; throw new Error("synthetic-secret-canary"); } });
  const invalid: unknown[] = [getter, proxy, null, [], { ...input, by: USER }, { ...input, strength: "observed" },
    { ...input, from: null }, { ...input, flowRevision: NaN }, { ...input, taskId: 0 }, { ...input, taskCreated: -1 },
    { ...input, reference: { ...target(), v: 2 } }, { ...input, reference: { ...target(), id: "a".repeat(257) } },
    { ...input, reference: { ...target(), sha256: "not-a-hash" } }];
  for (const value of invalid) rejects("invalid", () => parseExecutionLinkInput(value));
  expect(accesses).toBe(0);
});

test("reference identity is exact and declared, preserving foreign addresses without resolving them", () => {
  const f = fixture();
  try {
    expect(f.board.hasExecutionReferences()).toBe(false);
    expect(f.board.executionReferencesIntegrity().count).toBe(0);
    for (const tool of ["ares", "amem", "vmem"] as const) {
      const input = f.input(target(tool, tool));
      const result = f.board.recordExecutionReference(project, input, { by: "codex", at: 10 });
      expect(result.record.reference).toEqual(input.reference);
      expect(result.record.from).toEqual(taskExecutionReference(project, input.taskId, input.taskCreated));
      expect(result.record.strength).toBe("declared");
    }
    const before = f.board.executionReferencesIntegrity();
    rejects("invalid", () => f.board.recordExecutionReference(project, f.input({ ...target("x", "ahub"), projectKey: "wrong" }), { by: USER, at: 20 }));
    rejects("invalid", () => f.board.recordExecutionReference(project, { ...f.input(), from: target("foreign-origin") }, { by: USER, at: 20 }));
    rejects("invalid", () => f.board.recordExecutionReference(project, { ...f.input(), from: { ...target("dispatch", "ahub"), projectKey: "wrong" } }, { by: USER, at: 20 }));
    expect(f.board.executionReferencesIntegrity()).toEqual(before);
    const input = f.input(), from = { ...target("dispatch-1", "ahub"), kind: "dispatch" };
    expect(executionLinkId(project, input)).not.toBe(executionLinkId(project, { ...input, from }));
    expect(executionLinkId(project, input)).not.toBe(executionLinkId(project, { ...input, reference: { ...input.reference, revision: "r2" } }));
    expect(executionLinkId(project, input)).not.toBe(executionLinkId(project, { ...input, reference: { ...input.reference, sha256: "a".repeat(64) } }));
    // Storage preserves declarations; Tasks separately proves supplied from membership, not native causality.
    expect(f.board.recordExecutionReference(project, { ...input, from }, { by: "claude", at: 20 }).record.from).toEqual(from);
  } finally { f.close(); }
});

test("exact replay is zero-write after restart and retains original audit metadata", () => {
  const f = fixture();
  try {
    const input = f.input(), history = f.current().history, revision = f.board.statusRevision();
    const first = f.board.recordExecutionReference(project, input, { by: "codex", at: 100 });
    expect(first.already).toBe(false);
    expect(f.board.statusRevision()).toBe(revision + 1);
    expect(f.current().history).toEqual(history);
    const integrity = f.board.executionReferencesIntegrity();
    f.reopen();
    const reopenedRevision = f.board.statusRevision();
    const replay = f.board.recordExecutionReference(project, input, { by: USER, at: 200 });
    expect(replay).toEqual({ record: first.record, already: true });
    expect(f.board.statusRevision()).toBe(reopenedRevision);
    expect(f.board.executionReferencesIntegrity()).toEqual(integrity);
    expect(f.board.executionReferences(project, input.taskId, input.taskCreated)).toEqual([first.record]);
    expect(f.current().history).toEqual(history);
  } finally { f.close(); }
});

test("fresh authority, task epoch, flow and privacy fences precede duplicate lookup", () => {
  const f = fixture();
  try {
    const old = f.input();
    f.board.recordExecutionReference(project, old, { by: "codex", at: 10 });
    const unchanged = () => ({ integrity: f.board.executionReferencesIntegrity(), revision: f.board.statusRevision() });
    for (const by of ["pi", "unrelated"]) {
      const before = unchanged();
      rejects("changed", () => f.board.recordExecutionReference(project, old, { by, at: 20 }));
      expect(unchanged()).toEqual(before);
    }
    rejects("changed", () => f.board.recordExecutionReference(project, { ...old, taskCreated: old.taskCreated + 1 }, { by: USER, at: 20 }));
    f.board.update(old.taskId, USER, "progress", {});
    let before = unchanged();
    rejects("changed", () => f.board.recordExecutionReference(project, old, { by: "codex", at: 20 }));
    expect(unchanged()).toEqual(before);
    expect(f.board.recordExecutionReference(project, f.input(), { by: "claude", at: 30 }).already).toBe(true);
    f.board.update(old.taskId, USER, "owner changed", { owner: "kimi" });
    before = unchanged();
    rejects("changed", () => f.board.recordExecutionReference(project, f.input(), { by: "codex", at: 30 }));
    expect(unchanged()).toEqual(before);
    for (const signal of ["pii", "pii_path"]) {
      f.board.update(old.taskId, USER, "privacy changed", { signals: [signal] });
      before = unchanged();
      rejects("changed", () => f.board.recordExecutionReference(project, f.input(), { by: USER, at: 40 }));
      rejects("changed", () => f.board.recordExecutionReference(project, f.input(target("new")), { by: "kimi", at: 40 }));
      expect(unchanged()).toEqual(before);
    }
  } finally { f.close(); }
});

test("admission caps unique metadata per task while exact duplicates and indexed scoped reads remain usable", () => {
  const f = fixture();
  try {
    for (let i = 0; i < EXECUTION_LINK_LIMITS.perTask; i++) f.board.recordExecutionReference(project, f.input(target(`attempt-${i}`)), { by: "codex", at: i });
    const before = f.board.executionReferencesIntegrity(), revision = f.board.statusRevision(), input = f.input();
    expect(before.count).toBe(64);
    rejects("limit", () => f.board.recordExecutionReference(project, f.input(target("overflow")), { by: USER, at: 100 }));
    expect(f.board.recordExecutionReference(project, f.input(target("attempt-0")), { by: USER, at: 101 }).already).toBe(true);
    expect(f.board.executionReferencesIntegrity()).toEqual(before);
    expect(f.board.statusRevision()).toBe(revision);
    expect(f.board.executionReferences(project, input.taskId, input.taskCreated, 1)).toHaveLength(1);
    expect(f.board.executionReferences(project, input.taskId, input.taskCreated)).toHaveLength(64);
    expect(f.board.executionReferences(project, input.taskId, input.taskCreated + 1)).toEqual([]);
    expect(f.board.executionReferences("another-project", input.taskId, input.taskCreated)).toEqual([]);
    for (const limit of [0, 66, Infinity]) rejects("invalid", () => f.board.executionReferences(project, input.taskId, input.taskCreated, limit));
    const raw = new Database(f.file);
    try {
      inject(raw, f.input(target("corrupt-overflow")));
      expect(f.board.executionReferences(project, input.taskId, input.taskCreated)).toHaveLength(65);
      rejects("corrupt", () => f.board.executionReferencesIntegrity());
    } finally { raw.close(); }
  } finally { f.close(); }
});

test("integrity detects metadata changes and row loss without rebinding old task epochs", () => {
  const f = fixture(), raw = new Database(f.file);
  try {
    const input = f.input(), record = f.board.recordExecutionReference(project, input, { by: "codex", at: 10 }).record;
    const initial = f.board.executionReferencesIntegrity();
    raw.query("UPDATE execution_reference_links SET recorded_at=? WHERE id=?").run(11, record.id);
    expect(f.board.executionReferencesIntegrity().digest).not.toBe(initial.digest);
    raw.query("UPDATE execution_reference_links SET recorded_at=? WHERE id=?").run(10, record.id);
    expect(f.board.executionReferencesIntegrity()).toEqual(initial);
    raw.query("UPDATE tasks SET created=? WHERE id=?").run(input.taskCreated + 1, input.taskId);
    expect(f.board.executionReferencesIntegrity()).toEqual(initial);
    expect(f.board.executionReferences(project, input.taskId, input.taskCreated + 1)).toEqual([]);
    const replacement = f.board.recordExecutionReference(project, f.input(), { by: USER, at: 20 }).record;
    expect(replacement.id).not.toBe(record.id);
    raw.query("DELETE FROM execution_reference_links WHERE id=?").run(record.id);
    expect(f.board.executionReferencesIntegrity().count).toBe(1);
    expect(f.board.executionReferencesIntegrity().digest).not.toBe(initial.digest);
  } finally { raw.close(); f.close(); }
});

test("corrupt or oversized persisted fields fail closed and integrity always releases its read cursor", () => {
  const f = fixture(), raw = new Database(f.file);
  try {
    const input = f.input(), record = f.board.recordExecutionReference(project, input, { by: "codex", at: 10 }).record;
    const original = raw.query("SELECT * FROM execution_reference_links WHERE id=?").get(record.id) as Record<string, string | number>;
    const cases: Array<[string, string | number]> = [
      ["reference_json", JSON.stringify({ ...record.reference, id: "synthetic-secret-canary" })],
      ["from_json", "synthetic-secret-canary".repeat(200)], ["reference_json", "synthetic-secret-canary".repeat(200)],
      ["project_id", "synthetic-secret-canary".repeat(200)], ["recorded_by", "synthetic-secret-canary".repeat(200)],
      ["recorded_at", -1], ["from_sha256", "b".repeat(64)], ["reference_sha256", "c".repeat(64)],
    ];
    for (const [column, value] of cases) {
      // Column names are fixed fixture literals, never caller-controlled SQL.
      raw.query(`UPDATE execution_reference_links SET ${column}=? WHERE id=?`).run(value, record.id);
      expect(f.board.hasExecutionReferences()).toBe(true);
      rejects("corrupt", () => f.board.executionReferencesIntegrity());
      // A second connection write is the cursor-release assertion, not a WAL/deadline workaround.
      raw.query(`UPDATE execution_reference_links SET ${column}=? WHERE id=?`).run(original[column]!, record.id);
      expect(f.board.executionReferencesIntegrity().count).toBe(1);
    }
    raw.query("UPDATE execution_reference_links SET reference_json=? WHERE id=?").run("synthetic-secret-canary".repeat(200), record.id);
    rejects("corrupt", () => f.board.executionReferences(project, input.taskId, input.taskCreated));
    rejects("corrupt", () => f.board.recordExecutionReference(project, input, { by: USER, at: 30 }));
    raw.query("UPDATE execution_reference_links SET reference_json=? WHERE id=?").run(original.reference_json!, record.id);
    expect(parseExecutionLinkRecord(record)).toEqual(record);
    rejects("corrupt", () => parseExecutionLinkRecord({ ...record, strength: "observed" }));
  } finally { raw.close(); f.close(); }
});
