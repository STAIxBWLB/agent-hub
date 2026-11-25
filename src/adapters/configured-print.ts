import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { OwnedPrintChild, PrintChildCleanupError } from "./claude-print-child.ts";
import { renderDigest, replyAudience, replyParent, sanitize, type Envelope } from "../hub/envelope.ts";
import { BasePeer } from "../hub/peers.ts";
import { realPath } from "../hub/project.ts";
import { sbplString } from "../local/deny.ts";
import { profile, sandboxAvailable } from "../local/sandbox.ts";

export interface ConfiguredPrintAdapterConfig {
  transport: "print";
  command: string;
  args: readonly string[];
  stdin?: true;
  versionArgs: readonly string[];
  versionPin: string;
  timeoutS: number;
  displayName: string;
  roles: readonly ("reviewer" | "advisor")[];
}

export interface ConfiguredPrintOptions {
  declaration: ConfiguredPrintAdapterConfig;
  cwd: string;
  deny(): string[];
  stateDir: string;
  privateTurn(envs: readonly Envelope[]): boolean;
  publicText(text: string): boolean;
}

const OUTPUT_LIMIT = 64 * 1024;
const STDERR_DISPLAY_LIMIT = 2000;
const SANDBOX = "/usr/bin/sandbox-exec";

function executableIdentity(file: string): string {
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error("print command must name an executable file");
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

/** Each process is subject to the same read-only confinement, including the version probe. */
export class ConfiguredPrintPeer extends BasePeer {
  readonly form = "headless" as const;
  readonly hubOwned = true;
  readonly deliveryOnly = true;
  readonly permissionModeState = "unmanaged" as const;
  private child?: OwnedPrintChild;
  private command?: { path: string; identity: string };
  private stopped = false;

  constructor(id: string, private readonly options: ConfiguredPrintOptions) {
    super(id);
  }

  get pendingOwnedProcess(): boolean { return this.child !== undefined; }

  async start(): Promise<void> {
    if (this.child) throw new Error("print child cleanup is unconfirmed; stop the peer and retry");
    if (!sandboxAvailable()) throw new Error("configured print requires the hub read-only sandbox on this host");
    const config = this.options.declaration;
    const selected = isAbsolute(config.command) ? config.command : Bun.which(config.command);
    if (!selected) throw new Error("configured print command is unavailable");
    const path = realPath(selected);
    const identity = executableIdentity(path);
    this.command = { path, identity };
    this.stopped = false;
    const version = await this.run(config.versionArgs, "");
    if (this.stopped || version.code !== 0 || version.timedOut || version.truncated || version.stdout.trim() !== config.versionPin || executableIdentity(path) !== identity) {
      this.command = undefined;
      throw new Error("configured print version probe did not match versionPin");
    }
    this.setState("idle");
  }

  async deliver(envs: Envelope[], deliveryId?: string): Promise<void> {
    const receipt = (state: "accepted" | "completed" | "failed_safe" | "needs_review", reason?: string) => {
      if (deliveryId) this.delivery({ id: deliveryId, state, ...(reason ? { reason } : {}) });
    };
    if (this.state !== "idle" || this.child || !envs.length || this.options.privateTurn(envs)
      || envs.some(env => env.private || env.kind === "review" || env.kind === "task" || env.kind === "invocation")) {
      receipt("failed_safe", "configured print accepts public advisory messages only");
      return;
    }
    const prompt = renderDigest(envs, true);
    if (!this.options.publicText(prompt)) { receipt("failed_safe", "print prompt withheld by policy"); return; }
    const reply = { to: replyAudience(envs), inReplyTo: replyParent(envs) };
    const config = this.options.declaration;
    const args = config.stdin ? config.args : config.args.map(arg => arg.replace("{prompt}", () => prompt));
    this.setState("busy");
    try {
      receipt("accepted");
      const result = await this.run(args, config.stdin ? prompt : "");
      if (this.stopped || this.options.privateTurn(envs)) {
        receipt("needs_review", "print delivery stopped or became private");
        return;
      }
      if (result.code !== 0 || result.timedOut) {
        const cause = result.timedOut ? "Configured print timed out" : "Configured print exited unsuccessfully";
        const tail = result.stderr && this.options.publicText(result.stderr) ? sanitize(result.stderr.slice(-STDERR_DISPLAY_LIMIT)) : "";
        this.finalAnswer(tail ? `${cause}\n${tail}` : cause, reply, false);
        receipt("needs_review", cause);
        return;
      }
      const output = result.stdout + (result.truncated ? "\n[print output truncated]" : "");
      if (output && this.options.publicText(output)) this.finalAnswer(output, reply);
      else if (output) { receipt("needs_review", "print answer withheld by policy"); return; }
      receipt("completed");
    } catch (error) {
      receipt(error instanceof PrintChildCleanupError ? "needs_review" : "failed_safe", "configured print failed to run");
    } finally {
      if (!this.child) this.setState(this.stopped ? "offline" : "idle");
    }
  }

  override onWatchdog(): void {
    // The configured per-process timeout joins the owned child before the next delivery.
    this.touch();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    if (child) {
      await child.stop();
      await child.done.catch(error => {
        if (error instanceof PrintChildCleanupError) throw error;
      });
      if (this.child === child) this.child = undefined;
    }
    this.setState("offline");
  }

  private async run(args: readonly string[], input: string) {
    const command = this.command;
    if (!sandboxAvailable() || !command || this.stopped || executableIdentity(command.path) !== command.identity)
      throw new Error("configured print command or sandbox is no longer current");
    const { cwd, deny, stateDir } = this.options;
    // The final deny also closes the ordinary worker profile's loose Git-object write grant.
    const policy = profile(cwd, false, [command.path], deny(), [cwd])
      + `\n(deny file-read* (subpath ${sbplString(stateDir)}))\n(deny file-write*)\n(allow file-write* (literal "/dev/null"))`;
    const chunks: Uint8Array[] = [];
    let timedOut = false, truncated = false;
    const child = this.child = new OwnedPrintChild({ peer: this.id, command: [SANDBOX],
      args: ["-p", policy, command.path, ...args], cwd, input, envMode: "replace",
      env: { PATH: "/usr/bin:/bin", HOME: "/var/empty", LANG: "C", TERM: "dumb" },
      maxOutputBytes: OUTPUT_LIMIT, captureStderrTail: true,
      onOutput: chunk => chunks.push(chunk), onLimit: () => { truncated = true; } });
    const timer = setTimeout(() => {
      timedOut = true;
      void child.stop().catch(() => {});
    }, this.options.declaration.timeoutS * 1000);
    timer.unref();
    try {
      const code = await child.done;
      this.child = undefined;
      const stderr = child.stderrAfterSettlement();
      return { code, timedOut, truncated, stdout: Buffer.concat(chunks).toString("utf8"), stderr: stderr.status === "complete" ? stderr.text : "" };
    } catch (error) {
      if (!(error instanceof PrintChildCleanupError)) this.child = undefined;
      throw error;
    } finally { clearTimeout(timer); }
  }
}
