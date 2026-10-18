import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRecoveryDriver } from "../src/cli/upgrade-runtime.ts";
import type { PlannedProject, ProjectProgress, RecoveryOperation } from "../src/cli/upgrade.ts";
import type { TerminalBinding } from "../src/cli/terminal-recovery.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { VERSION } from "../src/version.ts";

/** The source protocol fixture enforces the cancelled-board target gate on every lease renewal. */
function renewalFixture(resumed: boolean, features: readonly string[] = ["task_cancel"]) {
  const root = mkdtempSync(join(tmpdir(), "ahub-478-features-")), stateDir = join(root, "state");
  mkdirSync(stateDir);
  const operationId = "feature-renewal", instanceId = "source-instance", projectId = "feature-project";
  const requests: { t: string; op?: string; targetFeatures?: readonly string[] }[] = [];
  let held = resumed;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response("no"); },
    websocket: { message(socket, data) {
      const message = JSON.parse(String(data));
      if (message.t === "hello") socket.send(JSON.stringify({ t: "welcome", rid: message.rid, ok: true, projectId, instanceId, cwd: root, protocol: PROTOCOL }));
      else if (message.t === "status") socket.send(JSON.stringify({ t: "status", rid: message.rid, ok: true, status: { projectId, instanceId, cwd: root, protocol: PROTOCOL, version: VERSION } }));
      else {
        requests.push(message);
        const checked = message.op === "prepare" || message.op === "commit" || message.op === "inspect" && message.targetFeatures !== undefined;
        if (checked && !message.targetFeatures?.includes("task_cancel")) {
          socket.send(JSON.stringify({ t: "recovery", rid: message.rid, ok: false, error: "target lacks task_cancel; cancelled tasks: #4" }));
          return;
        }
        if (message.op === "prepare") held = true;
        socket.send(JSON.stringify({ t: "recovery", rid: message.rid, ok: true, recovery: { operationId: held ? operationId : undefined,
          phase: held ? "prepared" : undefined, ready: held, peers: { pi: { id: "pi", state: "idle", sessionId: "pi-session" } } } }));
      }
    } },
  });
  writeFileSync(join(stateDir, "control-token"), "feature-token\n");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: server.port, protocol: PROTOCOL, instanceId, projectId, cwd: root }));
  const project = { id: projectId, root, stateDir, instanceId, pid: null, basePort: 4600 };
  const launch = { packageEntrypoint: "/candidate/main.js", command: "bun /candidate/main.js pi", argv: [], env: {} };
  const binding: TerminalBinding = { peer: "pi", handle: "pi-terminal", incarnationId: "pi-incarnation", worktreeId: "project-worktree", projectRoot: root,
    sessionId: "pi-session", sessionFile: join(stateDir, "pi-session.jsonl"), launch, launchMetadata: launch };
  const retired: TerminalBinding = { ...binding, peer: "claude", handle: "claude-terminal", incarnationId: "claude-incarnation", sessionId: "claude-session" };
  const planned: PlannedProject = { project, source: { state: "running", instanceId, version: VERSION, protocol: PROTOCOL,
    peers: [{ id: "pi", state: "idle", sessionId: binding.sessionId }], blockers: [] }, terminals: resumed ? [retired, binding] : [binding], blockers: [] };
  const progress: ProjectProgress = { id: projectId, phase: "prepared", terminals: resumed ? { "closed:claude": true } : {} };
  let op = { id: operationId, targetFeatures: features, projects: [progress], plan: { version: VERSION, projects: [planned] } } as RecoveryOperation;
  if (resumed) {
    // Load the same stored capability proof and close receipt that a resumed prepared operation uses.
    const file = join(root, "saved-receipt.json"); writeFileSync(file, JSON.stringify(op)); op = JSON.parse(readFileSync(file, "utf8"));
  }
  const terminalCommands: string[][] = [], journal: unknown[] = [];
  let closed = false;
  const driver = makeRecoveryDriver(async argv => {
    terminalCommands.push(argv);
    let result: unknown;
    if (argv[2] === "show") result = { terminal: { handle: binding.handle, incarnationId: binding.incarnationId, worktreeId: binding.worktreeId, worktreePath: root, connected: true } };
    else if (argv[2] === "wait") result = { wait: { satisfied: true } };
    else if (argv[2] === "close") { closed = true; result = {}; }
    else if (argv[2] === "list") result = { terminals: [] };
    else throw new Error(`unexpected terminal command ${argv.join(" ")}`);
    return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
  });
  return { project, planned, progress: op.projects[0]!, op, driver, requests, terminalCommands, journal, held: () => held, closed: () => closed,
    save: () => journal.push(JSON.parse(JSON.stringify(op.projects[0]!.terminals))),
    cleanup: () => { server.stop(true); rmSync(root, { recursive: true, force: true }); } };
}

for (const resumed of [false, true]) test(`#478 ${resumed ? "resumed" : "fresh"} cancelled-task recovery keeps target features on managed-TUI lease renewal`, async () => {
  const f = renewalFixture(resumed);
  try {
    if (!resumed) await f.driver.prepare(f.project, f.op.id, f.planned.source.instanceId!, f.op.targetFeatures);
    await f.driver.closeTerminals(f.planned, f.progress, f.op, f.save);
    await f.driver.commit(f.project, f.op.id, f.planned.source.instanceId!, f.op.targetFeatures);
    const prepares = f.requests.filter(request => request.op === "prepare");
    expect(prepares).toHaveLength(resumed ? 1 : 2);
    expect(prepares.map(request => request.targetFeatures)).toEqual(resumed ? [["task_cancel"]] : [["task_cancel"], ["task_cancel"]]);
    expect(f.requests.filter(request => request.op === "commit").map(request => request.targetFeatures)).toEqual([["task_cancel"]]);
    expect(f.closed()).toBe(true);
    expect(f.terminalCommands.filter(argv => argv[2] === "close").map(argv => argv[4])).toEqual(["pi-terminal"]);
    expect(f.journal).toContainEqual(expect.objectContaining({ "closed:pi": "pending" }));
    expect(f.progress.terminals["closed:pi"]).toBe(true);
    if (resumed) expect(f.progress.terminals["closed:claude"]).toBe(true);
  } finally { f.cleanup(); }
});

for (const action of ["inspect", "prepare", "commit"] as const) test(`#478 incompatible target ${action} refuses cancelled tasks before source or terminal effects`, async () => {
  const f = renewalFixture(false, []);
  try {
    const request = action === "inspect" ? f.driver.inspect(f.project, f.op.targetFeatures)
      : f.driver[action](f.project, f.op.id, f.planned.source.instanceId!, f.op.targetFeatures);
    await expect(request).rejects.toThrow("target lacks task_cancel; cancelled tasks: #4");
    expect(f.held()).toBe(false);
    expect(f.terminalCommands).toEqual([]);
    expect(f.journal).toEqual([]);
  } finally { f.cleanup(); }
});

test("#478 an incompatible lease renewal cannot journal or close a managed TUI", async () => {
  const f = renewalFixture(true, []);
  try {
    await expect(f.driver.closeTerminals(f.planned, f.progress, f.op, f.save)).rejects.toThrow("target lacks task_cancel");
    expect(f.closed()).toBe(false);
    expect(f.journal).toEqual([]);
    expect(f.progress.terminals["closed:pi"]).toBeUndefined();
    expect(f.terminalCommands.every(argv => argv[2] === "show" || argv[2] === "wait")).toBe(true);
  } finally { f.cleanup(); }
});
