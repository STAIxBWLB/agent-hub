import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { operationScreen, type ScreenIO, type UpgradeHost } from "../src/cli/upgrade-interactive.ts";
import { renderBlocked, renderSummary, type RecoveryPresentationOptions } from "../src/cli/upgrade-presentation.ts";
import { nextChoices, type RecoveryOperation } from "../src/cli/upgrade.ts";
import { VERSION } from "../src/version.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
const id = "00000000-0000-4000-8000-000000000466";
const presentation: RecoveryPresentationOptions = { columns: 120, color: false, verbose: true, now: () => 1000 };

function retained(capable = true) {
  const root = mkdtempSync(join(tmpdir(), "ahub-screen-coordinator-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src/cli"), { recursive: true });
  writeFileSync(join(root, "src/cli/main.js"), "// recording fixture, never executed\n");
  writeFileSync(join(root, "src/cli/upgrade.ts"), "export async function disposeRecovery() {}\nexport async function reattachRecovery() {}\nexport function recordRestart() {}\n");
  if (capable) writeFileSync(join(root, "src/cli/upgrade-presentation-flags.ts"), "// display capability only\n");
  return { root, entry: join(root, "src/cli/main.js") };
}

/** Main dispatches at import time. Evaluate its actual two terminal helpers with a recording spawn boundary,
 * like the existing pure-parser extraction tests. No lifecycle function, terminal provider or child CLI runs. */
function terminal(answers: string[], afterSpawn: (argv: string[]) => string) {
  const source = readFileSync(new URL("../src/cli/main.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = ["recoveryFormatting", "onTerminal"].map(name => {
    const node = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    expect(node, `${name} remains the screen's production boundary`).toBeDefined();
    return node!.getText(ast);
  }).join("\n");
  const script = ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  let output = "", error = "";
  const calls: { executable: string; argv: string[]; options: Record<string, any> }[] = [];
  const process_ = Object.assign(new EventEmitter(), { execPath: "/fixture/bun", stdin: {}, stdout: { columns: 120, write: (text: string) => { output += text; } },
    env: { AGENTHUB_PEER_ID: "codex", CODEX_THREAD_ID: "retained-agent-identity" } });
  const lineReader = () => {
    const reader = Object.assign(new EventEmitter(), { pause() {}, resume() {}, close() { reader.emit("close"); } });
    queueMicrotask(() => { for (const answer of answers) reader.emit("line", answer); reader.emit("close"); });
    return reader;
  };
  const spawn = (executable: string, argv: string[], options: Record<string, any>) => {
    calls.push({ executable, argv, options });
    const child = new EventEmitter();
    queueMicrotask(() => {
      const stdout = options.stdio === "inherit" ? "inherit" : options.stdio?.[1];
      const stderr = options.stdio === "inherit" ? "inherit" : options.stdio?.[2];
      const body = afterSpawn(argv);
      if (stdout === "inherit") output += body;
      if (stderr === "inherit") error += "child diagnostic remains visible\n";
      child.emit("close", 0);
    });
    return child;
  };
  const context = { process: process_, console: { log: (...values: unknown[]) => { output += values.join(" ") + "\n"; } },
    lineReader, spawn, existsSync, join, dirname, cwd: "/fixture/project", liveTestArgs: ["--live-test"], Bun: { sleep: async () => {} } };
  const onTerminal = runInNewContext(`${script}; onTerminal`, context) as (screens: (io: ScreenIO) => Promise<void>, options?: RecoveryPresentationOptions) => Promise<void>;
  return { onTerminal, calls, output: () => output, error: () => error, env: process_.env };
}

function operation(sourceRoot: string): RecoveryOperation {
  const launch = { packageEntrypoint: "/recorded/main.js", command: "never executed", argv: [], env: {} };
  const binding = { peer: "pi" as const, handle: "orphaned", incarnationId: "inc", worktreeId: "wt", projectRoot: "/fixture/project", sessionId: "recorded-pi", launch, launchMetadata: launch };
  return { schema: 1, id, sourceRoot, createdAt: 1, updatedAt: 1, phase: "blocked", step: "verify:alpha", targetRoot: sourceRoot, targetDigest: "fixture",
    plan: { schema: 1, kind: "restart", version: VERSION, sourceRoot, sourceDigest: "fixture", fingerprint: "fixture", blockers: [],
      projects: [{ project: { id: "alpha", root: "/fixture/project", stateDir: "/fixture/state", basePort: 0, instanceId: "source", pid: null },
        source: { state: "running", instanceId: "source", version: VERSION, peers: [{ id: "pi", state: "idle", sessionId: "recorded-pi" }], blockers: [] }, terminals: [binding], blockers: [] }] },
    projects: [{ id: "alpha", phase: "started", instanceId: "target", terminals: { "restored:pi": { state: "failed" } },
      reattachments: { pi: { state: "ready", at: 1, cause: "detached after restore", binding } } }],
    blockedReattachment: { projectId: "alpha", peer: "pi" } };
}

for (const action of ["dispose", "reattach", "resume"] as const) test(`#466 screen ${action} child is quiet and the parent alone renders its outcome`, async () => {
  const coordinator = retained(), op = operation(coordinator.root);
  const answers = action === "dispose" ? ["e", "y", "fixture reason", "n"] : action === "reattach" ? ["a", "q"] : ["r"];
  let childView = "";
  const f = terminal(answers, argv => {
    expect(argv[2]).toBe("recovery"); expect(argv[3]).toBe(action);
    op.updatedAt++;
    if (action === "dispose") {
      op.phase = "cancelled"; op.disposition = { choice: "stop-and-archive", at: 2, projects: { alpha: "target stopped" } };
      childView = renderSummary(op, {}, presentation).join("\n") + "\n";
    } else if (action === "resume") {
      op.phase = "completed"; op.step = "completed";
      childView = renderSummary(op, {}, presentation).join("\n") + "\n";
      return `Recovery operation ${id} scheduled.\nahub recovery status ${id}\n` + childView;
    } else {
      delete op.blockedReattachment;
      op.presentationCause = { kind: "preservation", check: "queues", projectId: "alpha" };
      childView = renderBlocked(op, nextChoices(op, undefined, { alpha: { state: "running", instanceId: "target", version: VERSION, recovery: { operationId: id, phase: "restored" }, peers: [], blockers: [] } }), presentation).join("\n") + "\n";
    }
    return childView;
  });
  const host: UpgradeHost = {
    plan: async () => op.plan, apply: async () => { throw new Error("no plan is applied by this recording fixture"); }, endPeer: async () => { throw new Error("no peer is ended"); },
    lock: () => id, read: () => op, runner: () => undefined,
    live: async () => ({ alpha: { state: "running", instanceId: "target", version: VERSION, recovery: { operationId: id, phase: "restored" }, peers: [], blockers: [] } }),
    endInspection: async () => ({}), runnerStoppable: () => false, stopRunner: async () => { throw new Error("no runner is stopped"); }, entry: coordinator.entry, version: VERSION,
  };
  await f.onTerminal(async io => { await operationScreen(host, io, id); }, presentation);
  expect(f.calls).toHaveLength(1);
  const child = f.calls[0]!;
  expect(childView.length).toBeGreaterThan(0);
  expect(f.output().split(childView)).toHaveLength(2);
  expect(f.output()).not.toContain("scheduled.");
  expect(child.executable).toBe("/fixture/bun");
  expect(child.argv).toContain("--json");
  expect(child.argv).toContain("--color=never"); expect(child.argv).toContain("--verbose");
  expect(child.options.stdio).toEqual(["inherit", "ignore", "inherit"]);
  expect(child.options.env).toBeUndefined();
  expect(f.env).toEqual({ AGENTHUB_PEER_ID: "codex", CODEX_THREAD_ID: "retained-agent-identity" });
  expect(f.error()).toContain("child diagnostic remains visible");
});

test("#466 old retained coordinators receive neither JSON nor new formatting flags from a screen", async () => {
  const coordinator = retained(false), request = [coordinator.entry, "recovery", "resume", id];
  const f = terminal([], () => "legacy coordinator output\n");
  await f.onTerminal(async io => { expect(await io.run(request)).toBe(0); }, presentation);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.argv).toEqual([coordinator.entry, "--live-test", "recovery", "resume", id]);
  expect(f.calls[0]!.options.stdio).toBe("inherit");
  expect(f.output()).toBe("legacy coordinator output\n");
});

test("#466 reset previews keep inherited stdout and exact existing project arguments", async () => {
  const coordinator = retained(), request = [coordinator.entry, "--project", "/fixture/project", "reset", "--all"];
  const f = terminal([], () => "unchanged reset preview\n");
  await f.onTerminal(async io => { expect(await io.run(request)).toBe(0); }, presentation);
  expect(f.calls[0]!.argv).toEqual([coordinator.entry, "--live-test", "--project", "/fixture/project", "reset", "--all"]);
  expect(f.calls[0]!.options.stdio).toBe("inherit");
  expect(f.output()).toBe("unchanged reset preview\n");
});
