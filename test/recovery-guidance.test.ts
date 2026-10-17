import { expect, test } from "bun:test";
import { recordedPeerGuidance, stopAndArchiveSummary } from "../src/cli/recovery-guidance.ts";
import { shellQuote, type TerminalBinding } from "../src/cli/terminal-recovery.ts";
import type { Inspection, PlannedProject, ProjectProgress, RecoveryOperation } from "../src/cli/upgrade.ts";

const root = "/fixture/project with 'spaces'";
const argv = (...words: string[]) => words.map(shellQuote).join(" ");
function binding(peer: "codex" | "pi" | "claude", sessionId: string, sessionFile?: string): TerminalBinding {
  const launch = { packageEntrypoint: "/source package/src/cli/main.js", command: "recorded only", argv: [], env: {} };
  return { peer, sessionId, ...(sessionFile ? { sessionFile } : {}), handle: `${peer}-handle`, incarnationId: "incarnation", worktreeId: "worktree", projectRoot: root, launch, launchMetadata: launch };
}
function fixture() {
  const planned: PlannedProject = {
    project: { id: "project-1", root, stateDir: "/fixture/state", basePort: 4600, instanceId: "source", pid: null },
    source: { state: "running", instanceId: "source", version: "0.12.30", peers: [
      { id: "codex", state: "idle", threadId: "original-thread" },
      { id: "pi", state: "idle", sessionId: "original-pi", sessionFile: "/sessions/original pi.jsonl" },
      { id: "claude", state: "idle", sessionId: "original-claude" },
    ], blockers: [] },
    terminals: [binding("codex", "original-thread"), binding("pi", "original-pi", "/sessions/original pi.jsonl"), binding("claude", "original-claude")], blockers: [],
  };
  const progress: ProjectProgress = { id: "project-1", phase: "peers-restored", instanceId: "target", terminals: {} };
  const op: RecoveryOperation = { schema: 1, id: "fixture-operation", phase: "cancelled", step: "disposed", sourceRoot: "/source package", targetRoot: "/target package", targetDigest: "target-digest", createdAt: 1, updatedAt: 2,
    plan: { schema: 1, kind: "upgrade", version: "0.12.31", sourceRoot: "/source package", sourceDigest: "source-digest", projects: [planned], fingerprint: "fixture", blockers: [] }, projects: [progress],
    disposition: { choice: "stop-and-archive", at: 2, projects: { "project-1": "target stopped" } }, pluginInstalled: true, globalInstalled: false };
  return { planned, progress, op };
}

test("#463 person guidance uses the current accepted conversation instead of the original plan", () => {
  const f = fixture();
  f.progress.terminals["restored:codex"] = { state: "done", binding: binding("codex", "accepted-thread") };
  f.progress.terminals["restored:pi"] = { state: "waiting", origin: "failed", binding: binding("pi", "accepted-pi", "/sessions/accepted 'pi'.jsonl") };
  const rows = recordedPeerGuidance(f.planned, f.progress, { reattachCommand: peer => argv("bun", "/source package/src/cli/main.js", "recovery", "reattach", f.op.id, peer) });
  const codex = rows.find(row => row.peer === "codex")!, pi = rows.find(row => row.peer === "pi")!, claude = rows.find(row => row.peer === "claude")!;
  expect(codex.sessionId).toBe("accepted-thread"); expect(codex.command).toBe(argv("ahub", "--project", root, "codex", "resume", "accepted-thread"));
  expect(codex.reattachCommand).toBe(argv("bun", "/source package/src/cli/main.js", "recovery", "reattach", f.op.id, "codex"));
  expect(pi.sessionFile).toBe("/sessions/accepted 'pi'.jsonl"); expect(pi.command).toBe(argv("ahub", "--project", root, "pi", "--session-file", "/sessions/accepted 'pi'.jsonl"));
  expect(claude.sessionId).toBe("original-claude"); expect(claude.command).toBe(argv("ahub", "--project", root, "claude", "--resume", "original-claude"));
  expect(claude.note).toContain("channel"); expect(claude.note).toContain("transcript"); expect(claude.note).not.toContain("transcript exists");
});

test("#463 an explicitly validated retained repair binding takes precedence without inventing a session", () => {
  const f = fixture(); f.progress.terminals["restored:pi"] = { state: "done", binding: binding("pi", "older-pi", "/older.jsonl") };
  const row = recordedPeerGuidance(f.planned, f.progress, { recorded: { pi: { sessionId: "repair-pi", sessionFile: "/sessions/repair.jsonl" } } }).find(row => row.peer === "pi")!;
  expect(row.sessionId).toBe("repair-pi"); expect(row.command).toBe(argv("ahub", "--project", root, "pi", "--session-file", "/sessions/repair.jsonl"));
  f.progress.terminals["restored:pi"] = { state: "unreadable" };
  expect(recordedPeerGuidance(f.planned, f.progress, { recorded: { pi: { sessionId: "repair-pi" } } }).find(row => row.peer === "pi")?.sessionId).toBe("repair-pi");
});

test("#463 malformed current receipts and missing identities remain unavailable rather than falling back to a plan", () => {
  const f = fixture(); f.progress.terminals["restored:codex"] = { state: "done", binding: {} };
  const row = recordedPeerGuidance(f.planned, f.progress).find(row => row.peer === "codex")!;
  expect(row.sessionId).toBeUndefined(); expect(row.command).toBeUndefined(); expect(row.note).toContain("unavailable");
  f.planned.terminals = []; f.planned.source.peers = [];
  for (const missing of recordedPeerGuidance(f.planned, { ...f.progress, terminals: {} })) { expect(missing.command).toBeUndefined(); expect(missing.note).toContain("unavailable"); }
});

test("#463 stop-and-archive distinguishes historical target, installed plugin and remaining global CLI", () => {
  const f = fixture();
  const text = stopAndArchiveSummary(f.op).join("\n");
  expect(text).toContain("abandoned, not completed"); expect(text).toContain("not rolled back");
  expect(text).toContain("0.12.31"); expect(text).toContain("had started"); expect(text).toContain("target stopped"); expect(text).not.toContain("currently running");
  expect(text).toContain("plugin installation recorded"); expect(text).toContain("global CLI installation remains");
  expect(text).toContain(argv("bun", "add", "-g", "@staix/agent-hub@0.12.31", "--ignore-scripts"));
});

test("#463 archive summary does not infer installation or a live target from a planned version", () => {
  const f = fixture(); f.progress.phase = "pending"; f.op.pluginInstalled = false; f.op.globalInstalled = true;
  const text = stopAndArchiveSummary(f.op).join("\n");
  expect(text).not.toContain("had started"); expect(text).toContain("plugin installation not recorded"); expect(text).toContain("global CLI installation recorded"); expect(text).not.toContain("bun' 'add");
  const live: Inspection = { state: "running", version: "0.12.99", instanceId: "other", peers: [], blockers: [] };
  expect(stopAndArchiveSummary(f.op, { "project-1": live }).join("\n")).not.toContain("currently running 0.12.31");
});
