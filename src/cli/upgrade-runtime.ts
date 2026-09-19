import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ControlClient, PROTOCOL, readControl } from "../hub/control-client.ts";
import { inspectProject } from "../hub/lifecycle.ts";
import type { Project } from "../hub/registry.ts";
import { hubHome } from "../hub/project.ts";
import { packageDigest, registryRelease, runCommand, stageRelease, verifyPackage, type RunCommand } from "./recovery-package.ts";
import { inspectTerminals, closeTerminal, createTerminal, waitForIdle, shellQuote, type SessionRef, type TerminalBinding, type TerminalRecoveryOptions } from "./terminal-recovery.ts";
import { planFingerprint, registeredProjects, type Inspection, type PlannedProject, type ProjectProgress, type RecoveryDriver, type RecoveryOperation, type UpgradePlan } from "./upgrade.ts";
import { refreshManager } from "../hub/manager.ts";

export const PACKAGE_ROOT = resolve(import.meta.dir, "../..");
const orcaExecutable = () => process.env.ORCA_CLI_COMMAND || (process.env.ORCA_DEV_REPO_ROOT ? "orca-dev" : process.platform === "linux" && !process.env.ORCA_TERMINAL_HANDLE ? "orca-ide" : "orca");

function terminalOptions(run: RunCommand = runCommand): TerminalRecoveryOptions {
  return { orcaExecutable: orcaExecutable(), runner: async (args) => {
    const result = await run([orcaExecutable(), ...args], { timeoutMs: 610_000 });
    return { status: result.code, stdout: result.stdout, stderr: result.stderr };
  } };
}

async function rpc(project: Project, message: Record<string, unknown>, protocol = PROTOCOL): Promise<any> {
  const client = await ControlClient.connect(project.stateDir, { role: "console", projectRoot: project.root, projectId: project.id }, 30_000, protocol);
  try {
    const reply = await client.request(message, 30_000);
    if (reply.ok === false) throw new Error(reply.error ?? "recovery control request failed");
    return reply;
  } finally { client.close(); }
}

export async function inspectRecovery(project: Project): Promise<Inspection> {
  const base = await inspectProject(project);
  const control = readControl(project.stateDir);
  const sourceProtocol = control?.protocol;
  const legacySupported = sourceProtocol === 8;
  if (base.state !== "running" && !legacySupported) return {
    state: base.state, peers: [], blockers: base.state === "stopped" ? [] : [base.state === "incompatible" ? "manual-bootstrap-required: source lacks the recovery contract; use its matching CLI" : base.error ?? base.state],
    ...(control?.instanceId ? { instanceId: control.instanceId } : {}), ...(control?.protocol ? { protocol: control.protocol } : {}),
  };
  let status = base.status;
  if (!status && legacySupported) {
    const readback = await rpc(project, { t: "status" }, sourceProtocol);
    status = readback.status;
  }
  if (!status || !control) return { state: "unavailable", peers: [], blockers: ["authenticated source status unavailable"] };
  let response: any;
  try { response = await rpc(project, { t: "recovery", op: "inspect", expectedInstanceId: status.instanceId }, sourceProtocol ?? PROTOCOL); }
  catch {
    // A stop can complete between authenticated status and the second read. Never infer stopped
    // from a connection failure: the coordinator will inspect the ownership manifest again.
    return { state: "unavailable", instanceId: status.instanceId, version: status.version, protocol: status.protocol,
      peers: [], blockers: ["runtime changed during recovery inspection"] };
  }
  const peers = Object.values(response.recovery?.peers ?? {}) as any[];
  return { state: "running", instanceId: status.instanceId, version: status.version, protocol: status.protocol,
    recovery: { operationId: response.recovery?.operationId, phase: response.recovery?.phase, ready: response.recovery?.ready }, peers: peers.map((peer) => ({ id: peer.id, state: peer.state,
      ...(peer.threadId ? { threadId: peer.threadId } : {}), ...(peer.sessionId ? { sessionId: peer.sessionId } : {}),
      ...(typeof (peer.sessionFile ?? peer.launch?.sessionFile) === "string" ? { sessionFile: peer.sessionFile ?? peer.launch.sessionFile } : {}),
      ...(peer.launch ? { args: Object.fromEntries(Object.entries(peer.launch).filter(([k, v]) => ["model", "route", "sessionFile", "mode", "backend"].includes(k) && typeof v === "string")) as Record<string, string> } : {}) })), blockers: [] };
}

export async function makeUpgradePlan(kind: "restart" | "upgrade", version: string, selectedRoot?: string, run: RunCommand = runCommand): Promise<UpgradePlan> {
  const projects = registeredProjects();
  const sourceDigest = packageDigest(PACKAGE_ROOT);
  const currentVersion = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
  const release = kind === "upgrade" ? await registryRelease(version, run) : undefined;
  const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind, version: kind === "restart" ? currentVersion : version,
    sourceRoot: PACKAGE_ROOT, sourceDigest, ...(release ? { integrity: release.integrity } : {}), projects: [], blockers: [] };
  if (kind === "upgrade") {
    try {
      if ((await run(["claude", "--version"], { timeoutMs: 10_000 })).code !== 0) body.blockers.push("shared Claude plugin installer is unavailable");
    } catch { body.blockers.push("shared Claude plugin installer is unavailable"); }
  }
  const managerFile = join(hubHome(), "manager/status.json");
  if (existsSync(managerFile)) {
    try {
      const manager = JSON.parse(readFileSync(managerFile, "utf8"));
      if (![8, PROTOCOL].includes(manager.protocol)) body.blockers.push("manager requires manual bootstrap with its matching CLI before protocol-9 recovery");
    } catch { body.blockers.push("manager ownership manifest is unreadable"); }
  }
  for (const project of projects) {
    if (kind === "restart" && project.root !== selectedRoot) continue;
    let source: Inspection;
    try { source = await inspectRecovery(project); }
    catch { source = { state: "unavailable", peers: [], blockers: ["source recovery metadata could not be authenticated"] }; }
    if (source.state === "stopped" || source.state === "missing") continue;
    const blockers = [...source.blockers];
    if (![8, PROTOCOL].includes(source.protocol ?? 0) || source.state !== "running") blockers.push("manual-bootstrap-required: an authenticated recovery-capable source is required");
    if (source.recovery?.operationId && source.recovery.phase !== "released") blockers.push(`existing recovery operation ${source.recovery.operationId} must be resolved first`);
    const sessions: { codex?: string; claude?: string; pi?: SessionRef } = {};
    for (const peer of source.peers) {
      if (peer.state === "offline") continue;
      if (peer.id === "codex" || peer.id === "claude") {
        const session = peer.id === "codex" ? peer.threadId : peer.sessionId;
        if (!session) blockers.push(`${peer.id}: original conversation ID is unknown; manual-required`);
        else sessions[peer.id] = session;
      } else if (peer.id === "pi" && peer.args?.mode === "tui") {
        if (!peer.sessionId) blockers.push("pi: original session ID is unknown; manual-required");
        else sessions.pi = { sessionId: peer.sessionId, ...(peer.sessionFile ? { sessionFile: peer.sessionFile } : {}), ...(peer.args.backend ? { backend: peer.args.backend } : {}), ...(peer.args.model ? { model: peer.args.model } : {}) };
      } else if (peer.id !== "kimi" && peer.id !== "local" && peer.id !== "pi") blockers.push(`${peer.id}: no automatic recovery adapter`);
    }
    const terminals = await inspectTerminals(project.root, sessions, {
      ...terminalOptions(run), stateDir: project.stateDir, instanceId: source.instanceId,
    });
    blockers.push(...terminals.blockers.map((b) => b.message));
    body.projects.push({ project, source, terminals: terminals.bindings, blockers });
  }
  if (!body.projects.length) body.blockers.push("no running registered projects in scope");
  return { ...body, fingerprint: planFingerprint(body) };
}

/** Freeze the coordinator/source package before its mutable global installation is replaced. */
export function preserveSource(plan: UpgradePlan, home = hubHome()): string {
  if (packageDigest(plan.sourceRoot) !== plan.sourceDigest) throw new Error("source package changed since planning");
  const base = join(home, "releases");
  const dest = join(base, `source-${plan.sourceDigest}`);
  if (existsSync(dest)) {
    if (packageDigest(dest) !== plan.sourceDigest) throw new Error("preserved source package changed");
    return dest;
  }
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const temporary = join(base, `.source-${randomUUID()}`);
  mkdirSync(temporary, { mode: 0o700 });
  try {
    for (const name of ["src", "plugins", "templates", ".claude-plugin", "package.json", "README.md", "LICENSE", "CHANGELOG.md"]) {
      cpSync(join(plan.sourceRoot, name), join(temporary, name), { recursive: true, dereference: false });
    }
    if (packageDigest(temporary) !== plan.sourceDigest) throw new Error("source changed while being preserved");
    renameSync(temporary, dest);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  return dest;
}

export function makeRecoveryDriver(run: RunCommand = runCommand): RecoveryDriver {
  const now = () => Date.now();
  const sleep = (ms: number) => Bun.sleep(ms);
  const env = (op: RecoveryOperation, project?: Project): NodeJS.ProcessEnv => {
    const value = { ...process.env };
    // Do not carry one project's gateway, auth overrides or unattended mode into another.
    for (const key of Object.keys(value)) if (key.startsWith("AGENTHUB_") || key.startsWith("OMNIROUTE_") || key.startsWith("CF_ACCESS_") ||
      (project && /(?:_API_KEY|_ACCESS_TOKEN|_SECRET|_TOKEN)$/.test(key))) delete value[key];
    value.AGENTHUB_HOME = hubHome(); value.AGENTHUB_RECOVERY_OPERATION = op.id;
    value.AGENTHUB_UNATTENDED = "0";
    if (project) {
      value.AGENTHUB_PROJECT_DIR = project.root; value.AGENTHUB_STATE_DIR = project.stateDir;
      delete value.CODEX_HOME; delete value.CLAUDE_CONFIG_DIR;
      const bindings = op.plan.projects.find((p) => p.project.id === project.id)?.terminals as TerminalBinding[] | undefined;
      for (const binding of bindings ?? []) {
        const key = binding.peer === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
        if (binding.launch.env[key]) value[key] = binding.launch.env[key];
      }
    }
    return value;
  };
  const command = async (op: RecoveryOperation, args: string[], project?: Project) => {
    const result = await run([process.execPath, join(op.targetRoot!, "src/cli/main.js"), ...(project ? ["--project", project.root] : []), ...args],
      { env: env(op, project), cwd: project?.root ?? op.plan.projects[0]!.project.root, timeoutMs: 180_000 });
    if (result.code !== 0) throw new Error(`target command ${args[0]} failed; inspect recovery state before retrying`);
    return result;
  };
  const control = (project: Project, op: string, id: string, instance: string) => rpc(project, { t: "recovery", op, operationId: id, expectedInstanceId: instance }).then(() => {});
  const revalidateTerminal = async (planned: PlannedProject, progress: ProjectProgress, saved: TerminalBinding, exact: boolean): Promise<TerminalBinding> => {
    const options = { ...terminalOptions(run), stateDir: planned.project.stateDir, instanceId: progress.instanceId };
    const found = await inspectTerminals(planned.project.root, { [saved.peer]: saved.sessionId }, options);
    const current = found.byPeer[saved.peer];
    if (found.manualRequired || !current || (exact && (current.handle !== saved.handle || current.incarnationId !== saved.incarnationId || current.worktreeId !== saved.worktreeId || current.projectRoot !== saved.projectRoot))) {
      throw new Error(`${saved.peer}: saved terminal identity changed or is not verified; manual-required`);
    }
    const idle = await waitForIdle(exact ? saved : current, 120_000, options);
    if (!idle.satisfied) throw new Error(`${saved.peer}: terminal is not idle; manual-required`);
    const observed = await inspectRecovery(planned.project);
    if (observed.instanceId !== progress.instanceId) throw new Error(`${saved.peer}: daemon instance changed during terminal revalidation`);
    const peer = observed.peers.find((item) => item.id === saved.peer);
    const session = saved.peer === "codex" ? peer?.threadId : peer?.sessionId;
    if (session !== saved.sessionId) throw new Error(`${saved.peer}: daemon session changed during terminal revalidation; manual-required`);
    return current;
  };
  return {
    now, sleep, inspect: inspectRecovery,
    stage: async (op) => {
      if (packageDigest(op.sourceRoot) !== op.plan.sourceDigest) throw new Error("preserved source changed");
      const target = op.plan.kind === "restart" ? { root: op.sourceRoot, digest: verifyPackage(op.sourceRoot, op.plan.version) }
        : await stageRelease(op.plan.version, op.plan.integrity!, run);
      const protocol = await run([process.execPath, "-e", `import { PROTOCOL } from ${JSON.stringify(join(target.root, "src/hub/control-client.ts"))}; console.log(PROTOCOL)`]);
      if (protocol.code !== 0 || Number(protocol.stdout.trim()) !== PROTOCOL) throw new Error("target protocol requires a newer coordinator; staged package retained, runtimes unchanged");
      return target;
    },
    prepare: (p, id, instance) => control(p, "prepare", id, instance),
    abort: (p, id, instance) => control(p, "abort", id, instance),
    commit: (p, id, instance) => control(p, "commit", id, instance),
    release: (p, id, instance) => control(p, "release", id, instance),
    closeTerminals: async (planned, progress, op, save) => {
      for (const binding of planned.terminals as TerminalBinding[]) {
        const key = `closed:${binding.peer}`;
        if (progress.terminals[key] === true) continue;
        if (progress.terminals[key] === "pending") {
          const result = await run([orcaExecutable(), "terminal", "list", "--json"]);
          const inventory = JSON.parse(result.stdout);
          const rows = inventory.result?.terminals;
          if (result.code !== 0 || inventory.ok !== true || !Array.isArray(rows) || inventory.result?.truncated ||
              rows.some((t: any) => t.handle === binding.handle || t.incarnationId === binding.incarnationId)) {
            throw new Error(`${binding.peer}: terminal close outcome needs manual reconciliation`);
          }
          progress.terminals[key] = true; save(); continue;
        }
        const idle = await waitForIdle(binding, 600_000, terminalOptions(run));
        if (!idle.satisfied) throw new Error(`${binding.peer}: terminal is not verified idle; source retained`);
        const source = await inspectRecovery(planned.project);
        if (source.instanceId !== planned.source.instanceId || source.recovery?.operationId !== op.id || !source.recovery.ready) {
          throw new Error("source preparation expired or changed while waiting for the terminal; no terminal was closed");
        }
        // Refresh the same prepared lease immediately before the terminal effect. Preserve
        // the original peer roster, including any terminal already closed in this operation.
        await control(planned.project, "prepare", op.id, planned.source.instanceId!);
        progress.terminals[key] = "pending"; save();
        const result = await closeTerminal(binding, 0, terminalOptions(run));
        if (result.manualRequired) throw new Error(`${binding.peer}: terminal close not verified; manual-required`);
        progress.terminals[key] = true; save();
      }
    },
    start: async (p, op) => {
      const checkpoint = JSON.parse(readFileSync(join(p.stateDir, "restart.json"), "utf8"));
      if (checkpoint.projectId !== p.id || checkpoint.projectRoot !== p.root || checkpoint.operationId !== op.id) {
        throw new Error("committed restart snapshot is missing or belongs to another operation");
      }
      await command(op, ["up"], p);
    },
    restore: async (planned, progress, op, group, save) => {
      const live = await inspectRecovery(planned.project);
      if (live.instanceId !== progress.instanceId) throw new Error("target daemon changed before peer restore");
      if (group === "native") {
        for (const peer of planned.source.peers.filter((p) => ["kimi", "local", "pi"].includes(p.id) && p.state !== "offline" && !(p.id === "pi" && p.args?.mode === "tui"))) {
          const current = live.peers.find((p) => p.id === peer.id);
          if (current && current.state !== "offline") continue;
          const args = [peer.id];
          for (const key of ["mode", "backend", "model", "route"]) if (typeof peer.args?.[key] === "string") args.push(`--${key}`, peer.args[key]!);
          if (peer.id === "pi") {
            const sessionFile = peer.sessionFile ?? peer.args?.sessionFile;
            if (typeof sessionFile === "string") args.push("--session-file", sessionFile);
            else if (peer.sessionId) args.push("--session-id", peer.sessionId);
          }
          await command(op, args, planned.project);
        }
      }
      for (const original of planned.terminals as TerminalBinding[]) {
        if ((original.peer === "claude") !== (group === "claude")) continue;
        const key = `restored:${original.peer}`;
        if (progress.terminals[key] && progress.terminals[key] !== "pending") {
          progress.terminals[key] = await revalidateTerminal(planned, progress, progress.terminals[key] as TerminalBinding, true); save();
          continue;
        }
        if (progress.terminals[key] === "pending") {
          const observed = await inspectRecovery(planned.project);
          const peer = observed.peers.find((p) => p.id === original.peer);
          if ((original.peer === "codex" ? peer?.threadId : peer?.sessionId) !== original.sessionId) {
            throw new Error(`${original.peer}: terminal creation outcome is uncertain; attach the original session manually, then resume`);
          }
          const existing = await revalidateTerminal(planned, progress, original, false);
          progress.terminals[key] = existing; save(); continue;
        }
        const entrypoint = join(op.targetRoot!, "src/cli/main.js");
        const argv = [process.execPath, entrypoint, "--project", planned.project.root, original.peer,
          ...(original.peer === "codex" ? ["resume", original.sessionId] : ["--resume", original.sessionId])];
        const assignments = { ...original.launch.env, AGENTHUB_HOME: hubHome(), AGENTHUB_RECOVERY_OPERATION: op.id };
        const launch = { ...original.launch, packageEntrypoint: entrypoint, argv,
          command: ["env", ...Object.entries(assignments).map(([k, v]) => `${k}=${v}`), ...argv].map(shellQuote).join(" ") };
        const binding = { ...original, launch, launchMetadata: launch };
        progress.terminals[key] = "pending"; save();
        const restored = await createTerminal(binding, { ...terminalOptions(run), stateDir: planned.project.stateDir, instanceId: progress.instanceId });
        if (restored.manualRequired || !restored.newBinding) throw new Error(`${original.peer}: original session restoration needs manual verification`);
        progress.terminals[key] = restored.newBinding; save();
      }
    },
    installPlugin: async (op) => {
      const configured = new Set<string>();
      for (const planned of op.plan.projects) {
        const binding = (planned.terminals as TerminalBinding[]).find((t) => t.peer === "claude");
        if (!binding) continue;
        const profile = binding.launch.env.CLAUDE_CONFIG_DIR ?? "default";
        if (configured.has(profile)) continue;
        await command(op, ["setup", "--yes"], planned.project);
        configured.add(profile);
      }
      if (!configured.size) await command(op, ["setup", "--yes"]);
    },
    installGlobal: async (op) => {
      const result = await run([process.execPath, "add", "-g", `@staix/agent-hub@${op.plan.version}`, "--ignore-scripts"], { env: env(op), timeoutMs: 180_000 });
      if (result.code !== 0) throw new Error("global installation failed; project runtimes use the retained staged package");
      const readback = await run(["ahub", "--version"], { env: env(op) });
      if (readback.code !== 0 || readback.stdout.trim() !== op.plan.version) throw new Error("global CLI version was not verified");
    },
    refreshManager: async (op) => { await refreshManager({ home: hubHome(), cli: join(op.targetRoot!, "src/cli/main.ts") }); },
    verify: async (planned, progress, op) => {
      const live = await inspectRecovery(planned.project);
      if (live.instanceId !== progress.instanceId || live.version !== op.plan.version || live.recovery?.operationId !== op.id) throw new Error("target identity verification failed");
      for (const old of planned.source.peers.filter((p) => p.state !== "offline")) {
        const peer = live.peers.find((p) => p.id === old.id);
        if (!peer || !["idle", "busy", "paused"].includes(peer.state)) throw new Error(`${old.id}: peer reattachment not verified`);
        if (old.id === "codex" && peer.threadId !== old.threadId) throw new Error("Codex resumed a different conversation");
        if (old.id === "claude" && peer.sessionId !== old.sessionId) throw new Error("Claude resumed a different conversation");
      }
      for (const original of planned.terminals as TerminalBinding[]) {
        const saved = progress.terminals[`restored:${original.peer}`];
        if (!saved || saved === "pending") throw new Error(`${original.peer}: restored terminal outcome is not recorded; manual-required`);
        await revalidateTerminal(planned, progress, saved as TerminalBinding, true);
      }
      const snapshot = await rpc(planned.project, { t: "ui_snapshot", after: 0 });
      if (snapshot.ok === false) throw new Error("dashboard snapshot readback failed");
      const recovery = await rpc(planned.project, { t: "recovery", op: "inspect", expectedInstanceId: progress.instanceId });
      const integrity = recovery.recovery?.integrity;
      if (!integrity?.expected || JSON.stringify(integrity.current) !== JSON.stringify(integrity.expected)) {
        throw new Error("queue, manual pause, task board or budget preservation was not verified");
      }
    },
  };
}
