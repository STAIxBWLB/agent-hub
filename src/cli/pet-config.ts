import { readFileSync } from "node:fs";
import { join } from "node:path";
import { characterId, type CharacterId, type PetSize, type PetGlyphs } from "../pet/frame.ts";

export interface PetConfig { enabled: boolean; blink: boolean; bell: boolean; character?: CharacterId; size?: PetSize; glyphs?: PetGlyphs; notice?: string }
/** Console-local presentation only; this reader never writes config or grants authority. */
export function loadPetConfig(cwd: string): PetConfig {
  let value: unknown;
  for (const name of ["config.json", "config.local.json"]) {
    try {
      const file = JSON.parse(readFileSync(join(cwd, ".agenthub", name), "utf8"));
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
  const invalid = Object.keys(row).some(key => !["character", "size", "glyphs", "blink", "bell"].includes(key)) ||
    row.character !== undefined && !characterId(row.character) || row.size !== undefined && !["line", "mini", "full"].includes(row.size as string) ||
    row.glyphs !== undefined && (typeof row.glyphs !== "string" || !["auto", "ascii", "blocks"].includes(row.glyphs)) ||
    row.blink !== undefined && typeof row.blink !== "boolean" || row.bell !== undefined && typeof row.bell !== "boolean";
  return { enabled: true, blink: typeof row.blink === "boolean" ? row.blink : true, bell: typeof row.bell === "boolean" ? row.bell : false,
    ...(characterId(row.character) && row.character !== "stai" ? { character: row.character } : {}),
    ...(row.size === "mini" || row.size === "full" ? { size: row.size } : {}),
    ...(row.glyphs === "ascii" || row.glyphs === "blocks" ? { glyphs: row.glyphs } : {}),
    ...(invalid ? { notice: "Unknown pet option; using stai line defaults for that option." } : {}) };
}
