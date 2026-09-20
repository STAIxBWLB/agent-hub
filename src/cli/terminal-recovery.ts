import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

/** The only terminal commands used by this adapter. Keep this list in sync with Orca's public CLI. */
export type OrcaTerminalCommand = "list" | "show" | "wait" | "close" | "create";

export interface CommandResult {
  /** Bun's name for the process exit status. */
  status?: number;
  /** Alternate name used by small test runners and child-process wrappers. */
  exitCode?: number;
  stdout?: string | Uint8Array;
  stderr?: string | Uint8Array;
  /** A runner may return the already-decoded JSON response. */
  result?: unknown;
}

/** Runs one argv vector. The adapter never passes a shell command to this function. */
export type CommandRunner = (argv: readonly string[]) => Promise<CommandResult>;

/** Stable process identity hook. It returns a digest, never raw process metadata. */
export type ProcessIdentity = (pid: number) => string | undefined | Promise<string | undefined>;

export type TerminalPeer = "codex" | "claude" | "pi";
export interface SessionRef { sessionId: string; sessionFile?: string; backend?: string; model?: string; }

export interface LaunchMetadata {
  /** Absolute entrypoint of the package which owns the resumed session. */
  packageEntrypoint: string;
  /** Complete command string passed to Orca's supported `terminal create --command` flag. */
  command: string;
  /** The parsed argv represented by `command`, useful to a journal and tests. */
  argv: string[];
  /** Only these two variables can cross a recovery boundary. */
  env: Partial<Pick<Record<"CODEX_HOME" | "CLAUDE_CONFIG_DIR", string>, "CODEX_HOME" | "CLAUDE_CONFIG_DIR">>;
}

export interface TerminalBinding {
  peer: TerminalPeer;
  handle: string;
  incarnationId: string;
  worktreeId: string;
  projectRoot: string;
  sessionId: string;
  sessionFile?: string;
  backend?: string;
  model?: string;
  launch: LaunchMetadata;
  /** Alias retained for callers that use the wire name. */
  launchMetadata: LaunchMetadata;
}

export interface RecoveryBlocker {
  code:
    | "project-root-mismatch"
    | "stale-terminal"
    | "missing-terminal"
    | "missing-session"
    | "ownership-unknown"
    | "ambiguous-terminal"
    | "terminal-unready"
    | "command-error"
    | "ambiguous-create";
  message: string;
  peer?: TerminalPeer;
  handle?: string;
  /** Stable terminal reference when Orca supplied one, for operator reconciliation. */
  terminalReference?: string;
  /** Human action that can resolve the blocker without guessing or retrying an effect. */
  nextAction?: string;
}

export interface TerminalInspection {
  bindings: TerminalBinding[];
  /** A map is convenient for callers recovering both peers at once. */
  byPeer: Partial<Record<TerminalPeer, TerminalBinding>>;
  blockers: RecoveryBlocker[];
  manualRequired: boolean;
}

export interface IdleResult {
  satisfied: boolean;
  manualRequired: boolean;
  blockers: RecoveryBlocker[];
}

export type RestorationStatus = "restored" | "manual-required";

export interface RestorationResult {
  status: RestorationStatus;
  manualRequired: boolean;
  peer: TerminalPeer;
  oldHandle: string;
  newBinding?: TerminalBinding;
  blockers: RecoveryBlocker[];
}

export interface TerminalCloseResult {
  closed: boolean;
  manualRequired: boolean;
  binding: TerminalBinding;
  blockers: RecoveryBlocker[];
}

export interface TerminalCreateResult {
  created: boolean;
  ready: boolean;
  manualRequired: boolean;
  binding?: TerminalBinding;
  /** Compatibility name used by the coordinator journal. */
  newBinding?: TerminalBinding;
  blockers: RecoveryBlocker[];
}

export interface TerminalRecoveryOptions {
  runner?: CommandRunner;
  /** Defaults to `orca`; callers in a managed session may pin another executable. */
  orcaExecutable?: string;
  /** Absolute path to this package's JS entrypoint. */
  packageEntrypoint?: string;
  /** Private state directory used to authenticate terminals launched by this ahub instance. */
  stateDir?: string;
  /** Daemon instance fence for a recorded launch. */
  instanceId?: string;
  /** Injectable process-start identity used to reject stale or reused launcher PIDs. */
  processIdentity?: ProcessIdentity;
}

export interface RecordedTerminalLaunch {
  peer: TerminalPeer;
  projectRoot: string;
  stateDir: string;
  instanceId: string;
  launcherPid: number;
  launcherSignature: string;
  /** Per-launch fence inherited by the native agent and Claude statusline. */
  launchId: string;
  handle: string;
  incarnationId: string;
  worktreeId: string;
  env: Partial<Record<AllowedEnvName, string>>;
}

const MAX_WAIT_MS = 10 * 60 * 1000;
const MAX_COMMAND_MS = 30_000;
const ALLOWED_ENV = ["CODEX_HOME", "CLAUDE_CONFIG_DIR"] as const;
type AllowedEnvName = (typeof ALLOWED_ENV)[number];

const defaultEntrypoint = resolve(fileURLToPath(new URL("./main.js", import.meta.url)));

function bytes(value: string | Uint8Array | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function commandStatus(result: CommandResult): number {
  return result.status ?? result.exitCode ?? 0;
}

function decoded(result: CommandResult): unknown {
  if (result.result !== undefined) return result.result;
  const text = bytes(result.stdout).trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errorText(result: CommandResult): string {
  const stderr = bytes(result.stderr).trim();
  return stderr || `exit status ${commandStatus(result)}`;
}

function runnerFailure(argv: readonly string[], result: CommandResult): RecoveryBlocker {
  return { code: "command-error", message: `Orca ${argv.slice(0, 2).join(" ")} failed: ${errorText(result)}` };
}

async function run(runner: CommandRunner, argv: readonly string[]): Promise<unknown> {
  const result = await runner(argv);
  if (commandStatus(result) !== 0) throw new OrcaCommandError(runnerFailure(argv, result));
  const value = decoded(result);
  const root = object(value);
  const payload = responseResult(value);
  if (root.ok === false || payload.ok === false) {
    throw new OrcaCommandError({ code: "command-error", message: `Orca ${argv.slice(0, 2).join(" ")} returned ok:false${typeof root.error === "string" ? `: ${root.error}` : ""}` });
  }
  return value;
}

export class OrcaCommandError extends Error {
  constructor(public readonly blocker: RecoveryBlocker) {
    super(blocker.message);
    this.name = "OrcaCommandError";
  }
}

/** POSIX quoting for the single command-string argument accepted by Orca. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeOptions(options?: CommandRunner | TerminalRecoveryOptions): Required<TerminalRecoveryOptions> {
  const config: TerminalRecoveryOptions = typeof options === "function" ? { runner: options } : options ?? {};
  const orcaExecutable = config.orcaExecutable ?? resolveOrcaExecutable();
  return {
    runner: config.runner ?? defaultRunner(orcaExecutable),
    orcaExecutable,
    packageEntrypoint: config.packageEntrypoint ?? defaultEntrypoint,
    stateDir: config.stateDir ?? "",
    instanceId: config.instanceId ?? "",
    processIdentity: config.processIdentity ?? defaultProcessIdentity,
  };
}

/** Resolve the same binary selection as the Orca CLI skill, once per operation. */
function resolveOrcaExecutable(): string {
  if (process.env.ORCA_CLI_COMMAND) return process.env.ORCA_CLI_COMMAND;
  if (process.env.ORCA_DEV_REPO_ROOT) return "orca-dev";
  if (process.platform === "linux") return "orca-ide";
  return "orca";
}

function defaultProcessIdentity(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart=,comm="], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) return undefined;
    const identity = result.stdout.toString().trim();
    if (!identity) return undefined;
    return new Bun.CryptoHasher("sha256").update(identity).digest("hex");
  } catch {
    return undefined;
  }
}

function defaultRunner(executable: string): CommandRunner {
  return async (argv) => {
    const child = Bun.spawn([executable, ...argv], { stdout: "pipe", stderr: "pipe" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { child.kill(); reject(new Error(`orca command timed out after ${MAX_COMMAND_MS}ms`)); }, MAX_COMMAND_MS);
      });
      const [stdout, stderr, status] = await Promise.race([result, timeout]);
      return { stdout, stderr, status };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

const RECORD_FILE = "terminal-recovery.json";

function recordPath(stateDir: string): string {
  return join(stateDir, RECORD_FILE);
}

function readLaunchRecords(stateDir: string): RecordedTerminalLaunch[] {
  if (!stateDir || !existsSync(recordPath(stateDir))) return [];
  try {
    const value: unknown = JSON.parse(readFileSync(recordPath(stateDir), "utf8"));
    return Array.isArray(value) ? value.filter((item): item is RecordedTerminalLaunch => {
      const row = object(item);
      return typeof row.peer === "string" && typeof row.projectRoot === "string" && typeof row.instanceId === "string" && typeof row.handle === "string" && typeof row.incarnationId === "string" && typeof row.worktreeId === "string" && typeof row.launcherPid === "number" && typeof row.launcherSignature === "string" && row.launcherSignature.length > 0 && typeof row.launchId === "string" && row.launchId.length > 0;
    }) : [];
  } catch {
    return [];
  }
}

function writeLaunchRecords(stateDir: string, rows: RecordedTerminalLaunch[]): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(recordPath(stateDir), `${JSON.stringify(rows)}\n`, { mode: 0o600 });
}

async function launcherMatches(row: RecordedTerminalLaunch, identity: ProcessIdentity): Promise<boolean> {
  try {
    const signature = await identity(row.launcherPid);
    return typeof signature === "string" && signature.length > 0 && signature === row.launcherSignature;
  } catch {
    return false;
  }
}

async function liveRecords(stateDir: string, projectRoot: string, instanceId: string, identity: ProcessIdentity): Promise<RecordedTerminalLaunch[]> {
  if (!stateDir || !instanceId) return [];
  const candidates = readLaunchRecords(stateDir).filter((item) => item.projectRoot === projectRoot && item.instanceId === instanceId);
  const checks = await Promise.all(candidates.map(async (item) => await launcherMatches(item, identity) ? item : undefined));
  return checks.filter((item): item is RecordedTerminalLaunch => item !== undefined);
}

/**
 * Capture the Orca terminal handed to an ahub launcher. This is the authenticated
 * identity source for legacy Orca payloads that omit agent/session metadata.
 */
export async function recordTerminalLaunch(peer: TerminalPeer, projectRoot: string, stateDir: string, instanceId: string, options?: CommandRunner | TerminalRecoveryOptions): Promise<RecordedTerminalLaunch | undefined> {
  const config = normalizeOptions(options);
  const handle = process.env.ORCA_TERMINAL_HANDLE;
  const worktreeIdFromEnv = process.env.ORCA_WORKTREE_ID;
  if (!handle || !worktreeIdFromEnv) return undefined;
  const value = await run(config.runner, ["terminal", "show", "--terminal", handle, "--json"]);
  const terminal = terminalObject(value);
  const actualRoot = nestedString(terminal, ["worktreePath", "projectRoot"]);
  const actualHandle = nestedString(terminal, ["handle"]);
  const actualWorktree = nestedString(terminal, ["worktreeId"]);
  const incarnationId = nestedString(terminal, ["incarnationId"]);
  if (actualHandle !== handle || !actualRoot || !rootMatches(actualRoot, projectRoot) || actualWorktree !== worktreeIdFromEnv || !incarnationId) {
    throw new OrcaCommandError(blocker("project-root-mismatch", "Orca launch terminal failed canonical root/worktree readback", peer, handle));
  }
  const launcherSignature = await config.processIdentity(process.pid);
  if (!launcherSignature) throw new OrcaCommandError(blocker("command-error", "cannot prove launcher process identity; refusing to record terminal", peer, handle));
  const launchId = randomUUID();
  process.env.AGENTHUB_LAUNCH_ID = launchId;
  process.env.AGENTHUB_INSTANCE_ID = instanceId;
  const row: RecordedTerminalLaunch = { peer, projectRoot, stateDir, instanceId, launcherPid: process.pid, launcherSignature, launchId, handle, incarnationId, worktreeId: actualWorktree, env: allowedEnv({ env: process.env }) };
  const rows = readLaunchRecords(stateDir).filter((item) => !(item.peer === peer && item.instanceId === instanceId));
  rows.push(row);
  writeLaunchRecords(stateDir, rows);
  return row;
}

function rootMatches(actual: unknown, expected: string): boolean {
  return typeof actual === "string" && actual === expected;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function responseResult(value: unknown): Record<string, unknown> {
  const root = object(value);
  return object(root.result ?? root);
}

function terminalObject(value: unknown): Record<string, unknown> {
  const root = responseResult(value);
  return object(root.terminal ?? root);
}

function nestedString(source: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const direct = source[name];
    if (typeof direct === "string" && direct.length > 0) return direct;
  }
  return undefined;
}

function sessionFrom(terminal: Record<string, unknown>): string | undefined {
  const wait = object(terminal.agentWait);
  const session = object(terminal.session);
  return nestedString(terminal, ["sessionId", "agentSessionId", "resumeSessionId"]) ?? nestedString(wait, ["sessionId", "agentSessionId", "resumeSessionId", "session", "agentSession"]) ?? nestedString(session, ["id", "sessionId"]);
}

function identityFrom(terminal: Record<string, unknown>): TerminalPeer | undefined {
  const wait = object(terminal.agentWait);
  const session = object(terminal.session);
  const candidates = [terminal.agentIdentity, terminal.agent, wait.agentIdentity, wait.agent, session.agentIdentity, session.agent];
  for (const candidate of candidates) {
    if (candidate === "codex" || candidate === "claude" || candidate === "pi") return candidate;
  }
  return undefined;
}

function allowedEnv(terminal: Record<string, unknown>): Partial<Record<AllowedEnvName, string>> {
  const env: Partial<Record<AllowedEnvName, string>> = {};
  const candidates = [terminal.env, terminal.environment, terminal.launchEnv, object(terminal.launch).env];
  for (const candidate of candidates) {
    const source = object(candidate);
    for (const name of ALLOWED_ENV) {
      if (env[name] === undefined && typeof source[name] === "string") env[name] = source[name] as string;
    }
  }
  return env;
}

function listTerminals(value: unknown): Record<string, unknown>[] {
  const root = responseResult(value);
  const list = root.terminals ?? root.items;
  return Array.isArray(list) ? list.map(object) : [];
}

function requireAbsoluteEntrypoint(value: string): string {
  if (!isAbsolute(value)) throw new Error(`package entrypoint must be absolute: ${value}`);
  return value;
}

function launchFor(peer: TerminalPeer, projectRoot: string, sessionId: string, options: Required<TerminalRecoveryOptions>, source: Record<string, unknown>, recorded?: RecordedTerminalLaunch, ref?: SessionRef): LaunchMetadata {
  const packageEntrypoint = requireAbsoluteEntrypoint(options.packageEntrypoint);
  const argv = peer === "codex"
    ? ["bun", packageEntrypoint, "--project", projectRoot, "codex", "resume", sessionId]
    : peer === "claude"
      ? ["bun", packageEntrypoint, "--project", projectRoot, "claude", "--resume", sessionId]
      : ["bun", packageEntrypoint, "--project", projectRoot, "pi", "--mode", "tui", ...(ref?.backend ? ["--backend", ref.backend] : []), ...(ref?.model ? ["--model", ref.model] : []), ...(ref?.sessionFile ? ["--session-file", ref.sessionFile] : ["--session-id", sessionId])];
  const env = { ...allowedEnv(source), ...(recorded?.env ?? {}) };
  const prefix = ALLOWED_ENV.filter((name) => env[name] !== undefined).map((name) => `${name}=${shellQuote(env[name]!)}`);
  const command = [...prefix, ...argv.map(shellQuote)].join(" ");
  return { packageEntrypoint, command, argv, env };
}

function blocker(code: RecoveryBlocker["code"], message: string, peer?: TerminalPeer, handle?: string): RecoveryBlocker {
  const nextAction = code === "missing-session" ? "reconnect the original native session and rerun recovery" :
    code === "ownership-unknown" ? "confirm the terminal owner in Orca, then resume recovery" :
    code === "ambiguous-terminal" ? "close or identify the duplicate terminal, then resume recovery" :
    code === "ambiguous-create" ? "inspect the existing terminal and attach the original session before resuming" :
    code === "terminal-unready" ? "finish or cancel the active terminal turn, then resume recovery" :
    "inspect the named terminal and resume recovery after the identity is verified";
  return { code, message, ...(peer ? { peer } : {}), ...(handle ? { handle, terminalReference: handle } : {}), nextAction };
}

function verifyBindingData(actual: Record<string, unknown>, binding: TerminalBinding): RecoveryBlocker | undefined {
  const handle = nestedString(actual, ["handle"]);
  const incarnation = nestedString(actual, ["incarnationId"]);
  const root = nestedString(actual, ["worktreePath", "projectRoot"]);
  const worktree = nestedString(actual, ["worktreeId"]);
  if (handle !== binding.handle || incarnation !== binding.incarnationId || worktree !== binding.worktreeId) return blocker("stale-terminal", "captured terminal identity changed; refusing to mutate it", binding.peer, binding.handle);
  if (!rootMatches(root, binding.projectRoot)) return blocker("project-root-mismatch", "terminal belongs to a different project root; refusing to mutate it", binding.peer, binding.handle);
  return undefined;
}

async function showBinding(binding: TerminalBinding, options: Required<TerminalRecoveryOptions>): Promise<Record<string, unknown>> {
  const value = await run(options.runner, ["terminal", "show", "--terminal", binding.handle, "--json"]);
  const actual = terminalObject(value);
  const issue = verifyBindingData(actual, binding);
  if (issue) throw new OrcaCommandError(issue);
  return actual;
}

/**
 * Read Orca's authoritative terminal inventory and bind only exact agent/session identities.
 * Titles, previews, pty ids and process names are deliberately never used as identity.
 */
export async function inspectTerminals(projectRoot: string, sessions: Partial<Record<TerminalPeer, string | SessionRef>>, options?: CommandRunner | TerminalRecoveryOptions): Promise<TerminalInspection> {
  const config = normalizeOptions(options);
  const records = await liveRecords(config.stateDir, projectRoot, config.instanceId, config.processIdentity);
  const blockers: RecoveryBlocker[] = [];
  const bindings: TerminalBinding[] = [];
  const byPeer: Partial<Record<TerminalPeer, TerminalBinding>> = {};
  const requested = (Object.entries(sessions) as [TerminalPeer, string | SessionRef | undefined][]).map(([peer, value]) => [peer, typeof value === "string" ? { sessionId: value } : value] as const).filter((entry): entry is [TerminalPeer, SessionRef] => !!entry[1]?.sessionId);
  if (!requested.length) return { bindings, byPeer, blockers, manualRequired: false };

  let listed: Record<string, unknown>[];
  try {
    listed = listTerminals(await run(config.runner, ["terminal", "list", "--json"]));
  } catch (error) {
    const commandBlocker = error instanceof OrcaCommandError ? error.blocker : blocker("command-error", String(error));
    return { bindings, byPeer, blockers: [commandBlocker], manualRequired: true };
  }

  for (const [peer, ref] of requested) {
    const sessionId = ref.sessionId;
    const candidates = listed.filter((terminal) => rootMatches(terminal.worktreePath ?? terminal.projectRoot, projectRoot));
    const peerCandidates: Record<string, unknown>[] = [];
    for (const listedTerminal of candidates) {
      const handle = nestedString(listedTerminal, ["handle"]);
      if (!handle) continue;
      let terminal: Record<string, unknown>;
      try {
        terminal = terminalObject(await run(config.runner, ["terminal", "show", "--terminal", handle, "--json"]));
      } catch (error) {
        blockers.push(error instanceof OrcaCommandError ? { ...error.blocker, peer, handle } : blocker("command-error", String(error), peer, handle));
        continue;
      }
      // A show readback is required; list can be stale between recovery steps.
      if (!rootMatches(terminal.worktreePath ?? terminal.projectRoot, projectRoot)) continue;
      const identity = identityFrom(terminal);
      const terminalSession = sessionFrom(terminal);
      const recorded = records.find((item) => item.peer === peer && item.handle === handle && item.worktreeId === terminal.worktreeId && item.incarnationId === terminal.incarnationId);
      // A recorded launcher proves ownership; the daemon's supplied session id is the
      // authoritative session id when Orca omits it from terminal metadata.
      if ((identity === peer && terminalSession === sessionId) || (recorded !== undefined && (identity === undefined || identity === peer) && (terminalSession === undefined || terminalSession === sessionId))) peerCandidates.push(terminal);
    }
    if (!peerCandidates.length) {
      const ownershipUnknown = candidates.some((terminal) => identityFrom(terminal) === undefined && !records.some((item) => item.handle === terminal.handle));
      blockers.push(ownershipUnknown
        ? blocker("ownership-unknown", `cannot prove ${peer} terminal ownership from Orca metadata`, peer)
        : blocker("missing-terminal", `no ${peer} terminal with session ${sessionId} in ${projectRoot}`, peer));
      continue;
    }
    if (peerCandidates.length > 1) {
      blockers.push(blocker("ambiguous-terminal", `multiple ${peer} terminals match session ${sessionId}; refusing to choose`, peer));
      continue;
    }
    const terminal = peerCandidates[0]!;
    const handle = nestedString(terminal, ["handle"]);
    const incarnationId = nestedString(terminal, ["incarnationId"]);
    const worktreeId = nestedString(terminal, ["worktreeId"]);
    if (!handle || !incarnationId || !worktreeId) {
      blockers.push(blocker("stale-terminal", `terminal metadata lacks a stable handle, incarnation or worktree id`, peer, handle));
      continue;
    }
    if (terminal.orphaned === true || terminal.connected === false) {
      blockers.push(blocker("terminal-unready", `terminal ${handle} is orphaned or disconnected`, peer, handle));
      continue;
    }
    const recorded = records.find((item) => item.peer === peer && item.handle === handle && item.worktreeId === terminal.worktreeId && item.incarnationId === terminal.incarnationId);
    const sessionFile = peer === "pi" ? nestedString(terminal, ["sessionFile", "sessionPath"]) ?? nestedString(object(terminal.session), ["file", "path"]) : undefined;
    const launch = launchFor(peer, projectRoot, sessionId, config, terminal, recorded, { ...ref, ...(sessionFile ? { sessionFile } : {}) });
    const binding: TerminalBinding = { peer, handle, incarnationId, worktreeId, projectRoot, sessionId, ...(sessionFile ? { sessionFile } : {}), ...(ref.backend ? { backend: ref.backend } : {}), ...(ref.model ? { model: ref.model } : {}), launch, launchMetadata: launch };
    bindings.push(binding);
    byPeer[peer] = binding;
  }
  return { bindings, byPeer, blockers, manualRequired: blockers.length > 0 };
}

/** Wait only on the captured terminal and only for Orca's supported TUI-idle condition. */
export async function waitForIdle(binding: TerminalBinding, timeoutMs: number, options?: CommandRunner | TerminalRecoveryOptions): Promise<IdleResult> {
  const config = normalizeOptions(options);
  const timeout = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? Math.min(Math.floor(timeoutMs), MAX_WAIT_MS) : 0;
  try {
    await showBinding(binding, config);
    const value = await run(config.runner, ["terminal", "wait", "--terminal", binding.handle, "--for", "tui-idle", "--timeout-ms", String(timeout), "--json"]);
    const root = responseResult(value);
    const wait = object(root.wait);
    const satisfied = root.satisfied === true || wait.satisfied === true;
    const blockers = satisfied ? [] : [blocker("terminal-unready", `terminal ${binding.handle} did not become idle before the bounded wait`, binding.peer, binding.handle)];
    return { satisfied, manualRequired: !satisfied, blockers };
  } catch (error) {
    const item = error instanceof OrcaCommandError ? error.blocker : blocker("command-error", String(error), binding.peer, binding.handle);
    return { satisfied: false, manualRequired: true, blockers: [item] };
  }
}

function restoration(peer: TerminalPeer, oldHandle: string, blockers: RecoveryBlocker[]): RestorationResult {
  return { status: "manual-required", manualRequired: true, peer, oldHandle, blockers };
}

function closeFailure(binding: TerminalBinding, blockers: RecoveryBlocker[]): TerminalCloseResult {
  return { closed: false, manualRequired: true, binding, blockers };
}

/** Quiesce and close exactly the captured terminal. This is a separately journalable effect. */
export async function closeTerminal(binding: TerminalBinding, timeoutMs = 600_000, options?: CommandRunner | TerminalRecoveryOptions): Promise<TerminalCloseResult> {
  const config = normalizeOptions(options);
  // The coordinator passes zero after its explicit quiesce/wait step. The show
  // readback below still proves the captured identity before the close mutation.
  const idle = timeoutMs === 0 ? { satisfied: true, manualRequired: false, blockers: [] as RecoveryBlocker[] } : await waitForIdle(binding, timeoutMs, config);
  if (!idle.satisfied) return closeFailure(binding, idle.blockers);
  try {
    await showBinding(binding, config);
    await run(config.runner, ["terminal", "close", "--terminal", binding.handle, "--json"]);
    const afterClose = listTerminals(await run(config.runner, ["terminal", "list", "--json"]));
    const stillThere = afterClose.some((terminal) => terminal.handle === binding.handle || terminal.incarnationId === binding.incarnationId);
    if (stillThere) return closeFailure(binding, [blocker("ambiguous-create", `close of terminal ${binding.handle} was not confirmed`, binding.peer, binding.handle)]);
    return { closed: true, manualRequired: false, binding, blockers: [] };
  } catch (error) {
    return closeFailure(binding, [error instanceof OrcaCommandError ? error.blocker : blocker("command-error", String(error), binding.peer, binding.handle)]);
  }
}

/** Create a replacement in the captured worktree, then prove TUI readiness and session mapping. */
export async function createTerminal(binding: TerminalBinding, options?: CommandRunner | TerminalRecoveryOptions, timeoutMs = 600_000): Promise<TerminalCreateResult> {
  const config = normalizeOptions(options);
  try {
    const worktreeSelector = binding.worktreeId.startsWith("id:") ? binding.worktreeId : `id:${binding.worktreeId}`;
    // A lost create reply is an uncertain effect. Before issuing another create,
    // reconcile terminals already present in the captured worktree. An exact
    // session match is safe to adopt; any other occupant requires an operator
    // decision rather than risking a duplicate native session.
    const existing = listTerminals(await run(config.runner, ["terminal", "list", "--json"])).filter((terminal) =>
      rootMatches(terminal.worktreePath ?? terminal.projectRoot, binding.projectRoot) &&
      nestedString(terminal, ["worktreeId"]) === binding.worktreeId,
    );
    if (existing.length > 0) {
      const matches: TerminalBinding[] = [];
      for (const listed of existing) {
        const handle = nestedString(listed, ["handle"]);
        if (!handle) continue;
        try {
          const shown = terminalObject(await run(config.runner, ["terminal", "show", "--terminal", handle, "--json"]));
          if (identityFrom(shown) === binding.peer && sessionFrom(shown) === binding.sessionId) {
            const incarnationId = nestedString(shown, ["incarnationId"]);
            const worktreeId = nestedString(shown, ["worktreeId"]);
            if (incarnationId && worktreeId) matches.push({ ...binding, handle, incarnationId, worktreeId });
          }
        } catch { /* An unreadable candidate remains an ambiguity below. */ }
      }
      if (matches.length === 1) {
        const recovered = matches[0]!;
        const idle = await waitForIdle(recovered, timeoutMs, config);
        if (!idle.satisfied) return { created: false, ready: false, manualRequired: true, blockers: idle.blockers };
        return { created: true, ready: true, manualRequired: false, binding: recovered, newBinding: recovered, blockers: [] };
      }
      return { created: false, ready: false, manualRequired: true, blockers: [blocker("ambiguous-create", `an existing terminal in worktree ${binding.worktreeId} may be the result of an earlier create; refusing another create`, binding.peer)] };
    }
    const value = await run(config.runner, ["terminal", "create", "--worktree", worktreeSelector, "--command", binding.launch.command, "--title", `${binding.peer} recovery`, "--json"]);
    let created = terminalObject(value);
    const createdHandle = nestedString(created, ["handle"]);
    if (!createdHandle) return { created: false, ready: false, manualRequired: true, blockers: [blocker("ambiguous-create", "Orca create returned no terminal handle", binding.peer)] };
    const incarnationId = nestedString(created, ["incarnationId"]);
    const worktreeId = nestedString(created, ["worktreeId"]) ?? binding.worktreeId;
    if (!incarnationId) {
      const listed = listTerminals(await run(config.runner, ["terminal", "list", "--json"])).filter((terminal) => terminal.handle === createdHandle);
      if (listed.length !== 1) return { created: false, ready: false, manualRequired: true, blockers: [blocker("ambiguous-create", `created terminal ${createdHandle} lacks stable identity`, binding.peer, createdHandle)] };
      created = listed[0]!;
    }
    const replacement: TerminalBinding = { ...binding, handle: createdHandle, incarnationId: nestedString(created, ["incarnationId"])!, worktreeId, launch: binding.launch, launchMetadata: binding.launch };
    const idle = await waitForIdle(replacement, timeoutMs, config);
    if (!idle.satisfied) return { created: true, ready: false, manualRequired: true, blockers: idle.blockers };
    const shown = await showBinding(replacement, config);
    const identity = identityFrom(shown);
    const session = sessionFrom(shown);
    const possibleRecords = readLaunchRecords(config.stateDir).filter((item) => item.instanceId === config.instanceId && item.peer === binding.peer && item.projectRoot === binding.projectRoot && item.handle === createdHandle && item.worktreeId === replacement.worktreeId && item.incarnationId === replacement.incarnationId);
    const recorded = (await Promise.all(possibleRecords.map(async (item) => await launcherMatches(item, config.processIdentity) ? item : undefined))).find((item): item is RecordedTerminalLaunch => item !== undefined);
    if ((identity !== binding.peer || session !== binding.sessionId) && !(recorded && (identity === undefined || identity === binding.peer) && (session === undefined || session === binding.sessionId))) {
      return { created: true, ready: true, manualRequired: true, blockers: [blocker("ambiguous-create", `created terminal ${createdHandle} cannot be mapped to the original ${binding.peer} session`, binding.peer, createdHandle)] };
    }
    return { created: true, ready: true, manualRequired: false, binding: replacement, newBinding: replacement, blockers: [] };
  } catch (error) {
    return { created: false, ready: false, manualRequired: true, blockers: [error instanceof OrcaCommandError ? error.blocker : blocker("command-error", String(error), binding.peer, binding.handle)] };
  }
}

/**
 * Close one verified terminal and recreate it in the same Orca worktree. Every mutation is
 * preceded by a show readback and no ambiguous close/create outcome is retried.
 */
export async function restoreTerminal(binding: TerminalBinding, timeoutMs = 600_000, options?: CommandRunner | TerminalRecoveryOptions): Promise<RestorationResult> {
  const closed = await closeTerminal(binding, timeoutMs, options);
  if (!closed.closed) return restoration(binding.peer, binding.handle, closed.blockers);
  const created = await createTerminal(binding, options, timeoutMs);
  if (!created.binding) return restoration(binding.peer, binding.handle, created.blockers);
  return { status: "restored", manualRequired: false, peer: binding.peer, oldHandle: binding.handle, newBinding: created.binding, blockers: [] };
}
