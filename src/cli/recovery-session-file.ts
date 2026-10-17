import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TerminalBinding } from "./terminal-recovery.ts";

/** The exact transcript file, or the exact sessions directory recursively searched for a rollout. */
export function checkedSessionPath(binding: TerminalBinding, kind: "rollout" | "transcript"): string {
  if (kind === "rollout") return join(binding.launch.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  const config = binding.launch.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const slug = binding.projectRoot.replace(/[^a-zA-Z0-9]/g, "-");
  return join(config, "projects", slug, `${binding.sessionId}.jsonl`);
}

/** Only an absent path is positive missing evidence. Unreadable or non-file evidence stays unknown. */
export function recordedFileState(file: string): "found" | "missing" | "unknown" {
  try { return statSync(file).isFile() ? "found" : "unknown"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unknown"; }
}
