import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync, copyFileSync } from "node:fs";
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
  test("release requires fresh stamps and preserves release-branch ancestry", () => fixture((root, _stamp, git) => {
    const base = git("rev-parse", "HEAD");
    git("checkout", "-qb", "release-fixture");
    writeFileSync(join(root, "src/covered.ts"), "release source\n");
    git("add", "."); git("commit", "-qm", "Release source");
    const reviewed = git("rev-parse", "HEAD");
    const strict = () => spawnSync("node", [checker, root, "--require-fresh"], { encoding: "utf8" });
    expect(strict().status).toBe(1);
    expect(strict().stderr).toContain("release requires fresh documentation stamps");
    alter(root, m => { for (const entry of Object.values(m.documents) as any[]) entry.verifiedAgainst = reviewed; });
    git("add", "."); git("commit", "-qm", "Review release source");
    const release = git("rev-parse", "HEAD");
    git("checkout", "-qb", "merge-fixture", base);
    git("merge", "--no-ff", "-m", "Merge release", release);
    const tree = git("rev-parse", "HEAD^{tree}");
    expect(strict().status).toBe(0);
    git("checkout", "-qb", "squash-fixture", base);
    git("merge", "--squash", release); git("commit", "-qm", "Squash release");
    expect(git("rev-parse", "HEAD^{tree}")).toBe(tree);
    const rejected = strict();
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("verified commit is not an ancestor of HEAD");
    expect(rejected.stderr).toContain("merge the release PR with a merge commit");
  }));
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


test("structured docs evidence reports fresh stale and dirty states without changing release refusal (#257)", () => fixture((root, stamp, git) => {
  const machine = (strict = false) => spawnSync("node", [checker, "--json", root, ...(strict ? ["--require-fresh"] : [])], { encoding: "utf8" });
  const fresh = machine(); expect(fresh.status).toBe(0); expect(fresh.stderr).toBe("");
  const data = JSON.parse(fresh.stdout); expect(data).toMatchObject({ schemaVersion: 1, head: git("rev-parse", "HEAD"), version: "1.2.3", fresh: true, errors: 0 });
  expect(data.documents).toHaveLength(5); expect(data.documents.every((d: any) => d.state === "fresh" && d.verifiedAgainst === stamp && d.commits === 0 && d.dirty === false)).toBe(true);
  writeFileSync(join(root, "src/covered.ts"), "changed\n"); git("add", "."); git("commit", "-qm", "Covered edit");
  const stale = JSON.parse(machine().stdout); expect(stale.fresh).toBe(false); expect(stale.documents.every((d: any) => d.state === "stale" && d.commits === 1)).toBe(true);
  writeFileSync(join(root, "src/covered.ts"), "dirty\n"); expect(JSON.parse(machine().stdout).documents.every((d: any) => d.dirty)).toBe(true);
  const strict = machine(true); expect(strict.status).toBe(1); expect(JSON.parse(strict.stdout).fresh).toBe(false);
}));
test("release doc evidence rejects working-tree restamps and reads committed metadata (#257)", () => fixture((root, _stamp, git) => {
  writeFileSync(join(root, "src/covered.ts"), "new source\n");
  git("add", "."); git("commit", "-qm", "Change covered source");
  const head = git("rev-parse", "HEAD");
  alter(root, manifest => { for (const entry of Object.values(manifest.documents) as any[]) entry.verifiedAgainst = head; });
  const ordinary = spawnSync("node", [checker, root, "--json"], { encoding: "utf8" });
  expect(JSON.parse(ordinary.stdout).fresh).toBe(true);
  const committed = () => {
    const code = `import {readDocEvidence} from ${JSON.stringify(resolve(import.meta.dir, "../src/hub/sdlc-release.ts"))}; console.log(JSON.stringify(await readDocEvidence(${JSON.stringify(root)})));`;
    const result = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 20_000 });
    expect(result.status).toBe(0); return JSON.parse(result.stdout);
  };
  expect(committed().fresh).toBe(false);
  git("add", "docs/verified.json"); expect(committed().fresh).toBe(false);
  git("commit", "-qm", "Commit reviewed stamps"); expect(committed().fresh).toBe(true);
  writeFileSync(join(root, "package.json"), '{"version":"9.9.9"}\n');
  const dirty = committed(); expect(dirty.version).toBe("1.2.3"); expect(dirty.fresh).toBe(false);
}));
test("structured invalid stamp evidence preserves uncertainty and excludes raw error payloads (#257)", () => fixture((root, stamp, git) => {
  alter(root, m => { m.documents["README.md"].verifiedAgainst = "PRIVATE_INVALID_STAMP_MARKER"; });
  const invalid = spawnSync("node", [checker, root, "--json"], { encoding: "utf8" }); expect(invalid.status).toBe(1); expect(invalid.stdout + invalid.stderr).not.toContain("PRIVATE_INVALID_STAMP_MARKER");
  expect(JSON.parse(invalid.stdout).documents.find((d: any) => d.path === "README.md").state).toBe("unknown");
  const sibling = git("commit-tree", `${stamp}^{tree}`, "-m", "Detached review"); alter(root, m => { m.documents["README.md"].verifiedAgainst = sibling; });
  const rejected = spawnSync("node", [checker, root, "--json"], { encoding: "utf8" }); expect(rejected.status).toBe(1); expect(JSON.parse(rejected.stdout).documents.find((d: any) => d.path === "README.md").state).toBe("nonancestor");
}));
test("documentation readbacks never execute the repository fsmonitor helper (#257)", () => fixture((root, _stamp, git) => {
  const marker = join(root, "monitor-ran"), script = join(root, "monitor.sh"); writeFileSync(script, '#!/bin/sh\nprintf marker > "' + marker + '"\n'); chmodSync(script, 0o755); git("config", "core.fsmonitor", script);
  const result = spawnSync("node", [checker, root, "--json"], { encoding: "utf8" }); expect(result.status).toBe(0); expect(JSON.parse(result.stdout).fresh).toBe(true); expect(existsSync(marker)).toBe(false);
}));
test("documentation drift checks never execute configured clean or process filters (#257)", () => fixture((root, _stamp, git) => {
  writeFileSync(join(root, ".gitattributes"), "src/covered.ts filter=metadata-trap\n");
  git("add", ".gitattributes"); git("commit", "-qm", "Declare fixture filter attribute");
  const marker = join(root, "filter-ran"), script = join(root, "filter.sh");
  writeFileSync(script, '#!/bin/sh\nprintf marker > "' + marker + '"\ncat\n'); chmodSync(script, 0o755);
  for (const helper of ["clean", "process"]) {
    git("config", `filter.metadata-trap.${helper}`, script);
    // Match the indexed byte length so legacy git status must hash through its configured filter.
    writeFileSync(join(root, "src/covered.ts"), helper === "clean" ? "changed\n" : "altered\n");
    if (helper === "clean") {
      git("status", "--porcelain", "--", "src/covered.ts");
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);
    }
    const result = spawnSync("node", [checker, root, "--json"], { encoding: "utf8", timeout: 15_000 });
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout).fresh).toBe(false);
    expect(existsSync(marker)).toBe(false);
  }
}));

test("installed-layout release reader finds the explicitly published checker and runs structured evidence (#257)", () => fixture(root => {
  const target = mkdtempSync(join(tmpdir(), "ahub-installed-doc-reader-"));
  try {
    mkdirSync(join(target, "src/hub"), { recursive: true });
    for (const name of ["sdlc-release.ts", "sdlc.ts", "workflow.ts", "git.ts", "child-process.ts"]) {
      copyFileSync(resolve(import.meta.dir, "../src/hub", name), join(target, "src/hub", name));
    }
    mkdirSync(join(target, "scripts"));
    copyFileSync(checker, join(target, "scripts/check-docs.mjs"));
    writeFileSync(join(target, "probe.ts"), `import {readDocEvidence} from "./src/hub/sdlc-release.ts"; console.log(JSON.stringify(await readDocEvidence(${JSON.stringify(root)})));`);
    const result = spawnSync(process.execPath, [join(target, "probe.ts")], { encoding: "utf8", timeout: 20_000 });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, fresh: true, errors: 0, version: "1.2.3" });
  } finally { rmSync(target, { recursive: true, force: true }); }
}));


test("committed docs reject ignored document and coverage ghosts absent from HEAD (#257)", () => {
  for (const kind of ["document", "coverage"] as const) fixture((root, stamp, git) => {
    const path = kind === "document" ? "docs/ghost.md" : "src/ghost.ts";
    writeFileSync(join(root, ".gitignore"), path + "\n");
    alter(root, m => {
      if (kind === "document") m.documents[path] = { verifiedAgainst: stamp, paths: ["src/covered.ts"] };
      else m.documents["README.md"].paths = [path];
    });
    git("add", "."); git("commit", "-qm", "Record missing ignored evidence");
    writeFileSync(join(root, path), "ignored local copy\n");
    expect(git("ls-files", "--", path)).toBe("");
    const result = spawnSync("node", [checker, root, "--json", "--committed"], { encoding: "utf8" });
    expect(result.status).toBe(1); expect(JSON.parse(result.stdout).fresh).toBe(false);
    expect(JSON.parse(result.stdout).errors).toBeGreaterThan(0);
  });
});

test("committed coverage preserves tracked wildcards and ignores local note-name additions (#257)", () => fixture((root, _stamp, git) => {
  alter(root, m => { for (const entry of Object.values(m.documents) as any[]) entry.paths = ["src/covered*.ts"]; });
  writeFileSync(join(root, ".gitignore"), "docs/agent-notes/ignored.md\n");
  git("add", "."); git("commit", "-qm", "Use wildcard source coverage");
  writeFileSync(join(root, "docs/agent-notes/ignored.md"), "local only\n");
  const result = spawnSync("node", [checker, root, "--json", "--committed"], { encoding: "utf8" });
  expect(result.status).toBe(0); expect(JSON.parse(result.stdout).fresh).toBe(true);
}));
