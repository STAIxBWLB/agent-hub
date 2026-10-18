/** Existing native identity swatches; hub and unknown-peer styling stays in the UI. */
export const CLAUDE_DISPLAY = { palette: { fg: "#6495ed", bg: "transparent", tone: "peerClaude", ansi: "\x1b[94m" } } as const;
export const CODEX_DISPLAY = { palette: { fg: "#22b8cf", bg: "transparent", tone: "peerCodex", ansi: "\x1b[96m" } } as const;
export const KIMI_DISPLAY = { palette: { fg: "#bc73ca", bg: "transparent", tone: "taskKeyword", ansi: "\x1b[35m" } } as const;
export const PI_DISPLAY = { palette: { fg: "#c79936", bg: "transparent", tone: "attention", ansi: "\x1b[33m" } } as const;
export const LOCAL_DISPLAY = { palette: { fg: "#4caa77", bg: "transparent", tone: "success", ansi: "\x1b[32m" } } as const;
// These two kinds deliberately retain the existing 'other' fallback, not new public swatches.
export const QWEN_DISPLAY = { palette: { fg: "#8a8f99", bg: "transparent", tone: "muted", ansi: "\x1b[90m" } } as const;
export const JCODE_DISPLAY = { palette: { fg: "#8a8f99", bg: "transparent", tone: "muted", ansi: "\x1b[90m" } } as const;

/** Kinds with a public named swatch; keep their exact literal types in compatibility projections. */
export const NATIVE_DISPLAYS = { claude: CLAUDE_DISPLAY, codex: CODEX_DISPLAY, kimi: KIMI_DISPLAY, pi: PI_DISPLAY, local: LOCAL_DISPLAY } as const;

const STREAM_TONES = { claude: "peerClaude", codex: "peerCodex" } as const;
/** Stream headers historically color only these speakers, independently of their board palette. */
export function nativeStreamTone(peer: string): (typeof STREAM_TONES)[keyof typeof STREAM_TONES] | undefined {
  return Object.hasOwn(STREAM_TONES, peer) ? STREAM_TONES[peer as keyof typeof STREAM_TONES] : undefined;
}
