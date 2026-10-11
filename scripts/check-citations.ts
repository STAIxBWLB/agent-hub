import { readFileSync, statSync } from "node:fs";
import { citationKeys } from "../src/hub/citations.ts";
const [document, bibliography, extra] = process.argv.slice(2);
if (!document || !bibliography || extra) throw new Error("usage: bun scripts/check-citations.ts <markdown> <bibtex>");
if (statSync(document).size > 256 * 1024 || statSync(bibliography).size > 4 * 1024 * 1024) throw new Error("citation input files exceed example check limits");
const result = citationKeys(readFileSync(document, "utf8"), readFileSync(bibliography, "utf8"));
console.log(`citations: ${result.cited.length} declared keys, ${result.missing.length} missing`);
if (result.missing.length) process.exitCode = 1;
