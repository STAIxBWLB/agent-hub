// CLI output standard v1 (docs/design/cli-output.md): the portable core. This file imports nothing, so a CLI outside the hub can reuse it as is. It holds the nine roles, the marker table and color resolution.
// Human-output code names a role or a marker, never an SGR code or a glyph literal.
/**
 * The nine semantic roles of CLI output standard v1 on the 16 ANSI colors, so a terminal theme decides the shades. Code names a role,
 * never an SGR code (`test/cli-output-conformance.test.ts` fails on a raw SGR literal in `src/cli/` and `src/hub/`). `value` is the
 * default foreground and carries no SGR. Bold is only for `header`, `section` and the three status roles; no backgrounds.
 */
/** End of every painted span. */
export const SGR_RESET = "\x1b[0m";
/** SGR of the console tones that are not an identity palette entry; the role table above is the standard, these are the TUI's own. */
export const TONE_SGR = Object.freeze({ strong: "\x1b[1;36m", failure: "\x1b[31m", number: "\x1b[1m", issueRef: "\x1b[4m", taskRef: "\x1b[4;35m" } as const);
export type Role = "header" | "section" | "key" | "value" | "success" | "warning" | "error" | "hint" | "accent";
export const ROLE_SGR: Readonly<Record<Role, string>> = Object.freeze({
  header: "\x1b[1;34m", section: "\x1b[1;35m", key: "\x1b[34m", value: "", success: "\x1b[1;32m", warning: "\x1b[1;33m", error: "\x1b[1;31m", hint: "\x1b[90m", accent: "\x1b[36m",
});
export const MARKER_NAMES = ["ok", "fail", "warn", "absent", "unknown", "pending", "active", "next"] as const;
export type MarkerName = (typeof MARKER_NAMES)[number];
/** Semantic glyphs, each with its ASCII form and the one role that colors it. Code names a marker, never a glyph literal. */
export const MARKERS: Readonly<Record<MarkerName, { glyph: string; ascii: string; role: Role }>> = Object.freeze({
  ok: { glyph: "\u2713", ascii: "ok", role: "success" }, fail: { glyph: "\u2717", ascii: "x", role: "error" }, warn: { glyph: "\u26a0", ascii: "!", role: "warning" },
  absent: { glyph: "-", ascii: "-", role: "hint" }, unknown: { glyph: "?", ascii: "?", role: "hint" }, pending: { glyph: "~", ascii: "~", role: "hint" },
  active: { glyph: "*", ascii: "*", role: "success" }, next: { glyph: "\u2192", ascii: "->", role: "accent" },
});
export const SECTION_MARKER = { glyph: "\u25b8", ascii: ">" } as const;
export const MARKER_COLUMN = 2;
/** Cells a string occupies: East Asian Ambiguous characters count as 1, so a Korean or CJK terminal keeps the same alignment. */
export const cellWidth = (text: string): number => Bun.stringWidth(text, { ambiguousIsNarrow: true });
/** A marker padded to the 2-cell marker column (ASCII `ok` and `->` fill it). */
export function markerCell(name: MarkerName, ascii: boolean): string {
  const text = ascii ? MARKERS[name].ascii : MARKERS[name].glyph;
  return text + " ".repeat(Math.max(0, MARKER_COLUMN - cellWidth(text)));
}
/** The environment one output stream's color decision reads (`streamEnv` builds it). */
export interface ColorEnv { isTTY: boolean; TERM?: string; NO_COLOR?: string; FORCE_COLOR?: string; CLICOLOR?: string; CLICOLOR_FORCE?: string }
/** `isTTY` of the stream that is decided (stdout and stderr are decided separately) plus the color variables of `env`. */
export function streamEnv(isTTY: boolean, env: Readonly<Record<string, string | undefined>> = process.env): ColorEnv {
  return { isTTY, TERM: env.TERM, NO_COLOR: env.NO_COLOR, FORCE_COLOR: env.FORCE_COLOR, CLICOLOR: env.CLICOLOR, CLICOLOR_FORCE: env.CLICOLOR_FORCE };
}
/**
 * Color for one stream, first rule wins (standard v1): `--color=never|always`; non-empty NO_COLOR off; FORCE_COLOR or CLICOLOR_FORCE
 * non-empty and not `0` on; FORCE_COLOR=0 or CLICOLOR=0 off; a TTY whose TERM is not `dumb` on; otherwise off. `auto` and no flag
 * apply rules 2 to 6. An unknown flag value is a usage error. `--json` is never colored: the caller does not ask.
 */
export function resolveColor(flag: string | undefined, env: ColorEnv): boolean | Error {
  if (flag === "always") return true;
  if (flag === "never") return false;
  if (flag !== undefined && flag !== "auto") return new Error("usage: ahub <command> [--color=auto|always|never]");
  if (env.NO_COLOR) return false;
  if ((env.FORCE_COLOR && env.FORCE_COLOR !== "0") || (env.CLICOLOR_FORCE && env.CLICOLOR_FORCE !== "0")) return true;
  if (env.FORCE_COLOR === "0" || env.CLICOLOR === "0") return false;
  return env.isTTY && env.TERM !== "dumb";
}
/** ASCII markers when `--ascii` is given or the locale (`LC_ALL`, then `LC_CTYPE`, then `LANG`) is not UTF-8. */
export function asciiMarkers(env: Readonly<Record<string, string | undefined>> = process.env, flag = false): boolean {
  return flag || !/utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || "");
}
