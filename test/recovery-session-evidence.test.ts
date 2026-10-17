import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as files from "../src/cli/recovery-session-file.ts";
import { makeRecoveryDriver, PACKAGE_ROOT } from "../src/cli/upgrade-runtime.ts";
import { MissingRecordedSession, type PlannedProject, type ProjectProgress, type RecoveryOperation } from "../src/cli/upgrade.ts";
import type { TerminalBinding } from "../src/cli/terminal-recovery.ts";
import { realPath } from "../src/hub/project.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { VERSION } from "../src/version.ts";

function binding(root: string, peer: "codex" | "claude", env: Record<string, string> = {}): TerminalBinding {
  const launch = { packageEntrypoint: "/fixture/main.js", command: "fixture only", argv: [], env };
  return { peer, sessionId: "accepted-session", projectRoot: root, handle: "chosen-terminal", incarnationId: "chosen-incarnation", worktreeId: "chosen-worktree", launch, launchMetadata: launch };
}
function checkedPath(saved: TerminalBinding, kind: "rollout" | "transcript"): string {
  const resolve = (files as any).checkedSessionPath;
  expect(typeof resolve).toBe("function");
  return resolve(saved, kind);
}

test("#168 checked session paths retain captured homes and the exact existing project slug", () => {
  const saved = binding("/fixture/project with 'spaces'/path\\name", "claude", { CLAUDE_CONFIG_DIR: "/captured Claude", CODEX_HOME: "/captured Codex" });
  expect(checkedPath(saved, "rollout")).toBe(join("/captured Codex", "sessions"));
  expect(checkedPath(saved, "transcript")).toBe(join("/captured Claude", "projects", saved.projectRoot.replace(/[^a-zA-Z0-9]/g, "-"), "accepted-session.jsonl"));
});

test("#168 default checked session paths match the native default homes without reading those homes", () => {
  const saved = binding("/fixture/project", "codex");
  expect(checkedPath(saved, "rollout")).toBe(join(homedir(), ".codex", "sessions"));
  expect(checkedPath(saved, "transcript")).toBe(join(homedir(), ".claude", "projects", "-fixture-project", "accepted-session.jsonl"));
});

for (const kind of ["rollout", "transcript"] as const) test(`#168 actual ${kind} lookup reads the same captured path exposed by checked-path evidence`, async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-session-lookup-")));
  const saved = binding(root, kind === "rollout" ? "codex" : "claude", { CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex") });
  const driver = makeRecoveryDriver(async () => { throw new Error("native execution is forbidden"); });
  try {
    const checked = checkedPath(saved, kind), file = kind === "rollout" ? join(checked, "nested", `rollout-${saved.sessionId}.jsonl`) : checked;
    expect(await driver.recordedSessionState!(saved, kind)).toBe("missing");
    mkdirSync(kind === "rollout" ? join(checked, "nested") : join(checked, ".."), { recursive: true });
    writeFileSync(file, "{}\n");
    expect(await driver.recordedSessionState!(saved, kind)).toBe("found");
    rmSync(file);
    expect(await driver.recordedSessionState!(saved, kind)).toBe("missing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const peer of ["codex", "claude"] as const) test(`#168 actual ${peer} missing-session error exposes the exact accepted store checked by the runtime`, async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-runtime-session-evidence-"))), stateDir = join(root, "state"); mkdirSync(stateDir);
  const saved = binding(root, peer, { CLAUDE_CONFIG_DIR: join(root, "captured-claude"), CODEX_HOME: join(root, "captured-codex") });
  const planned: PlannedProject = { project: { id: "session-evidence", root, stateDir, instanceId: "source", pid: null, basePort: 0 },
    source: { state: "running", instanceId: "source", version: VERSION, protocol: PROTOCOL, peers: [{ id: peer, state: "idle", ...(peer === "codex" ? { threadId: saved.sessionId } : { sessionId: saved.sessionId }) }], blockers: [] }, terminals: [saved], blockers: [] };
  const progress: ProjectProgress = { id: planned.project.id, phase: "started", instanceId: "target", repairedSessions: { [peer]: true },
    terminals: { [`closed:${peer}`]: true, [`retired:${peer}`]: saved, [`closedRetired:${peer}`]: true,
      [`restored:${peer}`]: peer === "claude" ? { state: "waiting", origin: "pending", binding: saved } : { state: "failed" } } };
  const operation = { schema: 1, id: "session-evidence-operation", sourceRoot: PACKAGE_ROOT, targetRoot: PACKAGE_ROOT, plan: { version: VERSION, projects: [planned] }, projects: [progress] } as RecoveryOperation;
  const server = Bun.serve<any>({ hostname: "127.0.0.1", port: 0,
    fetch(request, srv) { return srv.upgrade(request) ? undefined : new Response("no"); },
    websocket: { message(ws, data) {
      const msg = JSON.parse(String(data));
      if (msg.t === "hello") ws.send(JSON.stringify({ rid: msg.rid, t: "welcome", ok: true, projectId: planned.project.id, instanceId: "target", cwd: root, protocol: PROTOCOL }));
      else if (msg.t === "status") ws.send(JSON.stringify({ rid: msg.rid, t: "status", ok: true, status: { projectId: planned.project.id, instanceId: "target", cwd: root, version: VERSION, protocol: PROTOCOL } }));
      else ws.send(JSON.stringify({ rid: msg.rid, t: "recovery", ok: true, recovery: { operationId: operation.id, phase: "restored", peers: { [peer]: { id: peer, state: "offline" } }, integrity: { expected: {}, current: {} } } }));
    } },
  });
  writeFileSync(join(stateDir, "control-token"), "fixture-token\n");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: server.port, protocol: PROTOCOL, projectId: planned.project.id, instanceId: "target", cwd: root }));
  let clock = 0, nativeCalls = 0;
  const driver = makeRecoveryDriver(async () => { nativeCalls++; throw new Error("native execution is forbidden"); }, undefined,
    { now: () => clock, sleep: async ms => { clock += ms; throw new Error("fixture interrupts chosen missing-transcript wait"); } });
  try {
    const error = await driver.restore(planned, progress, operation, peer === "claude" ? "claude" : "native", () => {}).catch(error => error);
    expect(error).toBeInstanceOf(MissingRecordedSession);
    const expected = peer === "codex" ? join(root, "captured-codex", "sessions") : join(root, "captured-claude", "projects", root.replace(/[^a-zA-Z0-9]/g, "-"), `${saved.sessionId}.jsonl`);
    expect(error.evidence).toEqual({ projectId: planned.project.id, peer, sessionId: saved.sessionId, kind: peer === "codex" ? "rollout" : "transcript", checkedPath: expected });
    expect(checkedPath(saved, error.evidence.kind)).toBe(expected);
    expect(await driver.recordedSessionState!(saved, error.evidence.kind)).toBe("missing");
    expect(nativeCalls).toBe(0);
    expect(progress.terminals[`restored:${peer}`]).toEqual({ state: "failed" });
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
