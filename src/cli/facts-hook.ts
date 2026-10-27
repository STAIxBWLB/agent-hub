#!/usr/bin/env bun
import { claudePeer as defaultChannelPeer } from "../hub/claude-state.ts";
import { definitionOf } from "../adapters/registry.ts";
// Managed Claude hook transport for turn-free facts, native observations and runtime permissions.
// PreToolUse preserves facts additionalContext and adds permission decisions; other phases observe only.
// A failed or timed-out hub decides nothing, leaving Claude's native permission rules in effect.
import { relative, resolve, isAbsolute } from "node:path";
import { matchesPolicy } from "../hub/path-policy.ts";
import { realPath } from "../hub/project.ts";
import { isAgentConfigPath, isInstructionPath, isPermissionMode, hardLinked, isHubWritePath } from "../hub/permission-mode.ts";
import { ControlClient } from "../hub/control-client.ts";

/** A library call may target another hub; only the managed command hook inherits that target's native identity. */
export function nativeHookIdentity(stateDir: string, peer: string, env: NodeJS.ProcessEnv = process.env): { nativeInstanceId?: string; nativeLaunchId?: string; hookPurpose?: string } {
  if (env.AGENTHUB_STATE_DIR !== stateDir || env.AGENTHUB_PEER_ID !== peer) return {};
  return { ...(env.AGENTHUB_INSTANCE_ID ? { nativeInstanceId: env.AGENTHUB_INSTANCE_ID } : {}), ...(env.AGENTHUB_LAUNCH_ID ? { nativeLaunchId: env.AGENTHUB_LAUNCH_ID } : {}), ...(["facts", "idle", "facts-and-idle", "permission"].includes(env.AGENTHUB_HOOK_PURPOSE ?? "") ? { hookPurpose: env.AGENTHUB_HOOK_PURPOSE } : {}) };
}

/** Only resolving project paths outside the hub/native configuration directories receive a file grant. */
export function projectFileTool(tool: unknown, input: unknown, projectRoot: unknown, protectInstructions = false, readOnly: string[] = []): boolean {
  if (typeof projectRoot !== "string" || !isAbsolute(projectRoot) || !input || typeof input !== "object" || Array.isArray(input)) return false;
  const args = input as Record<string, unknown>;
  const key = ["Read", "Edit", "Write", "MultiEdit"].includes(String(tool)) ? "file_path" : tool === "NotebookEdit" ? "notebook_path" : ["LS", "Glob", "Grep"].includes(String(tool)) ? "path" : undefined;
  if (!key) return false;
  const optional = tool === "Glob" || tool === "Grep";
  if (args[key] !== undefined && (typeof args[key] !== "string" || !args[key])) return false;
  if (!optional && args[key] === undefined) return false;
  try {
    const root = realPath(projectRoot);
    const mutates = ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(String(tool));
    const protectedPath = (path: string) => isAgentConfigPath(path) || isHubWritePath(path) || (protectInstructions && mutates && isInstructionPath(path));
    const safe = (path: string) => {
      const requested = resolve(root, path), lexical = relative(root, requested);
      if (protectedPath(lexical)) return false;
      const real = realPath(requested), canonical = relative(root, real);
      // A hard link is another name for a file that may sit in a protected directory.
      return canonical !== ".." && !canonical.startsWith("../") && !isAbsolute(canonical) && !protectedPath(canonical) && !hardLinked(real);
    };
    const target = typeof args[key] === "string" ? args[key] as string : root;
    if (target.split(/[\\/]/).includes("..") || !safe(target)) return false;
    if (mutates && matchesPolicy(root, target, readOnly, true)) return false;
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

/** Only a usable managed scoped-write grant may evaluate filesystem policy. */
export function scopedWriteBlocked(phase: string, permission: unknown, tool: unknown, evaluate: () => boolean): boolean {
  return phase === "pre" && permission === "ask-when-needed" && ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(String(tool)) && !evaluate();
}

/** The hook's stdout for one Claude Code hook input, or undefined for none. */
export async function factsHook(stdin: string, stateDir: string, peer: string, timeoutMs = 2000, nativeEvent?: string): Promise<string | undefined> {
  if (nativeEvent !== undefined) {
    if (Buffer.byteLength(stdin, "utf8") > 1024 * 1024) return undefined;
    const port = definitionOf(peer)?.hooks?.factsHook;
    const payload: unknown = JSON.parse(stdin);
    if (!port?.decode(nativeEvent, payload)) return undefined;
    const hub = await ControlClient.connect(stateDir, { role: "tools", peer, ...(nativeHookIdentity(stateDir, peer).nativeLaunchId ? { launchId: nativeHookIdentity(stateDir, peer).nativeLaunchId } : {}) }, timeoutMs);
    try {
      const reply = await hub.request({ t: "native_facts", event: nativeEvent, payload, ...nativeHookIdentity(stateDir, peer) }, timeoutMs);
      const output = reply.ok ? port.encode(nativeEvent, typeof reply.text === "string" ? reply.text : undefined) : undefined;
      return output ? JSON.stringify(output) : undefined;
    } finally { hub.close(); }
  }
  const input = JSON.parse(stdin) as { hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown; tool_use_id?: unknown; session_id?: unknown; transcript_path?: unknown };
  const phase = ({ SessionStart: "session", UserPromptSubmit: "start", PostToolUse: "post", Stop: "stop" } as Record<string, string>)[String(input.hook_event_name)] ?? "pre";
  const hub = await ControlClient.connect(stateDir, { role: "tools", peer, ...(nativeHookIdentity(stateDir, peer).nativeLaunchId ? { launchId: nativeHookIdentity(stateDir, peer).nativeLaunchId } : {}) }, timeoutMs);
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
    const fileTool = projectFileTool(input.tool_name, input.tool_input, res.projectRoot, res.protectInstructionFiles === true);
    // Always-ask (#636): the hub classed this call (publish, external-write, destroy, install). `ask` wins over every allow, never-ask included.
    // A present value that is not an empty list asks, even when malformed: the hook never turns an unreadable classification into an allow.
    const classed = res.actionClasses !== undefined && !(Array.isArray(res.actionClasses) && res.actionClasses.length === 0);
    const classNames = Array.isArray(res.actionClasses) ? res.actionClasses.filter((key: unknown): key is string => typeof key === "string" && /^[a-z-]{1,32}$/.test(key)) : [];
    // The daemon supplies this ceiling from the authenticated instance's flow roles, never a peer-id spelling.
    const mayGrant = !Object.hasOwn(res, "mutationGrants") || res.mutationGrants === true || ["Read", "LS", "Glob", "Grep"].includes(String(input.tool_name));
    const allow = mayGrant && !classed && input.hook_event_name === "PreToolUse" && (permission === "never-ask" || permission === "ask-when-needed" && fileTool);
    const text = typeof res.text === "string" && res.text ? res.text : undefined;
    if (!allow && !classed && !text) return undefined;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...(text ? { additionalContext: text } : {}), ...(classed ? { permissionDecision: "ask", permissionDecisionReason: `agent-hub always-ask${classNames.length ? `: ${classNames.join(", ")}` : ""}` } : allow ? { permissionDecision: "allow" } : {}) } });
  } finally {
    hub.close();
  }
}

if (import.meta.main) {
  try {
    const stateDir = process.env.AGENTHUB_STATE_DIR;
    const out = stateDir ? await factsHook(await Bun.stdin.text(), stateDir, process.env.AGENTHUB_PEER_ID ?? defaultChannelPeer(undefined), 2000, process.env.AGENTHUB_HOOK_EVENT) : undefined;
    if (out) console.log(out);
  } catch {
    // a hook that fails must not get in the way of the tool call
  }
  process.exit(0);
}
