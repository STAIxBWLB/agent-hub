import { expect, test } from "bun:test";
import { recordRestart, type ProjectProgress } from "../src/cli/upgrade.ts";
import type { TerminalBinding, TerminalPeer } from "../src/cli/terminal-recovery.ts";

function acceptedBinding(peer: TerminalPeer): TerminalBinding {
  const launch = { packageEntrypoint: "/recorded/main.js", command: "not executed", argv: [], env: {} };
  return { peer, handle: `repaired-${peer}`, incarnationId: `inc-repaired-${peer}`, worktreeId: "worktree", projectRoot: "/fixture/project",
    sessionId: `accepted-${peer}`, ...(peer === "pi" ? { sessionFile: "/fixture/pi-session.jsonl", backend: "dgx", model: "dgx/coding" } : {}), launch, launchMetadata: launch };
}

for (const peer of ["codex", "claude", "pi"] as const) for (const state of ["done", "waiting"] as const) {
  test(`#463 target restart retires the accepted ${peer} ${state} binding and clears its old-instance repair fence`, () => {
    const binding = acceptedBinding(peer);
    const receipt = state === "done" ? { state, binding } : { state, origin: "failed", binding };
    const progress: ProjectProgress = { id: "project", phase: "peers-restored", instanceId: "target-that-died", releaseRequested: true,
      restarts: [{ instanceId: "older-target", at: 1 }],
      reattachments: { [peer]: { state: "attempted", at: 10, cause: "detached after restore", binding } },
      terminals: { [`restored:${peer}`]: receipt, [`closedRetired:${peer}`]: true, [`closed:${peer}`]: true } };
    recordRestart(progress, 20);
    expect(progress.phase).toBe("stopped"); expect(progress.instanceId).toBeUndefined();
    expect(progress.restarts).toEqual([{ instanceId: "older-target", at: 1 }, { instanceId: "target-that-died", at: 20 }]);
    expect(progress.terminals[`retired:${peer}`]).toEqual(binding);
    expect(progress.terminals[`restored:${peer}`]).toBeUndefined();
    expect(progress.terminals[`closedRetired:${peer}`]).toBeUndefined();
    expect(progress.terminals[`closed:${peer}`]).toBe(true);
    expect(progress.reattachments?.[peer]).toBeUndefined();
    expect(progress.releaseRequested).toBe(true);
  });
}
