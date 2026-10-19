import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readReleaseHostAdmission } from "../src/hub/release-admission.ts";

test("release admission names a shadowing Graphviz dot without granting admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-release-dot-diagnostic-"));
  const project = join(root, "repo"), host = join(root, "host"), oldPath = process.env.PATH;
  try {
    mkdirSync(project); mkdirSync(host);
    expect(spawnSync("git", ["init", "-q", project]).status).toBe(0);
    const binary = join(host, "dot"), calls = join(root, "calls");
    writeFileSync(binary, `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");\nif(process.argv[2] === "--version") { console.log("dot - graphviz version 12.2.1"); process.exit(0); }\nprocess.exit(1);\n`);
    chmodSync(binary, 0o755);
    process.env.PATH = `${host}:${oldPath ?? ""}`;
    expect(await readReleaseHostAdmission(project)).toMatchObject({ admitted: false, reason: expect.stringContaining("dot is not the resource controller") });
    expect(await Bun.file(calls).text()).toContain("--version\n");
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});
