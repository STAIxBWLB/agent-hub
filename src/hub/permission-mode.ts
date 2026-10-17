import { isSupportedPeer } from "./peer-catalog.ts";
import { lstatSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Operator-selected approval frequency; agent sandboxes remain separate. */
export const PERMISSION_MODES = ["ask", "ask-when-needed", "never-ask"] as const;
export type PermissionMode = typeof PERMISSION_MODES[number];
export const KIMI_MODE_IDS: Readonly<Record<PermissionMode, string>> = { ask: "default", "ask-when-needed": "yolo", "never-ask": "auto" };
export { QWEN_MODE_IDS } from "../adapters/definitions/qwen-native.ts";
export const isPermissionMode = (value: unknown): value is PermissionMode => typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
export function permissionDefaults(value: unknown): Record<string, PermissionMode> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("permission_modes must be an object with ask, ask-when-needed or never-ask values");
  const result: Record<string, PermissionMode> = {};
  for (const [peer, mode] of Object.entries(value)) {
    if (!isSupportedPeer(peer)) throw new Error(`permission_modes.${peer}: unsupported peer`);
    if (peer === "jcode") throw new Error("Jcode native policy is unmanaged; no hub permission_modes.jcode mapping exists");
    if (!isPermissionMode(mode)) throw new Error(`permission_modes.${peer} must be ask, ask-when-needed or never-ask`);
    result[peer] = mode;
  }
  return result;
}
/** Approval frequency does not create a common sandbox across native peers. */
export function permissionBoundary(peer: string): string {
  if (peer === "jcode") return "jcode: native policy unmanaged; NO hub sandbox; approvals belong to its native tools";
  if (peer === "pi" || peer === "local") return `${peer}: inside hub sandbox, path guard and denylist`;
  if (peer === "claude" || peer === "codex") return `${peer}: native vendor bounds; no hub sandbox`;
  return `${peer}: runs its own tools; NO hub sandbox`;
}
/** What a mode lets a peer do without asking, in one line a person reads before choosing it (#269). */
export function permissionGrant(peer: string, mode: PermissionMode): string {
  if (peer === "jcode") return "no verified hub mode mapping; native policy only";
  if (mode === "ask") return peer === "codex" ? "the session's own approval policy applies again" : peer === "kimi" ? "Kimi asks as it does on its own" : peer === "claude" ? "Claude's own permission rules decide" : "every write, edit and shell command asks";
  if (peer === "qwen") return mode === "never-ask" ? "Qwen yolo approves every tool; NO hub sandbox" : "Qwen auto-edit approves file edits; shell commands ask; NO hub sandbox";
  if (peer === "kimi") return mode === "never-ask" ? "Kimi's auto mode: nothing asks" : "Kimi's yolo mode: it asks only where it judges it must";
  if (peer === "codex") return mode === "never-ask" ? "approval policy never on every turn: nothing asks" : "approval policy on-request on every turn";
  if (peer === "claude") return mode === "never-ask" ? "every tool runs without asking" : "file tools on project files run without asking, outside .agenthub, .git and agent configuration; other tools keep Claude's own rules";
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
