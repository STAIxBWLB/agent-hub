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

// #469 R1: a light and a dark variant of every peer colour, one hue. The surfaces are the dashboard's panel tokens in
// src/ui/index.html (a test compares them); a colour is moved along lightness only until it reaches 3:1 on all of them.
export const LIGHT_SURFACES = Object.freeze(["#eeeef1", "#f8f8fa", "#fcfcfd", "#f1f1f4"] as const);
export const DARK_SURFACES = Object.freeze(["#121316", "#1a1b1f", "#222328", "#16171a"] as const);
const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16) / 255;
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(at => channel(hex, at)).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
}
export function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map(at => channel(hex, at)) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}
function fromHsl(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return "#" + [r, g, b].map(v => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("");
}
/** The colour with the same hue and saturation, moved in lightness (darker on light surfaces, lighter on dark) until it clears 3:1 on every surface. */
export function peerVariant(css: string, theme: "light" | "dark"): string {
  const surfaces = theme === "light" ? LIGHT_SURFACES : DARK_SURFACES;
  const ok = (hex: string) => surfaces.every(surface => contrast(hex, surface) >= 3);
  if (ok(css)) return css;
  const [h, s, l] = toHsl(css), step = theme === "light" ? -0.005 : 0.005;
  for (let next = l + step; next > 0 && next < 1; next += step) { const hex = fromHsl(h, s, next); if (ok(hex)) return hex; }
  return css;
}
/** Per-theme peer colours: the light variant by default, the dark one under data-theme="dark" and under the system preference. */
export function peerPaletteThemeCss(): string {
  const entries = Object.entries(PEER_PALETTE);
  const rules = (theme: "light" | "dark", scope = "") => entries.map(([key, value]) => `${scope}${scope ? " " : ""}.peer-${key}{--peer-color:${peerVariant(value.css, theme)}}`).join("");
  return rules("light")
    + rules("dark", ':root[data-theme="dark"]')
    + `@media(prefers-color-scheme:dark){${rules("dark", ':root:not([data-theme="light"]):not([data-theme="dark"])')}}`;
}
