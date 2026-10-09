import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { canonicalPath, hubHome, projectRoot } from "./project.ts";
import { processLiveness } from "../pi/process-signature.ts";

const BASE_PORT = 4600;
const STRIDE = 10;
const MAX_PORT = 65535 - 3;
const LEGACY_DONE = "legacy_ports_imported";
type Tx = { immediate(): void };
// SQLite's busy_timeout bounds contention; never multiply it through unbounded retries.
const runTx = (tx: Tx): void => { tx.immediate(); };

export interface Project {
  id: string;
  root: string;
  stateDir: string;
  basePort: number;
  instanceId: string | null;
  pid: number | null;
  /** #226: the claimant's processSignature; absent for a claim written by 0.12.20 or older (judged by its pid alone). */
  pidSignature?: string | null;
}

/**
 * #226: `pid_signature` holds "<instance id> <signature>". An older daemon's claim rewrites instance_id and pid but not
 * this column, so a signature counts only for the instance that wrote it: under another instance the claim is unsigned.
 */
export const PROJECT_COLUMNS = "id, root, state_dir as stateDir, base_port as basePort, instance_id as instanceId, pid";
export function projectFromRow(raw: Record<string, unknown>): Project {
  const { pid_signature: signed, ...row } = raw;
  const project = { ...row } as unknown as Project;
  const prefix = `${project.instanceId} `;
  if (project.instanceId && typeof signed === "string" && signed.startsWith(prefix) && signed.length > prefix.length) project.pidSignature = signed.slice(prefix.length);
  return project;
}

const idFor = (root: string) => `p_${createHash("sha256").update(root).digest("hex").slice(0, 24)}`;
// Preserve the original identifier of missing legacy checkouts as a reservation.
const legacyRoot = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
const canonicalState = canonicalPath;

export class Registry {
  readonly path: string;
  private readonly db: Database;

  constructor(path = join(hubHome(), "registry.db")) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA busy_timeout = 5000");
    try {
      this.db.run("PRAGMA journal_mode = WAL");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED") throw error;
    }
    this.db.run(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, state_dir TEXT NOT NULL UNIQUE,
      base_port INTEGER NOT NULL UNIQUE, instance_id TEXT, pid INTEGER, claimed_at INTEGER
    )`);
    this.db.run("CREATE TABLE IF NOT EXISTS registry_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const columns = this.db.query("PRAGMA table_info(projects)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "pid_signature")) {
      try { this.db.run("ALTER TABLE projects ADD COLUMN pid_signature TEXT"); }
      catch (error) { if (!/duplicate column/i.test((error as Error).message)) throw error; } // a concurrent open added it
    }
    this.importLegacy();
  }

  register(root: string, stateDir?: string): Project {
    const canonicalRoot = projectRoot(root);
    const explicitState = stateDir !== undefined;
    const stateInput = stateDir ? (stateDir.startsWith("/") ? stateDir : join(canonicalRoot, stateDir)) : join(canonicalRoot, ".agenthub", "state");
    const state = canonicalState(stateInput);
    const id = idFor(canonicalRoot);
    const tx = this.db.transaction(() => {
      const existing = this.row(id);
      if (existing) {
        if (existing.root !== canonicalRoot) throw new Error(`registry id collision for ${canonicalRoot}`);
        if (explicitState && existing.stateDir !== state) {
          if (existing.instanceId && (existing.pid === null || processLiveness(existing.pid, existing.pidSignature) !== "gone")) throw new Error(`cannot relocate live or uncertain project ${id}`);
          this.db.query("UPDATE projects SET state_dir = ? WHERE id = ?").run(state, id);
        }
        return;
      }
      const basePort = this.nextBase();
      try {
        this.db.query("INSERT INTO projects (id, root, state_dir, base_port) VALUES (?, ?, ?, ?)").run(id, canonicalRoot, state, basePort);
      } catch (error) {
        throw new Error(`cannot register ${canonicalRoot}: ${(error as Error).message}`);
      }
    });
    runTx(tx as Tx);
    return this.get(id)!;
  }

  get(id: string): Project | undefined {
    return this.row(id) ?? undefined;
  }

  list(): Project[] {
    return (this.db.query(`SELECT ${PROJECT_COLUMNS}, pid_signature FROM projects ORDER BY root`).all() as Record<string, unknown>[]).map(projectFromRow);
  }

  allocate(root: string): number {
    return this.register(root).basePort;
  }

  reallocate(id: string, instanceId: string): number {
    let base = 0;
    const tx = this.db.transaction(() => {
      const project = this.row(id);
      if (!project || project.instanceId !== instanceId) throw new Error(`project ${id} is not owned by instance ${instanceId}`);
      base = this.nextBase(project.basePort);
      this.db.query("UPDATE projects SET base_port = ? WHERE id = ?").run(base, id);
    });
    runTx(tx as Tx);
    return base;
  }

  /** `signature`: the claimant's processSignature (#226); without one the claim is judged by its pid alone. */
  claim(id: string, instanceId: string, pid: number, signature?: string): boolean {
    let claimed = false;
    const tx = this.db.transaction(() => {
      const project = this.row(id);
      if (!project) return;
      if (project.instanceId && project.instanceId !== instanceId) {
        if (project.pid === null) return;
        if (processLiveness(project.pid, project.pidSignature) !== "gone") return;
      }
      this.db.query("UPDATE projects SET instance_id = ?, pid = ?, pid_signature = ?, claimed_at = ? WHERE id = ?")
        .run(instanceId, pid, signature ? `${instanceId} ${signature}` : null, Date.now(), id);
      claimed = true;
    });
    runTx(tx as Tx);
    return claimed;
  }

  release(id: string, instanceId: string): void {
    this.db.query("UPDATE projects SET instance_id = NULL, pid = NULL, pid_signature = NULL, claimed_at = NULL WHERE id = ? AND instance_id = ?").run(id, instanceId);
  }

  remove(id: string): void {
    const tx = this.db.transaction(() => {
      const project = this.row(id);
      if (!project) return;
      if (project.instanceId) {
        if (project.pid === null || processLiveness(project.pid, project.pidSignature) !== "gone") throw new Error(`project ${id} has a live or uncertain claim`);
      } else if (existsSync(join(project.stateDir, "status.json")) || existsSync(join(project.stateDir, "control-token"))) {
        let pid: number | undefined, signature: string | undefined;
        try {
          const status = JSON.parse(readFileSync(join(project.stateDir, "status.json"), "utf8")) as { pid?: number; pidSignature?: unknown };
          pid = typeof status.pid === "number" ? status.pid : undefined;
          signature = typeof status.pidSignature === "string" ? status.pidSignature : undefined;
        } catch {
          // A state directory without a readable owner marker is uncertain.
        }
        if (pid === undefined || processLiveness(pid, signature) !== "gone") throw new Error(`project ${id} has a live or uncertain legacy state`);
      }
      this.db.query("DELETE FROM projects WHERE id = ?").run(id);
    });
    runTx(tx as Tx);
  }

  close(): void {
    this.db.close();
  }

  private row(id: string): Project | null {
    const raw = this.db.query(`SELECT ${PROJECT_COLUMNS}, pid_signature FROM projects WHERE id = ?`).get(id) as Record<string, unknown> | null;
    return raw ? projectFromRow(raw) : null;
  }

  private nextBase(after = BASE_PORT - STRIDE): number {
    const used = new Set((this.db.query("SELECT base_port as basePort FROM projects").all() as { basePort: number }[]).map((r) => r.basePort));
    let base = Math.max(BASE_PORT - STRIDE, after);
    do {
      base += STRIDE;
      if (base > MAX_PORT) throw new Error(`no available project port range below ${MAX_PORT}`);
    } while (used.has(base));
    return base;
  }

  private importLegacy(): void {
    const legacy = join(dirname(this.path), "ports.json");
    const tx = this.db.transaction(() => {
      if (this.db.query("SELECT 1 FROM registry_meta WHERE key = ?").get(LEGACY_DONE)) return;
      if (existsSync(legacy)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(legacy, "utf8"));
        } catch (error) {
          throw new Error(`cannot import legacy port registry ${legacy}: ${(error as Error).message}`);
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`cannot import legacy port registry ${legacy}: expected an object`);
        const seen = new Map<string, number>();
        for (const [rawRoot, rawPort] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof rawPort !== "number" || !Number.isInteger(rawPort) || rawPort < BASE_PORT || rawPort > MAX_PORT || rawPort % STRIDE !== 0) throw new Error(`cannot import legacy port registry ${legacy}: invalid port for ${rawRoot}`);
          const root = legacyRoot(rawRoot);
          const alias = seen.get(root);
          if (alias !== undefined && alias !== rawPort) throw new Error(`cannot import legacy port registry ${legacy}: aliases for ${root} have conflicting ports`);
          if (alias !== undefined) continue;
          if ([...seen.values()].includes(rawPort)) throw new Error(`cannot import legacy port registry ${legacy}: conflicting port ${rawPort}`);
          seen.set(root, rawPort);
          const id = idFor(root);
          const existing = this.row(id);
          if (existing && existing.basePort !== rawPort) throw new Error(`legacy port for ${root} conflicts with registry`);
          if (!existing) this.db.query("INSERT INTO projects (id, root, state_dir, base_port) VALUES (?, ?, ?, ?)").run(id, root, join(root, ".agenthub", "state"), rawPort);
        }
      }
      this.db.query("INSERT INTO registry_meta (key, value) VALUES (?, ?)").run(LEGACY_DONE, String(Date.now()));
    });
    runTx(tx as Tx);
  }
}
