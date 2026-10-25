import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { applySeed, applySeedInRepo, classifyRun, copyTracked, readSeeds, seedRotContext, shardSeeds } from "../scripts/seeded-check.ts";

test("seed manifest and exact source replacement reject rot and ambiguous matches", () => {
  expect(applySeed("a guard b", { search: "guard", replacement: "$& weakened" })).toBe("a $& weakened b");
  expect(() => applySeed("absent", { search: "guard", replacement: "false" })).toThrow("seed rot");
  expect(() => applySeed("guard guard", { search: "guard", replacement: "false" })).toThrow("found 2");
  expect(() => readSeeds('{"schemaVersion":1,"seeds":[]}')).toThrow("invalid seed manifest");
  expect(() => readSeeds(JSON.stringify({ schemaVersion: 1, seeds: [{ id: "bad", file: "../outside", search: "a", replacement: "b", testFile: "test/a.ts", testName: "a" }] }))).toThrow("invalid");
});

test("seed rot reports the base symbol and its current locations, while exact matching still fails (#684)", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-seed-symbol-"));
  const seed = { id: "fixture", file: "guard.ts", search: "return allowed;", replacement: "return true;", testFile: "test/guard.ts", testName: "guard" };
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  try {
    git("init", "-q");
    writeFileSync(join(root, seed.file), "class Guard { check() { return allowed; } }\nexport const LIMIT = 3;\n");
    git("add", "-f", seed.file);
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", base);
    const current = "\n\nclass Guard { check() { return permitted; } }\n";
    expect(seedRotContext(root, { file: seed.file, search: "export const LIMIT = 3;" }, "export const LIMIT = 4;")).toContain("symbol LIMIT; current guard.ts:1");
    writeFileSync(join(root, seed.file), current);
    // Commit the edit too: the report must use the merge base, not the broken HEAD.
    git("add", seed.file);
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "move anchor");
    expect(seedRotContext(root, seed, current)).toContain(`base ${base} guard.ts:1 symbol Guard.check; current guard.ts:3`);
    expect(() => applySeedInRepo(root, current, seed)).toThrow("seed rot: expected one exact source match, found 0");
    expect(() => applySeedInRepo(root, current, seed)).toThrow("symbol Guard.check");
    writeFileSync(join(root, seed.file), "// moved\n");
    writeFileSync(join(root, "moved.ts"), current);
    git("add", "-f", "moved.ts");
    expect(seedRotContext(root, seed, "// moved\n")).toContain("current moved.ts:3");
    writeFileSync(join(root, "moved.ts"), "// deleted\n");
    expect(seedRotContext(root, seed, "// moved\n")).toContain("symbol not found");
    expect(() => applySeedInRepo(root, seed.search.repeat(2), seed)).toThrow("found 2");
    expect(applySeedInRepo(root, seed.search, seed)).toBe(seed.replacement);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("seed context absence never hides exact-match failure (#684)", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-seed-no-base-"));
  const seed = { id: "fixture", file: "guard.ts", search: "old", replacement: "new", testFile: "test/guard.ts", testName: "guard" };
  try {
    expect(() => applySeedInRepo(root, "absent", seed)).toThrow("seed rot: expected one exact source match, found 0; anchor context unavailable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("seed verdict requires the same named assertion and distinguishes survivors from invalid failures", () => {
  const green = "(pass) guard [1.00ms]\n 1 pass\n 0 fail\n";
  const red = "error: expect(received).toBe(expected)\n(fail) guard [1.00ms]\n 0 pass\n 1 fail\n";
  expect(classifyRun(green, 0, "guard", false)).toBe("green");
  expect(classifyRun(red, 1, "guard", true)).toBe("detected");
  expect(() => classifyRun(green, 0, "guard", true)).toThrow("surviving seed");
  expect(() => classifyRun(red, 1, "other", true)).toThrow("named test missing");
  expect(() => classifyRun(`${red}(fail) unrelated [1ms]\n`, 1, "guard", true)).toThrow("unrelated test");
  expect(() => classifyRun(red.replace("expect(received).toBe(expected)", "Cannot find module package"), 1, "guard", true)).toThrow("setup, compiler");
  expect(() => classifyRun(`${red}timed out\n`, 1, "guard", true)).toThrow("timeout failure");
  expect(() => classifyRun(`${red}check: pid 123 still running\n`, 1, "guard", true)).toThrow("timeout failure");
  expect(() => classifyRun(red, 143, "guard", true)).toThrow("not the named assertion");
});
test("seed copy uses current tracked bytes and excludes state, outputs, dependencies and user untracked files", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-seed-copy-"));
  const output = mkdtempSync(join(tmpdir(), "ahub-seed-target-"));
  try {
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
    };
    mkdirSync(join(root, "src")); mkdirSync(join(root, ".agenthub/state"), { recursive: true });
    mkdirSync(join(root, "output")); mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "src/guard.ts"), "original");
    writeFileSync(join(root, ".agenthub/state/control-token"), "private");
    writeFileSync(join(root, "output/generated"), "output");
    git("init", "-q"); git("add", "-f", "src", ".agenthub", "output"); // deliberately tracked forbidden fixture state, independent of host ignore policy
    writeFileSync(join(root, "src/guard.ts"), "current tracked edit");
    writeFileSync(join(root, "secret-untracked"), "secret");
    copyTracked(root, output);
    expect(readFileSync(join(output, "src/guard.ts"), "utf8")).toBe("current tracked edit");
    for (const path of [".git", ".agenthub", "output", "secret-untracked"]) expect(existsSync(join(output, path))).toBe(false);
    expect(existsSync(join(output, "node_modules"))).toBe(true); // linked packages; no recursive copy
    writeFileSync(join(output, "src/guard.ts"), "seeded");
    expect(readFileSync(join(root, "src/guard.ts"), "utf8")).toBe("current tracked edit");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(output, { recursive: true, force: true }); }
});


test("seed classification ignores an echoed source error property but rejects real error diagnostics (#315)", () => {
  const source = '187 | expect(reply).toMatchObject({ ok: false, error: "peer is off roster" });\n';
  const assertion = 'error: expect(received).toMatchObject(expected)\n(fail) roster guard [1ms]\n 0 pass\n 1 fail\n';
  expect(classifyRun(source + assertion, 1, "roster guard", true)).toBe("detected");
  expect(() => classifyRun('error: actual setup failure\n' + assertion, 1, "roster guard", true)).toThrow("setup, compiler");
});


for (const diagnostic of [
  "TypeError: undefined is not an object",
  "ReferenceError: nmae is not defined",
  "  error: indented setup failure",
  "\terror: tab-indented setup failure",
  "[hub] error: listen EADDRINUSE",
  "[adapter] TypeError: invalid native response",
  "[hub] ERROR: uppercase logged failure",
  "187: error: not a Bun source excerpt",
]) test(`seed classification rejects runtime diagnostics before a named assertion: ${diagnostic.trim()} (#315)`, () => {
  const assertion = "error: expect(received).toBe(expected)\n(fail) roster guard [1ms]\n 0 pass\n 1 fail\n";
  expect(() => classifyRun(diagnostic + "\n" + assertion, 1, "roster guard", true)).toThrow("invalid detection: setup, compiler or timeout failure");
  // Runtime failures invalidate the green control too, even if its named test passed.
  expect(() => classifyRun(diagnostic + "\n(pass) roster guard [1ms]\n 1 pass\n 0 fail\n", 0, "roster guard", false)).toThrow("invalid detection: setup, compiler or timeout failure");
});

test("seed diagnostic exclusion applies only to Bun's numbered source excerpts (#315)", () => {
  const assertion = "error: expect(received).toBe(expected)\n(fail) roster guard [1ms]\n 0 pass\n 1 fail\n";
  const excerpts = '  187 | throw new TypeError("error: source text");\n\t188 | const message = "ReferenceError: source text";\n189 | const timeout = "Cannot find module";\n';
  expect(classifyRun(excerpts + assertion, 1, "roster guard", true)).toBe("detected");
  expect(() => classifyRun(excerpts + "[hub] error: actual setup failure\n" + assertion, 1, "roster guard", true)).toThrow("invalid detection: setup, compiler or timeout failure");
  // An echoed assertion cannot stand in for the actual assertion diagnostic.
  expect(() => classifyRun("190 | error: expect(received).toBe(expected)\n(fail) roster guard [1ms]\n 0 pass\n 1 fail\n", 1, "roster guard", true)).toThrow("failure is not the named assertion");
});

test("shards cover every seed exactly once and refuse malformed specs (#457)", () => {
  const seeds = readSeeds(readFileSync(join(import.meta.dir, "../scripts/seeds.json"), "utf8"));
  expect(shardSeeds(seeds, undefined)).toBe(seeds);
  const parts = [1, 2, 3, 4].map(i => shardSeeds(seeds, `${i}/4`));
  expect(parts.flat().map(seed => seed.id).sort()).toEqual(seeds.map(seed => seed.id).sort());
  expect(new Set(parts.flat().map(seed => seed.id)).size).toBe(seeds.length);
  expect(Math.max(...parts.map(p => p.length)) - Math.min(...parts.map(p => p.length))).toBeLessThanOrEqual(1);
  for (const bad of ["0/4", "5/4", "1/0", "a/4", "1/4/2", "1/65"]) expect(() => shardSeeds(seeds, bad)).toThrow("invalid shard");
});
