import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/hub/project.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { makeRecoveryDriver, PACKAGE_ROOT } from "../src/cli/upgrade-runtime.ts";
import { nextChoices, recordRestart, type PlannedProject, type ProjectProgress, type RecoveryOperation } from "../src/cli/upgrade.ts";
import type { TerminalBinding } from "../src/cli/terminal-recovery.ts";
import { VERSION } from "../src/version.ts";

/** Fake control and terminal-command boundaries only; no native peer or Orca process is opened. */
function fixture(peer: "claude" | "codex" | "pi") {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-repair-continuity-"))), stateDir = join(root, "state");
  const config = join(root, "claude"), codeHome = join(root, "codex"), sessionId = `recorded-${peer}`;
  const transcriptDir = join(config, "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(stateDir); mkdirSync(transcriptDir, { recursive: true }); mkdirSync(join(codeHome, "sessions"), { recursive: true });
  const transcript = peer === "claude" ? join(transcriptDir, `${sessionId}.jsonl`) : join(codeHome, "sessions", `${sessionId}.jsonl`);
  writeFileSync(transcript, "{}\n");
  const launch = { packageEntrypoint: "/fixture/main.js", command: "fixture only", argv: [], env: { CLAUDE_CONFIG_DIR: config, CODEX_HOME: codeHome } };
  const accepted: TerminalBinding = { peer, handle: "term-accepted", incarnationId: "inc-accepted", worktreeId: "wt", projectRoot: root, sessionId, launch, launchMetadata: launch,
    ...(peer === "pi" ? { sessionFile: join(root, "accepted-session.jsonl"), backend: "accepted-backend", model: "accepted-model" } : {}) };
  // A #215 accepted replacement was later repaired: its accepted id differs from the original plan.
  const plannedBinding: TerminalBinding = { ...accepted, handle: "term-planned", incarnationId: "inc-planned", sessionId: peer === "pi" ? sessionId : `planned-${peer}`,
    ...(peer === "pi" ? { sessionFile: join(root, "planned-session.jsonl"), backend: "planned-backend", model: "planned-model" } : {}) };
  const planned: PlannedProject = { project: { id: "repair-project", root, stateDir, instanceId: "i-source", pid: null, basePort: 0 },
    source: { state: "running", instanceId: "i-source", version: VERSION, protocol: PROTOCOL, peers: [{ id: peer, state: "idle", ...(peer === "codex" ? { threadId: plannedBinding.sessionId } : { sessionId: plannedBinding.sessionId }), ...(peer === "pi" ? { args: { mode: "tui" } } : {}) }], blockers: [] },
    terminals: [plannedBinding], ...(peer === "codex" ? { freshStart: [peer] } : {}), blockers: [] };
  const progress: ProjectProgress = { id: planned.project.id, phase: "peers-restored", instanceId: "i-target", terminals: { [`closed:${peer}`]: true, [`restored:${peer}`]: { state: "done", binding: accepted } },
    reattachments: { [peer]: { state: "attempted", at: 0, cause: "detached after restore", binding: accepted } } };
  const op = { schema: 1, id: "repair-operation", sourceRoot: PACKAGE_ROOT, targetRoot: PACKAGE_ROOT, plan: { version: VERSION, projects: [planned] }, projects: [progress] } as RecoveryOperation;
  let instanceId = "i-target", attached = false, attachmentPending = false, terminal: TerminalBinding | undefined = accepted, creates = 0, elapsed = 0;
  const control = { wrongSession: false, orphaned: false, interrupt: false };
  const calls: string[][] = [];
  const server = Bun.serve<any>({ hostname: "127.0.0.1", port: 0,
    fetch(request, srv) { return srv.upgrade(request) ? undefined : new Response("no"); },
    websocket: { message(ws, data) {
      const msg = JSON.parse(String(data));
      if (msg.t === "hello") ws.send(JSON.stringify({ rid: msg.rid, t: "welcome", ok: true, projectId: planned.project.id, instanceId, cwd: root, protocol: PROTOCOL }));
      else if (msg.t === "status") ws.send(JSON.stringify({ rid: msg.rid, t: "status", ok: true, status: { projectId: planned.project.id, instanceId, cwd: root, version: VERSION, protocol: PROTOCOL } }));
      else {
        const visible = attached, id = control.wrongSession ? "different-session" : sessionId;
        if (attachmentPending && !visible) queueMicrotask(() => { attached = true; attachmentPending = false; });
        ws.send(JSON.stringify({ rid: msg.rid, t: "recovery", ok: true, recovery: { operationId: op.id, phase: "restored", ready: visible,
          peers: { [peer]: { id: peer, state: visible ? "idle" : "offline", ...(visible ? peer === "codex" ? { threadId: id } : { sessionId: id, ...(peer === "pi" ? { sessionFile: accepted.sessionFile } : {}) } : {}) } }, integrity: { expected: {}, current: {} } } }));
      }
    } },
  });
  const status = () => writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: server.port, protocol: PROTOCOL, projectId: planned.project.id, instanceId, cwd: root }));
  writeFileSync(join(stateDir, "control-token"), "fixture-token\n"); status();
  const shown = () => terminal && ({ ...terminal, sessionId: attached && control.wrongSession ? "different-session" : terminal.sessionId,
    worktreePath: root, agentIdentity: peer, connected: !control.orphaned, orphaned: control.orphaned, state: control.orphaned ? "exited" : "idle" });
  const driver = makeRecoveryDriver(async argv => {
    calls.push(argv);
    if (argv[1] !== "terminal") throw new Error("native execution is forbidden in the fixture");
    let result: unknown;
    if (argv[2] === "list") result = { terminals: terminal ? [shown()] : [] };
    else if (argv[2] === "show") result = { terminal: shown() };
    else if (argv[2] === "wait") result = { wait: { satisfied: true } };
    else if (argv[2] === "close") { terminal = undefined; result = {}; }
    else if (argv[2] === "create") {
      creates++; attachmentPending = true; terminal = { ...accepted, handle: `term-created-${creates}`, incarnationId: `inc-created-${creates}` }; control.orphaned = false;
      result = { terminal: shown() };
    } else throw new Error("unexpected terminal mutation");
    return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
  }, undefined, { now: () => elapsed, sleep: async ms => { elapsed += ms; if (control.interrupt) throw new Error("fixture coordinator interrupted"); } });
  return { root, progress, planned, op, control, calls, accepted, creates: () => creates,
    removeTranscript: () => rmSync(transcript),
    restart: () => { recordRestart(progress, ++elapsed); instanceId = `i-target-${progress.restarts!.length}`; progress.instanceId = instanceId; progress.phase = "started"; attached = false; attachmentPending = false; status(); },
    restore: () => driver.restore(planned, progress, op, peer === "claude" ? "claude" : "native", () => {}),
    verify: () => driver.verify(planned, progress, op, () => {}),
    cleanup: () => { server.stop(true); rmSync(root, { recursive: true, force: true }); } };
}

test("#166 recording a restart retains repair provenance independently of the retired incarnation's attempt fence", () => {
  const f = fixture("claude");
  try {
    f.restart();
    expect((f.progress as any).repairedSessions).toEqual({ claude: true });
    expect(f.progress.reattachments).toBeUndefined();
    expect(f.progress.terminals["retired:claude"]).toEqual(f.accepted);
    f.progress.terminals["restored:claude"] = { state: "waiting", origin: "pending", binding: f.accepted };
    f.restart();
    expect((f.progress as any).repairedSessions).toEqual({ claude: true });
    expect(f.progress.restarts).toHaveLength(2);
  } finally { f.cleanup(); }
});

test("#166 an uncertain repair without a chosen binding retains its attempt fence across restart", () => {
  const f = fixture("claude");
  try {
    f.progress.terminals["restored:claude"] = { state: "pending" };
    f.restart();
    expect(f.progress.reattachments?.claude?.state).toBe("attempted");
    expect(f.progress.terminals["restored:claude"]).toEqual({ state: "pending" });
    expect(f.progress.terminals["retired:claude"]).toBeUndefined();
    expect(f.creates()).toBe(0);
  } finally { f.cleanup(); }
});

test("#166 failed repaired peers keep fresh-session choices disabled after their incarnation fence clears", () => {
  const f = fixture("claude");
  try {
    f.restart(); f.op.phase = "blocked";
    f.progress.terminals["restored:claude"] = { state: "failed" };
    expect(f.progress.reattachments).toBeUndefined();
    expect(nextChoices(f.op).some(choice => choice.kind === "fresh")).toBe(false);
    delete (f.progress as any).repairedSessions;
    expect(nextChoices(f.op).some(choice => choice.kind === "fresh" && choice.peer === "claude")).toBe(true);
  } finally { f.cleanup(); }
});

test("#166 arming a detachment repair durably pins the accepted conversation before any launch", async () => {
  const f = fixture("claude");
  try {
    delete f.progress.reattachments; f.control.orphaned = true;
    await expect(f.verify()).rejects.toThrow("detached after restore");
    expect((f.progress as any).repairedSessions).toEqual({ claude: true });
    expect((f.progress as ProjectProgress).reattachments?.claude).toMatchObject({ state: "ready", binding: { sessionId: "recorded-claude" } });
    expect(f.creates()).toBe(0);
  } finally { f.cleanup(); }
});

test("#166 a transcript-less repaired Claude remains recorded-session-only after repeated target restarts", async () => {
  const f = fixture("claude"); f.removeTranscript();
  try {
    f.restart(); await f.restore(); await f.verify();
    expect(f.progress.terminals["restored:claude"]).toMatchObject({ state: "done", binding: { sessionId: "recorded-claude" } });
    expect(f.creates()).toBe(1);
    const create = f.calls.find(args => args[2] === "create")!, closeIndex = f.calls.findIndex(args => args[2] === "close");
    expect(create[create.indexOf("--command") + 1]).toContain("'--resume' 'recorded-claude'");
    expect(closeIndex).toBeGreaterThanOrEqual(0); expect(closeIndex).toBeLessThan(f.calls.indexOf(create));
    f.restart(); f.control.wrongSession = true;
    await expect(f.restore()).rejects.toThrow(/different conversation|attached instead/);
    expect(f.creates()).toBe(2);
    await expect(f.restore()).rejects.toThrow(/different conversation|attached instead/);
    expect(f.creates()).toBe(2);
    expect(f.progress.terminals["restored:claude"]).toMatchObject({ state: "waiting", binding: { sessionId: "recorded-claude" } });
  } finally { f.cleanup(); }
});

test("#166 repaired Codex freshStart provenance cannot replace a missing rollout after a second restart", async () => {
  const f = fixture("codex");
  try {
    f.restart(); await f.restore(); await f.verify();
    expect(f.creates()).toBe(1);
    const create = f.calls.find(args => args[2] === "create")!;
    expect(create[create.indexOf("--command") + 1]).toContain("'resume' 'recorded-codex'");
    f.removeTranscript(); f.restart(); f.control.wrongSession = true;
    await expect(f.restore()).rejects.toThrow("no resumable transcript");
    expect(f.creates()).toBe(1);
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "failed" });
    expect((f.progress as any).repairedSessions).toEqual({ codex: true });
    await expect(f.restore()).rejects.toThrow("no resumable transcript");
    expect(f.creates()).toBe(1);
  } finally { f.cleanup(); }
});

test("#166 repaired Pi restart preserves its accepted file backend and model even when the session id matches the plan", async () => {
  const f = fixture("pi");
  try {
    f.restart(); const outcome = await f.restore().catch(error => error);
    const create = f.calls.find(args => args[2] === "create")!;
    const command = create[create.indexOf("--command") + 1]!;
    expect(command).toContain(`'--session-file' '${f.accepted.sessionFile}'`);
    expect(command).toContain("'--backend' 'accepted-backend'");
    expect(command).toContain("'--model' 'accepted-model'");
    expect(command).not.toContain("planned-session.jsonl");
    expect(command).not.toContain("planned-backend"); expect(command).not.toContain("planned-model");
    expect(outcome).toBeUndefined(); await f.verify();
    expect(f.progress.terminals["restored:pi"]).toMatchObject({ state: "done", binding: { sessionId: "recorded-pi", sessionFile: f.accepted.sessionFile, backend: "accepted-backend", model: "accepted-model" } });
    expect(f.creates()).toBe(1); expect(f.progress.reattachments).toBeUndefined();
  } finally { f.cleanup(); }
});
