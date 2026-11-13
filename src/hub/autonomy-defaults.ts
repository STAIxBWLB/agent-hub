import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { canonicalPath } from "./project.ts";
import { insideRoot } from "./path-policy.ts";
import { checkStartAgents } from "./start-agents.ts";

/** `startAgents` is the machine default of `start.agents` (#608), present only when `ahub setup` chose one. */
export interface AutonomyDefaultsRead { enabled: boolean; fingerprint: string; notice?: string; startAgents?: string[]; researchEnabled?: boolean }
const MAX_BYTES = 4096;
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const refusal = () => new Error("machine autonomy defaults are unsafe or changed; nothing was written");
const safeFile = (stat: Stats) => stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600 && stat.size <= MAX_BYTES;
function location(home: string, roots: readonly string[], create: boolean): Stats | undefined {
  if (!isAbsolute(home) || roots.some(root => insideRoot(relative(canonicalPath(root), canonicalPath(home))))) throw refusal();
  let parent = lstatSync(home, { throwIfNoEntry: false });
  if (!parent && create) { mkdirSync(home, { recursive: true, mode: 0o700 }); parent = lstatSync(home); }
  if (parent && (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o022) !== 0)) throw refusal();
  return parent;
}
function capture(home: string, roots: readonly string[]): { stat?: Stats; text?: string; fingerprint: string } {
  if (!location(home, roots, false)) return { fingerprint: "absent" };
  const file = join(home, "defaults.json");
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { fingerprint: "absent" }; throw refusal(); }
  try {
    const before = fstatSync(fd);
    if (!safeFile(before)) throw refusal();
    const text = readFileSync(fd, "utf8"), after = fstatSync(fd), named = lstatSync(file);
    if (Buffer.byteLength(text) > MAX_BYTES || !same(before, after) || !same(after, named)) throw refusal();
    return { stat: after, text, fingerprint: createHash("sha256").update(`${after.dev}:${after.ino}:${after.ctimeMs}:`).update(text).digest("hex") };
  } finally { closeSync(fd); }
}
interface DefaultsDocument { autonomy?: boolean; startAgents?: string[]; researchEnabled?: boolean }
/** The file's content, or the refusal. `{schema:1}` alone and any key but schema, autonomy, start and research are refused. */
function parseDefaults(text: string): DefaultsDocument {
  const raw: unknown = JSON.parse(text);
  const document = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  if (!document || Object.keys(document).some(key => !["schema", "autonomy", "start", "research"].includes(key)) || document.schema !== 1) throw refusal();
  if (document.autonomy !== undefined && typeof document.autonomy !== "boolean") throw refusal();
  let startAgents: string[] | undefined;
  if (document.start !== undefined) {
    const start = document.start;
    if (!start || typeof start !== "object" || Array.isArray(start) || Object.keys(start).some(key => key !== "agents")) throw refusal();
    try { startAgents = checkStartAgents((start as Record<string, unknown>).agents); } catch { throw refusal(); }
  }
  let researchEnabled: boolean | undefined;
  if (document.research !== undefined) {
    const research = document.research;
    if (!research || typeof research !== "object" || Array.isArray(research) || Object.keys(research).some(key => key !== "enabled") || typeof (research as Record<string, unknown>).enabled !== "boolean") throw refusal();
    researchEnabled = (research as { enabled: boolean }).enabled;
  }
  if (document.autonomy === undefined && startAgents === undefined && researchEnabled === undefined) throw refusal();
  return { ...(document.autonomy === undefined ? {} : { autonomy: document.autonomy }), ...(startAgents ? { startAgents } : {}), ...(researchEnabled === undefined ? {} : { researchEnabled }) };
}
/** Missing or untrusted machine files never change the shipped ask default. */
export function readAutonomyDefaults(home: string, roots: readonly string[] = []): AutonomyDefaultsRead {
  try {
    const held = capture(home, roots);
    if (held.text === undefined) return { enabled: false, fingerprint: held.fingerprint };
    const document = parseDefaults(held.text);
    return { enabled: document.autonomy === true, fingerprint: held.fingerprint, ...(document.startAgents ? { startAgents: document.startAgents } : {}), ...(document.researchEnabled === undefined ? {} : { researchEnabled: document.researchEnabled }) };
  } catch { return { enabled: false, fingerprint: "untrusted", notice: "Machine autonomy defaults ignored: defaults.json must be an owner-only regular file with a valid schema, outside project roots." }; }
}
/** Person CLI only. Exact prior evidence is rechecked after confirmation and before replacement. The other half of the file (the start set) is kept. */
export function writeAutonomyDefaults(home: string, enabled: boolean, expected: string, roots: readonly string[] = []): void {
  writeDefaults(home, expected, roots, kept => ({ schema: 1, autonomy: enabled, ...(kept.startAgents ? { start: { agents: kept.startAgents } } : {}), ...(kept.researchEnabled === undefined ? {} : { research: { enabled: kept.researchEnabled } }) }));
}
/** Person CLI only (`ahub setup`): the machine default of `start.agents`. The autonomy half of the file is kept, and absent stays absent. */
export function writeMachineStartAgents(home: string, agents: readonly string[], expected: string, roots: readonly string[] = []): void {
  const checked = checkStartAgents([...agents]);
  writeDefaults(home, expected, roots, kept => ({ schema: 1, ...(kept.autonomy === undefined ? {} : { autonomy: kept.autonomy }), start: { agents: checked }, ...(kept.researchEnabled === undefined ? {} : { research: { enabled: kept.researchEnabled } }) }));
}
/** Person CLI only (`ahub setup --research|--no-research`); preserve autonomy and the chosen agent set. */
export function writeMachineResearch(home: string, enabled: boolean, expected: string, roots: readonly string[] = []): void {
  if (typeof enabled !== "boolean") throw refusal();
  writeDefaults(home, expected, roots, kept => ({ schema: 1, ...(kept.autonomy === undefined ? {} : { autonomy: kept.autonomy }), ...(kept.startAgents ? { start: { agents: kept.startAgents } } : {}), research: { enabled } }));
}
function writeDefaults(home: string, expected: string, roots: readonly string[], build: (kept: DefaultsDocument) => Record<string, unknown>): void {
  const before = capture(home, roots);
  if (before.fingerprint !== expected) throw refusal();
  const kept = before.text === undefined ? {} : parseDefaults(before.text);
  const parent = location(home, roots, true)!;
  const file = join(home, "defaults.json"), temporary = join(home, `.defaults.${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, `${JSON.stringify(build(kept), null, 2)}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
    const current = lstatSync(home);
    if (current.dev !== parent.dev || current.ino !== parent.ino || capture(home, roots).fingerprint !== expected) throw refusal();
    renameSync(temporary, file);
  } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}
