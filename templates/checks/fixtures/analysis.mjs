// Explicit fixture program: node analysis.mjs <input.json>.
import { readFileSync } from "node:fs";
const values = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (!Array.isArray(values) || !values.every(value => typeof value === "number" && Number.isFinite(value))) process.exit(1);
const sum = values.reduce((total, value) => total + value, 0);
if (!Number.isFinite(sum)) process.exit(1);
process.stdout.write(JSON.stringify({ count: values.length, sum }) + "\n");
