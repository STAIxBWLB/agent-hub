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

const DECORATIONS = ["**", "__", "*", "_", "`", "\"", "'"] as const;
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function stripLeadingDecoration(input: string): string {
  let value = input.trimStart();
  for (let count = 0; count < 8; count++) {
    const quote = /^(?:>\s*)+/.exec(value), heading = /^#{1,6}[ \t]+/.exec(value), list = /^(?:[-+*]|[0-9]{1,3}[.)])[ \t]+/.exec(value);
    const prefix = quote ?? heading ?? list;
    if (!prefix) break;
    value = value.slice(prefix[0].length).trimStart();
  }
  return value;
}

function advisorVerdict(input: string): { verdict: "APPROVE" | "REDO"; rest: string } | undefined {
  let value = stripLeadingDecoration(input);
  // A whole decorated verdict, e.g. **Verdict: REDO**: feedback.
  for (const marker of DECORATIONS) {
    const escaped = escapeRegExp(marker), whole = new RegExp(`^${escaped}\\s*Verdict\\s*:\\s*(APPROVE|REDO)\\s*${escaped}(?=$|[\\s:.-])`, "i").exec(value);
    if (whole) return { verdict: whole[1]!.toUpperCase() as "APPROVE" | "REDO", rest: value.slice(whole[0].length) };
  }
  // Optional prefix may itself be bold, italic, underscored or inline-code decorated.
  let prefix = /^Verdict\s*:\s*/i.exec(value);
  if (prefix) value = value.slice(prefix[0].length);
  else {
    for (const marker of DECORATIONS) {
      const escaped = escapeRegExp(marker), decorated = new RegExp(`^${escaped}\\s*Verdict\\s*:${escaped}\\s*`, "i").exec(value);
      if (decorated) { value = value.slice(decorated[0].length); break; }
    }
  }
  value = value.trimStart();
  const marker = DECORATIONS.find(candidate => value.startsWith(candidate));
  if (marker) value = value.slice(marker.length).trimStart();
  const match = (marker ? /^(APPROVE|REDO)/i : /^(APPROVE|REDO)\b/i).exec(value);
  if (!match) return undefined;
  let rest = value.slice(match[0].length);
  if (marker) {
    rest = rest.trimStart();
    if (!rest.startsWith(marker)) return undefined;
    rest = rest.slice(marker.length);
  }
  return { verdict: match[1]!.toUpperCase() as "APPROVE" | "REDO", rest };
}

export function parseAdvisorReply(text: unknown): AdvisorReply | undefined {
  if (!bounded(text)) return undefined;
  const parsed = advisorVerdict(text);
  if (!parsed) return undefined;
  if (parsed.verdict === "APPROVE") return { kind: "approve" };
  return { kind: "redo", feedback: feedback(parsed.rest.replace(/^\s*:\s*/, "").trim()) };
}

function category(value: unknown): value is EscalationCategory {
  return value === "none" || value === "repetition" || value === "false_progress"
    || value === "drift" || value === "desperation" || value === "capability_gap";
}

export function parseEscalationReply(text: unknown): EscalationReply | undefined {
  if (!bounded(text)) return undefined;
  let json = text;
  const trimmed = text.trim();
  if (trimmed.startsWith("```") || trimmed.endsWith("```")) {
    const fence = /^```[ \t]*(?:json[ \t]*)?\r?\n([\s\S]*?)\r?\n```[ \t]*$/i.exec(trimmed);
    if (!fence) return undefined;
    json = fence[1]!;
  }
  let value: unknown;
  try { value = JSON.parse(json); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const reply = value as Record<string, unknown>;
  if (typeof reply.escalate !== "boolean" || !category(reply.category)
    || typeof reply.new_evidence !== "boolean" || typeof reply.reason !== "string") return undefined;
  return { escalate: reply.escalate, category: reply.category, newEvidence: reply.new_evidence, reason: feedback(reply.reason) };
}
