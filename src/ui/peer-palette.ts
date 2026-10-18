import { definitionOf, OFFICE_PEER_ORDER } from "../adapters/registry.ts";
import type { NATIVE_DISPLAYS } from "../adapters/definitions/native-display.ts";

type NativePalette = { [Kind in keyof typeof NATIVE_DISPLAYS]: {
  tone: (typeof NATIVE_DISPLAYS)[Kind]["palette"]["tone"];
  ansi: (typeof NATIVE_DISPLAYS)[Kind]["palette"]["ansi"];
  css: (typeof NATIVE_DISPLAYS)[Kind]["palette"]["fg"];
} };
const other = { tone: "muted", ansi: "\x1b[90m", css: "#8a8f99" } as const;
const nativePalette = Object.fromEntries(OFFICE_PEER_ORDER.map(kind => {
  const palette = definitionOf(kind)!.display.palette;
  return [kind, { tone: palette.tone ?? other.tone, ansi: palette.ansi ?? other.ansi, css: palette.fg }];
})) as NativePalette;

/** Stable peer identity colors shared by terminal board/status and the dashboard (#263). */
export const PEER_PALETTE = Object.freeze({
  ...nativePalette,
  hub: { tone: "info", ansi: "\x1b[36m", css: "#489da8" },
  other,
} as const);
export function peerStyle(peer: string): (typeof PEER_PALETTE)[keyof typeof PEER_PALETTE] {
  return PEER_PALETTE[Object.hasOwn(PEER_PALETTE, peer) ? peer as keyof typeof PEER_PALETTE : "other"];
}
export function peerPaletteCss(): string {
  return Object.entries(PEER_PALETTE).map(([key, value]) => `.peer-${key}{--peer-color:${value.css}}`).join("");
}
