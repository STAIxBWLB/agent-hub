#!/usr/bin/env bun
// Claude Code pipes a JSON document to its status line command on every render, and that document carries
// `rate_limits` (five_hour, seven_day: used_percentage, resets_at). `ahub claude` puts this script in front of the
// user's own status line command: it records the limits for the hub's budget coordinator and then runs the original
// command with the same input, so the status line looks exactly as before. It must never fail the render.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const input = await Bun.stdin.text();
let own = "";
try {
  const parsed = JSON.parse(input);
  const limits = parsed.rate_limits;
  const pct = (w: any) => (typeof w?.used_percentage === "number" ? `${Math.round(w.used_percentage)}%` : "-");
  if (limits) own = `agent-hub  5h ${pct(limits.five_hour)}  wk ${pct(limits.seven_day)}`;
  const dir = process.env.AGENTHUB_STATE_DIR;
  if (limits && dir) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "claude-usage.json");
    writeFileSync(`${file}.tmp`, JSON.stringify({ at: Date.now(), rate_limits: limits }));
    renameSync(`${file}.tmp`, file);
  }
  const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : typeof parsed.sessionId === "string" ? parsed.sessionId : "";
  if (sessionId && dir) {
    // Bind context to the launcher, daemon and native session. Persist no prompts or transcript text.
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "claude-context.json");
    const c = parsed.context_window;
    const current = c?.current_usage;
    const numeric = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
    const record = current !== null && typeof current === "object" && !Array.isArray(current);
    const context = { context_window_size: numeric(c?.context_window_size), used_percentage: numeric(c?.used_percentage),
      current_usage: !record ? null : { input_tokens: numeric(current.input_tokens), cache_creation_input_tokens: numeric(current.cache_creation_input_tokens), cache_read_input_tokens: numeric(current.cache_read_input_tokens) } };
    writeFileSync(`${file}.tmp`, JSON.stringify({ at: Date.now(), sessionId, instanceId: process.env.AGENTHUB_INSTANCE_ID, launchId: process.env.AGENTHUB_LAUNCH_ID, context }), { mode: 0o600 });
    chmodSync(`${file}.tmp`, 0o600);
    renameSync(`${file}.tmp`, file);
  }
  if (sessionId && dir) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "claude-session.json");
    // The transcript path lets the hub tell a zero-turn session (file not yet created, so
    // `claude --resume` can never work) from one whose conversation must be preserved (#64).
    const transcriptPath = typeof parsed.transcript_path === "string" && parsed.transcript_path ? parsed.transcript_path : undefined;
    writeFileSync(`${file}.tmp`, JSON.stringify({ at: Date.now(), sessionId, ...(transcriptPath ? { transcriptPath } : {}), ...(process.env.AGENTHUB_INSTANCE_ID ? { instanceId: process.env.AGENTHUB_INSTANCE_ID } : {}), ...(process.env.AGENTHUB_LAUNCH_ID ? { launchId: process.env.AGENTHUB_LAUNCH_ID } : {}) }), { mode: 0o600 });
    chmodSync(`${file}.tmp`, 0o600);
    renameSync(`${file}.tmp`, file);
  }
} catch {
  // not JSON, or the state dir is gone: the status line still has to render
}
const original = process.env.AGENTHUB_STATUSLINE_CMD;
if (original) {
  const res = spawnSync("/bin/sh", ["-c", original], { input, encoding: "utf8", timeout: 5000 });
  process.stdout.write(res.stdout ?? "");
} else {
  // No status line of the user's own to wrap: `--settings` still replaces whatever Claude Code would show, so say something useful.
  process.stdout.write(`${own}\n`);
}
