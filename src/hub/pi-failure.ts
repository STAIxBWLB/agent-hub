import { sanitize } from "./envelope.ts";

/** Public failure diagnostics stay one bounded line; private callers omit the text entirely. */
export const PI_FAILURE_TEXT_LIMIT = 300;
export function piFailureText(reason: string): string {
  return Array.from(sanitize(reason.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim())).slice(0, PI_FAILURE_TEXT_LIMIT).join("");
}
