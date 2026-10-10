import { lstatSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

/** Operator-selected approval frequency; agent sandboxes remain separate. */
export const PERMISSION_MODES = ["ask", "ask-when-needed", "never-ask"] as const;
export type PermissionMode = typeof PERMISSION_MODES[number];
export const KIMI_MODE_IDS: Readonly<Record<PermissionMode, string>> = { ask: "default", "ask-when-needed": "yolo", "never-ask": "auto" };
export const isPermissionMode = (value: unknown): value is PermissionMode => typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
export function permissionDefaults(value: unknown): Record<string, PermissionMode> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("permission_modes must be an object with ask, ask-when-needed or never-ask values");
  const result: Record<string, PermissionMode> = {};
  for (const [peer, mode] of Object.entries(value)) {
    if (!["claude", "codex", "kimi", "pi", "local"].includes(peer)) throw new Error(`permission_modes.${peer}: unsupported peer`);
    if (!isPermissionMode(mode)) throw new Error(`permission_modes.${peer} must be ask, ask-when-needed or never-ask`);
    result[peer] = mode;
  }
  return result;
}
export const PI_EDIT_TOOLS = new Set(["edit", "write"]);
/** Native agent policy files are never included in scoped automatic file grants. */
export const AGENT_CONFIG_SEGMENTS: ReadonlySet<string> = new Set([".claude", ".codex", ".qwen", ".kimi", ".pi", ".mcp.json"]);
/** One spelling per name: a case-insensitive disk also opens `.mcp.j\u017Fon` (long s) as `.mcp.json`, which `toLowerCase` alone leaves apart. */
export const foldSegment = (segment: string): string => segment.normalize("NFKC").toUpperCase().toLowerCase();
export const isAgentConfigPath = (path: string): boolean => path.split(/[\\/]/).some(segment => AGENT_CONFIG_SEGMENTS.has(foldSegment(segment)));
/** A file with a second name somewhere else: a grant for this name would write that one too. */
export function hardLinked(path: string): boolean {
  try { const st = lstatSync(path); return st.isFile() && st.nlink > 1; } catch { return false; } // a file that does not exist yet has no other name
}
/**
 * Whether a scoped automatic write or edit grant may cover `path` (canonical) in the project at `root` (canonical):
 * inside the project, outside every agent's configuration, judged by the path within the project (a project that
 * itself lives under `.claude/worktrees/` is still a project), and not a hard link.
 */
export function grantablePath(root: string, path: string): boolean {
  const inside = relative(root, path);
  return !!inside && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside) && !isAgentConfigPath(inside) && !hardLinked(path);
}
