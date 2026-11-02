import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpecsEngine, parseSpecsConfig, type SpecsConfig } from "../src/hub/specs.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";

const FIXTURE = join(import.meta.dir, "fixtures/spec-graph");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tempRoot(name: string): string {
  const root = realPath(mkdtempSync(join(tmpdir(), `ahub-specs-${name}-`)));
  roots.push(root);
  return root;
}

function git(root: string, ...args: string[]): string {
  const result = hubGitSync(["-C", root, "-c", "user.name=Specs fixture", "-c", "user.email=specs@example.invalid", ...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`fixture git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function repository(tree: "valid" | "invalid" = "valid", config: Partial<SpecsConfig> = {}): { root: string; engine: SpecsEngine; git: (...args: string[]) => string } {
  const root = tempRoot(tree);
  git(root, "init", "-q");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/core.ts"), "export const core = 1;\n");
  for (const name of readdirSync(join(FIXTURE, tree))) {
    const target = name.endsWith(".fixture") ? name.slice(0, -".fixture".length) : name;
    cpSync(join(FIXTURE, tree, name), join(root, target), { recursive: true });
  }
  git(root, "add", "-A"); git(root, "commit", "-qm", "fixture baseline");
  const specs = parseSpecsConfig({ ...parseSpecsConfig(undefined), ...config });
  return { root, engine: new SpecsEngine(root, specs), git: (...args: string[]) => git(root, ...args) };
}

test("the schema fixture's valid graph parses inline and block lists without diagnostics", () => {
  const { engine } = repository("valid");
  const report = engine.check();
  expect(report.specCount).toBe(4);
  expect(report.errors).toBe(0);
  expect(report.warnings).toBe(0);
  expect(report.items).toEqual([]);
  expect(engine.list().specs.map(spec => spec.id).sort()).toEqual(["architecture", "core-leaf", "core-module", "product"]);
});

test("disabling notices does not disable explicit specs reads", () => {
  const { root } = repository("valid", { enabled: false, review: "off" });
  expect(new SpecsEngine(root, parseSpecsConfig({ enabled: false, review: "off" })).list().specs.map(spec => spec.id).sort()).toEqual(["architecture", "core-leaf", "core-module", "product"].sort());
});

test("schema payloads are stored as non-Markdown fixtures so the dogfood scanner ignores them", () => {
  for (const tree of ["valid", "invalid"]) for (const name of readdirSync(join(FIXTURE, tree))) {
    expect(name, `${tree}/${name}`).toEndWith(".md.fixture");
  }
});

test("ordinary Markdown with an unrelated type is not treated as a spec candidate", () => {
  const root = tempRoot("ordinary-markdown"); git(root, "init", "-q");
  writeFileSync(join(root, "post.md"), "---\ntype: post\ntitle: Blog post\n---\nText.\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "ordinary Markdown");
  expect(new SpecsEngine(root, parseSpecsConfig(undefined)).check()).toMatchObject({ specCount: 0, errors: 0, warnings: 0, stale: 0, truncated: false, freshness: [], items: [] });
});

test("the schema fixture diagnoses every listed graph error and warning class", () => {
  const { engine } = repository("invalid");
  const report = engine.check();
  const errors = new Set(report.items.filter(item => item.severity === "error").map(item => item.code));
  const warnings = new Set(report.items.filter(item => item.severity === "warning").map(item => item.code));
  for (const code of ["required-field", "duplicate-id", "dangling-link", "parent-cycle", "rank", "unknown-type", "unknown-status", "superseded-by-misuse", "superseded-by-self", "invalid-paths", "invalid-verified-against"]) expect(errors, code).toContain(code);
  for (const code of ["orphan", "deprecated-without-replacement", "multiple-goals", "duplicate-covers", "unknown-body-link", "active-without-paths", "deprecated-replacement"]) expect(warnings, code).toContain(code);
  expect(report.errors).toBeGreaterThanOrEqual(errors.size);
  expect(report.warnings).toBeGreaterThanOrEqual(warnings.size);
});

test("warnings alone do not make validation fail", () => {
  const { root } = repository("valid");
  writeFileSync(join(root, "orphan.md"), "---\nid: orphan\ntype: module\ntitle: Orphan\nstatus: draft\npaths: [src/core.ts]\n---\n");
  const report = new SpecsEngine(root, parseSpecsConfig(undefined)).check();
  expect(report.errors).toBe(0);
  expect(report.warnings).toBeGreaterThan(0);
  expect(report.items.map(item => item.code)).toContain("orphan");
});

test("covers matches tracked files and newly supplied untracked files without exposing spec bodies", () => {
  const { root, engine } = repository("valid");
  writeFileSync(join(root, "src/new.ts"), "export const next = 2;\n");
  const report = engine.covers(["src/core.ts", "src/new.ts"]);
  expect(report.errors).toBe(0);
  expect(report.specs.map(spec => spec.id).sort()).toEqual(["architecture", "core-module", "core-leaf", "product"].sort());
  expect(report.specs.every(spec => !Object.hasOwn(spec, "paths") && !Object.hasOwn(spec, "type"))).toBe(true);
  expect(engine.covers(["../outside.ts"]).items.map(item => item.code)).toContain("invalid-cover-path");
});

test("a retained engine refreshes changed frontmatter and Git pathspec evidence", () => {
  const { root, engine, git } = repository("valid");
  const file = join(root, "new.md");
  const spec = (title: string) => `---\nid: new\ntype: module\ntitle: ${title}\nparent: product\npaths: [src/future.ts]\n---\n`;
  writeFileSync(file, spec("First"));
  expect(engine.check().items.some(item => item.code === "invalid-paths" && item.id === "new")).toBe(true);
  writeFileSync(file, spec("Other"));
  const future = new Date(Date.now() + 1000); utimesSync(file, future, future);
  writeFileSync(join(root, "src/future.ts"), "export const future = true;\n"); git("add", "src/future.ts");
  expect(engine.check().errors).toBe(0);
  expect(engine.list().specs.find(spec => spec.id === "new")?.title).toBe("Other");
});

test("spec roots are literal directory names even when they contain Git glob punctuation", () => {
  const root = tempRoot("literal-root"); git(root, "init", "-q");
  for (const [directory, id] of [["design[one]", "literal"], ["designxone", "wildcard-collision"]] as const) {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, directory, "spec.md"), `---\nid: ${id}\ntype: goal\ntitle: ${id}\n---\n`);
  }
  git(root, "add", "-A"); git(root, "commit", "-qm", "literal roots");
  const report = new SpecsEngine(root, parseSpecsConfig({ roots: ["design[one]"] })).list();
  expect(report.specs.map(spec => spec.id)).toEqual(["literal"]);
});

test("covers preserves default Git glob, glob-magic segment and case-insensitive literal semantics", () => {
  const root = tempRoot("pathspecs"); git(root, "init", "-q");
  mkdirSync(join(root, "src"), { recursive: true }); writeFileSync(join(root, "src/core.ts"), "export const core = 1;\n");
  writeFileSync(join(root, "default.md"), "---\nid: default-glob\ntype: module\ntitle: Default glob\npaths: [src/*.ts]\n---\n");
  writeFileSync(join(root, "glob.md"), "---\nid: glob-magic\ntype: module\ntitle: Glob magic\npaths: [\":(glob)src/*.ts\"]\n---\n");
  writeFileSync(join(root, "literal.md"), "---\nid: literal-ignore-case\ntype: module\ntitle: Literal ignore case\npaths: [\":(icase,literal)src/CORE.ts\"]\n---\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "Git pathspec examples");
  const engine = new SpecsEngine(root, parseSpecsConfig(undefined));
  expect(engine.covers(["src/nested/new.ts"]).specs.map(spec => spec.id)).toEqual(["default-glob"]);
  expect(engine.covers(["src/CORE.ts"]).specs.map(spec => spec.id)).toContain("literal-ignore-case");
});

test("freshness counts commits and checks uncommitted tracked, staged and untracked path bytes", () => {
  const root = tempRoot("freshness");
  git(root, "init", "-q"); mkdirSync(join(root, "src"), { recursive: true }); mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "src/core.ts"), "export const core = 1;\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "baseline");
  const stamp = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "docs/core.md"), `---\nid: core\ntype: module\ntitle: Core\nstatus: active\npaths: [src/]\nverified-against: ${stamp}\n---\nCore design.\n`);
  writeFileSync(join(root, "docs/verified.json"), JSON.stringify({ schemaVersion: 1, documents: { "docs/core.md": { verifiedAgainst: stamp, paths: ["src/"] } } }, null, 2));
  git(root, "add", "-A"); git(root, "commit", "-qm", "add stamped design");
  const engine = new SpecsEngine(root, parseSpecsConfig({ stamps_file: "docs/verified.json" }));
  expect(engine.check().freshness.map(row => row.state)).toEqual(["fresh", "fresh"]);
  writeFileSync(join(root, "src/core.ts"), "export const core = 2;\n");
  git(root, "add", "src/core.ts"); git(root, "commit", "-qm", "change covered source");
  writeFileSync(join(root, "src/new.ts"), "export const added = 3;\n");
  const stale = engine.check();
  expect(stale.stale).toBe(2);
  expect(stale.freshness.map(row => row.state)).toEqual(["stale", "stale"]);
  expect(stale.freshness.every(row => row.commitsSince === 1 && row.dirty === true)).toBe(true);
});

test("a non-ancestor stamp is an error and never reported as fresh", () => {
  const { root, git } = repository("valid");
  git("checkout", "--orphan", "unrelated");
  git("rm", "-rf", ".");
  writeFileSync(join(root, "other.md"), "unrelated\n"); git("add", "-A"); git("commit", "-qm", "unrelated root");
  const stamp = git("rev-parse", "HEAD");
  git("checkout", "-q", "--orphan", "mainline"); git("rm", "-rf", ".");
  mkdirSync(join(root, "src"), { recursive: true }); writeFileSync(join(root, "src/core.ts"), "export const core = 1;\n");
  writeFileSync(join(root, "design.md"), `---\nid: design\ntype: goal\ntitle: Design\npaths: [src/core.ts]\nverified-against: ${stamp}\n---\n\n`);
  git("add", "-A"); git("commit", "-qm", "new root");
  const report = new SpecsEngine(root, parseSpecsConfig(undefined)).check();
  expect(report.items.map(item => item.code)).toContain("nonancestor-stamp");
  expect(report.freshness.some(row => row.state === "fresh")).toBe(false);
});

test("symlinked Markdown files and symlink components are skipped", () => {
  const { root, engine } = repository("valid");
  const outside = tempRoot("symlink-target");
  writeFileSync(join(outside, "hidden.md"), "---\nid: hidden\ntype: module\ntitle: Hidden\n---\n");
  const link = join(root, "linked.md"); symlinkSync(join(root, "goal.md"), link);
  symlinkSync(outside, join(root, "linked-dir"));
  const report = engine.list();
  expect(report.specs.some(spec => spec.id === "hidden")).toBe(false);
  expect(report.specs.some(spec => spec.path === "linked.md")).toBe(false);
});

test("the 8 KiB frontmatter cap is visible as a truncated report with a narrowing step", () => {
  const root = tempRoot("frontmatter-cap"); git(root, "init", "-q");
  const frontmatter = `---\nid: large\ntype: module\ntitle: Large\n${"x".repeat(9 * 1024)}\n---\n`;
  writeFileSync(join(root, "large.md"), frontmatter); git(root, "add", "-A"); git(root, "commit", "-qm", "large frontmatter");
  const report = new SpecsEngine(root, parseSpecsConfig(undefined)).check();
  expect(report.truncated).toBe(true);
  expect(report.items.some(item => item.code === "frontmatter-truncated" && item.nextSteps.includes("specs.roots"))).toBe(true);
});

test("discovery scans at most 2000 Markdown files and tells the operator to narrow roots", () => {
  const root = tempRoot("file-cap"); git(root, "init", "-q");
  for (let index = 0; index < 2001; index++) writeFileSync(join(root, `note-${String(index).padStart(4, "0")}.md`), "ordinary Markdown\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "many Markdown files");
  const report = new SpecsEngine(root, parseSpecsConfig(undefined)).check();
  expect(report.truncated).toBe(true);
  expect(report.items.some(item => item.code === "scan-truncated" && item.nextSteps.includes("specs.roots"))).toBe(true);
});

test("body-link scanning preserves UTF-8 identifiers split across the reader boundary", () => {
  const root = tempRoot("unicode-body-link"); git(root, "init", "-q");
  writeFileSync(join(root, "goal.md"), `---\nid: goal\ntype: goal\ntitle: Goal\n---\nGoal.\n`);
  const prefix = "x".repeat(65_533);
  writeFileSync(join(root, "target.md"), `---\nid: 模块\ntype: module\ntitle: Module\nparent: goal\n---\nTarget.\n`);
  writeFileSync(join(root, "link.md"), `---\nid: link\ntype: module\ntitle: Link\nparent: goal\n---\n${prefix}[[模块]]\n`);
  git(root, "add", "-A"); git(root, "commit", "-qm", "unicode body link");
  const report = new SpecsEngine(root, parseSpecsConfig(undefined)).check();
  expect(report.items.some(item => item.code === "unknown-body-link")).toBe(false);
});

test("freshness never runs configured external diff, textconv or clean-filter programs", () => {
  const root = tempRoot("no-external-diff"); git(root, "init", "-q"); mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "src/core.ts"), "export const core = 1;\n");
  writeFileSync(join(root, ".gitattributes"), "*.ts diff=fixture filter=fixture\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "source baseline");
  const stamp = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "docs/core.md"), `---\nid: core\ntype: module\ntitle: Core\npaths: [src/core.ts]\nverified-against: ${stamp}\n---\nCore.\n`);
  writeFileSync(join(root, "docs/verified.json"), JSON.stringify({ schemaVersion: 1, documents: { "docs/core.md": { verifiedAgainst: stamp, paths: ["src/core.ts"] } } }));
  git(root, "add", "-A"); git(root, "commit", "-qm", "stamp design");
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "src/core.ts"), "export const core = 2;\n");
  git(root, "add", "src/core.ts"); git(root, "commit", "-qm", "change covered source");
  const marker = join(root, "external-diff-ran"), executable = join(root, "external-diff.sh");
  writeFileSync(executable, `#!/bin/sh\nprintf called >> '${marker}'\ncat\n`, { mode: 0o700 }); chmodSync(executable, 0o700);
  git(root, "config", "diff.external", executable); git(root, "config", "diff.fixture.textconv", executable); git(root, "config", "filter.fixture.clean", executable); git(root, "config", "filter.fixture.required", "true");
  writeFileSync(join(root, "src/core.ts"), "export const core = 3;\n"); // unstaged so this test can detect an accidental clean-filter read
  const report = new SpecsEngine(root, parseSpecsConfig({ stamps_file: "docs/verified.json" })).check({ base });
  expect(report.errors).toBe(0);
  expect(report.freshness).toHaveLength(2);
  expect(report.freshness.every(row => row.state === "stale" && row.dirty === true)).toBe(true);
  expect(existsSync(marker)).toBe(false);
});
