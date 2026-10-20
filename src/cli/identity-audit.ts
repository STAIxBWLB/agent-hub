import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliCommandLabel } from "./identity.ts";

export interface CliAudit {
  v: 1; id: string; at: number; peer: string; command: string; outcome: "run" | "refused" | "invalid" | "delegated";
}
const MAX_FILES = 256;
const MAX_BYTES = 64 * 1024;
const MAX_ROW_BYTES = 512;
const READY = /^[a-f0-9-]{36}\.json$/;
const PENDING = /^[a-f0-9-]{36}\.tmp$/;
const valid = (row: any): row is CliAudit => row?.v === 1 && typeof row.id === "string" && /^[a-f0-9-]{36}$/.test(row.id)
  && typeof row.at === "number" && Number.isFinite(row.at) && row.at > 0
  && typeof row.peer === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(row.peer) && !/\s/.test(row.peer)
  && typeof row.command === "string" && row.command.length <= 64 && row.command === cliCommandLabel(...splitLabel(row.command))
  && ["run", "refused", "invalid", "delegated"].includes(row.outcome);
const splitLabel = (label: string): [string, string[]] => { const [command = "unknown", ...args] = label.split(" "); return [command, args]; };

/**
 * An ids-only outbox, published atomically without a writer lock. Concurrent writers can overshoot
 * the checked 256-file / 64 KiB ceiling by at most one bounded row per concurrent writer.
 * Unpublished temp files count against the ceiling, so a crashed writer cannot grow the spool forever.
 */
function reserveCliAudit(stateDir: string, peer: string, command: string, outcome: CliAudit["outcome"]) {
  const row: CliAudit = { v: 1, id: crypto.randomUUID(), at: Date.now(), peer, command, outcome };
  if (!valid(row)) throw new Error("invalid CLI audit identifiers");
  const dir = join(stateDir, "cli-audit");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = readdirSync(dir).filter(name => READY.test(name) || PENDING.test(name));
  let bytes = 0;
  for (const name of files) {
    try { bytes += statSync(join(dir, name)).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const text = JSON.stringify(row) + "\n";
  if (Buffer.byteLength(text) > MAX_ROW_BYTES || files.length >= MAX_FILES || bytes + Buffer.byteLength(text) > MAX_BYTES) throw new Error("CLI audit outbox is full");
  const pending = join(dir, `${row.id}.tmp`);
  try { writeFileSync(pending, text, { mode: 0o600, flag: "wx" }); }
  catch (error) { try { unlinkSync(pending); } catch { /* only this writer's unpublished file */ } throw error; }
  return {
    id: row.id,
    commit(outcome: CliAudit["outcome"]) {
      if (!valid({ ...row, outcome })) throw new Error("invalid CLI audit identifiers");
      writeFileSync(pending, JSON.stringify({ ...row, outcome }) + "\n", { mode: 0o600 });
      renameSync(pending, join(dir, `${row.id}.json`));
    },
    close() { try { unlinkSync(pending); } catch { /* only this writer's unpublished file */ } },
  };
}

export function recordCliAudit(stateDir: string, peer: string, command: string, outcome: CliAudit["outcome"]): void {
  const pending = reserveCliAudit(stateDir, peer, command, outcome);
  try { pending.commit(outcome); }
  finally { pending.close(); }
}

/** Reserve the bounded audit before connecting; old drains never see an unsupported ready row. */
export async function recordDelegatedCliAudit(stateDir: string, peer: string, command: string, features: () => Promise<readonly string[]>): Promise<string> {
  let pending: ReturnType<typeof reserveCliAudit>;
  try { pending = reserveCliAudit(stateDir, peer, command, "delegated"); }
  catch { throw new Error("live-test delegation audit unavailable; nothing was executed"); }
  try {
    let supported = false;
    try { supported = (await features()).includes("cli_audit_delegated"); }
    catch { /* unavailable authentication is not proof of an audit consumer */ }
    try { pending.commit(supported ? "delegated" : "refused"); }
    catch { throw new Error("live-test delegation audit unavailable; nothing was executed"); }
    if (!supported) throw new Error("running hub cannot retain delegated CLI audits; upgrade it from a person's terminal, or use the audited upgrade/recovery path; nothing was executed");
    return pending.id;
  } finally { pending.close(); }
}

/** Consume ready files only; rebuild fixed fields so titles or other injected text cannot be rendered. */
export function drainCliAudits(stateDir: string): CliAudit[] {
  const dir = join(stateDir, "cli-audit");
  let files: string[];
  try { files = readdirSync(dir).filter(name => READY.test(name)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const rows: CliAudit[] = [];
  for (const name of files) {
    const path = join(dir, name);
    try {
      if (statSync(path).size <= MAX_ROW_BYTES) {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (valid(parsed) && `${parsed.id}.json` === name) rows.push({ v: 1, id: parsed.id, at: parsed.at, peer: parsed.peer, command: parsed.command, outcome: parsed.outcome });
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return rows;
}
