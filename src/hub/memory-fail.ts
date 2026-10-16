export const REMEMBER_TEXT_MAX_BYTES = 4000;
const FAIL_FIELDS = [
  ["approach", "Approach"], ["symptom", "Symptom"], ["cause", "Cause"], ["evidence", "Evidence"], ["retry_when", "Retry when"],
] as const;

/** Compose ordinary v1 text only. Validation precedes policy screening, storage and display caps. */
export function composeRememberText(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("memory note must be an object");
  const note = input as Record<string, unknown>;
  if (note.text !== undefined && typeof note.text !== "string") throw new Error("text must be a string");
  const text = typeof note.text === "string" ? note.text.trim() : "";
  const fields: string[] = [];
  for (const [name, label] of FAIL_FIELDS) {
    const value = note[name];
    if (value === undefined) continue;
    if (note.kind !== "fail") throw new Error(`${name} is only available for kind fail`);
    if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a nonempty string`);
    fields.push(`${label}: ${value.trim()}`);
  }
  if (!text && !fields.length) throw new Error("text is required, or supply structured fields with kind fail");
  const result = text && fields.length ? `${text}\n\n${fields.join("\n")}` : text || fields.join("\n");
  const bytes = Buffer.byteLength(result, "utf8");
  if (bytes > REMEMBER_TEXT_MAX_BYTES) throw new Error(`memory text is ${bytes} UTF-8 bytes; maximum is ${REMEMBER_TEXT_MAX_BYTES} bytes (refused without truncation)`);
  return result;
}
