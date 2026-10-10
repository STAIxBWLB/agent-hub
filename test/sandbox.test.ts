import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HFS_IGNORABLE_POINTS } from "../src/local/deny.ts";
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
    // An external git dir on the same volume, joiner spellings included: the common dir's config, hooks and the
    // worktree record's commondir stay refused. Each target is removed first, so a folded write would create it.
    const main2 = join(cwd, "main2");
    expect(Bun.spawnSync(["git", "init", "-q", main2]).exitCode).toBe(0);
    writeFileSync(join(main2, "a.txt"), "one\n");
    Bun.spawnSync(["git", "-C", main2, "add", "a.txt"]);
    Bun.spawnSync(["git", "-C", main2, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "one"]);
    const wt = join(cwd, "wt2");
    expect(Bun.spawnSync(["git", "-C", main2, "worktree", "add", wt]).exitCode).toBe(0);
    rmSync(join(main2, ".git", "config"));
    rmSync(join(main2, ".git", "hooks"), { recursive: true, force: true });
    rmSync(join(main2, ".git", "worktrees", "wt2", "commondir"));
    const ext = await sandboxedExec(["/bin/sh", "-c", [
      `(echo x > '${main2}/.git/co${ZWJ}nfig') 2>/dev/null && echo WROTE-EXT-CONFIG || echo blocked-ext-config`,
      `(mkdir '${main2}/.git/ho${ZWJ}ks' && echo x > '${main2}/.git/ho${ZWJ}ks/pre-commit') 2>/dev/null && echo WROTE-EXT-HOOKS || echo blocked-ext-hooks`,
      `(echo x > '${main2}/.git/worktrees/wt2/co${ZWJ}mmondir') 2>/dev/null && echo WROTE-EXT-COMMONDIR || echo blocked-ext-commondir`,
    ].join("; ")], { cwd: wt, profile: profile(wt, false) });
    for (const expected of ["blocked-ext-config", "blocked-ext-hooks", "blocked-ext-commondir"]) expect(ext.output).toContain(expected);
    expect(existsSync(join(main2, ".git", "config"))).toBe(false);
    expect(existsSync(join(main2, ".git", "hooks"))).toBe(false);
    expect(existsSync(join(main2, ".git", "worktrees", "wt2", "commondir"))).toBe(false);
  } finally {
    detach(mnt);
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
