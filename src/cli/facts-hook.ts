#!/usr/bin/env bun
// Managed Claude hook transport for turn-free facts, native observations and runtime permissions.
// PreToolUse preserves facts additionalContext and adds permission decisions; other phases observe only.
// A failed or timed-out hub decides nothing, leaving Claude's native permission rules in effect.
import { relative, resolve, isAbsolute } from "node:path";
import { realPath } from "../hub/project.ts";
import { isAgentConfigPath, isPermissionMode, foldSegment, hardLinked } from "../hub/permission-mode.ts";
import { ControlClient } from "../hub/control-client.ts";

/** A library call may target another hub; only the managed command hook inherits that target's native identity. */
export function nativeHookIdentity(stateDir: string, peer: string, env: NodeJS.ProcessEnv = process.env): { nativeInstanceId?: string; nativeLaunchId?: string; hookPurpose?: string } {
  if (env.AGENTHUB_STATE_DIR !== stateDir || env.AGENTHUB_PEER_ID !== peer) return {};
  return { ...(env.AGENTHUB_INSTANCE_ID ? { nativeInstanceId: env.AGENTHUB_INSTANCE_ID } : {}), ...(env.AGENTHUB_LAUNCH_ID ? { nativeLaunchId: env.AGENTHUB_LAUNCH_ID } : {}), ...(["facts", "idle", "facts-and-idle", "permission"].includes(env.AGENTHUB_HOOK_PURPOSE ?? "") ? { hookPurpose: env.AGENTHUB_HOOK_PURPOSE } : {}) };
}

/** Only resolving project paths outside the hub/native configuration directories receive a file grant. */
export function projectFileTool(tool: unknown, input: unknown, projectRoot: unknown): boolean {
  if (typeof projectRoot !== "string" || !isAbsolute(projectRoot) || !input || typeof input !== "object" || Array.isArray(input)) return false;
  const args = input as Record<string, unknown>;
  const key = ["Read", "Edit", "Write", "MultiEdit"].includes(String(tool)) ? "file_path" : tool === "NotebookEdit" ? "notebook_path" : ["LS", "Glob", "Grep"].includes(String(tool)) ? "path" : undefined;
  if (!key) return false;
  const optional = tool === "Glob" || tool === "Grep";
  if (args[key] !== undefined && (typeof args[key] !== "string" || !args[key])) return false;
  if (!optional && args[key] === undefined) return false;
  try {
    const root = realPath(projectRoot);
    const protectedPath = (path: string) => isAgentConfigPath(path) || path.split(/[\\/]/).some(part => [".agenthub", ".git"].includes(foldSegment(part)));
    const safe = (path: string) => {
      const requested = resolve(root, path), lexical = relative(root, requested);
      if (protectedPath(lexical)) return false;
      const real = realPath(requested), canonical = relative(root, real);
      // A hard link is another name for a file that may sit in a protected directory.
      return canonical !== ".." && !canonical.startsWith("../") && !isAbsolute(canonical) && !protectedPath(canonical) && !hardLinked(real);
    };
    const target = typeof args[key] === "string" ? args[key] as string : root;
    if (target.split(/[\\/]/).includes("..") || !safe(target)) return false;
    if (tool === "Grep" && args.glob !== undefined) {
      if (typeof args.glob !== "string" || !args.glob || args.glob.split(/[\\/]/).includes("..") || protectedPath(args.glob)) return false;
      if (/[?*[{]/.test(args.glob) || !safe(resolve(root, target, args.glob))) return false;
    }
    if (tool === "Glob") {
      if (typeof args.pattern !== "string" || !args.pattern) return false;
      if (args.pattern.split(/[\\/]/).includes("..") || protectedPath(args.pattern)) return false;
      // Wildcard expansions can enter symlinked or protected directories; their exact targets are unknown here.
      if (/[?*[{]/.test(args.pattern) || !safe(resolve(root, target, args.pattern))) return false;
    }
    return true;
  } catch { return false; }
}

/** The hook's stdout for one Claude Code hook input, or undefined for none. */
export async function factsHook(stdin: string, stateDir: string, peer: string, timeoutMs = 2000): Promise<string | undefined> {
  const input = JSON.parse(stdin) as { hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown; tool_use_id?: unknown; session_id?: unknown; transcript_path?: unknown };
  const phase = ({ SessionStart: "session", UserPromptSubmit: "start", PostToolUse: "post", Stop: "stop" } as Record<string, string>)[String(input.hook_event_name)] ?? "pre";
  const hub = await ControlClient.connect(stateDir, { role: "tools", peer }, timeoutMs);
  try {
    const res = await hub.request({
      t: "facts",
      phase,
      ...nativeHookIdentity(stateDir, peer),
      tool: typeof input.tool_name === "string" ? input.tool_name : "",
      input: input.tool_input ?? {},
      ...(typeof input.tool_use_id === "string" ? { toolUseId: input.tool_use_id } : {}),
      ...(typeof input.session_id === "string" ? { sessionId: input.session_id } : {}),
      ...(typeof input.transcript_path === "string" ? { transcriptPath: input.transcript_path } : {}),
      startedMs: performance.now(), // this process's own start-up and connect time, for the latency record
    }, timeoutMs);
    if (phase !== "pre" || !res?.ok) return undefined;
    const permission = isPermissionMode(res.permission) ? res.permission : "ask";
    const fileTool = projectFileTool(input.tool_name, input.tool_input, res.projectRoot);
    const allow = input.hook_event_name === "PreToolUse" && (permission === "never-ask" || permission === "ask-when-needed" && fileTool);
    const text = typeof res.text === "string" && res.text ? res.text : undefined;
    if (!allow && !text) return undefined;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...(text ? { additionalContext: text } : {}), ...(allow ? { permissionDecision: "allow" } : {}) } });
  } finally {
    hub.close();
  }
}

if (import.meta.main) {
  try {
    const stateDir = process.env.AGENTHUB_STATE_DIR;
    const out = stateDir ? await factsHook(await Bun.stdin.text(), stateDir, process.env.AGENTHUB_PEER_ID ?? "claude") : undefined;
    if (out) console.log(out);
  } catch {
    // a hook that fails must not get in the way of the tool call
  }
  process.exit(0);
}
