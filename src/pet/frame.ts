import { CHARACTERS, CHARACTER_IDS, type CharacterId, type PetGlyphs, type PetPose, type PetSize } from "./characters.ts";
export { CHARACTERS, CHARACTER_IDS };
export type { CharacterId, PetGlyphs, PetPose, PetSize };
export function characterId(value: unknown): value is CharacterId { return typeof value === "string" && (CHARACTER_IDS as readonly string[]).includes(value); }
export function petSize(requested: PetSize = "line", columns: number, rows: number): PetSize {
  if (requested === "full" && columns >= 100 && rows >= 40) return "full";
  return requested !== "line" && columns >= 100 ? "mini" : "line";
}
export function petGlyphs(requested: PetGlyphs = "auto", env: Record<string, string | undefined> = process.env): "ascii" | "blocks" {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return requested !== "ascii" && /utf-?8/i.test(locale) && !!env.TERM && !["dumb", "linux"].includes(env.TERM) ? "blocks" : "ascii";
}
/** Double-width letter cells (the petPixels font glyphs u,v,w,x,y,z,9,0,j,k,l,m,n,p,q,r) print as letter tiles in text terminals. */
const TEXT_GLYPH_ALIAS: Record<string, string> = { u: "S", v: "█", w: "T", x: "█", y: "A", z: "█", "9": "I", "0": "█", j: "S", k: "█", l: "T", m: "█", n: "A", p: "█", q: "I", r: "█" };
export function petFrame(character: CharacterId = "stai", pose: PetPose, size: PetSize = "line", glyphs: "ascii" | "blocks" = "ascii"): readonly string[] {
  const frame = CHARACTERS[character].frames[glyphs][pose][size];
  return glyphs === "blocks" ? frame.map(row => [...row].map(glyph => TEXT_GLYPH_ALIAS[glyph] ?? glyph).join("")) : frame;
}
/** A full footer reserves the catalog maximum, independent of state and session character cycling. */
export function petFooterRows(size: PetSize): number { return size === "full" ? 9 : 4; }
