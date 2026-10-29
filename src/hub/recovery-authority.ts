/** Host-only conductor continuity. Public operation JSON, actor labels and audits grant nothing.
 * The pin is this registered project's canonical host-owned private key, never a key carried
 * by a record. Like existing host state, it does not resist a same-OS-user process able to
 * replace both key and record. Fresh host policy/privacy proof remains mandatory per effect.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { realPath } from "./project.ts";

export interface ConductorRecoveryBinding {
  schema: 1; operationId: string; peer: string; kind: "restart" | "upgrade";
  projectId: string; projectRoot: string; stateDir: string; sourceInstanceId: string;
  targetRoot: string; targetDigest: string; planFingerprint: string; policyDigest: string; boardDigest: string;
}
export interface VerifiedRecoveryAuthority { readonly binding: Readonly<ConductorRecoveryBinding> }
export class RecoveryAuthorityError extends Error {
  readonly code = "AHUB_RECOVERY_AUTHORITY";
  constructor() { super("conductor recovery authority unavailable; the person runs it in ahub console or a terminal"); this.name = "RecoveryAuthorityError"; }
}
type Current = (binding: Readonly<ConductorRecoveryBinding>) => boolean;
type PrivateRecord = { binding: Readonly<ConductorRecoveryBinding>; retired: boolean; seal: string };
type FileRead = { bytes: Buffer; identity: string };
type Grant = { stateDir: string; directory: string; key: string; record: string; current: Current };
const grants = new WeakMap<VerifiedRecoveryAuthority, Grant>();
const KEYS: readonly (keyof ConductorRecoveryBinding)[] = ["schema", "operationId", "peer", "kind", "projectId", "projectRoot", "stateDir", "sourceInstanceId", "targetRoot", "targetDigest", "planFingerprint", "policyDigest", "boardDigest"];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_RECORD = 16 * 1024;
function refuse(): never { throw new RecoveryAuthorityError(); }
function guarded<T>(work: () => T): T { try { return work(); } catch { return refuse(); } }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) refuse();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== keys.length || keys.some(key => !fields[key] || !Object.hasOwn(fields[key]!, "value"))) refuse();
  return value as Record<string, unknown>;
}
function binding(value: unknown): Readonly<ConductorRecoveryBinding> {
  const row = object(value, KEYS);
  if (row.schema !== 1 || typeof row.operationId !== "string" || !UUID.test(row.operationId) || typeof row.peer !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(row.peer)
    || ["user", "hub", "digest"].includes(row.peer) || row.kind !== "restart" && row.kind !== "upgrade") refuse();
  for (const key of ["projectId", "sourceInstanceId"] as const) if (typeof row[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(row[key])) refuse();
  for (const key of ["projectRoot", "stateDir", "targetRoot"] as const) {
    const value = row[key]; if (typeof value !== "string" || value.length > 4096 || !isAbsolute(value) || /[\p{Cc}]/u.test(value) || realPath(value) !== value) refuse();
  }
  for (const key of ["targetDigest", "planFingerprint", "policyDigest", "boardDigest"] as const) if (typeof row[key] !== "string" || !HASH.test(row[key])) refuse();
  return Object.freeze(Object.fromEntries(KEYS.map(key => [key, row[key]])) as unknown as ConductorRecoveryBinding);
}
function identity(stat: NonNullable<ReturnType<typeof lstatSync>>): string {
  return JSON.stringify([stat.dev, stat.ino, stat.mode, stat.uid, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs]);
}
function directory(stateDir: string): string {
  if (!isAbsolute(stateDir) || realPath(stateDir) !== stateDir) refuse();
  const stat = lstatSync(stateDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !process.getuid || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) refuse();
  // Directory contents change during publication; pin its inode, owner and permission, not mtime.
  return JSON.stringify([stat.dev, stat.ino, stat.uid, stat.mode]);
}
function readPrivate(file: string, maximum: number, exact?: number): FileRead {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || !process.getuid || before.uid !== process.getuid()
      || before.size < 1 || before.size > maximum || exact !== undefined && before.size !== exact) refuse();
    const bytes = Buffer.alloc(before.size + 1); let size = 0;
    while (size < bytes.length) { const n = readSync(fd, bytes, size, bytes.length - size, null); if (!n) break; size += n; }
    if (size !== before.size || identity(fstatSync(fd)) !== identity(before) || identity(lstatSync(file)) !== identity(before) || realPath(file) !== file) refuse();
    return { bytes: bytes.subarray(0, size), identity: identity(before) };
  } finally { closeSync(fd); }
}
const keyPath = (stateDir: string) => join(stateDir, "conductor-recovery.key");
const recordPath = (stateDir: string, operationId: string) => join(stateDir, `conductor-recovery.${operationId}.json`);
function seal(key: Buffer, value: Omit<PrivateRecord, "seal">): string {
  return createHmac("sha256", key).update("agent-hub/conductor-recovery/v1\n").update(JSON.stringify(value)).digest("hex");
}
function encodeRecord(key: Buffer, value: Omit<PrivateRecord, "seal">): Buffer {
  const bytes = Buffer.from(JSON.stringify({ ...value, seal: seal(key, value) })); if (bytes.length > MAX_RECORD) refuse(); return bytes;
}
function checkRecord(stateDir: string, expected: Readonly<ConductorRecoveryBinding>): { key: FileRead; record: FileRead; value: PrivateRecord } {
  const key = readPrivate(keyPath(stateDir), 32, 32), record = readPrivate(recordPath(stateDir, expected.operationId), MAX_RECORD);
  const row = object(JSON.parse(record.bytes.toString("utf8")), ["binding", "retired", "seal"]), bound = binding(row.binding);
  if (typeof row.retired !== "boolean" || typeof row.seal !== "string" || !HASH.test(row.seal) || JSON.stringify(bound) !== JSON.stringify(expected)) refuse();
  const computed = seal(key.bytes, { binding: bound, retired: row.retired });
  if (!timingSafeEqual(Buffer.from(row.seal, "hex"), Buffer.from(computed, "hex"))) refuse();
  return { key, record, value: { binding: bound, retired: row.retired, seal: row.seal } };
}
function fresh(current: Current, value: Readonly<ConductorRecoveryBinding>): void { if (current(value) !== true) refuse(); }
function stillPrivate(file: string, stamp: string): void { if (identity(lstatSync(file)) !== stamp || realPath(file) !== file) refuse(); }
/** Publish a whole private file, never an empty capability visible to another reader. */
function publishNew(stateDir: string, file: string, bytes: Buffer): void {
  const temporary = join(stateDir, `.conductor-recovery.${randomUUID()}.tmp`);
  try { writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 }); linkSync(temporary, file); }
  finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}

/** Call only at the authenticated source's current-conductor boundary. A verifier never creates a key. */
export function issueConductorRecoveryAuthority(stateDir: string, input: ConductorRecoveryBinding, current: () => boolean): void {
  return guarded(() => {
    const value = binding(input), pin = directory(stateDir); if (value.stateDir !== stateDir) refuse(); fresh(current, value);
    try { readPrivate(keyPath(stateDir), 32, 32); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fresh(current, value); publishNew(stateDir, keyPath(stateDir), randomBytes(32));
    }
    const key = readPrivate(keyPath(stateDir), 32, 32);
    try {
      const existing = checkRecord(stateDir, value); if (existing.value.retired) refuse();
      fresh(current, value); stillPrivate(keyPath(stateDir), key.identity); stillPrivate(recordPath(stateDir, value.operationId), existing.record.identity);
      if (directory(stateDir) !== pin) refuse(); return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    fresh(current, value); if (directory(stateDir) !== pin) refuse(); stillPrivate(keyPath(stateDir), key.identity);
    publishNew(stateDir, recordPath(stateDir, value.operationId), encodeRecord(key.bytes, { binding: value, retired: false }));
    fresh(current, value); if (directory(stateDir) !== pin) refuse();
  });
}
/** The host supplies expected registry/package binding and a fresh live-RPC or conservative offline policy check. */
export function authorizeConductorRecovery(stateDir: string, expected: ConductorRecoveryBinding, current: Current): VerifiedRecoveryAuthority {
  return guarded(() => {
    const value = binding(expected), pin = directory(stateDir); if (value.stateDir !== stateDir) refuse();
    const proof = checkRecord(stateDir, value); if (proof.value.retired) refuse(); fresh(current, value);
    stillPrivate(keyPath(stateDir), proof.key.identity); stillPrivate(recordPath(stateDir, value.operationId), proof.record.identity); if (directory(stateDir) !== pin) refuse();
    const authority = Object.freeze({ binding: value });
    grants.set(authority, { stateDir, directory: pin, key: proof.key.identity, record: proof.record.identity, current });
    return authority;
  });
}
/** Recheck immediately before every host effect, and after any awaited work. */
export function assertConductorRecovery(authority: VerifiedRecoveryAuthority): void {
  return guarded(() => {
    const grant = grants.get(authority); if (!grant) refuse();
    if (directory(grant.stateDir) !== grant.directory) refuse();
    const proof = checkRecord(grant.stateDir, authority.binding);
    if (proof.value.retired || proof.key.identity !== grant.key || proof.record.identity !== grant.record) refuse();
    fresh(grant.current, authority.binding);
    stillPrivate(keyPath(grant.stateDir), grant.key); stillPrivate(recordPath(grant.stateDir, authority.binding.operationId), grant.record); if (directory(grant.stateDir) !== grant.directory) refuse();
  });
}
/** Root calls only at an authorized terminal phase. A sealed retirement never reactivates through issuance. */
export function retireConductorRecovery(authority: VerifiedRecoveryAuthority): void {
  return guarded(() => {
    assertConductorRecovery(authority);
    const grant = grants.get(authority)!;
    const key = readPrivate(keyPath(grant.stateDir), 32, 32), file = recordPath(grant.stateDir, authority.binding.operationId);
    const temporary = join(grant.stateDir, `.conductor-recovery.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, encodeRecord(key.bytes, { binding: authority.binding, retired: true }), { flag: "wx", mode: 0o600 });
      assertConductorRecovery(authority); renameSync(temporary, file);
    } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
    grants.delete(authority);
  });
}
