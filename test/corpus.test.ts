import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corpusConfig, MAX_CORPUS_ROOTS } from "../src/hub/corpus-config.ts";
import { checkCorpusRoot, CorpusIndex, MAX_DEPTH, MAX_HEADINGS, MAX_LINKS, MAX_NOTE_BYTES, parseNote, VAULT_REASON } from "../src/hub/corpus.ts";
import { realPath } from "../src/hub/project.ts";
import { loadConfig } from "../src/hub/daemon.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { ALL_MACHINE_LOCAL, MACHINE_LOCAL } from "../src/hub/config-trust.ts";

// agent-hub #510 (hub task #331): the read-only plain-notes index. Spec: "Knowledge corpus (#510), owner decision 2026-10-22".
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) { try { chmodSync(join(dir, "locked"), 0o755); } catch { /* not made */ } rmSync(dir, { recursive: true, force: true }); } });
const base = () => { const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-corpus-"))); dirs.push(dir); mkdirSync(join(dir, "project")); return { dir, cwd: join(dir, "project") }; };
const put = (root: string, path: string, text = "x") => { const file = join(root, path); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); return file; };
const ctx = (cwd: string, paths: string[], extra: Record<string, unknown> = {}) => ({ cwd, paths, ...extra });

test("corpus.paths is a machine-local key, so a committed config cannot point the hub at a folder", () => {
  expect(MACHINE_LOCAL).toContain("corpus.paths");
  expect(ALL_MACHINE_LOCAL).toContain("corpus.paths");
});

test("corpusConfig accepts bounded folder lists and refuses the rest", () => {
  expect(corpusConfig(undefined)).toEqual({ paths: [] });
  expect(corpusConfig({})).toEqual({ paths: [] });
  expect(corpusConfig({ paths: ["/notes", "rel/notes", "/notes"] })).toEqual({ paths: ["/notes", "rel/notes"] });
  const bad: [unknown, string][] = [
    ["x", "corpus must be an object"], [[], "corpus must be an object"], [null, "corpus must be an object"], [{ extra: 1 }, "corpus.extra: unknown key"],
    [{ paths: "/n" }, "corpus.paths takes a list"], [{ paths: Array(MAX_CORPUS_ROOTS + 1).fill("/n").map((p, i) => p + i) }, "at most"],
    [{ paths: [""] }, "non-empty string"], [{ paths: ["  "] }, "non-empty string"], [{ paths: [5] }, "non-empty string"], [{ paths: ["a\nb"] }, "control characters"],
    [{ paths: ["~/notes"] }, "~ is not expanded"], [{ paths: [" /n"] }, "spaces"], [{ paths: ["x".repeat(1025)] }, "at most 1024"],
  ];
  for (const [input, reason] of bad) expect(() => corpusConfig(input), JSON.stringify(input)?.slice(0, 60)).toThrow(reason);
});

test("parseNote reads frontmatter, headings and wikilinks, and ignores code", () => {
  const note = parseNote([
    "---", "title: Project Plan", "tags: [alpha, #beta]", "aliases:", "  - The Plan", "  - \"Plan B\"", "status: draft", "---",
    "# Heading One", "Text with [[Other Note]] and [[folder/Deep Note#Section|shown]] and ![[Embedded]].", "```", "# not a heading", "[[in code]]", "```", "Inline `[[code link]]` too.", "## Second  ##", "[[Other Note]]",
  ].join("\n"));
  expect(note.title).toBe("Project Plan");
  expect(note.frontmatter).toMatchObject({ title: "Project Plan", status: "draft", tags: ["alpha", "#beta"] });
  expect(note.tags).toEqual(["alpha", "beta"]);
  expect(note.aliases).toEqual(["The Plan", "Plan B"]);
  expect(note.headings).toEqual([{ level: 1, text: "Heading One" }, { level: 2, text: "Second" }]);
  expect(note.links).toEqual([
    { target: "Other Note", embed: false }, { target: "folder/Deep Note", heading: "Section", embed: false }, { target: "Embedded", embed: true }, { target: "Other Note", embed: false },
  ]);
  expect(note.truncated).toBe(false);
});

test("a note without frontmatter takes its first level-1 heading as title, and malformed input never throws", () => {
  expect(parseNote("# Only A Title\nbody").title).toBe("Only A Title");
  expect(parseNote("no heading at all").title).toBeUndefined();
  for (const text of ["", "---", "---\n", "---\nunterminated: yes", "---\n: no key\n---\n", "[[", "[[]]", "[[a|]]", "\u0000\u0001", "---\n__proto__: x\nconstructor: y\n---\n", "---\ntags: [a, \n---\n[[ok]]"]) {
    expect(() => parseNote(text), JSON.stringify(text)).not.toThrow();
  }
  expect(parseNote("---\n__proto__: x\nconstructor: y\n---\n").frontmatter).toEqual({});
  expect(Object.getPrototypeOf(parseNote("---\n__proto__: x\n---\n").frontmatter)).toBe(Object.prototype);
  expect(parseNote("---\ntags: [a, \n---\n[[ok]]").links).toEqual([{ target: "ok", embed: false }]);
});

test("parsing is bounded: headings, links and a huge frontmatter are cut and say so", () => {
  const many = parseNote(Array.from({ length: MAX_HEADINGS + 20 }, (_, i) => `# H${i}`).join("\n"));
  expect(many.headings).toHaveLength(MAX_HEADINGS);
  expect(many.truncated).toBe(true);
  const links = parseNote(Array.from({ length: MAX_LINKS + 20 }, (_, i) => `[[n${i}]]`).join(" "));
  expect(links.links).toHaveLength(MAX_LINKS);
  expect(links.truncated).toBe(true);
  const front = parseNote(`---\n${"k: v\n".repeat(5000)}---\n# After`);
  expect(front.truncated).toBe(true);
  expect(front.frontmatter).toEqual({});
  expect(parseNote("[[" + "a".repeat(300) + "]]").links).toEqual([]); // a target over 200 characters is no link
});

test("a plain notes folder is indexed read-only with ids, titles, tags and links", () => {
  const { dir, cwd } = base(), notes = join(dir, "notes");
  put(notes, "a.md", "---\ntitle: Alpha\ntags: [x]\n---\n# Alpha\n[[b]] and [[sub/c]]");
  put(notes, "b.md", "# Beta\nback to [[a]]");
  put(notes, "sub/c.markdown", "# Gamma");
  put(notes, "readme.txt", "not a note");
  const index = new CorpusIndex(ctx(cwd, [notes]));
  const report = index.refresh();
  expect(report.roots[0]).toMatchObject({ label: "notes", notes: 3 });
  expect(report.roots[0]!.refused).toBeUndefined();
  expect(index.notes().map(note => note.id)).toEqual(["note:notes/a.md", "note:notes/b.md", "note:notes/sub/c.markdown"]);
  const alpha = index.get("note:notes/a.md")!;
  expect(alpha).toMatchObject({ title: "Alpha", tags: ["x"], root: "notes", path: "a.md" });
  expect(alpha.links.map(link => link.target)).toEqual(["b", "sub/c"]);
  expect(alpha.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(index.resolveLink(alpha.id, "b").map(note => note.id)).toEqual(["note:notes/b.md"]);
  expect(index.resolveLink(alpha.id, "sub/c").map(note => note.id)).toEqual(["note:notes/sub/c.markdown"]);
  expect(index.resolveLink(alpha.id, "C").map(note => note.id)).toEqual(["note:notes/sub/c.markdown"]);
  expect(index.resolveLink(alpha.id, "missing")).toEqual([]);
  expect(index.resolveLink("note:nowhere/x.md", "b")).toEqual([]);
});

test("the index never stores note text and never writes into the folder", () => {
  const { dir, cwd } = base(), notes = join(dir, "notes");
  put(notes, "a.md", "# T\nthe secret body sentence");
  const before = Bun.spawnSync(["ls", "-laR", notes]).stdout.toString();
  const index = new CorpusIndex(ctx(cwd, [notes]));
  index.refresh(); index.refresh();
  expect(JSON.stringify(index.notes())).not.toContain("secret body sentence");
  expect(Bun.spawnSync(["ls", "-laR", notes]).stdout.toString()).toBe(before);
});

test("refresh is incremental: an unchanged note is reused, a changed one is re-read, a removed one is dropped", () => {
  const { dir, cwd } = base(), notes = join(dir, "notes");
  const a = put(notes, "a.md", "# A"), b = put(notes, "b.md", "# B");
  const index = new CorpusIndex(ctx(cwd, [notes]));
  expect(index.refresh()).toMatchObject({ notes: 2, parsed: 2, reused: 0, removed: 0 });
  expect(index.refresh()).toMatchObject({ notes: 2, parsed: 0, reused: 2, removed: 0 });
  writeFileSync(a, "# A changed with more text"); const later = new Date(Date.now() + 5000); utimesSync(a, later, later);
  expect(index.refresh()).toMatchObject({ parsed: 1, reused: 1 });
  expect(index.get("note:notes/a.md")!.title).toBe("A changed with more text");
  rmSync(b);
  expect(index.refresh()).toMatchObject({ notes: 1, removed: 1 });
  expect(index.get("note:notes/b.md")).toBeUndefined();
});

test("an Obsidian vault is refused when it is the root, with a reason naming the Obsidian MCP tools", () => {
  const { dir, cwd } = base(), vault = join(dir, "vault");
  put(vault, ".obsidian/app.json", "{}"); put(vault, "n.md", "# N");
  const checked = checkCorpusRoot(vault, ctx(cwd, [vault]));
  expect(checked.ok).toBe(false);
  expect((checked as { reason: string }).reason).toContain(VAULT_REASON);
  expect((checked as { reason: string }).reason).toContain("Obsidian MCP tools");
  const index = new CorpusIndex(ctx(cwd, [vault])), report = index.refresh();
  expect(report.notes).toBe(0);
  expect(report.roots[0]!.refused).toContain("Obsidian MCP tools");
  expect(index.notes()).toEqual([]);
});

test("a root inside a vault is refused through every ancestor, and a root that contains a vault is refused wherever it sits below", () => {
  const { dir, cwd } = base();
  const vault = join(dir, "vault");
  put(vault, ".obsidian/app.json", "{}"); put(vault, "sub/deep/n.md", "# N");
  const inside = checkCorpusRoot(join(vault, "sub/deep"), ctx(cwd, [join(vault, "sub/deep")]));
  expect(inside.ok).toBe(false);
  expect((inside as { reason: string }).reason).toContain(`the vault folder is ${vault}`);
  const parent = join(dir, "parent");
  put(parent, "plain.md", "# P"); put(parent, "a/b/c/.obsidian/x", "1"); put(parent, "a/b/c/n.md", "# N");
  const index = new CorpusIndex(ctx(cwd, [parent])), report = index.refresh();
  expect(report.roots[0]!.refused).toContain("found");
  expect(report.roots[0]!.refused).toContain(".obsidian");
  expect(index.notes(), "a root that contains a vault contributes no notes at all").toEqual([]);
});

test("a vault is caught by its folded spelling, by a symlink to it, and by a file named .obsidian too", () => {
  const { dir, cwd } = base();
  const vault = join(dir, "vault2"); put(vault, ".obsidian/app.json", "{}"); put(vault, "n.md", "# N");
  const link = join(dir, "link"); symlinkSync(vault, link);
  expect(checkCorpusRoot(link, ctx(cwd, [link])).ok, "a symlink to a vault resolves to the vault").toBe(false);
  const outer = join(dir, "outer"); put(outer, "x/n.md", "# N"); symlinkSync(vault, join(outer, "x", "alias"));
  const index = new CorpusIndex(ctx(cwd, [outer]));
  expect(index.refresh().notes, "a link inside the folder is skipped, never followed").toBe(1);
  const fileMarker = join(dir, "filemarker"); put(fileMarker, ".obsidian", "a file, not a folder"); put(fileMarker, "n.md", "# N");
  expect(checkCorpusRoot(fileMarker, ctx(cwd, [fileMarker])).ok, "any entry named .obsidian is a vault marker").toBe(false);
  const folded = join(dir, "folded"); put(folded, "x/.OBSIDIAN/app.json", "{}"); put(folded, "n.md", "# N");
  expect(new CorpusIndex(ctx(cwd, [folded])).refresh().roots[0]!.refused).toContain("Obsidian MCP tools");
});

test("evidence that cannot be read refuses the root: an unreadable folder, a missing path and a file are never certified", () => {
  const { dir, cwd } = base(), notes = join(dir, "notes");
  put(notes, "a.md", "# A"); put(notes, "locked/b.md", "# B");
  chmodSync(join(notes, "locked"), 0o000);
  try {
    const report = new CorpusIndex(ctx(cwd, [notes])).refresh();
    if (process.getuid?.() !== 0) expect(report.roots[0]!.refused).toContain("cannot be read");
  } finally { chmodSync(join(notes, "locked"), 0o755); }
  const missing = checkCorpusRoot(join(dir, "nope"), ctx(cwd, [join(dir, "nope")]));
  expect(missing.ok).toBe(false);
  expect((missing as { reason: string }).reason).toContain("never read");
  const file = put(dir, "file.md", "# F");
  expect(checkCorpusRoot(file, ctx(cwd, [file]))).toMatchObject({ ok: false, reason: expect.stringContaining("not a folder") });
});

test("a folder tree that is too deep or too big to be shown free of a vault is refused, not cut short", () => {
  const { dir, cwd } = base(), deep = join(dir, "deep");
  put(deep, Array.from({ length: MAX_DEPTH + 3 }, () => "d").join("/") + "/n.md", "# N");
  const report = new CorpusIndex(ctx(cwd, [deep])).refresh();
  expect(report.roots[0]!.refused).toContain("cannot be shown to be free of a vault");
  expect(report.notes).toBe(0);
});

test("pii.paths and the deny rules apply first: a protected root is refused, a protected folder or note is skipped and counted", () => {
  const { cwd } = base();
  const root = join(cwd, "notes");
  put(root, "open.md", "# Open"); put(root, "secret/s.md", "# S"); put(root, "credentials.md", "# Creds"); put(root, ".env", "KEY=1"); put(root, "private-x/p.md", "# P");
  const index = new CorpusIndex(ctx(cwd, [root], { piiPaths: ["notes/secret"], deny: ["private-x"] }));
  const report = index.refresh();
  expect(index.notes().map(note => note.path), "credentials.md is on the built-in secrets denylist, secret/ is pii.paths, private-x/ is local.deny").toEqual(["open.md"]);
  expect(report.roots[0]!.skipped.protected).toBe(3);
  expect(JSON.stringify(index.notes())).not.toContain("# S");
  const piiRoot = new CorpusIndex(ctx(cwd, [root], { piiPaths: ["notes"] })).refresh();
  expect(piiRoot.roots[0]!.refused).toContain("pii.paths");
  expect(piiRoot.notes).toBe(0);
  const inside = new CorpusIndex(ctx(cwd, [join(root, "secret")], { piiPaths: ["notes/secret"] })).refresh();
  expect(inside.roots[0]!.refused, "a root inside a pii path is refused").toContain("pii.paths");
  const parent = new CorpusIndex(ctx(cwd, [cwd], { piiPaths: ["notes/secret"] }));
  parent.refresh();
  expect(parent.notes().map(note => note.path), "a root that merely contains a pii folder is read, minus that folder").not.toContain("notes/secret/s.md");
  expect(parent.notes().length).toBeGreaterThan(0);
  const denied = new CorpusIndex(ctx(cwd, [root], { deny: ["notes"] })).refresh();
  expect(denied.roots[0]!.refused).toContain("denylist");
});

test("a note whose text matches signals.pii_patterns is not indexed, and a pattern that cannot be evaluated indexes nothing", () => {
  const { dir, cwd } = base(), notes = join(dir, "notes");
  put(notes, "ok.md", "# Fine"); put(notes, "pii.md", "patient 900101-1234567");
  const flagged = new CorpusIndex(ctx(cwd, [notes], { piiPatterns: ["\\d{6}-\\d{7}"] }));
  const report = flagged.refresh();
  expect(flagged.notes().map(note => note.path)).toEqual(["ok.md"]);
  expect(report.roots[0]!.skipped.pii).toBe(1);
  const broken = new CorpusIndex(ctx(cwd, [notes], { piiPatterns: ["("] }));
  expect(broken.refresh().notes).toBe(0);
});

test("links, hard links, oversized and binary notes are skipped and counted, never read", () => {
  const { dir, cwd } = base(), notes = join(dir, "notes");
  put(notes, "ok.md", "# Ok"); const target = put(dir, "outside.md", "# Outside");
  symlinkSync(target, join(notes, "link.md")); linkSync(target, join(notes, "hard.md"));
  put(notes, "big.md", "a".repeat(MAX_NOTE_BYTES + 1)); put(notes, "bin.md", "abc\u0000def");
  const index = new CorpusIndex(ctx(cwd, [notes])), report = index.refresh();
  expect(index.notes().map(note => note.path)).toEqual(["ok.md"]);
  expect(report.roots[0]!.skipped).toMatchObject({ links: 2, large: 1, unreadable: 1 });
});

test("two roots get distinct labels, and a symlinked root is read as its real folder", () => {
  const { dir, cwd } = base();
  const one = join(dir, "a", "notes"), two = join(dir, "b", "notes");
  put(one, "x.md", "# X"); put(two, "x.md", "# X2");
  const alias = join(dir, "alias"); symlinkSync(one, alias);
  const index = new CorpusIndex(ctx(cwd, [one, two, alias]));
  const report = index.refresh();
  expect(report.roots.map(root => root.label)).toEqual(["notes", "notes-2", "notes-3"]);
  expect(index.notes().map(note => note.id)).toEqual(["note:notes-2/x.md", "note:notes-3/x.md", "note:notes/x.md"]);
});

function gitProject(files: Record<string, unknown>, commit: string[] = []) {
  const { dir, cwd } = base();
  mkdirSync(join(cwd, ".agenthub"));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(cwd, ".agenthub", name), JSON.stringify(value));
  const git = (...args: string[]) => { const r = hubGitSync(["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", ...args], { encoding: "utf8" }); expect(r.status, r.stderr).toBe(0); };
  git("init", "-q");
  for (const name of commit) git("add", "-f", `.agenthub/${name}`);
  git("commit", "-qm", "baseline", "--allow-empty");
  return { dir, cwd };
}

test("loadConfig takes corpus.paths from an untracked config.local.json only", () => {
  const local = gitProject({ "config.local.json": { corpus: { paths: ["/notes/a"] } } });
  expect(loadConfig(local.cwd).corpus).toEqual({ paths: ["/notes/a"] });
  const committed = gitProject({ "config.json": { corpus: { paths: ["/notes/a"] } } }, ["config.json"]);
  expect(loadConfig(committed.cwd).corpus).toEqual({ paths: [] });
  expect(loadConfig(committed.cwd).ignored?.join(" ")).toContain("corpus.paths in .agenthub/config.json ignored");
  const trackedLocal = gitProject({ "config.local.json": { corpus: { paths: ["/notes/a"] } } }, ["config.local.json"]);
  expect(loadConfig(trackedLocal.cwd).corpus).toEqual({ paths: [] });
  const none = gitProject({});
  expect(loadConfig(none.cwd).corpus).toEqual({ paths: [] });
});

test("an invalid corpus block is refused by the loader with the path named", () => {
  const bad = gitProject({ "config.local.json": { corpus: { paths: ["~/notes"] } } });
  expect(() => loadConfig(bad.cwd)).toThrow("corpus.paths[0]");
  const extra = gitProject({ "config.local.json": { corpus: { paths: ["/n"], vault: true } } });
  expect(() => loadConfig(extra.cwd)).toThrow("corpus.vault: unknown key");
});

test("a vault directly inside a protected folder still refuses the root, though the folder itself is never read", () => {
  const { cwd } = base(), root = join(cwd, "notes");
  put(root, "open.md", "# Open"); put(root, "secret/.obsidian/app.json", "{}"); put(root, "secret/s.md", "# S");
  const index = new CorpusIndex(ctx(cwd, [root], { piiPaths: ["notes/secret"] })), report = index.refresh();
  expect(report.roots[0]!.refused).toContain("Obsidian MCP tools");
  expect(index.notes()).toEqual([]);
  const plain = join(cwd, "plain");
  put(plain, "open.md", "# Open"); put(plain, "secret/s.md", "# S");
  const ok = new CorpusIndex(ctx(cwd, [plain], { piiPaths: ["plain/secret"] }));
  expect(ok.refresh().notes).toBe(1);
});

test("a refused root does not hide the others: each root is judged alone, and a refusal removes its earlier notes on the next refresh", () => {
  const { dir, cwd } = base(), good = join(dir, "good"), vault = join(dir, "vault");
  put(good, "g.md", "# G"); put(vault, "v.md", "# V");
  const index = new CorpusIndex(ctx(cwd, [good, vault]));
  expect(index.refresh().notes).toBe(2);
  put(vault, ".obsidian/app.json", "{}"); // the folder becomes a vault after it was indexed
  const report = index.refresh();
  expect(report.roots[1]!.refused).toContain("Obsidian MCP tools");
  expect(index.notes().map(note => note.id)).toEqual(["note:good/g.md"]);
  expect(report.removed).toBe(1);
});
