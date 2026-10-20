import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFiles, selectTests } from "../scripts/changed-tests.mjs";

// #610: `scripts/check.sh --changed` runs only the tests a change touches; anything that can move every test is ALL.
test("#610 changed-files selection: importing tests, changed tests, docs only, gate changes and unmapped code", () => {
  const repo = mkdtempSync(join(tmpdir(), "ahub-changed-tests-"));
  const git = (...args: string[]) => {
    const run = Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    if (run.exitCode !== 0) throw new Error(run.stderr.toString());
    return run.stdout.toString().trim();
  };
  try {
    for (const dir of ["src/hub", "test", "docs", "scripts"]) mkdirSync(join(repo, dir), { recursive: true });
    writeFileSync(join(repo, "src/hub/a.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, "src/hub/lonely.ts"), "export const b = 1;\n");
    writeFileSync(join(repo, "test/a.test.ts"), 'import { a } from "../src/hub/a.ts";\n');
    writeFileSync(join(repo, "test/b.test.ts"), "// unrelated\n");
    git("init", "-q"); git("-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");

    expect(selectTests(["src/hub/a.ts"], repo)).toEqual(["test/a.test.ts"]);
    expect(selectTests(["test/b.test.ts", "src/hub/a.ts"], repo)).toEqual(["test/a.test.ts", "test/b.test.ts"]);
    expect(selectTests(["docs/x.md"], repo)).toEqual([]);
    expect(selectTests(["src/hub/lonely.ts"], repo)).toBe("ALL"); // code no test imports is unknown, not nothing
    // review of #611: nested suites count, and code outside src/ maps the same way or runs everything
    mkdirSync(join(repo, "test/conformance"), { recursive: true });
    writeFileSync(join(repo, "test/conformance/a.test.ts"), 'import { a } from "../../src/hub/a.ts";\n');
    writeFileSync(join(repo, "scripts/gate.mjs"), "export const g = 1;\n");
    writeFileSync(join(repo, "test/gate.test.ts"), 'import { g } from "../scripts/gate.mjs";\n');
    expect(selectTests(["src/hub/a.ts"], repo)).toEqual(["test/a.test.ts", "test/conformance/a.test.ts"]);
    expect(selectTests(["scripts/gate.mjs"], repo)).toEqual(["test/gate.test.ts"]);
    expect(selectTests(["scripts/unused.mjs"], repo)).toBe("ALL");
    expect(selectTests(["src/hub/a.ts", "src/hub/lonely.ts"], repo)).toBe("ALL"); // one unmapped file is enough
    for (const gate of ["bunfig.toml", "package.json", "scripts/check.sh", "test/hub-home.ts"]) expect(selectTests([gate, "docs/x.md"], repo)).toBe("ALL");

    writeFileSync(join(repo, "src/hub/a.ts"), "export const a = 2;\n"); // unstaged
    writeFileSync(join(repo, "test/c.test.ts"), "// new, untracked\n");
    expect(changedFiles(base, repo).sort()).toEqual(["scripts/gate.mjs", "src/hub/a.ts", "test/c.test.ts", "test/conformance/a.test.ts", "test/gate.test.ts"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// The environment scripts/check.sh pins for the test runner; meaningful only inside the gate, which sets AHUB_CHECK_RUN_ROOT.
test.skipIf(!process.env.AHUB_CHECK_RUN_ROOT)("#610 the gate pins git config, color and temp root for every test", () => {
  expect(process.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  expect(process.env.NO_COLOR).toBeUndefined();
  expect(process.env.TERM).toBe("xterm-256color");
  if (process.platform === "darwin" && process.env.HOME) expect(process.env.TMPDIR?.startsWith(process.env.HOME)).toBe(false);
});
