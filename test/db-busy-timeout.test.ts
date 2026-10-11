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

interface GuardSource { path: string; source: string }

// Deliberately admit only the current named, unaliased import idiom. A new SQLite
// opening idiom must extend this guard before it can enter src/.
function sourceProblems(source: string): string[] {
  const problems = missingTimeouts(source).map((line) => `${line}: Database open lacks its immediate named timeout`);
  for (const match of source.matchAll(/\bimport\s+([^;]+?)\s+from\s+["']bun:sqlite["']\s*;/g)) {
    const clause = match[1]!.trim();
    const members = clause.match(/^\{([^}]+)\}$/)?.[1]?.split(",").map((name) => name.trim()).filter(Boolean);
    if (!members?.includes("Database") || members.some((name) => !/^[A-Za-z_$][\w$]*$/.test(name))) {
      problems.push(`${source.slice(0, match.index).split("\n").length}: unsupported bun:sqlite import; use named unaliased Database`);
    }
  }
  for (const match of source.matchAll(/\b(?:Database\s*\.\s*open\s*\(|import\s*\(\s*["']bun:sqlite["'])/g)) {
    problems.push(`${source.slice(0, match.index).split("\n").length}: unsupported SQLite open; use new Database with an immediate named timeout`);
  }
  const lines = source.split("\n");
  const initialSettings = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!/\bnew Database\s*\(/.test(lines[i]!)) continue;
    let next = i + 1;
    while (lines[next]?.trim() === "") next++;
    if (lines[next]?.trim() === "try {") next++;
    // Only the constructor's own setting is allowed. A later assignment, even to
    // another named constant, can silently replace the configured busy handler.
    if (!missingTimeouts(lines.slice(i, next + 1).join("\n")).length) initialSettings.add(next);
  }
  for (let i = 0; i < lines.length; i++) {
    if (/PRAGMA\s+busy_timeout\b/i.test(lines[i]!) && !lines[i]!.trimStart().startsWith("//") && !initialSettings.has(i)) {
      problems.push(`${i + 1}: busy_timeout setting outside a Database open; later resets are forbidden`);
    }
  }
  return problems;
}

function constantProblems(sources: GuardSource[]): string[] {
  const problems: string[] = [];
  const constants = new Map<string, { value: number; at: string }>();
  for (const { path, source } of sources) {
    for (const match of source.matchAll(/\bconst\s+([A-Z_]+_BUSY_TIMEOUT_MS)\b([^;]*);/g)) {
      const name = match[1]!, at = `${path}:${source.slice(0, match.index).split("\n").length}`;
      const literal = match[2]!.match(/^\s*(?::\s*number\s*)?=\s*(\d+)\s*$/);
      if (!literal) { problems.push(`${at}: ${name} must be a literal integer (optional : number)`); continue; }
      const prior = constants.get(name);
      if (prior) problems.push(`${at}: duplicate ${name}; first declared at ${prior.at}`);
      const value = Number(literal[1]);
      if (!(value > 0 && value <= 5000)) problems.push(`${at}: ${name} must be between 1 and 5000 ms; got ${value}`);
      constants.set(name, { value, at });
    }
  }
  for (const { path, source } of sources) {
    for (const match of source.matchAll(/PRAGMA busy_timeout = \$\{([A-Z_]+_BUSY_TIMEOUT_MS)\}/g)) {
      if (!constants.has(match[1]!)) problems.push(`${path}:${source.slice(0, match.index).split("\n").length}: missing constant ${match[1]}`);
    }
  }
  return problems;
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
  const sources: GuardSource[] = [];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) {
        const source = readFileSync(path, "utf8");
        const name = relative(src, path);
        sources.push({ path: name, source });
        for (const problem of sourceProblems(source)) offenders.push(`${name}:${problem}`);
      }
    }
  };
  walk(src);
  expect(offenders).toEqual([]);
  expect(constantProblems(sources)).toEqual([]);
});

test("the database guard rejects alternative imports, static opens and later timeout resets (#303)", () => {
  const open = "const db = new Database(path);\n";
  const timeout = "db.run(`PRAGMA busy_timeout = ${HUB_DB_BUSY_TIMEOUT_MS}`);\n";
  expect(sourceProblems('import { Database, constants } from "bun:sqlite";\n' + open + timeout)).toEqual([]);
  for (const alternative of [
    'import { Database as Sqlite } from "bun:sqlite";\nconst db = new Sqlite(path);',
    'import Sqlite from "bun:sqlite";\nconst db = new Sqlite(path);',
    'import * as sqlite from "bun:sqlite";\nconst db = new sqlite.Database(path);',
    'const db = Database.open(path);',
    'const db = Database . open (path);',
    'const sqlite = await import("bun:sqlite");',
  ]) expect(sourceProblems(alternative).join("\n")).toMatch(/unsupported/);
  for (const reset of [
    "db.run('PRAGMA busy_timeout = 0');",
    "db.exec('pragma busy_timeout=0');",
    "db.query('PRAGMA busy_timeout = 0').run();",
    "db.run(`PRAGMA busy_timeout = ${HUB_DB_BUSY_TIMEOUT_MS}`);",
  ]) expect(sourceProblems(open + timeout + reset).join("\n")).toContain("later resets are forbidden");
});

test("the database guard names typed, duplicate, missing and invalid timeout constants (#303)", () => {
  const setting = "db.run(`PRAGMA busy_timeout = ${HUB_DB_BUSY_TIMEOUT_MS}`);";
  expect(constantProblems([{ path: "typed.ts", source: "const HUB_DB_BUSY_TIMEOUT_MS: number = 3000;\n" + setting }])).toEqual([]);
  expect(constantProblems([
    { path: "first.ts", source: "const HUB_DB_BUSY_TIMEOUT_MS = 3000;" },
    { path: "second.ts", source: "const HUB_DB_BUSY_TIMEOUT_MS: number = 3000;" },
  ])).toEqual(["second.ts:1: duplicate HUB_DB_BUSY_TIMEOUT_MS; first declared at first.ts:1"]);
  expect(constantProblems([{ path: "missing.ts", source: setting }])).toEqual(["missing.ts:1: missing constant HUB_DB_BUSY_TIMEOUT_MS"]);
  expect(constantProblems([{ path: "computed.ts", source: "const HUB_DB_BUSY_TIMEOUT_MS: number = 3 * 1000;" }])).toEqual(["computed.ts:1: HUB_DB_BUSY_TIMEOUT_MS must be a literal integer (optional : number)"]);
  for (const value of [0, 5001]) expect(constantProblems([{ path: "range.ts", source: `const HUB_DB_BUSY_TIMEOUT_MS = ${value};` }])).toEqual([`range.ts:1: HUB_DB_BUSY_TIMEOUT_MS must be between 1 and 5000 ms; got ${value}`]);
});
