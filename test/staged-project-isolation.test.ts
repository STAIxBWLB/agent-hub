import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ADAPTERS } from "../src/adapters/registry.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { Registry, type Project } from "../src/hub/registry.ts";
import { recoveryLock } from "../src/hub/recovery-store.ts";
import { stageCurrentRuntime, runCommand, verifyPackage } from "../src/cli/recovery-package.ts";
import { createOperation, disposeRecovery, planFingerprint, runRecovery, type RecoveryDriver, type RecoveryOperation, type UpgradePlan } from "../src/cli/upgrade.ts";
import { VERSION } from "../src/version.ts";
import { cleanEnvironment, restoreEnvironment, restoreOnTestEnd, useEnvironmentScope } from "./helpers/env-scope.ts";
useEnvironmentScope();   // #1262: registers the afterEach in THIS file's scope; an import by an earlier file would bind it to that file

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
// #1577 exception (docs/agent-notes/tests.md): this body keeps two real daemons and a real upgrade CLI child, and the test process
// itself runs synchronous `ps` identity reads (processSignature), so Bun's timeout must never be the first thing to fire. The work is
// fixed, never a guess at how long a hub takes: 14,739 ms in the green macOS shard 4/4 run 44732101559 (head 3cc4818b) and over 20 s
// in both ledger failures (44703709611, and 44732101559 attempt 1, which was cut with a single daemon up), i.e. the same steps cost
// what the runner gives them. Body 45 s + cleanup 5 x 6 s = 75 s stays under this test's 90 s timeout.
const BODY_DEADLINE_MS = 45_000;
const CLEANUP_STEP_MS = 6_000;

function isolate(root: string) {
  const saved = cleanEnvironment(), env = cleanEnvironment(), bin = join(root, "bin");   // #1262: the file's clean snapshot, never an environment another test's abandoned body still holds
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || key.startsWith("OMNIROUTE_") || key.startsWith("CF_ACCESS_")
    || /(?:_API_KEY|_ACCESS_TOKEN|_SECRET|_TOKEN)$/.test(key)) delete env[key];
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]) delete env[key];
  mkdirSync(bin); writeFileSync(join(bin, "git"), '#!/bin/sh\nexec /usr/bin/git "$@"\n'); chmodSync(join(bin, "git"), 0o700);
  // Preserve process identity tooling without exposing installed native agent CLIs.
  writeFileSync(join(bin, "ps"), '#!/bin/sh\nexec /bin/ps "$@"\n'); chmodSync(join(bin, "ps"), 0o700);
  Object.assign(env, { HOME: join(root, "home"), AGENTHUB_HOME: join(root, "hub-home"), AMEM_HOME: join(root, "amem-home"),
    CLAUDE_CONFIG_DIR: join(root, "claude-home"), CODEX_HOME: join(root, "codex-home"), KIMI_CODE_HOME: join(root, "kimi-home"),
    PI_CODING_AGENT_DIR: join(root, "pi-home"), QWEN_CODE_HOME: join(root, "qwen-home"), GEMINI_CLI_HOME: join(root, "gemini-home"),
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PATH: bin });
  for (const key of ["HOME", "AGENTHUB_HOME", "AMEM_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "KIMI_CODE_HOME", "PI_CODING_AGENT_DIR", "QWEN_CODE_HOME", "GEMINI_CLI_HOME"])
    mkdirSync(env[key]!, { recursive: true });
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(env, key)) delete process.env[key];
  Object.assign(process.env, env);
  const restore = restoreOnTestEnd(() => restoreEnvironment(saved));   // #1262: also at Bun's timeout, before the next test or file starts
  return { env, home: env.AGENTHUB_HOME!, restore };
}

test("#607 a real scoped A upgrade preserves B's daemon, channel session and ordinary lifecycle throughout", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-two-project-upgrade-"))), scope = isolate(root);
  let lifecycle: typeof import("../src/hub/lifecycle.ts") | undefined;
  let channel: ControlClient | undefined, operation: RecoveryOperation | undefined, production: RecoveryDriver | undefined;
  let bodyFailure: unknown;
  const projects: Project[] = [];
  // A step the deadline gives up on does not stop: runRecovery has no cancel path and its runner claim belongs to this process,
  // so its effects keep writing the fixture. Each one is recorded here and settled before anything stops or removes it.
  const abandoned: Promise<unknown>[] = [];
  const deadline = performance.now() + BODY_DEADLINE_MS;
  /** What is left of the shared body deadline, never above the caller's own cap: a control request can never outlive the body. */
  const left = (cap: number) => Math.max(1, Math.min(cap, Math.round(deadline - performance.now())));
  /** One body step under the shared deadline, so a stalled hub fails this step by name and the cleanup below still runs (tests.md). */
  const inBody = <T>(step: string, work: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      abandoned.push(work.then(() => {}, () => {}));
      reject(new Error(`${step} did not settle within the ${BODY_DEADLINE_MS / 1000} s body deadline`));
    }, left(BODY_DEADLINE_MS));
    work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  try {
    const retained = stageCurrentRuntime(PACKAGE_ROOT, VERSION, scope.home);
    const runtimeLifecycle: typeof import("../src/hub/lifecycle.ts") = await inBody("the retained lifecycle import",
      import(pathToFileURL(join(retained.root, "src/hub/lifecycle.ts")).href));
    lifecycle = runtimeLifecycle;
    const runtimeRecovery: typeof import("../src/cli/upgrade-runtime.ts") = await inBody("the retained recovery import",
      import(pathToFileURL(join(retained.root, "src/cli/upgrade-runtime.ts")).href));
    for (const name of ["a", "b"]) {
      const cwd = join(root, name); mkdirSync(join(cwd, ".agenthub"), { recursive: true });
      const git = Bun.spawn(["/usr/bin/git", "init", "-q", cwd], { env: scope.env, stdout: "ignore", stderr: "pipe" });
      expect(await git.exited, await new Response(git.stderr).text()).toBe(0);
      writeFileSync(join(cwd, ".agenthub/config.json"), JSON.stringify({
        roster: { ...Object.fromEntries(ADAPTERS.map(adapter => [adapter.kind, false])), ...(name === "b" ? { claude: true } : {}) }, roles: {},
        memory: { enabled: false }, inference: { enabled: false }, omniroute: { urls: [], access_hosts: [] }, mlx: { enabled: false },
        pi: { enabled: false, auto_start: false }, recovery: { auto_resume_after_crash: false }, snapshots: { enabled: false },
        task_sweep: { enabled: false }, approvals: { notify: false }, terminal: { open: [] },
      }));
      const registry = new Registry();
      try { projects.push(registry.register(realPath(cwd))); } finally { registry.close(); }
      await inBody(`the ${name} daemon start`, runtimeLifecycle.startProject(projects[projects.length - 1]!, { env: scope.env }));
    }
    const a = projects[0]!, b = projects[1]!, bBefore = await inBody("the second b start", runtimeLifecycle.startProject(b, { env: scope.env }));
    // A real control-channel client exercises the native wire without starting a native CLI or account.
    const bChannel = await inBody("the channel connect", ControlClient.connect(b.stateDir, { role: "peer", peer: "claude", channel: true, projectId: b.id, projectRoot: b.root, instanceId: bBefore.instanceId }, left(5_000)));
    channel = bChannel;
    let closes = 0; bChannel.onClose = () => { closes++; };
    const bSession = "fixture-project-b-session";
    const facts = await bChannel.request({ t: "facts", phase: "session", sessionId: bSession, nativeInstanceId: bBefore.instanceId, hookPurpose: "facts" }, left(10_000));
    expect(facts.ok).toBe(true);
    const observations: string[] = [];
    const assertB = async (step: string) => {
      expect(bChannel.isOpen).toBe(true); expect(closes).toBe(0);
      const status = await bChannel.request({ t: "status" }, left(10_000));
      expect(status.status.instanceId).toBe(bBefore.instanceId); expect(status.status.pid).toBe(bBefore.pid);
      const observed = await inBody(`${step} recovery inspection`, runtimeRecovery.inspectRecovery(b));
      expect(observed.state).toBe("running"); expect(observed.instanceId).toBe(bBefore.instanceId);
      expect(observed.peers.find(peer => peer.id === "claude")?.sessionId).toBe(bSession);
      expect(recoveryLock(scope.home, b.root)).toBeUndefined();
      expect((await inBody(`${step} b start`, runtimeLifecycle.startProject(b, { env: scope.env }))).instanceId).toBe(bBefore.instanceId);
      observations.push(step);
    };
    await assertB("before-plan");
    const source = await inBody("the a inspection", runtimeRecovery.inspectRecovery(a));
    expect(source.state).toBe("running"); expect(source.blockers).toEqual([]);
    const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind: "upgrade", version: VERSION, sourceRoot: retained.root, sourceDigest: retained.digest,
      scope: { projectRoot: a.root }, projects: [{ project: a, source, terminals: [], blockers: [] }], blockers: [] };
    const plan: UpgradePlan = { ...body, fingerprint: planFingerprint(body) };
    operation = createOperation(plan, retained.root, scope.home);
    expect(operation.schema).toBe(3); expect(operation.projects.map(project => project.id)).toEqual([a.id]);
    // All production effect ports remain real. The command guard refuses accidental registry, global or native execution.
    production = runtimeRecovery.makeRecoveryDriver(async (argv, options) => {
      expect(argv).toEqual([process.execPath, join(retained.root, "src/cli/main.js"), "--project", a.root, "up"]);
      // The real `up` child keeps its own 60 s default, never past what remains of the body deadline.
      return runCommand(argv, { ...options, timeoutMs: left(options?.timeoutMs ?? 60_000) });
    });
    function observe<A extends unknown[], R>(step: string, effect: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
      return async (...args) => { await assertB(`before-${step}`); const result = await effect(...args); await assertB(`after-${step}`); return result; };
    }
    const actual = production;
    const driver: RecoveryDriver = { ...actual,
      // Fixture provisioning only: reviewed local bytes replace a registry download, with exact identity and feature proof.
      stage: observe("fixture-local-stage", async () => {
        expect(verifyPackage(retained.root, VERSION, { ownDependencies: true })).toBe(retained.digest);
        return { root: retained.root, digest: retained.digest, targetFeatures: [...DAEMON_FEATURES] };
      }),
      refreshManager: async () => { await assertB("manager-refresh-omitted-by-fixture"); },
      prepare: observe("prepare", actual.prepare), commit: observe("commit", actual.commit), start: observe("start", actual.start),
      closeTerminals: observe("close-terminals", actual.closeTerminals), restore: observe("restore", actual.restore),
      verify: observe("verify", actual.verify), release: observe("release", actual.release),
    };
    const result = await inBody("the recovery run", runRecovery(operation.id, driver, scope.home));
    expect(result.phase, result.error).toBe("completed");
    expect(result.schema).toBe(3); expect(result.pluginInstalled).toBeUndefined(); expect(result.globalInstalled).toBeUndefined();
    const afterA = await inBody("the a inspection after completion", runtimeRecovery.inspectRecovery(a));
    expect(afterA.instanceId).not.toBe(source.instanceId); expect(afterA.version).toBe(VERSION); expect(afterA.recovery?.phase).toBe("released");
    expect(recoveryLock(scope.home, a.root)).toBeUndefined();
    await assertB("after-completion");
    for (const step of ["prepare", "commit", "start", "restore", "verify", "release"]) expect(observations).toContain(`after-${step}`);
  } catch (error) { bodyFailure = error; throw error; }
  finally {
    channel?.close();
    const failures: string[] = [];
    /** Every cleanup wait is its own bound (tests.md): a hub that will not stop fails this file's cleanup by name, never Bun's timeout. */
    const bounded = async (step: string, work: () => Promise<unknown>): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${step} exceeded ${CLEANUP_STEP_MS / 1000} s`)), CLEANUP_STEP_MS); })]);
        return true;
      } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); return false; }
      finally { clearTimeout(timer); }
    };
    try {
      // Whatever the deadline abandoned still owns the operation, the daemons and the fixture; settle it before touching them.
      // Its own awaits take 1 ms once the deadline passed, so this returns at once rather than waiting out its work.
      const settled = await bounded("abandoned body work", () => Promise.all(abandoned));
      const owned = operation, effects = production;
      if (owned && effects && recoveryLock(scope.home, projects[0]?.root) === owned.id)
        await bounded("recovery dispose cleanup", () => disposeRecovery(owned.id, { stop: true }, "owned test fixture cleanup", effects, scope.home));
      if (lifecycle) for (const project of projects) await bounded(`stopping ${project.id}`, () => lifecycle!.stopProject(project));
      // A directory live work still uses is never removed.
      if (settled) await bounded("fixture removal", async () => rmSync(root, { recursive: true, force: true }));
      else failures.push(`fixture kept: ${root} is still used by work the deadline abandoned`);
    } finally { scope.restore(); }
    // A cleanup failure is never swallowed; the body's own failure rides along when both happen.
    if (failures.length) throw new Error(`fixture cleanup did not finish: ${failures.join("; ")}${bodyFailure === undefined ? "" : ` (body: ${bodyFailure instanceof Error ? bodyFailure.message : String(bodyFailure)})`}`);
  }
}, 90_000);
