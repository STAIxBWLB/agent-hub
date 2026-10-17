import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, renameSync, unlinkSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { realPath } from "./project.ts";
import { atomicPrivateJSON, operationIdPattern } from "./recovery-store.ts";

export const RECOVERY_CONTINUITY_BUSY_TIMEOUT_MS = 3000;
const MAX_BOOKMARK_BYTES = 16 * 1024;
const BOOKMARK = "recovery-continuity.json", LOCK = "recovery-continuity-lock.db";

export interface RecoveryContinuityBookmark {
  schema: 1;
  operationId: string;
  projectId: string;
  projectRoot: string;
  at: number;
  pi: { sessionId: string; sessionFile?: string; backend?: "auto" | "dgx" | "mlx"; model?: string };
}
export interface RecoveryContinuityExpected { projectId: string; projectRoot: string; operationId?: string }
export type ContinuityRetirementReason = "authenticated_session_changed" | "resume_unavailable" | "recovery_released";
export type RecoveryContinuityReading =
  | { state: "absent" }
  | { state: "invalid"; reason: "unavailable" | "invalid_shape" | "invalid_path" | "identity_mismatch" | "oversized" }
  | { state: "ready"; bookmark: RecoveryContinuityBookmark; digest: string };

const unavailable = (): never => { throw new Error("recovery continuity metadata unavailable or invalid"); };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key));
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const id = (value: unknown): value is string => text(value, 256) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const absolute = (value: unknown): value is string => text(value, 4096) && isAbsolute(value) && normalize(value) === value;
function canonicalRoot(value: unknown): string {
  if (!absolute(value)) return unavailable();
  const root = realPath(value);
  if (!lstatSync(root).isDirectory()) return unavailable();
  return root;
}
function checked(value: unknown): RecoveryContinuityBookmark {
  if (!record(value) || !keys(value, ["schema", "operationId", "projectId", "projectRoot", "at", "pi"]) || value.schema !== 1 || typeof value.operationId !== "string" || !operationIdPattern.test(value.operationId) || !id(value.projectId) || !absolute(value.projectRoot) || !Number.isSafeInteger(value.at) || (value.at as number) < 0) return unavailable();
  const pi = value.pi;
  if (!record(pi) || !keys(pi, ["sessionId", "sessionFile", "backend", "model"]) || !id(pi.sessionId) || pi.sessionFile !== undefined && !absolute(pi.sessionFile) || pi.backend !== undefined && !["auto", "dgx", "mlx"].includes(String(pi.backend)) || pi.model !== undefined && !text(pi.model, 4096)) return unavailable();
  const projectRoot = canonicalRoot(value.projectRoot);
  return { schema: 1, operationId: value.operationId, projectId: value.projectId, projectRoot, at: value.at as number,
    pi: { sessionId: pi.sessionId, ...(pi.sessionFile === undefined ? {} : { sessionFile: pi.sessionFile as string }), ...(pi.backend === undefined ? {} : { backend: pi.backend as "auto" | "dgx" | "mlx" }), ...(pi.model === undefined ? {} : { model: pi.model as string }) } };
}
function stateDirectory(stateDir: string): void {
  if (!absolute(stateDir)) return unavailable();
  const stat = lstatSync(stateDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return unavailable();
}
function privateFile(path: string, missing = false): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077) return unavailable();
  } catch (error) { if (!missing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Read one bounded project-local file; invalid evidence is deliberately distinct from no bookmark. */
export function readRecoveryContinuity(stateDir: string, expected: RecoveryContinuityExpected): RecoveryContinuityReading {
  let fd: number | undefined;
  let expectedRoot: string;
  try { expectedRoot = canonicalRoot(expected.projectRoot); }
  catch { return { state: "invalid", reason: "identity_mismatch" }; }
  try {
    stateDirectory(stateDir);
    const file = join(stateDir, BOOKMARK);
    privateFile(file);
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.mode & 0o077) return { state: "invalid", reason: "invalid_path" };
    if (stat.size > MAX_BOOKMARK_BYTES) return { state: "invalid", reason: "oversized" };
    const buffer = Buffer.alloc(MAX_BOOKMARK_BYTES + 1);
    let length = 0;
    while (length < buffer.length) { const n = readSync(fd, buffer, length, buffer.length - length, null); if (!n) break; length += n; }
    if (length > MAX_BOOKMARK_BYTES) return { state: "invalid", reason: "oversized" };
    const bytes = buffer.subarray(0, length);
    let bookmark: RecoveryContinuityBookmark;
    try {
      const raw: unknown = JSON.parse(bytes.toString("utf8"));
      bookmark = checked(raw);
      if (!record(raw) || raw.projectRoot !== bookmark.projectRoot) return { state: "invalid", reason: "invalid_path" };
    } catch { return { state: "invalid", reason: "invalid_shape" }; }
    if (!id(expected.projectId) || expected.operationId !== undefined && !operationIdPattern.test(expected.operationId) || bookmark.projectId !== expected.projectId || bookmark.projectRoot !== expectedRoot || expected.operationId !== undefined && bookmark.operationId !== expected.operationId) return { state: "invalid", reason: "identity_mismatch" };
    return { state: "ready", bookmark, digest: digest(bytes) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "invalid", reason: "unavailable" };
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** A crash releases SQLite's lock; no lockfile ownership or stale-process inference is needed. */
function withWriter<T>(stateDir: string, action: () => T): T {
  stateDirectory(stateDir);
  const file = join(stateDir, LOCK);
  privateFile(file, true);
  for (const suffix of ["-journal", "-wal", "-shm"]) privateFile(file + suffix, true);
  const db = new Database(file, { create: true });
  db.run(`PRAGMA busy_timeout = ${RECOVERY_CONTINUITY_BUSY_TIMEOUT_MS}`);
  try {
    chmodSync(file, 0o600);
    db.run("BEGIN IMMEDIATE");
    try { return action(); } finally { db.run("ROLLBACK"); }
  } finally { db.close(); }
}

/** Called only after the coordinator confirmed its target stopped and archived that operation's snapshot. */
export function writeRecoveryContinuity(stateDir: string, value: RecoveryContinuityBookmark): { digest: string } {
  const bookmark = checked(value), bytes = Buffer.from(JSON.stringify(bookmark, null, 2) + "\n");
  if (bytes.length > MAX_BOOKMARK_BYTES) return unavailable();
  return withWriter(stateDir, () => {
    privateFile(join(stateDir, BOOKMARK), true);
    atomicPrivateJSON(join(stateDir, BOOKMARK), bookmark);
    return { digest: digest(bytes) };
  });
}

/** Consume only the exact bookmark whose recorded session has authenticated; stale receipts retain newer data. */
export function consumeRecoveryContinuity(stateDir: string, expected: RecoveryContinuityExpected & { operationId: string; digest: string }): boolean {
  if (!operationIdPattern.test(expected.operationId) || !/^[a-f0-9]{64}$/.test(expected.digest)) return false;
  return withWriter(stateDir, () => {
    const current = readRecoveryContinuity(stateDir, { projectId: expected.projectId, projectRoot: expected.projectRoot });
    if (current.state === "absent") return false;
    if (current.state === "invalid") return unavailable();
    if (current.bookmark.operationId !== expected.operationId || current.digest !== expected.digest) return false;
    unlinkSync(join(stateDir, BOOKMARK));
    return true;
  });
}

/** Preserve superseded evidence privately; only a matching project/operation/digest may retire the active file. */
export function retireRecoveryContinuity(
  stateDir: string,
  expected: RecoveryContinuityExpected & { operationId: string; digest: string },
  reason: ContinuityRetirementReason,
): { retired: boolean; archive?: string } {
  if (!["authenticated_session_changed", "resume_unavailable", "recovery_released"].includes(reason)) return unavailable();
  if (!operationIdPattern.test(expected.operationId) || !/^[a-f0-9]{64}$/.test(expected.digest)) return { retired: false };
  return withWriter(stateDir, () => {
    const current = readRecoveryContinuity(stateDir, { projectId: expected.projectId, projectRoot: expected.projectRoot });
    if (current.state === "absent") return { retired: false };
    if (current.state === "invalid") return unavailable();
    if (current.bookmark.operationId !== expected.operationId || current.digest !== expected.digest) return { retired: false };
    // A unique destination preserves an earlier retirement even when the same bookmark was explicitly restored.
    const archive = join(stateDir, `recovery-continuity.retired.${reason}.${current.digest}.${randomUUID()}.json`);
    try { lstatSync(archive); return unavailable(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    renameSync(join(stateDir, BOOKMARK), archive);
    chmodSync(archive, 0o600);
    return { retired: true, archive };
  });
}
