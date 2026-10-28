/** Person-owned exposure only; committed/shared config cannot enroll or expose a hub. */
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configRefusal } from "../hub/config-trust.ts";

const ID = /^[a-z][a-z0-9-]{0,31}$/;
export function roomName(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error("room: invalid_name");
  return value;
}
export function exposedPeers(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64 || value.some(x => typeof x !== "string" || !ID.test(x) || ["hub", "digest"].includes(x))) throw new Error("room: invalid_exposure");
  return [...new Set(value as string[])].sort();
}
export class RoomPolicy {
  constructor(private readonly cwd: string) {}
  private read(): Record<string, any> {
    const dir = join(this.cwd, ".agenthub"), file = join(dir, "config.local.json");
    if (configRefusal(this.cwd, "config.local.json")) throw new Error("room: untrusted_config");
    if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory())) throw new Error("room: untrusted_config");
    if (!existsSync(file)) return {};
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1_048_576) throw new Error("room: untrusted_config");
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("room: invalid_config");
    const config = raw as Record<string, any>;
    if (config.rooms !== undefined) {
      if (!config.rooms || typeof config.rooms !== "object" || Array.isArray(config.rooms) || Object.keys(config.rooms).length > 64) throw new Error("room: invalid_config");
      for (const [name, row] of Object.entries(config.rooms)) {
        roomName(name);
        if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some(key => key !== "expose")) throw new Error("room: invalid_config");
        exposedPeers((row as {expose?: unknown}).expose ?? []);
      }
    }
    return config;
  }
  // ponytail: at most two fresh hardened Git/file probes per room publication, with
  // at most 64 rooms. Profile before replacing this with shared per-turn/stat-keyed snapshots.
  get(name: string): string[] {
    roomName(name);
    try { return exposedPeers(this.read().rooms?.[name]?.expose ?? []); }
    catch { return []; } // Loss of trust revokes exposure, never widens it.
  }
  private prepare(name: string, peers: string[]): { config: Record<string, any>; bytes: string } {
    roomName(name); const expose = exposedPeers(peers), config = this.read();
    const rooms = { ...config.rooms, [name]: { expose } };
    if (Object.keys(rooms).length > 64) throw new Error("room: config_full");
    const bytes = JSON.stringify({ ...config, rooms }, null, 2) + "\n";
    if (Buffer.byteLength(bytes) > 1_048_576) throw new Error("room: config_full");
    return { config, bytes };
  }
  assertWritable(name: string, peers: string[], current: () => boolean): void {
    this.prepare(name, peers);
    if (!current()) throw new Error("room: state_changed");
  }
  set(name: string, peers: string[], current: () => boolean): void {
    const { config, bytes } = this.prepare(name, peers);
    const dir = join(this.cwd, ".agenthub"), file = join(dir, "config.local.json");
    if (!current()) throw new Error("room: state_changed");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = join(dir, `.room-${crypto.randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
      if (!current() || configRefusal(this.cwd, "config.local.json") || JSON.stringify(this.read()) !== JSON.stringify(config)) throw new Error("room: state_changed");
      renameSync(temporary, file);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch { /* renamed or not created */ }
    }
  }
}
