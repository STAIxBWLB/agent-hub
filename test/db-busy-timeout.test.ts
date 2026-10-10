import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Source tripwire for the Database construction idiom used under src/. A multiline
// open or a different binding requires updating this guard, not silently skipping it.
// No exemptions today: even read-only handles can meet another process's writer.
function missingTimeouts(source: string): number[] {
  const lines = source.split("\n");
  const missing: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/\bnew Database\s*\(/.test(line)) continue;
    const receiver = line.match(/^\s*(?:(?:const|let)\s+)?(this\.db|db)\s*=/)?.[1];
    let next = i + 1;
    while (lines[next]?.trim() === "") next++;
    if (lines[next]?.trim() === "try {") next++;
    const setting = lines[next]?.trim();
    const expected = receiver && `${receiver}.run(\`PRAGMA busy_timeout = \${`;
    if (!line.trimEnd().endsWith(";") || !expected || !setting?.startsWith(expected)
      || !/\$\{[A-Z_]+_BUSY_TIMEOUT_MS\}\`\);/.test(setting)) missing.push(i + 1);
  }
  return missing;
}

test("the database guard requires a named timeout before any SQL, including read-only opens (#303)", () => {
  const open = "const db = new Database(path, { readonly: true });\n";
  const timeout = "db.run(`PRAGMA busy_timeout = ${HUB_DB_BUSY_TIMEOUT_MS}`);\n";
  expect(missingTimeouts(open + timeout)).toEqual([]);
  expect(missingTimeouts(open + "try {\n" + timeout)).toEqual([]);
  expect(missingTimeouts(open + "db.query('SELECT 1');\n" + timeout)).toEqual([1]);
  expect(missingTimeouts(open + "db.run('PRAGMA busy_timeout = 3000');")).toEqual([1]);
  expect(missingTimeouts(open + "other.run(`PRAGMA busy_timeout = ${HUB_DB_BUSY_TIMEOUT_MS}`);")).toEqual([1]);
  expect(missingTimeouts(open)).toEqual([1]);
});

test("every Database open under src/ sets a bounded named busy timeout immediately (#303)", () => {
  const src = join(import.meta.dir, "..", "src");
  const sources: string[] = [];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) {
        const source = readFileSync(path, "utf8");
        sources.push(source);
        for (const line of missingTimeouts(source)) offenders.push(`${relative(src, path)}:${line}`);
      }
    }
  };
  walk(src);
  expect(offenders).toEqual([]);
  const constants = new Map<string, number>();
  for (const source of sources) {
    for (const match of source.matchAll(/\bconst ([A-Z_]+_BUSY_TIMEOUT_MS) = (\d+);/g)) {
      expect(constants.has(match[1]!)).toBe(false);
      constants.set(match[1]!, Number(match[2]));
    }
  }
  for (const source of sources) {
    for (const match of source.matchAll(/PRAGMA busy_timeout = \$\{([A-Z_]+_BUSY_TIMEOUT_MS)\}/g)) {
      const value = constants.get(match[1]!);
      expect(value).toBeDefined();
      expect(value!).toBeGreaterThan(0);
      expect(value!).toBeLessThanOrEqual(5000);
    }
  }
});
