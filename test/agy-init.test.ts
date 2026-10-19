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
    expect(hubGitSync(["init", "-q"], { cwd: root, encoding: "utf8" }).status).toBe(0);
    mkdirSync(join(root, entry), { recursive: true }); writeFileSync(join(root, entry, "plugin.json"), '{}\n');
    expect(hubGitSync(["add", "-f", "--", entry], { cwd: root, encoding: "utf8" }).status).toBe(0);
    init(root);
    const ignored = readFileSync(join(root, ".gitignore"), "utf8").split("\n");
    expect(ignored).not.toContain(entry); expect(ignored).not.toContain(`${entry}plugin.json`);
    expect(ignored).toContain(`${entry}mcp_config.json`); expect(ignored).toContain(`${entry}hooks.json`);
    expect(hubGitSync(["check-ignore", "--no-index", "--quiet", "--", `${entry}plugin.json`], { cwd: root, encoding: "utf8" }).status).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("init ignores each untracked owned agy file despite a tracked plugin sibling", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-agy-init-sibling-")), entry = ".agents/plugins/agent-hub/";
  try {
    expect(hubGitSync(["init", "-q"], { cwd: root, encoding: "utf8" }).status).toBe(0);
    mkdirSync(join(root, entry), { recursive: true }); writeFileSync(join(root, entry, "README.md"), "preserved sibling\n");
    expect(hubGitSync(["add", "--", `${entry}README.md`], { cwd: root, encoding: "utf8" }).status).toBe(0);
    // Init runs before the launcher writes its three files. Their future paths must already be protected.
    init(root);
    for (const name of ["plugin.json", "mcp_config.json", "hooks.json"]) {
      writeFileSync(join(root, entry, name), "{}\n");
      expect(hubGitSync(["check-ignore", "--quiet", "--", `${entry}${name}`], { cwd: root, encoding: "utf8" }).status).toBe(0);
    }
    for (const name of ["README.md", "notes.txt"]) expect(hubGitSync(["check-ignore", "--no-index", "--quiet", "--", `${entry}${name}`], { cwd: root, encoding: "utf8" }).status).toBe(1);
    expect(readFileSync(join(root, entry, "README.md"), "utf8")).toBe("preserved sibling\n");
    expect(init(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
