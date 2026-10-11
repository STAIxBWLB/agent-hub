import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRole } from "../src/hub/roles.ts";
let count = 0;
for (const group of ["dev", "research"]) for (const file of readdirSync(join("templates/roles", group))) {
  if (!file.endsWith(".md")) throw new Error("unexpected role file");
  parseRole(readFileSync(join("templates/roles", group, file), "utf8"), file.slice(0, -3), "shipped"); count++;
}
if (count !== 11) throw new Error("expected the first eleven roles");
console.log(`roles: OK (${count} bounded definitions)`);
