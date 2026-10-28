import { randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, lstatSync, mkdtempSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type Socket } from "node:net";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { HOST_SHELL_PROTOCOL as WIRE } from "../cli/claude-shell-wrapper.ts";
import { shellQuote } from "../cli/shell-quote.ts";
import { readProcessTable, stopOwnedProcess, trackGroup } from "./child-process.ts";
import { realPath } from "./project.ts";
import { sbplString } from "../local/deny.ts";

export interface ShellGrant {
  peer: string; task: number; generation: string; root: string; branch: string;
  executable: string; argv: readonly string[]; env: Readonly<Record<string, string>>;
  signal: AbortSignal; timeoutMs: number; current(): boolean; activity?: () => void;
  /** Host-only observation of a matched redemption refusal; it proves no execution outcome. */
  onRefused?: () => void;
  sandbox?: { profile: string; readOnlyData: boolean };
}
type Stamp = { path: string; identity: string };
type Ticket = { source: ShellGrant; grant: Readonly<ShellGrant>; expires: number; root: Stamp; executable: Stamp; abort(): void };
type Execution = { ticket: Ticket; proc?: ChildProcess; temporary?: Stamp; response: ServerResponse; cancelled: boolean; failedCleanup: boolean; stopping?: Promise<void>; done: Promise<void>; cancel(): Promise<void> };
const MAX_TICKETS = 64, MAX_PEER = 8, TTL_MS = 30_000;
const MAX_EXECUTION_PAYLOAD = 256 * 1024;
// Host-only source: no public CLI mode accepts execution descriptors. The descriptor arrives on fd4,
// never argv/env, and the exact target env is passed to spawn rather than inherited through a shell.
const SUPERVISOR_SOURCE = String.raw`
import { createReadStream, writeSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { constants } from "node:os";
let finished = false;
const finish = code => {
  if (finished) return;
  finished = true;
  try { writeSync(3, String(code) + "\n"); } catch {}
  for (const fd of [1, 2, 3]) { try { closeSync(fd); } catch {} }
};
// The host owns stdin. On owner loss, only this original detached group is terminated.
process.stdin.on("end", () => { try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(125); } });
process.stdin.resume();
try {
  const pieces = []; let bytes = 0;
  for await (const part of createReadStream("/dev/null", { fd: 4, autoClose: true, highWaterMark: 16384 })) {
    const block = Buffer.isBuffer(part) ? part : Buffer.from(part); bytes += block.length;
    if (bytes > 262144) throw new Error(); pieces.push(block);
  }
  const value = JSON.parse(Buffer.concat(pieces, bytes).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "argv,env,executable,root"
    || typeof value.root !== "string" || !value.root.startsWith("/") || typeof value.executable !== "string" || !value.executable.startsWith("/")
    || !Array.isArray(value.argv) || value.argv.some(v => typeof v !== "string" || v.includes("\0"))
    || !value.env || typeof value.env !== "object" || Array.isArray(value.env)
    || Object.entries(value.env).some(([key, v]) => !key || key.includes("=") || key.includes("\0") || typeof v !== "string" || v.includes("\0"))) throw new Error();
  const child = spawn(value.executable, value.argv, { cwd: value.root, env: value.env, stdio: ["ignore", 1, 2, "ignore", "ignore"] });
  const status = (code, signal) => {
    const found = code ?? (signal && constants.signals[signal] ? 128 + constants.signals[signal] : 125);
    finish(Number.isInteger(found) && found >= 0 && found <= 255 ? found : 125);
  };
  child.once("error", () => finish(256)); child.once("exit", status);
  if (child.exitCode !== null || child.signalCode !== null) status(child.exitCode, child.signalCode);
} catch { finish(256); }
`;
const fail = () => new Error(WIRE.refusal);
const beneath = (root: string, file: string) => { const r = relative(root, file); return !r || r !== ".." && !r.startsWith("../") && !isAbsolute(r); };
function stamp(value: string, directory = false): Stamp {
  const path = realPath(value), s = lstatSync(path);
  if (directory ? !s.isDirectory() : !s.isFile()) throw fail();
  if (!directory) accessSync(path, constants.R_OK);
  return { path, identity: JSON.stringify(directory ? [path, s.dev, s.ino, s.mode] : [path, s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs]) };
}
const same = (value: string, prior: Stamp, directory = false) => { try { return stamp(value, directory).identity === prior.identity; } catch { return false; } };
function removeOwned(directory: Stamp): void {
  try { lstatSync(directory.path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw fail(); }
  if (!same(directory.path, directory, true)) throw fail();
  rmSync(directory.path, { recursive: true, force: true });
}
function snapshot(source: ShellGrant): Readonly<ShellGrant> | undefined {
  try {
    if (!source || !/^[a-z][a-z0-9-]{0,63}$/.test(source.peer) || !Number.isSafeInteger(source.task) || source.task < 1
      || typeof source.generation !== "string" || !source.generation || source.generation.length > 256 || /[\p{Cc}]/u.test(source.generation)
      || typeof source.root !== "string" || !isAbsolute(source.root) || typeof source.executable !== "string" || !isAbsolute(source.executable)
      || typeof source.branch !== "string" || !source.branch || source.branch.length > 256 || /[\p{Cc}]/u.test(source.branch)
      || !Array.isArray(source.argv) || source.argv.length > 256 || source.argv.some(a => typeof a !== "string" || a.includes("\0") || a.length > 64 * 1024)
      || !source.env || typeof source.env !== "object" || Array.isArray(source.env) || !(source.signal instanceof AbortSignal) || source.signal.aborted
      || !Number.isSafeInteger(source.timeoutMs) || source.timeoutMs < 1 || source.timeoutMs > WIRE.maximumMs || typeof source.current !== "function"
      || source.activity !== undefined && typeof source.activity !== "function"
      || source.onRefused !== undefined && typeof source.onRefused !== "function") return;
    if (source.sandbox !== undefined && (!source.sandbox || typeof source.sandbox !== "object" || Array.isArray(source.sandbox)
      || Object.keys(source.sandbox).sort().join(",") !== "profile,readOnlyData" || typeof source.sandbox.profile !== "string" || !source.sandbox.profile
      || source.sandbox.profile.includes("\0") || Buffer.byteLength(source.sandbox.profile) > 128 * 1024 || typeof source.sandbox.readOnlyData !== "boolean"
      || source.sandbox.readOnlyData && /\(allow file-write\* \(subpath /.test(source.sandbox.profile))) return;
    const entries = Object.entries(source.env);
    if (entries.length > 256 || entries.some(([key, value]) => !key || key.includes("=") || key.includes("\0") || typeof value !== "string" || value.includes("\0"))
      || Buffer.byteLength(JSON.stringify([source.argv, entries, source.sandbox])) > 256 * 1024) return;
    return Object.freeze({ ...source, argv: Object.freeze([...source.argv]), env: Object.freeze(Object.fromEntries(entries)),
      ...(source.sandbox ? { sandbox: Object.freeze({ ...source.sandbox }) } : {}) });
  } catch { return; }
}
function unchanged(ticket: Ticket): boolean {
  const a = ticket.source, b = ticket.grant;
  try {
    return a.peer === b.peer && a.task === b.task && a.generation === b.generation && a.root === b.root && a.branch === b.branch
      && a.executable === b.executable && a.signal === b.signal && a.timeoutMs === b.timeoutMs && a.current === b.current && a.activity === b.activity && a.onRefused === b.onRefused
      && a.argv.length === b.argv.length && a.argv.every((v, i) => v === b.argv[i])
      && (a.sandbox === undefined ? b.sandbox === undefined : b.sandbox !== undefined && Object.keys(a.sandbox).sort().join(",") === "profile,readOnlyData"
        && a.sandbox.profile === b.sandbox.profile && a.sandbox.readOnlyData === b.sandbox.readOnlyData)
      && Object.keys(a.env).length === Object.keys(b.env).length && Object.entries(b.env).every(([k, v]) => a.env[k] === v);
  } catch { return false; }
}

/** An in-memory single-use capability service. Only the host supplies grants; request bodies carry a ticket only. */
export class HostShellWrapper {
  private server!: Server;
  private readonly tickets = new Map<string, Ticket>();
  private readonly active = new Set<Execution>();
  private readonly connections = new Set<Socket>();
  private closing = false;
  private closed = false;
  private closingWork?: Promise<void>;
  private socketIdentity?: string;
  private constructor(private readonly directory: Stamp, private readonly socket: string, private readonly runtime: Stamp, private readonly entry: Stamp, private readonly envProgram: Stamp, private readonly implementation: Stamp, private readonly sandboxExec?: Stamp) {}

  static async create(): Promise<HostShellWrapper> {
    // A short system temp path avoids Darwin's Unix-socket length ceiling under a nested test TMPDIR.
    // Native/target TMPDIR never chooses the private capability directory.
    const directory = mkdtempSync(join(realPath("/tmp"), "ahub-shell-")); chmodSync(directory, 0o700);
    let wrapper: HostShellWrapper | undefined;
    try {
      const runtime = stamp(process.execPath), entry = stamp(fileURLToPath(new URL("../cli/claude-shell-wrapper.ts", import.meta.url))), envProgram = stamp("/usr/bin/env"), implementation = stamp(fileURLToPath(import.meta.url));
      for (const program of [runtime, envProgram]) accessSync(program.path, constants.X_OK);
      let sandboxExec: Stamp | undefined;
      if (process.platform === "darwin") { try { sandboxExec = stamp("/usr/bin/sandbox-exec"); accessSync(sandboxExec.path, constants.X_OK); } catch { sandboxExec = undefined; } }
      wrapper = new HostShellWrapper(stamp(directory, true), join(directory, "s"), runtime, entry, envProgram, implementation, sandboxExec);
      const owner = wrapper;
      const server = wrapper.server = createServer({ maxHeaderSize: 2048 }, (request, response) => {
        response.on("error", () => {});
        void owner.handle(request, response).catch(() => owner.refuse(response));
      });
      server.maxConnections = 96; server.maxHeadersCount = 8; server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.timeout = 0;
      server.on("connection", socket => { owner.connections.add(socket); socket.once("close", () => owner.connections.delete(socket)); });
      server.on("clientError", (_error, socket) => { socket.destroy(); });
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(owner.socket, () => { server.off("error", reject); resolve(); }); });
      server.on("error", () => {});
      chmodSync(wrapper.socket, 0o600);
      const socket = lstatSync(wrapper.socket); wrapper.socketIdentity = JSON.stringify([socket.dev, socket.ino, socket.mode]);
      return wrapper;
    } catch {
      if (wrapper?.server) {
        for (const connection of wrapper.connections) connection.destroy();
        if (wrapper.server.listening) await new Promise<void>(resolve => wrapper!.server.close(() => resolve()));
      }
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* unavailable service, no issued grant */ }
      throw fail();
    }
  }

  private stable(root: string): boolean {
    return !this.closing && same(this.directory.path, this.directory, true) && same(this.runtime.path, this.runtime)
      && same(this.entry.path, this.entry) && same(this.envProgram.path, this.envProgram)
      && same(this.implementation.path, this.implementation)
      && ![this.runtime.path, this.entry.path, this.envProgram.path, this.implementation.path].some(file => beneath(root, file));
  }
  private sandboxStable(grant: Readonly<ShellGrant>, root: string): boolean {
    return !grant.sandbox || process.platform === "darwin" && !!this.sandboxExec && same(this.sandboxExec.path, this.sandboxExec) && !beneath(root, this.sandboxExec.path);
  }
  private count(peer?: string): number { return [...this.tickets.values(), ...[...this.active].map(a => a.ticket)].filter(t => peer === undefined || t.grant.peer === peer).length; }
  private forget(token: string, ticket: Ticket): void { this.tickets.delete(token); ticket.grant.signal.removeEventListener("abort", ticket.abort); }
  private prune(): void { for (const [token, ticket] of this.tickets) if (ticket.expires <= Date.now() || ticket.grant.signal.aborted) this.forget(token, ticket); }

  issue(source: ShellGrant): { command: string } | undefined {
    this.prune(); const grant = snapshot(source); if (!grant) return;
    try {
      const root = stamp(grant.root, true), executable = stamp(grant.executable); accessSync(executable.path, constants.X_OK);
      if (!this.stable(root.path) || !this.sandboxStable(grant, root.path) || this.count() >= MAX_TICKETS || this.count(grant.peer) >= MAX_PEER || grant.current() !== true || grant.signal.aborted || this.closing) return;
      const token = randomBytes(32).toString("hex");
      const ticket: Ticket = { source, grant, root, executable, expires: Date.now() + TTL_MS, abort: () => this.forget(token, ticket) };
      if (!unchanged(ticket) || !this.stable(root.path) || !this.sandboxStable(grant, root.path) || this.count() >= MAX_TICKETS || this.count(grant.peer) >= MAX_PEER) return;
      this.tickets.set(token, ticket); grant.signal.addEventListener("abort", ticket.abort, { once: true });
      if (grant.signal.aborted) { this.forget(token, ticket); return; }
      // env -i alone does not prevent Bun from discovering config/preloads in a persisted native cwd.
      return { command: [this.envProgram.path, "-i", `HOME=${this.directory.path}`, this.runtime.path, "--config=/dev/null", "--no-env-file", `--cwd=${this.directory.path}`, this.entry.path, this.socket, token].map(shellQuote).join(" ") };
    } catch { return; }
  }

  private refuse(response: ServerResponse, ticket?: Ticket): void {
    // Only the issued immutable callback may observe a matched ticket. It grants
    // nothing and must not change refusal, cleanup or target-exit classification.
    try { ticket?.grant.onRefused?.(); } catch { /* An observer is never authority. */ }
    if (response.destroyed || response.writableEnded) return;
    if (!response.headersSent) { response.statusCode = 403; response.setHeader("connection", "close"); response.end(`${WIRE.refusal}\n`); }
    else response.destroy();
  }
  private async body(request: IncomingMessage): Promise<unknown> {
    const length = request.headers["content-length"];
    if (typeof length !== "string" || !/^[0-9]+$/.test(length) || Number(length) > 256 || Number(length) < 1 || request.headers["transfer-encoding"] !== undefined) throw fail();
    const chunks: Buffer[] = []; let bytes = 0;
    const timer = setTimeout(() => request.destroy(), 3000);
    try {
      for await (const part of request) { const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part); bytes += chunk.length; if (bytes > 256) throw fail(); chunks.push(chunk); }
      if (bytes !== Number(length)) throw fail();
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { clearTimeout(timer); }
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.closing || request.method !== "POST" || request.url !== "/execute" || Object.hasOwn(request.headers, "origin") || request.headers["content-type"] !== "application/json") return this.refuse(response);
    const body = await this.body(request) as { ticket?: unknown };
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.ticket !== "string" || !/^[a-f0-9]{64}$/.test(body.ticket)) return this.refuse(response);
    const ticket = this.tickets.get(body.ticket);
    if (!ticket) return this.refuse(response);
    this.forget(body.ticket, ticket); // Consume before schema, expiry, authority or metadata validation.
    if (Object.keys(body).length !== 1 || ticket.expires <= Date.now()) return this.refuse(response, ticket);
    const execution: Execution = { ticket, response, cancelled: false, failedCleanup: false, done: Promise.resolve(), cancel: async () => { execution.cancelled = true; await this.stop(execution); } };
    this.active.add(execution);
    execution.done = this.execute(execution);
    await execution.done;
  }
  private async stop(execution: Execution): Promise<void> {
    if (!execution.proc) return;
    if (execution.stopping) return execution.stopping;
    const work = stopOwnedProcess(execution.proc, { group: true }).then(() => { execution.failedCleanup = false; }, () => { execution.failedCleanup = true; throw fail(); });
    execution.stopping = work;
    try { await work; } finally { execution.stopping = undefined; }
  }
  private async execute(execution: Execution): Promise<void> {
    const { ticket, response } = execution, grant = ticket.grant;
    let timer: ReturnType<typeof setTimeout> | undefined, heartbeat: ReturnType<typeof setInterval> | undefined, temporary: Stamp | undefined;
    const activity = () => { try { grant.activity?.(); } catch { /* A heartbeat grants nothing. */ } };
    const abort = () => { void execution.cancel().catch(() => response.destroy()); };
    const disconnected = () => { if (!response.writableEnded) abort(); };
    response.once("close", disconnected); response.on("error", abort); grant.signal.addEventListener("abort", abort, { once: true });
    try {
      if (!unchanged(ticket) || !this.stable(ticket.root.path) || !this.sandboxStable(grant, ticket.root.path) || !same(grant.root, ticket.root, true) || !same(grant.executable, ticket.executable)) throw fail();
      const temp = mkdtempSync(join(this.directory.path, "r-")); chmodSync(temp, 0o700); temporary = execution.temporary = stamp(temp, true);
      const env = { ...grant.env, TMPDIR: `${temporary.path}/` };
      // Identical own-temp allow suffix and data.readonly broad-write guard to sandboxedExec.
      if (grant.sandbox?.readOnlyData && /\(allow file-write\* \(subpath /.test(grant.sandbox.profile)) throw fail();
      const sandbox = grant.sandbox && `${grant.sandbox.profile}\n(allow file-read* ${grant.sandbox.readOnlyData ? "" : "file-write* "}process-exec (subpath ${sbplString(temporary.path)}))`;
      const target = sandbox ? [this.sandboxExec!.path, "-p", sandbox, ticket.executable.path, ...grant.argv] : [ticket.executable.path, ...grant.argv];
      const payload = JSON.stringify({ root: ticket.root.path, executable: target[0], argv: target.slice(1), env });
      if (Buffer.byteLength(payload) > MAX_EXECUTION_PAYLOAD) throw fail();
      // No await or effectful setup remains between this final host proof and spawn.
      if (!this.sandboxStable(grant, ticket.root.path) || grant.current() !== true || grant.signal.aborted || execution.cancelled || this.closing || response.destroyed) throw fail();
      // Keep our original group leader alive through output drain. stopOwnedProcess refuses to signal a
      // reaped leader's surviving group. The fixed Bun supervisor reports target status on fd3,
      // closes its own output fds and stays alive on the host-owned stdin release pipe.
      const proc = execution.proc = spawn(this.runtime.path, ["--config=/dev/null", "--no-env-file", `--cwd=${this.directory.path}`, "-e", SUPERVISOR_SOURCE], {
        cwd: this.directory.path, env: { HOME: this.directory.path }, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
      });
      proc.on("error", () => {}); proc.stdin!.on("error", () => {});
      const control = proc.stdio[4] as Writable;
      control.on("error", abort);
      proc.once("spawn", () => {
        try {
          if (!unchanged(ticket) || !this.stable(ticket.root.path) || !this.sandboxStable(grant, ticket.root.path)
            || !same(grant.root, ticket.root, true) || !same(grant.executable, ticket.executable)
            || grant.current() !== true || grant.signal.aborted || execution.cancelled || this.closing || response.destroyed) { abort(); return; }
          control.end(payload);
        } catch { abort(); }
      });
      trackGroup(proc);
      response.writeHead(200, { "content-type": "application/x-ndjson", connection: "close", "cache-control": "no-store" }); response.flushHeaders();
      timer = setTimeout(abort, grant.timeoutMs); heartbeat = setInterval(activity, 250); heartbeat.unref(); activity();
      let queued = Promise.resolve();
      const frame = (value: unknown): Promise<void> => {
        const bytes = `${JSON.stringify(value)}\n`; if (Buffer.byteLength(bytes) > WIRE.frameBytes) return Promise.reject(fail());
        const work = queued.then(() => new Promise<void>((resolve, reject) => {
          if (response.destroyed || response.writableEnded) { reject(fail()); return; }
          response.write(bytes, error => error ? reject(error) : resolve());
        }));
        queued = work.catch(() => {}); return work;
      };
      const pump = async (stream: Readable, type: "stdout" | "stderr") => {
        stream.pause();
        for (;;) {
          const raw = stream.read(Math.min(WIRE.chunkBytes, stream.readableLength || WIRE.chunkBytes));
          if (raw !== null) {
            const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            if (chunk.length > WIRE.chunkBytes) throw fail();
            activity(); await frame({ type, data: chunk.toString("base64") }); continue;
          }
          if (stream.readableEnded) return;
          if (stream.destroyed) throw fail();
          await new Promise<void>((resolve, reject) => {
            const clean = () => { stream.off("readable", ready); stream.off("end", ready); stream.off("error", broken); stream.off("close", closed); };
            const ready = () => { clean(); resolve(); };
            const broken = () => { clean(); reject(fail()); };
            const closed = () => stream.readableEnded ? ready() : broken();
            stream.once("readable", ready); stream.once("end", ready); stream.once("error", broken); stream.once("close", closed);
            if (stream.readableLength || stream.readableEnded) ready(); else if (stream.destroyed) broken();
          });
        }
      };
      const status = (async () => {
        let value = "";
        for await (const raw of proc.stdio[3] as Readable) { value += Buffer.from(raw).toString("ascii"); if (value.length > 16) throw fail(); }
        if (!/^[0-9]{1,3}\n$/.test(value) || Number(value) > 255) throw fail();
        // The leader is still ours. A surviving same-group child is an unclean target outcome; reap it
        // now rather than circularly waiting for a pipe that that child still owns. Unknown evidence asks.
        const rows = await readProcessTable();
        if (!rows || !rows.some(row => row.pid === proc.pid && row.pgid === proc.pid)) throw fail();
        if (rows.some(row => row.pgid === proc.pid && row.pid !== proc.pid)) { execution.cancelled = true; await this.stop(execution); throw fail(); }
        return Number(value);
      })();
      const [code] = await Promise.all([status, pump(proc.stdout!, "stdout"), pump(proc.stderr!, "stderr")]);
      await this.stop(execution);
      if (execution.cancelled) throw fail();
      removeOwned(temporary); temporary = undefined; execution.temporary = undefined;
      if (execution.cancelled || grant.signal.aborted || this.closing || response.destroyed) throw fail();
      if (!Number.isInteger(code) || code < 0 || code > 255) throw fail();
      await frame({ type: "exit", code }); response.end();
    } catch {
      execution.cancelled = true;
      try { await this.stop(execution); } catch { execution.failedCleanup = true; }
      this.refuse(response, ticket);
    } finally {
      clearTimeout(timer); clearInterval(heartbeat); grant.signal.removeEventListener("abort", abort); response.off("close", disconnected); response.off("error", abort);
      if (!execution.failedCleanup && temporary) { try { removeOwned(temporary); execution.temporary = undefined; } catch { execution.failedCleanup = true; } }
      if (!execution.failedCleanup) this.active.delete(execution);
    }
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closingWork) return this.closingWork;
    this.closing = true;
    for (const [token, ticket] of this.tickets) this.forget(token, ticket);
    const work = (async () => {
      const entries = [...this.active];
      await Promise.allSettled(entries.map(entry => entry.cancel()));
      await Promise.allSettled(entries.map(entry => entry.done));
      for (const entry of entries) if (!entry.failedCleanup) {
        try { if (entry.temporary) removeOwned(entry.temporary); entry.temporary = undefined; this.active.delete(entry); }
        catch { entry.failedCleanup = true; }
      }
      for (const connection of this.connections) connection.destroy();
      await new Promise<void>(resolve => { if (!this.server.listening) resolve(); else this.server.close(() => resolve()); });
      if ([...this.active].some(entry => entry.failedCleanup)) throw fail();
      if (!same(this.directory.path, this.directory, true)) throw fail();
      try {
        const socket = lstatSync(this.socket);
        if (!socket.isSocket() || JSON.stringify([socket.dev, socket.ino, socket.mode]) !== this.socketIdentity) throw fail();
        unlinkSync(this.socket);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw fail(); }
      try { rmdirSync(this.directory.path); } catch { throw fail(); }
      this.closed = true;
    })();
    this.closingWork = work;
    void work.finally(() => { if (!this.closed && this.closingWork === work) this.closingWork = undefined; }).catch(() => {});
    return work;
  }
}

export const createHostShellWrapper = (): Promise<HostShellWrapper> => HostShellWrapper.create();
