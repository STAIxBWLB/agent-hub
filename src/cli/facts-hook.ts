#!/usr/bin/env bun
// Claude Code PreToolUse and PostToolUse hook for turn-free facts (issue #108). `ahub claude` adds it to the session's
// settings in a turn-free project. It never blocks or fails a tool call: a hub that is down, an advisory project or any
// error prints nothing. A fact comes back as `additionalContext`, which Claude Code adds with the tool result.
import { ControlClient } from "../hub/control-client.ts";

/** The hook's stdout for one Claude Code hook input, or undefined for none. */
export async function factsHook(stdin: string, stateDir: string, peer: string, timeoutMs = 2000): Promise<string | undefined> {
  const input = JSON.parse(stdin) as { hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown };
  const phase = input.hook_event_name === "PostToolUse" ? "post" : "pre";
  const hub = await ControlClient.connect(stateDir, { role: "tools", peer }, timeoutMs);
  try {
    const res = await hub.request({ t: "facts", phase, tool: typeof input.tool_name === "string" ? input.tool_name : "", input: input.tool_input ?? {} }, timeoutMs);
    if (phase !== "pre" || !res?.ok || typeof res.text !== "string" || !res.text) return undefined;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: res.text } });
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
