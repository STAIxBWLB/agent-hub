import example from "../../templates/packs/example.pack.json" with { type: "text" };

/**
 * The packs the hub ships (#513a), by file name without `.pack.json`. Imported as text so the bundle carries them, as `shipped-roles.ts` carries the role catalog.
 * Only the format example is here: the writing, analysis and ops packs are #513b, which adds a file to `templates/packs/` and a line here.
 */
// TypeScript types a `.json` import as its parsed shape even with `type: "text"`; Bun hands over the file text, which `parsePack` parses and bounds itself.
export const SHIPPED_PACKS: Readonly<Record<string, string>> = { example: example as unknown as string };
