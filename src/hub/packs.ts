import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PROFILE_NAMES, resolveProfile, type ProfileName } from "./profiles.ts";
import { loadRoleCatalog } from "./roles.ts";
import { criterionId } from "./workflow.ts";

/**
 * A domain pack (#513a): a profile plus the roles it expects, a review rubric and example checks, in one file. It is data, never authority: it selects an
 * existing profile, names roles that must already be in the catalog, and contributes only `profile_overrides` text (`review_checklist`, `example_checks`)
 * that `resolveProfile` already bounds. Checks are display text exactly like `example_checks`: nothing here selects or runs a command.
 * The rubric ids follow #507's criterion ids (`criterionId`), so a reviewer names an unmet item by the same id the task's checklist uses.
 */
export interface DomainPack {
  name: string; profile: ProfileName; summary: string; roles: string[];
  rubric: { id: string; text: string; required: boolean }[];
  checks: { id: string; note: string }[];
  layer: "shipped" | "project";
}
export interface PackCatalog { packs: Map<string, DomainPack>; errors: { id: string; reason: string }[] }
export const PACK_SUFFIX = ".pack.json";
const NAME = /^[a-z][a-z0-9-]{0,47}$/;
const MAX_BYTES = 8192, MAX_FILES = 16, MAX_ROLES = 8, MAX_RUBRIC = 12, MAX_CHECKS = 8;
const KEYS = ["name", "profile", "summary", "roles", "rubric", "checks"];

const plain = (value: unknown, cap: number, what: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > cap || value !== value.trim()) throw new Error(`${what} must be trimmed text of at most ${cap} characters`);
  for (const char of value) if (/[\x00-\x1f\x7f]/.test(char) || (char.codePointAt(0)! > 127 && /[\p{P}\p{S}\p{Z}\p{C}]/u.test(char))) throw new Error(`${what} must use plain punctuation and no control characters`);
  return value;
};
const object = (value: unknown, keys: string[], what: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${what}: unexpected shape or field`);
  return value as Record<string, unknown>;
};

/** One pack file. `stem` is the file name without `.pack.json`; the name inside must equal it. */
export function parsePack(text: string, stem: string, layer: DomainPack["layer"]): DomainPack {
  if (Buffer.byteLength(text) > MAX_BYTES || text.includes("\r") || !NAME.test(stem)) throw new Error("invalid pack size, encoding or file name");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("pack is not valid JSON"); }
  const data = object(raw, KEYS, "pack");
  if (KEYS.some(key => data[key] === undefined)) throw new Error("pack needs name, profile, summary, roles, rubric and checks");
  if (data.name !== stem) throw new Error("pack name must equal its file name");
  if ((PROFILE_NAMES as readonly string[]).includes(stem)) throw new Error("a pack cannot take a profile's name");
  if (typeof data.profile !== "string" || !(PROFILE_NAMES as readonly string[]).includes(data.profile)) throw new Error(`pack profile must be one of ${PROFILE_NAMES.join(", ")}`);
  const summary = plain(data.summary, 160, "summary");
  if (!Array.isArray(data.roles) || data.roles.length > MAX_ROLES || new Set(data.roles).size !== data.roles.length || data.roles.some(id => typeof id !== "string" || !NAME.test(id))) throw new Error(`pack roles must be at most ${MAX_ROLES} distinct role ids`);
  if (!Array.isArray(data.rubric) || !data.rubric.length || data.rubric.length > MAX_RUBRIC) throw new Error(`pack rubric needs 1 to ${MAX_RUBRIC} criteria`);
  const rubric = data.rubric.map((entry, index) => {
    const item = object(entry, ["id", "text", "required"], `rubric ${index + 1}`);
    if (!criterionId(item.id) || typeof item.required !== "boolean") throw new Error(`rubric ${index + 1} needs a criterion id and a required flag`);
    return { id: item.id, text: plain(item.text, 300, `rubric ${item.id} text`), required: item.required };
  });
  if (new Set(rubric.map(item => item.id)).size !== rubric.length) throw new Error("rubric criterion ids must be distinct");
  if (!Array.isArray(data.checks) || data.checks.length > MAX_CHECKS) throw new Error(`pack checks must be at most ${MAX_CHECKS} entries`);
  const checks = data.checks.map((entry, index) => {
    const item = object(entry, ["id", "note"], `check ${index + 1}`);
    if (typeof item.id !== "string" || !NAME.test(item.id)) throw new Error(`check ${index + 1} needs a check id`);
    return { id: item.id, note: plain(item.note, 500, `check ${item.id} note`) };
  });
  if (new Set(checks.map(item => item.id)).size !== checks.length) throw new Error("check ids must be distinct");
  return { name: stem, profile: data.profile as ProfileName, summary, roles: [...data.roles as string[]], rubric, checks, layer };
}

/** Read one bounded regular file without following links, as `loadRoleCatalog` reads a project role. */
function readPack(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BYTES) throw new Error("pack must be a bounded regular file");
    const bytes = Buffer.alloc(MAX_BYTES + 1); let length = 0, n = 0;
    while ((n = readSync(fd, bytes, length, bytes.length - length, null)) > 0) { length += n; if (length > MAX_BYTES) throw new Error("pack exceeds file cap"); }
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || length !== after.size) throw new Error("pack changed during read");
    return bytes.subarray(0, length).toString("utf8");
  } finally { closeSync(fd); }
}

/**
 * Project-layer packs, `.agenthub/roles/<name>.pack.json` (#513a AC4): the same directory the role catalog reads, which ignores these files (it takes `.md` only).
 * A pack whose roles are not all in the catalog (shipped or project) is refused with the reason, never loaded half-usable. Reasons carry ids, never file contents.
 */
export function loadPacks(cwd?: string): PackCatalog {
  const packs = new Map<string, DomainPack>(), errors: PackCatalog["errors"] = [];
  if (!cwd) return { packs, errors };
  const catalog = loadRoleCatalog(cwd);
  try {
    const config = join(cwd, ".agenthub"), dir = join(config, "roles");
    // lstat, never stat: a link is not a directory to lstat, so a symlinked `.agenthub` or `roles` is refused before anything is read through it.
    for (const path of [config, dir]) if (!lstatSync(path).isDirectory()) throw new Error("unsafe role directory");
    // ponytail: 16 flat pack files, no recursive scan; an explicit pack index before larger collections.
    const files = readdirSync(dir).filter(name => name.endsWith(PACK_SUFFIX)).sort();
    if (files.length > MAX_FILES) throw new Error("too many project packs");
    for (const file of files) {
      const id = file.slice(0, -PACK_SUFFIX.length);
      try {
        const pack = parsePack(readPack(join(dir, file)), id, "project");
        const missing = pack.roles.filter(role => !catalog.roles.has(role));
        if (missing.length) throw new Error(`unknown roles: ${missing.join(", ")}`);
        packs.set(id, pack);
      } catch (error) { errors.push({ id: NAME.test(id) ? id : "invalid-file-id", reason: (error as Error).message.slice(0, 200) }); }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push({ id: "project", reason: "project pack directory unavailable or unsafe" }); }
  return { packs, errors };
}

/** What a pack contributes to the project's `profile_overrides`: the rubric as the profile's review checklist, the checks as advisory examples. Validated by `resolveProfile`. */
export function packOverrides(pack: DomainPack): Record<string, unknown> {
  const overrides: Record<string, unknown> = {
    review_checklist: [...pack.rubric.map(item => `${item.id}${item.required ? "" : " (optional)"}: ${item.text}`), "{check}"],
    ...(pack.checks.length ? { example_checks: pack.checks.map(check => `${check.id}: ${check.note}`) } : {}),
  };
  resolveProfile(pack.profile, overrides);
  return overrides;
}
