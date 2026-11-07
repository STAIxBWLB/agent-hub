// #1268: mechanical facts in the docs (version, install tag, Bun floor, pins) are rendered from the files that own them,
// between `<!-- facts:<name> -->` and `<!-- /facts:<name> -->`. Default: report drift and fail; `--write`: rewrite the blocks.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const pkg = JSON.parse(read("package.json")) as { version: string; engines?: { bun?: string }; dependencies?: Record<string, string> };
const floor = /^>=\s*(\d+\.\d+\.\d+)$/.exec(pkg.engines?.bun ?? "")?.[1];
const memoryPin = pkg.dependencies?.["@staix/agent-mem"];
if (!floor || !memoryPin) throw new Error("readme-facts: package.json needs engines.bun as `>=x.y.z` and an exact @staix/agent-mem dependency");

const FACTS: Record<string, string> = {
  "bun-floor": floor,
  "bun-pinned": read(".bun-version").trim(),
  "agent-mem-pin": memoryPin,
  "install-tag": `\n\`\`\`bash\nbun add -g github:STAIxBWLB/agent-hub#v${pkg.version}\nahub setup\n\`\`\`\n`,
};
const FILES = ["README.md", "CONTRIBUTING.md", "docs/quickstart.md", "docs/operations.md"];
const BLOCK = /<!-- facts:([a-z-]+) -->([\s\S]*?)<!-- \/facts:([a-z-]+) -->/g;

const write = process.argv.includes("--write");
const drift: string[] = [], errors: string[] = [];
const used = new Set<string>();
for (const file of FILES) {
  const text = read(file);
  const next = text.replace(BLOCK, (block, name: string, body: string, close: string) => {
    const fact = FACTS[name];
    if (close !== name || fact === undefined) { errors.push(`${file}: block ${name} is unknown or closed as ${close}`); return block; }
    used.add(name);
    if (body !== fact) drift.push(`${file}: facts:${name} reads ${JSON.stringify(body.trim())}, the source says ${JSON.stringify(fact.trim())}`);
    return `<!-- facts:${name} -->${fact}<!-- /facts:${name} -->`;
  });
  if (write && next !== text) writeFileSync(join(root, file), next);
}
for (const name of Object.keys(FACTS)) if (!used.has(name)) errors.push(`facts:${name} is rendered nowhere: restore its block or drop it from scripts/readme-facts.ts`);

for (const error of errors) console.error(`facts: ERROR ${error}`);
if (!write) for (const line of drift) console.error(`facts: ${line}`);
if (errors.length || drift.length && !write) {
  if (drift.length && !write) console.error("facts: run `bun scripts/readme-facts.ts --write` and commit the result");
  process.exit(1);
}
console.log(write ? `facts: wrote ${drift.length} block${drift.length === 1 ? "" : "s"}` : "facts: OK");
