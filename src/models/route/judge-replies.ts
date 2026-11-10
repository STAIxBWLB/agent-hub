/** Host-owned semantic replies. They never select a model or grant admission. */
const REPLY_BYTES = 64 * 1024;
const FEEDBACK_BYTES = 4096;

export type AdvisorReply = { kind: "approve" } | { kind: "redo"; feedback: string };
export type EscalationCategory = "none" | "repetition" | "false_progress" | "drift" | "desperation" | "capability_gap";
export interface EscalationReply {
  escalate: boolean;
  category: EscalationCategory;
  newEvidence: boolean;
  reason: string;
}

function bounded(text: unknown): text is string {
  return typeof text === "string" && text.length <= REPLY_BYTES && Buffer.byteLength(text, "utf8") <= REPLY_BYTES;
}

function feedback(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= FEEDBACK_BYTES) return text;
  let bytes = 0, result = "";
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > FEEDBACK_BYTES) break;
    result += character; bytes += size;
  }
  return result;
}

export function parseAdvisorReply(text: unknown): AdvisorReply | undefined {
  if (!bounded(text)) return undefined;
  const match = /^\s*(APPROVE|REDO)\b/i.exec(text);
  if (!match) return undefined;
  if (match[1]?.toUpperCase() === "APPROVE") return { kind: "approve" };
  return { kind: "redo", feedback: feedback(text.slice(match[0].length).replace(/^\s*:\s*/, "").trim()) };
}

function category(value: unknown): value is EscalationCategory {
  return value === "none" || value === "repetition" || value === "false_progress"
    || value === "drift" || value === "desperation" || value === "capability_gap";
}

export function parseEscalationReply(text: unknown): EscalationReply | undefined {
  if (!bounded(text)) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const reply = value as Record<string, unknown>;
  if (typeof reply.escalate !== "boolean" || !category(reply.category)
    || typeof reply.new_evidence !== "boolean" || typeof reply.reason !== "string") return undefined;
  return { escalate: reply.escalate, category: reply.category, newEvidence: reply.new_evidence, reason: feedback(reply.reason) };
}
