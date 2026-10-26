import { randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BasePeer, type OwnedToolsLaunch } from "../hub/peers.ts";
import { frame, type Envelope } from "../hub/envelope.ts";
import { realPath } from "../hub/project.ts";
import { IMPLEMENTER_HUB_TOOL_NAMES } from "../hub/hub-tools.ts";
import { claudeStateFile } from "../hub/claude-state.ts";
import { sessionSettings } from "../cli/launch.ts";
import { assessVersion, COMPAT } from "./compat.ts";
import { OwnedPrintChild, PrintChildCleanupError, type OwnedPrintChildOptions } from "./claude-print-child.ts";
import { ClaudeTaskSessions } from "./claude-task-sessions.ts";
import type { PermissionMode } from "../hub/permission-mode.ts";
import type { ReviewerPrintUsage } from "./reviewer-print.ts";

export interface ClaudeImplementerOptions {
  cwd: string;
  stateDir: string;
  projectRoot: string;
  instanceId: string;
  server: string;
  factsHook: string;
  systemPrompt: string;
  watchdogMs: number;
  /** Declared `model` of this instance (#844): one validated word passed as `--model`; unset leaves the native default and the argv unchanged. */
  model?: string;
  mode?: "ask" | "ask-when-needed";
  /** Exact host-reported transcript evidence only; unknown/read errors retain the recorded UUID. */
  transcriptPersisted?(task: number, sessionId: string): boolean | "unknown";
  /** Host-only lifecycle test seam, never project configuration. */
  stopChild?: OwnedPrintChildOptions["stop"];
  command?: readonly string[];
  /** Host-owned policy and board reads, never native or model-selected authority. */
  admit(env: Envelope): boolean;
  chatTask(): number | undefined;
  onUsage?(usage: ReviewerPrintUsage, task?: number): void;
  notify?(message: string): void;
  /** Test/embedding-only proof port; project configuration cannot select it. */
  prove?(): Promise<() => boolean>;
}
export interface ImplementerTurn { sessionId: string; resume: boolean; persistent: boolean }
export function claudeImplementerArgs(turn: ImplementerTurn, mcp: string, settings: string, prompt: string, model?: string): string[] {
  return ["-p", "--output-format", "stream-json", "--verbose", turn.resume ? "--resume" : "--session-id", turn.sessionId,
    ...(!turn.persistent ? ["--no-session-persistence"] : []), "--strict-mcp-config", "--mcp-config", mcp, "--setting-sources", "", "--settings", settings,
    ...(model ? ["--model", model] : []), "--permission-mode", "default", "--permission-prompts", "host", "--permission-prompt-tool", "mcp__agent-hub__hub_permission_request",
    "--allowedTools", ...IMPLEMENTER_HUB_TOOL_NAMES.map(name => `mcp__agent-hub__${name}`), "--append-system-prompt", prompt];
}

/** A receipt-backed CLI version and a per-start binary fence. Version reads use an isolated, disposable HOME.
 * ponytail: native prompt behavior is certified by the dated deterministic receipt, not re-inferred at startup;
 * the upgrade is another isolated native permission probe before extending COMPAT. */
export async function proveClaudeImplementer(peer: string, command: readonly string[]): Promise<() => boolean> {
  const binary = Bun.which(command[0]!, { PATH: process.env.PATH }) ?? command[0]!;
  const fingerprint = () => { const file = realPath(binary), stat = lstatSync(file); return [file, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"); };
  const binding = fingerprint(), home = mkdtempSync(join(tmpdir(), "ahub-claude-proof-"));
  let version = "", timedOut = false;
  const child = new OwnedPrintChild({ peer, command, args: ["--version"], cwd: home, input: "", envMode: "replace",
    env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") }, maxFrameBytes: 4096, maxOutputBytes: 4096,
    onLine: line => { version += line; }, onLimit: () => { timedOut = true; void child.stop().catch(() => {}); } });
  const timer = setTimeout(() => { timedOut = true; void child.stop().catch(() => {}); }, 3000);
  try {
    const code = await child.done;
    if (code !== 0 || timedOut) throw new Error("Claude implementer permission proof unavailable");
    const observed = COMPAT["claude-implementer"].parse(version), verdict = assessVersion("claude-implementer", observed);
    if (!verdict.ok) throw new Error(verdict.reason);
    if (fingerprint() !== binding) throw new Error("Claude implementer binary changed during proof");
    return () => { try { return fingerprint() === binding; } catch { return false; } };
  } finally { clearTimeout(timer); await child.stop(); rmSync(home, { recursive: true, force: true }); }
}

/** One owned print child at a time. Idle holds no native process; task continuity is ids-only on disk. */
export class ClaudeImplementerPeer extends BasePeer {
  readonly hubNative = true;
  private generation = 0;
  private owned: OwnedPrintChild | undefined;
  private running: Promise<void> | undefined;
  private active: OwnedToolsLaunch | undefined;
  private childAbort: AbortController | undefined;
  private abort: AbortController | undefined;
  private cleanup: (() => void) | undefined;
  private binding: (() => boolean) | undefined;
  private command: readonly string[] | undefined;
  private deliveryId: string | undefined;
  private inputReleased = false;
  private sessions: ClaudeTaskSessions;
  private stopping: Promise<void> | undefined;
  private stoppingTarget: "idle" | "offline" | undefined;
  private mode: "ask" | "ask-when-needed";
  constructor(id: string, private readonly options: ClaudeImplementerOptions) {
    super(id, options.watchdogMs);
    if (options.mode !== undefined && options.mode !== "ask" && options.mode !== "ask-when-needed") throw new Error("Claude implementer refuses unsupported permission mode");
    this.mode = options.mode ?? "ask";
    this.sessions = new ClaudeTaskSessions(join(options.stateDir, claudeStateFile("claude-task-sessions", id)));
  }
  get permissionModeState(): "ask" | "ask-when-needed" { return this.mode; }
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (mode !== "ask" && mode !== "ask-when-needed") throw new Error("Claude implementer refuses never-ask");
    this.mode = mode; // Native remains default: the host facts gate applies this choice to the current child.
  }
  get sessionGeneration(): string | undefined { return this.active?.generation; }
  ownedTools(launchId: unknown): OwnedToolsLaunch | undefined { return typeof launchId === "string" && this.active?.launchId === launchId && !this.abort?.signal.aborted ? this.active : undefined; }
  keepApprovalAlive(): void { if (this.state === "busy" && this.active) this.touch(); }
  recoveryMetadata(): Record<string, unknown> { return { launch: { kind: "claude-implementer", peer: this.id }, ...(this.active ? { sessionId: this.active.sessionId } : {}) }; }
  async start(): Promise<void> {
    if (this.owned || this.running || this.stopping) throw new Error("Claude implementer cleanup is not complete");
    if (this.state !== "offline") return;
    const generation = ++this.generation;
    const selected = this.options.command ?? ["claude"];
    const command = this.options.prove ? selected : [realPath(Bun.which(selected[0]!, { PATH: process.env.PATH }) ?? selected[0]!), ...selected.slice(1)];
    const binding = await (this.options.prove?.() ?? proveClaudeImplementer(this.id, command));
    if (generation !== this.generation) return;
    this.command = command; this.binding = binding; this.setState("idle");
  }
  async stop(reason = "Claude implementer stopped before settlement"): Promise<void> { return this.cancel(reason, "offline"); }
  protected override onWatchdog(): void { void this.cancel("Claude implementer watchdog timeout", "idle").catch(() => {}); }
  private settle(state: "completed" | "failed_safe" | "needs_review", reason?: string): void {
    const id = this.deliveryId; this.deliveryId = undefined;
    if (id) this.delivery({ id, state, ...(reason ? { reason } : {}) });
  }
  private cancel(reason: string, next: "idle" | "offline"): Promise<void> {
    if (this.stopping) {
      if (next === "offline") this.stoppingTarget = "offline";
      return this.stopping;
    }
    this.stoppingTarget = next;
    ++this.generation; this.active = undefined; this.childAbort?.abort(); this.childAbort = undefined; this.abort?.abort(); this.clearWatchdog();
    this.settle(this.inputReleased ? "needs_review" : "failed_safe", reason);
    if (this.owned || this.running) this.setState("busy");
    const work: Promise<void> = Promise.resolve().then(async () => {
      if (this.owned) await this.owned.stop(); // Retain handle/busy if group cleanup fails.
      const running = this.running;
      await running?.catch(() => {});
      if (this.running === running) this.running = undefined;
      this.cleanup?.(); this.cleanup = undefined; this.owned = undefined;
      // An idle callback can synchronously drain the next Bus delivery.
      const target = this.stoppingTarget ?? next;
      if (this.stopping === work) { this.stopping = undefined; this.stoppingTarget = undefined; }
      this.setState(target);
    });
    this.stopping = work;
    void work.finally(() => { if (this.stopping === work) { this.stopping = undefined; this.stoppingTarget = undefined; } }).catch(() => {});
    return work;
  }
  async deliver(envs: Envelope[], deliveryId?: string): Promise<void> {
    if (this.state !== "idle" || this.owned || this.running || this.stopping) throw new Error("Claude implementer is not idle");
    if (envs.some(env => env.private)) throw new Error("Claude implementer refuses private delivery");
    const groups: { task?: number; envs: Envelope[] }[] = [];
    for (const env of envs) {
      // Completion/cancellation notices and foreign task refs do not veto ordinary messages in the digest.
      if (!this.options.admit(env)) continue;
      const raw = env.refs?.task, task = raw === undefined ? this.options.chatTask() : Number(raw);
      if (task !== undefined && (!Number.isSafeInteger(task) || task <= 0)) continue;
      let group = groups.find(item => item.task === task);
      if (!group) { group = { task, envs: [] }; groups.push(group); }
      group.envs.push(env);
    }
    const generation = this.generation; this.deliveryId = deliveryId; this.inputReleased = false;
    this.abort = new AbortController(); this.setState("busy");
    if (deliveryId) this.delivery({ id: deliveryId, state: "accepted" });
    // Register the run identity before any synchronous failure can publish idle.
    const running: Promise<void> = Promise.resolve().then(() => this.run(groups, generation, running));
    this.running = running;
    void running.finally(() => { if (this.running === running) this.running = undefined; }).catch(() => {});
  }
  private async run(groups: { task?: number; envs: Envelope[] }[], generation: number, running: Promise<void>): Promise<void> {
    const current = () => generation === this.generation && !this.abort?.signal.aborted;
    try {
      for (let group of groups) {
        if (!current() || !this.binding?.()) throw new Error("Claude implementer admission changed");
        group = { ...group, envs: group.envs.filter(env => !env.private && this.options.admit(env)) };
        if (!group.envs.length) continue;
        let turn = this.sessions.session(group.task);
        if (turn.resume && group.task !== undefined) {
          let persisted: boolean | "unknown" = "unknown";
          try { persisted = this.options.transcriptPersisted?.(group.task, turn.sessionId) ?? "unknown"; } catch { /* unknown is never missing */ }
          if (persisted === false) {
            this.sessions.forgetMissing(group.task, turn.sessionId); turn = this.sessions.session(group.task);
            this.options.notify?.(`${this.id}: task #${group.task} session fresh; recorded transcript is missing`);
          }
        }
        const launchId = randomUUID(), directory = mkdtempSync(join(this.options.stateDir, "claude-child-")), settings = join(directory, "settings.json");
        this.cleanup = () => rmSync(directory, { recursive: true, force: true });
        writeFileSync(settings, sessionSettings(undefined, { script: this.options.factsHook, stateDir: this.options.stateDir, purpose: "permission" }), { mode: 0o600, flag: "wx" });
        const env = { AGENTHUB_MODE: "tools", AGENTHUB_PEER_ID: this.id, AGENTHUB_STATE_DIR: this.options.stateDir, AGENTHUB_PROJECT_DIR: this.options.projectRoot,
          AGENTHUB_INSTANCE_ID: this.options.instanceId, AGENTHUB_LAUNCH_ID: launchId, AGENTHUB_HOOK_PURPOSE: "permission", AGENTHUB_PERMISSION_TOOL: "1" };
        const mcp = JSON.stringify({ mcpServers: { "agent-hub": { command: process.execPath, args: ["run", this.options.server], env } } });
        let result = false, failed = false;
        const child = new OwnedPrintChild({ peer: this.id, command: this.command!, args: claudeImplementerArgs(turn, mcp, settings, this.options.systemPrompt, this.options.model), cwd: this.options.cwd,
          input: group.envs.map(frame).join("\n\n"), env, current, stop: this.options.stopChild,
          onSpawn: () => {
            try {
              if (!this.binding?.() || group.envs.some(env => env.private || !this.options.admit(env))) throw new Error("Claude implementer admission changed before child start");
            } catch {
              // Fence synchronously before OwnedPrintChild can release stdin; cleanup is asynchronous and owned.
              void this.cancel("Claude implementer admission changed before child start", "idle").catch(() => {});
              return;
            }
            this.inputReleased = true; // OwnedPrintChild releases stdin immediately after this synchronous admission fence.
            this.childAbort = new AbortController();
            this.active = { permissionHook: true, launchId, generation: `${generation}:${launchId}`, sessionId: turn.sessionId, signal: this.childAbort.signal, ...(group.task !== undefined ? { task: group.task } : {}) };
          },
          onLeaderExit: () => { this.active = undefined; this.childAbort?.abort(); this.childAbort = undefined; },
          onActivity: () => this.touch(),
          onLimit: () => { void this.cancel("Claude implementer output limit exceeded", "idle").catch(() => {}); },
          onFrame: event => {
            const row = event as { type?: unknown; subtype?: unknown; is_error?: unknown; usage?: ReviewerPrintUsage; session_id?: unknown } | null;
            if (row?.session_id === turn.sessionId && group.task !== undefined) {
              try { if (!this.sessions.markStarted(group.task, turn.sessionId)) throw new Error("session changed"); }
              catch { void this.cancel("Claude implementer session publication failed", "idle").catch(() => {}); return; }
            }
            if (row?.type !== "result" || result) return;
            result = true; failed = row.is_error === true || row.subtype !== "success";
            if (row.usage) this.options.onUsage?.(row.usage, group.task);
          } });
        this.owned = child;
        let code: number | null;
        try { code = await child.done; }
        catch (error) {
          // spawn ENOENT has no owned group. A started child with failed group cleanup must keep its handle.
          if (child.process.pid === undefined) this.owned = undefined;
          throw error;
        }
        this.active = undefined; this.owned = undefined;
        this.cleanup?.(); this.cleanup = undefined;
        if (!current()) return;
        if (code !== 0 || !result || failed) throw new Error("Claude implementer turn failed");
      }
      if (current()) {
        if (this.running === running) this.running = undefined;
        this.settle(this.inputReleased ? "completed" : "failed_safe", this.inputReleased ? undefined : "Claude implementer has no admissible envelopes"); this.setState("idle");
      }
    } catch (error) {
      this.active = undefined; this.childAbort?.abort(); this.childAbort = undefined;
      if (current()) {
        this.settle(this.inputReleased ? "needs_review" : "failed_safe", error instanceof PrintChildCleanupError ? "Claude implementer cleanup incomplete" : "Claude implementer turn failed");
        if (this.owned) this.setState("busy"); else {
          this.cleanup?.(); this.cleanup = undefined;
          if (this.running === running) this.running = undefined;
          this.setState("idle");
        }
      }
    }
  }
}
