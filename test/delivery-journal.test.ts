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

test("review input provenance is ID-only, snapshot-restorable and session-scoped", () => {
  const source = open(), targetDir = mkdtempSync(join(tmpdir(), "ahub-review-input-restore-"));
  const target = new DeliveryJournal({ file: join(targetDir, "hub.db"), projectRoot: targetDir, projectId: "p", instanceId: "restored", operationId: "restore-review-input" });
  const hold = { peer: "claude", sessionHash: "a".repeat(64), inputHash: "b".repeat(64) };
  let reopenedSource: DeliveryJournal | undefined;
  try {
    expect(source.journal.snapshot().reviewInputProvenance).toMatchObject({ version: 2, complete: true, coverageComplete: true, count: 0, holds: [], incompletePeers: [], incompleteSessions: [] });
    expect(source.journal.hasReviewInputState()).toBe(false);
    source.journal.holdReviewInput(hold);
    expect(source.journal.hasReviewInputState()).toBe(true);
    source.journal.close();
    reopenedSource = new DeliveryJournal({ file: join(source.dir, "hub.db"), projectRoot: source.dir, projectId: "p", instanceId: "i2" });
    expect(reopenedSource.reviewInputState(hold.peer, hold.sessionHash)).toEqual({ state: "held", inputHash: hold.inputHash });
    const unresolvedReview = newEnvelope("hub", "legacy review still awaiting disposition", { kind: "review", to: ["new-peer"], refs: { reviewPackage: "reviewer-request-legacy" } });
    reopenedSource.createDelivery({ id: "legacy-review-unsettled", peer: "new-peer", state: "needs_review", createdAt: unresolvedReview.ts, originals: [unresolvedReview], out: [unresolvedReview] });
    const snapshot = reopenedSource.snapshot();
    expect(snapshot.reviewInputProvenance?.holds).toEqual([hold]);
    expect(Object.keys(snapshot.reviewInputProvenance!.holds[0]!)).toEqual(["peer", "sessionHash", "inputHash"]);
    expect(target.importSnapshot(snapshot, "restore-review-input")).toBe(true);
    expect(target.reviewInputState(hold.peer, hold.sessionHash)).toEqual({ state: "held", inputHash: hold.inputHash });
    expect(target.reviewInputState(hold.peer, "c".repeat(64))).toEqual({ state: "clean" });
    target.clearReviewInput(hold.peer, hold.sessionHash);
    expect(target.hasReviewInputState()).toBe(false);
    expect(target.reviewInputState(hold.peer, hold.sessionHash)).toEqual({ state: "clean" });
    expect(target.reviewInputState(hold.peer)).toEqual({ state: "clean" }); // Complete coverage makes absence clean after N3 prunes NULL receipts.
    expect(target.snapshot().reviewInputProvenance?.holds).toEqual([]);
    expect((target as unknown as { db: Database }).db.query("SELECT 1 FROM review_input_sessions WHERE project_id='p' AND input_hash IS NULL LIMIT 1").get()).toBeNull();

    const legacyTargetDir = mkdtempSync(join(tmpdir(), "ahub-legacy-review-input-"));
    const legacyTarget = new DeliveryJournal({ file: join(legacyTargetDir, "hub.db"), projectRoot: legacyTargetDir, projectId: "p", instanceId: "legacy", operationId: "restore-legacy" });
    try {
      const { reviewInputProvenance: _marker, ...legacySnapshot } = snapshot;
      expect(legacyTarget.importSnapshot(legacySnapshot, "restore-legacy")).toBe(true);
      expect(legacyTarget.reviewInputState("new-peer", "d".repeat(64))).toEqual({ state: "unknown" });
      expect(legacyTarget.hasReviewInputState()).toBe(true);
      legacyTarget.clearReviewInput("new-peer", "d".repeat(64)); // A positive ordinary ACK confirms only this session.
      expect(legacyTarget.reviewInputState("new-peer", "d".repeat(64))).toEqual({ state: "clean" });
      expect(legacyTarget.reviewInputEvidence("new-peer")).toMatchObject({ retainedSessionHold: false, retainedPeerSessionHold: false });
      expect(legacyTarget.reviewInputState("old-peer", "e".repeat(64))).toEqual({ state: "unknown" });
    } finally { legacyTarget.close(); rmSync(legacyTargetDir, { recursive: true, force: true }); }
  } finally { source.journal.close(); reopenedSource?.close(); target.close(); rmSync(source.dir, { recursive: true, force: true }); rmSync(targetDir, { recursive: true, force: true }); }
});

test("review input metadata rejects malformed, accessor-backed and overbudget records", () => {
  const { dir, journal } = open(), sessionHash = "a".repeat(64), inputHash = "b".repeat(64);
  try {
    const empty = journal.snapshot();
    const provenance = empty.reviewInputProvenance!;
    expect(() => validateJournalSnapshot({ ...empty, reviewInputProvenance: { ...provenance, holds: [{ peer: "claude", sessionHash: "bad", inputHash }] } })).toThrow("sessionHash is invalid");
    expect(() => validateJournalSnapshot({ ...empty, reviewInputProvenance: { ...provenance, holds: [{ peer: "claude", sessionHash, inputHash }, { peer: "claude", sessionHash, inputHash: "c".repeat(64) }] } })).toThrow("duplicate sessions");
    expect(() => validateJournalSnapshot({ ...empty, reviewInputProvenance: { ...provenance, holds: Array.from({ length: 4097 }, (_, index) => ({ peer: `peer-${index}`, sessionHash, inputHash })) } })).toThrow("exceeds 4096");
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

test("legacy held rows stay append-only and a session release does not certify other missing sessions", () => {
  const { dir, journal } = open(), sessionHash = "a".repeat(64), inputHash = "b".repeat(64);
  const db = (journal as unknown as { db: Database }).db;
  try {
    db.query("CREATE TABLE review_input_holds (project_id TEXT NOT NULL, peer TEXT NOT NULL, session_hash TEXT NOT NULL, input_hash TEXT NOT NULL, PRIMARY KEY(project_id,peer))").run();
    db.query("INSERT INTO review_input_holds(project_id,peer,session_hash,input_hash) VALUES('p','claude',?,?)").run(sessionHash, inputHash);
    const review = newEnvelope("hub", "legacy review awaiting disposition", { kind: "review", to: ["claude"], refs: { reviewPackage: "reviewer-request-v1-legacy" } });
    journal.createDelivery({ id: "v1-legacy-review", peer: "claude", state: "needs_review", createdAt: review.ts, originals: [review], out: [review] });
    db.query("UPDATE delivery_meta SET review_input_version=0,review_input_complete=0,review_input_coverage_complete=0,review_input_count=0,review_input_digest='',review_input_instance_id='' WHERE project_id='p'").run();
    journal.close();
    const reopened = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "i2" });
    const reopenedDb = (reopened as unknown as { db: Database }).db;
    expect(reopened.reviewInputState("claude", sessionHash)).toEqual({ state: "held", inputHash });
    expect(reopened.reviewInputState("claude", "c".repeat(64))).toEqual({ state: "unknown" });
    expect((reopenedDb.query("SELECT input_hash FROM review_input_holds WHERE project_id='p' AND peer='claude'").get() as { input_hash: string }).input_hash).toBe(inputHash);
    reopened.clearReviewInput("claude", sessionHash);
    expect(reopened.reviewInputState("claude", sessionHash)).toEqual({ state: "clean" });
    expect(reopened.reviewInputState("claude", "c".repeat(64))).toEqual({ state: "unknown" });
    reopened.close();
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("corrupt review input metadata and failed clear remain unknown or held", () => {
  const { dir, journal } = open(), sessionHash = "a".repeat(64), inputHash = "b".repeat(64);
  const db = (journal as unknown as { db: Database }).db;
  try {
    journal.holdReviewInput({ peer: "claude", sessionHash, inputHash });
    db.query("CREATE TRIGGER refuse_review_input_clear BEFORE UPDATE OF input_hash ON review_input_sessions BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END").run();
    expect(() => journal.clearReviewInput("claude", sessionHash)).toThrow("fixture write failure");
    expect(journal.reviewInputState("claude", sessionHash)).toEqual({ state: "held", inputHash });
    expect(journal.hasReviewInputState()).toBe(true);

    db.query("DROP TRIGGER refuse_review_input_clear").run();
    db.query("UPDATE review_input_sessions SET session_hash='bad' WHERE project_id='p' AND peer='claude'").run();
    expect(journal.hasReviewInputState()).toBe(true);
    expect(journal.reviewInputState("claude", sessionHash)).toEqual({ state: "unknown" });
    expect(() => journal.clearReviewInput("claude", sessionHash)).toThrow("sessionHash is invalid");
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("failed pre-handoff hold leaves the attempted session unknown without poisoning a new session", () => {
  const { dir, journal } = open();
  const db = (journal as unknown as { db: Database }).db;
  try {
    db.query("CREATE TRIGGER refuse_review_input_hold BEFORE INSERT ON review_input_sessions BEGIN SELECT RAISE(ABORT, 'fixture hold failure'); END").run();
    expect(() => journal.holdReviewInput({ peer: "claude", sessionHash: "a".repeat(64), inputHash: "b".repeat(64) })).toThrow("fixture hold failure");
    expect(journal.reviewInputState("claude", "a".repeat(64))).toEqual({ state: "unknown" });
    expect(journal.reviewInputState("claude", "c".repeat(64))).toEqual({ state: "clean" });
    expect(journal.hasReviewInputState()).toBe(true);
    expect(journal.snapshot().reviewInputProvenance).toMatchObject({ complete: true, coverageComplete: true, incompleteSessions: [{ peer: "claude", sessionHash: "a".repeat(64) }] });
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("lost provenance rows fail closed against the stored count and digest", () => {
  const { dir, journal } = open(), sessionHash = "a".repeat(64), inputHash = "b".repeat(64);
  const db = (journal as unknown as { db: Database }).db;
  try {
    journal.holdReviewInput({ peer: "claude", sessionHash, inputHash });
    db.query("DELETE FROM review_input_sessions WHERE project_id='p' AND peer='claude' AND session_hash=?").run(sessionHash);
    expect(journal.reviewInputState("claude", sessionHash)).toEqual({ state: "unknown" });
    expect(journal.hasReviewInputState()).toBe(true);
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("corrupt review provenance reopens as unknown while ordinary journal operations remain available", () => {
  const { dir, journal } = open(), sessionHash = "a".repeat(64), inputHash = "b".repeat(64), db = (journal as unknown as { db: Database }).db;
  try {
    journal.holdReviewInput({ peer: "claude", sessionHash, inputHash });
    const ordinary = newEnvelope("user", "ordinary journal row");
    journal.createDelivery({ id: "ordinary-row", peer: "codex", state: "queued", createdAt: ordinary.ts, originals: [ordinary], out: [ordinary] });
    db.query("UPDATE review_input_sessions SET input_hash='malformed' WHERE project_id='p' AND peer='claude'").run();
    journal.close();
    const reopened = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "i2" });
    expect(reopened.get("ordinary-row")).toMatchObject({ state: "queued", peer: "codex" });
    expect(reopened.reviewInputState("claude", sessionHash)).toEqual({ state: "unknown" });
    expect(reopened.reviewInputEvidence("claude", sessionHash)).toMatchObject({ provenance: "corrupt", sessionState: "unknown", retainedSessionHold: false, retainedPeerSessionHold: false });
    expect(reopened.reviewInputHealth()).toMatchObject({ state: "corrupt", cause: "provenance_corrupt" });
    expect(reopened.reviewInputHealth().nextStep).toContain("review-input provenance");
    expect(reopened.hasReviewInputState()).toBe(true);
    expect(() => reopened.snapshot()).toThrow("inputHash is invalid");
    const transport = reopened.transportSnapshot();
    expect(transport.deliveries).toContainEqual(expect.objectContaining({ id: "ordinary-row", state: "queued", peer: "codex" }));
    expect(transport).not.toHaveProperty("reviewInputProvenance");
    expect(() => reopened.holdReviewInput({ peer: "claude", sessionHash: "c".repeat(64), inputHash: "d".repeat(64) })).toThrow("inputHash is invalid");
    reopened.close();
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("review provenance digests bind the completeness flags", () => {
  const { dir, journal } = open(), db = (journal as unknown as { db: Database }).db;
  try {
    const snapshot = journal.snapshot(), provenance = snapshot.reviewInputProvenance!;
    expect(() => validateJournalSnapshot({ ...snapshot, reviewInputProvenance: { ...provenance, complete: false } })).toThrow("integrity does not match its rows");
    expect(() => validateJournalSnapshot({ ...snapshot, reviewInputProvenance: { ...provenance, coverageComplete: false } })).toThrow("integrity does not match its rows");
    db.query("UPDATE delivery_meta SET review_input_complete=0 WHERE project_id='p'").run();
    expect(journal.reviewInputState("claude", "a".repeat(64))).toEqual({ state: "unknown" });
    db.query("UPDATE delivery_meta SET review_input_complete=1,review_input_coverage_complete=0 WHERE project_id='p'").run();
    expect(journal.reviewInputState("claude", "a".repeat(64))).toEqual({ state: "unknown" });
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("reopened incomplete provenance is corrupt and cannot release peer or session holds", () => {
  const { dir, journal } = open(), peer = "claude", sessionHash = "a".repeat(64), inputHash = "b".repeat(64);
  try {
    journal.holdReviewInput({ peer, sessionHash, inputHash });
    journal.markReviewInputIncomplete(peer);
    (journal as unknown as { writeReviewInputProvenance(complete: boolean, coverageComplete: boolean): void }).writeReviewInputProvenance(false, true);
    journal.close();

    const reopened = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "incomplete-reopened" });
    const reopenedDb = (reopened as unknown as { db: Database }).db;
    try {
      expect(reopened.reviewInputEvidence(peer, sessionHash)).toMatchObject({ provenance: "corrupt", sessionState: "unknown", retainedSessionHold: false, retainedPeerSessionHold: false });
      expect(reopened.reviewInputHealth()).toMatchObject({ state: "corrupt", cause: "provenance_incomplete" });
      expect(() => reopened.clearReviewInputIncomplete(peer)).toThrow("provenance is incomplete");
      expect(() => reopened.clearReviewInput(peer, sessionHash)).toThrow("provenance is incomplete");
      expect(reopenedDb.query("SELECT input_hash FROM review_input_sessions WHERE project_id='p' AND peer=? AND session_hash=?").get(peer, sessionHash)).toMatchObject({ input_hash: inputHash });
      expect(reopenedDb.query("SELECT peer FROM review_input_incomplete_peers WHERE project_id='p' AND peer=?").get(peer)).toMatchObject({ peer });
    } finally { reopened.close(); }
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("reopened bad provenance digest stays corrupt after restart marks completeness false", () => {
  const { dir, journal } = open(), peer = "claude", sessionHash = "a".repeat(64), inputHash = "b".repeat(64);
  const db = (journal as unknown as { db: Database }).db;
  try {
    journal.holdReviewInput({ peer, sessionHash, inputHash });
    db.query("UPDATE delivery_meta SET review_input_digest=? WHERE project_id='p'").run("0".repeat(64));
    journal.close();

    const reopened = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "bad-digest-reopened" });
    const reopenedDb = (reopened as unknown as { db: Database }).db;
    try {
      expect(reopenedDb.query("SELECT review_input_complete FROM delivery_meta WHERE project_id='p'").get()).toMatchObject({ review_input_complete: 0 });
      expect(reopened.reviewInputEvidence(peer, sessionHash)).toMatchObject({ provenance: "corrupt", sessionState: "unknown", retainedSessionHold: false, retainedPeerSessionHold: false });
      expect(reopened.reviewInputHealth()).toMatchObject({ state: "corrupt", cause: "provenance_corrupt" });
      expect(() => reopened.clearReviewInputIncomplete(peer)).toThrow("integrity mismatch");
      expect(() => reopened.clearReviewInput(peer, sessionHash)).toThrow("integrity mismatch");
    } finally { reopened.close(); }
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("version-downgraded current provenance cannot auto-migrate or reseal on reopen", () => {
  const { dir, journal } = open(), sessionHash = "a".repeat(64), inputHash = "b".repeat(64), db = (journal as unknown as { db: Database }).db;
  try {
    journal.holdReviewInput({ peer: "claude", sessionHash, inputHash });
    db.query("CREATE TABLE review_input_holds (project_id TEXT NOT NULL, peer TEXT NOT NULL, session_hash TEXT NOT NULL, input_hash TEXT NOT NULL, PRIMARY KEY(project_id,peer))").run();
    db.query("INSERT INTO review_input_holds(project_id,peer,session_hash,input_hash) VALUES('p','claude',?,?)").run("c".repeat(64), "d".repeat(64));
    db.query("UPDATE delivery_meta SET review_input_version=1 WHERE project_id='p'").run();
    journal.close();
    const reopened = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "i2" });
    const reopenedDb = (reopened as unknown as { db: Database }).db;
    expect(reopened.reviewInputState("claude", sessionHash)).toEqual({ state: "unknown" });
    expect(reopened.reviewInputState("claude", "c".repeat(64))).toEqual({ state: "unknown" });
    expect(reopenedDb.query("SELECT * FROM review_input_sessions WHERE project_id='p'").all()).toHaveLength(1);
    expect(reopenedDb.query("SELECT input_hash FROM review_input_holds WHERE project_id='p' AND peer='claude'").get()).toMatchObject({ input_hash: "d".repeat(64) });
    reopened.close();
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("unbound identities and explicit incomplete markers stay scoped and fail closed", () => {
  const { dir, journal } = open();
  try {
    journal.markReviewInputIncomplete("claude", "a".repeat(64));
    expect(journal.reviewInputState("claude", "a".repeat(64))).toEqual({ state: "unknown" });
    expect(journal.reviewInputState("claude", "b".repeat(64))).toEqual({ state: "clean" });
    journal.markReviewInputIncomplete("agy");
    expect(journal.reviewInputState("agy", "c".repeat(64))).toEqual({ state: "unknown" });
    expect(journal.reviewInputState("pi", "d".repeat(64))).toEqual({ state: "clean" });
    expect(journal.hasReviewInputState()).toBe(true);
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("verified input clears only its own peer marker and selected session evidence", () => {
  const { dir, journal } = open(), sessionA = "a".repeat(64), sessionB = "b".repeat(64), incompleteSession = "e".repeat(64), hashA = "c".repeat(64), hashB = "d".repeat(64);
  try {
    journal.markReviewInputIncomplete("claude");
    journal.markReviewInputIncomplete("codex");
    journal.holdReviewInput({ peer: "codex", sessionHash: sessionA, inputHash: hashA });
    journal.holdReviewInput({ peer: "codex", sessionHash: sessionB, inputHash: hashB });
    journal.markReviewInputIncomplete("codex", incompleteSession);
    expect(journal.reviewInputEvidence("claude")).toMatchObject({ incompletePeer: true, retainedPeerSessionHold: false });
    journal.clearReviewInputIncomplete("claude"); // New native SID confirmation has no stable session receipt to clear.
    expect(journal.reviewInputEvidence("claude")).toMatchObject({ provenance: "available", incompletePeer: false, sessionState: "clean", retainedPeerSessionHold: false });
    expect(journal.reviewInputEvidence("codex", sessionA)).toMatchObject({ incompletePeer: true, sessionState: "unknown", retainedSessionHold: true, retainedPeerSessionHold: true });
    expect(journal.reviewInputEvidence("codex", sessionB)).toMatchObject({ incompletePeer: true, sessionState: "unknown", retainedSessionHold: true, retainedPeerSessionHold: true });
    expect(journal.reviewInputEvidence("codex", "f".repeat(64))).toMatchObject({ incompletePeer: true, sessionState: "unknown", retainedSessionHold: false, retainedPeerSessionHold: true });
    expect(journal.reviewInputEvidence("codex")).toMatchObject({ incompletePeer: true, sessionState: "unknown", retainedSessionHold: false, retainedPeerSessionHold: true });
    expect(journal.snapshot().reviewInputProvenance?.holds).toEqual([
      { peer: "codex", sessionHash: sessionA, inputHash: hashA },
      { peer: "codex", sessionHash: sessionB, inputHash: hashB },
    ]);

    journal.clearReviewInput("codex", sessionA); // Verified ordinary input releases its own marker and SID.
    expect(journal.reviewInputState("codex", sessionA)).toEqual({ state: "clean" });
    expect(journal.reviewInputEvidence("codex", sessionB)).toMatchObject({ incompletePeer: false, sessionState: "held", retainedSessionHold: true, retainedPeerSessionHold: true });
    expect(journal.reviewInputState("codex", sessionB)).toEqual({ state: "held", inputHash: hashB });
    expect(journal.reviewInputEvidence("codex", incompleteSession)).toMatchObject({ incompleteSession: true, sessionState: "unknown" });
    journal.markReviewInputIncomplete("agy", incompleteSession);
    expect(journal.reviewInputEvidence("agy", incompleteSession)).toMatchObject({ incompleteSession: true, sessionState: "unknown", retainedSessionHold: false, retainedPeerSessionHold: true });
    expect(journal.reviewInputEvidence("pi", "f".repeat(64))).toMatchObject({ retainedPeerSessionHold: false });
    expect(journal.reviewInputHealth()).toMatchObject({ state: "incomplete", cause: "incomplete_markers" });
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("legacy coverage ignores queued review work but retains handed accepted work", () => {
  for (const state of ["queued", "accepted"] as const) {
    const source = open(), targetDir = mkdtempSync(join(tmpdir(), `ahub-legacy-${state}-`));
    const target = new DeliveryJournal({ file: join(targetDir, "hub.db"), projectRoot: targetDir, projectId: "p", instanceId: `legacy-${state}` });
    try {
      const review = newEnvelope("hub", `${state} review request`, { kind: "review", to: ["claude"], refs: { task: "1", reviewPackage: `reviewer-request-${state}` } });
      source.journal.createDelivery({ id: `${state}-review`, peer: "claude", state, createdAt: review.ts, originals: [review], out: [review] });
      const { reviewInputProvenance: _provenance, ...legacySnapshot } = source.journal.snapshot();
      expect(target.importSnapshot(legacySnapshot, `legacy-${state}`)).toBe(true);
      const evidence = target.reviewInputEvidence("claude", "a".repeat(64));
      expect(evidence.coverageComplete).toBe(state === "queued");
      expect(evidence.sessionState).toBe(state === "queued" ? "clean" : "unknown");
    } finally { source.journal.close(); target.close(); rmSync(source.dir, { recursive: true, force: true }); rmSync(targetDir, { recursive: true, force: true }); }
  }
});

test("legacy coverage retains a handed host-stamped review response until it settles", () => {
  const source = open(), targetDir = mkdtempSync(join(tmpdir(), "ahub-legacy-response-"));
  const target = new DeliveryJournal({ file: join(targetDir, "hub.db"), projectRoot: targetDir, projectId: "p", instanceId: "legacy-response" });
  try {
    const response = newEnvelope("codex", "review response", { kind: "chat", refs: { reviewResponse: "reviewer-request-7" } });
    const row = source.journal.createDelivery({ id: "review-response", peer: "claude", state: "accepted", createdAt: response.ts, originals: [response], out: [response] });
    const { reviewInputProvenance: _provenance, ...legacySnapshot } = source.journal.snapshot();
    expect(target.importSnapshot(legacySnapshot, "legacy-review-response")).toBe(true);
    expect(target.reviewInputEvidence("claude", "a".repeat(64))).toMatchObject({ coverageComplete: false, sessionState: "unknown" });
    target.transition(row.id, "completed");
    expect(target.reviewInputEvidence("claude", "a".repeat(64))).toMatchObject({ coverageComplete: true, sessionState: "clean" });
  } finally { source.journal.close(); target.close(); rmSync(source.dir, { recursive: true, force: true }); rmSync(targetDir, { recursive: true, force: true }); }
});

test("legacy coverage waits for its captured rows but not new guarded review deliveries", () => {
  const source = open(), targetDir = mkdtempSync(join(tmpdir(), "ahub-legacy-captured-review-"));
  const target = new DeliveryJournal({ file: join(targetDir, "hub.db"), projectRoot: targetDir, projectId: "p", instanceId: "legacy-captured" });
  try {
    const priorReview = newEnvelope("hub", "pre-upgrade review", { kind: "review", to: ["claude"], refs: { reviewPackage: "reviewer-request-before-upgrade" } });
    const prior = source.journal.createDelivery({ id: "pre-upgrade-review", peer: "claude", state: "accepted", createdAt: priorReview.ts, originals: [priorReview], out: [priorReview] });
    const { reviewInputProvenance: _provenance, ...legacySnapshot } = source.journal.snapshot();
    expect(target.importSnapshot(legacySnapshot, "legacy-captured-review")).toBe(true);
    target.transition(prior.id, "queued"); // A captured handoff remains uncertain if a manual retry queues it again.
    expect(target.reviewInputEvidence("claude", "a".repeat(64))).toMatchObject({ coverageComplete: false, sessionState: "unknown" });
    target.transition(prior.id, "accepted");
    target.clearReviewInput("claude", "a".repeat(64));

    const currentReview = newEnvelope("hub", "current guarded review", { kind: "review", to: ["claude"], refs: { reviewPackage: "reviewer-request-current" } });
    target.holdReviewInput({ peer: "claude", sessionHash: "b".repeat(64), inputHash: "c".repeat(64) });
    target.createDelivery({ id: "current-review", peer: "claude", state: "accepted", createdAt: currentReview.ts, originals: [currentReview], out: [currentReview] });

    target.transition(prior.id, "completed");
    expect(target.reviewInputEvidence("claude", "b".repeat(64))).toMatchObject({ coverageComplete: true, sessionState: "held", retainedSessionHold: true });
    expect(target.get("current-review")?.state).toBe("accepted");
    expect((target as unknown as { db: Database }).db.query("SELECT 1 FROM review_input_sessions WHERE project_id='p' AND input_hash IS NULL LIMIT 1").get()).toBeNull();
  } finally { source.journal.close(); target.close(); rmSync(source.dir, { recursive: true, force: true }); rmSync(targetDir, { recursive: true, force: true }); }
});

test("legacy coverage completes after its final review delivery settles and prunes NULL clean receipts", () => {
  const source = open(), targetDir = mkdtempSync(join(tmpdir(), "ahub-legacy-coverage-"));
  const target = new DeliveryJournal({ file: join(targetDir, "hub.db"), projectRoot: targetDir, projectId: "p", instanceId: "legacy-target" });
  try {
    const review = newEnvelope("hub", "review request", { kind: "review", to: ["claude"], refs: { task: "1", reviewPackage: "reviewer-request-1" } });
    const row = source.journal.createDelivery({ id: "legacy-review", peer: "claude", state: "needs_review", createdAt: review.ts, originals: [review], out: [review] });
    const { reviewInputProvenance: _provenance, ...legacySnapshot } = source.journal.snapshot();
    expect(target.importSnapshot(legacySnapshot, "legacy-review-coverage")).toBe(true);
    expect(target.reviewInputEvidence("claude", "e".repeat(64))).toMatchObject({ coverageComplete: false, sessionState: "unknown" });
    target.clearReviewInput("claude", "f".repeat(64)); // Legacy confirmation stays explicit while old review work is unsettled.
    const targetDb = (target as unknown as { db: Database }).db;
    expect(targetDb.query("SELECT input_hash FROM review_input_sessions WHERE project_id='p' AND peer='claude' AND session_hash=?").get("f".repeat(64))).toMatchObject({ input_hash: null });
    const addClean = targetDb.query("INSERT INTO review_input_sessions(project_id,peer,session_hash,input_hash) VALUES('p',?,?,NULL)");
    for (let index = 0; index < 4095; index++) addClean.run(`legacy-peer-${index}`, index.toString(16).padStart(64, "0"));
    (target as unknown as { writeReviewInputProvenance(complete: boolean, coverageComplete: boolean): void }).writeReviewInputProvenance(true, false);
    expect(targetDb.query("SELECT COUNT(*) AS n FROM review_input_sessions WHERE project_id='p' AND input_hash IS NULL").get()).toMatchObject({ n: 4096 });

    target.transition(row.id, "completed");
    expect(target.reviewInputEvidence("claude", "e".repeat(64))).toMatchObject({ coverageComplete: true, sessionState: "clean" });
    expect(targetDb.query("SELECT 1 FROM review_input_sessions WHERE project_id='p' AND input_hash IS NULL LIMIT 1").get()).toBeNull();
    expect(target.get(row.id)?.state).toBe("completed"); // Settlement is observed, never replayed.
    expect(() => target.holdReviewInput({ peer: "new-peer", sessionHash: "a".repeat(64), inputHash: "b".repeat(64) })).not.toThrow();
    expect(target.reviewInputHealth()).toMatchObject({ state: "healthy", cause: null });
  } finally { source.journal.close(); target.close(); rmSync(source.dir, { recursive: true, force: true }); rmSync(targetDir, { recursive: true, force: true }); }
});

test("closed observer cleanup compare-and-deletes only the matching session receipt", () => {
  const { dir, journal } = open(), peer = "claude", sessionA = "a".repeat(64), sessionB = "c".repeat(64), hashA = "b".repeat(64), hashB = "d".repeat(64);
  try {
    journal.holdReviewInput({ peer, sessionHash: sessionA, inputHash: hashA });
    journal.holdReviewInput({ peer, sessionHash: sessionB, inputHash: hashB });
    expect(journal.forgetClosedObserverInput(peer, sessionA, "e".repeat(64))).toBe(false);
    expect(journal.reviewInputState(peer, sessionA)).toEqual({ state: "held", inputHash: hashA });
    expect(journal.forgetClosedObserverInput(peer, sessionA, hashA)).toBe(true);
    expect(journal.reviewInputState(peer, sessionA)).toEqual({ state: "clean" });
    expect(journal.reviewInputState(peer, sessionB)).toEqual({ state: "held", inputHash: hashB });

    journal.clearReviewInput(peer, sessionB);
    expect(journal.forgetClosedObserverInput(peer, sessionB, hashB)).toBe(false);
    expect(journal.reviewInputState(peer, sessionB)).toEqual({ state: "clean" });
    expect(journal.forgetClosedObserverInput(peer, sessionB, null)).toBe(false); // N3 already pruned the NULL receipt; absence is clean.
    expect(journal.reviewInputState(peer, sessionB)).toEqual({ state: "clean" });
    expect((journal as unknown as { db: Database }).db.query("SELECT 1 FROM review_input_sessions WHERE project_id='p' AND peer=? AND session_hash=?").get(peer, sessionB)).toBeNull();
    expect(journal.hasReviewInputState()).toBe(false);
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});
