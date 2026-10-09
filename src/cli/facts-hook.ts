#!/usr/bin/env bun
// Managed Claude hook transport for turn-free facts, native observations and runtime permissions.
// PreToolUse preserves facts additionalContext and adds permission decisions; other phases observe only.
// A failed or timed-out hub decides nothing, leaving Claude's native permission rules in effect.
import { isPermissionMode } from "../hub/permission-mode.ts";
import { ControlClient } from "../hub/control-client.ts";

/** A library call may target another hub; only the managed command hook inherits that target's native identity. */
export function nativeHookIdentity(stateDir: string, peer: string, env: NodeJS.ProcessEnv = process.env): { nativeInstanceId?: string; nativeLaunchId?: string } {
  if (env.AGENTHUB_STATE_DIR !== stateDir || env.AGENTHUB_PEER_ID !== peer) return {};
  return { ...(env.AGENTHUB_INSTANCE_ID ? { nativeInstanceId: env.AGENTHUB_INSTANCE_ID } : {}), ...(env.AGENTHUB_LAUNCH_ID ? { nativeLaunchId: env.AGENTHUB_LAUNCH_ID } : {}) };
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
    const fileTool = ["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS"].includes(String(input.tool_name));
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
