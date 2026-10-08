import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const checker = resolve(import.meta.dir, "../scripts/check-docs.mjs");
function fixture(run: (root: string, stamp: string, git: (...args: string[]) => string) => void) {
  const root = mkdtempSync(join(tmpdir(), "ahub-docs-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  try {
    mkdirSync(join(root, "docs/agent-notes"), { recursive: true });
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/covered.ts"), "initial\n");
    writeFileSync(join(root, "src/unrelated.ts"), "initial\n");
    writeFileSync(join(root, "package.json"), '{"version":"1.2.3"}\n');
    const docs = ["README.md", "docs/security.md", "docs/operations.md", "docs/quickstart.md", "docs/agent-notes/example.md"];
    for (const doc of docs) writeFileSync(join(root, doc), doc === "README.md" ? "Status: 1.2.3, control protocol 13.\n" : "Fixture\n");
    git("init", "-q"); git("add", "."); git("commit", "-qm", "Initial fixture");
    const stamp = git("rev-parse", "HEAD");
    writeFileSync(join(root, "docs/verified.json"), JSON.stringify({ schemaVersion: 1, documents: Object.fromEntries(docs.map((doc) => [doc, { verifiedAgainst: stamp, paths: ["src/covered.ts"] }])) }));
    git("add", "."); git("commit", "-qm", "Record reviewed documentation");
    run(root, stamp, git);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const check = (root: string) => spawnSync("node", [checker, root], { encoding: "utf8" });
function alter(root: string, modify: (manifest: any) => void) {
  const path = join(root, "docs/verified.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  modify(manifest); writeFileSync(path, JSON.stringify(manifest));
}

describe("documentation source verification gate", () => {
  test("ancestor stamps and unrelated commits stay fresh; source drift is sorted and counted once per commit", () => fixture((root, _stamp, git) => {
    writeFileSync(join(root, "src/unrelated.ts"), "unrelated\n"); git("add", "."); git("commit", "-qm", "Unrelated edit");
    expect(check(root).stdout).toBe("docs: OK (0 stale documents)\n");
    writeFileSync(join(root, "src/covered.ts"), "changed\n"); git("add", "."); git("commit", "-qm", "Covered edit");
    const result = check(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe([
      "docs: README.md: stale (1 source commit)",
      "docs: docs/agent-notes/example.md: stale (1 source commit)",
      "docs: docs/operations.md: stale (1 source commit)",
      "docs: docs/quickstart.md: stale (1 source commit)",
      "docs: docs/security.md: stale (1 source commit)",
      "docs: OK (5 stale documents)", "",
    ].join("\n"));
    expect(check(root).stdout).toBe(result.stdout);
    writeFileSync(join(root, "src/covered.ts"), "dirty\n");
    expect(check(root).stdout).toContain("1 source commit; uncommitted source changes");
  }));
  test("rejects README version drift", () => fixture((root) => {
    writeFileSync(join(root, "README.md"), "Status: 1.2.2, control protocol 13.\n");
    const result = check(root); expect(result.status).toBe(1);
    expect(result.stderr).toContain("README status version 1.2.2 differs from package.json 1.2.3");
  }));
  test("rejects nonexistent and nonancestor commit stamps", () => fixture((root, stamp, git) => {
    alter(root, (m) => { m.documents["README.md"].verifiedAgainst = "0".repeat(40); });
    expect(check(root).stderr).toContain("verified commit does not resolve");
    const sibling = git("commit-tree", `${stamp}^{tree}`, "-m", "Detached review");
    alter(root, (m) => { m.documents["README.md"].verifiedAgainst = sibling; });
    const result = check(root); expect(result.status).toBe(1);
    expect(result.stderr).toContain("verified commit is not an ancestor of HEAD");
  }));
  test("rejects missing coverage and removed sources", () => fixture((root) => {
    alter(root, (m) => { delete m.documents["docs/agent-notes/example.md"]; });
    expect(check(root).stderr).toContain("missing manifest entry: docs/agent-notes/example.md");
    rmSync(join(root, "src/covered.ts"));
    const result = check(root); expect(result.status).toBe(1);
    expect(result.stderr).toContain("covered path no longer exists: src/covered.ts");
  }));
});
