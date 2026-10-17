import { expect, test } from "bun:test";
import * as guidance from "../src/cli/recovery-guidance.ts";
import { publicOperation, recoveryCommand, recordRestart, type PlannedProject, type ProjectProgress, type RecoveryOperation } from "../src/cli/upgrade.ts";
import { shellQuote, type TerminalBinding } from "../src/cli/terminal-recovery.ts";

const root = "/fixture/accepted project";
function binding(peer: "codex" | "claude" | "pi", sessionId: string): TerminalBinding {
  const launch = { packageEntrypoint: "/source/main.js", command: "fixture only", argv: [], env: {} };
  return { peer, sessionId, projectRoot: root, handle: `${sessionId}-handle`, incarnationId: `${sessionId}-incarnation`, worktreeId: "fixture-worktree", launch, launchMetadata: launch,
    ...(peer === "pi" ? { sessionFile: `/sessions/${sessionId}.jsonl`, backend: `${sessionId}-backend`, model: `${sessionId}-model` } : {}) };
}
function fixture(peer: "codex" | "claude" | "pi" = "codex") {
  const original = binding(peer, "planned-session"), accepted = binding(peer, "accepted-session");
  const planned: PlannedProject = { project: { id: "accepted-project", root, stateDir: "/fixture/state", basePort: 0, instanceId: "source", pid: null },
    source: { state: "running", instanceId: "source", version: "0.12.31", peers: [{ id: peer, state: "idle", ...(peer === "codex" ? { threadId: original.sessionId } : { sessionId: original.sessionId, sessionFile: original.sessionFile }) }], blockers: [] }, terminals: [original], blockers: [] };
  const progress: ProjectProgress = { id: planned.project.id, phase: "peers-restored", instanceId: "target", terminals: { [`restored:${peer}`]: { state: "done", binding: accepted } },
    reattachments: { [peer]: { state: "attempted", at: 1, cause: "detached after restore", binding: accepted } } };
  const op = { schema: 1, id: "accepted-operation", phase: "cancelled", step: "disposed", sourceRoot: "/source", targetRoot: "/target", targetDigest: "digest", createdAt: 0, updatedAt: 1,
    plan: { schema: 1, kind: "restart", version: "0.12.31", sourceRoot: "/source", sourceDigest: "source", projects: [planned], fingerprint: "fixture", blockers: [] }, projects: [progress],
    disposition: { choice: "stop-and-archive", at: 1, projects: { [planned.project.id]: "target stopped" } } } as RecoveryOperation;
  return { original, accepted, planned, progress, op };
}
const resolve = (planned: PlannedProject, progress: ProjectProgress, peer: "codex" | "claude" | "pi"): TerminalBinding | undefined => {
  const resolver = (guidance as any).resolveAcceptedBinding;
  expect(typeof resolver).toBe("function");
  return resolver(planned, progress, peer);
};

test("#166 guidance after recordRestart names the accepted repaired Codex conversation, never the planned lost one", () => {
  const f = fixture(); recordRestart(f.progress, 2);
  expect(f.progress.reattachments).toBeUndefined(); expect(f.progress.terminals["restored:codex"]).toBeUndefined();
  const row = guidance.recordedPeerGuidance(f.planned, f.progress).find(row => row.peer === "codex")!;
  expect(row.sessionId).toBe(f.accepted.sessionId);
  expect(row.command).toBe(["ahub", "--project", root, "codex", "resume", f.accepted.sessionId].map(shellQuote).join(" "));
  expect(row.command).not.toContain(f.original.sessionId);
});

test("#166 the stop-and-archive summary after restart preserves every accepted conversation selector", () => {
  const f = fixture("pi"); recordRestart(f.progress, 2);
  const text = guidance.stopAndArchiveSummary(f.op).join("\n");
  expect(text).toContain(["ahub", "--project", root, "pi", "--session-file", f.accepted.sessionFile!].map(shellQuote).join(" "));
  expect(text).not.toContain(f.original.sessionFile!);
  expect(text).toContain("target stopped"); expect(text).toContain("abandoned, not completed");
});

for (const state of ["done", "waiting"] as const) test(`#166 accepted resolver prioritizes restored ${state} over marker retired and plan`, () => {
  const f = fixture("pi"), current = binding("pi", "current-session");
  f.progress.terminals["restored:pi"] = state === "done" ? { state, binding: current } : { state, origin: "pending", binding: current };
  f.progress.terminals["retired:pi"] = binding("pi", "retired-session");
  expect(resolve(f.planned, f.progress, "pi")).toEqual(current);
});

test("#166 accepted resolver uses the validated marker before retired and then retains all Pi archive metadata after restart", () => {
  const f = fixture("pi"); f.progress.terminals["restored:pi"] = { state: "failed" };
  f.progress.terminals["retired:pi"] = binding("pi", "older-retired");
  expect(resolve(f.planned, f.progress, "pi")).toEqual(f.accepted);
  f.progress.terminals["restored:pi"] = { state: "done", binding: f.accepted }; recordRestart(f.progress, 2);
  const resolved = resolve(f.planned, f.progress, "pi");
  expect(resolved).toEqual(f.accepted);
  expect(resolved).toMatchObject({ sessionFile: "/sessions/accepted-session.jsonl", backend: "accepted-session-backend", model: "accepted-session-model" });
});

test("#166 accepted resolver reaches the plan only when no accepted binding exists", () => {
  const f = fixture(); delete f.progress.reattachments; f.progress.terminals = { "restored:codex": { state: "pending" } };
  expect(resolve(f.planned, f.progress, "codex")).toEqual(f.original);
  f.planned.terminals = [];
  expect(resolve(f.planned, f.progress, "codex")).toBeUndefined();
});

for (const source of ["restored", "marker", "retired", "plan"] as const) test(`#166 malformed ${source} accepted evidence never falls through to a different conversation`, () => {
  const f = fixture(); delete f.progress.reattachments; f.progress.terminals = {};
  if (source === "restored") f.progress.terminals["restored:codex"] = { state: "done", binding: {} };
  if (source === "marker") f.progress.reattachments = { codex: { state: "ready", at: 1, cause: "detached after restore", binding: {} } } as any;
  if (source === "retired") f.progress.terminals["retired:codex"] = { ...f.accepted, projectRoot: "/another/project" };
  if (source === "plan") f.planned.terminals = [{ ...f.original, projectRoot: "/another/project" }];
  expect(() => resolve(f.planned, f.progress, "codex")).toThrow();
  const row = guidance.recordedPeerGuidance(f.planned, f.progress).find(row => row.peer === "codex")!;
  expect(row.command).toBeUndefined(); expect(row.sessionId).toBeUndefined(); expect(row.note).toContain("unavailable");
});

test("#166 a wrong-peer restored binding and an invalid marker envelope are unavailable even when retired identity is valid", () => {
  const f = fixture(); f.progress.terminals["retired:codex"] = f.accepted;
  f.progress.terminals["restored:codex"] = { state: "done", binding: binding("claude", "wrong-peer") };
  expect(() => resolve(f.planned, f.progress, "codex")).toThrow();
  delete f.progress.terminals["restored:codex"];
  (f.progress.reattachments!.codex as any).state = "invented";
  expect(() => resolve(f.planned, f.progress, "codex")).toThrow();
});

test("#166 public operation status keeps accepted Codex after restart and prioritizes a newer done receipt over a stale marker", () => {
  const f = fixture(); recordRestart(f.progress, 2);
  const retired = publicOperation(f.op).projects[0]!.recordedSessions!.find(row => row.peer === "codex")!;
  expect(retired.sessionId).toBe("accepted-session");
  expect(retired.command).toBe(["ahub", "--project", root, "codex", "resume", "accepted-session"].map(shellQuote).join(" "));
  expect(retired.command).not.toContain("planned-session");
  f.progress.reattachments = { codex: { state: "attempted", at: 1, cause: "detached after restore", binding: f.accepted } };
  f.progress.terminals["restored:codex"] = { state: "done", binding: binding("codex", "latest-accepted-session") };
  const current = publicOperation(f.op).projects[0]!.recordedSessions!.find(row => row.peer === "codex")!;
  expect(current.sessionId).toBe("latest-accepted-session");
  expect(current.command).toBe(["ahub", "--project", root, "codex", "resume", "latest-accepted-session"].map(shellQuote).join(" "));
  expect(current.command).not.toContain("planned-session");
});


test("#166 blocked Pi guidance names stop-and-archive and the normal Pi start when its accepted file is missing", () => {
  const f = fixture("pi"); recordRestart(f.progress, 2);
  f.op.phase = "blocked"; delete f.op.disposition;
  const row = publicOperation(f.op).projects[0]!.recordedSessions!.find(row => row.peer === "pi")!;
  expect(row.note).toContain("positively missing");
  expect(row.note).toContain(recoveryCommand(f.op, "dispose", "--stop-and-archive --reason <text>"));
  expect(row.note).toContain(["ahub", "--project", root, "pi"].map(shellQuote).join(" "));
  expect(row.note).toContain("Fresh-session is not supported for Pi");
});
