import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { restoreTransition } from "../src/cli/upgrade-restore-state.ts";
import { makeRecoveryDriver } from "../src/cli/upgrade-runtime.ts";
import type { PlannedProject, ProjectProgress, RecoveryOperation } from "../src/cli/upgrade.ts";
import { realPath } from "../src/hub/project.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { VERSION } from "../src/version.ts";

/** Execute the actual wait closure with deterministic writer/clock/read ports, without a daemon or terminal. */
function boundary(file: string, name: string, ports: Record<string, unknown>): (...args: any[]) => Promise<any> {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) expression = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!expression) throw new Error(`${name} source boundary missing`);
  const js = ts.transpileModule(`const boundary = ${expression.getText(ast)}; boundary;`, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  return runInNewContext(js, ports);
}

function writer(failOn: number[]) {
  let calls = 0;
  const logs: unknown[][] = [];
  return { save: () => { if (failOn.includes(++calls)) throw new Error(`writer failed ${calls}`); }, calls: () => calls,
    console: { warn: (...args: unknown[]) => logs.push(args), error: (...args: unknown[]) => logs.push(args) }, logs };
}

for (const failedWrite of [1, 2]) test(`#466 prepare wait continues when timing write ${failedWrite} fails`, async () => {
  const w = writer([failedWrite]), op: any = { id: "operation", step: "prepare:fixture" };
  let prepared = 0, inspected = 0, rosterChecked = 0;
  const prepare = boundary("../src/cli/upgrade.ts", "prepareSource", { id: op.id, op, save: w.save, console: w.console, targetFeatures: [], idleTimeoutMs: 600_000,
    sourceRoster: () => { rosterChecked++; }, driver: { now: () => 1000, prepare: async () => { prepared++; },
      inspect: async () => { inspected++; return { instanceId: "source", recovery: { operationId: op.id, ready: true } }; } } });
  await prepare({ project: { id: "fixture" }, source: { instanceId: "source" } }, {});
  expect(prepared).toBe(1); expect(inspected).toBe(1); expect(rosterChecked).toBe(1);
  expect(w.calls()).toBe(2); expect(w.logs).toHaveLength(1);
  expect(op.waits[op.step]).toEqual({ waitStartedAt: new Date(1000).toISOString(), deadlineAt: new Date(601000).toISOString(), waitEndedAt: new Date(1000).toISOString() });
});

function attachment(failOn: number[], attached = true) {
  const w = writer(failOn), op: any = { id: "operation", step: "restore:fixture", plan: { version: "1.0.0" } };
  const binding = { peer: "codex", handle: "chosen-terminal", incarnationId: "chosen-incarnation", worktreeId: "chosen-worktree", sessionId: "recorded-thread" };
  let clock = 1000, inspections = 0;
  const wait = boundary("../src/cli/upgrade-runtime.ts", "awaitAttachment", { console: w.console,
    now: () => clock, RECONNECT_WAIT_MS: 1000, restoreTransition,
    inspectRecovery: async () => { inspections++; return { state: "running", instanceId: "target", version: "1.0.0", recovery: { operationId: op.id }, peers: attached ? [{ id: "codex", state: "idle", threadId: "recorded-thread" }] : [] }; },
    terminalOptions: () => ({}), run: async () => ({ code: 1, stdout: "" }), orcaExecutable: () => "fixture-only",
    launcherOf: async () => ({ state: "live", record: binding }),
    sleep: async (ms: number) => { clock += ms; },
    nativeFailure: (_planned: unknown, _peer: string, _reason: string, message: string) => new Error(message),
  });
  const progress: any = { instanceId: "target" };
  return { ...w, op, progress, inspections: () => inspections, run: () => wait({ project: { id: "fixture", root: "/fixture", stateDir: "/fixture/state" } }, progress, op, { state: "waiting", origin: "pending", binding }, w.save) };
}

function managedAttachment() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-timing-write-"))), stateDir = join(root, "state"), codeHome = join(root, "codex-home");
  mkdirSync(stateDir); mkdirSync(join(codeHome, "sessions"), { recursive: true });
  writeFileSync(join(codeHome, "sessions", "recorded-thread.jsonl"), "{}\n");
  const server = Bun.serve<any>({ hostname: "127.0.0.1", port: 0,
    fetch(request, srv) { return srv.upgrade(request) ? undefined : new Response("no"); },
    websocket: { message(ws, data) {
      const msg = JSON.parse(String(data));
      const base = { rid: msg.rid, ok: true };
      if (msg.t === "hello") ws.send(JSON.stringify({ ...base, t: "welcome", projectId: "fixture", instanceId: "target", cwd: root, protocol: PROTOCOL }));
      else if (msg.t === "status") ws.send(JSON.stringify({ ...base, t: "status", status: { projectId: "fixture", instanceId: "target", cwd: root, protocol: PROTOCOL, version: VERSION } }));
      else ws.send(JSON.stringify({ ...base, t: "recovery", recovery: { operationId: "timing-operation", phase: "restored", ready: true, peers: { codex: { id: "codex", state: "idle", threadId: "recorded-thread" } } } }));
    } },
  });
  writeFileSync(join(stateDir, "control-token"), "fixture-token\n");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: server.port, protocol: PROTOCOL, projectId: "fixture", instanceId: "target", cwd: root }));
  const launch = { packageEntrypoint: "/fixture/main.js", command: "unused", argv: [], env: { CODEX_HOME: codeHome } };
  const binding = { peer: "codex" as const, handle: "chosen-terminal", incarnationId: "chosen-incarnation", worktreeId: "chosen-worktree", projectRoot: root, sessionId: "recorded-thread", launch, launchMetadata: launch };
  const shown = { ...binding, worktreePath: root, agentIdentity: "codex", connected: true, state: "idle" };
  const planned: PlannedProject = { project: { id: "fixture", root, stateDir, instanceId: "source", pid: null, basePort: 4600 }, source: { state: "running", instanceId: "source", version: VERSION, protocol: PROTOCOL, peers: [{ id: "codex", state: "idle", threadId: "recorded-thread" }], blockers: [] }, terminals: [binding], blockers: [] };
  const progress: ProjectProgress = { id: "fixture", phase: "started", instanceId: "target", terminals: { "closed:codex": true, "restored:codex": { state: "waiting", origin: "pending", binding } } };
  const op = { id: "timing-operation", step: "restore:fixture", plan: { version: VERSION, projects: [planned] }, projects: [progress] } as RecoveryOperation;
  const driver = makeRecoveryDriver(async argv => {
    if (argv[1] !== "terminal" || !["list", "show", "wait"].includes(argv[2]!)) throw new Error("fixture refuses runtime mutation");
    return { code: 0, stderr: "", stdout: JSON.stringify({ ok: true, result: argv[2] === "list" ? { terminals: [shown] } : argv[2] === "show" ? { terminal: shown } : { wait: { satisfied: true } } }) };
  }, undefined, { now: () => 1000, sleep: async () => { throw new Error("attached fixture must not sleep"); } });
  return { op, progress, restore: (save: () => void) => driver.restore(planned, progress, op, "native", save), cleanup: () => { server.stop(true); rmSync(root, { recursive: true, force: true }); } };
}

for (const point of ["start", "finish"] as const) test(`#466 actual driver attachment succeeds when its ${point} timing save fails`, async () => {
  const f = managedAttachment(), warnings: unknown[][] = [], warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  let failed = false;
  try {
    await f.restore(() => {
      const timing = f.op.waits?.[f.op.step!];
      if (!failed && timing && (point === "start" ? !timing.waitEndedAt : !!timing.waitEndedAt)) { failed = true; throw new Error(`timing ${point} failed`); }
    });
    expect(failed).toBe(true); expect(warnings).toHaveLength(1);
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "done", binding: { sessionId: "recorded-thread", handle: "chosen-terminal" } });
    expect(f.op.waits?.[f.op.step!]).toEqual({ waitStartedAt: new Date(1000).toISOString(), deadlineAt: new Date(601000).toISOString(), waitEndedAt: new Date(1000).toISOString() });
  } finally { console.warn = warn; f.cleanup(); }
});

test("#466 actual driver still rejects an ordinary done-receipt save failure", async () => {
  const f = managedAttachment();
  try {
    await expect(f.restore(() => { if ((f.progress.terminals["restored:codex"] as any)?.state === "done") throw new Error("ordinary done receipt failed"); })).rejects.toThrow("ordinary done receipt failed");
  } finally { f.cleanup(); }
});

test("#466 timing persistence does not turn an ordinary attachment diagnostic save into best effort", async () => {
  const f = attachment([2], false);
  await expect(f.run()).rejects.toThrow("writer failed 2");
  expect(f.calls()).toBe(3);
  expect(f.progress.attachmentTimeouts.codex).toMatchObject({ lastHubConnectAttempt: "unknown" });
});

test("#466 failed prepare retains its real guard failure when ending its timing cannot be saved", async () => {
  const w = writer([2]), op: any = { id: "operation", step: "prepare:fixture" };
  const prepare = boundary("../src/cli/upgrade.ts", "prepareSource", { id: op.id, op, save: w.save, console: w.console, targetFeatures: [], idleTimeoutMs: 600_000,
    driver: { now: () => 1000, prepare: async () => {}, inspect: async () => ({ instanceId: "replacement" }) } });
  await expect(prepare({ project: { id: "fixture" }, source: { instanceId: "source" } }, {})).rejects.toThrow("source daemon changed during preparation");
  expect(w.calls()).toBe(2); expect(w.logs).toHaveLength(1);
});
