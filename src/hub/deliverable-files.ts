import { constants, lstatSync, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { guardPath } from "../local/tools.ts";
import { isDenied } from "../local/deny.ts";
import { isHubWritePath } from "./permission-mode.ts";
import { realPath } from "./project.ts";
import { insideRoot } from "./path-policy.ts";
import { DELIVERABLE_LIMITS, deliverableId, parseDeliverableClaims, type DeliverableClaim, type DeliverableRecord, type DeliverableState } from "./deliverables.ts";

/**
 * The only code that opens a deliverable (#509a). The hub hashes the bytes itself; nothing an agent says about a file is used.
 *
 * - Containment: `guardPath` (read mode) resolves the path with `realPath`, refuses anything outside the project, on the secrets denylist or
 *   through a dangling link, and returns the resolved path. The file is then opened without following a final link and its identity
 *   (device, inode, size and mtime: Linux reuses an inode number at once) is compared with what was checked, so a path swapped between the check and the open is refused, not read.
 * - Plain folders: nothing here needs git, a PR, a snapshot or a lifecycle receipt.
 * - Bounded and non-blocking: a regular file only, at most `fileBytes` each and `totalBytes` per call, read in 1 MiB chunks with an await
 *   between them so a large file never stalls the daemon. A file that changes while it is read is refused, never recorded half-read.
 */

export interface DeliverablePorts {
  cwd: string;
  /** The project's secrets denylist (`local.deny`). */
  deny: readonly string[];
  /** Whether a file belongs to a PII task or matches `pii.paths`: its record is private. */
  private(path: string): boolean;
}

const CHUNK = 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export class DeliverableRefusal extends Error {}

/**
 * Test seam: runs between vetting a path and opening it, the window a swapped file would use. Never set outside tests; no config or tool reaches it.
 * ponytail: a hook, not a lock. The open uses O_NOFOLLOW and a device/inode comparison, which is what this seam lets a test attack.
 */
export const deliverableHooks: { beforeOpen?: (path: string) => void } = {};
const refuse = (path: string, why: string): never => { throw new DeliverableRefusal(`deliverable ${path}: ${why}`); };

interface Located { real: string; stat: Stats }

/** Resolve and vet one path. Throws `DeliverableRefusal` with a reason that names the given relative path, never a resolved one. */
function locate(path: string, ports: DeliverablePorts): Located {
  let real: string;
  try { real = guardPath({ cwd: ports.cwd, deny: [...ports.deny], readOnly: [] }, path, "read"); }
  catch (error) { return refuse(path, (error as Error).message.replace(path, "the path").slice(0, 160)); }
  // guardPath's read mode keeps secrets out but not the hub's own state: `.agenthub` and `.git` are refused here, so no hash of a config, token or
  // git file ever reaches a record (a hash of a low-entropy file confirms guesses). Compared on the resolved path, folded like the write guard.
  let root: string;
  try { root = realPath(ports.cwd); } catch { return refuse(path, "the project root cannot be resolved"); }
  // Judged on the resolved name and on the name the caller gave (#552, the #541 class): Bun's realpath can name another hardlink of the same file.
  const typed = relative(root, resolve(root, path));
  const inside = insideRoot(typed);
  if (isHubWritePath(relative(root, real)) || inside && isHubWritePath(typed)) return refuse(path, "the hub's own state is not a deliverable");
  if (inside && isDenied(typed, [...ports.deny])) return refuse(path, "the path is on the secrets denylist");
  let stat: Stats;
  try { stat = lstatSync(real); }
  catch (error) { return refuse(path, (error as NodeJS.ErrnoException).code === "ENOENT" ? "the file does not exist" : "the file cannot be read"); }
  if (!stat.isFile()) return refuse(path, "not a regular file");
  if (stat.size > DELIVERABLE_LIMITS.fileBytes) return refuse(path, `larger than ${DELIVERABLE_LIMITS.fileBytes / (1024 * 1024)} MiB`);
  return { real, stat };
}

const sameFile = (a: Pick<Stats, "dev" | "ino">, b: Pick<Stats, "dev" | "ino">) => a.dev === b.dev && a.ino === b.ino;

/** sha256 and size of one vetted file, or a refusal. */
async function digest(path: string, found: Located, read?: { limit: number; current: () => void }): Promise<{ sha256: string; bytes: number; data?: Uint8Array; identity: { dev: number; ino: number } }> {
  let handle;
  deliverableHooks.beforeOpen?.(path);
  try { handle = await open(found.real, constants.O_RDONLY | NOFOLLOW); }
  catch { return refuse(path, "the file cannot be opened"); }
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameFile(before, found.stat) || before.size !== found.stat.size || before.mtimeMs !== found.stat.mtimeMs) return refuse(path, "the file changed while it was being checked");
    if (read && before.ctimeMs !== found.stat.ctimeMs) return refuse(path, "the file changed while it was being checked");
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(CHUNK), chunks: Uint8Array[] = [];
    const limit = read?.limit ?? DELIVERABLE_LIMITS.fileBytes;
    let bytes = 0;
    for (;;) {
      read?.current();
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, bytes);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > limit) return refuse(path, "larger than the size limit");
      hash.update(buffer.subarray(0, bytesRead));
      if (read) chunks.push(Uint8Array.from(buffer.subarray(0, bytesRead)));
    }
    const after = await handle.stat();
    if (after.size !== bytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return refuse(path, "the file changed while it was being read");
    if (read && (!sameFile(after, before) || after.ctimeMs !== before.ctimeMs)) return refuse(path, "the file changed while it was being read");
    read?.current();
    return { sha256: hash.digest("hex"), bytes, identity: { dev: before.dev, ino: before.ino }, ...(read ? { data: Buffer.concat(chunks, bytes) } : {}) };
  } finally { await handle.close().catch(() => {}); }
}

export interface GuardedDeliverableRead {
  data: Uint8Array;
  sha256: string;
  bytes: number;
  /** Host-only physical identity; never stored as a visual record or used as content proof. */
  identity: { dev: number; ino: number };
  /** Call-scoped stamps for a later batch fence, not persisted content proof. */
  stamps?: { size: number; mtimeMs: number; ctimeMs: number };
}

/** Reuse the deliverable guard and opened-descriptor reader; this export refuses private files before reading any bytes. */
export async function readGuardedDeliverable(path: string, ports: DeliverablePorts, limit = DELIVERABLE_LIMITS.fileBytes): Promise<GuardedDeliverableRead> {
  parseDeliverableClaims([{ path, format: "bin" }]);
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > DELIVERABLE_LIMITS.fileBytes) return refuse(path, "invalid read limit; use the deliverable size limit or a smaller bound");
  const privacy = (real?: string) => {
    try {
      if (ports.private(path) || real !== undefined && ports.private(relative(realPath(ports.cwd), real))) return refuse(path, "private file; choose a public project file and retry");
    } catch { return refuse(path, "private file or unavailable privacy policy; choose a public project file and retry"); }
  };
  privacy();
  const found = locate(path, ports); privacy(found.real);
  if (found.stat.size > limit) return refuse(path, "larger than the read limit; choose a smaller file and retry");
  const result = await digest(path, found, { limit, current: () => privacy(found.real) });
  const current = locate(path, ports); privacy(current.real);
  if (!sameFile(current.stat, result.identity) || current.stat.size !== found.stat.size || current.stat.mtimeMs !== found.stat.mtimeMs || current.stat.ctimeMs !== found.stat.ctimeMs)
    return refuse(path, "the file changed while it was being read; retry with a stable file");
  const observed = { data: result.data!, sha256: result.sha256, bytes: result.bytes, identity: result.identity };
  Object.defineProperty(observed, "stamps", { value: { size: current.stat.size, mtimeMs: current.stat.mtimeMs, ctimeMs: current.stat.ctimeMs }, enumerable: false });
  return observed;
}

/** Refuse a bad claim before any effect, without hashing: the path must be inside the project, allowed, and a regular file of a usable size. */
export function vetDeliverables(claims: readonly DeliverableClaim[], ports: DeliverablePorts): void {
  let total = 0;
  for (const claim of claims) total += locate(claim.path, ports).stat.size;
  if (total > DELIVERABLE_LIMITS.totalBytes) throw new DeliverableRefusal(`deliverables: together larger than ${DELIVERABLE_LIMITS.totalBytes / (1024 * 1024)} MiB`);
}

/** Hash the claimed files now. Any refusal refuses the whole call: there is no partial record. */
export async function hashDeliverables(claims: readonly DeliverableClaim[], ports: DeliverablePorts): Promise<DeliverableRecord[]> {
  const found = claims.map(claim => ({ claim, at: locate(claim.path, ports) }));
  if (found.reduce((sum, row) => sum + row.at.stat.size, 0) > DELIVERABLE_LIMITS.totalBytes) throw new DeliverableRefusal(`deliverables: together larger than ${DELIVERABLE_LIMITS.totalBytes / (1024 * 1024)} MiB`);
  const records: DeliverableRecord[] = [];
  for (const { claim, at } of found) {
    const { sha256, bytes } = await digest(claim.path, at);
    records.push({ id: deliverableId(claim.path, claim.format), path: claim.path, format: claim.format, ...(claim.version !== undefined ? { version: claim.version } : {}), sha256, bytes, ...(ports.private(claim.path) ? { private: true as const } : {}) });
  }
  return records;
}

export interface DeliverableCheck { record: DeliverableRecord; state: DeliverableState; why?: string }

/**
 * Compare recorded deliverables with the files as they are now. `unchanged` and `changed` are measurements; `missing` is a file that is gone;
 * `unknown` is a file the hub cannot vouch for (outside the project, denied, too large, unreadable, or changing while read): never `unchanged`.
 */
export async function checkDeliverables(records: readonly DeliverableRecord[], ports: DeliverablePorts): Promise<DeliverableCheck[]> {
  const out: DeliverableCheck[] = [];
  // The files may have grown since delivery: the aggregate bound holds for a read as for a delivery, so an over-large set is read as unknown, not hashed.
  let total = 0;
  for (const record of records) { try { if (record.path) total += locate(record.path, ports).stat.size; } catch { /* reported per file below */ } }
  const tooLarge = total > DELIVERABLE_LIMITS.totalBytes;
  for (const record of records) {
    if (!record.path) { out.push({ record, state: "unknown", why: "no path recorded" }); continue; }
    if (tooLarge) { out.push({ record, state: "unknown", why: `the files together are now larger than ${DELIVERABLE_LIMITS.totalBytes / (1024 * 1024)} MiB` }); continue; }
    try {
      const found = locate(record.path, ports);
      const now = await digest(record.path, found);
      out.push({ record, state: now.sha256 === record.sha256 ? "unchanged" : "changed" });
    } catch (error) {
      const why = error instanceof DeliverableRefusal ? error.message : "unreadable";
      out.push({ record, state: /does not exist/.test(why) ? "missing" : "unknown", why });
    }
  }
  return out;
}


/** Synchronous final batch fence using the same guard/policies as the original descriptor read. */
export function guardedDeliverableCurrent(path: string, ports: DeliverablePorts, read: GuardedDeliverableRead): boolean {
  try {
    if (!read.stamps) return false;
    const found = locate(path, ports);
    if (ports.private(path) || ports.private(relative(realPath(ports.cwd), found.real))) return false;
    return sameFile(found.stat, read.identity) && found.stat.size === read.stamps.size
      && found.stat.mtimeMs === read.stamps.mtimeMs && found.stat.ctimeMs === read.stamps.ctimeMs;
  } catch { return false; }
}
