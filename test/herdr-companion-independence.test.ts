import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// #1199 H1 (AC7): the entry is optional and removable. Neither product depends on it, it depends on neither's internals, and it does not depend on the other companion.
const ROOT = join(import.meta.dir, "..");
const MOD = join(ROOT, "integrations/herdr/mod");
const walk = (dir: string, pattern: RegExp): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile() && pattern.test(e.name)).map(e => join(e.parentPath, e.name));

test("no ahub source, script, package or plugin file names the Herdr entry or its folder", () => {
  for (const dir of ["src", "scripts", "plugins", "templates"]) for (const file of walk(join(ROOT, dir), /\.(ts|js|mjs|json|md|toml|sh)$/)) {
    if (file.endsWith("scripts/seeds.json")) continue;
    expect(readFileSync(file, "utf8"), file).not.toMatch(/integrations\/herdr|herdr-app|herdr-core/i);
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  expect(JSON.stringify(pkg)).not.toMatch(/herdr/i);
});

test("the mod folder is self-contained: card.js and focus.js import nothing, core.js imports only those two, main.js imports only the host's own modules and ./core.js", () => {
  const strip = (text: string) => text.replace(/^\s*\/\/.*$/gm, "");
  const core = strip(readFileSync(join(MOD, "core.js"), "utf8")), main = strip(readFileSync(join(MOD, "main.js"), "utf8"));
  for (const leaf of ["card.js", "focus.js"]) { expect(strip(readFileSync(join(MOD, leaf), "utf8")), leaf).not.toMatch(/^\s*import\s|\brequire\(|import\(/m); }
  expect([...core.matchAll(/from "([^"]+)"/g)].map(m => m[1]).sort()).toEqual(["./card.js", "./focus.js"]);
  expect(core).not.toMatch(/\brequire\(|import\(/);
  const specs = [...main.matchAll(/from "([^"]+)"/g)].map(m => m[1]).sort();
  expect(specs).toEqual(["./core.js", "gpui-base", "gpui-kit", "herdr"]);
});

test("the Herdr entry shares no file or import with the Orca companion, in either direction", () => {
  // shipped files and fixtures only: the test files themselves name the other product inside the scans that forbid it
  const herdrFiles = [...walk(join(ROOT, "integrations/herdr"), /./), ...["test/helpers/herdr-mod-host.ts", "test/helpers/herdr-root-candidates.ts", "test/fakes/herdr-companion-cli.ts"].map(f => join(ROOT, f))];
  for (const file of herdrFiles) expect(readFileSync(file, "utf8"), file).not.toMatch(/orca/i);
  const orca = join(ROOT, "integrations/orca");
  if (existsSync(orca)) for (const file of walk(orca, /./)) expect(readFileSync(file, "utf8"), file).not.toMatch(/herdr/i);
  for (const name of ["orca-companion-host.ts", "orca-companion-cli.ts"]) for (const file of herdrFiles) expect(readFileSync(file, "utf8")).not.toContain(name);
});

test("the mod's owned footprint is exactly five files and a single folder name", () => {
  expect(readdirSync(MOD).sort()).toEqual(["card.js", "core.js", "focus.js", "main.js", "mod.json"]);
  const readme = readFileSync(join(ROOT, "integrations/herdr/README.md"), "utf8");
  expect(readme).toMatch(/mods\/ahub/);
  expect(readme).toMatch(/Never overwrite/);
  expect(readme).toMatch(/Delete `mods\/ahub`/);
  const receipt = readFileSync(join(ROOT, "integrations/herdr/native-receipt.md"), "utf8");
  expect(receipt).toMatch(/Status: NOT RUN/);
  for (const claim of ["Claim 1", "Claim 2", "Claim 3"]) expect(receipt).toContain(claim);
  expect(receipt).not.toMatch(/Overall:\s*(PASS|PASSED)\s*(\n|$)/);
});
