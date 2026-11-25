import { MARKERS, asciiMarkers } from "./output-standard.ts";

// Deliberately imports only the light output-standard module: launch.ts, bench.ts and the other modules that warn reach this file early, and
// error-format.ts (through console-state.ts) would close an import cycle through the adapter registry.
/** Control characters out of a next-step command, so a daemon-supplied string cannot move the cursor. */
const plain = (text: string) => text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

/** A stderr warning outside main.ts (which has its own `warn`): `ahub: warning: <what>: <why>` and an optional `→ next` line, the form `warningLines` pins. */
export function warnLine(message: string, next?: string): void {
  const ascii = asciiMarkers(process.env, process.argv.includes("--ascii")), terminal = !!process.stderr.isTTY;
  const line = `ahub: warning: ${plain(message).replace(/[\r\n]+/g, " ")}`;
  console.error([terminal ? `${MARKERS.warn[ascii ? "ascii" : "glyph"]} ${line}` : line, ...(next ? [`  ${MARKERS.next[ascii ? "ascii" : "glyph"]} ${plain(next)}`] : [])].join("\n"));
}
