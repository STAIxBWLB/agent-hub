import { readFileSync } from "node:fs";
import { join } from "node:path";
import { characterId, type CharacterId, type PetSize, type PetGlyphs } from "./frame.ts";

export type PetPalette = "blue" | "teal" | "violet" | "ochre";
const PALETTES: Record<string, PetPalette> = { a: "blue", b: "teal", c: "violet", d: "ochre", blue: "blue", teal: "teal", violet: "violet", ochre: "ochre" };
export interface PetConfig { enabled: boolean; blink: boolean; bell: boolean; character?: CharacterId; size?: PetSize; glyphs?: PetGlyphs; palette?: PetPalette; notice?: string; window?: boolean }
/** Console-local presentation only; this reader never writes config or grants authority. */
export function loadPetConfig(cwd: string): PetConfig {
  let value: unknown;
  let enabled = true;
  for (const name of ["config.json", "config.local.json"]) {
    try {
      const file = JSON.parse(readFileSync(join(cwd, ".agenthub", name), "utf8"));
      // A window-only local opt-in does not undo inherited pet:false presentation.
      if (file.pet === false) enabled = false;
      else if (file.pet !== undefined && !(file.pet && typeof file.pet === "object" && !Array.isArray(file.pet) && Object.keys(file.pet).length === 1 && Object.hasOwn(file.pet, "window"))) enabled = true;
      if (file.pet !== undefined) value = value && typeof value === "object" && file.pet && typeof file.pet === "object" ? { ...value, ...file.pet } : file.pet;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (value === false) return { enabled: false, blink: true, bell: false };
  const defaults = { enabled: true, blink: true, bell: false };
  if (value === undefined) return defaults;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...defaults, notice: "Unknown pet configuration; using stai line defaults." };
  const row = value as Record<string, unknown>;
  const invalid = Object.keys(row).some(key => !["character", "size", "glyphs", "blink", "bell", "palette", "window"].includes(key)) ||
    row.character !== undefined && !characterId(row.character) || row.size !== undefined && !["line", "mini", "full"].includes(row.size as string) ||
    row.glyphs !== undefined && (typeof row.glyphs !== "string" || !["auto", "ascii", "blocks"].includes(row.glyphs)) ||
    row.palette !== undefined && (typeof row.palette !== "string" || !PALETTES[row.palette.toLowerCase()]) ||
    row.blink !== undefined && typeof row.blink !== "boolean" || row.bell !== undefined && typeof row.bell !== "boolean" || row.window !== undefined && typeof row.window !== "boolean";
  const palette = typeof row.palette === "string" ? PALETTES[row.palette.toLowerCase()] : undefined;
  return { enabled, blink: typeof row.blink === "boolean" ? row.blink : true, bell: typeof row.bell === "boolean" ? row.bell : false,
    ...(typeof row.window === "boolean" ? { window: row.window } : {}),
    ...(characterId(row.character) && row.character !== "stai" ? { character: row.character } : {}),
    ...(row.size === "mini" || row.size === "full" ? { size: row.size } : {}),
    ...(row.glyphs === "ascii" || row.glyphs === "blocks" ? { glyphs: row.glyphs } : {}),
    ...(palette && palette !== "teal" ? { palette } : {}),
    ...(invalid ? { notice: "Unknown pet option; using stai line defaults for that option." } : {}) };
}
