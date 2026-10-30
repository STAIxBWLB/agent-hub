import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRole } from "../src/hub/roles.ts";
import { SHIPPED_ROLES } from "../src/hub/shipped-roles.ts";

const seen = new Set<string>();
for (const group of readdirSync("templates/roles", { withFileTypes: true })) {
  if (group.name === "NOTICE.md" && group.isFile()) continue;
  if (!group.isDirectory() || group.isSymbolicLink()) throw new Error("unexpected role catalog entry");
  for (const file of readdirSync(join("templates/roles", group.name), { withFileTypes: true })) {
    if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith(".md")) throw new Error("unexpected role file");
    const id = file.name.slice(0, -3), text = readFileSync(join("templates/roles", group.name, file.name), "utf8");
    const role = parseRole(text, id, "shipped");
    if (seen.has(id) || role.group !== group.name || SHIPPED_ROLES[id] !== text) throw new Error("role registry/template mismatch");
    seen.add(id);
  }
}
if (seen.size !== Object.keys(SHIPPED_ROLES).length) throw new Error("role registry/template mismatch");
console.log(`roles: OK (${seen.size} bounded definitions)`);
