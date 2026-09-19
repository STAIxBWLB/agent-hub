#!/usr/bin/env bun
// Claude Code pipes a JSON document to its status line command on every render, and that document carries
// `rate_limits` (five_hour, seven_day: used_percentage, resets_at). `hub claude` puts this script in front of the
// user's own status line command: it records the limits for the hub's budget coordinator and then runs the original
// command with the same input, so the status line looks exactly as before. It must never fail the render.
import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const input = await Bun.stdin.text();
let own = "";
try {
  const limits = JSON.parse(input).rate_limits;
  const pct = (w: any) => (typeof w?.used_percentage === "number" ? `${Math.round(w.used_percentage)}%` : "-");
  if (limits) own = `agent-hub  5h ${pct(limits.five_hour)}  wk ${pct(limits.seven_day)}`;
  const dir = process.env.AGENTHUB_STATE_DIR;
  if (limits && dir) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "claude-usage.json");
    writeFileSync(`${file}.tmp`, JSON.stringify({ at: Date.now(), rate_limits: limits }));
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
