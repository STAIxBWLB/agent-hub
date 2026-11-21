// #1605: resolve the newest plain patch inside package.json's declared agent-mem range, from the registry and never the
// lockfile. `node scripts/agent-mem-latest.mjs` prints the values the daily workflow needs; nothing here writes the tree.
import { appendFileSync, readFileSync } from "node:fs";
import { isAgentMemPatchRange, newestInRangePatch } from "./lib/agent-mem-range.mjs";

const declared = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies?.["@staix/agent-mem"];
if (!isAgentMemPatchRange(declared)) throw new Error(`package.json must declare the agent-mem patch range ~X.Y.Z (got ${JSON.stringify(declared)})`);
const response = await fetch("https://registry.npmjs.org/@staix/agent-mem");
if (!response.ok) throw new Error(`the registry answered ${response.status} for @staix/agent-mem`);
const published = Object.keys((await response.json()).versions ?? {});
const version = newestInRangePatch(declared, published);
if (version === undefined) throw new Error(`no published plain release of ${declared} was found among ${published.length} versions`);
const newer = version !== declared.slice(1);
console.log(`declared ${declared}; newest in-range patch ${version}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `range=${declared}\nversion=${version}\nnewer=${newer}\n`);
else console.log(`version=${version} newer=${newer}`);
