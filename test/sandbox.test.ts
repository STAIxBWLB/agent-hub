import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HFS_IGNORABLE_POINTS, hubWriteRegexes } from "../src/local/deny.ts";
import { profile, sandboxAvailable, sandboxedExec } from "../src/local/sandbox.ts";

/**
 * Seatbelt profile tests that need the real sandbox-exec (issue #270). The nested-.git, name-route and long-root
 * legs run on any macOS volume; the ignorable-code-point legs need HFS+, the only filesystem that ignores those
 * code points (the probe found case-insensitive APFS ignores none), so they run inside a mounted HFS+ disk image.
 */

const ZWJ = HFS_IGNORABLE_POINTS[1]!;

/** Create, attach and detach a tiny HFS+ image once: the ignorable legs are skipped with the reason when that fails. */
function hfsProbe(): { ok: boolean; why: string } {
  if (!sandboxAvailable()) return { ok: false, why: "no sandbox-exec on this host" };
  const dir = mkdtempSync(join(tmpdir(), "agenthub-hfs-probe-"));
  const dmg = join(dir, "probe.dmg"), mnt = join(dir, "mnt");
  try {
    mkdirSync(mnt);
    let r = Bun.spawnSync(["hdiutil", "create", "-size", "16m", "-fs", "HFS+", "-volname", "ahubprobe", "-ov", dmg]);
    if (r.exitCode !== 0) return { ok: false, why: `hdiutil create: ${r.stderr.toString().trim().split("\n")[0]}` };
    r = Bun.spawnSync(["hdiutil", "attach", "-nobrowse", "-mountpoint", mnt, dmg]);
    if (r.exitCode !== 0) return { ok: false, why: `hdiutil attach: ${r.stderr.toString().trim().split("\n")[0]}` };
    if (Bun.spawnSync(["hdiutil", "detach", mnt, "-quiet"]).exitCode !== 0) Bun.spawnSync(["hdiutil", "detach", mnt, "-force", "-quiet"]);
    return { ok: true, why: "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const HFS = hfsProbe();

/** Same probe for a case-sensitive APFS image (#281): the deny legs are skipped with the reason when it cannot mount. */
function apfsxProbe(): { ok: boolean; why: string } {
  if (!sandboxAvailable()) return { ok: false, why: "no sandbox-exec on this host" };
  const dir = mkdtempSync(join(tmpdir(), "agenthub-apfsx-probe-"));
  const dmg = join(dir, "probe.dmg"), mnt = join(dir, "mnt");
  try {
    mkdirSync(mnt);
    let r = Bun.spawnSync(["hdiutil", "create", "-size", "16m", "-fs", "Case-sensitive APFS", "-volname", "ahubprobe", "-ov", dmg]);
    if (r.exitCode !== 0) return { ok: false, why: `hdiutil create: ${r.stderr.toString().trim().split("\n")[0]}` };
    r = Bun.spawnSync(["hdiutil", "attach", "-nobrowse", "-mountpoint", mnt, dmg]);
    if (r.exitCode !== 0) return { ok: false, why: `hdiutil attach: ${r.stderr.toString().trim().split("\n")[0]}` };
    if (Bun.spawnSync(["hdiutil", "detach", mnt, "-quiet"]).exitCode !== 0) Bun.spawnSync(["hdiutil", "detach", mnt, "-force", "-quiet"]);
    return { ok: true, why: "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const APFSX = apfsxProbe();

const detach = (mnt: string) => {
  if (Bun.spawnSync(["hdiutil", "detach", mnt, "-quiet"]).exitCode !== 0) Bun.spawnSync(["hdiutil", "detach", mnt, "-force", "-quiet"]);
};

test.skipIf(!sandboxAvailable())("the profile refuses writes to a nested .git/config, .git/hooks and .git/commondir at any depth (#270)", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-nested-git-")));
  mkdirSync(join(cwd, "sub", ".git"), { recursive: true });
  mkdirSync(join(cwd, "sub", "deep", "mod", ".git"), { recursive: true });
  const out = await sandboxedExec(["/bin/sh", "-c", [
    "(echo x > sub/.git/config) 2>/dev/null && echo WROTE-NESTED-CONFIG || echo blocked-nested-config",
    "(mkdir -p sub/.git/hooks && echo x > sub/.git/hooks/pre-commit) 2>/dev/null && echo WROTE-NESTED-HOOK || echo blocked-nested-hook",
    "(echo x > sub/.git/commondir) 2>/dev/null && echo WROTE-NESTED-COMMONDIR || echo blocked-nested-commondir",
    "(echo x > sub/deep/mod/.git/config) 2>/dev/null && echo WROTE-DEEP-CONFIG || echo blocked-deep-config",
  ].join("; ")], { cwd, profile: profile(cwd, false) });
  for (const expected of ["blocked-nested-config", "blocked-nested-hook", "blocked-nested-commondir", "blocked-deep-config"]) expect(out.output).toContain(expected);
  expect(existsSync(join(cwd, "sub", ".git", "config"))).toBe(false);
  expect(existsSync(join(cwd, "sub", ".git", "hooks"))).toBe(false);
  expect(existsSync(join(cwd, "sub", ".git", "commondir"))).toBe(false);
  expect(existsSync(join(cwd, "sub", "deep", "mod", ".git", "config"))).toBe(false);
});

test.skipIf(!sandboxAvailable())("the .git name itself is refused: rename in, rename out and back, symlink, gitfile, commondir, git init (#270)", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-gitname-")));
  Bun.spawnSync(["git", "init", "-q"], { cwd }); // outside the sandbox: the rename-out and commondir legs need a real .git
  mkdirSync(join(cwd, "planted"));
  writeFileSync(join(cwd, "planted", "config"), "[core]\n");
  const out = await sandboxedExec(["/bin/sh", "-c", [
    "mkdir s1 s2 s3 newrepo",
    "(mv planted s1/.git) 2>/dev/null && echo WROTE-RENAME-IN || echo blocked-rename-in",
    "(mv .git away && mv away .git) 2>/dev/null && echo WROTE-RENAME-OUT || echo blocked-rename-out",
    "(ln -s ../planted s2/.git) 2>/dev/null && echo WROTE-SYMLINK || echo blocked-symlink",
    "(echo 'gitdir: ../planted' > s3/.git) 2>/dev/null && echo WROTE-GITFILE || echo blocked-gitfile",
    "(echo .. > .git/commondir) 2>/dev/null && echo WROTE-COMMONDIR || echo blocked-commondir",
    "(git -C newrepo init -q) 2>/dev/null && echo WROTE-INIT || echo blocked-init",
  ].join("; ")], { cwd, profile: profile(cwd, false) });
  for (const expected of ["blocked-rename-in", "blocked-rename-out", "blocked-symlink", "blocked-gitfile", "blocked-commondir", "blocked-init"]) expect(out.output).toContain(expected);
  expect(existsSync(join(cwd, "s1", ".git"))).toBe(false); // the rename never landed
  expect(existsSync(join(cwd, "planted", "config"))).toBe(true); // and its source is intact
  expect(existsSync(join(cwd, ".git", "config"))).toBe(true); // the real .git was never renamed away
  expect(existsSync(join(cwd, "away"))).toBe(false);
  expect(existsSync(join(cwd, "s2", ".git"))).toBe(false);
  expect(existsSync(join(cwd, "s3", ".git"))).toBe(false);
  expect(existsSync(join(cwd, ".git", "commondir"))).toBe(false);
  expect(existsSync(join(cwd, "newrepo", ".git"))).toBe(false);
});

test.skipIf(!sandboxAvailable())("commondir is refused at any depth below a .git: a linked worktree's record cannot be repointed, and its prune fails inside (#270)", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-linked-wt-")));
  Bun.spawnSync(["git", "init", "-q"], { cwd });
  writeFileSync(join(cwd, "a.txt"), "one\n");
  Bun.spawnSync(["git", "-C", cwd, "add", "a.txt"]);
  Bun.spawnSync(["git", "-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "one"]);
  expect(Bun.spawnSync(["git", "-C", cwd, "worktree", "add", join(cwd, "linked")]).exitCode).toBe(0); // outside the sandbox
  const record = join(cwd, ".git", "worktrees", "linked", "commondir");
  const before = readFileSync(record, "utf8");
  const run = (command: string) => sandboxedExec(["/bin/sh", "-c", command], { cwd, profile: profile(cwd, false) });
  const out = await run("(echo /evil > .git/worktrees/linked/commondir) 2>/dev/null && echo WROTE-COMMONDIR || echo blocked-commondir");
  expect(out.output).toContain("blocked-commondir");
  expect(readFileSync(record, "utf8")).toBe(before); // the worktree was not repointed
  // The same unlink denial keeps a stale record in place: prune cannot remove it inside the sandbox (#270 cost).
  rmSync(join(cwd, "linked"), { recursive: true, force: true });
  await run("git worktree prune --expire=now");
  expect(readFileSync(record, "utf8")).toBe(before);
});

test.skipIf(!sandboxAvailable())("a worktree project: the common dir's config, hooks and commondir are refused, and refs named config or hooks still work (#270)", async () => {
  const main = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-main-repo-")));
  Bun.spawnSync(["git", "init", "-q"], { cwd: main });
  writeFileSync(join(main, "a.txt"), "one\n");
  Bun.spawnSync(["git", "-C", main, "add", "a.txt"]);
  Bun.spawnSync(["git", "-C", main, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "one"]);
  const cwd = join(realpathSync(mkdtempSync(join(tmpdir(), "agenthub-wt-proj-"))), "wt");
  expect(Bun.spawnSync(["git", "-C", main, "worktree", "add", cwd]).exitCode).toBe(0); // outside the sandbox
  const gitDir = join(main, ".git", "worktrees", "wt");
  const commondir = readFileSync(join(gitDir, "commondir"), "utf8");
  const run = (command: string) => sandboxedExec(["/bin/sh", "-c", command], { cwd, profile: profile(cwd, false) });
  const out = await run([
    `(echo x > '${main}/.git/config') 2>/dev/null && echo WROTE-MAIN-CONFIG || echo blocked-main-config`,
    `(echo x > '${main}/.git/hooks/pre-commit') 2>/dev/null && echo WROTE-MAIN-HOOK || echo blocked-main-hook`,
    `(echo x > '${main}/.git/commondir') 2>/dev/null && echo WROTE-MAIN-COMMONDIR || echo blocked-main-commondir`,
    `(echo x > '${gitDir}/commondir') 2>/dev/null && echo WROTE-WT-COMMONDIR || echo blocked-wt-commondir`,
    `(echo x > '${gitDir}/config') 2>/dev/null && echo WROTE-WT-CONFIG || echo blocked-wt-config`,
    "git branch fix/config && echo branched-config",
    "git tag config && echo tagged-config",
    "git checkout -qb feature/hooks/x && echo branched-hooks",
  ].join("; "));
  for (const expected of ["blocked-main-config", "blocked-main-hook", "blocked-main-commondir", "blocked-wt-commondir", "blocked-wt-config", "branched-config", "tagged-config", "branched-hooks"]) expect(out.output).toContain(expected);
  expect(existsSync(join(main, ".git", "commondir"))).toBe(false);
  expect(readFileSync(join(gitDir, "commondir"), "utf8")).toBe(commondir);
  expect(existsSync(join(gitDir, "config"))).toBe(false);
});

test.skipIf(!sandboxAvailable())("git add, commit, stash, checkout and gc still work inside the sandbox (#270)", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-gitops-")));
  Bun.spawnSync(["git", "init", "-q"], { cwd });
  writeFileSync(join(cwd, "a.txt"), "one\n");
  const out = await sandboxedExec(["/bin/sh", "-c", [
    "git add a.txt",
    "git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm one",
    "echo two >> a.txt",
    "git -c user.email=t@t -c user.name=t -c commit.gpgsign=false stash -q",
    "git checkout -q -- a.txt",
    "git gc -q",
    "echo git-ops-ok",
  ].join(" && ")], { cwd, profile: profile(cwd, false) });
  expect(out.output).toContain("git-ops-ok");
  expect(Bun.spawnSync(["git", "-C", cwd, "log", "--oneline"]).stdout.toString()).toContain("one");
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("one\n"); // stash and checkout really ran
});

test.skipIf(!sandboxAvailable())(".gitignore and .github stay writable through the profile: the folded patterns are equality, not prefix (#270)", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-prefix-")));
  const out = await sandboxedExec(["/bin/sh", "-c", [
    "echo x > .gitignore && echo wrote-gitignore",
    "mkdir -p .github/workflows && echo x > .github/workflows/ci.yml && echo wrote-github",
    "echo x > .agenthub.md && echo wrote-agenthub-md",
    "mkdir -p my.git x.git docs/git && echo x > my.git/config && echo x > x.git/config && echo x > docs/git/config && echo wrote-lookalikes",
  ].join("; ")], { cwd, profile: profile(cwd, false) });
  for (const expected of ["wrote-gitignore", "wrote-github", "wrote-agenthub-md", "wrote-lookalikes"]) expect(out.output).toContain(expected);
});

test.skipIf(!sandboxAvailable())("a project real path of 347 bytes or more, ASCII or Korean, still runs commands (#270)", async () => {
  // The folded literals carry no root: an SBPL string literal dies at 1024 bytes, and with the root inside, a
  // 347-byte root (a 118-character Korean one) made sandbox-exec refuse the whole profile, killing every command.
  for (const parts of [["a".repeat(105), "b".repeat(105), "c".repeat(90)], ["한글".repeat(25), "프로젝트".repeat(12), "디렉터리".repeat(8)]]) {
    const deep = join(mkdtempSync(join(tmpdir(), "agenthub-long-")), ...parts);
    mkdirSync(deep, { recursive: true });
    const cwd = realpathSync(deep);
    expect(Buffer.byteLength(cwd)).toBeGreaterThanOrEqual(347); // the regression this guards is invisible below it
    const out = await sandboxedExec(["/bin/sh", "-c", "echo long-root-ok"], { cwd, profile: profile(cwd, false) });
    expect(out.output).toContain("long-root-ok");
  }
});

test.skipIf(!HFS.ok)(`an HFS+ image: every ignorable code point at every position of .git, .agenthub, config, hooks and commondir is refused (#270)${HFS.ok ? "" : ` [skipped: ${HFS.why}]`}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-hfs-test-"));
  const dmg = join(dir, "t.dmg"), mnt = join(dir, "mnt");
  mkdirSync(mnt);
  /** Every code point at every position (before the first character, between each pair, after the last) plus a run of three. */
  const nameVariants = (name: string): string[] =>
    HFS_IGNORABLE_POINTS.flatMap((cp) => {
      const vs: string[] = [];
      for (let i = 0; i <= name.length; i++) vs.push(name.slice(0, i) + cp + name.slice(i));
      vs.push(name.slice(0, 2) + cp + cp + cp + name.slice(2));
      return vs;
    });
  /** Every code point mid-word, plus U+200D at every position. */
  const segVariants = (seg: string): string[] => [
    ...HFS_IGNORABLE_POINTS.map((cp) => `${seg.slice(0, 2)}${cp}${seg.slice(2)}`),
    ...Array.from({ length: seg.length + 1 }, (_, i) => `${seg.slice(0, i)}${ZWJ}${seg.slice(i)}`),
  ];
  try {
    expect(Bun.spawnSync(["hdiutil", "create", "-size", "16m", "-fs", "HFS+", "-volname", "ahubtest", "-ov", dmg]).exitCode).toBe(0);
    expect(Bun.spawnSync(["hdiutil", "attach", "-nobrowse", "-mountpoint", mnt, dmg]).exitCode).toBe(0);
    const cwd = realpathSync(mnt);
    // The list the rules fold must be exactly the list the volume ignores, or a dropped entry would pass silently:
    // hardcode the four ranges here, and probe each point against the mounted image.
    const HFS_IGNORED = ([[0x200C, 0x200F], [0x202A, 0x202E], [0x206A, 0x206F], [0xFEFF, 0xFEFF]] as [number, number][]).flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCodePoint(a + i)));
    expect(HFS_IGNORABLE_POINTS).toEqual(HFS_IGNORED);
    writeFileSync(join(cwd, "ab"), "x");
    for (const cp of HFS_IGNORED) expect(existsSync(join(cwd, `a${cp}b`))).toBe(true);
    Bun.spawnSync(["git", "init", "-q"], { cwd }); // a real .git for the second-segment legs, made outside the sandbox
    rmSync(join(cwd, ".git", "config")); // a folded write would create it anew (an existing one is refused as the canonical name)
    rmSync(join(cwd, ".git", "hooks"), { recursive: true, force: true });
    // One sandboxed script: every attempt echoes exactly one marker. On HFS+ all variants of a name open as that
    // name, so each name attempt gets a fresh plain parent; a WROTE anywhere, or a leftover outside, fails the test.
    const legs: string[] = [];
    const nameLeg = (tag: string, name: string) => {
      for (const [i, v] of nameVariants(name).entries()) legs.push(`mkdir n${tag}${i}`, `(mkdir 'n${tag}${i}/${v}') 2>/dev/null && echo WROTE-${tag}-${i} || echo blocked-${tag}-${i}`);
    };
    nameLeg("git", ".git");
    nameLeg("agenthub", ".agenthub");
    const segLeg = (tag: string, seg: string, attempt: (v: string) => string) => {
      for (const [i, v] of segVariants(seg).entries()) legs.push(`(${attempt(v)}) 2>/dev/null && echo WROTE-${tag}-${i} || echo blocked-${tag}-${i}`);
    };
    segLeg("config", "config", (v) => `echo x > '.git/${v}'`);
    segLeg("hooks", "hooks", (v) => `mkdir '.git/${v}' && echo x > '.git/${v}/pre-commit'`);
    segLeg("commondir", "commondir", (v) => `echo x > '.git/${v}'`);
    // A submodule git dir's names fold the same way (#281): `.git/modules/sub` stands in for one. The folded
    // `modules` component itself is the documented residual (the rules anchor at the discovered plain path).
    mkdirSync(join(cwd, ".git", "modules", "sub"), { recursive: true });
    segLeg("modconfig", "config", (v) => `echo x > '.git/modules/sub/${v}'`);
    segLeg("modhooks", "hooks", (v) => `mkdir '.git/modules/sub/${v}' && echo x > '.git/modules/sub/${v}/pre-commit'`);
    const attempts = legs.filter((l) => l.includes("echo WROTE")).length;
    const out = await sandboxedExec(["/bin/sh", "-c", legs.join("; ")], { cwd, profile: profile(cwd, false) });
    expect(out.output).not.toContain("WROTE");
    expect(out.output.match(/blocked-/g)?.length ?? 0).toBe(attempts);
    // From outside the sandbox a planted name is the real one on HFS+: nothing may exist under any spelling.
    for (const [i] of nameVariants(".git").entries()) expect(existsSync(join(cwd, `ngit${i}`, ".git"))).toBe(false);
    for (const [i] of nameVariants(".agenthub").entries()) expect(existsSync(join(cwd, `nagenthub${i}`, ".agenthub"))).toBe(false);
    expect(existsSync(join(cwd, ".git", "config"))).toBe(false);
    expect(existsSync(join(cwd, ".git", "hooks"))).toBe(false);
    expect(existsSync(join(cwd, ".git", "commondir"))).toBe(false);
    expect(existsSync(join(cwd, ".git", "modules", "sub", "config"))).toBe(false);
    expect(existsSync(join(cwd, ".git", "modules", "sub", "hooks"))).toBe(false);
    // An external git dir on the same volume, joiner spellings included: the common dir's config, hooks and the
    // worktree record's commondir stay refused. Each target is removed first, so a folded write would create it.
    const main2 = join(cwd, "main2");
    expect(Bun.spawnSync(["git", "init", "-q", main2]).exitCode).toBe(0);
    writeFileSync(join(main2, "a.txt"), "one\n");
    Bun.spawnSync(["git", "-C", main2, "add", "a.txt"]);
    Bun.spawnSync(["git", "-C", main2, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "one"]);
    const wt = join(cwd, "wt2");
    expect(Bun.spawnSync(["git", "-C", main2, "worktree", "add", wt]).exitCode).toBe(0);
    // The profile is built while the worktree still resolves its git dirs: built after the removals below it would
    // not hold them at all, and every write there would be refused whatever the rules say.
    const extProfile = profile(wt, false);
    rmSync(join(main2, ".git", "config"));
    rmSync(join(main2, ".git", "hooks"), { recursive: true, force: true });
    rmSync(join(main2, ".git", "worktrees", "wt2", "commondir"));
    const ext = await sandboxedExec(["/bin/sh", "-c", [
      // The control: an ordinary file in the common dir is writable, so a block below is the rule's doing.
      `(echo x > '${main2}/.git/probe-ok') 2>/dev/null && echo WROTE-EXT-OK || echo blocked-ext-ok`,
      `(echo x > '${main2}/.git/co${ZWJ}nfig') 2>/dev/null && echo WROTE-EXT-CONFIG || echo blocked-ext-config`,
      `(mkdir '${main2}/.git/ho${ZWJ}oks' && echo x > '${main2}/.git/ho${ZWJ}oks/pre-commit') 2>/dev/null && echo WROTE-EXT-HOOKS || echo blocked-ext-hooks`,
      `(echo x > '${main2}/.git/worktrees/wt2/co${ZWJ}mmondir') 2>/dev/null && echo WROTE-EXT-COMMONDIR || echo blocked-ext-commondir`,
    ].join("; ")], { cwd: wt, profile: extProfile });
    for (const expected of ["WROTE-EXT-OK", "blocked-ext-config", "blocked-ext-hooks", "blocked-ext-commondir"]) expect(ext.output).toContain(expected);
    expect(existsSync(join(main2, ".git", "config"))).toBe(false);
    expect(existsSync(join(main2, ".git", "hooks"))).toBe(false);
    expect(existsSync(join(main2, ".git", "worktrees", "wt2", "commondir"))).toBe(false);
  } finally {
    detach(mnt);
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

test.skipIf(!sandboxAvailable())("a submodule's git dir under .git/modules: config and hooks refused at the depth submodules nest, refs named config or hooks still work (#281)", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-submod-")));
  const git = (args: string[]) => Bun.spawnSync(["git", ...args]);
  const initRepo = (dir: string) => {
    expect(git(["init", "-q", dir]).exitCode).toBe(0);
    writeFileSync(join(dir, "f.txt"), "x\n");
    git(["-C", dir, "add", "f.txt"]);
    expect(git(["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "one"]).exitCode).toBe(0);
  };
  const deepSrc = join(base, "deep-src"), subSrc = join(base, "sub-src");
  initRepo(deepSrc);
  initRepo(subSrc);
  // sub-src carries deep as its own submodule, so main's .git/modules/sub/modules/deep is the nesting depth to cover.
  expect(git(["-C", subSrc, "-c", "protocol.file.allow=always", "submodule", "add", "-q", deepSrc, "deep"]).exitCode).toBe(0);
  git(["-C", subSrc, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "with deep"]);
  const cwd = join(base, "main");
  initRepo(cwd);
  expect(git(["-C", cwd, "-c", "protocol.file.allow=always", "submodule", "add", "-q", subSrc, "sub"]).exitCode).toBe(0);
  // A name with refs/logs as a substring and one ending in hooks: the boundary probes of round 2 (#281).
  for (const name of ["catalogs", "webhooks"]) {
    const src = join(base, `${name}-src`);
    initRepo(src);
    expect(git(["-C", cwd, "-c", "protocol.file.allow=always", "submodule", "add", "-q", src, name]).exitCode).toBe(0);
  }
  expect(git(["-C", cwd, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive", "-q"]).exitCode).toBe(0);
  const subGit = join(cwd, ".git", "modules", "sub"), deepGit = join(subGit, "modules", "deep");
  expect(existsSync(join(subGit, "config"))).toBe(true);
  expect(existsSync(join(deepGit, "config"))).toBe(true);
  const subConfig = readFileSync(join(subGit, "config"), "utf8"), deepConfig = readFileSync(join(deepGit, "config"), "utf8");
  rmSync(join(subGit, "hooks"), { recursive: true, force: true }); // the create-when-absent leg
  const out = await sandboxedExec(["/bin/sh", "-c", [
    "(echo x > .git/modules/sub/config) 2>/dev/null && echo WROTE-SUB-CONFIG || echo blocked-sub-config",
    "(mkdir .git/modules/sub/hooks && echo x > .git/modules/sub/hooks/pre-commit) 2>/dev/null && echo WROTE-SUB-HOOK || echo blocked-sub-hook",
    "(echo x > .git/modules/sub/modules/deep/config) 2>/dev/null && echo WROTE-DEEP-CONFIG || echo blocked-deep-config",
    "(echo x > .git/modules/sub/modules/deep/hooks/pre-commit) 2>/dev/null && echo WROTE-DEEP-HOOK || echo blocked-deep-hook",
    // The indirect routes: the directory entries above those files are protected like the .git name (#281).
    "(mv .git/modules/sub .git/modules/away) 2>/dev/null && echo WROTE-RENAME || echo blocked-rename",
    "(mv .git/modules .git/m2) 2>/dev/null && echo WROTE-ROOT-RENAME || echo blocked-root-rename",
    "(mv .git/modules/sub/modules .git/modules/sub/m2) 2>/dev/null && echo WROTE-NESTED-RENAME || echo blocked-nested-rename",
    "(mkdir planted && echo x > planted/config && ln planted/config .git/modules/sub/config) 2>/dev/null && echo WROTE-HARDLINK || echo blocked-hardlink",
    "ln -sfn planted .git/modules/sub 2>/dev/null; [ -L .git/modules/sub ] && echo WROTE-SYMLINK-REPLACE || echo entry-intact", // ln -sfn exits 0 but cannot replace a real directory; assert the state, not the code
    "git -C sub branch fix/config && echo branched-config-in-sub",
    "git -C sub tag config && echo tagged-config-in-sub",
    "git -C sub checkout -qb feature/hooks && echo branched-hooks-in-sub",
    "git -C sub/deep tag hooks && echo tagged-hooks-in-deep",
    "git -C sub -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm sub-work --allow-empty && echo committed-in-sub",
    // A name with refs/logs as a substring keeps the refusal; one ending in hooks keeps its ordinary writes (#281).
    "(echo x > .git/modules/catalogs/config) 2>/dev/null && echo WROTE-CATALOGS-CONFIG || echo blocked-catalogs-config",
    "(echo x > .git/modules/catalogs/hooks/pre-commit) 2>/dev/null && echo WROTE-CATALOGS-HOOK || echo blocked-catalogs-hook",
    "git -C catalogs branch fix/config && echo branched-config-in-catalogs",
    "git -C webhooks -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm wh --allow-empty && echo committed-in-webhooks",
    "(echo x > .git/modules/webhooks/FETCH_HEAD) 2>/dev/null && echo wrote-webhooks-fetch-head || echo blocked-webhooks-fetch-head",
    "(echo x > .git/modules/webhooks/hooks/pre-commit) 2>/dev/null && echo WROTE-WEBHOOKS-HOOK || echo blocked-webhooks-hook",
  ].join("; ")], { cwd, profile: profile(cwd, false) });
  for (const expected of ["blocked-sub-config", "blocked-sub-hook", "blocked-deep-config", "blocked-deep-hook", "blocked-rename", "blocked-root-rename", "blocked-nested-rename", "blocked-hardlink", "entry-intact", "branched-config-in-sub", "tagged-config-in-sub", "branched-hooks-in-sub", "tagged-hooks-in-deep", "committed-in-sub", "blocked-catalogs-config", "blocked-catalogs-hook", "branched-config-in-catalogs", "committed-in-webhooks", "wrote-webhooks-fetch-head", "blocked-webhooks-hook"]) expect(out.output).toContain(expected);
  expect(readFileSync(join(subGit, "config"), "utf8")).toBe(subConfig);
  expect(readFileSync(join(deepGit, "config"), "utf8")).toBe(deepConfig);
  expect(existsSync(join(subGit, "hooks"))).toBe(false);
  expect(existsSync(join(cwd, ".git", "modules", "away"))).toBe(false);
  expect(existsSync(join(cwd, ".git", "m2"))).toBe(false);
  expect(existsSync(join(subGit, "m2"))).toBe(false);
});

test.skipIf(!sandboxAvailable())("a linked worktree's submodule git dir (<common>/worktrees/<wt>/modules/<name>) and config.worktree are as protected as <common>/modules (#518)", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-wt-submod-")));
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  const ident = ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"];
  const initRepo = (dir: string) => {
    expect(git(["init", "-q", dir]).exitCode).toBe(0);
    writeFileSync(join(dir, "f.txt"), "x\n");
    git(["-C", dir, "add", "f.txt"]);
    expect(git(["-C", dir, ...ident, "commit", "-qm", "one"]).exitCode).toBe(0);
  };
  const subSrc = join(base, "sub-src"), main = join(base, "main"), cwd = join(base, "wt"), sibling = join(base, "wt-sibling");
  initRepo(subSrc); initRepo(main);
  expect(git(["-C", main, "-c", "protocol.file.allow=always", "submodule", "add", "-q", subSrc, "sub"]).exitCode).toBe(0);
  expect(git(["-C", main, ...ident, "commit", "-qm", "with sub"]).exitCode).toBe(0);
  expect(git(["-C", main, "worktree", "add", cwd]).exitCode).toBe(0);   // outside the sandbox
  expect(git(["-C", main, "worktree", "add", sibling]).exitCode).toBe(0);
  // The submodule of the LINKED worktree keeps its git dir under that worktree's own git dir, not under <common>/modules.
  expect(git(["-C", cwd, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]).exitCode).toBe(0);
  // A SIBLING worktree's submodule git dir is in the common dir the sandbox can write too, so it is protected as well. Only the sibling updates its submodule.
  expect(git(["-C", sibling, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]).exitCode).toBe(0);
  const common = join(main, ".git"), wtGit = join(common, "worktrees", "wt"), subGit = join(wtGit, "modules", "sub");
  const sibGit = join(common, "worktrees", "wt-sibling", "modules", "sub");
  expect(existsSync(join(subGit, "config"))).toBe(true);
  expect(existsSync(join(sibGit, "config"))).toBe(true);
  const sibConfig = readFileSync(join(sibGit, "config"), "utf8");
  const subConfig = readFileSync(join(subGit, "config"), "utf8");
  rmSync(join(subGit, "hooks"), { recursive: true, force: true });   // the create-when-absent leg, for this worktree's submodule and the sibling's
  rmSync(join(sibGit, "hooks"), { recursive: true, force: true });
  const out = await sandboxedExec(["/bin/sh", "-c", [
    `(echo '[core]' >> '${subGit}/config') 2>/dev/null && echo WROTE-WTSUB-CONFIG || echo blocked-wtsub-config`,
    `(mkdir '${subGit}/hooks' && echo x > '${subGit}/hooks/pre-commit') 2>/dev/null && echo WROTE-WTSUB-HOOK || echo blocked-wtsub-hook`,
    `(echo x > '${wtGit}/config.worktree') 2>/dev/null && echo WROTE-CONFIG-WORKTREE || echo blocked-config-worktree`,
    `(echo x > .git-config-probe && echo x > '${common}/config.worktree') 2>/dev/null && echo WROTE-COMMON-CONFIG-WORKTREE || echo blocked-common-config-worktree`,
    `(echo '[core]' >> '${sibGit}/config') 2>/dev/null && echo WROTE-SIBLING-CONFIG || echo blocked-sibling-config`,
    `(mkdir -p '${sibGit}/hooks' && echo x > '${sibGit}/hooks/pre-commit') 2>/dev/null && echo WROTE-SIBLING-HOOK || echo blocked-sibling-hook`,
    `(mv '${sibGit}' '${sibGit}2') 2>/dev/null && echo WROTE-SIBLING-RENAME || echo blocked-sibling-rename`,
    // The directory entries above: the submodule git dir cannot be renamed away, replaced or recreated either.
    `(mv '${subGit}' '${wtGit}/modules/away') 2>/dev/null && echo WROTE-WTSUB-RENAME || echo blocked-wtsub-rename`,
    `(mv '${wtGit}/modules' '${wtGit}/m2') 2>/dev/null && echo WROTE-WTMODULES-RENAME || echo blocked-wtmodules-rename`,
    // Ordinary work still runs: the worktree, its submodule's refs and a commit in the main project.
    `(echo hi > new.txt) && echo wrote-worktree-file`,
    "git branch fix/config && echo branched-config",
    "git -C sub branch fix/hooks && echo branched-in-sub",
    "git -C sub tag config && echo tagged-config-in-sub",
    `git -C sub ${ident.join(" ")} commit -qm in-sub --allow-empty && echo committed-in-sub`,
  ].join("; ")], { cwd, profile: profile(cwd, false) });
  for (const expected of ["blocked-wtsub-config", "blocked-wtsub-hook", "blocked-config-worktree", "blocked-common-config-worktree", "blocked-sibling-config", "blocked-sibling-hook", "blocked-sibling-rename", "blocked-wtsub-rename", "blocked-wtmodules-rename", "wrote-worktree-file", "branched-config", "branched-in-sub", "tagged-config-in-sub", "committed-in-sub"]) expect(out.output).toContain(expected);
  for (const forbidden of ["WROTE-WTSUB-CONFIG", "WROTE-WTSUB-HOOK", "WROTE-CONFIG-WORKTREE", "WROTE-COMMON-CONFIG-WORKTREE", "WROTE-SIBLING-CONFIG", "WROTE-SIBLING-HOOK", "WROTE-SIBLING-RENAME", "WROTE-WTSUB-RENAME", "WROTE-WTMODULES-RENAME"]) expect(out.output).not.toContain(forbidden);
  expect(readFileSync(join(subGit, "config"), "utf8")).toBe(subConfig);
  expect(existsSync(join(subGit, "hooks"))).toBe(false);
  expect(existsSync(join(wtGit, "config.worktree"))).toBe(false);
  expect(existsSync(join(common, "config.worktree"))).toBe(false);
  expect(readFileSync(join(sibGit, "config"), "utf8")).toBe(sibConfig);
  expect(existsSync(join(sibGit, "hooks"))).toBe(false);
  expect(existsSync(`${sibGit}2`)).toBe(false);
  expect(existsSync(join(wtGit, "modules", "away"))).toBe(false);
  expect(existsSync(join(wtGit, "m2"))).toBe(false);
});

test.skipIf(!sandboxAvailable())("every linked worktree's git dir is protected by pattern: a modules tree that does not exist yet cannot be pre-created, and a sibling's own config.worktree is refused (#518 review)", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-wt-pattern-")));
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  const ident = ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"];
  const main = join(base, "main"), cwd = join(base, "wt"), sibling = join(base, "wt-sibling");
  expect(git(["init", "-q", main]).exitCode).toBe(0);
  writeFileSync(join(main, "f.txt"), "x\n"); git(["-C", main, "add", "f.txt"]); expect(git(["-C", main, ...ident, "commit", "-qm", "one"]).exitCode).toBe(0);
  expect(git(["-C", main, "worktree", "add", cwd]).exitCode).toBe(0);
  expect(git(["-C", main, "worktree", "add", sibling]).exitCode).toBe(0);
  // Neither worktree has a submodule, so neither git dir has a modules/ tree yet: nothing for discovery to find.
  const common = join(main, ".git"), own = join(common, "worktrees", "wt"), sib = join(common, "worktrees", "wt-sibling");
  expect(existsSync(join(own, "modules"))).toBe(false);
  expect(existsSync(join(sib, "modules"))).toBe(false);
  const out = await sandboxedExec(["/bin/sh", "-c", [
    `(mkdir '${sib}/modules') 2>/dev/null && echo WROTE-SIB-MODULES || echo blocked-sib-modules`,
    `(mkdir -p '${sib}/modules/x' && echo '[core]' > '${sib}/modules/x/config') 2>/dev/null && echo WROTE-SIB-PLANTED-CONFIG || echo blocked-sib-planted-config`,
    `(mkdir -p '${own}/modules/y' && echo '[core]' > '${own}/modules/y/config') 2>/dev/null && echo WROTE-OWN-PLANTED-CONFIG || echo blocked-own-planted-config`,
    `(echo x > '${sib}/config.worktree') 2>/dev/null && echo WROTE-SIB-CONFIG-WORKTREE || echo blocked-sib-config-worktree`,
    `(echo x > '${sib}/config') 2>/dev/null && echo WROTE-SIB-CONFIG || echo blocked-sib-config`,
    `(mkdir -p '${sib}/hooks' && echo x > '${sib}/hooks/pre-commit') 2>/dev/null && echo WROTE-SIB-HOOK || echo blocked-sib-hook`,
    // A worktree created AFTER the profile was built is covered too: the rule is a pattern, not a list.
    `(mkdir -p '${common}/worktrees/later/modules/z' && echo x > '${common}/worktrees/later/modules/z/config') 2>/dev/null && echo WROTE-LATER-WORKTREE || echo blocked-later-worktree`,
    // Ordinary work: the worktree, branches and tags named like the protected files, a commit.
    `(echo hi > new.txt) && echo wrote-worktree-file`,
    "git branch fix/config && echo branched-config",
    "git tag config && echo tagged-config",
    `git ${ident.join(" ")} commit -qm two --allow-empty && echo committed`,
  ].join("; ")], { cwd, profile: profile(cwd, false) });
  for (const expected of ["blocked-sib-modules", "blocked-sib-planted-config", "blocked-own-planted-config", "blocked-sib-config-worktree", "blocked-sib-config", "blocked-sib-hook", "blocked-later-worktree", "wrote-worktree-file", "branched-config", "tagged-config", "committed"]) expect(out.output).toContain(expected);
  for (const forbidden of ["WROTE-SIB-MODULES", "WROTE-SIB-PLANTED-CONFIG", "WROTE-OWN-PLANTED-CONFIG", "WROTE-SIB-CONFIG-WORKTREE", "WROTE-SIB-CONFIG", "WROTE-SIB-HOOK", "WROTE-LATER-WORKTREE"]) expect(out.output).not.toContain(forbidden);
  expect(existsSync(join(sib, "modules"))).toBe(false);
  expect(existsSync(join(own, "modules"))).toBe(false);
  expect(existsSync(join(sib, "config.worktree"))).toBe(false);
  // The sandbox may make an empty directory for a worktree git dir that does not exist (harmless: git needs HEAD, commondir and gitdir there, and the names that execute are refused); nothing inside it may exist.
  for (const name of ["modules", "config", "config.worktree", "hooks", "commondir"]) expect(existsSync(join(common, "worktrees", "later", name)), name).toBe(false);
});

test.skipIf(!sandboxAvailable())("config.worktree is refused with ignorable code points in BOTH halves of the name, in the project .git, a worktree git dir and the common dir, and an unrelated name stays writable (#518 review)", async () => {
  // The rule matches the path string, so a file named with the code points HFS+ ignores is refused wherever the volume is: on HFS+ it opens as the real name, on APFS it is another name the rule still covers.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-wt-fold-")));
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  const ident = ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"];
  const main = join(base, "main"), cwd = join(base, "wt");
  expect(git(["init", "-q", main]).exitCode).toBe(0);
  writeFileSync(join(main, "f.txt"), "x\n"); git(["-C", main, "add", "f.txt"]); expect(git(["-C", main, ...ident, "commit", "-qm", "one"]).exitCode).toBe(0);
  expect(git(["-C", main, "worktree", "add", cwd]).exitCode).toBe(0);
  const common = join(main, ".git"), own = join(common, "worktrees", "wt");
  const fold = (name: string, at: number, ch: string) => name.slice(0, at) + ch + name.slice(at);
  const spellings = {
    plain: "config.worktree",
    front: fold("config.worktree", 3, ZWJ),
    back: fold("config.worktree", 9, ZWJ),
    both: fold(fold("config.worktree", 3, ZWJ), 11, HFS_IGNORABLE_POINTS[0]!),
    ends: `${ZWJ}config.${ZWJ}worktree${ZWJ}`,
    dot: fold(fold("config.worktree", 6, ZWJ), 7, HFS_IGNORABLE_POINTS[14]!),
  };
  const legs: string[] = [];
  for (const [label, name] of Object.entries(spellings)) {
    legs.push(`(echo x > '${own}/${name}') 2>/dev/null && echo WROTE-WT-${label} || echo blocked-wt-${label}`);
    legs.push(`(echo x > '${common}/${name}') 2>/dev/null && echo WROTE-COMMON-${label} || echo blocked-common-${label}`);
    legs.push(`(echo x > .git/${name}) 2>/dev/null && echo WROTE-PROJECT-${label} || echo blocked-project-${label}`);
  }
  // The linked worktree's own .git is a gitfile, so the project-.git leg needs a plain checkout.
  const plain = join(base, "plain");
  expect(git(["init", "-q", plain]).exitCode).toBe(0);
  const run = (dir: string, commands: string[]) => sandboxedExec(["/bin/sh", "-c", commands.join("; ")], { cwd: dir, profile: profile(dir, false) });
  const worktree = await run(cwd, legs.filter((leg) => !leg.includes("echo x > .git/")));
  const project = await run(plain, legs.filter((leg) => leg.includes("echo x > .git/")));
  for (const label of Object.keys(spellings)) {
    expect(worktree.output).toContain(`blocked-wt-${label}`); expect(worktree.output).toContain(`blocked-common-${label}`);
    expect(project.output).toContain(`blocked-project-${label}`);
  }
  expect(worktree.output).not.toMatch(/WROTE-/); expect(project.output).not.toMatch(/WROTE-/);
  // Names that only look similar are not over-matched: ordinary git files in those directories stay writable where they were before.
  const unrelated = await run(cwd, [`(echo x > '${own}/ORIG_HEAD') && echo wrote-orig-head`, `(echo x > '${own}/worktree') 2>/dev/null && echo wrote-worktree-name || echo blocked-worktree-name`, "git branch fix/config.worktree && echo branched-dotted-name", "git tag config.worktree && echo tagged-dotted-name"]);
  expect(unrelated.output).toContain("wrote-orig-head"); expect(unrelated.output).toContain("branched-dotted-name"); expect(unrelated.output).toContain("tagged-dotted-name");
});

test.skipIf(!sandboxAvailable())("the ancestors of a protected git dir cannot be moved out and back: not the worktrees container, a worktree git dir, the common dir's modules tree or the .git directory (#518 review)", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-wt-ancestors-")));
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  const ident = ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"];
  const init = (dir: string) => { expect(git(["init", "-q", dir]).exitCode).toBe(0); writeFileSync(join(dir, "f"), "x"); git(["-C", dir, "add", "f"]); expect(git(["-C", dir, ...ident, "commit", "-qm", "one"]).exitCode).toBe(0); };
  const subSrc = join(base, "sub-src"), main = join(base, "main"), cwd = join(base, "wt"), sibling = join(base, "wt2");
  init(subSrc); init(main);
  expect(git(["-C", main, "-c", "protocol.file.allow=always", "submodule", "add", "-q", subSrc, "s"]).exitCode).toBe(0);
  expect(git(["-C", main, ...ident, "commit", "-qm", "s"]).exitCode).toBe(0);
  expect(git(["-C", main, "worktree", "add", cwd]).exitCode).toBe(0);
  expect(git(["-C", main, "worktree", "add", sibling]).exitCode).toBe(0);
  expect(git(["-C", sibling, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]).exitCode).toBe(0);
  // The main checkout's own submodule git dir sits in <common>/modules, the sibling's in <common>/worktrees/wt2/modules.
  expect(git(["-C", main, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]).exitCode).toBe(0);
  const common = join(main, ".git"), sibGit = join(common, "worktrees", "wt2"), sibSub = join(sibGit, "modules", "s"), mainSub = join(common, "modules", "s");
  const sibBefore = readFileSync(join(sibSub, "config"), "utf8"), mainBefore = readFileSync(join(mainSub, "config"), "utf8");
  // Each attack moves an ancestor away, edits the config underneath, and moves it back: the profile must refuse the first move.
  const attacks = [
    `(mv '${common}/worktrees' '${common}/w-away' && echo '[core]' >> '${common}/w-away/wt2/modules/s/config'; mv '${common}/w-away' '${common}/worktrees') 2>/dev/null; echo done-worktrees`,
    `(mv '${sibGit}' '${common}/away2' && echo '[core]' >> '${common}/away2/modules/s/config'; mv '${common}/away2' '${sibGit}') 2>/dev/null; echo done-sibling-gitdir`,
    `(mv '${sibGit}/modules' '${sibGit}/m-away' && echo '[core]' >> '${sibGit}/m-away/s/config'; mv '${sibGit}/m-away' '${sibGit}/modules') 2>/dev/null; echo done-sibling-modules`,
    `(mv '${common}/modules' '${common}/m-away' && echo '[core]' >> '${common}/m-away/s/config'; mv '${common}/m-away' '${common}/modules') 2>/dev/null; echo done-common-modules`,
    `(mv '${common}' '${main}/.git-away' && echo '[core]' >> '${main}/.git-away/modules/s/config'; mv '${main}/.git-away' '${common}') 2>/dev/null; echo done-dot-git`,
  ];
  for (const attack of attacks) {
    const out = await sandboxedExec(["/bin/sh", "-c", attack], { cwd, profile: profile(cwd, false) });
    expect(out.output).toContain("done-");
    expect(readFileSync(join(sibSub, "config"), "utf8"), attack).toBe(sibBefore);
    expect(readFileSync(join(mainSub, "config"), "utf8"), attack).toBe(mainBefore);
    expect(existsSync(join(common, "worktrees")) && existsSync(sibGit) && existsSync(join(common, "modules")), `the layout is intact after: ${attack}`).toBe(true);
  }
  // Ordinary work still runs after all of that: the worktree, a branch and a commit.
  const ok = await sandboxedExec(["/bin/sh", "-c", ["echo hi > ok.txt && echo wrote-file", "git branch fix/config && echo branched", `git ${ident.join(" ")} commit -qm two --allow-empty && echo committed`].join("; ")], { cwd, profile: profile(cwd, false) });
  for (const expected of ["wrote-file", "branched", "committed"]) expect(ok.output).toContain(expected);
});

test("no regex literal that folds a name carries the git path, so a long path cannot push one over SBPL's 1024-byte limit (#518 review)", () => {
  // A literal over 1024 BYTES (the HFS+ code points are 3 bytes each) makes sandbox-exec refuse the whole profile, so no sandboxed command starts. Bytes, not characters.
  const literal = /\(regex "((?:[^"\\]|\\.)*)"\)/g;
  const literals = (rules: string[]) => rules.flatMap((rule) => [...rule.matchAll(literal)].map((m) => m[1]!));
  const build = (pathBytes: number) => {
    const common = `/p${"a".repeat(pathBytes - "/p/.git".length)}/.git`;
    return hubWriteRegexes("/proj", [common], [{ root: `${common}/modules`, entries: [`${common}/modules`, `${common}/modules/sub`, `${common}/modules/sub/modules/deep`] }], `${common}/worktrees`);
  };
  for (const bytes of [40, 200, 450, 520, 700]) {
    const all = literals(build(bytes));
    const folded = all.filter((text) => text.includes(HFS_IGNORABLE_POINTS[1]!));
    expect(folded.length, `${bytes}: folded literals exist`).toBeGreaterThan(8);
    // The structural guarantee: a literal that folds a name never holds the path, so it is the same size at every path length.
    for (const text of folded) expect(text, `${bytes}: a folded literal names the path`).not.toContain("aaaa");
    expect(Math.max(...folded.map((text) => Buffer.byteLength(text))), `${bytes}: longest folded literal`).toBeLessThan(1000);
    // The plain root literals grow with the path and stay under the limit until a ~900-byte git path, a ceiling main already had.
    expect(Math.max(...all.map((text) => Buffer.byteLength(text))), `${bytes}: longest literal`).toBeLessThan(1024);
  }
});

test.skipIf(!sandboxAvailable())("a linked worktree with a submodule under a ~480-byte path: the profile still parses and the protections hold (#518 review)", async () => {
  let base = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-longpath-")));
  while (Buffer.byteLength(base) < 470) base = join(base, "d".repeat(Math.min(100, 470 - Buffer.byteLength(base))));
  mkdirSync(base, { recursive: true });
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  const ident = ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"];
  const init = (dir: string) => { expect(git(["init", "-q", dir]).exitCode).toBe(0); writeFileSync(join(dir, "f"), "x"); git(["-C", dir, "add", "f"]); expect(git(["-C", dir, ...ident, "commit", "-qm", "one"]).exitCode).toBe(0); };
  const subSrc = join(base, "sub-src"), main = join(base, "main"), cwd = join(base, "wt");
  init(subSrc); init(main);
  expect(git(["-C", main, "-c", "protocol.file.allow=always", "submodule", "add", "-q", subSrc, "s"]).exitCode).toBe(0);
  expect(git(["-C", main, ...ident, "commit", "-qm", "s"]).exitCode).toBe(0);
  expect(git(["-C", main, "worktree", "add", cwd]).exitCode).toBe(0);
  expect(git(["-C", cwd, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]).exitCode).toBe(0);
  expect(Buffer.byteLength(join(main, ".git"))).toBeGreaterThan(470);
  const own = join(main, ".git", "worktrees", "wt");
  const out = await sandboxedExec(["/bin/sh", "-c", [
    "echo started",
    `(echo x > '${own}/modules/s/config') 2>/dev/null && echo WROTE-SUB-CONFIG || echo blocked-sub-config`,
    `(echo x > '${own}/config.worktree') 2>/dev/null && echo WROTE-CW || echo blocked-cw`,
    `(mv '${own}/modules/s' '${own}/modules/away') 2>/dev/null && echo WROTE-RENAME || echo blocked-rename`,
    "echo hi > ok.txt && echo wrote-file",
    "git branch fix/config && echo branched",
  ].join("; ")], { cwd, profile: profile(cwd, false) });
  for (const expected of ["started", "blocked-sub-config", "blocked-cw", "blocked-rename", "wrote-file", "branched"]) expect(out.output).toContain(expected);
  expect(out.output).not.toContain("Error reading string"); expect(out.output).not.toMatch(/WROTE-/);
});

test.skipIf(!sandboxAvailable())("a nested bare-layout repository is not covered by the rules: the exclusion, tested (#281)", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-bare-")));
  Bun.spawnSync(["git", "init", "-q", cwd]);
  expect(Bun.spawnSync(["git", "init", "-q", "--bare", join(cwd, "nested.git")]).exitCode).toBe(0);
  // A bare layout has no `.git` name to anchor a rule on: the directory is the git dir, indistinguishable from an
  // ordinary one by name. The hub never runs git there (its calls are all -C <project root>), so these writes are
  // allowed; docs/security.md records the exclusion and its reason.
  const out = await sandboxedExec(["/bin/sh", "-c", [
    "(echo x > nested.git/config) 2>/dev/null && echo WROTE-BARE-CONFIG || echo blocked-bare-config",
    "(echo x > nested.git/hooks/pre-commit) 2>/dev/null && echo WROTE-BARE-HOOK || echo blocked-bare-hook",
  ].join("; ")], { cwd, profile: profile(cwd, false) });
  expect(out.output).toContain("WROTE-BARE-CONFIG");
  expect(out.output).toContain("WROTE-BARE-HOOK");
});

test.skipIf(!APFSX.ok)(`a case-sensitive APFS image: the deny rules hold there, and the code points HFS+ ignores are ordinary characters (#281)${APFSX.ok ? "" : ` [skipped: ${APFSX.why}]`}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-apfsx-test-"));
  const dmg = join(dir, "t.dmg"), mnt = join(dir, "mnt");
  mkdirSync(mnt);
  try {
    expect(Bun.spawnSync(["hdiutil", "create", "-size", "16m", "-fs", "Case-sensitive APFS", "-volname", "ahubtest", "-ov", dmg]).exitCode).toBe(0);
    expect(Bun.spawnSync(["hdiutil", "attach", "-nobrowse", "-mountpoint", mnt, dmg]).exitCode).toBe(0);
    const cwd = realpathSync(mnt);
    // The volume folds nothing: a ZWJ name is a different file, so a missed fold could never open the real config here.
    writeFileSync(join(cwd, "ab"), "x");
    expect(existsSync(join(cwd, `a${ZWJ}b`))).toBe(false);
    Bun.spawnSync(["git", "init", "-q"], { cwd });
    mkdirSync(join(cwd, ".git", "modules", "sub"), { recursive: true });
    rmSync(join(cwd, ".git", "config")); // a blocked create is the assertion, like the HFS+ leg
    const out = await sandboxedExec(["/bin/sh", "-c", [
      "(echo x > .git/config) 2>/dev/null && echo WROTE-CONFIG || echo blocked-config",
      `(echo x > '.git/co${ZWJ}nfig') 2>/dev/null && echo WROTE-FOLDED-CONFIG || echo blocked-folded-config`,
      "(echo x > .git/modules/sub/config) 2>/dev/null && echo WROTE-MOD-CONFIG || echo blocked-mod-config",
    ].join("; ")], { cwd, profile: profile(cwd, false) });
    for (const expected of ["blocked-config", "blocked-folded-config", "blocked-mod-config"]) expect(out.output).toContain(expected);
    expect(existsSync(join(cwd, ".git", "config"))).toBe(false);
    expect(existsSync(join(cwd, ".git", `co${ZWJ}nfig`))).toBe(false);
  } finally {
    detach(mnt);
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

test.skipIf(!sandboxAvailable())("the modules rules ignore the project's own ancestor names (#281)", async () => {
  // Executed against round 1's rule: a project under a directory named `refs` turned the rule off, and one under
  // `config` refused unrelated writes (FETCH_HEAD) inside a submodule git dir. The anchored rule holds both.
  for (const ancestor of ["refs", "config"]) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-ancestor-")));
    const cwd = join(base, ancestor, "proj");
    mkdirSync(cwd, { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd });
    mkdirSync(join(cwd, ".git", "modules", "sub"), { recursive: true });
    const out = await sandboxedExec(["/bin/sh", "-c", [
      "(echo x > .git/modules/sub/config) 2>/dev/null && echo WROTE-CONFIG || echo blocked-config",
      "(echo x > .git/modules/sub/FETCH_HEAD) 2>/dev/null && echo wrote-unrelated || echo blocked-unrelated",
    ].join("; ")], { cwd, profile: profile(cwd, false) });
    expect(out.output).toContain("blocked-config");
    expect(out.output).toContain("wrote-unrelated");
  }
});
