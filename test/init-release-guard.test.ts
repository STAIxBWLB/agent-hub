import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, planInit } from "../src/cli/init.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-release-init-")), root = join(dir, "repo"), global = join(dir, "gitconfig");
  mkdirSync(root); writeFileSync(global, "");
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = global;
  cleanup.push(() => { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; rmSync(dir, { recursive: true, force: true }); });
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_SYSTEM: "/dev/null" }, timeout: 3000 });
  expect(git("init", "-q").status).toBe(0);
  return { dir, root, git, hooks: join(root, ".git/hooks"), global };
}

test("release guard is opt-in, previews no writes, persists and is idempotent", () => {
  const f = fixture();
  writeFileSync(join(f.root, "AGENTS.md"), "# Mine\nKeep this.\n");
  init(f.root);
  expect(existsSync(join(f.hooks, "pre-push"))).toBe(false);
  const before = readFileSync(join(f.root, "AGENTS.md"), "utf8"), preview = planInit(f.root, undefined, false, true);
  expect(preview.some(row => row.path === join(f.hooks, "pre-push"))).toBe(true);
  expect(readFileSync(join(f.root, "AGENTS.md"), "utf8")).toBe(before);
  expect(existsSync(join(f.hooks, "pre-push"))).toBe(false);
  expect(init(f.root, undefined, false, true).sort()).toEqual(preview.map(row => row.path).sort());
  const agents = readFileSync(join(f.root, "AGENTS.md"), "utf8"), hook = readFileSync(join(f.hooks, "pre-push"), "utf8");
  expect(agents).toStartWith("# Mine\nKeep this.\n");
  expect(agents).toContain("ahub sdlc release-guard --");
  expect(hook).toContain(process.execPath);
  expect(hook).toContain('sdlc release-guard-hook "$1" "$2"');
  expect(hook).toContain('umask 077');
  expect(lstatSync(join(f.hooks, "pre-push")).mode & 0o111).toBe(0o111);
  expect(init(f.root)).toEqual([]);
  expect(readFileSync(join(f.root, "AGENTS.md"), "utf8")).toBe(agents);
});

test("release guard preserves the existing hook inode, bytes and executable mode", () => {
  const f = fixture(), hook = join(f.hooks, "pre-push"), backup = join(f.hooks, "pre-push.agent-hub-original");
  const content = "#!/bin/sh\nexit 7\n";
  writeFileSync(hook, content, { mode: 0o751 });
  const before = lstatSync(hook);
  const preview = planInit(f.root, undefined, false, true);
  expect(preview.some(row => row.path === backup && row.action === "create")).toBe(true);
  expect(readFileSync(hook, "utf8")).toBe(content);
  init(f.root, undefined, false, true);
  const after = lstatSync(backup);
  expect([after.dev, after.ino, after.mode]).toEqual([before.dev, before.ino, before.mode]);
  expect(readFileSync(backup, "utf8")).toBe(content);
  expect(init(f.root)).toEqual([]);
});

for (const unsafe of ["hook-link", "hook-hardlink", "hooks-link", "occupied-backup", "local-hooks-path", "global-hooks-path"]) {
  test(`release guard refuses ${unsafe} before writing project instructions`, () => {
    const f = fixture(), hook = join(f.hooks, "pre-push");
    const other = join(f.dir, "other");
    writeFileSync(other, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    if (unsafe === "hook-link") symlinkSync(other, hook);
    if (unsafe === "hook-hardlink") linkSync(other, hook);
    if (unsafe === "hooks-link") { rmSync(f.hooks, { recursive: true }); mkdirSync(join(f.dir, "other-hooks")); symlinkSync(join(f.dir, "other-hooks"), f.hooks); }
    if (unsafe === "occupied-backup") writeFileSync(join(f.hooks, "pre-push.agent-hub-original"), "keep");
    if (unsafe === "local-hooks-path") expect(f.git("config", "--local", "core.hooksPath", f.hooks).status).toBe(0);
    if (unsafe === "global-hooks-path") writeFileSync(f.global, `[core]\n hooksPath = ${f.hooks}\n`);
    expect(() => init(f.root, undefined, false, true)).toThrow();
    expect(existsSync(join(f.root, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(f.root, ".agenthub"))).toBe(false);
    expect(readFileSync(other, "utf8")).toBe("#!/bin/sh\nexit 0\n");
  });
}

test("a worktree release guard installs in the shared default hooks directory", () => {
  const f = fixture(), worktree = join(f.dir, "worktree");
  expect(f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "fixture").status).toBe(0);
  expect(f.git("worktree", "add", "-qb", "other", worktree).status).toBe(0);
  expect(planInit(worktree, undefined, false, true).some(row => row.path === join(f.hooks, "pre-push"))).toBe(true);
  init(worktree, undefined, false, true);
  expect(existsSync(join(f.hooks, "pre-push"))).toBe(true);
});

test("the installed wrapper chains exact argv/stdin only after a successful preflight", () => {
  const f = fixture(), hook = join(f.hooks, "pre-push"), received = join(f.dir, "received");
  writeFileSync(hook, `#!/bin/sh\nprintf '%s\\n' "$@" > '${received}.args'\ncat > '${received}.stdin'\numask > '${received}.umask'\nexit 7\n`, { mode: 0o755 });
  init(f.root, undefined, false, true);
  const guard = join(f.dir, "guard.ts");
  writeFileSync(guard, 'import { readFileSync } from "node:fs"; const input=readFileSync(0); if(process.env.FIXTURE_DENY==="1") process.exit(3); process.stdout.write(input);\n');
  const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
  const installed = readFileSync(hook, "utf8"), entry = join(import.meta.dir, "../src/cli/main.ts");
  expect(installed).toContain(`${quote(process.execPath)} ${quote(entry)}`);
  // Substitute only the read-only host decision for this native shell/chain fixture.
  const fixtureWrapper = join(f.dir, "wrapper");
  writeFileSync(fixtureWrapper, installed.replace(quote(entry), quote(guard)), { mode: 0o755 });
  const input = `refs/tags/v1.2.3 ${"a".repeat(40)} refs/tags/v1.2.3 ${"0".repeat(40)}\n`;
  const args = ["origin", "https://example.test/repo"];
  const run = (deny: boolean) => spawnSync("sh", ["-c", 'umask 022; exec "$@"', "fixture", fixtureWrapper, ...args], { cwd: f.root, input, encoding: "utf8", env: { ...process.env, FIXTURE_DENY: deny ? "1" : "0" }, timeout: 3000 });
  expect(run(true).status).toBe(3);
  expect(existsSync(`${received}.stdin`)).toBe(false);
  expect(run(false).status).toBe(7);
  expect(readFileSync(`${received}.stdin`, "utf8")).toBe(input);
  expect(readFileSync(`${received}.args`, "utf8")).toBe(args.join("\n") + "\n");
  expect(Number.parseInt(readFileSync(`${received}.umask`, "utf8").trim(), 8)).toBe(0o022);
});
