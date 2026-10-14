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
export function petFrame(character: CharacterId = "stai", pose: PetPose, size: PetSize = "line", glyphs: "ascii" | "blocks" = "ascii"): readonly string[] {
  return CHARACTERS[character].frames[glyphs][pose][size];
}
/** A full footer reserves the catalog maximum, independent of state and session character cycling. */
export function petFooterRows(size: PetSize): number { return size === "full" ? 9 : 4; }
