import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
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
/** The wrapper contract preserves every configured prefix argument before the native probe. */
export function verifiedJcodeCommand(command: string[], cwd: string): boolean {
  const [bin, ...prefix] = command;
  if (!bin) return false;
  try {
    const result = spawnSync(bin, [...prefix, "--quiet", "version", "--json"], { cwd, env: peerChildEnv("jcode"), encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
    if (result.status !== 0) return false;
    const version = JSON.parse(result.stdout);
    return version.semver === "0.94.0";
  } catch { return false; }
}

/** Both processes are ours. The user's global daemon and its sockets are never stopped. */
export class JcodePeer extends AcpPeer {
  private readonly root: string;
  private readonly socket: string;
  private server: ChildProcess | undefined;
  private ending = false;
  private preserveRoot = false;
  private stopPromise: Promise<void> | undefined;

  constructor(private readonly jcode: JcodeOptions) {
    if (!isAbsolute(jcode.home)) throw new Error("jcode_home must be an absolute native data path");
    jcodeCommand(jcode.command, "acp", "preview", jcode.cwd);
    const root = mkdtempSync(join(tmpdir(), "ahub-jcode-")), socket = join(root, "s");
    const cmd = jcodeCommand(jcode.command, "acp", socket, jcode.cwd, jcode.launchModel, jcode.providerProfile);
    super("jcode", { ...jcode, cmd, env: { ...jcode.env, JCODE_HOME: jcode.home, JCODE_SOCKET: socket, JCODE_DISABLE_CLAUDE_MCP: "1" }, mcpServers: [], requireLoadSessionEcho: true, expectedAgent: { name: "jcode", version: "0.94.0" } });
    this.root = root; this.socket = socket;
  }

  override async start(): Promise<void> {
    // The native loader otherwise imports Codex MCP into the user's store on first use.
    if (!existsSync(join(this.jcode.home, "mcp.json"))) throw new Error("initialize Jcode's global MCP store with its native client before enabling this peer; the hub never initializes or copies it");
    if (existsSync(this.socket)) { this.preserveRoot = true; throw new Error("Jcode private socket is occupied; no daemon was adopted or removed"); }
    this.ending = false;
    const [bin, ...args] = jcodeCommand(this.jcode.command, "serve", this.socket, this.jcode.cwd, this.jcode.launchModel, this.jcode.providerProfile);
    const server = spawn(bin!, args, { cwd: this.jcode.cwd, detached: true, env: { ...peerChildEnv("jcode"), JCODE_HOME: this.jcode.home, JCODE_SOCKET: this.socket, JCODE_READY_FD: "3", JCODE_DISABLE_CLAUDE_MCP: "1" }, stdio: ["ignore", "ignore", "ignore", "pipe"] });
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
  override recoveryMetadata(): Record<string, unknown> {
    return { ...super.recoveryMetadata(), launch: { kind: "jcode", peer: "jcode", mode: "headless", ...(this.jcode.launchModel ? { model: this.jcode.launchModel } : {}), ...(this.jcode.providerProfile ? { providerProfile: this.jcode.providerProfile } : {}) } };
  }
}
