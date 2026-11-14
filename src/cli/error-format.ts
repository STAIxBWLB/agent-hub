import { MARKERS, terminalText } from "./console-state.ts";

// CLI output standard v1, Messages. Pure, so a test reads the exact text without starting the CLI (main.ts runs on import).
/**
 * 2 for a usage error (standard v1: an unknown command or flag, a bad argument), 1 for every other failure. A usage error is one whose text starts with
 * `usage:` or names an unknown command, or that carries its usage as a line of its own (`<what is wrong>\nusage: ...`, the form `ahub study` prints), or is a flag
 * with no value (`--task needs a value`), or is the release command's malformed-arguments refusal. A refusal that changed nothing (`never-ask requires --yes`) is not a usage error and keeps exit 1.
 */
export function failureExitCode(message: string): 1 | 2 {
  return /^(usage:|unknown command )|\nusage:|^--[a-z][a-z-]* needs a value|^invalid release command$/i.test(message) ? 2 : 1;
}

/** The error line and its optional next step, as `fail()` prints them; pure so a test reads the exact text. */
export function errorLines(message: string, next: string | undefined, terminal: boolean, ascii: boolean): string[] {
  const line = `ahub: ${message}`;
  const first = terminal ? `${MARKERS.fail[ascii ? "ascii" : "glyph"]} ${line}` : line;
  return next ? [first, `  ${MARKERS.next[ascii ? "ascii" : "glyph"]} ${terminalText(next)}`] : [first];
}
