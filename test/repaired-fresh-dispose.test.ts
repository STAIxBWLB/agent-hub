import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperation, disposeRecovery, publicOperation, nextChoices, planFingerprint, type RecoveryDriver, type UpgradePlan } from "../src/cli/upgrade.ts";
import { stopAndArchiveSummary } from "../src/cli/recovery-guidance.ts";
import { recordedFileState } from "../src/cli/recovery-session-file.ts";
import { PACKAGE_ROOT } from "../src/cli/upgrade-runtime.ts";
import { readOperation, writeOperation } from "../src/hub/recovery-store.ts";
import type { TerminalBinding } from "../src/cli/terminal-recovery.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(peer: "codex" | "claude", state: "found" | "missing" | "unknown" = "missing") {
  const home = mkdtempSync(join(tmpdir(), "ahub-repaired-dispose-")); roots.push(home);
  const launch = { packageEntrypoint: "/fixture/main.js", command: "fixture", argv: [], env: {} };
  const accepted: TerminalBinding = { peer, projectRoot: home, handle: "accepted", incarnationId: "inc", worktreeId: "worktree", sessionId: "accepted-conversation", launch, launchMetadata: launch };
  const planned = { ...accepted, sessionId: "planned-lost-conversation" };
  const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind: "restart", version: "0.12.31", sourceRoot: PACKAGE_ROOT, sourceDigest: "source", blockers: [],
    projects: [{ project: { id: "p", root: home, stateDir: join(home, "state"), basePort: 0, pid: null, instanceId: "source" }, source: { state: "running", peers: [{ id: peer, state: "idle" }], blockers: [] }, terminals: [planned], blockers: [] }] };
  const op = createOperation({ ...body, fingerprint: planFingerprint(body) }, PACKAGE_ROOT, home);
  Object.assign(op, { phase: "blocked", step: "restore:p", targetRoot: PACKAGE_ROOT, targetDigest: "target", missingRecordedSession: { projectId: "p", peer, sessionId: accepted.sessionId, kind: peer === "codex" ? "rollout" : "transcript" } });
  Object.assign(op.projects[0]!, { phase: "started", instanceId: "target", repairedSessions: { [peer]: true }, terminals: { [`restored:${peer}`]: { state: "failed" }, [`retired:${peer}`]: accepted } });
  writeOperation(op.id, op, home);
  const reads: unknown[] = [];
  const driver = { now: () => 100, inspect: async () => ({ state: "running", instanceId: "target", version: "0.12.31", peers: [], blockers: [], recovery: { operationId: op.id, phase: "restored" } }),
    recordedSessionState: async (...args: unknown[]) => { reads.push(args); return state; } } as unknown as RecoveryDriver;
  return { home, op, peer, accepted, reads, driver };
}
for (const peer of ["codex", "claude"] as const) test(`#166 a positively missing repaired ${peer} offers explicit fresh and records the accepted conversation as lost`, async () => {
  const f = fixture(peer);
  expect(nextChoices(f.op).some(choice => choice.kind === "fresh" && choice.peer === peer)).toBe(true);
  const chosen = await disposeRecovery(f.op.id, { fresh: peer }, "person accepts the recorded loss", f.driver, f.home);
  expect(chosen.projects[0]?.fresh?.[peer]).toMatchObject({ lost: f.accepted.sessionId, repaired: true });
  expect(chosen.audit?.at(-1)).toMatchObject({ action: "fresh-session", peer, projects: ["p"] });
  expect(chosen.freshOverride).toEqual({ peer, evidence: { projectId: "p", peer, sessionId: f.accepted.sessionId, kind: peer === "codex" ? "rollout" : "transcript" }, checked: "missing", at: 100 });
  expect(publicOperation(chosen).freshOverride).toEqual(chosen.freshOverride);
  expect(stopAndArchiveSummary(chosen).join("\n")).toContain(`accepted session 'accepted-conversation'`);
  expect(stopAndArchiveSummary(chosen).join("\n")).toContain("checked missing at 100");
  expect(f.reads).toHaveLength(1);
  expect(f.reads[0]).toEqual([f.accepted, peer === "codex" ? "rollout" : "transcript"]);
});
for (const state of ["found", "unknown"] as const) test(`#166 repaired fresh disposal refuses ${state} on its final typed read without recording a loss`, async () => {
  const f = fixture("codex", state);
  await expect(disposeRecovery(f.op.id, { fresh: "codex" }, "person request", f.driver, f.home)).rejects.toThrow("positively missing");
  expect(readOperation<any>(f.op.id, f.home).projects[0].fresh).toBeUndefined();
  expect(readOperation<any>(f.op.id, f.home).audit).toBeUndefined();
});
test("#166 absent or mismatched typed missing evidence never grants a repaired fresh choice", async () => {
  const f = fixture("codex");
  delete (f.op as any).missingRecordedSession;
  expect(nextChoices(f.op).some(choice => choice.kind === "fresh")).toBe(false);
  writeOperation(f.op.id, f.op, f.home);
  await expect(disposeRecovery(f.op.id, { fresh: "codex" }, "person request", f.driver, f.home)).rejects.toThrow("no failed restoration");
  Object.assign(f.op, { missingRecordedSession: { projectId: "p", peer: "codex", sessionId: "other", kind: "rollout" } });
  expect(nextChoices(f.op).some(choice => choice.kind === "fresh")).toBe(false);
});


test("#166 only ENOENT proves a missing session file; present and uncertain non-file evidence cannot authorize replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-session-file-evidence-")); roots.push(root);
  const file = join(root, "session.jsonl"), directory = join(root, "directory.jsonl");
  writeFileSync(file, "preserved"); mkdirSync(directory);
  expect(recordedFileState(file)).toBe("found");
  expect(recordedFileState(join(root, "missing.jsonl"))).toBe("missing");
  expect(recordedFileState(directory)).toBe("unknown");
  expect(recordedFileState(join(file, "not-a-directory"))).toBe("unknown");
});
