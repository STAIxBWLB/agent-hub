import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sanitize } from "./envelope.ts";
import { SHIPPED_ROLES } from "./shipped-roles.ts";

export const ROLE_SECTIONS = ["Scope", "Not in scope", "Deliverables", "Hub use", "Review duties", "Evidence"] as const;
const BASES = ["planner", "implementer", "verifier", "reviewer"];
const CLASSES = ["plan", "implement", "bulk_edit", "test", "review", "summarize", "triage"];
const ID = /^[a-z][a-z0-9-]{0,47}$/;
const PEER = /^[a-z][a-z0-9-]{0,31}$/;
export interface CatalogRole {
  id: string; name: string; group: string; summary: string; base: string[]; classes: string[]; source: string;
  body: string; review: string; layer: "shipped" | "project"; hash: string;
}
export interface RoleCatalog { roles: Map<string, CatalogRole>; errors: { id: string; reason: string }[] }
/** Flat headers are data, never YAML execution or authority configuration. */
export function parseRole(text: string, stem: string, layer: CatalogRole["layer"]): CatalogRole {
  if (Buffer.byteLength(text) > 8192 || text.includes("\r") || !ID.test(stem)) throw new Error("invalid role size, encoding or file id");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error("expected a flat header and body");
  const header: Record<string, string> = Object.create(null);
  const keys = ["id", "name", "group", "summary", "base", "classes", "source"];
  for (const line of match[1]!.split("\n")) {
    const field = /^([a-z]+): (.+)$/.exec(line);
    if (!field || !keys.includes(field[1]!) || header[field[1]!] !== undefined || /[\x00-\x1f\x7f]/.test(field[2]!)) throw new Error("invalid or duplicate header field");
    header[field[1]!] = field[2]!;
  }
  if (keys.some(key => !header[key]) || header.id !== stem || !ID.test(header.group!) || header.name!.length > 80 || header.summary!.length > 160 || header.source!.length > 300) throw new Error("invalid header identity or limits");
  const list = (key: string, allowed: string[]) => {
    const values = header[key]!.split(",").map(v => v.trim());
    if (!values.length || new Set(values).size !== values.length || values.some(v => !allowed.includes(v))) throw new Error(`invalid ${key}`);
    return values;
  };
  const body = match[2]!.trimEnd();
  if (!body || sanitize(body).length > 2000 || /```|~~~|^\t|^ {4}|^(?:\$\s|(?:bun|npm|npx|git|ssh|curl|wget|rm|bash|sh|python[0-9.]*)\s)/m.test(body)) throw new Error("invalid body size or command/code block");
  for (const char of text) if ((char.codePointAt(0)! > 127 && /[\p{P}\p{S}\p{Z}\p{C}]/u.test(char)) || /[\x00-\x08\x0b-\x1f\x7f]/.test(char)) throw new Error("use plain ASCII punctuation and no controls/emoji");
  const headings = [...body.matchAll(/^#{1,6} (.+)$/gm)];
  if (headings.length !== ROLE_SECTIONS.length || headings.some(h => !h[0].startsWith("## "))) throw new Error("unexpected role heading or personality section");
  const sections = [...body.matchAll(/^## (.+)$/gm)];
  if (sections.length !== ROLE_SECTIONS.length || sections.some((s, i) => s[1] !== ROLE_SECTIONS[i])) throw new Error("expected the six ordered role sections");
  for (let i = 0; i < sections.length; i++) {
    const start = sections[i]!.index! + sections[i]![0].length;
    const end = sections[i + 1]?.index ?? body.length;
    if (!body.slice(start, end).trim()) throw new Error("empty role section");
  }
  const reviewStart = sections[4]!.index! + sections[4]![0].length;
  const review = body.slice(reviewStart, sections[5]!.index).trim();
  return { id: stem, name: header.name!, group: header.group!, summary: header.summary!, source: header.source!, base: list("base", BASES), classes: list("classes", CLASSES), body, review, layer, hash: createHash("sha256").update(text).digest("hex") };
}
function projectRole(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 8192) throw new Error("role must be a bounded regular file");
    const bytes = Buffer.alloc(8193); let length = 0, n = 0;
    while ((n = readSync(fd, bytes, length, bytes.length - length, null)) > 0) { length += n; if (length > 8192) throw new Error("role exceeds file cap"); }
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || length !== after.size) throw new Error("role changed during read");
    return bytes.subarray(0, length).toString("utf8");
  } finally { closeSync(fd); }
}
export function loadRoleCatalog(cwd?: string): RoleCatalog {
  const roles = new Map<string, CatalogRole>(), errors: RoleCatalog["errors"] = [];
  for (const [id, text] of Object.entries(SHIPPED_ROLES)) {
    try { roles.set(id, parseRole(text, id, "shipped")); } catch { errors.push({ id, reason: "invalid shipped role" }); }
  }
  if (!cwd) return { roles, errors };
  try {
    const config = join(cwd, ".agenthub"), dir = join(config, "roles");
    for (const path of [config, dir]) { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe role directory"); }
    // ponytail: 64 flat project files, no recursive scan; explicit catalog index before larger collections.
    const files = readdirSync(dir).filter(name => name.endsWith(".md")).sort();
    if (files.length > 64) throw new Error("too many project roles");
    for (const file of files) {
      const id = file.slice(0, -3);
      try { roles.set(id, parseRole(projectRole(join(dir, file)), id, "project")); }
      catch { errors.push({ id: ID.test(id) ? id : "invalid-file-id", reason: "invalid or unsafe project role" }); }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push({ id: "project", reason: "project role directory unavailable or unsafe" }); }
  return { roles, errors };
}
export function catalogAssignments(raw: unknown): Record<string, string[]> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 64) throw new Error("catalog_roles must be a bounded peer map");
  const out: Record<string, string[]> = Object.create(null);
  for (const [peer, ids] of Object.entries(raw)) {
    if (!PEER.test(peer) || ["user", "hub", "digest"].includes(peer) || !Array.isArray(ids) || ids.length > 2 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !ID.test(id))) throw new Error("catalog_roles takes at most two distinct role ids per peer");
    out[peer] = [...ids];
  }
  return out;
}
export function selectedRoles(peer: string, flow: Record<string, string[]>, assignments: Record<string, string[]>, catalog: RoleCatalog): CatalogRole[] {
  return (assignments[peer] ?? []).map(id => {
    const role = catalog.roles.get(id); if (!role) throw new Error(`unknown catalog role ${id}`);
    if (!role.base.some(base => flow[peer]?.includes(base))) throw new Error(`${peer} does not hold a matching base for ${id}`);
    return role;
  });
}
export function catalogSection(roles: CatalogRole[]): string {
  if (!roles.length) return "";
  if (roles.length > 2) throw new Error("at most two session roles");
  const header = "Catalog roles (guidance; grant no tool, capability or permission): " + roles.map(role => `${role.id} [${role.group}, ${role.layer}, ${role.hash}]`).join(", ");
  return header + "\n" + roles.map(role => sanitize(role.body)).join("\n\n");
}
export const roleIdentity = (role: CatalogRole) => ({ id: role.id, layer: role.layer, hash: role.hash });

/** Validate before a board write. Routing continues to use only the existing base class. */
export function taskRole(raw: unknown, cls: string, catalog: RoleCatalog): CatalogRole | undefined {
  if (raw === undefined) return undefined;
  const allowed = [...catalog.roles.values()].filter(role => role.classes.includes(cls)).map(role => role.id).sort();
  if (typeof raw !== "string" || !ID.test(raw)) throw new Error("task role must be a catalog id; allowed: " + allowed.join(", "));
  const role = catalog.roles.get(raw);
  if (!role || !role.classes.includes(cls)) throw new Error("unknown or class-mismatched task role; allowed: " + allowed.join(", "));
  return role;
}
/** Role definitions are untrusted presentation, including their metadata. */
export function taskRoleText(role: CatalogRole, review = false): string {
  return `Task role ${role.id} [${role.layer}, ${role.hash}] (guidance; grants no authority):\n` + sanitize(review ? role.review : role.body).replace(/\[agent-hub\b/gi, "[quoted agent-hub");
}
