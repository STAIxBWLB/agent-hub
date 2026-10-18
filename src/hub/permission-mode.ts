import { definitionOf } from "../adapters/registry.ts";
import { lstatSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Operator-selected approval frequency; agent sandboxes remain separate. */
export const PERMISSION_MODES = ["ask", "ask-when-needed", "never-ask"] as const;
export type PermissionMode = typeof PERMISSION_MODES[number];
export { KIMI_MODE_IDS } from "../adapters/definitions/kimi-native.ts";
export { QWEN_MODE_IDS } from "../adapters/definitions/qwen-native.ts";
export const isPermissionMode = (value: unknown): value is PermissionMode => typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
export function permissionDefaults(value: unknown): Record<string, PermissionMode> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("permission_modes must be an object with ask, ask-when-needed or never-ask values");
  const result: Record<string, PermissionMode> = {};
  for (const [peer, mode] of Object.entries(value)) {
    const definition = typeof peer === "string" ? definitionOf(peer) : undefined;
    if (!definition) throw new Error(`permission_modes.${peer}: unsupported peer`);
    if (definition.permission.unmanaged) throw new Error(`${definition.displayName} native policy is unmanaged; no hub permission_modes.${peer} mapping exists`);
    if (!isPermissionMode(mode)) throw new Error(`permission_modes.${peer} must be ask, ask-when-needed or never-ask`);
    result[peer] = mode;
  }
  return result;
}
/** Approval frequency does not create a common sandbox across native peers. */
export function permissionBoundary(peer: string): string {
  const definition = definitionOf(peer);
  if (definition?.permission.unmanaged) return `${peer}: native policy unmanaged; NO hub sandbox; approvals belong to its native tools`;
  if (definition?.trust.hubSandboxed) return `${peer}: inside hub sandbox, path guard and denylist`;
  if (definition?.transport === "claude-channel" || definition?.transport === "codex-appserver") return `${peer}: native vendor bounds; no hub sandbox`;
  return `${peer}: runs its own tools; NO hub sandbox`;
}
/** What a mode lets a peer do without asking, in one line a person reads before choosing it (#269). */
export function permissionGrant(peer: string, mode: PermissionMode): string {
  const grant = definitionOf(peer)?.permission.grants?.[mode];
  if (grant !== undefined) return grant;
  if (mode === "ask") return "every write, edit and shell command asks";
  return mode === "never-ask" ? "every tool runs without asking, inside the hub sandbox and path guard" : "write and edit inside the project run without asking; shell and git writes still ask";
}
export const PI_EDIT_TOOLS = new Set(["edit", "write"]);
/** Native agent policy files are never included in scoped automatic file grants. */
export const AGENT_CONFIG_SEGMENTS: ReadonlySet<string> = new Set([".claude", ".codex", ".qwen", ".kimi", ".kimi-code", ".jcode", ".pi", ".mcp.json", ".agents", ".claude.json"]);
export const INSTRUCTION_FILES: ReadonlySet<string> = new Set(["agents.md", "claude.md", "qwen.md"]);
export const isInstructionPath = (path: string): boolean => path.split(/[\\/]/).some(segment => INSTRUCTION_FILES.has(foldSegment(segment)));
export function instructionProtection(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error("protect_instruction_files must be a boolean");
  return value;
}
/**
 * One spelling per name, as a case-insensitive disk sees it: it opens `.mcp.j\u017Fon` (long s) as `.mcp.json`, and
 * HFS+ also ignores the default-ignorable code points (a zero-width joiner inside `.codex` is still `.codex`).
 */
export const foldSegment = (segment: string): string => segment.normalize("NFKC").replace(/\p{Default_Ignorable_Code_Point}/gu, "").toLowerCase().toUpperCase().toLowerCase();
/** The hub's and git's own directories: writing them changes what runs outside any agent's control. */
export const HUB_WRITE_SEGMENTS: ReadonlySet<string> = new Set([".git", ".agenthub"]);
export const isHubWritePath = (path: string): boolean => path.split(/[\\/]/).some(segment => HUB_WRITE_SEGMENTS.has(foldSegment(segment)));
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
export function grantablePath(root: string, path: string, originalPath?: string, protectInstructions = false): boolean {
  const inside = relative(root, path);
  const original = originalPath === undefined ? inside : relative(root, resolve(root, originalPath));
  return !!inside && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside) && !isAgentConfigPath(inside) && !isHubWritePath(inside) && !isAgentConfigPath(original) && !isHubWritePath(original) && !(protectInstructions && (isInstructionPath(inside) || isInstructionPath(original))) && !hardLinked(path);
}
