import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { normalizeUsage, safeModelLabel, type NormalizedUsage } from "../omniroute/usage.ts";

export interface UsageRecord {
  id: string;
  /** True only for a native assistant end_turn row, never a tool-use/compaction message. */
  completedTurn?: boolean;
  at?: string;
  usage?: NormalizedUsage;
  requestedModel?: string;
  servedModel?: string;
  provider?: string;
}

/** Claude-native counters have separate input/output/cache categories, often no explicit total. */
export function claudeReportedTokens(usage: NormalizedUsage | undefined): number | undefined {
  if (!usage) return undefined;
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  const total = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return Number.isSafeInteger(total) && total >= 0 ? total : undefined;
}

export type ClaudeCompletionWait = { record?: UsageRecord; reason: "verified" | "unavailable" | "baseline" | "before-start" | "superseded" };
/** After acknowledging Stop, observe its delayed transcript append within a bounded 1200 ms window. */
export async function waitForClaudeCompletion(read: () => UsageRecord | undefined, current: () => boolean, start: { at: number; baseline?: string }, timeoutMs = 1200): Promise<ClaudeCompletionWait> {
  const budget = Number.isFinite(timeoutMs) ? Math.min(1200, Math.max(0, timeoutMs)) : 1200;
  if (budget === 0) return { reason: "unavailable" };
  const deadline = performance.now() + budget;
  let reason: ClaudeCompletionWait["reason"] = "unavailable";
  while (true) {
    if (!current()) return { reason: "superseded" };
    const record = read();
    if (!current()) return { reason: "superseded" };
    if (performance.now() > deadline) return { reason };
    const at = typeof record?.at === "string" ? Date.parse(record.at) : NaN;
    if (record?.completedTurn && Number.isFinite(at)) {
      if (record.id === start.baseline) reason = "baseline";
      else if (at < start.at) reason = "before-start";
      else return { record, reason: "verified" };
    } else reason = "unavailable";
    const left = deadline - performance.now();
    if (left <= 0) return { reason };
    await Bun.sleep(Math.min(40, left));
  }
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
    return transcriptRecords(sessionId, readFileSync(transcriptPath, "utf8"));
  } catch {
    return [];
  }
}

/** The tail read for turn completion: the newest end_turn row is always near the end. */
export const COMPLETION_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * The newest completed assistant turn (stop_reason end_turn) in a transcript of any size, from its last
 * COMPLETION_TAIL_BYTES only (#517: a whole-file cap made every Stop unverifiable on a long session). The first,
 * possibly partial, line of a cut tail is dropped. Undefined when there is none or the file cannot be read.
 */
export function readClaudeTranscriptCompletion(sessionId: string, transcriptPath: string, tailBytes = COMPLETION_TAIL_BYTES): UsageRecord | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size, start = Math.max(0, size - tailBytes);
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) { const n = readSync(fd, buffer, read, buffer.length - read, start + read); if (n <= 0) break; read += n; }
    let text = buffer.subarray(0, read).toString("utf8");
    // A cut tail starts inside a line: drop up to the first newline, or all of it when it holds none.
    if (start > 0) { const nl = text.indexOf("\n"); text = nl < 0 ? "" : text.slice(nl + 1); }
    return transcriptRecords(sessionId, text).filter(record => record.completedTurn).at(-1);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

function transcriptRecords(sessionId: string, text: string): UsageRecord[] {
  const latest = new Map<string, { usage?: NormalizedUsage; at?: string; servedModel?: string; completedTurn?: boolean }>();
  for (const line of text.split("\n")) {
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
      latest.set(message.id, { ...(usage ? { usage } : {}), ...(at ? { at } : {}), ...(servedModel ? { servedModel } : {}), ...(message.stop_reason === "end_turn" ? { completedTurn: true } : {}) });
    } catch {
      // A streaming or crash-truncated line is not a record.
    }
  }
  return [...latest].map(([messageId, value]) => ({ id: opaqueId(sessionId, messageId), ...value }));
}
