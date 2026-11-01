import { Database } from "bun:sqlite";
import { lstatSync, opendirSync, type Dirent, type Stats } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { processLiveness } from "../pi/process-signature.ts";
import { hubHome } from "./project.ts";
import { REGISTRY_DB_BUSY_TIMEOUT_MS } from "./registry.ts";
import { RUNTIME_PRUNE_INTERVAL_MS } from "./runtime-capture-prune.ts";

export interface RuntimePruneHealthCheck { ok: boolean | undefined; name: string; detail: string }
const MAX_LEDGER_BYTES = 1024 * 1024, MAX_OUTCOME_BYTES = 16 * 1024;
const MAX_SCAN_ENTRIES = 1024, MAX_QUARANTINES = 64, SCAN_MS = 250;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const columns = "slot,id,admitted_at,phase,pid,outcome";
const issue = (detail: string, ok: boolean | undefined = undefined): RuntimePruneHealthCheck => ({ ok, name: "runtime pruning", detail });
const info = (file: string): Stats | undefined => {
  try { return lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
};
const safeFile = (file: string, stat: Stats, limit: number): void => {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > limit) throw new Error(`unsafe metadata: ${file}`);
};
interface Admission { slot: number; id: string; admitted_at: number; phase: string; pid: number | null; outcome: string | null; signature: string | null; outcome_ok: number; signature_ok: number }
interface LedgerHealth { checks: RuntimePruneHealthCheck[]; active: boolean | undefined }
function admissionHealth(file: string): LedgerHealth {
  let db: Database | undefined;
  try {
    const before = info(file); if (!before) return { checks: [], active: false };
    safeFile(file, before, MAX_LEDGER_BYTES);
    for (const suffix of ["-wal", "-shm", "-journal"]) { const sidecar = info(`${file}${suffix}`); if (sidecar) safeFile(`${file}${suffix}`, sidecar, MAX_LEDGER_BYTES); }
    db = new Database(file, { readonly: true, create: false });
    db.run(`PRAGMA busy_timeout = ${REGISTRY_DB_BUSY_TIMEOUT_MS}`);
    const tables = db.query("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 2").all() as { name: string; type: string }[];
    const shape = (db.query("PRAGMA table_info(admission)").all() as { name: string }[]).map(column => column.name).join(",");
    if (tables.length !== 1 || tables[0]?.name !== "admission" || tables[0]?.type !== "table" || ![columns, `${columns},signature`].includes(shape)) throw new Error("unknown admission schema");
    const signed = shape.endsWith(",signature");
    const rows = db.query(`SELECT slot,id,admitted_at,phase,pid,CASE WHEN typeof(outcome)='text' AND length(CAST(outcome AS BLOB))<=${MAX_OUTCOME_BYTES} THEN outcome END AS outcome,
      CASE WHEN outcome IS NULL OR (typeof(outcome)='text' AND length(CAST(outcome AS BLOB))<=${MAX_OUTCOME_BYTES}) THEN 1 ELSE 0 END AS outcome_ok,
      ${signed ? "CASE WHEN typeof(signature)='text' AND length(CAST(signature AS BLOB))<=1024 THEN signature END" : "NULL"} AS signature,
      ${signed ? "CASE WHEN signature IS NULL OR (typeof(signature)='text' AND length(CAST(signature AS BLOB))<=1024) THEN 1 ELSE 0 END" : "1"} AS signature_ok FROM admission LIMIT 2`).all() as Admission[];
    const row = rows[0], after = info(file);
    if (!after || after.dev !== before.dev || after.ino !== before.ino || after.size > MAX_LEDGER_BYTES) throw new Error("admission identity changed");
    if (!rows.length) return { checks: [], active: false };
    if (rows.length !== 1 || row?.slot !== 1 || row.outcome_ok !== 1 || row.signature_ok !== 1 || typeof row.id !== "string" || row.id.length !== 36 || !/^[a-f0-9-]{36}$/.test(row.id)
      || !Number.isSafeInteger(row.admitted_at) || row.admitted_at < 0 || !["scheduled", "running", "complete"].includes(row.phase)
      || row.pid !== null && (!Number.isSafeInteger(row.pid) || row.pid < 1)
      || row.signature !== null && (!row.signature.trim() || Buffer.byteLength(row.signature) > 1024)) throw new Error("invalid admission row");
    if (row.phase === "running") {
      if (row.pid === null) throw new Error("running admission has no pid");
      const liveness = processLiveness(row.pid, row.signature);
      if (row.signature === null) return { active: undefined, checks: [issue(`legacy running admission has no signed worker identity${liveness === "gone" ? "; its PID is gone" : "; ownership is unknown"}; inspect ${file}`, liveness === "gone" ? false : undefined)] };
      if (liveness === "live") return { active: true, checks: [issue(`signed maintenance worker ${row.pid} is running; ledger ${file}`, true)] };
      return { active: liveness === "gone" ? false : undefined, checks: [issue(`maintenance worker is ${liveness === "gone" ? "gone; admission needs recovery" : "uncertain; ownership needs inspection"}; inspect ${file}`, liveness === "gone" ? false : undefined)] };
    }
    if (row.phase === "scheduled") {
      if (row.pid !== null || row.signature !== null || row.outcome !== null) throw new Error("scheduled admission identity is inconsistent");
      const age = Date.now() - row.admitted_at;
      return { active: false, checks: age < 0 ? [issue(`scheduled admission timestamp is in the future; inspect ${file}`)]
        : age >= RUNTIME_PRUNE_INTERVAL_MS ? [issue(`scheduled maintenance has not started within its admission interval; inspect ${file}`, false)] : [] };
    }
    if (typeof row.outcome !== "string") throw new Error("completed admission has no bounded outcome");
    const outcome = JSON.parse(row.outcome) as { removed?: unknown; quarantined?: unknown; deferred?: unknown };
    if (!outcome || typeof outcome !== "object" || Array.isArray(outcome) || Object.keys(outcome).some(key => !["removed", "quarantined", "deferred"].includes(key))
      || !Number.isSafeInteger(outcome.removed) || (outcome.removed as number) < 0 || !Array.isArray(outcome.quarantined) || outcome.quarantined.length > MAX_QUARANTINES
      || outcome.quarantined.some(value => typeof value !== "string" || value.length > 4096 || isAbsolute(value) || normalize(value) !== value || value.split(/[\\/]/).some(part => part === ".."))
      || outcome.deferred !== undefined && (typeof outcome.deferred !== "string" || Buffer.byteLength(outcome.deferred) > 512)) throw new Error("invalid completed outcome");
    if (outcome.deferred !== undefined || outcome.quarantined.length) {
      const detail = typeof outcome.deferred === "string" ? `maintenance deferred: ${outcome.deferred.replace(/[\x00-\x1f\x7f]/g, " ")}; inspect ${file}` : `maintenance retained quarantine paths; inspect ${file}`;
      return { active: false, checks: [issue(detail, false)] };
    }
    return { checks: [], active: false };
  } catch { return { active: undefined, checks: [issue(`runtime maintenance admission is unreadable, unsafe or unknown; inspect ${file}`)] }; }
  finally { try { db?.close(); } catch { /* Inspection never repairs or alters admission state. */ } }
}

/** Scan only the two release directory levels, never capture contents or a referenced/symlinked directory. */
function quarantineHealth(home: string, active: boolean | undefined): RuntimePruneHealthCheck[] {
  const releases = join(home, "releases"), checks: RuntimePruneHealthCheck[] = [];
  let remaining = MAX_SCAN_ENTRIES, found = 0;
  const deadline = performance.now() + SCAN_MS;
  const scan = (directory: string, visit: (entry: Dirent) => void) => {
    const stat = info(directory); if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe release directory");
    const stream = opendirSync(directory);
    try { for (;;) { const entry = stream.readSync(); if (!entry) break; if (--remaining < 0 || performance.now() > deadline) throw new Error("release inventory bound exceeded"); visit(entry); } }
    finally { stream.closeSync(); }
  };
  try {
    scan(releases, version => {
      if (VERSION.exec(version.name)?.[0] !== version.name) return;
      const directory = join(releases, version.name);
      if (!version.isDirectory() || version.isSymbolicLink()) throw new Error(`unsafe version directory: ${directory}`);
      scan(directory, entry => {
        if (!entry.name.startsWith(".runtime-prune-")) return;
        if (++found > MAX_QUARANTINES) throw new Error("quarantine result bound exceeded");
        const path = join(directory, entry.name), stat = info(path); if (!stat) return;
        const unsafe = stat.isSymbolicLink() || !stat.isDirectory();
        checks.push({ ok: undefined, name: "runtime quarantine", detail: `${unsafe ? "unsafe reserved quarantine path" : active === true ? "maintenance quarantine is in use" : "runtime quarantine remains"}; inspect ${path}` });
      });
    });
  } catch { checks.push(issue(`runtime quarantine inventory is unreadable, unsafe or exceeds its bound; inspect ${releases}`)); }
  return checks;
}

/** Read-only doctor diagnostics. An absent ledger and quarantine inventory preserves the previous empty result. */
export function runtimePruneHealth(home?: string): RuntimePruneHealthCheck[] {
  try {
    const target = home ?? hubHome(), stat = info(target);
    if (!stat) return [];
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [issue(`runtime maintenance home is unsafe; inspect ${target}`)];
    const ledger = admissionHealth(join(target, "runtime-prune.db"));
    return [...ledger.checks, ...quarantineHealth(target, ledger.active)];
  } catch { return [issue(`runtime maintenance diagnostics are unavailable; inspect ${home ?? "the agent-hub home"}`)]; }
}
