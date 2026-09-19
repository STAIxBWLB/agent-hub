import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Routing } from "../hub/routing.ts";
import type { OmniRoute } from "../omniroute/client.ts";
import { KEY_ENV, switchyardToml } from "./config.ts";

class GatewayDown extends Error {}

export interface SidecarOptions {
  routing: Routing;
  omni: OmniRoute;
  stateDir: string;
  port: number;
  /** `AGENTHUB_SWITCHYARD_BIN`, else `switchyard-server` on PATH. */
  bin?: string;
  log: (line: string) => void;
}

/**
 * L2 as a session-scoped sidecar: started on the first hub-owned model call, stopped with the hub, never resident.
 * Every failure (no binary, bad config, unhealthy, a failed call) turns it off for the rest of the hub run and the
 * caller falls back to `fixed_model` on OmniRoute directly.
 */
export class Sidecar {
  private proc: ChildProcess | undefined;
  private starting: Promise<string | undefined> | undefined;
  private off = "";
  /** The gateway URL the running sidecar was generated with; calls through it go there whatever the client probes later. */
  upstream: string | undefined;

  constructor(private readonly opts: SidecarOptions) {}

  get status(): string {
    return this.off ? `off (${this.off})` : this.proc ? `127.0.0.1:${this.opts.port}` : "not started";
  }

  /** Base URL to send chat calls to, or undefined when the hub should call OmniRoute directly. */
  endpoint(): Promise<string | undefined> {
    if (this.off) return Promise.resolve(undefined);
    return (this.starting ??= this.start().catch((e: Error) => {
      // An unreachable gateway says nothing about Switchyard: this call goes direct, the next one tries the sidecar again.
      if (e instanceof GatewayDown) this.starting = undefined;
      else this.disable(e.message);
      return undefined;
    }));
  }

  /** A call through the sidecar failed: stop trusting it. Logged once. */
  disable(reason: string): void {
    if (this.off) return;
    this.off = reason;
    this.opts.log(`switchyard: off, falling back to fixed_model on OmniRoute (${reason})`);
    this.stop();
  }

  stop(): void {
    this.proc?.kill();
    this.proc = undefined;
    rmSync(join(this.opts.stateDir, "switchyard.toml"), { force: true });
  }

  private async start(): Promise<string | undefined> {
    const { routing, omni, stateDir, port, log } = this.opts;
    if (!Object.keys(routing.routes).length) throw new Error("routing.toml defines no routes");
    const bin = this.opts.bin ?? process.env.AGENTHUB_SWITCHYARD_BIN ?? "switchyard-server";
    const baseUrl = await omni.base();
    const key = omni.apiKey();
    if (!baseUrl || !key) throw new GatewayDown("no OmniRoute endpoint or key");
    this.upstream = baseUrl;

    const file = join(stateDir, "switchyard.toml");
    writeFileSync(file, switchyardToml(routing, { baseUrl, extraHeaders: omni.accessHeaders(baseUrl) }), { mode: 0o600 });
    chmodSync(file, 0o600);
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", [KEY_ENV]: key };
    const check = spawnSync(bin, ["--config", file, "--dry-run"], { env, encoding: "utf8" });
    if (check.error) throw new Error(`${bin} not runnable: ${check.error.message}`);
    if (check.status !== 0) throw new Error(`config rejected: ${(check.stderr || check.stdout).trim().slice(0, 300)}`);

    // Switchyard's default host is 0.0.0.0; the hub binds loopback only.
    const proc = spawn(bin, ["--config", file, "--host", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "ignore", "pipe"] });
    this.proc = proc;
    let exited = false;
    // Switchyard logs every request at INFO on stderr; only problems belong in hub.log.
    proc.stderr?.on("data", (d) => {
      for (const line of String(d).split("\n")) if (/\b(WARN|ERROR)\b/.test(line)) log(`[switchyard] ${line.trim().slice(0, 500)}`);
    });
    proc.on("error", () => (exited = true));
    proc.on("exit", (code) => {
      exited = true;
      if (this.proc === proc) this.disable(`exited with code ${code}`);
    });
    for (let i = 0; i < 100 && !exited; i++) {
      if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)) {
        log(`switchyard: up on 127.0.0.1:${port}, routes ${Object.keys(routing.routes).join(", ")}`);
        return `http://127.0.0.1:${port}/v1`;
      }
      await Bun.sleep(100);
    }
    throw new Error(exited ? "exited during startup" : "not healthy within 10 s");
  }
}
