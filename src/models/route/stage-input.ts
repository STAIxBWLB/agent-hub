/** Local bounded observation, deliberately separate from the whole forwarded wire. */
export type StageTurn = "user" | "tool_result" | "compaction" | "other";
export interface StageResultInput { text: string; error: boolean; family: "read" | "mutation" | "execution" | "other"; associated: boolean; assistantTurn?: number }
export interface StageInput { turn: StageTurn; incomplete: boolean; assistantTurns: number; results: StageResultInput[] }
const MESSAGE_LIMIT = 64, RESULT_LIMIT = 16, CALL_LIMIT = 32, PART_LIMIT = 32;
const TEXT_BYTES = 64 * 1024, ID_BYTES = 128, NAME_BYTES = 64;

/** Accessors are not part of a transport record; capture never invokes them. */
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}
function boundedString(value: unknown, bytes: number): string | undefined {
  return typeof value === "string" && value.length <= bytes && Buffer.byteLength(value) <= bytes ? value : undefined;
}
function family(name: string | undefined): StageResultInput["family"] {
  if (!name) return "other";
  if (/^(bash|exec_command)$/i.test(name)) return "execution";
  if (/^(read|read_file|readfile|glob|grep|search|list|ls|lookup)(_|$)/i.test(name)) return "read";
  if (/^(write|write_file|edit|apply_patch|patch|delete|create|replace)(_|$)/i.test(name)) return "mutation";
  return "other";
}

export function captureStageInput(source: unknown): StageInput | undefined {
  try {
    const messages = Array.isArray(source) ? source : field(source, "messages");
    if (!Array.isArray(messages)) return undefined;
    let incomplete = messages.length > MESSAGE_LIMIT, bytes = 0, parts = 0, inspectedCalls = 0;
    const text = (value: unknown): string => {
      if (typeof value === "string") {
        if (value.length > TEXT_BYTES || bytes + Buffer.byteLength(value) > TEXT_BYTES) { incomplete = true; return ""; }
        bytes += Buffer.byteLength(value); return value;
      }
      if (!Array.isArray(value)) return "";
      const kept: string[] = [];
      const available = PART_LIMIT - parts;
      for (let index = 0; index < value.length && parts < PART_LIMIT; index++, parts++) {
        const part = field(value, String(index));
        if (field(part, "type") === "text" && typeof field(part, "text") === "string") kept.push(text(field(part, "text")));
      }
      if (value.length > available) incomplete = true;
      return kept.join("\n");
    };
    const calls = new Map<string, { name?: string; index: number } | null>();
    const observations: { id?: string; text: string; error: boolean; index: number }[] = [];
    let turn: StageTurn = "other", assistantTurns = 0, turnCaptured = false;
    for (let index = messages.length - 1; index >= Math.max(0, messages.length - MESSAGE_LIMIT); index--) {
      const message = field(messages, String(index)), role = field(message, "role");
      if (role === "system" || role === "developer") continue;
      if (role !== "user" && role !== "assistant" && role !== "tool") {
        incomplete = true;
        if (!turnCaptured) { turnCaptured = true; turn = "other"; }
        continue;
      }
      if (!turnCaptured) {
        turnCaptured = true;
        turn = role === "tool" ? "tool_result" : role === "user" ? "user" : "other";
        if (role === "user") {
          const latest = text(field(message, "content"));
          if (/\b(compact(?:ed|ion)?|context summary|conversation summary)\b|continued[\s\S]*(?:previous conversation|ran out of context)/i.test(latest)) turn = "compaction";
        }
      }
      if (role === "assistant") {
        assistantTurns++;
        const entries = field(message, "tool_calls");
        if (Array.isArray(entries)) {
          const availableCalls = CALL_LIMIT - inspectedCalls;
          for (let at = entries.length - 1; at >= 0 && inspectedCalls < CALL_LIMIT; at--, inspectedCalls++) {
            const call = field(entries, String(at));
            const id = boundedString(field(call, "id"), ID_BYTES);
            const name = boundedString(field(field(call, "function"), "name"), NAME_BYTES);
            if (id) calls.set(id, calls.has(id) ? null : { name, index });
            else incomplete = true;
          }
          if (entries.length > availableCalls) incomplete = true;
        }
      }
      if (role === "tool") {
        if (observations.length === RESULT_LIMIT) { incomplete = true; continue; }
        const id = boundedString(field(message, "tool_call_id"), ID_BYTES);
        observations.push({ id, index, text: text(field(message, "content")), error: field(message, "is_error") === true || field(message, "isError") === true });
      }
    }
    const resultIds = new Set<string>(), duplicates = new Set<string>();
    for (const result of observations) if (result.id) { if (resultIds.has(result.id)) duplicates.add(result.id); resultIds.add(result.id); }
    const results = observations.reverse().map(result => {
      const call = result.id && !duplicates.has(result.id) ? calls.get(result.id) : undefined;
      const associated = !!call && call.index < result.index;
      return { text: result.text, error: result.error, family: associated ? family(call!.name) : "other" as const, associated, ...(associated ? { assistantTurn: call!.index } : {}) };
    });
    return { turn, incomplete, assistantTurns, results };
  } catch { return undefined; }
}

/** Closed failure for numeric compatibility callers; never convert an unavailable size to zero. */
export class StageSizingUnavailableError extends Error {
  constructor() { super("model input size is unavailable; provide bounded JSON messages and tool schemas"); }
}
const WIRE_BYTES = 2_000_000;
/** Whole-wire UTF-8 estimate. This is not the bounded stage evidence capture. */
export function estimateStageInputTokens(messages: readonly unknown[], tools?: readonly unknown[]): number | undefined {
  try {
    if (!Array.isArray(messages) || tools !== undefined && !Array.isArray(tools)) return undefined;
    const envelope = { messages, ...(tools === undefined ? {} : { tools }) };
    const active = new Set<object>();
    let bytes = 0, inspected = 0;
    const append = (part: string): void => {
      bytes += Buffer.byteLength(part);
      if (bytes > WIRE_BYTES) throw new StageSizingUnavailableError();
    };
    const encode = (value: unknown, depth: number): void => {
      if (++inspected > WIRE_BYTES || depth > 128) throw new StageSizingUnavailableError();
      if (value === null || typeof value === "boolean") { append(String(value)); return; }
      if (typeof value === "string") {
        if (value.length > WIRE_BYTES) throw new StageSizingUnavailableError();
        append(JSON.stringify(value)); return;
      }
      if (typeof value === "number" && Number.isFinite(value)) { append(JSON.stringify(value)); return; }
      if (!value || typeof value !== "object" || active.has(value)) throw new StageSizingUnavailableError();
      const array = Array.isArray(value);
      if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new StageSizingUnavailableError();
      if (Object.getOwnPropertyDescriptor(value, "toJSON")) throw new StageSizingUnavailableError();
      active.add(value);
      try {
        append(array ? "[" : "{");
        let count = 0;
        const keys = array ? undefined : Object.keys(value);
        const length = Array.isArray(value) ? value.length : keys!.length;
        if (length > WIRE_BYTES) throw new StageSizingUnavailableError();
        for (let index = 0; index < length; index++) {
          const key = array ? String(index) : keys![index]!;
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor && !("value" in descriptor)) throw new StageSizingUnavailableError();
          const item: unknown = descriptor?.value;
          if (!array && item === undefined) continue;
          if (count++) append(",");
          if (!array) {
            if (key.length > WIRE_BYTES) throw new StageSizingUnavailableError();
            append(JSON.stringify(key)); append(":");
          }
          encode(item === undefined ? null : item, depth + 1);
        }
        append(array ? "]" : "}");
      } finally { active.delete(value); }
    };
    encode(envelope, 0);
    const estimate = Math.ceil(bytes / 4);
    return Number.isSafeInteger(estimate) ? estimate : undefined;
  } catch { return undefined; }
}
export function estimateInputTokens(messages: readonly unknown[], tools?: readonly unknown[]): number {
  const estimate = estimateStageInputTokens(messages, tools);
  if (estimate === undefined) throw new StageSizingUnavailableError();
  return estimate;
}
