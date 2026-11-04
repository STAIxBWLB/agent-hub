import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { readRestartSnapshot, writeRestartSnapshot, type RestartSnapshot } from "../src/hub/restart.ts";

const oldSnapshot = (): RestartSnapshot => ({
  schemaVersion: 1, projectRoot: "/project", projectId: "evidence-project", sourceInstanceId: "source-instance", operationId: "evidence-operation", committedAt: 1,
  bus: { schemaVersion: 1, queues: {}, prefaces: {}, seen: [], attempts: {}, withdrawn: [] }, manualPaused: [], peers: [],
  integrity: { queues: {}, manualPaused: [], boardDigest: "a".repeat(64), budgetDigest: "b".repeat(64) },
});
const expected = { projectRoot: "/project", projectId: "evidence-project", operationId: "evidence-operation" };

test("legacy recovery snapshots without evidence integrity retain their shape and the new store starts empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-evidence-restart-")), board = new Board(join(dir, "hub.db"));
  try {
    expect(board.hasResearchEvidenceState()).toBe(false);
    expect(board.researchEvidenceIntegrity()).toMatchObject({ links: 0, revisions: 0 });
    const legacy = oldSnapshot(); writeRestartSnapshot(dir, legacy);
    expect(readRestartSnapshot(dir, expected)).toEqual(legacy);
    expect(readRestartSnapshot(dir, expected)!.integrity).not.toHaveProperty("researchEvidence");
    const evidence = { links: 1, revisions: 2, digest: "c".repeat(64) };
    const current = { ...legacy, integrity: { ...legacy.integrity!, researchEvidence: evidence } };
    writeRestartSnapshot(dir, current);
    expect(readRestartSnapshot(dir, expected)!.integrity!.researchEvidence).toEqual(evidence);
  } finally { board.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("evidence recovery integrity rejects malformed counters, digests and narrative fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-evidence-restart-bad-")), legacy = oldSnapshot();
  try {
    for (const value of [null, [], { links: -1, revisions: 1, digest: "c".repeat(64) }, { links: 1, revisions: 1.5, digest: "c".repeat(64) },
      { links: "1", revisions: 1, digest: "c".repeat(64) }, { links: 1, digest: "c".repeat(64) }, { links: 1, revisions: 1, digest: "not-a-hash" },
      { links: 1, revisions: 1, digest: "c".repeat(64), body: "PRIVATE_EVIDENCE_NARRATIVE" }]) {
      writeRestartSnapshot(dir, { ...legacy, integrity: { ...legacy.integrity!, researchEvidence: value } } as unknown as RestartSnapshot);
      expect(readRestartSnapshot(dir, expected)).toBeUndefined();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
