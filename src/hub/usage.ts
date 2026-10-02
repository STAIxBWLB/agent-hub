import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { normalizeUsage, safeModelLabel, type NormalizedUsage } from "../omniroute/usage.ts";

export interface UsageRecord {
  id: string;
  at?: string;
  usage?: NormalizedUsage;
  requestedModel?: string;
  servedModel?: string;
  provider?: string;
}

function opaqueId(sessionId: string, messageId: string): string {
  return createHash("sha256").update(sessionId).update("\0").update(messageId).digest("hex");
}

// Documented successful Messages API values, including beta compaction, plus stop_sequence in native transcripts.
const COMPLETED_STOP_REASONS = new Set(["end_turn", "tool_use", "max_tokens", "stop_sequence", "pause_turn", "refusal", "model_context_window_exceeded", "compaction"]);

/**
 * Read Claude's native JSONL usage without returning transcript text, paths or session identity.
 * Repeated streaming records are collapsed by message.id, using only a completed assistant message.
 * Malformed lines and unavailable files are ignored so telemetry cannot interrupt a Claude turn.
 */
export function readClaudeTranscriptUsage(sessionId: string, transcriptPath: string): UsageRecord[] {
  try {
    // Avoid repeatedly parsing an unbounded transcript on the daemon's polling path.
    if (statSync(transcriptPath).size > 32 * 1024 * 1024) {
      // Signal unavailable coverage with a stable opaque id; a repeated poll dedupes in the report.
      return [{ id: opaqueId(sessionId, "transcript-too-large") }];
    }
    const latest = new Map<string, { usage?: NormalizedUsage; at?: string; servedModel?: string }>();
    for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { type?: unknown; timestamp?: unknown; sessionId?: unknown; message?: unknown };
        if (typeof row.sessionId === "string" && row.sessionId !== sessionId) continue;
        if (row.type !== "assistant" || !row.message || typeof row.message !== "object") continue;
        const message = row.message as { id?: unknown; stop_reason?: unknown; usage?: unknown; model?: unknown };
        if (typeof message.id !== "string" || !message.id || typeof message.stop_reason !== "string" || !message.stop_reason) continue;
        const supportedStopReason = COMPLETED_STOP_REASONS.has(message.stop_reason);
        const usage = supportedStopReason ? normalizeUsage(message.usage) : undefined;
        const at = typeof row.timestamp === "string" && Number.isFinite(Date.parse(row.timestamp)) ? new Date(row.timestamp).toISOString() : undefined;
        const servedModel = safeModelLabel(message.model);
        latest.set(message.id, { ...(usage ? { usage } : {}), ...(at ? { at } : {}), ...(servedModel ? { servedModel } : {}) });
      } catch {
        // A streaming or crash-truncated line is not a record.
      }
    }
    return [...latest].map(([messageId, value]) => ({ id: opaqueId(sessionId, messageId), ...value }));
  } catch {
    return [];
  }
}
