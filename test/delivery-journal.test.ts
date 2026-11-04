import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryJournal, validateJournalSnapshot } from "../src/hub/delivery-journal.ts";
import type { Database } from "../src/hub/db-schema.ts";
import { Bus } from "../src/hub/bus.ts";
import { newEnvelope } from "../src/hub/envelope.ts";

function open() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-journal-"));
  const journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "i" });
  return { dir, journal };
}

test("journal survives a reopen and marks unsettled delivery for review", () => {
  const { dir, journal } = open();
  const env = newEnvelope("user", "private work", { private: true });
  journal.createDelivery({ id: "d1", peer: "codex", state: "dispatching", createdAt: env.ts, originals: [env], out: [env] });
  journal.close();
  const reopened = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "j" });
  expect(reopened.get("d1")).toMatchObject({ state: "needs_review", peer: "codex" });
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

test("resolution requires the observed revision and is idempotent", () => {
  const { dir, journal } = open();
  const env = newEnvelope("user", "work");
  const row = journal.createDelivery({ id: "d2", peer: "kimi", state: "needs_review", createdAt: env.ts, originals: [env], out: [env] });
  const done = journal.resolve("d2", row.revision, "completed", "verified no side effect");
  expect(journal.resolve("d2", done.revision, "completed", "verified no side effect").state).toBe("completed");
  expect(() => journal.resolve("d2", row.revision, "discard", "wrong revision")).toThrow("stale delivery revision");
  journal.close();
  rmSync(dir, { recursive: true, force: true });
});

test("terminal history is bounded without pruning an unresolved receipt", () => {
  const { dir, journal } = open();
  const env = newEnvelope("user", "history fixture");
  journal.createDelivery({ id: "pending", peer: "claude", state: "needs_review", createdAt: env.ts, originals: [env], out: [env] });
  journal.transaction(() => {
    for (let n = 0; n < 2050; n++) journal.createDelivery({ id: `terminal-${n}`, peer: "claude", state: "failed", createdAt: env.ts + n, originals: [env], out: [] });
  });
  expect(journal.list().filter((row) => row.state === "failed").length).toBeLessThanOrEqual(2048);
  expect(journal.get("pending")?.state).toBe("needs_review");
  journal.close();
  rmSync(dir, { recursive: true, force: true });
});

test("AC2: automatic settlement records the hub actor and conflicts with person resolution (#434)", () => {
  const { dir, journal } = open();
  try {
    const env = newEnvelope("hub", "memory", { kind: "presence" });
    const row = journal.createDelivery({ id: "hub-settle", peer: "claude", state: "needs_review", createdAt: env.ts, originals: [env], out: [env] });
    journal.resolve(row.id, row.revision, "completed", "superseded: presence", row.revision, "hub");
    expect(journal.resolution(row.id)).toMatchObject({ actor: "hub", action: "completed", reason: "superseded: presence" });
    expect(() => journal.resolve(row.id, row.revision, "completed", "superseded: presence")).toThrow();
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("hot roster and unresolved queue reads exclude terminal payload history (#719)", () => {
  const { dir, journal } = open();
  try {
    const env = newEnvelope("user", "x".repeat(8192));
    journal.transaction(() => {
      for (let n = 0; n < 512; n++) journal.createDelivery({ id: `history-${n}`, peer: "retired", state: "failed", createdAt: env.ts + n, originals: [env], out: [env] });
      journal.createDelivery({ id: "held", peer: "codex", state: "needs_review", createdAt: env.ts, originals: [env], out: [env] });
    });
    const expected = journal.snapshot().revision, bus = new Bus({ journal });
    const list = journal.list.bind(journal), snapshot = journal.snapshot.bind(journal);
    journal.list = () => { throw new Error("full delivery history on hot path"); };
    journal.snapshot = () => { throw new Error("recovery snapshot on hot path"); };
    expect(() => bus.knownPeers()).not.toThrow();
    expect(bus.knownPeers()).toEqual(["codex"]);
    expect(journal.revision()).toBe(expected);
    expect(bus.queueSummary("codex")).toEqual({ needsReview: 1, heldBy: "held" });
    expect(bus.queueSummary("retired")).toEqual({ needsReview: 0 });
    expect(() => bus.queueList(undefined, true)).not.toThrow();
    expect(bus.queueList(undefined, true).map(row => row.id)).toEqual(["held"]);
    journal.list = list;
    // Explicit history still includes terminal rows and does not need a recovery snapshot.
    expect(bus.queueList()).toHaveLength(513);
    journal.snapshot = snapshot;
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("review input holds are ID-only, snapshot-restorable and absent after ordinary clear", () => {
  const source = open(), targetDir = mkdtempSync(join(tmpdir(), "ahub-review-input-restore-"));
  const target = new DeliveryJournal({ file: join(targetDir, "hub.db"), projectRoot: targetDir, projectId: "p", instanceId: "restored", operationId: "restore-review-input" });
  const hold = { peer: "claude", sessionHash: "a".repeat(64), inputHash: "b".repeat(64) };
  let reopenedSource: DeliveryJournal | undefined;
  try {
    expect(source.journal.snapshot()).not.toHaveProperty("reviewInputs");
    expect(source.journal.hasReviewInputState()).toBe(false);
    source.journal.holdReviewInput(hold);
    expect(source.journal.hasReviewInputState()).toBe(true);
    source.journal.close();
    reopenedSource = new DeliveryJournal({ file: join(source.dir, "hub.db"), projectRoot: source.dir, projectId: "p", instanceId: "i2" });
    expect(reopenedSource.readReviewInput(hold.peer, hold.sessionHash)).toBe(hold.inputHash);
    const snapshot = reopenedSource.snapshot();
    expect(snapshot.reviewInputs).toEqual([hold]);
    expect(Object.keys(snapshot.reviewInputs![0]!)).toEqual(["peer", "sessionHash", "inputHash"]);
    expect(target.importSnapshot(snapshot, "restore-review-input")).toBe(true);
    expect(target.readReviewInput(hold.peer, hold.sessionHash)).toBe(hold.inputHash);
    expect(target.readReviewInput(hold.peer, "c".repeat(64))).toBeUndefined();
    target.clearReviewInput(hold.peer);
    expect(target.hasReviewInputState()).toBe(false);
    expect(target.readReviewInput(hold.peer, hold.sessionHash)).toBeUndefined();
    expect(target.snapshot()).not.toHaveProperty("reviewInputs");
  } finally { source.journal.close(); reopenedSource?.close(); target.close(); rmSync(source.dir, { recursive: true, force: true }); rmSync(targetDir, { recursive: true, force: true }); }
});

test("review input metadata rejects malformed, accessor-backed and overbudget records", () => {
  const { dir, journal } = open(), sessionHash = "a".repeat(64), inputHash = "b".repeat(64);
  try {
    const empty = journal.snapshot();
    expect(() => validateJournalSnapshot({ ...empty, reviewInputs: [{ peer: "claude", sessionHash: "bad", inputHash }] })).toThrow("sessionHash is invalid");
    expect(() => validateJournalSnapshot({ ...empty, reviewInputs: [] })).toThrow("omitted when empty");
    expect(() => validateJournalSnapshot({ ...empty, reviewInputs: [{ peer: "claude", sessionHash, inputHash }, { peer: "claude", sessionHash, inputHash: "c".repeat(64) }] })).toThrow("duplicate snapshot review input peer");
    expect(() => validateJournalSnapshot({ ...empty, reviewInputs: Array.from({ length: 4097 }, (_, index) => ({ peer: `peer-${index}`, sessionHash, inputHash })) })).toThrow("exceeds 4096");
    let getterCalled = false;
    const accessor = Object.defineProperties({}, {
      peer: { enumerable: true, get: () => { getterCalled = true; return "claude"; } },
      sessionHash: { enumerable: true, value: sessionHash },
      inputHash: { enumerable: true, value: inputHash },
    });
    expect(() => journal.holdReviewInput(accessor)).toThrow("own data fields");
    expect(getterCalled).toBe(false);
    expect(() => journal.holdReviewInput({ peer: "claude", sessionHash, inputHash, body: "must not persist" })).toThrow("unexpected fields");
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("corrupt review input metadata and failed clear remain unknown or held", () => {
  const { dir, journal } = open(), sessionHash = "a".repeat(64), inputHash = "b".repeat(64);
  const db = (journal as unknown as { db: Database }).db;
  try {
    journal.holdReviewInput({ peer: "claude", sessionHash, inputHash });
    db.query("CREATE TRIGGER refuse_review_input_clear BEFORE DELETE ON review_input_holds BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END").run();
    expect(() => journal.clearReviewInput("claude")).toThrow("fixture write failure");
    expect(journal.readReviewInput("claude", sessionHash)).toBe(inputHash);

    db.query("DROP TRIGGER refuse_review_input_clear").run();
    db.query("UPDATE review_input_holds SET session_hash='bad' WHERE project_id='p' AND peer='claude'").run();
    expect(() => journal.hasReviewInputState()).toThrow("sessionHash is invalid");
    expect(() => journal.readReviewInput("claude", sessionHash)).toThrow("sessionHash is invalid");
    expect(() => journal.clearReviewInput("claude")).toThrow("sessionHash is invalid");
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});
