import { claudePeer as defaultChannelPeer } from "../hub/claude-state.ts";
// Launchers inject only the flags the hub owns and refuse user-supplied duplicates.
import { claudeStateFile } from "../hub/claude-state.ts";
import { mkdirSync, writeFileSync, renameSync, unlinkSync, lstatSync, readFileSync, openSync, closeSync, readSync, accessSync, constants, linkSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { resolve, join, basename, dirname, isAbsolute } from "node:path";
import { processLiveness, processSignature } from "../pi/process-signature.ts";
import { realPath } from "../hub/project.ts";
import { peerChildEnv, processTable } from "../hub/child-process.ts";
import { definitionOf } from "../adapters/registry.ts";
import type { InstancesConfig } from "../hub/instances.ts";
import { kimiAcpCommand } from "../adapters/definitions/native-daemon-kimi.ts";
export const CLAUDE_CHANNEL = "plugin:agent-hub@agent-hub";

export { retainedLaunchWarning } from "../adapters/definitions/native-cli-retained.ts";

/** Consume only ahub's selector, never native arguments after the passthrough delimiter. */
export function instanceLaunchArguments(command: string, raw: readonly string[], instances?: InstancesConfig): { instance?: string; args: string[]; hubStarted?: true } {
  if (!definitionOf(command)) return { args: [...raw] };
  const args: string[] = [];
  let instance: string | undefined, hubStarted = false;
  for (let index = 0; index < raw.length; index++) {
    const arg = raw[index]!;
    if (arg === "--") { args.push(...raw.slice(index)); break; }
    if (arg !== "--as" && !arg.startsWith("--as=")) { args.push(arg); continue; }
    if (instance !== undefined) throw new Error("--as may appear only once");
    const id = arg === "--as" ? raw[++index] : arg.slice("--as=".length);
    if (!id || id.startsWith("--")) throw new Error("--as needs a declared instance id");
    const declaration = instances && Object.hasOwn(instances, id) ? instances[id] : undefined;
    if (!declaration || declaration.kind !== command || !definitionOf(id, instances)) throw new Error("--as must name a declared instance of this command's native kind");
    // #223: a headless reviewer is started by the hub, never from this terminal.
    hubStarted = definitionOf(id, instances) === definitionOf(command)?.reviewerVariant;
    instance = id;
  }
  if (hubStarted && args.some(arg => arg !== "--print-command" && arg !== "--dry-run")) throw new Error(`${instance} is a headless reviewer the hub runs per review: ahub ${command} --as ${instance} takes no launch arguments`);
  return { ...(instance ? { instance } : {}), args, ...(hubStarted ? { hubStarted: true as const } : {}) };
}

/** The running daemon bound this instance at startup; a declaration added later, or an older daemon, is not proof. */
export function requireActiveInstance(status: unknown, instance: string): void {
  const active = (status as { activeInstances?: unknown } | undefined)?.activeInstances;
  if (!Array.isArray(active)) throw new Error("running hub does not report its declared instances; upgrade it before starting an extra instance");
  if (!active.includes(instance)) throw new Error(`running hub has not loaded the declaration of ${instance}; restart the hub (ahub restart) after declaring it`);
}

/** Only an authenticated daemon hello can authorize extra-instance effects. */
export function requirePeerInstances(features: unknown): void {
  if (!Array.isArray(features) || !features.includes("peer_instances")) throw new Error("running hub lacks peer_instances; upgrade it before starting an extra instance");
}

/** Launch identity belongs to the native child, never to the agent that invoked the wrapper. */
export function nativeLaunchEnv(tool: string, source: NodeJS.ProcessEnv, instances?: InstancesConfig): NodeJS.ProcessEnv {
  const env = peerChildEnv(tool, source);
  delete env.AGENTHUB_UNATTENDED;
  // Channel evidence for the plugin (issue #205): set beside the development-channel flag `buildLaunch` always passes.
  const definition = definitionOf(tool, instances);
  if (definition?.identity.mcp === "channel-plugin" && !definition.attach?.pullOnlyForms?.includes("tui")) env.AGENTHUB_CHANNEL = "1";
  if (definition?.attach?.pullOnlyForms?.includes("tui")) delete env.AGENTHUB_MODE; // its MCP child must attach pull-only, never as a tools socket
  return env;
}

export const UNATTENDED_WARNING =
  "WARNING: --unattended disables permission prompts. Other agents' messages are untrusted input and this agent will act on its own judgment without asking you.";

export interface Launch {
  cmd: string;
  args: string[];
  warning?: string;
  permissionHook?: boolean;
  hookPurpose?: FactsHook["purpose"];
  settingsFile?: string;
  unattended?: boolean;
}

/** Retire only our prior private Claude settings file, after the replacement launch record is committed. */
export function cleanupClaudeSettings(stateDir: string, previous: unknown): void {
  if (typeof previous !== "string" || !isAbsolute(previous) || !/^claude-settings-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/.test(basename(previous))) return;
  try {
    const root = realPath(stateDir);
    if (realPath(dirname(previous)) !== root) return;
    const stat = lstatSync(previous);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || !process.getuid || stat.uid !== process.getuid()) return;
    if (realPath(previous) !== join(root, basename(previous))) return;
    unlinkSync(previous);
  } catch { /* Missing or unverifiable files remain untouched. */ }
}

/** Crash fallback only: an absent/unreadable owner identity never certifies that its native launch ended. */
export function cleanupStaleClaudeSettings(stateDir: string, previous: unknown, identity = processSignature): void {
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) return;
  const original = previous as Record<string, unknown>;
  const record = readClaudeNative(stateDir, original as ClaudeLaunchRecord) ?? original;
  if (typeof record.launcherSignature !== "string" || !record.launcherSignature) return;
  if (processLiveness(record.launcherPid, record.launcherSignature, identity) !== "gone") return;
  if (typeof record.nativePid !== "number" || !Number.isSafeInteger(record.nativePid) || record.nativePid <= 0 || record.nativePid === record.launcherPid || typeof record.nativeSignature !== "string" || !record.nativeSignature) return;
  if (record.nativeIdentity === "direct-child") {
    // A direct child may exec in place. A changed signature while its PID still runs cannot certify native exit.
    // The shared table excludes exited zombies; an unavailable table certifies nothing.
    const table = processTable();
    if (!table || table.some(row => row.pid === record.nativePid)) return;
  } else if (processLiveness(record.nativePid, record.nativeSignature, identity) !== "gone") return;
  cleanupClaudeSettings(stateDir, record.settingsFile);
  removeClaudeNative(stateDir, original as ClaudeLaunchRecord);
}

export interface ClaudeLaunchRecord extends Record<string, unknown> {
  instanceId: string; launchId: string; settingsFile?: string; launcherPid: number; launcherSignature?: string;
  /** A claude-<name> instance (#450 I3); absent for the builtin claude peer, whose file keeps its original name. */
  peer?: string;
  /** Validated terminal instance root; absent for legacy/canonical launches. */
  executionCwd?: string;
}

export interface ClaudeLaunchPublication { recorded: boolean; warning?: string; }

/** Native attestation alone is serialized; managed hook metadata never waits on this lock. */
async function withClaudeLaunchRecord(stateDir: string, action: () => void): Promise<ClaudeLaunchPublication> {
  const lock = join(stateDir, "claude-launch.lock"), temp = `${lock}.${randomUUID()}.tmp`;
  const skipped = (reason = `${lock} is busy or unverified`): ClaudeLaunchPublication => ({ recorded: false, warning: `Native identity and crash cleanup disabled for this launch; managed hook record stays current. ${reason}; inspect ${lock} and verify its owner has ended before removing it.` });
  const signature = processSignature(process.pid);
  if (!signature) return skipped("launcher identity could not be verified");
  let locked = false, tempCreated = false, own: { dev: number; ino: number } | undefined;
  try {
    const fd = openSync(temp, "wx", 0o600); tempCreated = true;
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, signature })); } finally { closeSync(fd); }
    const stat = lstatSync(temp); own = { dev: stat.dev, ino: stat.ino };
    const deadline = performance.now() + 250;
    for (;;) {
      try { linkSync(temp, lock); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return skipped();
        let before;
        try { before = lstatSync(lock); } catch { if (performance.now() < deadline) continue; return skipped(); }
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || !process.getuid || before.uid !== process.getuid()) return skipped();
        let owner: { pid?: unknown; signature?: unknown };
        try { owner = JSON.parse(readFileSync(lock, "utf8")); } catch { return skipped(); }
        if (!owner || typeof owner.signature !== "string" || !owner.signature) return skipped();
        const alive = processLiveness(owner.pid, owner.signature);
        if (alive === "unknown") return skipped();
        if (alive === "live") {
          if (performance.now() >= deadline) return skipped();
          await new Promise(resolve => setTimeout(resolve, 25)); continue;
        }
        const current = lstatSync(lock);
        if (current.dev !== before.dev || current.ino !== before.ino) return skipped();
        unlinkSync(lock);
      }
    }
    locked = true;
    unlinkSync(temp);
    try { action(); } catch { return skipped("native attestation publication failed"); }
    return { recorded: true };
  } catch { return skipped("native attestation lock could not be read or published"); }
  finally {
    if (locked && own) {
      try { const current = lstatSync(lock); if (current.dev === own.dev && current.ino === own.ino) unlinkSync(lock); }
      catch { /* only our verified lock may be removed */ }
    }
    if (tempCreated) { try { unlinkSync(temp); } catch { /* our populated temp may already be linked and consumed */ } }
  }
}

function writeClaudeLaunchRecord(stateDir: string, record: Record<string, unknown>): void {
  const file = join(stateDir, claudeStateFile("claude-launch", typeof record.peer === "string" ? record.peer : defaultChannelPeer(undefined))), temp = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(record), { mode: 0o600 }); renameSync(temp, file); }
  finally { try { unlinkSync(temp); } catch { /* the rename normally consumed it */ } }
}

export function recordClaudeLaunch(stateDir: string, record: ClaudeLaunchRecord): ClaudeLaunchPublication {
  writeClaudeLaunchRecord(stateDir, record);
  return { recorded: true };
}

function sameClaudeLaunch(left: ClaudeLaunchRecord, right: ClaudeLaunchRecord): boolean {
  return left.instanceId === right.instanceId && left.launchId === right.launchId && left.settingsFile === right.settingsFile
    && left.launcherPid === right.launcherPid && left.launcherSignature === right.launcherSignature && left.executionCwd === right.executionCwd;
}
function nativeAttestationPath(stateDir: string, launch: ClaudeLaunchRecord): string {
  const hash = createHash("sha256").update(JSON.stringify([launch.instanceId, launch.launchId, launch.settingsFile, launch.launcherPid, launch.launcherSignature, ...(launch.executionCwd ? [launch.executionCwd] : [])])).digest("hex");
  return join(stateDir, `claude-native-${hash}.json`);
}
function privateClaudeNative(stateDir: string, launch: ClaudeLaunchRecord): { file: string; stat: ReturnType<typeof lstatSync>; record: ClaudeLaunchRecord } | undefined {
  const file = nativeAttestationPath(stateDir, launch);
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || !process.getuid || stat.uid !== process.getuid()) return;
    const record = JSON.parse(readFileSync(file, "utf8")) as ClaudeLaunchRecord;
    if (!record || !sameClaudeLaunch(record, launch) || typeof record.nativePid !== "number" || !Number.isSafeInteger(record.nativePid) || record.nativePid <= 0 || typeof record.nativeSignature !== "string" || !record.nativeSignature || record.nativeIdentity !== "direct-child") return;
    return { file, stat, record };
  } catch { return; }
}
export function readClaudeNative(stateDir: string, launch: ClaudeLaunchRecord): ClaudeLaunchRecord | undefined {
  return privateClaudeNative(stateDir, launch)?.record;
}
function removeClaudeNative(stateDir: string, launch: ClaudeLaunchRecord): void {
  const saved = privateClaudeNative(stateDir, launch); if (!saved?.stat) return;
  try { const now = lstatSync(saved.file); if (now.dev === saved.stat.dev && now.ino === saved.stat.ino) unlinkSync(saved.file); }
  catch { /* absent or replaced native proof remains untouched */ }
}

/** Never attach an old child's identity to a replacement launch, even when its spawn callback arrives later. */
export async function recordClaudeNative(stateDir: string, launch: ClaudeLaunchRecord, pid: number, signature: string, report?: (warning: string) => void): Promise<boolean> {
  let recorded = false;
  const publication = await withClaudeLaunchRecord(stateDir, () => {
    let current: ClaudeLaunchRecord;
    try {
      const file = join(stateDir, claudeStateFile("claude-launch", launch.peer ?? defaultChannelPeer(undefined))), stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || !process.getuid || stat.uid !== process.getuid()) return;
      current = JSON.parse(readFileSync(file, "utf8"));
    } catch { return; }
    if (!sameClaudeLaunch(current, launch)) return;
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === launch.launcherPid || !signature) return;
    const file = nativeAttestationPath(stateDir, launch), temp = `${file}.${randomUUID()}.tmp`;
    try {
      lstatSync(file);
      const saved = privateClaudeNative(stateDir, launch);
      recorded = !!saved && saved.record.nativePid === pid && saved.record.nativeSignature === signature;
      return; // a launch's first native proof is immutable; an unknown file is never overwritten
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return; }
    try {
      writeFileSync(temp, JSON.stringify({ ...launch, nativePid: pid, nativeSignature: signature, nativeIdentity: "direct-child" }), { mode: 0o600, flag: "wx" });
      renameSync(temp, file);
    } finally { try { unlinkSync(temp); } catch { /* atomic rename consumed our private temporary file */ } }
    try { recorded = sameClaudeLaunch(JSON.parse(readFileSync(join(stateDir, claudeStateFile("claude-launch", launch.peer ?? defaultChannelPeer(undefined))), "utf8")), launch); } catch { /* replaced or unreadable managed record */ }
  });
  if (publication.warning) report?.(publication.warning);
  return publication.recorded && recorded;
}

/** Scripts and interpreters can leave a different native owner behind: their crash cleanup remains disabled. */
function directNativeExecutable(command: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
  const interpreter = /^(?:node|bun|deno|env|busybox|python(?:[0-9.]+)?|ruby|perl|bash|sh|zsh|fish|dash|ksh|csh|tcsh|ash)(?:\.exe)?$/;
  if (interpreter.test(basename(command))) return false;
  const paths = command.includes("/") ? [resolve(cwd, command)] : (env.PATH ?? "").split(":").filter(Boolean).map(path => resolve(cwd, path, command));
  for (const path of paths) {
    let fd: number | undefined;
    try {
      const target = realPath(path);
      accessSync(target, constants.X_OK);
      if (interpreter.test(basename(target))) return false;
      fd = openSync(target, "r");
      const bytes = Buffer.alloc(4); if (readSync(fd, bytes, 0, 4, 0) !== 4) return false;
      return ["7f454c46", "feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(bytes.toString("hex"));
    } catch { /* resolve the next PATH entry */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return false;
}

/** Same native stdio/environment and exit result as spawnSync, with a live child identity before it exits. */
export async function runClaudeLaunch(launch: Launch, options: { cwd: string; env: NodeJS.ProcessEnv; stateDir: string; record?: ClaudeLaunchRecord }): Promise<{ status: number | null; signal: NodeJS.Signals | null; error?: Error }> {
  const direct = directNativeExecutable(launch.cmd, options.cwd, options.env);
  return new Promise(resolveResult => {
    let attestation: Promise<unknown> | undefined;
    let childSignature: string | undefined;
    const child = spawn(launch.cmd, launch.args, { cwd: options.cwd, env: options.env, stdio: "inherit" });
    child.once("spawn", () => {
      if (!options.record || !child.pid) return;
      const unavailable = (reason: string) => console.error(`Native identity and crash cleanup disabled for this launch; managed hook record stays current. ${reason}.`);
      if (!direct) { unavailable("native executable is a script or an unverified interpreter"); return; }
      if (!options.record.launcherSignature) { unavailable("launcher identity could not be verified"); return; }
      const signature = processSignature(child.pid);
      if (!signature) { unavailable("native process identity could not be verified"); return; }
      childSignature = signature;
      attestation = recordClaudeNative(options.stateDir, options.record, child.pid, signature, warning => console.error(warning)).catch(() => undefined);
    });
    child.once("error", error => resolveResult({ status: null, signal: null, error }));
    child.once("exit", async (status, signal) => {
      await attestation;
      if (options.record) {
        const saved = readClaudeNative(options.stateDir, options.record);
        if (saved && typeof child.pid === "number" && saved.nativePid === child.pid && saved.nativeSignature === childSignature) removeClaudeNative(options.stateDir, options.record);
      } // this child's observed exit, after its last bounded write
      resolveResult({ status, signal });
    });
  });
}

export interface StatusLineTee {
  /** absolute path of src/cli/statusline-tee.ts */
  script: string;
  stateDir: string;
  /** the user's own statusLine setting, wrapped so the status line looks the same */
  original?: { command?: string; refreshInterval?: number; padding?: number };
}

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Settings for one session that put the tee in front of the user's status line command. Claude Code's status line
 * input carries `rate_limits`; this is the hub's Claude quota source. `~/.claude/settings.json` is never edited.
 */
export function statusLineSettings(tee: StatusLineTee): string {
  const command = `AGENTHUB_STATE_DIR=${sh(tee.stateDir)} AGENTHUB_STATUSLINE_CMD=${sh(tee.original?.command ?? "")} bun ${sh(tee.script)}`;
  return JSON.stringify({ statusLine: { type: "command", command, refreshInterval: tee.original?.refreshInterval ?? 10, ...(tee.original?.padding !== undefined ? { padding: tee.original.padding } : {}) } });
}

/** Shared facts, native observation and permission hook transport. */
export interface FactsHook {
  script: string;
  stateDir: string;
  /** The same hook transport can observe native turns without injecting facts. */
  purpose?: "facts" | "idle" | "facts-and-idle" | "permission";
  /** Observe native sessions/turns for every enabled facts, idle or conductor hook configuration. */
  observeNative?: boolean;
}

/** Shared by actual launch and preview; permissions are always enabled, advisory facts remain disabled. */
export function claudeObservationHooks(config: { coordination?: string; task_sweep?: { enabled: boolean }; roles?: Record<string, string[]> }, paths: Pick<FactsHook, "script" | "stateDir">): FactsHook {
  const facts = config.coordination === "turn-free";
  const idle = config.task_sweep?.enabled === true;
  const observeNative = facts || idle || config.roles?.claude?.includes("conductor") === true;
  return { ...paths, purpose: facts ? (idle ? "facts-and-idle" : "facts") : idle || observeNative ? "idle" : "permission", ...(observeNative ? { observeNative: true } : {}) };
}

/**
 * The one `--settings` value of a hub-launched Claude session: the status line tee, and in a turn-free project the
 * facts hook before and after every tool call and at the end of each turn (issue #108; the turn end is the quiescence
 * evidence of issue #107).
 */
export function sessionSettings(tee?: StatusLineTee, facts?: FactsHook): string {
  const settings = (tee ? JSON.parse(statusLineSettings(tee)) : {}) as Record<string, unknown>;
  if (facts) {
    const hooks = [{ type: "command", command: `AGENTHUB_STATE_DIR=${sh(facts.stateDir)} AGENTHUB_HOOK_PURPOSE=${sh(facts.purpose ?? "facts")} bun ${sh(facts.script)}`, timeout: 5 }];
    settings.hooks = { PreToolUse: [{ matcher: "*", hooks }], ...(facts.purpose !== "permission" ? { PostToolUse: [{ matcher: "*", hooks }], Stop: [{ hooks }] } : {}) };
    if (facts.observeNative) Object.assign(settings.hooks as object, { SessionStart: [{ matcher: "*", hooks }], UserPromptSubmit: [{ hooks }] });
  }
  return JSON.stringify(settings);
}

export function buildLaunch(
  tool: "claude" | "codex",
  userArgs: string[],
  ctx: { instance?: string; unattended: boolean; proxyUrl?: string; launchTokenEnv?: string; codexBin?: string; statusLine?: StatusLineTee; facts?: FactsHook; preview?: boolean },
): Launch {
  const adapter = definitionOf(tool);
  if (!adapter) throw new Error("native launch definition unavailable");
  const { metadata: _metadata, ...launch } = adapter.start.launch!({
    instance: ctx.instance ?? tool, form: "tui", projectRoot: process.cwd(), stateDir: ctx.facts?.stateDir ?? ctx.statusLine?.stateDir ?? "",
    entrypoint: resolve(import.meta.dir, "main.js"), userArgs, env: {}, ...ctx,
  });
  return launch;
}


/** The daemon and preview use exactly the same ACP command insertion. */
export function buildKimiLaunch(command: string[], model?: string): Launch {
  const [cmd, ...args] = kimiAcpCommand(command, model);
  return { cmd: cmd!, args };
}

export { buildQwenLaunch } from "../adapters/definitions/qwen-native.ts";

/** The configured ACP argv has a TUI form only when its exact final word is the ACP subcommand. */
export function buildKimiTuiLaunch(command: string[], model?: string): Launch {
  if (!command.length || command.some(word => typeof word !== "string" || !word)) throw new Error("kimi_cmd must name an executable");
  if (command.length > 1 && command.at(-1) !== "acp") throw new Error("kimi_cmd has no derivable TUI form; use a single executable or an argv ending in acp, or run ahub kimi --mode headless");
  return buildKimiLaunch(command.length > 1 ? command.slice(0, -1) : command, model);
}
