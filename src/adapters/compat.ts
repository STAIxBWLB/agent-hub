import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hubHome } from "../hub/project.ts";

/**
 * #691: the one version policy for native agent CLIs. Every version gate asks `assessVersion`; no other file holds a
 * version constant. `verified` lists versions with a receipt in docs/verification; `line` is a semver window assumed
 * compatible (contract gates only); a person's trust lets an exact other version through on this machine. An isolation
 * gate keeps every runtime proof after trust: trust only lifts the version pin.
 */
export type CompatGate = "contract" | "isolation";
export interface CompatPolicy {
  label: string;
  verified: readonly string[];
  line?: { min: string; below: string };
  gate: CompatGate;
  /** The default executable and the argv `ahub agents` uses to read the version. */
  probe: readonly string[];
  /** Turns the probe's stdout into a plain semver, or undefined. */
  parse: (stdout: string) => string | undefined;
  /** What runtime checks still decide after trust (isolation) or what stays unverified (contract). */
  trustNote: string;
  /** The config key that selects this kind's executable, when one exists. */
  config?: "codex_bin" | "jcode_cmd" | "qwen_cmd";
}

const plain = (text: string) => text.length <= 64 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(text) ? text : undefined;
export const COMPAT = {
  // 0.163.0 receipt: docs/verification/2026-10-22-codex-reviewer-isolation.md
  "codex-review": { label: "Codex reviewer (codex-cli)", verified: ["0.146.0", "0.163.0"], gate: "isolation", probe: ["codex", "--version"], config: "codex_bin",
    parse: out => plain(out.trim().replace(/^codex-cli /, "")),
    trustNote: "Every launch still proves the MCP inventory, Apps/plugins/hooks disabled, sandbox read/write denial and the binary fence; a failed leg still refuses. Trust covers only the source-level claims those probes cannot see (docs/verification/2026-10-19-reviewer-isolation.md)." },
  "kimi-review": { label: "Kimi reviewer (kimi-code)", verified: ["2.2.0"], gate: "isolation", probe: ["kimi", "--version"],
    parse: out => plain(out.trim()),
    trustNote: "Every launch still builds the private config, exact two-tool agent file and task-bound MCP; the native tool allowlist behaviour of an untested version is not re-proven." },
  jcode: { label: "Jcode", verified: ["0.98.1", "0.99.0"], line: { min: "0.98.0", below: "1.0.0" }, gate: "contract", probe: ["jcode", "--quiet", "version", "--json"], config: "jcode_cmd",
    parse: out => { try { const v = JSON.parse(out).semver; return typeof v === "string" ? plain(v) : undefined; } catch { return undefined; } },
    trustNote: "The ACP, serve and MCP contract was verified on 0.98.1 and steering on 0.99.0; an untested version may change them." },
  agy: { label: "agy", verified: ["1.4.2"], line: { min: "1.4.0", below: "1.5.0" }, gate: "contract", probe: ["agy", "--version"],
    parse: out => plain(out.trim()),
    trustNote: "Only 1.4.2 is T0-verified; the plugin MCP and hook contract of another version is unverified." },
  qwen: { label: "Qwen Code", verified: ["0.25.0"], gate: "contract", probe: ["qwen", "--version"], config: "qwen_cmd",
    parse: out => plain(out.trim()),
    trustNote: "Native ACP identity and mode ids were verified on 0.25.0; another version may rename or drop them." },
} as const satisfies Record<string, CompatPolicy>;
export type CompatId = keyof typeof COMPAT;
type CommandConfig = { codex_bin: string; jcode_cmd: string[]; qwen_cmd: string[] };
/** The configured executables the native gates use; the rest probe their PATH default. */
export function configuredCommands(config: CommandConfig): Partial<Record<CompatId, readonly string[]>> {
  const out: Partial<Record<CompatId, readonly string[]>> = {};
  for (const [id, policy] of Object.entries(COMPAT) as [CompatId, CompatPolicy][]) {
    if (!policy.config) continue;
    const value = config[policy.config];
    out[id] = typeof value === "string" ? [value] : value;
  }
  return out;
}
export const isCompatId = (id: unknown): id is CompatId => typeof id === "string" && Object.hasOwn(COMPAT, id);

export type CompatVerdict =
  | { ok: true; state: "verified" | "in-line" | "trusted"; version: string; note?: string }
  | { ok: false; state: "refused" | "unknown"; version?: string; reason: string };

const parts = (v: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number);
const compare = (a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
function inLine(version: string, line?: { min: string; below: string }): boolean {
  const v = parts(version);
  return !!line && !!v && compare(v, parts(line.min)!) >= 0 && compare(v, parts(line.below)!) < 0;
}

/** A refusal the daemon may show as is: it names only versions and a command. */
export const VERSION_REFUSAL = "Version not verified: ";
/** A window of one minor (1.4.0 up to 1.5.0) reads as "the 1.4.x line". */
function lineText(line: { min: string; below: string }): string {
  const [a, b] = [parts(line.min)!, parts(line.below)!];
  return a[2] === 0 && b[2] === 0 && a[0] === b[0] && b[1] === a[1]! + 1 ? `the ${a[0]}.${a[1]}.x line` : `the line ${line.min} up to ${line.below}`;
}
export function describe(id: CompatId): string {
  const p: CompatPolicy = COMPAT[id];
  return `verified ${p.verified.join(", ")}${p.line ? `; compatible: ${lineText(p.line)}` : ""}`;
}

/** `trusted` defaults to this machine's record; tests and the CLI pass their own. */
export function assessVersion(id: CompatId, observed: unknown, trusted: readonly TrustEntry[] = readTrust()): CompatVerdict {
  const policy: CompatPolicy = COMPAT[id];
  const version = typeof observed === "string" ? plain(observed) : undefined;
  if (!version) return { ok: false, state: "unknown", reason: `${VERSION_REFUSAL}${policy.label} version unknown (${describe(id)}); check that the executable runs` };
  if (policy.verified.includes(version)) return { ok: true, state: "verified", version };
  if (trusted.some(entry => entry.id === id && entry.version === version)) return { ok: true, state: "trusted", version, note: `${policy.label} ${version} is untested; trusted on this machine by the person` };
  if (policy.gate === "contract" && inLine(version, policy.line)) return { ok: true, state: "in-line", version, note: `${policy.label} ${version} is untested (${describe(id)}); launching on the compatible line` };
  return { ok: false, state: "refused", version, reason: `${VERSION_REFUSAL}${policy.label} ${version} (${describe(id)}). Install a verified version, or accept this one on this machine with: ahub agents trust ${id} ${version}` };
}

export interface TrustEntry { id: CompatId; version: string; at: number }
const MAX_TRUST = 64;
export const trustFile = (home = hubHome()) => join(home, "agent-compat.json");

const MAX_BYTES = 64 * 1024;
/** An unreadable, linked, oversized or invalid record trusts nothing. */
export function readTrust(file = trustFile()): TrustEntry[] {
  let fd: number | undefined;
  try {
    // O_NONBLOCK: a FIFO planted at the record path must not stall a synchronous version gate; fstat refuses it.
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_BYTES) return [];
    const bytes = Buffer.alloc(info.size);
    if (readSync(fd, bytes, 0, info.size, 0) !== info.size) return [];
    const raw = JSON.parse(bytes.toString("utf8"));
    if (raw?.schemaVersion !== 1 || !Array.isArray(raw.trusted) || raw.trusted.length > MAX_TRUST) return [];
    const rows = raw.trusted.filter((row: unknown): row is TrustEntry => {
      const r = row as TrustEntry;
      return !!r && isCompatId(r.id) && typeof r.version === "string" && plain(r.version) === r.version && Number.isSafeInteger(r.at);
    });
    return rows.length === raw.trusted.length ? rows : [];
  } catch { return []; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Person-only (the CLI classifier refuses agent shells). Writes atomically; returns the new record. */
export function writeTrust(id: CompatId, version: string, revoke: boolean, file = trustFile(), now = Date.now()): TrustEntry[] {
  if (plain(version) !== version) throw new Error("trust needs an exact version such as 1.2.3");
  const rows = readTrust(file).filter(row => !(row.id === id && row.version === version));
  if (!revoke) rows.push({ id, version, at: now });
  if (rows.length > MAX_TRUST) throw new Error(`at most ${MAX_TRUST} trusted versions; revoke some first`);
  const parent = dirname(file);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const dir = lstatSync(parent);
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error("the hub home is not a plain directory; trust not written");
  const target = lstatSync(file, { throwIfNoEntry: false });
  if (target && !target.isFile()) throw new Error("the trust record is not a regular file; trust not written");
  // A unique, exclusively created temporary file: an existing name or a planted link fails instead of being followed.
  const temporary = join(parent, `.agent-compat.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, trusted: rows }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try { renameSync(temporary, file); }
  catch (error) { unlinkSync(temporary); throw error; }
  return rows;
}
