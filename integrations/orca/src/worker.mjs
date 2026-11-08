// agent-hub companion for Orca: the trusted worker (#1198 O1). `createCompanion` holds every decision and takes its ports as arguments, so the tests run it against the O0 fixtures; the
// default export is the thin `activate(orca)` that Orca calls, wired to the real host, the real filesystem and the real child process. See README.md for what is and is not proven.
import { spawn } from "node:child_process";
import { classifyStatusRun, projectStatus } from "./status.mjs";
import { REMOTE_COMMAND, REFUSALS, CLI_LIMITS, ENTRY_KINDS, bindWorkspace, canonicalizeHere, entryFor, parseSettings, readInventory, readSnapshot, refuse, runCli, terminalCommand, verifyBinding } from "./companion.mjs";

const HANDLERS = Object.freeze(["workspaces.list", "workspace.bind", "entry.open", "status.read"]);
/** What `ahub` prints, as its first words, when no hub runs for the project (src/hub/control-client.ts). Tested as a prefix and never returned. */
const NO_HUB_PREFIX = "ahub: no hub running for ";

/** Strict input: exactly these keys, each a plain own data property. A panel is the plugin's own code, but a request is still untrusted until read. */
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
  const own = Object.getOwnPropertyNames(value);
  if (own.length !== keys.length || !keys.every(key => own.includes(key))) return undefined;
  if (own.some(key => !("value" in Object.getOwnPropertyDescriptor(value, key)))) return undefined;
  return value;
}

/**
 * @param {{ host: { call(method: string, params?: unknown): Promise<any>, has(method: string): boolean },
 *           readSettings(): Promise<unknown>, spawnCli(call: any): Promise<any>, canonicalize?: (path: string) => string, log?: (line: string) => void }} ports
 */
export function createCompanion(ports) {
  const canonicalize = ports.canonicalize ?? canonicalizeHere;
  // The only log lines: a handler name and a closed code. Never a path, a workspace name, a CLI line or a link.
  const log = code => { try { ports.log?.(code); } catch { /* logging never changes an outcome */ } };
  const context = async () => {
    let raw;
    try { raw = await ports.readSettings(); } catch { raw = {}; }
    return { settings: parseSettings(raw), canonicalize, platform: ports.platform ?? process.platform };
  };
  const inventory = async () => {
    if (!ports.host.has("workspace.list")) return undefined;
    try { return await ports.host.call("workspace.list"); } catch { return undefined; }
  };
  const done = (handler, outcome) => { log(`${handler}: ${outcome.ok ? "ok" : outcome.refusal}`); return outcome; };

  async function list() {
    const ctx = await context();
    if (ctx.settings.ahubInvalid) return done("workspaces.list", refuse("invalid_setting"));
    const raw = await inventory();
    if (raw === undefined) return done("workspaces.list", refuse(ports.host.has("workspace.list") ? "inventory_unavailable" : "not_offered"));
    const read = readInventory(raw);
    if (!read.ok) return done("workspaces.list", read);
    // Display only: names and branches label a row, they never select one. A row that cannot be bound says why, so it can still be seen but not chosen.
    const rows = read.rows.map(row => {
      const bound = bindWorkspaceRow(row, ctx);
      return { id: row.id, name: row.name, branch: row.branch, kind: row.kind, hostId: row.hostId, root: bound.ok ? bound.binding.root : row.path, selectable: bound.ok, ...(bound.ok ? {} : { refusal: bound.refusal, guidance: bound.guidance }) };
    });
    return done("workspaces.list", { ok: true, rows });
  }
  const bindWorkspaceRow = (row, ctx) => bindWorkspace({ workspaces: [row], truncated: false }, row.id, ctx);

  async function bind(input) {
    const value = exact(input, ["id"]);
    if (!value) return done("workspace.bind", refuse("bad_request"));
    const ctx = await context();
    const raw = await inventory();
    if (raw === undefined) return done("workspace.bind", refuse("inventory_unavailable"));
    const bound = bindWorkspace(raw, value.id, ctx);
    return done("workspace.bind", bound.ok ? { ok: true, binding: bound.binding } : bound);
  }

  async function open(input) {
    const value = exact(input, ["kind", "snapshot"]);
    if (!value || !ENTRY_KINDS.includes(value.kind) || !readSnapshot(value.snapshot)) return done("entry.open", refuse("bad_request"));
    const ctx = await context();
    if (ctx.settings.ahubInvalid) return done("entry.open", refuse("invalid_setting"));
    // Re-read a complete inventory and require the same id, host, kind and real root as the person selected, before anything is run or opened.
    const raw = await inventory();
    if (raw === undefined) return done("entry.open", refuse("inventory_unavailable"));
    const verified = verifyBinding(value.snapshot, raw, ctx);
    // A workspace on another host is never run here and its loopback link is never opened here: the person gets the existing remote console command to run there.
    if (!verified.ok) return done("entry.open", verified.refusal === "remote" ? { ...verified, command: REMOTE_COMMAND } : verified);
    const entry = entryFor(value.kind, verified.binding, ctx.settings);
    if (entry.via === "cli") {
      const result = await runCli(ports.spawnCli, entry);
      return done("entry.open", result);
    }
    // Console and family console: show the workspace, then create a terminal in it that runs fixed words. Orca creates it in the background, so the person still selects its tab.
    if (!ports.host.has("workspace.open") || !ports.host.has("terminal.create")) return done("entry.open", { ...refuse("not_offered"), command: terminalCommand(entry.argv) });
    try {
      await ports.host.call("workspace.open", { workspaceId: entry.workspaceId });
      // Opening the workspace yields to the host. Its identity or local-host settings may change during that await.
      const freshContext = await context();
      if (freshContext.settings.ahubInvalid) return done("entry.open", refuse("invalid_setting"));
      const freshInventory = await inventory();
      if (freshInventory === undefined) return done("entry.open", refuse("inventory_unavailable"));
      const fresh = verifyBinding(verified.binding, freshInventory, freshContext);
      if (!fresh.ok) return done("entry.open", fresh);
      const terminal = entryFor(value.kind, fresh.binding, freshContext.settings);
      await ports.host.call("terminal.create", { workspaceId: terminal.workspaceId, title: terminal.title, command: terminalCommand(terminal.argv) });
    } catch { return done("entry.open", { ...refuse("not_offered"), command: terminalCommand(entry.argv) }); }
    return done("entry.open", { ok: true, status: "terminal_created" });
  }

  /**
   * Read the project's public status, on a user action only: re-verify the exact binding, then run `ahub status --json` (the folder is the working directory, nothing else) and project a closed
   * allowlist of its fields. No poller, no transcript read, no write. Offline, an older hub and a failed run stay distinct, and nothing of the output or stderr is returned.
   */
  async function readStatus(input) {
    const value = exact(input, ["snapshot"]);
    if (!value || !readSnapshot(value.snapshot)) return done("status.read", refuse("bad_request"));
    const ctx = await context();
    if (ctx.settings.ahubInvalid) return done("status.read", refuse("invalid_setting"));
    const raw = await inventory();
    if (raw === undefined) return done("status.read", refuse("inventory_unavailable"));
    const verified = verifyBinding(value.snapshot, raw, ctx);
    if (!verified.ok) return done("status.read", verified);
    let result;
    try { result = await ports.spawnCli({ executable: ctx.settings.ahubPath ?? "ahub", argv: ["status", "--json"], cwd: verified.binding.root, hostId: verified.binding.hostId, ...CLI_LIMITS }); }
    catch (error) { return done("status.read", refuse(error && typeof error === "object" && error.code === "ENOENT" ? "cli_missing" : "cli_failed")); }
    const ran = classifyStatusRun(result, result?.stderrSaysNoHub === true);
    if (ran.kind === "offline") return done("status.read", { ok: true, state: "offline", ...fixedReading() });
    if (ran.kind !== "ok") return done("status.read", refuse(ran.kind === "timeout" ? "cli_timeout" : ran.kind === "too_large" ? "cli_output_too_large" : "cli_failed"));
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch { return done("status.read", refuse("unrecognized_output")); }
    // `ahub status --json` prints the status object itself.
    const fetchedAt = Date.now();
    const reading = projectStatus(parsed, fetchedAt, fetchedAt);
    return done("status.read", reading.ok ? { ...reading, fetchedAt } : reading);
  }
  const fixedReading = () => ({ version: null, tasks: null, peers: null, missing: [], ageMs: 0, fetchedAt: Date.now() });

  return { list, bind, open, status: readStatus, handlers: { "workspaces.list": list, "workspace.bind": bind, "entry.open": open, "status.read": readStatus } };
}

/**
 * The real child-process port: fixed executable and argv, no shell, a hard timeout, a byte cap, and no ORCA_ variable passed on. The child leads its own process group so a timeout kills
 * everything it started (a script's own children keep the pipe open, and would otherwise outlive the answer), and the answer is settled on the timer, not on the pipe closing.
 */
export function realSpawnCli(call) {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ORCA_")));
    let child;
    try { child = spawn(call.executable, [...call.argv], { cwd: call.cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: false, detached: process.platform !== "win32" }); }
    catch (error) { reject(error); return; }
    let out = "", used = 0, truncated = false, timedOut = false, settled = false;
    const stop = () => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    };
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const take = chunk => {
      const room = call.maxOutputBytes - used;
      if (room <= 0) { truncated = true; stop(); return; }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.length > room) { truncated = true; out += bytes.subarray(0, room).toString("utf8"); used += room; stop(); return; }
      out += bytes.toString("utf8"); used += bytes.length;
    };
    child.stdout.on("data", take);
    // stderr is never kept. Only its first 64 bytes are tested, once, against ahub's own fixed no-hub prefix, and the answer is a boolean: stderr can hold a path, and nothing needs it.
    let head = "";
    child.stderr.on("data", chunk => { if (head.length < 64) head += Buffer.from(chunk).toString("utf8", 0, 64 - head.length); });
    const timer = setTimeout(() => { timedOut = true; stop(); finish({ stdout: "", stderr: "", exitCode: null, timedOut: true, truncated }); }, call.timeoutMs);
    child.once("error", error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.once("close", code => finish({ stdout: out, stderr: "", exitCode: timedOut ? null : code, timedOut, truncated, stderrSaysNoHub: head.startsWith(NO_HUB_PREFIX) }));
  });
}

/** Orca calls this once when the worker starts. */
export default async function activate(orca) {
  const companion = createCompanion({
    host: { call: (method, params) => orca.host.call(method, params), has: method => orca.host.has(method) },
    readSettings: async () => (await orca.host.call("settings.get")).settings,
    spawnCli: realSpawnCli,
    log: line => orca.log(line),
  });
  const disposables = HANDLERS.map(name => orca.panels.handle(name, input => companion.handlers[name](input)));
  void REFUSALS; void CLI_LIMITS;
  return { dispose() { for (const d of disposables) d?.dispose?.(); } };
}

export async function deactivate() { /* nothing is held: no state, no child, no timer */ }
