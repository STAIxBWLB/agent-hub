import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { isAbsolute, join } from "node:path";
import { types } from "node:util";

export type AutonomyConsentPurpose = "permission" | "ownership" | "undo";
export type AutonomyConsentValue = string;
export type AutonomyConsentValues = Record<string, Record<string, AutonomyConsentValue>>;
export interface AutonomyConsent {
  confirmed(current: AutonomyConsentValues, trusted: boolean): Set<string>;
  /** Host console-confirmation capability. Never exposed as a caller-selected operation. */
  confirm(values: AutonomyConsentValues): void;
  clear(): void;
}
export const AUTONOMY_CONSENT_DIR = "autonomy";
export const AUTONOMY_CONSENT_FILE = "autonomy-consent.json";
export const AUTONOMY_CONSENT_KEY_FILE = "autonomy-consent.key";
const MAX_PEERS = 128, MAX_RECORD = 64 * 1024, KEY_BYTES = 32;
const HEX = /^[a-f0-9]{64}$/, PEER = /^[a-z][a-z0-9-]{0,63}$/;
const unavailable = (): Error => new Error("autonomy consent is unavailable");
interface SignedPeer { peer: string; digest: string; mac: string }
interface Document { version: 1; project: string; purpose: AutonomyConsentPurpose; peers: SignedPeer[] }
interface PrivateRead { bytes: Buffer; stat: Stats }
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && !types.isProxy(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.getOwnPropertySymbols(value).length === 0
  && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => Object.hasOwn(descriptor, "value"));
const sameFile = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

/** Digests bind exact mode keys or the purpose-specific witness digest, independent of insertion order. No values are retained in the receipt. */
function digests(value: AutonomyConsentValues, purpose: AutonomyConsentPurpose): Map<string, string> {
  if (!plain(value) || Object.keys(value).length > MAX_PEERS) throw unavailable();
  if (purpose !== "permission" && (Object.keys(value).length !== 1 || !Object.hasOwn(value, purpose))) throw unavailable();
  const result = new Map<string, string>();
  for (const peer of Object.keys(value).sort()) {
    const values = value[peer];
    if (!PEER.test(peer) || !plain(values)) throw unavailable();
    const keys = Object.keys(values).sort();
    if (purpose === "permission") {
      if (!keys.length || keys.length > 2 || keys.some(key => key !== `permission_modes.${peer}` && key !== `permission.${peer}`)) throw unavailable();
    } else if (keys.length !== 1 || keys[0] !== "digest" || typeof values.digest !== "string" || !HEX.test(values.digest)) throw unavailable();
    const pairs = keys.map(key => {
      const item = values[key];
      if (typeof item !== "string" || !item || Buffer.byteLength(item) > 4096) throw unavailable();
      return [key, item];
    });
    result.set(peer, createHash("sha256").update(JSON.stringify(pairs)).digest("hex"));
  }
  return result;
}

/** State is a host capability: filesystem guards and its HMAC key are outside writable project configuration. */
export function createAutonomyConsent(stateDir: string, projectId: string, purpose: AutonomyConsentPurpose = "permission"): AutonomyConsent {
  if (typeof stateDir !== "string" || !isAbsolute(stateDir) || Buffer.byteLength(stateDir) > 4096 || typeof projectId !== "string" || !projectId || Buffer.byteLength(projectId) > 1024 || !["permission", "ownership", "undo"].includes(purpose)) throw unavailable();
  const privateDir = join(stateDir, AUTONOMY_CONSENT_DIR);
  const state = join(privateDir, AUTONOMY_CONSENT_FILE), keyFile = join(privateDir, AUTONOMY_CONSENT_KEY_FILE);
  const owner = process.getuid?.();
  const directory = (create = false): boolean => {
    if (owner === undefined || typeof constants.O_NOFOLLOW !== "number") throw unavailable();
    let stat = lstatSync(stateDir, { throwIfNoEntry: false });
    if (!stat && create) { mkdirSync(stateDir, { recursive: true, mode: 0o700 }); stat = lstatSync(stateDir); }
    if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== owner || (stat.mode & 0o022) !== 0) throw unavailable();
    let child = lstatSync(privateDir, { throwIfNoEntry: false });
    if (!child && create) { mkdirSync(privateDir, { mode: 0o700 }); child = lstatSync(privateDir); }
    if (!child) return false;
    if (!child.isDirectory() || child.isSymbolicLink() || child.uid !== owner || (child.mode & 0o077) !== 0) throw unavailable();
    return true;
  };
  const safe = (stat: Stats, max: number) => stat.isFile() && stat.uid === owner && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && stat.size > 0 && stat.size <= max;
  const read = (file: string, max: number): PrivateRead | undefined => {
    let fd: number;
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw unavailable(); }
    try {
      const before = fstatSync(fd);
      if (!safe(before, max)) throw unavailable();
      const bytes = Buffer.alloc(before.size); let offset = 0;
      while (offset < bytes.length) { const size = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!size) throw unavailable(); offset += size; }
      const after = fstatSync(fd), current = lstatSync(file, { throwIfNoEntry: false });
      if (!safe(after, max) || !sameFile(before, after) || !current || !safe(current, max) || !sameFile(after, current)) throw unavailable();
      return { bytes, stat: after };
    } finally { closeSync(fd); }
  };
  const mac = (key: Buffer, peer: string, digest: string): string => createHmac("sha256", key).update(JSON.stringify(["agent-hub.autonomy-consent/v1", purpose, projectId, peer, digest])).digest("hex");
  const temporary = (bytes: Buffer): string => {
    const file = join(privateDir, `.autonomy-consent-${randomBytes(16).toString("hex")}.tmp`);
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset); fsyncSync(fd); }
    catch (error) { try { unlinkSync(file); } catch { /* Only this exclusive temporary file is ours. */ } throw error; }
    finally { closeSync(fd); }
    return file;
  };
  const write = (peers: SignedPeer[]): void => {
    if (!directory()) throw unavailable();
    read(state, MAX_RECORD); // Refuse unsafe existing paths; rename never follows a link.
    const bytes = Buffer.from(`${JSON.stringify({ version: 1, project: projectId, purpose, peers } satisfies Document)}\n`);
    if (bytes.length > MAX_RECORD) throw unavailable();
    const temp = temporary(bytes);
    try { renameSync(temp, state); } finally { if (existsSync(temp)) unlinkSync(temp); }
  };
  const key = (issue: boolean): Buffer | undefined => {
    const present = read(keyFile, KEY_BYTES);
    if (present) { if (present.bytes.length !== KEY_BYTES) throw unavailable(); return present.bytes; }
    if (!issue) return undefined;
    const generated = randomBytes(KEY_BYTES), temp = temporary(generated);
    try {
      try { linkSync(temp, keyFile); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { unlinkSync(temp); }
    const published = read(keyFile, KEY_BYTES);
    if (!published || published.bytes.length !== KEY_BYTES) throw unavailable();
    return published.bytes;
  };
  const authenticated = (bytes: Buffer, secret: Buffer): { peers: SignedPeer[]; count: number } | undefined => {
    const raw: unknown = JSON.parse(bytes.toString("utf8"));
    if (!plain(raw) || raw.version !== 1 || Object.keys(raw).some(name => !["version", "project", "purpose", "peers"].includes(name)) || typeof raw.project !== "string" || typeof raw.purpose !== "string" || !Array.isArray(raw.peers) || raw.peers.length > MAX_PEERS) throw unavailable();
    if (raw.project !== projectId || raw.purpose !== purpose) return undefined;
    const peers: SignedPeer[] = [], seen = new Set<string>();
    for (const value of raw.peers) {
      if (!plain(value) || Object.keys(value).some(name => !["peer", "digest", "mac"].includes(name)) || typeof value.peer !== "string" || !PEER.test(value.peer) || typeof value.digest !== "string" || !HEX.test(value.digest) || typeof value.mac !== "string" || !HEX.test(value.mac) || seen.has(value.peer)) throw unavailable();
      seen.add(value.peer);
      if (timingSafeEqual(Buffer.from(value.mac, "hex"), Buffer.from(mac(secret, value.peer, value.digest), "hex"))) peers.push({ peer: value.peer, digest: value.digest, mac: value.mac });
    }
    return { peers, count: raw.peers.length };
  };
  const clear = (): void => {
    try {
      if (!directory()) return;
      let failure = false;
      // Retire the key first, including when a receipt is missing. Unlink never follows
      // an owned alias or reads unsafe data; an old signed receipt cannot revive consent.
      for (const file of [keyFile, state]) {
        try {
          const stat = lstatSync(file, { throwIfNoEntry: false });
          if (!stat) continue;
          if (stat.uid !== owner || !stat.isFile() && !stat.isSymbolicLink()) throw unavailable();
          unlinkSync(file);
        } catch { failure = true; }
      }
      if (failure) throw unavailable();
    } catch { throw unavailable(); }
  };
  return {
    confirmed(current, trusted) {
      if (trusted !== true) { try { clear(); } catch { /* Unsafe state never proves consent. */ } return new Set(); }
      try {
        const expected = digests(current, purpose);
        if (!directory()) return new Set();
        const secret = key(false), receipt = read(state, MAX_RECORD);
        if (!secret || !receipt) return new Set();
        const stored = authenticated(receipt.bytes, secret);
        if (!stored) return new Set();
        const retained = stored.peers.filter(row => expected.get(row.peer) === row.digest);
        const stillCurrent = read(state, MAX_RECORD);
        if (!stillCurrent || !sameFile(receipt.stat, stillCurrent.stat)) return new Set();
        // Copy only already authenticated approvals; an observation can revoke but never mint consent.
        if (retained.length !== stored.count) write(retained);
        return new Set(retained.map(row => row.peer));
      } catch { return new Set(); }
    },
    confirm(values) {
      try {
        const requested = digests(values, purpose);
        directory(true); read(state, MAX_RECORD);
        const secret = key(true);
        if (!secret) throw unavailable();
        write([...requested].map(([peer, digest]) => ({ peer, digest, mac: mac(secret, peer, digest) })));
      } catch { throw unavailable(); }
    },
    clear,
  };
}
