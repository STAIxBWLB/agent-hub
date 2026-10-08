import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { applySeed, classifyRun, copyTracked, readSeeds } from "../scripts/seeded-check.ts";

test("seed manifest and exact source replacement reject rot and ambiguous matches", () => {
  expect(applySeed("a guard b", { search: "guard", replacement: "$& weakened" })).toBe("a $& weakened b");
  expect(() => applySeed("absent", { search: "guard", replacement: "false" })).toThrow("seed rot");
  expect(() => applySeed("guard guard", { search: "guard", replacement: "false" })).toThrow("found 2");
  expect(() => readSeeds('{"schemaVersion":1,"seeds":[]}')).toThrow("invalid seed manifest");
  expect(() => readSeeds(JSON.stringify({ schemaVersion: 1, seeds: [{ id: "bad", file: "../outside", search: "a", replacement: "b", testFile: "test/a.ts", testName: "a" }] }))).toThrow("invalid");
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
