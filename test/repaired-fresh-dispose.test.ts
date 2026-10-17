import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperation, disposeRecovery, publicOperation, nextChoices, planFingerprint, type RecoveryDriver, type UpgradePlan } from "../src/cli/upgrade.ts";
import { stopAndArchiveSummary } from "../src/cli/recovery-guidance.ts";
import { checkedSessionPath, recordedFileState } from "../src/cli/recovery-session-file.ts";
import { PACKAGE_ROOT } from "../src/cli/upgrade-runtime.ts";
import { acquireRecoveryLock, releaseRecoveryLock, operationPath, readOperation, writeOperation } from "../src/hub/recovery-store.ts";
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
  Object.assign(op, { phase: "blocked", step: "restore:p", targetRoot: PACKAGE_ROOT, targetDigest: "target", missingRecordedSession: { projectId: "p", peer, sessionId: accepted.sessionId, kind: peer === "codex" ? "rollout" : "transcript", checkedPath: checkedSessionPath(accepted, peer === "codex" ? "rollout" : "transcript") } });
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
  expect(chosen.freshOverride).toEqual({ peer, evidence: { projectId: "p", peer, sessionId: f.accepted.sessionId, kind: peer === "codex" ? "rollout" : "transcript", checkedPath: checkedSessionPath(f.accepted, peer === "codex" ? "rollout" : "transcript") }, checked: "missing", at: 100 });
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

test("#168 Pi fresh refusal itself names the exact archive exit and normal project-scoped start", async () => {
  const f = fixture("codex");
  const before = readOperation<any>(f.op.id, f.home);
  let failure: unknown;
  try { await disposeRecovery(f.op.id, { fresh: "pi" }, "person request", f.driver, f.home); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("--stop-and-archive --reason <text>");
  expect((failure as Error).message).toContain(["ahub", "--project", f.home, "pi"].map(value => `'${value}'`).join(" "));
  expect((failure as Error).message).toContain("after stop-and-archive");
  expect(readOperation<any>(f.op.id, f.home)).toEqual(before);
});


test("#168 delegated repaired fresh refuses before lock claim inspection or receipt mutation", async () => {
  const f = fixture("codex"), before = readOperation<any>(f.op.id, f.home);
  const beforeBytes = readFileSync(operationPath(f.op.id, f.home), "utf8");
  releaseRecoveryLock(f.op.id, f.home); acquireRecoveryLock(randomUUID(), f.home);
  const delegated = { ...f.driver, liveTestPeer: "codex", inspect: async () => { throw new Error("inspection must not run for person-only repaired loss"); } };
  await expect(disposeRecovery(f.op.id, { fresh: "codex" }, "agent-authored loss", delegated, f.home)).rejects.toThrow("live-test cannot write person-attributed content");
  expect(readOperation<any>(f.op.id, f.home)).toEqual(before); expect(f.reads).toEqual([]);
  expect(readFileSync(operationPath(f.op.id, f.home), "utf8")).toBe(beforeBytes);
});

test("#168 ordinary non-repaired fresh disposal retains its existing live-test delegation", async () => {
  const f = fixture("codex");
  delete f.op.missingRecordedSession; delete f.op.projects[0]!.repairedSessions;
  writeOperation(f.op.id, f.op, f.home);
  const chosen = await disposeRecovery(f.op.id, { fresh: "codex" }, "existing delegated operational choice", { ...f.driver, liveTestPeer: "codex" }, f.home);
  expect(chosen.projects[0]!.fresh!.codex).toMatchObject({ lost: "planned-lost-conversation" });
  expect(chosen.projects[0]!.fresh!.codex!.repaired).toBeUndefined(); expect(chosen.freshOverride).toBeUndefined();
});

test("#168 the actual CLI refuses delegated repaired loss despite presentation prefixes and an unavailable operation lock", async () => {
  const f = fixture("codex"), before = readOperation<any>(f.op.id, f.home);
  const beforeBytes = readFileSync(operationPath(f.op.id, f.home), "utf8");
  releaseRecoveryLock(f.op.id, f.home); acquireRecoveryLock(randomUUID(), f.home);
  const home = join(f.home, "person-home"), amem = join(f.home, "amem"); mkdirSync(home); mkdirSync(amem);
  for (const prefix of [[], ["--json"], ["--color=never", "--verbose"]]) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.js"), "--project", f.home, "--live-test", "recovery", ...prefix, "dispose", f.op.id, "--fresh-session", "codex", "--reason", "agent-authored loss"], {
      cwd: f.home, env: { PATH: process.env.PATH, HOME: home, AMEM_HOME: amem, AGENTHUB_HOME: f.home, AGENTHUB_PEER_ID: "codex", TERM: "dumb" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1); expect(out).toBe("");
    expect(err).toContain("live-test cannot write person-attributed content");
    expect(readOperation<any>(f.op.id, f.home)).toEqual(before);
    expect(readFileSync(operationPath(f.op.id, f.home), "utf8")).toBe(beforeBytes);
  }
});


test("#168 status and a final unknown-store refusal show the exact path that was checked", async () => {
  const f = fixture("codex", "unknown"), path = checkedSessionPath(f.accepted, "rollout");
  f.op.missingRecordedSession!.checkedPath = path; writeOperation(f.op.id, f.op, f.home);
  expect(publicOperation(f.op).missingRecordedSession!.checkedPath).toBe(path);
  let failure: unknown;
  try { await disposeRecovery(f.op.id, { fresh: "codex" }, "person request", f.driver, f.home); } catch (error) { failure = error; }
  expect((failure as Error).message).toContain(JSON.stringify(path));
  expect((failure as Error).message).toContain("not positively missing");
  expect(readOperation<any>(f.op.id, f.home).freshOverride).toBeUndefined();
});


for (const kind of ["missing", "parse", "peer-absent", "invalid-plan", "ordinary"] as const) test(`#168 delegated CLI classification is fail-closed for ${kind} and preserves ordinary refusal behavior`, async () => {
  const f = fixture("codex");
  if (kind === "missing") rmSync(operationPath(f.op.id, f.home));
  if (kind === "parse") writeFileSync(operationPath(f.op.id, f.home), "{");
  if (kind === "invalid-plan") { f.op.plan.fingerprint = "invalid"; writeOperation(f.op.id, f.op, f.home); }
  if (kind === "ordinary") { delete f.op.missingRecordedSession; delete f.op.projects[0]!.repairedSessions; writeOperation(f.op.id, f.op, f.home); }
  releaseRecoveryLock(f.op.id, f.home); acquireRecoveryLock(randomUUID(), f.home);
  const home = join(f.home, "person-home"), amem = join(f.home, "amem"); mkdirSync(home); mkdirSync(amem);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.js"), "--project", f.home, "--live-test", "recovery", "dispose", f.op.id, "--fresh-session", kind === "peer-absent" ? "claude" : "codex", "--reason", "fixture reason"], {
    cwd: f.home, env: { PATH: process.env.PATH, HOME: home, AMEM_HOME: amem, AGENTHUB_HOME: f.home, AGENTHUB_PEER_ID: "codex", TERM: "dumb" }, stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(1); expect(out).toBe("");
  if (kind === "ordinary") {
    expect(err).toContain("another recovery operation owns this machine");
    expect(err).not.toContain("live-test cannot write person-attributed content");
  } else expect(err).toContain("live-test cannot write person-attributed content");
});
