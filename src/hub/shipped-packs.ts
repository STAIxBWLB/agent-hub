import example from "../../templates/packs/example.pack.json" with { type: "text" };
import writing from "../../templates/packs/writing-pack.pack.json" with { type: "text" };
import analysis from "../../templates/packs/analysis.pack.json" with { type: "text" };
import ops from "../../templates/packs/ops.pack.json" with { type: "text" };

/**
 * The packs the hub ships (#513a), by file name without `.pack.json`. Imported as text so the bundle carries them, as `shipped-roles.ts` carries the role catalog.
 * The format example and the writing, analysis and ops domain packs are advisory data; checks never execute from this registry.
 */
// TypeScript types a `.json` import as its parsed shape even with `type: "text"`; Bun hands over the file text, which `parsePack` parses and bounds itself.
export const SHIPPED_PACKS: Readonly<Record<string, string>> = { example: example as unknown as string, "writing-pack": writing as unknown as string, analysis: analysis as unknown as string, ops: ops as unknown as string };
