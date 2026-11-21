// #1605/#1611: resolve the newest plain release inside package.json's declared agent-mem range, from the registry and never the
// lockfile. `node scripts/agent-mem-latest.mjs` prints the values the daily workflow needs; nothing here writes the tree.
import { appendFileSync, readFileSync } from "node:fs";
import { isAgentMemFloorRange, isAgentMemPatchRange, newestInRange } from "./lib/agent-mem-range.mjs";

const declared = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies?.["@staix/agent-mem"];
if (!isAgentMemFloorRange(declared) && !isAgentMemPatchRange(declared)) throw new Error(`package.json must declare the agent-mem range >=X.Y.Z <M.0.0 (got ${JSON.stringify(declared)})`);
const response = await fetch("https://registry.npmjs.org/@staix/agent-mem");
if (!response.ok) throw new Error(`the registry answered ${response.status} for @staix/agent-mem`);
const published = Object.keys((await response.json()).versions ?? {});
const version = newestInRange(declared, published);
if (version === undefined) throw new Error(`no published plain release of ${declared} was found among ${published.length} versions`);
const locked = /"@staix\/agent-mem": \["@staix\/agent-mem@(\d+\.\d+\.\d+)"/.exec(readFileSync(new URL("../bun.lock", import.meta.url), "utf8"))?.[1];
const newer = version !== locked;
console.log(`declared ${declared}; locked ${locked}; newest in-range release ${version}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `range=${declared}\nversion=${version}\nnewer=${newer}\n`);
else console.log(`version=${version} newer=${newer}`);
