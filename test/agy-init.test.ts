import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/cli/init.ts";
import { hubGitSync } from "../src/hub/git.ts";

test("init ignores only an existing untracked agy plugin and remains idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-agy-init-")), entry = ".agents/plugins/agent-hub/";
  try {
    init(root); expect(readFileSync(join(root, ".gitignore"), "utf8")).not.toContain(entry);
    mkdirSync(join(root, entry), { recursive: true }); writeFileSync(join(root, entry, "plugin.json"), '{}\n');
    init(root); expect(readFileSync(join(root, ".gitignore"), "utf8").split("\n").filter(line => line === entry)).toHaveLength(1);
    expect(init(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("init preserves a tracked agy plugin instead of adding a directory ignore", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-agy-init-tracked-")), entry = ".agents/plugins/agent-hub/";
  try {
    expect(hubGitSync(["init", "-q"], { cwd: root }).status).toBe(0);
    mkdirSync(join(root, entry), { recursive: true }); writeFileSync(join(root, entry, "plugin.json"), '{}\n');
    expect(hubGitSync(["add", "-f", "--", entry], { cwd: root }).status).toBe(0);
    init(root); expect(readFileSync(join(root, ".gitignore"), "utf8")).not.toContain(entry);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
