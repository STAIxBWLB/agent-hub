import { MARKERS, asciiMarkers } from "./output-standard.ts";

// Deliberately imports only the light output-standard module: launch.ts, bench.ts and the other modules that warn reach this file early, and
// console-state.ts (through error-format.ts) would close an import cycle through the adapter registry.
/** Control characters out of a message or next step, so a daemon-supplied string cannot move the cursor. */
const plain = (text: string) => text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

/** The one warning format (standard v1, Messages): `ahub: warning: <what>: <why>`, a marker only on a terminal, and an optional `→ next` line. Pure; `error-format.ts` re-exports it. */
export function warningLines(message: string, next: string | undefined, terminal: boolean, ascii: boolean): string[] {
  const line = `ahub: warning: ${plain(message).replace(/[\r\n]+/g, " ")}`;
  const first = terminal ? `${MARKERS.warn[ascii ? "ascii" : "glyph"]} ${line}` : line;
  return next ? [first, `  ${MARKERS.next[ascii ? "ascii" : "glyph"]} ${plain(next)}`] : [first];
}

/** `warningLines` on stderr for this process; main.ts's `warn()` is this same function. */
export function warnLine(message: string, next?: string): void {
  console.error(warningLines(message, next, !!process.stderr.isTTY, asciiMarkers(process.env, process.argv.includes("--ascii"))).join("\n"));
}
