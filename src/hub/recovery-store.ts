import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { hubHome } from "./project.ts";

export const operationIdPattern = /^[a-f0-9-]{36}$/;
export function operationPath(id: string, home = hubHome()): string {
  if (!operationIdPattern.test(id)) throw new Error("invalid recovery operation ID");
  return join(home, "recovery", `${id}.json`);
}

/** Private state only. Never put tokens or transcript/message bodies in an operation receipt. */
export function atomicPrivateJSON(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

export function readOperation<T>(id: string, home = hubHome()): T {
  return JSON.parse(readFileSync(operationPath(id, home), "utf8")) as T;
}

export function writeOperation(id: string, value: unknown, home = hubHome()): void {
  mkdirSync(join(home, "recovery"), { recursive: true, mode: 0o700 });
  atomicPrivateJSON(operationPath(id, home), value);
}

export function recoveryLock(home = hubHome()): string | undefined {
  const file = join(home, "recovery.lock");
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!operationIdPattern.test(data.operationId)) throw new Error("invalid recovery lock");
    return data.operationId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("recovery lock is unreadable; inspect it before changing runtimes", { cause: error });
  }
}

export function acquireRecoveryLock(id: string, home = hubHome()): void {
  operationPath(id, home);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const existing = recoveryLock(home);
  if (existing === id) return;
  try { writeFileSync(join(home, "recovery.lock"), JSON.stringify({ operationId: id }), { mode: 0o600, flag: "wx" }); }
  catch { throw new Error(`another recovery operation owns this machine: ${recoveryLock(home) ?? "unknown"}`); }
}

export function releaseRecoveryLock(id: string, home = hubHome()): void {
  if (recoveryLock(home) !== id) throw new Error("recovery lock ownership changed");
  rmSync(join(home, "recovery.lock"));
}

/** Used by CLI and manager lifecycle paths. A detached operation carries its own ID. */
export function assertLifecycleAvailable(): void {
  const owner = recoveryLock();
  if (owner && process.env.AGENTHUB_RECOVERY_OPERATION !== owner) throw new Error(activeOperation(owner));
}

/**
 * #215: the command line of an operation's own coordinator, which has every recovery command. Mid-upgrade the global
 * `ahub` may still be the older release, so next actions and errors never name it bare. A coordinator from before #215
 * lacks dispose, refuses abort and resume on a lapsed hold and shows no next actions: then the running release is
 * named, which does all of that in-process (its resume still runs the operation's own runner).
 */
export function recoveryCommand(op: { id: string; sourceRoot?: string }, action: "status" | "resume" | "abort" | "dispose", flags = ""): string {
  const entry = !op.sourceRoot ? undefined : coordinatorCurrent(op.sourceRoot) ? join(op.sourceRoot, "src/cli/main.js") : join(import.meta.dir, "../cli/main.js");
  const cli = !entry ? "ahub" : /^[\w./@+-]+$/.test(entry) ? `bun ${entry}` : `bun '${entry.replace(/'/g, `'\\''`)}'`;
  return `${cli} recovery ${action} ${op.id}${flags ? ` ${flags}` : ""}`;
}

/**
 * Whether a coordinator has the #215 recovery commands (dispose, re-preparation, next actions).
 * ponytail: a text sniff of its upgrade.ts; a rename or re-export reads as an older coordinator (the running release is
 * then named, which is safe). Upgrade path: a capability list in package.json, shared with targetReadsWaivers.
 */
export function coordinatorCurrent(sourceRoot: string): boolean {
  try { return readFileSync(join(sourceRoot, "src/cli/upgrade.ts"), "utf8").includes("export async function disposeRecovery"); } catch { return false; }
}

/** What a lifecycle command refused by the lock says: the operation's own status command, which lists what to do next. */
export function activeOperation(owner: string, home = hubHome()): string {
  let op: { id: string; sourceRoot?: string } = { id: owner };
  try { op = { id: owner, sourceRoot: readOperation<{ sourceRoot?: string }>(owner, home).sourceRoot }; } catch { /* no readable receipt: the bare commands are all there is */ }
  // The choices depend on the operation's state (a partway stop-and-archive refuses resume): status lists them.
  return `recovery operation ${owner} is active; ${recoveryCommand(op, "status")} lists what to do next`;
}

/**
 * The pid of the runner that holds the operation now, read without claiming it (#215 status): undefined when none does,
 * "unknown" when the record cannot be read (unreadable, or still locked after the busy timeout), never "none" then.
 */
export function recoveryRunner(id: string, home = hubHome()): number | "unknown" | undefined {
  const path = `${operationPath(id, home)}.runner.db`;
  if (!existsSync(path)) return undefined;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    db.run("PRAGMA busy_timeout = 3000"); // a claim in progress must not read as no runner
    const row = db.query("SELECT pid FROM runner WHERE slot = 1").get() as { pid: number } | null;
    if (!row) return undefined;
    if (!Number.isSafeInteger(row.pid) || row.pid < 1) return "unknown";
    try { process.kill(row.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined; }
    return row.pid;
  } catch { return "unknown"; } finally { db?.close(); }
}

/** An exclusive runner claim. Never steal a live or uncertain owner on resume. */
export function claimRunner(id: string, home = hubHome()): () => void {
  const path = `${operationPath(id, home)}.runner.db`;
  const db = new Database(path, { create: true });
  chmodSync(path, 0o600);
  const nonce = randomUUID();
  try {
    db.run("PRAGMA busy_timeout = 3000");
    db.run("CREATE TABLE IF NOT EXISTS runner (slot INTEGER PRIMARY KEY, pid INTEGER NOT NULL, nonce TEXT NOT NULL)");
    db.transaction(() => {
      const row = db.query("SELECT pid FROM runner WHERE slot = 1").get() as { pid: number } | null;
      if (row) {
        if (!Number.isSafeInteger(row.pid) || row.pid < 1) throw new Error("invalid recovery runner ownership");
        try { process.kill(row.pid, 0); throw new Error(`recovery runner ${row.pid} is still alive`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      db.query("INSERT OR REPLACE INTO runner (slot, pid, nonce) VALUES (1, ?, ?)").run(process.pid, nonce);
    }).immediate();
  } catch (error) { db.close(); throw error; }
  return () => {
    db.query("DELETE FROM runner WHERE slot = 1 AND nonce = ?").run(nonce);
    db.close();
  };
}
