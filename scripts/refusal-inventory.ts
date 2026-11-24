import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { collectRefusals } from "./lib/refusal-check.ts";

const root = join(import.meta.dir, "..");

function* sourceFiles(folder: string): Generator<string> {
  for (const entry of readdirSync(join(root, folder), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = folder + "/" + entry.name;
    if (entry.isDirectory()) yield* sourceFiles(file);
    else if (entry.isFile() && entry.name.endsWith(".ts")) yield file;
  }
}

const sites = [...sourceFiles("src")].flatMap(file => collectRefusals(file, readFileSync(join(root, file), "utf8")));
const counts = new Map<string, { sites: number; dynamic: number }>();
for (const site of sites) {
  const count = counts.get(site.carrier) ?? { sites: 0, dynamic: 0 };
  count.sites++;
  if (!site.message.fragments.some(Boolean) && !site.next?.fragments.some(Boolean)) count.dynamic++;
  counts.set(site.carrier, count);
}

if (process.argv[2] === "--json") {
  process.stdout.write(JSON.stringify({ counts: Object.fromEntries(counts), sites }, null, 2) + "\n");
} else if (process.argv[2] === undefined) {
  for (const [carrier, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(carrier + ": " + count.sites + " sites, " + count.dynamic + " fully dynamic");
  }
} else {
  throw new Error("usage: bun scripts/refusal-inventory.ts [--json]");
}
