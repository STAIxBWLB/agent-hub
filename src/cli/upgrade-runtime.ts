import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ControlClient, PROTOCOL, RECOVERY_SOURCE_PROTOCOLS, readControl } from "../hub/control-client.ts";
import { awaitStopped, inspectProject } from "../hub/lifecycle.ts";
import type { Project } from "../hub/registry.ts";
import { hubHome } from "../hub/project.ts";
import { packageDigest, registryRelease, runCommand, stageRelease, verifyPackage, type RunCommand } from "./recovery-package.ts";
import { inspectTerminals, closeTerminal, createTerminal, launcherOf, recordedLauncher, waitForIdle, shellQuote, type SessionRef, type TerminalBinding, type TerminalRecoveryOptions } from "./terminal-recovery.ts";
import { planFingerprint, recoveryCommand, registeredProjects, type Inspection, type PlannedProject, type ProjectProgress, type RecoveryDriver, type RecoveryOperation, type UpgradePlan } from "./upgrade.ts";
import { readEvents } from "../hub/events.ts";
import { refreshManager } from "../hub/manager.ts";
import { abandonRestartSnapshot, waiveRecoveryPeers } from "../hub/restart.ts";

/** An unmanaged Claude's plugin retries with a backoff of at most 30 s; three of those bound the reconnect wait (#206). */
const RECONNECT_WAIT_MS = 90_000;

export const PACKAGE_ROOT = resolve(import.meta.dir, "../..");
const orcaExecutable = () => process.env.ORCA_CLI_COMMAND || (process.env.ORCA_DEV_REPO_ROOT ? "orca-dev" : process.platform === "linux" && !process.env.ORCA_TERMINAL_HANDLE ? "orca-ide" : "orca");

/**
 * Claude Code persists a transcript at projects/<slug>/<sessionId>.jsonl under its config
 * dir, creating the project directory only with the first persisted turn; the slug replaces
 * every non-alphanumeric character of the project root with '-'.
 */
function claudeTranscriptExists(binding: TerminalBinding): boolean {
  const config = binding.launch.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const slug = binding.projectRoot.replace(/[^a-zA-Z0-9]/g, "-");
  return existsSync(join(config, "projects", slug, `${binding.sessionId}.jsonl`));
}

/**
 * #215: `codex resume <id>` reads the thread's rollout from the store its launcher uses (the captured CODEX_HOME, else
 * the default), so an app-server thread id alone proves nothing.
 * ponytail: a `.jsonl` under sessions/ whose name carries the thread id is the evidence; ask Codex itself once it offers
 * a supported resumability query, or when its store layout changes.
 */
const codexSessions = (binding: TerminalBinding) => join(binding.launch.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
function codexTranscript(binding: TerminalBinding): "found" | "missing" | "unknown" {
  try { return readdirSync(codexSessions(binding), { recursive: true }).some((name) => String(name).endsWith(".jsonl") && basename(String(name)).includes(binding.sessionId)) ? "found" : "missing"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unknown"; } // no store has no rollout; an unreadable one says nothing
}
const unresumable = (binding: TerminalBinding) => codexTranscript(binding) === "unknown"
  ? `codex: the session store ${codexSessions(binding)} cannot be read, so whether thread ${binding.sessionId} can resume is unknown`
  : `codex: thread ${binding.sessionId} has no resumable transcript under ${codexSessions(binding)}`;

const closeUnsettled = (binding: TerminalBinding, op: RecoveryOperation) =>
  `${binding.peer}: terminal close outcome needs manual reconciliation: Orca still lists terminal ${binding.handle}; next action: close that terminal (the login shell it runs in) by hand in Orca, then ${recoveryCommand(op, "resume")}`;

/**
 * #215: Codex writes a thread's rollout with its first message, so a thread this hub saw Codex start (`native_thread`
 * with `fresh`) on which no turn ran has nothing to lose. A codex turn_start belongs to the thread most recently
 * adopted before it; detaching forgets nothing. A thread whose start the log does not show (resumed, older hub, pruned
 * log) is unsure, and unsure counts as turned.
 */
function codexZeroTurn(stateDir: string, thread: string): boolean {
  let current: string | undefined, started = false, turned = false;
  for (const e of readEvents(join(stateDir, "events.jsonl"))) {
    if (e.type === "native_thread" && e.peer === "codex") {
      current = e.thread;
      if (e.thread === thread && e.fresh) started = true;
    } else if (e.type === "turn_start" && e.peer === "codex" && current === thread) turned = true;
  }
  return started && !turned;
}

function terminalOptions(run: RunCommand = runCommand): TerminalRecoveryOptions {
  return { orcaExecutable: orcaExecutable(), runner: async (args) => {
    const result = await run([orcaExecutable(), ...args], { timeoutMs: 610_000 });
    return { status: result.code, stdout: result.stdout, stderr: result.stderr };
  } };
}

/** `fresh` (#215: the operator's choice, or a planned fresh start) starts Codex or Claude without resuming its recorded session. */
export function restoredTerminalArgv(entrypoint: string, projectRoot: string, binding: TerminalBinding, fresh = false): string[] {
  if (binding.peer === "codex") return [process.execPath, entrypoint, "--project", projectRoot, "codex", ...(fresh ? [] : ["resume", binding.sessionId])];
  if (binding.peer === "claude") return [process.execPath, entrypoint, "--project", projectRoot, "claude", ...(fresh ? [] : ["--resume", binding.sessionId])];
  return [process.execPath, entrypoint, "--project", projectRoot, "pi", "--mode", "tui",
    ...(binding.backend ? ["--backend", binding.backend] : []), ...(binding.model ? ["--model", binding.model] : []),
    ...(binding.sessionFile ? ["--session-file", binding.sessionFile] : ["--session-id", binding.sessionId])];
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
  const legacySupported = sourceProtocol !== undefined && RECOVERY_SOURCE_PROTOCOLS.includes(sourceProtocol as (typeof RECOVERY_SOURCE_PROTOCOLS)[number]);
  if (base.state !== "running" && !legacySupported) return {
    state: base.state, peers: [], blockers: base.state === "stopped" ? [] : [base.state === "incompatible" ? "manual-bootstrap-required: source lacks the recovery contract; use its matching CLI" : base.error ?? base.state],
    ...(control?.instanceId ? { instanceId: control.instanceId } : {}), ...(control?.protocol ? { protocol: control.protocol } : {}),
  };
  let status = base.status;
  if (!status && legacySupported) {
    try {
      const readback = await rpc(project, { t: "status" }, sourceProtocol);
      status = readback.status;
    } catch {
      // server.stop() runs before state-file removal, so a stopping hub briefly refuses
      // connections with its manifest still on disk. Never infer stopped from a connect
      // failure: callers poll again and see "stopped" once the manifest is gone.
      return { state: "unavailable", peers: [], blockers: ["runtime changed during recovery inspection"],
        ...(control?.instanceId ? { instanceId: control.instanceId } : {}), ...(control?.protocol ? { protocol: control.protocol } : {}) };
    }
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
      if (!RECOVERY_SOURCE_PROTOCOLS.includes(manager.protocol as (typeof RECOVERY_SOURCE_PROTOCOLS)[number])) body.blockers.push("manager requires manual bootstrap with its matching CLI before current-protocol recovery");
    } catch { body.blockers.push("manager ownership manifest is unreadable"); }
  }
  for (const project of projects) {
    if (kind === "restart" && project.root !== selectedRoot) continue;
    let source: Inspection;
    try { source = await inspectRecovery(project); }
    catch { source = { state: "unavailable", peers: [], blockers: ["source recovery metadata could not be authenticated"] }; }
    if (source.state === "stopped" || source.state === "missing") continue;
    const blockers = [...source.blockers];
    if (!RECOVERY_SOURCE_PROTOCOLS.includes(source.protocol as (typeof RECOVERY_SOURCE_PROTOCOLS)[number]) || source.state !== "running") blockers.push("manual-bootstrap-required: an authenticated protocol-9, protocol-10, protocol-11, protocol-12, protocol-13, protocol-14, protocol-15 or protocol-16 source is required");
    if (source.recovery?.operationId && source.recovery.phase !== "released") blockers.push(`existing recovery operation ${source.recovery.operationId} must be resolved first`);
    const sessions: { codex?: string; claude?: string; pi?: SessionRef } = {};
    const reconnectOnly: string[] = [];
    for (const peer of source.peers) {
      if (peer.state === "offline") continue;
      if (peer.id === "claude") {
        // #206: managed means a live `ahub claude` launcher recorded for this daemon and a session record written by
        // that launch. Anything else cannot be bound to the attached session, so its record never becomes a target.
        // ponytail: the channel's hello carries no launch id, so a plain `claude` that took the peer id from a live
        // managed session reads as managed; send the launch id at hello (a protocol bump) if that case shows up.
        const launcher = await recordedLauncher("claude", project.root, { ...terminalOptions(run), stateDir: project.stateDir, instanceId: source.instanceId });
        if (!launcher) {
          delete peer.sessionId;
          if (source.protocol === PROTOCOL) reconnectOnly.push("claude");
          else blockers.push(`claude: unmanaged session (no live ahub claude launcher recorded) runs a protocol-${source.protocol} plugin and cannot reconnect to a protocol-${PROTOCOL} hub; next action: end that Claude session, or relaunch it with ahub claude in an Orca terminal, then make a new plan`);
          continue;
        }
        let record: { instanceId?: unknown; launchId?: unknown; sessionId?: unknown } | undefined;
        try { record = JSON.parse(readFileSync(join(project.stateDir, "claude-session.json"), "utf8")); } catch { /* no record: the id check below reports it */ }
        if (peer.sessionId && (record?.instanceId !== source.instanceId || record?.launchId !== launcher.launchId || record?.sessionId !== peer.sessionId)) {
          delete peer.sessionId;
          blockers.push(`claude: the recorded session was not written by the live launcher in terminal ${launcher.handle}; manual-required; next action: close any other Claude session in this project, send one message in that terminal, then make a new plan`);
          continue;
        }
      }
      if (peer.id === "codex" || peer.id === "claude") {
        const session = peer.id === "codex" ? peer.threadId : peer.sessionId;
        if (!session) blockers.push(`${peer.id}: original conversation ID is unknown; manual-required; next action: reconnect the original native session and make a new recovery plan`);
        else sessions[peer.id] = session;
      } else if (peer.id === "pi" && peer.args?.mode === "tui") {
        if (!peer.sessionId) blockers.push("pi: original session ID is unknown; manual-required; next action: reconnect the original Pi session and make a new recovery plan");
        else sessions.pi = { sessionId: peer.sessionId, ...(peer.sessionFile ? { sessionFile: peer.sessionFile } : {}), ...(peer.args.backend ? { backend: peer.args.backend } : {}), ...(peer.args.model ? { model: peer.args.model } : {}) };
      } else if (peer.id !== "kimi" && peer.id !== "local" && peer.id !== "pi") blockers.push(`${peer.id}: no automatic recovery adapter`);
    }
    const terminals = await inspectTerminals(project.root, sessions, {
      ...terminalOptions(run), stateDir: project.stateDir, instanceId: source.instanceId,
    });
    blockers.push(...terminals.blockers.map((b) => `${b.message}${b.terminalReference ? ` (terminal ${b.terminalReference})` : ""}${b.nextAction ? `; next action: ${b.nextAction}` : ""}`));
    const freshStart: string[] = [];
    for (const binding of terminals.bindings) if (binding.peer === "codex") {
      const transcript = codexTranscript(binding);
      if (transcript === "found") continue;
      if (transcript === "missing" && codexZeroTurn(project.stateDir, binding.sessionId)) { freshStart.push("codex"); continue; }
      blockers.push(transcript === "unknown"
        ? `${unresumable(binding)}; manual-required; next action: make that store readable, then make a new plan`
        : `${unresumable(binding)}, and the hub cannot show that no turn ran on it, so its conversation may not come back after the restart; manual-required; next action: end that Codex session and close its Orca terminal ${binding.handle} (ahub codex starts a new one later), then make a new plan`);
    }
    body.projects.push({ project, source, terminals: terminals.bindings, blockers, ...(reconnectOnly.length ? { reconnectOnly } : {}), ...(freshStart.length ? { freshStart } : {}) });
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
  const control = (project: Project, op: string, id: string, instance: string) => {
    const sourceProtocol = readControl(project.stateDir)?.protocol;
    const protocol = sourceProtocol !== undefined && RECOVERY_SOURCE_PROTOCOLS.includes(sourceProtocol as (typeof RECOVERY_SOURCE_PROTOCOLS)[number]) ? sourceProtocol : PROTOCOL;
    return rpc(project, { t: "recovery", op, operationId: id, expectedInstanceId: instance }, protocol).then(() => {});
  };
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
  // Reconnect-only (#206) and fresh sessions (#215) need a target hub that reads recovery-waivers.json.
  const waiversSupported = async (root: string) => {
    const probe = await run([process.execPath, "-e", `import { readRecoveryWaivers } from ${JSON.stringify(join(root, "src/hub/restart.ts"))}; console.log(typeof readRecoveryWaivers)`]);
    return probe.code === 0 && probe.stdout.trim() === "function";
  };
  const attachedId = async (planned: PlannedProject, peer: string, op: RecoveryOperation): Promise<string> => {
    for (const deadline = now() + RECONNECT_WAIT_MS; ;) {
      const current = (await inspectRecovery(planned.project)).peers.find((p) => p.id === peer && p.state !== "offline");
      const id = peer === "codex" ? current?.threadId : current?.sessionId;
      if (id) return id;
      if (now() >= deadline) throw new Error(`${peer}: the new session reported no id within ${RECONNECT_WAIT_MS / 1000} s; next action: wait until it attaches, then ${recoveryCommand(op, "resume")}`);
      await sleep(1000);
    }
  };
  return {
    now, sleep, inspect: inspectRecovery,
    stage: async (op) => {
      if (packageDigest(op.sourceRoot) !== op.plan.sourceDigest) throw new Error("preserved source changed");
      const target = op.plan.kind === "restart" ? { root: op.sourceRoot, digest: verifyPackage(op.sourceRoot, op.plan.version) }
        : await stageRelease(op.plan.version, op.plan.integrity!, run);
      const protocol = await run([process.execPath, "-e", `import { PROTOCOL } from ${JSON.stringify(join(target.root, "src/hub/control-client.ts"))}; console.log(PROTOCOL)`]);
      if (protocol.code !== 0 || Number(protocol.stdout.trim()) !== PROTOCOL) throw new Error("target protocol requires a newer coordinator; staged package retained, runtimes unchanged");
      if (op.plan.projects.some((p) => p.reconnectOnly?.length || p.freshStart?.length) && !(await waiversSupported(target.root))) {
        throw new Error(`target ${op.plan.version} predates recovery waivers, so its hub could never accept a reconnect-only Claude or a fresh Codex start; staged package retained, runtimes unchanged; next action: ${recoveryCommand(op, "abort")}, then choose a newer target`);
      }
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
            throw new Error(closeUnsettled(binding, op));
          }
          progress.terminals[key] = true; save(); continue;
        }
        // A peer whose TUI already exited left nothing to close: the source reports it
        // detached, and inventory silence is the same proof the pending-reconcile path
        // accepts. No mutation is issued for a terminal that no longer exists (#21).
        const attached = (await inspectRecovery(planned.project)).peers.find((item) => item.id === binding.peer);
        if (attached?.state === "offline") {
          const result = await run([orcaExecutable(), "terminal", "list", "--json"]);
          const inventory = JSON.parse(result.stdout);
          const rows = inventory.result?.terminals;
          if (result.code !== 0 || inventory.ok !== true || !Array.isArray(rows) || inventory.result?.truncated ||
              rows.some((t: any) => t.handle === binding.handle || t.incarnationId === binding.incarnationId)) {
            throw new Error(closeUnsettled(binding, op));
          }
          progress.terminals[key] = true; save(); continue;
        }
        // #215: check resume viability again right before the destructive effect (a planned fresh start has none to lose).
        const transcript = binding.peer === "codex" ? codexTranscript(binding) : "found";
        if (transcript === "unknown") throw new Error(`${unresumable(binding)}; no terminal was closed; next action: make that store readable, then ${recoveryCommand(op, "resume")}`);
        if (transcript === "missing" && !planned.freshStart?.includes("codex")) {
          throw new Error(`${unresumable(binding)}; no terminal was closed; next action: ${recoveryCommand(op, "dispose", "--stop-and-archive --reason <text>")} releases the source hold (sessions this operation has not closed stay open; those it closed stay closed), or end that Codex session, close its Orca terminal ${binding.handle} and ${recoveryCommand(op, "resume")}; resume then stops at restoring codex, where ${recoveryCommand(op, "dispose", "--fresh-session codex --reason <text>")} is the explicit way to continue without its conversation`);
        }
        const idle = await waitForIdle(binding, 600_000, terminalOptions(run));
        if (!idle.satisfied) throw new Error(`${binding.peer}: terminal is not verified idle; source retained`);
        const source = await inspectRecovery(planned.project);
        if (source.instanceId !== planned.source.instanceId || source.recovery?.operationId !== op.id || !source.recovery.ready) {
          throw new Error("source preparation expired or changed while waiting for the terminal; no terminal was closed");
        }        // Refresh the same prepared lease immediately before the terminal effect. Preserve
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
      const reconnect = op.plan.projects.find((planned) => planned.project.id === p.id)?.reconnectOnly ?? [];
      if (reconnect.length) waiveRecoveryPeers(p.stateDir, op.id, Object.fromEntries(reconnect.map((peer) => [peer, "reconnect-only"])));
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
        // A new session is accepted only by the operator's choice (#215 dispose --fresh-session) or a planned fresh
        // start of a Codex thread with nothing to lose that still has no rollout; an unreadable store is neither.
        const chosen = !!progress.fresh?.[original.peer];
        let read: ReturnType<typeof codexTranscript> | undefined;
        const transcript = () => original.peer !== "codex" || chosen ? "found" : (read ??= codexTranscript(original));
        const fresh = () => chosen || (!!planned.freshStart?.includes(original.peer) && transcript() === "missing");
        // What runs for this peer on the target: an attached session, and the recorded launcher with its state.
        const attachedSession = (inspection: Inspection) => {
          const peer = inspection.peers.find((p) => p.id === original.peer && p.state !== "offline");
          return original.peer === "codex" ? peer?.threadId : peer?.sessionId;
        };
        const launcher = () => launcherOf(original.peer, planned.project.root, { ...terminalOptions(run), stateDir: planned.project.stateDir, instanceId: progress.instanceId });
        const resume = recoveryCommand(op, "resume");
        const notRestored = (why: string) => new Error(fresh()
          ? `${original.peer}: ${why}; next action: read that terminal in Orca for the launcher's error and fix its cause, then ${resume}; or ${recoveryCommand(op, "dispose", "--stop-and-archive --reason <text>")}`
          : `${original.peer}: ${why}; session ${original.sessionId} was not restored; choices: ${recoveryCommand(op, "dispose", `--fresh-session ${original.peer} --reason <text>`)} starts a new ${original.peer} session and records this one as lost, or ${recoveryCommand(op, "dispose", "--stop-and-archive --reason <text>")} abandons the upgrade`);
        const receipt = progress.terminals[key];
        if (receipt && receipt !== "pending" && receipt !== "failed") {
          progress.terminals[key] = await revalidateTerminal(planned, progress, receipt as TerminalBinding, true); save();
          continue;
        }
        // #215: a pending or failed receipt is settled by what is live now (the receipt table in the recovery spec).
        if (receipt === "pending" || receipt === "failed") {
          const attached = attachedSession(await inspectRecovery(planned.project));
          if (attached) {
            // #21: a Claude session that never got a first turn has no transcript, so `claude --resume S` can never
            // succeed and accepting its fresh attach loses nothing. Otherwise only the planned id, or a new session
            // the operator or the plan accepted, counts as restored.
            if (attached !== original.sessionId && !fresh() && !(original.peer === "claude" && !claudeTranscriptExists(original))) {
              throw new Error(`${original.peer}: terminal creation outcome is uncertain: session ${attached} is attached instead of ${original.sessionId}; next action: end that ${original.peer} session and close its terminal, then ${resume}`);
            }
            // The original came back after all: a fresh session chosen for it lost nothing.
            if (attached === original.sessionId && progress.fresh?.[original.peer]) {
              delete progress.fresh[original.peer];
              if (!Object.keys(progress.fresh).length) delete progress.fresh;
            }
            progress.terminals[key] = await revalidateTerminal(planned, progress, { ...original, sessionId: attached }, false); save();
            continue;
          }
          const recorded = await launcher();
          if (recorded && recorded.state !== "gone") {
            throw new Error(`${original.peer}: its launcher in terminal ${recorded.record.handle} ${recorded.state === "live" ? "is running" : "cannot be read"} but no ${original.peer} session attached yet; next action: wait until it attaches, or end it and close terminal ${recorded.record.handle}, then ${resume}`);
          }
          if (receipt === "pending") {
            progress.terminals[key] = "failed"; save();
            throw notRestored(`its launcher no longer runs and no ${original.peer} session attached`);
          }
          delete progress.terminals[key]; save(); // failed, nothing live: launch again below
        }
        if (transcript() === "unknown") throw new Error(`${unresumable(original)}; no terminal was created; next action: make that store readable, then ${resume}`);
        if (transcript() === "missing" && !fresh()) {
          progress.terminals[key] = "failed"; save();
          throw notRestored(unresumable(original));
        }
        // Never create beside a live launch.
        const running = await launcher();
        if (attachedSession(live) || (running && running.state !== "gone")) {
          throw new Error(`${original.peer}: a ${original.peer} launch is live on the target although this operation recorded none${running ? ` (terminal ${running.record.handle})` : ""}; no terminal was created; next action: end that ${original.peer} launch and close its terminal, then ${resume}`);
        }
        if (fresh()) {
          if (!(await waiversSupported(op.targetRoot!))) throw new Error(`${original.peer}: target ${op.plan.version} predates recovery waivers, so it cannot accept a new session; next action: ${recoveryCommand(op, "dispose", "--stop-and-archive --reason <text>")}`);
          // The restored daemon must accept the new session instead of the recorded one.
          waiveRecoveryPeers(planned.project.stateDir, op.id, { [original.peer]: progress.fresh?.[original.peer] ? "fresh-session" : "fresh-start" });
        }
        const entrypoint = join(op.targetRoot!, "src/cli/main.js");
        const argv = restoredTerminalArgv(entrypoint, planned.project.root, original, fresh());
        const assignments = { ...original.launch.env, AGENTHUB_HOME: hubHome(), AGENTHUB_RECOVERY_OPERATION: op.id };
        const launch = { ...original.launch, packageEntrypoint: entrypoint, argv,
          command: ["env", ...Object.entries(assignments).map(([k, v]) => `${k}=${v}`), ...argv].map(shellQuote).join(" ") };
        const binding = { ...original, launch, launchMetadata: launch };
        progress.terminals[key] = "pending"; save();
        const restored = await createTerminal(binding, { ...terminalOptions(run), stateDir: planned.project.stateDir, instanceId: progress.instanceId }, undefined, fresh());
        const exited = restored.blockers.find((b) => b.code === "launcher-exited");
        if (exited) {
          progress.terminals[key] = "failed"; save();
          throw notRestored(exited.message);
        }
        if (restored.manualRequired || !restored.newBinding) throw new Error(`${original.peer}: original session restoration needs manual verification`);
        // The daemon's id is authoritative: a fresh session is recorded under the id it reports once attached.
        progress.terminals[key] = fresh() ? { ...restored.newBinding, sessionId: await attachedId(planned, original.peer, op) } : restored.newBinding; save();
      }
      if (group === "claude") for (const id of planned.reconnectOnly ?? []) {
        // #206: nothing is launched for an unmanaged session; its plugin reconnects by itself, within a bound.
        const deadline = now() + RECONNECT_WAIT_MS;
        while (!(await inspectRecovery(planned.project)).peers.some((p) => p.id === id && p.state !== "offline")) {
          if (now() >= deadline) throw new Error(`${id}: the unmanaged session did not reconnect within ${RECONNECT_WAIT_MS / 1000} s; next action: if that Claude session was closed, start Claude in the project again (its plugin reconnects), then ${recoveryCommand(op, "resume")}`);
          await sleep(1000);
        }
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
    stopAndArchive: async (project, op, instance) => {
      if (instance) {
        // #215: a target an older coordinator started speaks its own protocol, which the lifecycle stop's inspection
        // refuses. Ask it to stop at that protocol, fenced by its instance (the daemon refuses another), then wait as
        // the lifecycle stop does until its manifest and registry claim are gone.
        const sourceProtocol = readControl(project.stateDir)?.protocol;
        const protocol = sourceProtocol !== undefined && RECOVERY_SOURCE_PROTOCOLS.includes(sourceProtocol as (typeof RECOVERY_SOURCE_PROTOCOLS)[number]) ? sourceProtocol : PROTOCOL;
        await rpc(project, { t: "kill", instanceId: instance }, protocol);
        await awaitStopped(project, instance);
      }
      abandonRestartSnapshot(project.stateDir, op.id);
    },
    refreshManager: async (op) => { await refreshManager({ home: hubHome(), cli: join(op.targetRoot!, "src/cli/main.ts") }); },
    verify: async (planned, progress, op) => {
      const live = await inspectRecovery(planned.project);
      if (live.instanceId !== progress.instanceId || live.version !== op.plan.version || live.recovery?.operationId !== op.id) throw new Error("target identity verification failed");
      for (const old of planned.source.peers.filter((p) => p.state !== "offline")) {
        const peer = live.peers.find((p) => p.id === old.id);
        if (!peer || !["idle", "busy", "paused"].includes(peer.state)) throw new Error(`${old.id}: peer reattachment not verified`);
        if (progress.fresh?.[old.id] || planned.freshStart?.includes(old.id)) continue; // #215: a new session was accepted (recorded)
        if (old.id === "codex" && peer.threadId !== old.threadId) throw new Error("Codex resumed a different conversation");
        if (old.id === "claude" && peer.sessionId !== old.sessionId) {
          // #64: the restore gate already accepted a fresh session when the original never
          // persisted a transcript. Re-derive persistence from the binding exactly like that
          // gate did, so a first turn landing after the plan was made keeps the check strict.
          const binding = (planned.terminals as TerminalBinding[]).find((t) => t.peer === "claude");
          if (!binding || binding.sessionId !== old.sessionId || claudeTranscriptExists(binding)) throw new Error("Claude resumed a different conversation");
        }
        if (old.id === "pi" && (peer.sessionId !== old.sessionId || (old.sessionFile && peer.sessionFile !== old.sessionFile))) throw new Error("Pi resumed a different conversation");
      }
      for (const original of planned.terminals as TerminalBinding[]) {
        const saved = progress.terminals[`restored:${original.peer}`];
        if (!saved || typeof saved === "string") throw new Error(`${original.peer}: restored terminal outcome is not recorded; manual-required`);
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
