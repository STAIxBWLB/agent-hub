// agent-hub companion for Orca: the trusted worker (#1198 O1). `createCompanion` holds every decision and takes its ports as arguments, so the tests run it against the O0 fixtures; the
// default export is the thin `activate(orca)` that Orca calls, wired to the real host, the real filesystem and the real child process. See README.md for what is and is not proven.
import { spawn } from "node:child_process";
import { REFUSALS, CLI_LIMITS, ENTRY_KINDS, bindWorkspace, canonicalizeHere, entryFor, parseSettings, readInventory, readSnapshot, refuse, runCli, terminalCommand, verifyBinding } from "./companion.mjs";

const HANDLERS = Object.freeze(["workspaces.list", "workspace.bind", "entry.open"]);

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
    return { settings: parseSettings(raw), canonicalize };
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
    if (!verified.ok) return done("entry.open", verified);
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

  return { list, bind, open, handlers: { "workspaces.list": list, "workspace.bind": bind, "entry.open": open } };
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
    child.stderr.on("data", () => { /* stderr is not read: it may hold a path or a hub message, and nothing here needs it */ });
    const timer = setTimeout(() => { timedOut = true; stop(); finish({ stdout: "", stderr: "", exitCode: null, timedOut: true, truncated }); }, call.timeoutMs);
    child.once("error", error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.once("close", code => finish({ stdout: out, stderr: "", exitCode: timedOut ? null : code, timedOut, truncated }));
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
