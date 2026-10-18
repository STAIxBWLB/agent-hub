import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeRestoreReceipt } from "../src/cli/upgrade-restore-state.ts";
import { recordedPeerGuidance, resolveAcceptedBinding } from "../src/cli/recovery-guidance.ts";
import { shellQuote, type TerminalBinding } from "../src/cli/terminal-recovery.ts";
import type { PlannedProject, ProjectProgress } from "../src/cli/upgrade.ts";

function project(declared = true) {
  const root = mkdtempSync(join(tmpdir(), "ahub-instance-receipt-"));
  const init = spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
  if (init.status !== 0) throw new Error(`fixture git init failed: ${init.stderr}`);
  mkdirSync(join(root, ".agenthub"));
  const file = join(root, ".agenthub/config.local.json");
  writeFileSync(file, JSON.stringify(declared ? { instances: { "codex-2": { kind: "codex" } } } : {}));
  const launch = { packageEntrypoint: "/fixture/main.js", command: "recorded only", argv: ["bun", "/fixture/main.js"], env: {} };
  const binding: TerminalBinding = { peer: "codex-2", handle: "pane-2", incarnationId: "incarnation-2", worktreeId: "worktree", projectRoot: root, sessionId: "recorded-thread", launch, launchMetadata: launch };
  const planned: PlannedProject = { project: { id: root, root, stateDir: join(root, "state"), basePort: 4600, instanceId: "source", pid: null },
    source: { state: "running", instanceId: "source", version: "0.12.34", peers: [{ id: "codex-2", state: "idle", threadId: "source-thread" }], blockers: [] },
    terminals: [binding], blockers: [] };
  const progress: ProjectProgress = { id: root, phase: "peers-restored", instanceId: "target", terminals: { "restored:codex-2": { state: "done", binding } } };
  return { root, file, binding, planned, progress, close() { rmSync(root, { recursive: true, force: true }); } };
}

test("instance restore receipt decoder accepts only a current trusted launch-record declaration at its exact project", () => {
  const f = project(), other = project(false);
  try {
    expect(decodeRestoreReceipt({ state: "done", binding: f.binding })).toEqual({ state: "done", binding: f.binding });
    const roots = { ...f.binding, executionCwd: join(f.root, "worker"), terminalRoot: f.root };
    expect(decodeRestoreReceipt({ state: "done", binding: roots })).toEqual({ state: "done", binding: roots });
    expect(() => decodeRestoreReceipt({ state: "done", binding: { ...roots, executionCwd: {} } })).toThrow("invalid restore receipt");
    expect(decodeRestoreReceipt({ state: "waiting", origin: "pending", binding: f.binding })).toMatchObject({ state: "waiting", binding: { peer: "codex-2", projectRoot: f.root } });
    expect(() => decodeRestoreReceipt({ state: "done", binding: { ...f.binding, projectRoot: other.root } })).toThrow("invalid restore receipt");
    expect(() => decodeRestoreReceipt({ state: "done", binding: { ...f.binding, peer: "codex-unknown" } })).toThrow("invalid restore receipt");
    expect(() => resolveAcceptedBinding(f.planned, { ...f.progress, terminals: { "restored:codex-2": { state: "done", binding: { ...f.binding, projectRoot: other.root } } } }, "codex-2")).toThrow();
  } finally { f.close(); other.close(); }
});

test("instance recorded guidance uses the owning project's declaration and emits the exact --as recorded-thread command", () => {
  const f = project(), other = project(false);
  try {
    expect(resolveAcceptedBinding(f.planned, f.progress, "codex-2")).toEqual(f.binding);
    const row = recordedPeerGuidance(f.planned, f.progress).find(row => row.peer === "codex-2");
    expect(row?.sessionId).toBe("recorded-thread");
    expect(row?.command).toBe(["ahub", "--project", f.root, "codex", "--as", "codex-2", "resume", "recorded-thread"].map(shellQuote).join(" "));
    expect(row?.note).toContain("thread");
    expect(recordedPeerGuidance(other.planned, other.progress).some(row => row.peer === "codex-2")).toBe(false);
    // Resolving another project's catalog must not erase or globally install the first project's declaration.
    expect(recordedPeerGuidance(f.planned, f.progress).find(row => row.peer === "codex-2")?.command).toBe(row?.command);
  } finally { f.close(); other.close(); }
});

test("instance retained receipts refuse revoked or tracked declarations instead of guessing the suffix", () => {
  const f = project();
  try {
    expect(decodeRestoreReceipt(f.binding)?.state).toBe("done");
    writeFileSync(f.file, "{}");
    expect(() => decodeRestoreReceipt(f.binding)).toThrow("invalid restore receipt");
    expect(() => resolveAcceptedBinding(f.planned, f.progress, "codex-2")).toThrow();
    expect(recordedPeerGuidance(f.planned, f.progress).some(row => row.peer === "codex-2")).toBe(false);
    writeFileSync(f.file, JSON.stringify({ instances: { "codex-2": { kind: "codex" } } }));
    const add = spawnSync("git", ["-C", f.root, "add", ".agenthub/config.local.json"], { encoding: "utf8" });
    expect(add.status).toBe(0);
    expect(() => decodeRestoreReceipt(f.binding)).toThrow("invalid restore receipt");
    expect(recordedPeerGuidance(f.planned, f.progress).some(row => row.peer === "codex-2")).toBe(false);
  } finally { f.close(); }
});


test("instance missing Pi file archive guidance restarts the selected instance rather than the builtin", () => {
  const f = project();
  try {
    writeFileSync(f.file, JSON.stringify({ instances: { "pi-2": { kind: "pi" } } }));
    const binding: TerminalBinding = { ...f.binding, peer: "pi-2", sessionId: "saved-pi-instance", sessionFile: join(f.root, "missing-session.jsonl") };
    f.planned.terminals = [binding];
    f.planned.source.peers = [{ id: "pi-2", state: "idle", sessionId: binding.sessionId, sessionFile: binding.sessionFile }];
    f.progress.terminals = { "restored:pi-2": { state: "done", binding } };
    const row = recordedPeerGuidance(f.planned, f.progress, { stopAndArchiveCommand: "ahub recovery dispose fixture --stop-and-archive" }).find(row => row.peer === "pi-2");
    expect(row?.command).toBe(["ahub", "--project", f.root, "pi", "--as", "pi-2", "--session-file", binding.sessionFile!].map(shellQuote).join(" "));
    expect(row?.note).toContain(["ahub", "--project", f.root, "pi", "--as", "pi-2"].map(shellQuote).join(" "));
    expect(row?.note).toContain("positively missing");
  } finally { f.close(); }
});
