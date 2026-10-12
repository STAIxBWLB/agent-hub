/** Stable peer identity colors shared by terminal board/status and the dashboard (#263). */
export const PEER_PALETTE = Object.freeze({
  claude: { tone: "peerClaude", ansi: "\x1b[94m", css: "#6495ed" },
  codex: { tone: "peerCodex", ansi: "\x1b[96m", css: "#22b8cf" },
  kimi: { tone: "taskKeyword", ansi: "\x1b[35m", css: "#bc73ca" },
  pi: { tone: "attention", ansi: "\x1b[33m", css: "#c79936" },
  local: { tone: "success", ansi: "\x1b[32m", css: "#4caa77" },
  hub: { tone: "info", ansi: "\x1b[36m", css: "#489da8" },
  other: { tone: "muted", ansi: "\x1b[90m", css: "#8a8f99" },
} as const);
export function peerStyle(peer: string): (typeof PEER_PALETTE)[keyof typeof PEER_PALETTE] {
  return PEER_PALETTE[Object.hasOwn(PEER_PALETTE, peer) ? peer as keyof typeof PEER_PALETTE : "other"];
}
export function peerPaletteCss(): string {
  return Object.entries(PEER_PALETTE).map(([key, value]) => `.peer-${key}{--peer-color:${value.css}}`).join("");
}
