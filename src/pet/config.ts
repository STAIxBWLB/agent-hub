import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { characterId, type CharacterId, type PetSize, type PetGlyphs } from "./frame.ts";

export type PetPalette = "blue" | "teal" | "violet" | "ochre";
const PALETTES: Record<string, PetPalette> = { a: "blue", b: "teal", c: "violet", d: "ochre", blue: "blue", teal: "teal", violet: "violet", ochre: "ochre" };
export function petPalette(value: unknown): PetPalette | undefined {
  return typeof value === "string" ? PALETTES[value.toLowerCase()] : undefined;
}
export const PET_WINDOW_RETIRED_NOTICE = "The floating pet window moved to acon Mini; run acon ui and open Mini.";
/** Source compatibility only. Removed window data is never a terminal option or a settings capability. */
export function stripLegacyPetWindow(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "window")) return value;
  const { window: _retired, ...terminal } = value as Record<string, unknown>;
  return terminal;
}
export interface PetConfig { enabled: boolean; blink: boolean; bell: boolean; character?: CharacterId; size?: PetSize; glyphs?: PetGlyphs; palette?: PetPalette; notice?: string }
/** Console-local presentation only; it merges pet.palette into config.local.json and grants no authority. */
export function savePetPalette(cwd: string, value: string): string {
  const palette = petPalette(value);
  if (!palette) throw new Error("Unknown pet palette; use blue, teal, violet or ochre (a/b/c/d).");
  const dir = join(cwd, ".agenthub");
  const path = join(dir, "config.local.json");
  let file: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("malformed");
    file = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot update config.local.json; it is malformed.");
  }
  const pet = file.pet && typeof file.pet === "object" && !Array.isArray(file.pet) ? file.pet as Record<string, unknown> : {};
  mkdirSync(dir, { recursive: true });
  const temporary = join(dir, `config.local.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify({ ...file, pet: { ...pet, palette } }, null, 2) + "\n", { flag: "wx" });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
  return `Pet palette set to ${palette}.`;
}
/** Console-local presentation only; this reader never writes config or grants authority. */
export function loadPetConfig(cwd: string): PetConfig {
  let value: unknown;
  let enabled = true, retiredWindow = false;
  for (const name of ["config.json", "config.local.json"]) {
    try {
      const file = JSON.parse(readFileSync(join(cwd, ".agenthub", name), "utf8"));
      const pet = stripLegacyPetWindow(file.pet);
      if (pet !== file.pet) {
        retiredWindow = true;
        // A retired-only block contributes no terminal override, including no enablement over inherited pet:false.
        if (pet && typeof pet === "object" && !Object.keys(pet).length) continue;
      }
      if (pet === false) enabled = false;
      else if (pet !== undefined) enabled = true;
      if (pet !== undefined) value = value && typeof value === "object" && pet && typeof pet === "object" ? { ...value, ...pet } : pet;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const notice = (other?: string) => [retiredWindow ? PET_WINDOW_RETIRED_NOTICE : undefined, other].filter(Boolean).join(" ");
  if (value === false) return { enabled: false, blink: true, bell: false, ...(retiredWindow ? { notice: notice() } : {}) };
  const defaults = { enabled: true, blink: true, bell: false };
  if (value === undefined) return { ...defaults, ...(retiredWindow ? { notice: notice() } : {}) };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...defaults, notice: notice("Unknown pet configuration; using stai line defaults.") };
  const row = value as Record<string, unknown>;
  const invalid = Object.keys(row).some(key => !["character", "size", "glyphs", "blink", "bell", "palette"].includes(key)) ||
    row.character !== undefined && !characterId(row.character) || row.size !== undefined && !["line", "mini", "full"].includes(row.size as string) ||
    row.glyphs !== undefined && (typeof row.glyphs !== "string" || !["auto", "ascii", "blocks"].includes(row.glyphs)) ||
    row.palette !== undefined && !petPalette(row.palette) ||
    row.blink !== undefined && typeof row.blink !== "boolean" || row.bell !== undefined && typeof row.bell !== "boolean";
  const palette = petPalette(row.palette);
  return { enabled, blink: typeof row.blink === "boolean" ? row.blink : true, bell: typeof row.bell === "boolean" ? row.bell : false,
    ...(characterId(row.character) && row.character !== "stai" ? { character: row.character } : {}),
    ...(row.size === "mini" || row.size === "full" ? { size: row.size } : {}),
    ...(row.glyphs === "ascii" || row.glyphs === "blocks" ? { glyphs: row.glyphs } : {}),
    ...(palette && palette !== "teal" ? { palette } : {}),
    ...(invalid || retiredWindow ? { notice: notice(invalid ? "Unknown pet option; using stai line defaults for that option." : undefined) } : {}) };
}
