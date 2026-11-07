// #1268: mechanical facts in the docs (version, install tag, Bun floor, pins) are rendered from the files that own them,
// between `<!-- facts:<name> -->` and `<!-- /facts:<name> -->` (the renderer is scripts/lib/readme-facts.ts, which release-prepare also calls, #1273).
// Default: report drift and fail; `--write`: rewrite the blocks.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderFacts } from "./lib/readme-facts.ts";

const root = join(import.meta.dir, "..");
const read = (path: string) => existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined;
const write = process.argv.includes("--write");
const rendered = renderFacts(read, { packageJson: readFileSync(join(root, "package.json"), "utf8"), bunVersion: readFileSync(join(root, ".bun-version"), "utf8") });

for (const error of rendered.errors) console.error(`facts: ERROR ${error}`);
if (write) for (const [file, text] of Object.entries(rendered.files)) if (!rendered.errors.length) writeFileSync(join(root, file), text);
if (!write) for (const d of rendered.drift) console.error(`facts: ${d.file}: facts:${d.name} reads ${JSON.stringify(d.found)}, the source says ${JSON.stringify(d.wanted)}`);
if (rendered.errors.length || rendered.drift.length && !write) {
  if (rendered.drift.length && !write) console.error("facts: run `bun scripts/readme-facts.ts --write` and commit the result");
  process.exit(1);
}
console.log(write ? `facts: wrote ${rendered.drift.length} block${rendered.drift.length === 1 ? "" : "s"}` : "facts: OK");
