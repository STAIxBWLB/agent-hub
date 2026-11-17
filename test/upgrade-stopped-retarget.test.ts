import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { stageCurrentRuntime } from "../src/cli/recovery-package.ts";
import type { RunCommand } from "../src/cli/recovery-package.ts";
import { applyStoppedRetargets, planStoppedRetargets, type StoppedDeps, type StoppedPlan } from "../src/cli/upgrade-stopped.ts";
import { renderStoppedPlan, renderStoppedResults, renderUpgradePlan } from "../src/cli/upgrade-output.ts";
import { awaitOperationEnd, OPERATION_WAIT_MS } from "../src/cli/upgrade-wait.ts";
import type { RecoveryOperation, UpgradePlan } from "../src/cli/upgrade.ts";
import { realPath } from "../src/hub/project.ts";
import { resolveProjectRuntime, recordProjectRuntime, verifyProjectRuntime } from "../src/hub/project-runtime.ts";
import { createProjectRuntimeAccess, projectRuntimeFile, readProjectRuntime } from "../src/hub/project-runtime-state.ts";
import { Registry, type Project } from "../src/hub/registry.ts";
import { processSignature } from "../src/pi/process-signature.ts";
import { writeRestartSnapshot } from "../src/hub/restart.ts";
import { acquireRecoveryLock } from "../src/hub/recovery-store.ts";
import type { ProjectInspection } from "../src/hub/lifecycle.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const TARGET = "0.50.0", OLD = "0.40.0";
const put = (root: string, name: string, text: string) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };

function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-stopped-retarget-"))), home = join(root, "home");
  mkdirSync(home);
  const previous = process.env.AGENTHUB_HOME; process.env.AGENTHUB_HOME = home;
  cleanup.push(() => { if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; rmSync(root, { recursive: true, force: true }); });
  const registry = new Registry(join(home, "registry.db")); cleanup.push(() => registry.close());
  let packages = 0;
  const source = (version: string, marker = "fixture") => {
    const cwd = join(root, `package-${++packages}`);
    put(cwd, "package.json", JSON.stringify({ name: "@staix/agent-hub", version }));
    put(cwd, "src/cli/main.js", `// ${marker}\n`); put(cwd, "src/cli/main.ts", `export const marker = ${JSON.stringify(marker)};\n`);
    put(cwd, "plugins/agent-hub/.claude-plugin/plugin.json", JSON.stringify({ name: "agent-hub", version }));
    for (const directory of ["templates", ".claude-plugin"]) mkdirSync(join(cwd, directory));
    for (const file of ["README.md", "LICENSE", "CHANGELOG.md"]) put(cwd, file, `fixture ${file}\n`);
    return cwd;
  };
  const project = (name: string, initialized = true): Project => {
    const dir = join(root, name); mkdirSync(dir, { recursive: true });
    if (initialized) put(dir, ".agenthub/config.json", "{}\n");
    const registered = registry.register(dir); mkdirSync(registered.stateDir, { recursive: true });
    return registered;
  };
  /** A project that already runs `version`, the way a startup recorded it. */
  const retained = (p: Project, version: string) => {
    const staged = stageCurrentRuntime(source(version), version, home, registry);
    recordProjectRuntime(p, { ...staged, version, kind: "restart" }, null, registry);
    return staged;
  };
  const calls: string[][] = [];
  const run: RunCommand = async argv => {
    calls.push([...argv]);
    if (argv.join(" ") !== `npm view @staix/agent-hub@${TARGET} version dist.integrity --json`) throw new Error(`unexpected fixture command: ${argv.join(" ")}`);
    return { code: 0, stdout: JSON.stringify({ version: TARGET, "dist.integrity": `sha512-${Buffer.alloc(64).toString("base64")}` }), stderr: "" };
  };
  let stages = 0;
  const targetSource = source(TARGET, "target");
  const states = new Map<string, ProjectInspection>();
  const deps: StoppedDeps = {
    home,
    inspect: async p => states.get(p.id) ?? { state: "stopped" },
    stage: async version => { stages++; return stageCurrentRuntime(targetSource, version, home, registry); },
  };
  return { root, home, registry, project, retained, run, calls, deps, states, stages: () => stages };
}
type Fixture = ReturnType<typeof fixture>;
const row = (plan: StoppedPlan, p: Project) => plan.rows.find(r => r.project.id === p.id)!;
const recoveryFiles = (f: Fixture) => existsSync(join(f.home, "recovery")) ? readdirSync(join(f.home, "recovery")) : [];

test("#1540 AC1: a stopped project with a valid runtime.json plans a runtime-selection-only retarget, with no running-hub blocker", async () => {
  const f = fixture(), p = f.project("a"); f.retained(p, OLD);
  const plan = await planStoppedRetargets(TARGET, { root: p.root }, f.run, f.deps);
  expect(plan.blockers).toEqual([]);
  expect(row(plan, p)).toMatchObject({ outcome: "retarget", inspected: "stopped", from: OLD });
  expect(plan.integrity).toStartWith("sha512-");
  const text = renderStoppedPlan(plan, "0.50.0", { columns: 100, color: false, now: () => 0 }).join("\n");
  expect(text).toContain("stopped: runtime selection only");
  expect(text).not.toContain("no running registered projects");
  expect(text).not.toMatch(/claude|codex|reconnect/i); // no peer rows
  expect(readProjectRuntime(p)?.version).toBe(OLD); // a plan writes nothing
});

test("#1540 AC2 and AC3: applying rewrites runtime.json with a verified root and digest and changes nothing else; the next start honours it and an older CLI refuses", async () => {
  const f = fixture(), p = f.project("a"); f.retained(p, OLD);
  writeFileSync(join(p.stateDir, "sentinel.txt"), "untouched\n");
  const before = readdirSync(p.stateDir).sort(), registryBefore = f.registry.get(p.id);
  const plan = await planStoppedRetargets(TARGET, { root: p.root }, f.run, f.deps);
  const results = await applyStoppedRetargets(plan, f.run, f.deps);
  expect(results).toEqual([{ id: p.id, root: p.root, outcome: "retargeted", from: OLD, to: TARGET }]);
  const saved = readProjectRuntime(p)!;
  expect(saved).toMatchObject({ version: TARGET, kind: "upgrade", instanceId: null });
  expect(verifyProjectRuntime(saved)).toMatchObject({ version: TARGET, root: saved.root, digest: saved.digest });
  expect(readdirSync(p.stateDir).sort()).toEqual(before); // no hub files, no snapshot, no leftover temporary
  expect(readFileSync(join(p.stateDir, "sentinel.txt"), "utf8")).toBe("untouched\n");
  expect(recoveryFiles(f)).toEqual([]); // no recovery operation, no lock
  expect(f.registry.get(p.id)).toEqual(registryBefore); // no claim, no daemon
  expect(existsSync(join(p.stateDir, "status.json"))).toBe(false);
  // AC3: a CLI at the target or later starts that runtime; an older one refuses with the existing message.
  expect(resolveProjectRuntime(p, TARGET, f.root, f.registry)).toMatchObject({ version: TARGET, root: saved.root, digest: saved.digest });
  expect(resolveProjectRuntime(p, "0.51.0", f.root, f.registry)).toMatchObject({ version: TARGET });
  expect(() => resolveProjectRuntime(p, OLD, f.root, f.registry)).toThrow(`this project runs ${TARGET}; use ${TARGET} or later / ahub upgrade`);
});

test("#1540: a stopped project that records no runtime yet is retargeted too", async () => {
  const f = fixture(), p = f.project("fresh");
  const plan = await planStoppedRetargets(TARGET, { root: p.root }, f.run, f.deps);
  expect(row(plan, p)).toMatchObject({ outcome: "retarget", before: "none" });
  expect(row(plan, p).from).toBeUndefined();
  expect((await applyStoppedRetargets(plan, f.run, f.deps))[0]).toMatchObject({ outcome: "retargeted", to: TARGET });
  expect(readProjectRuntime(p)?.version).toBe(TARGET);
});

test("#1540 AC4: a stopped project holding an unreleased or a corrupt restart snapshot is refused with its next step, and nothing is written", async () => {
  const f = fixture(), held = f.project("held"), corrupt = f.project("corrupt"); f.retained(held, OLD); f.retained(corrupt, OLD);
  writeRestartSnapshot(held.stateDir, { schemaVersion: 1, projectRoot: held.root, projectId: held.id, sourceInstanceId: "source-instance", operationId: "operation-held", committedAt: 1,
    bus: { schemaVersion: 1, queues: {}, prefaces: {}, seen: [], attempts: {}, withdrawn: [] }, manualPaused: [], peers: [] });
  writeFileSync(join(corrupt.stateDir, "restart.json"), "{ not json");
  const plan = await planStoppedRetargets(TARGET, "all", f.run, f.deps);
  expect(row(plan, held)).toMatchObject({ outcome: "refused", cause: expect.stringContaining("operation-held"), next: expect.stringContaining("ahub recovery status") });
  expect(row(plan, corrupt)).toMatchObject({ outcome: "refused", cause: expect.stringContaining("cannot be read") });
  expect(await applyStoppedRetargets(plan, f.run, f.deps)).toEqual([]);
  expect(readProjectRuntime(held)?.version).toBe(OLD); expect(readProjectRuntime(corrupt)?.version).toBe(OLD);
  expect(f.stages()).toBe(0); // nothing to retarget: the package is not even staged
});

test("#1540 AC4 and AC8: a missing project, an uninitialized root, an unreadable runtime.json and an unverifiable inspection are each refused, never read as stopped", async () => {
  const f = fixture(), missing = f.project("missing"), bare = f.project("bare", false), broken = f.project("broken"), unknown = f.project("unknown"), starting = f.project("starting");
  put(broken.stateDir, "runtime.json", "garbage");
  rmSync(missing.root, { recursive: true, force: true });
  f.states.set(missing.id, { state: "missing", error: "project directory is missing" });
  f.states.set(unknown.id, { state: "unavailable", error: "authenticated hub identity does not match registration" });
  f.states.set(starting.id, { state: "starting", error: "daemon owns a startup or shutdown claim" });
  const plan = await planStoppedRetargets(TARGET, "all", f.run, f.deps);
  expect(row(plan, missing)).toMatchObject({ outcome: "refused", cause: "project directory is missing", next: expect.stringContaining("ahub projects remove") });
  expect(row(plan, bare)).toMatchObject({ outcome: "refused", cause: "project is not initialized", next: expect.stringContaining("ahub init") });
  expect(row(plan, broken)).toMatchObject({ outcome: "refused", cause: expect.stringContaining("runtime record is invalid"), next: expect.stringContaining("runtime.json") });
  expect(row(plan, unknown)).toMatchObject({ outcome: "refused", cause: expect.stringContaining("not verifiably stopped (unavailable") });
  expect(row(plan, starting)).toMatchObject({ outcome: "refused", cause: expect.stringContaining("not verifiably stopped (starting") });
  expect(plan.rows.some(r => r.outcome === "retarget")).toBe(false);
  expect(readFileSync(projectRuntimeFile(broken), "utf8")).toBe("garbage"); // a bad record is never overwritten
});

test("#1540 AC4: a Git-tracked runtime.json is refused", async () => {
  const f = fixture(), p = f.project("tracked"); f.retained(p, OLD);
  const git = (...args: string[]) => spawnSync("git", ["-C", p.root, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  expect(git("init", "-q").status).toBe(0);
  expect(git("add", "-f", ".agenthub/state/runtime.json").status).toBe(0);
  expect(git("commit", "-q", "-m", "track it").status).toBe(0);
  const plan = await planStoppedRetargets(TARGET, { root: p.root }, f.run, f.deps);
  expect(row(plan, p)).toMatchObject({ outcome: "refused", cause: expect.stringContaining("committed to git") });
  expect(plan.blockers[0]).toContain("committed to git");
  expect(JSON.parse(readFileSync(projectRuntimeFile(p), "utf8")).version).toBe(OLD);
});

test("#1540 AC5: a hub that starts between inspection and the write is refused, never written over", async () => {
  const f = fixture();
  const claimed = f.project("claimed"), controlled = f.project("controlled"), locked = f.project("locked"), snapshot = f.project("snap"), edited = f.project("edited");
  for (const p of [claimed, controlled, locked, snapshot, edited]) f.retained(p, OLD);
  const plan = await planStoppedRetargets(TARGET, "all", f.run, f.deps);
  expect(plan.rows.filter(r => r.outcome === "retarget")).toHaveLength(5);
  // After planning: one starter claimed the registry, one published a live control manifest, one recovery took the project's hold, one wrote a snapshot, one changed the record.
  expect(f.registry.claim(claimed.id, "race-instance", process.pid, processSignature(process.pid))).toBe(true);
  put(controlled.stateDir, "status.json", JSON.stringify({ controlPort: 4999, pid: process.pid, pidSignature: processSignature(process.pid), projectId: controlled.id, instanceId: "race-control", cwd: controlled.root }));
  put(controlled.stateDir, "control-token", "token\n");
  const operation = "11111111-1111-1111-1111-111111111111";
  put(f.home, `recovery/${operation}.json`, "{}\n");
  acquireRecoveryLock(operation, f.home, locked.root);
  writeFileSync(join(snapshot.stateDir, "restart.json"), "{}");
  f.retained(edited, "0.45.0"); // a person or another process re-recorded the runtime after planning
  const results = await applyStoppedRetargets(plan, f.run, f.deps);
  expect(results.map(r => r.outcome)).toEqual(Array(5).fill("failed"));
  const cause = (p: Project) => results.find(r => r.id === p.id)!.cause!;
  expect(cause(claimed)).toContain("a hub started");
  expect(cause(controlled)).toContain("a hub started");
  expect(cause(locked)).toContain(`recovery operation ${operation} holds this project`);
  expect(cause(snapshot)).toContain("restart snapshot appeared");
  expect(cause(edited)).toContain("recorded runtime changed");
  for (const p of [claimed, controlled, locked, snapshot]) expect(readProjectRuntime(p)?.version).toBe(OLD);
  expect(readProjectRuntime(edited)?.version).toBe("0.45.0");
});

test("#1540 AC6: a mixed set lists retarget, already current, skipped running, snapshot-held, missing and uninitialized projects; apply writes only the retarget rows, one project's refusal never blocks another", async () => {
  const f = fixture();
  const stopped = f.project("stopped"), current = f.project("current"), newer = f.project("newer"), running = f.project("running"), held = f.project("held"), missing = f.project("missing"), bare = f.project("bare", false), stopped2 = f.project("stopped2");
  f.retained(stopped, OLD); f.retained(current, TARGET); f.retained(newer, "0.60.0"); f.retained(running, OLD); f.retained(held, OLD); f.retained(stopped2, "0.41.0");
  f.states.set(running.id, { state: "running", status: {} });
  f.states.set(missing.id, { state: "missing", error: "project directory is missing" });
  writeFileSync(join(held.stateDir, "restart.json"), "{}");
  const plan = await planStoppedRetargets(TARGET, "all", f.run, f.deps);
  expect(plan.rows.map(r => [r.project.id === stopped.id ? "stopped" : r.project.id === stopped2.id ? "stopped2" : r.project.id === current.id ? "current" : r.project.id === newer.id ? "newer" : r.project.id === running.id ? "running" : r.project.id === held.id ? "held" : r.project.id === missing.id ? "missing" : "bare", r.outcome]).sort())
    .toEqual([["bare", "refused"], ["current", "current"], ["held", "refused"], ["missing", "refused"], ["newer", "current"], ["running", "running"], ["stopped", "retarget"], ["stopped2", "retarget"]]);
  expect(row(plan, running).command).toBe(`ahub --project ${running.id} upgrade --to ${TARGET}`);
  expect(plan.blockers).toEqual([]); // batch refusals are rows, never a plan-wide blocker
  expect(f.calls).toHaveLength(1); // one registry query for the whole batch
  const text = renderStoppedPlan(plan, "0.50.0", { columns: 120, color: false, now: () => 0 }).join("\n");
  for (const must of ["retarget: runtime selection only", "already at", "skipped: running", `ahub --project ${running.id} upgrade --to ${TARGET}`, "refused: project directory is missing", "refused: project is not initialized", "Applying writes 2 runtime selections"]) expect(text).toContain(must);
  // A change after planning fails that one project, and the rest still retarget.
  f.registry.claim(stopped2.id, "race", process.pid, processSignature(process.pid));
  const results = await applyStoppedRetargets(plan, f.run, f.deps);
  expect(f.stages()).toBe(1); // staged and verified once, reused for every project
  expect(results.map(r => [r.id === stopped.id ? "stopped" : "stopped2", r.outcome])).toEqual([["stopped", "retargeted"], ["stopped2", "failed"]]);
  expect(readProjectRuntime(stopped)?.version).toBe(TARGET); expect(readProjectRuntime(stopped2)?.version).toBe("0.41.0");
  expect(readProjectRuntime(current)?.version).toBe(TARGET); // already current: left as it was
  expect(readProjectRuntime(running)?.version).toBe(OLD); expect(readProjectRuntime(held)?.version).toBe(OLD); expect(readProjectRuntime(newer)?.version).toBe("0.60.0");
  expect(renderStoppedResults(results, { columns: 120, color: false, now: () => 0 }).join("\n")).toContain("not retargeted (a hub started");
  expect(recoveryFiles(f)).toEqual([]);
});

test("#1540: a staging failure fails every planned retarget and writes nothing", async () => {
  const f = fixture(), a = f.project("a"), b = f.project("b"); f.retained(a, OLD); f.retained(b, OLD);
  const plan = await planStoppedRetargets(TARGET, "all", f.run, f.deps);
  const results = await applyStoppedRetargets(plan, f.run, { ...f.deps, stage: async () => { throw new Error("package staging failed; installed runtime was not changed"); } });
  expect(results.map(r => r.outcome)).toEqual(["failed", "failed"]);
  expect(results[0]!.cause).toContain("no runtime was changed");
  expect(readProjectRuntime(a)?.version).toBe(OLD); expect(readProjectRuntime(b)?.version).toBe(OLD);
});

test("#1540: a single project is planned by its canonical root; an unregistered one is a blocker", async () => {
  const f = fixture(), p = f.project("a"); f.retained(p, OLD);
  const none = await planStoppedRetargets(TARGET, { root: join(f.root, "elsewhere") }, f.run, f.deps);
  expect(none.rows).toEqual([]); expect(none.blockers[0]).toContain("project is not registered");
  expect(createProjectRuntimeAccess(p).read()?.version).toBe(OLD);
});

test("#1540 AC9: under --yes the plan is printed without the line that says nothing was changed", () => {
  const plan: UpgradePlan = { schema: 1, kind: "upgrade", version: TARGET, sourceRoot: "/x", sourceDigest: "d", projects: [], blockers: [], fingerprint: "f" };
  const options = { columns: 100, color: false, now: () => 0 };
  expect(renderUpgradePlan(plan, "0.50.0", options).join("\n")).toContain("Nothing was changed. Apply with `--yes`.");
  const applying = renderUpgradePlan(plan, "0.50.0", options, true).join("\n");
  expect(applying).not.toContain("Nothing was changed");
  expect(renderUpgradePlan({ ...plan, blockers: ["a blocker"] }, "0.50.0", options, true).join("\n")).toContain("Nothing was changed"); // a blocked apply still says nothing ran
});

const receipt = (phase: RecoveryOperation["phase"], updatedAt = 1): RecoveryOperation => ({ id: "op", phase, updatedAt } as RecoveryOperation);
function waitPorts(reads: RecoveryOperation[], runners: (number | "unknown" | undefined)[]) {
  let clock = 0, read = 0, run = 0;
  return { read: () => reads[Math.min(read++, reads.length - 1)]!, runner: () => runners[Math.min(run++, runners.length - 1)], now: () => clock, sleep: async (ms: number) => { clock += ms; } };
}

test("#1540 AC10: the wait returns only when the operation is terminal, and an open receipt with no runner is a failure, never a success", async () => {
  // running, then completed after the runner lets go
  expect((await awaitOperationEnd({ id: "op", updatedAt: 1 }, waitPorts([receipt("running"), receipt("running", 2), receipt("completed", 3)], [1234, 1234, undefined]))).phase).toBe("completed");
  // blocked and cancelled end the wait without success
  expect((await awaitOperationEnd({ id: "op", updatedAt: 1 }, waitPorts([receipt("running"), receipt("blocked", 2)], [1234]))).phase).toBe("blocked");
  expect((await awaitOperationEnd({ id: "op", updatedAt: 1 }, waitPorts([receipt("cancelled", 2)], [undefined]))).phase).toBe("cancelled");
  // the runner wrote its end state and released the claim between two reads: the final read sees it
  expect((await awaitOperationEnd({ id: "op", updatedAt: 1 }, waitPorts([receipt("running"), receipt("completed", 4)], [1234, undefined]))).phase).toBe("completed");
  // a runner that exits with the receipt still open ends the wait with that open receipt
  expect((await awaitOperationEnd({ id: "op", updatedAt: 1 }, waitPorts([receipt("running", 2)], [1234, undefined]))).phase).toBe("running");
  // a runner that never appears is waited for 10 s, not forever
  const never = waitPorts([receipt("pending")], [undefined]);
  expect((await awaitOperationEnd({ id: "op", updatedAt: 1 }, never)).phase).toBe("pending");
  expect(never.now()).toBeGreaterThan(10_000);
  // a runner that keeps its claim on a hung operation is waited for at most the cap, then the open receipt comes back as a failure
  const hung = waitPorts([receipt("running", 2)], [1234]);
  expect((await awaitOperationEnd({ id: "op", updatedAt: 1 }, hung)).phase).toBe("running");
  expect(hung.now()).toBeGreaterThan(OPERATION_WAIT_MS);
});

// The CLI, for real: stopped projects need no daemon, so a real registry and real inspection exercise the flags and the dry run end to end.
test("#1540 CLI: --all-stopped conflicts with --project, names its plan rows in a dry run, and writes nothing", async () => {
  const f = fixture(), a = f.project("a"), b = f.project("b", false); f.retained(a, OLD);
  const main = join(import.meta.dir, "../src/cli/main.js");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("AGENTHUB_") && !key.startsWith("ORCA_") && !["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"].includes(key)) env[key] = value;
  env.AGENTHUB_HOME = f.home;
  mkdirSync(join(f.root, "bin")); writeFileSync(join(f.root, "bin/npm"), `#!/bin/sh\nVER=$(cat ${JSON.stringify(join(import.meta.dir, "../package.json"))} | sed -n 's/.*"version": "\\(.*\\)".*/\\1/p' | head -1)\necho '{"version":"'$VER'","dist.integrity":"sha512-fixture"}'\n`, { mode: 0o755 });
  env.PATH = `${join(f.root, "bin")}:${env.PATH}`;
  const { VERSION } = await import("../src/version.ts");
  const cli = (...args: string[]) => {
    const p = Bun.spawnSync([process.execPath, main, ...args], { cwd: a.root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const conflict = cli("--project", a.root, "upgrade", "--all-stopped", "--to", VERSION, "--dry-run");
  expect(conflict.code).toBe(1); expect(conflict.err).toContain("--all-stopped and --project are conflicting selectors");
  const local = cli("upgrade", "--project", a.root, "--all-stopped", "--to", VERSION, "--dry-run");
  expect(local.code).toBe(1); expect(local.err).toContain("conflicting selectors");
  const noTo = cli("upgrade", "--all-stopped", "--yes");
  expect(noTo.code).toBe(1); expect(noTo.err).toContain("upgrade requires --to <exact-version>");
  const dry = cli("upgrade", "--all-stopped", "--to", VERSION, "--dry-run");
  expect(dry.code, dry.err).toBe(0);
  for (const must of ["retarget: runtime selection only", "refused: project is not initialized", "ahub init", "Nothing was changed. Apply with `--yes`."]) expect(dry.out).toContain(must);
  const json = cli("upgrade", "--all-stopped", "--to", VERSION, "--json");
  expect(json.code, json.err).toBe(0);
  expect(JSON.parse(json.out)).toMatchObject({ mode: "runtime-selection", scope: "all-stopped", version: VERSION });
  expect(readProjectRuntime(a)?.version).toBe(OLD); expect(readProjectRuntime(b)).toBeUndefined();
  expect(existsSync(join(f.home, "recovery"))).toBe(false);
  // the single-project form on a stopped project is the same plan, with no running-hub blocker
  const single = cli("upgrade", "--to", VERSION, "--dry-run");
  expect(single.code, single.err).toBe(0);
  expect(single.out).toContain("stopped: runtime selection only"); expect(single.out).not.toContain("no running registered projects");
}, 30_000);

test("#1540: --all-stopped is person-only: refused for a live-test delegation, never a conductor operation, and a preview stays a person form", async () => {
  const { liveTestRefusal, classifyPeerCommand } = await import("../src/cli/identity.ts");
  const { conductorOperation } = await import("../src/hub/operational-authority.ts");
  for (const args of [["--all-stopped", "--to", "0.50.0", "--yes"], ["--to", "0.50.0", "--all-stopped", "--yes"], ["--all-stopped", "--to", "0.50.0", "--dry-run"], ["--all-stopped", "--json"]]) {
    expect(liveTestRefusal("upgrade", args)).toBe(true);
    expect(conductorOperation("upgrade", args)).toBeUndefined();
    expect(classifyPeerCommand("upgrade", args)).toBe("console");
  }
});
