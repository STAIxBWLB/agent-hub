// Hub-specific TUI tones; the portable standard is provided by @staix/cli-output.
export const TONE_SGR = Object.freeze({ strong: "\x1b[1;36m", failure: "\x1b[31m", number: "\x1b[1m", issueRef: "\x1b[4m", taskRef: "\x1b[4;35m" } as const);
export { SGR_RESET, ROLE_SGR, MARKER_NAMES, MARKERS, SECTION_MARKER, MARKER_COLUMN, cellWidth, markerCell, streamEnv, resolveColor, asciiMarkers } from "@staix/cli-output";
export type { Role, MarkerName, ColorEnv } from "@staix/cli-output";
