import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Readable } from "node:stream";
import type { PeerState } from "../hub/envelope.ts";
import { AcpPeer, type AcpOptions } from "./acp.ts";
import { peerChildEnv, stopOwnedProcess, trackGroup } from "../hub/child-process.ts";

export interface JcodeOptions extends Omit<AcpOptions, "cmd" | "qwen025" | "expectedAgent" | "mcpServers" | "permissionMode"> {
  command: string[];
  home: string;
  providerProfile?: string;
}
export function jcodeCommand(command: string[], kind: "serve" | "acp", socket: string, cwd: string, model?: string, profile?: string): string[] {
  if (!command.length || command.some(word => typeof word !== "string" || !word)) throw new Error("jcode_cmd must name an executable argv");
  return [...command, kind, "--socket", socket, "--cwd", cwd, "--no-update", "--no-selfdev", ...(model ? ["--model", model] : []), ...(profile ? ["--provider-profile", profile] : []),
    ...(kind === "serve" ? ["--temporary-server", "--owner-pid", String(process.pid), "--server-name", "agent-hub-jcode"] : ["--mcp-tools", "eager"])];
}
export interface JcodeTuiBinding { launchId: string; sessionId: string }
export type JcodeTuiState = { state: "waiting"; binding: JcodeTuiBinding } |
  { state: "ready"; binding: JcodeTuiBinding; launch: { cmd: string; args: string[]; env: NodeJS.ProcessEnv } };

export function jcodeTuiCommand(command: string[], socket: string, sessionId: string, model?: string, profile?: string): string[] {
  if (!command.length || command.some(word => typeof word !== "string" || !word)) throw new Error("jcode_cmd must name an executable argv");
  return [...command, "--socket", socket, "--resume", sessionId, "--no-update", "--no-selfdev",
    ...(model ? ["--model", model] : []), ...(profile ? ["--provider-profile", profile] : [])];
}

/** Read native persistence only. Never synthesize a native session or send a save-inducing prompt. */
function savedSession(home: string, id: string): boolean {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("invalid native session identity");
  const directory = join(home, "sessions"), info = lstatSync(directory, { throwIfNoEntry: false });
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe native session directory");
  const file = join(directory, `${id}.json`), entry = lstatSync(file, { throwIfNoEntry: false });
  if (!entry) return false;
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("unsafe native session proof");
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  try {
    const before = fstatSync(fd);
    // ponytail: bound native persistence proof to 32 MiB; larger conversations need a native saved-session API.
    if (!before.isFile() || before.nlink !== 1 || before.size > 32 * 1024 * 1024) throw new Error("unsafe native session proof");
    if (!before.size) return false;
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) return false; offset += n; }
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return false;
    let data: unknown;
    try { data = JSON.parse(bytes.toString("utf8")); } catch { return false; }
    if (!data || typeof data !== "object" || (data as { id?: unknown }).id !== id || !Array.isArray((data as { messages?: unknown }).messages)) throw new Error("native saved session identity is unproven");
    return true;
  } finally { closeSync(fd); }
}

/** Set on every owned jcode process: no Claude MCP import, and no native telemetry (jcode-telemetry-core is_enabled, #529). */
const JCODE_OWNED_ENV = { JCODE_DISABLE_CLAUDE_MCP: "1", JCODE_NO_TELEMETRY: "1" } as const;
/** The oldest native release accepted; its ACP, serve and MCP contract was verified live on 0.98.1 (docs/verification). */
export const JCODE_MIN_VERSION = "0.98.0";
/** The first native release assumed to break that contract: the next major. Lower it when a release is shown to break. */
export const JCODE_BREAKING_VERSION = "1.0.0";
const release = (version: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
const compare = (a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
/** A plain release from JCODE_MIN_VERSION up to, not including, JCODE_BREAKING_VERSION; the minor is not pinned (#529). */
export function jcodeVersionSupported(version: unknown): boolean {
  const v = typeof version === "string" ? release(version) : undefined;
  return !!v && compare(v, release(JCODE_MIN_VERSION)!) >= 0 && compare(v, release(JCODE_BREAKING_VERSION)!) < 0;
}

/** The wrapper contract preserves every configured prefix argument before the native probe. */
export function verifiedJcodeCommand(command: string[], cwd: string): boolean {
  const [bin, ...prefix] = command;
  if (!bin) return false;
  try {
    const result = spawnSync(bin, [...prefix, "--quiet", "version", "--json"], { cwd, env: { ...peerChildEnv("jcode"), ...JCODE_OWNED_ENV }, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
    if (result.status !== 0) return false;
    const version = JSON.parse(result.stdout);
    return jcodeVersionSupported(version.semver);
  } catch { return false; }
}

/** Both processes are ours. The user's global daemon and its sockets are never stopped. */
export class JcodePeer extends AcpPeer {
  private readonly launchId = crypto.randomUUID();
  private socketIdentity: { dev: number; ino: number } | undefined;
  private readonly root: string;
  private readonly socket: string;
  private server: ChildProcess | undefined;
  private ending = false;
  private preserveRoot = false;
  private stopPromise: Promise<void> | undefined;

  constructor(private readonly jcode: JcodeOptions) {
    if (!isAbsolute(jcode.home)) throw new Error("jcode_home must be an absolute native data path");
    jcodeCommand(jcode.command, "acp", "preview", jcode.cwd);
    // The name must end in ".sock": jcode names its debug socket by replacing that suffix, so "s" binds one path twice.
    const root = mkdtempSync(join(tmpdir(), "ahub-jcode-")), socket = join(root, "j.sock");
    const cmd = jcodeCommand(jcode.command, "acp", socket, jcode.cwd, jcode.launchModel, jcode.providerProfile);
    super("jcode", { ...jcode, cmd, env: { ...jcode.env, JCODE_HOME: jcode.home, JCODE_SOCKET: socket, ...JCODE_OWNED_ENV }, mcpServers: [], requireLoadSessionEcho: true, expectedAgent: { name: "jcode", version: jcodeVersionSupported } });
    this.root = root; this.socket = socket;
  }

  override async start(): Promise<void> {
    // The native loader otherwise imports Codex MCP into the user's store on first use.
    if (!existsSync(join(this.jcode.home, "mcp.json"))) throw new Error("initialize Jcode's global MCP store with its native client before enabling this peer; the hub never initializes or copies it");
    if (existsSync(this.socket)) { this.preserveRoot = true; throw new Error("Jcode private socket is occupied; no daemon was adopted or removed"); }
    this.ending = false;
    const [bin, ...args] = jcodeCommand(this.jcode.command, "serve", this.socket, this.jcode.cwd, this.jcode.launchModel, this.jcode.providerProfile);
    const server = spawn(bin!, args, { cwd: this.jcode.cwd, detached: true, env: { ...peerChildEnv("jcode"), JCODE_HOME: this.jcode.home, JCODE_SOCKET: this.socket, JCODE_READY_FD: "3", ...JCODE_OWNED_ENV }, stdio: ["ignore", "ignore", "ignore", "pipe"] });
    this.server = server; trackGroup(server);
    try {
      await new Promise<void>((resolve, reject) => {
        const ready = server.stdio[3] as Readable;
        const timer = setTimeout(() => reject(new Error("Jcode owned daemon did not become ready within 30 s")), 30_000);
        const fail = () => { clearTimeout(timer); reject(new Error("Jcode owned daemon exited before readiness; details withheld")); };
        server.once("error", fail); server.once("exit", fail);
        ready.once("data", () => { clearTimeout(timer); server.off("exit", fail); if (lstatSync(this.socket, { throwIfNoEntry: false })?.isSocket()) resolve(); else reject(new Error("Jcode readiness has no private socket")); });
      });
      server.once("exit", () => { if (!this.ending && this.server === server) void this.stop("Jcode owned daemon disconnected").catch(() => {}); });
      const identity = lstatSync(this.socket);
      this.socketIdentity = { dev: identity.dev, ino: identity.ino };
      await super.start();
    } catch (error) { await this.stop().catch(() => {}); throw error; }
  }

  protected override setState(next: PeerState): void {
    if (next === "offline" && this.server) {
      // A removed socket is not process-exit proof. Retain a non-ready state until both owned groups settle.
      if (!this.ending) { super.setState("busy"); void this.stop("Jcode ACP transport ended").catch(() => {}); }
      return;
    }
    super.setState(next);
  }
  override async stop(reason?: string): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const pending = this.end(reason); this.stopPromise = pending;
    try { await pending; } finally { if (this.stopPromise === pending) this.stopPromise = undefined; }
  }
  private async end(reason?: string): Promise<void> {
    this.ending = true;
    if (this.server && this.state !== "offline") super.setState("busy");
    let failure: unknown;
    try { await super.stop(reason); } catch (error) { failure = error; }
    try {
      if (this.server) {
        const server = this.server;
        const closed = server.exitCode !== null || server.signalCode !== null ? Promise.resolve() : new Promise<void>((resolve) => server.once("close", () => resolve()));
        await stopOwnedProcess(server, { group: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Jcode child exit is not confirmed; runtime retained")), 3000); })]);
        } finally { clearTimeout(timer); }
        if (this.server === server) this.server = undefined;
      }
    } catch (error) { failure ??= error; }
    if (!failure && !this.server) {
      if (!this.preserveRoot) rmSync(this.root, { recursive: true, force: true });
      super.setState("offline");
    }
    if (failure) throw failure;
  }
  tuiLaunch(expected?: JcodeTuiBinding, options: { model?: string; providerProfile?: string; sessionId?: string } = {}): JcodeTuiState {
    const sessionId = super.recoveryMetadata().sessionId;
    const socket = lstatSync(this.socket, { throwIfNoEntry: false });
    if (this.ending || !this.server || this.server.exitCode !== null || this.server.signalCode !== null || this.state === "offline" ||
      !socket?.isSocket() || socket.dev !== this.socketIdentity?.dev || socket.ino !== this.socketIdentity.ino || typeof sessionId !== "string") throw new Error("owned Jcode launch is unavailable");
    const binding = { launchId: this.launchId, sessionId };
    if (expected && (expected.launchId !== binding.launchId || expected.sessionId !== binding.sessionId)) throw new Error("Jcode launch changed");
    if ((options.sessionId !== undefined && options.sessionId !== sessionId) ||
      (options.model !== undefined && options.model !== this.jcode.launchModel) ||
      (options.providerProfile !== undefined && options.providerProfile !== this.jcode.providerProfile)) throw new Error("Jcode launch options differ from its running session");
    if (!savedSession(this.jcode.home, sessionId)) return { state: "waiting", binding };
    const [cmd, ...args] = jcodeTuiCommand(this.jcode.command, this.socket, sessionId, this.jcode.launchModel, this.jcode.providerProfile);
    return { state: "ready", binding, launch: { cmd: cmd!, args, env: { JCODE_HOME: this.jcode.home, JCODE_SOCKET: this.socket, ...JCODE_OWNED_ENV } } };
  }
  override recoveryMetadata(): Record<string, unknown> {
    return { ...super.recoveryMetadata(), launch: { kind: "jcode", peer: "jcode", mode: "headless", ...(this.jcode.launchModel ? { model: this.jcode.launchModel } : {}), ...(this.jcode.providerProfile ? { providerProfile: this.jcode.providerProfile } : {}) } };
  }
}
