import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { profile, sandboxAvailable, sandboxedExec } from "../src/local/sandbox.ts";
import { guardPath, isDenied, runTool, type ToolContext } from "../src/local/tools.ts";

function project(permit = true) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-proj-")));
  writeFileSync(join(cwd, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(cwd, ".env.local"), "SECRET=1\n");
  mkdirSync(join(cwd, ".maru", "secrets"), { recursive: true });
  writeFileSync(join(cwd, ".maru", "secrets", "token"), "t0ken");
  mkdirSync(join(cwd, ".agenthub", "state"), { recursive: true });
  writeFileSync(join(cwd, ".agenthub", "state", "control-token"), "c0ntrol");
  const asked: string[] = [];
  const ctx: ToolContext = { cwd, deny: ["private/"], sandboxProfile: profile(cwd, false, [], ["private/"]), permit: async (t) => (asked.push(t), permit), send: (t, to) => `sent ${t} to ${to ?? "*"}` };
  return { cwd, ctx, asked };
}
const call = (ctx: ToolContext, name: string, args: unknown) => runTool(name, JSON.stringify(args), ctx);

test("paths: traversal, absolute outside paths, symlink escapes and denylisted names are refused", () => {
  const { cwd, ctx } = project();
  const outside = mkdtempSync(join(tmpdir(), "agenthub-out-"));
  writeFileSync(join(outside, "x"), "x");
  symlinkSync(outside, join(cwd, "link"));
  expect(guardPath(ctx, "a.txt", "read")).toBe(join(cwd, "a.txt"));
  expect(guardPath(ctx, "new/dir/file.ts", "write")).toBe(join(cwd, "new/dir/file.ts"));
  for (const p of ["../x", "/etc/passwd", "link/x", "link/new-file", join(homedir(), ".ssh/id_rsa")]) {
    expect(() => guardPath(ctx, p, "read")).toThrow(/outside the project/);
  }
  for (const p of [".env.local", ".maru/secrets/token", ".agenthub/state/control-token", "certs/server.pem", "deploy.key", "keys/id_ed25519.pub", "private/notes.md"]) {
    expect(() => guardPath(ctx, p, "read")).toThrow(/denylist/);
  }
  for (const p of [".git/hooks/pre-commit", ".agenthub/routing.toml"]) expect(() => guardPath(ctx, p, "write")).toThrow(/not writable/);
  expect(guardPath(ctx, ".agenthub/routing.toml", "read")).toContain("routing.toml");
  expect(isDenied("src/environment.ts")).toBe(false);
});

test("a dangling symlink cannot smuggle a write out of the project or into .git/hooks", async () => {
  const { cwd, ctx } = project();
  mkdirSync(join(cwd, ".git", "hooks"), { recursive: true });
  symlinkSync(join(cwd, ".git", "hooks", "pre-commit"), join(cwd, "hook"));
  symlinkSync(join(homedir(), `.agenthub-dangling-${process.pid}`), join(cwd, "out"));
  for (const p of ["hook", "out", "out/nested"]) expect(() => guardPath(ctx, p, "write")).toThrow(/dangling symlink|outside|not writable/);
  expect(await call(ctx, "write", { path: "hook", content: "echo pwned" })).toMatch(/^error: /);
  expect(() => readFileSync(join(cwd, ".git", "hooks", "pre-commit"))).toThrow();
});

test.skipIf(!sandboxAvailable())("git arguments: nothing absolute, nothing with .., nothing denylisted, and local.deny reaches the sandbox too", async () => {
  const { cwd, ctx, asked } = project();
  Bun.spawnSync(["git", "init", "-q"], { cwd });
  mkdirSync(join(cwd, "private"));
  writeFileSync(join(cwd, "private", "customers.csv"), "name,card\n");
  for (const args of [
    ["diff", "--no-index", "/dev/null", join(homedir(), ".cargo/credentials.toml")],
    ["diff", "--", "/etc/passwd"],
    ["show", "HEAD:.env.local"],
    ["show", "HEAD:private/customers.csv"],
    ["log", "-p", "--", "../other"],
    ["diff", "--output=/tmp/x"],
  ]) {
    expect(await call(ctx, "git", { args })).toMatch(/^error: git /);
  }
  expect(asked).toHaveLength(0);
  const out = await call(ctx, "bash", { command: "(cat private/customers.csv 2>/dev/null | grep -q card) && echo READ-CUSTOM-DENY || echo blocked-custom-deny" });
  expect(out).toContain("blocked-custom-deny");
  expect(isDenied("home/.cargo/credentials.toml")).toBe(true);
});

test("read is free; write and edit ask first and do nothing when refused", async () => {
  const { cwd, ctx, asked } = project();
  expect(await call(ctx, "read", { path: "a.txt", offset: 2, limit: 1 })).toBe("2\ttwo");
  expect(asked).toHaveLength(0);
  expect(await call(ctx, "edit", { path: "a.txt", old: "two", new: "2" })).toBe("edited a.txt");
  expect(await call(ctx, "edit", { path: "a.txt", old: "e", new: "E" })).toMatch(/matched 3 times/);
  expect(await call(ctx, "write", { path: "sub/b.txt", content: "hi" })).toBe("wrote sub/b.txt");
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("one\n2\nthree\n");
  expect(asked).toEqual(["edit a.txt:\n- two\n+ 2", "write sub/b.txt (2 chars):\nhi"]); // the approver sees what is written

  const denied = project(false);
  expect(await call(denied.ctx, "write", { path: "c.txt", content: "x" })).toMatch(/did not approve/);
  expect(await call(denied.ctx, "bash", { command: "touch c.txt" })).toMatch(/did not approve/);
  expect(() => readFileSync(join(denied.cwd, "c.txt"))).toThrow();
});

test("failures are text for the model, never exceptions", async () => {
  const { ctx } = project();
  expect(await runTool("read", "{not json", ctx)).toMatch(/not valid JSON/);
  expect(await call(ctx, "read", { path: ".env.local" })).toMatch(/^error: .*denylist/);
  expect(await call(ctx, "read", { path: "missing.txt" })).toMatch(/^error: /);
  expect(await call(ctx, "git", { args: ["push", "origin", "main"] })).toMatch(/not available/);
  expect(await call(ctx, "git", { args: ["-c", "core.pager=sh", "log"] })).toMatch(/not available/);
  expect(await call(ctx, "nope", {})).toMatch(/unknown tool/);
  expect(await call(ctx, "hub_send", { text: "[IMPORTANT] done", to: ["claude"] })).toBe("sent [IMPORTANT] done to claude");
});

test.skipIf(!sandboxAvailable())("sandbox: writes stay in the project, credential stores and denylisted files are unreadable, no network, clean env", async () => {
  const { cwd, ctx, asked } = project();
  Bun.spawnSync(["git", "init", "-q"], { cwd }); // so .git/hooks exists and the hook write is a real attempt
  process.env.OMNIROUTE_API_KEY = "sk-must-not-leak";
  const outside = join(homedir(), `.agenthub-sandbox-probe-${process.pid}`);
  const out = await call(ctx, "bash", {
    command: [
      "echo inside > made-by-bash.txt && echo wrote-inside",
      `(echo x > ${outside}) 2>/dev/null && echo WROTE-OUTSIDE || echo blocked-outside`,
      "(ls ~/.ssh >/dev/null 2>&1) && echo READ-SSH || echo blocked-ssh",
      "(cat ~/.claude.json >/dev/null 2>&1) && echo READ-HOME || echo blocked-home",
      "(ls ~/Documents >/dev/null 2>&1) && echo LISTED-HOME || echo blocked-home-listing",
      "(bun --version >/dev/null 2>&1 && git --version >/dev/null 2>&1 && cat a.txt >/dev/null) && echo toolchains-ok || echo TOOLCHAINS-BROKEN",
      "(cat .env.local 2>/dev/null | grep -q SECRET) && echo READ-ENV || echo blocked-env",
      "(cat .agenthub/state/control-token 2>/dev/null | grep -q c0ntrol) && echo READ-TOKEN || echo blocked-token",
      "(echo 'echo pwned' > .git/hooks/pre-commit) 2>/dev/null && echo WROTE-HOOK || echo blocked-hook",
      "(curl -s -m 3 http://example.com >/dev/null 2>&1) && echo NETWORK || echo blocked-network",
      'echo "key=[$OMNIROUTE_API_KEY]"',
    ].join("; "),
  });
  delete process.env.OMNIROUTE_API_KEY;
  for (const expected of ["wrote-inside", "blocked-outside", "blocked-ssh", "blocked-home", "blocked-home-listing", "toolchains-ok", "blocked-env", "blocked-token", "blocked-hook", "blocked-network", "key=[]", "(exit 0)"]) {
    expect(out).toContain(expected);
  }
  expect(readFileSync(join(cwd, "made-by-bash.txt"), "utf8")).toBe("inside\n");
  expect(asked[0]).toStartWith("bash: echo inside");
});

test.skipIf(!sandboxAvailable())("a local.deny entry with a quote or a backslash, or a project root with a quote, still makes a profile that denies exactly those paths (issue #23)", async () => {
  const cwd = join(realpathSync(mkdtempSync(join(tmpdir(), "agenthub-quote-"))), 'we"ird');
  const entries = ['q"uoted/', "back\\slash/"];
  mkdirSync(cwd);
  for (const e of entries) {
    mkdirSync(join(cwd, e));
    writeFileSync(join(cwd, e, "secret.txt"), "hidden");
  }
  writeFileSync(join(cwd, "open.txt"), "visible");
  const { output } = await sandboxedExec(["/bin/sh", "-c", `cat open.txt; cat 'q"uoted/secret.txt' 2>/dev/null || echo blocked-quote; cat 'back\\slash/secret.txt' 2>/dev/null || echo blocked-backslash`], { cwd, profile: profile(cwd, false, [], entries) });
  expect(output).toContain("visible");
  expect(output).toContain("blocked-quote");
  expect(output).toContain("blocked-backslash");
  expect(output).not.toContain("hidden");
});

test("guardPath in a project whose path has a backslash: inside reads pass, escapes are still refused (issue #26)", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-bs-")));
  const cwd = join(base, "back\\slash");
  mkdirSync(join(cwd, "sub"), { recursive: true });
  writeFileSync(join(cwd, "a.txt"), "x");
  symlinkSync(base, join(cwd, "out\\link"));
  symlinkSync(join(cwd, "sub"), join(cwd, "in\\link"));
  symlinkSync(join(cwd, "gone"), join(cwd, "dang\\ling"));
  const ctx = { cwd, deny: [] };
  expect(guardPath(ctx, "a.txt", "read")).toBe(join(cwd, "a.txt"));
  expect(guardPath(ctx, "in\\link/new.txt", "write")).toBe(join(cwd, "sub", "new.txt"));
  expect(() => guardPath(ctx, "../x", "read")).toThrow(/outside the project/);
  expect(() => guardPath(ctx, "out\\link/x", "read")).toThrow(/outside the project/);
  expect(() => guardPath(ctx, "dang\\ling", "write")).toThrow(/dangling symlink/);
  // Names are checked as stored on disk: another spelling the file system opens as .git/config or .env is refused too.
  mkdirSync(join(cwd, ".git"));
  writeFileSync(join(cwd, ".git", "config"), "x");
  writeFileSync(join(cwd, ".env"), "x");
  writeFileSync(join(cwd, "id_rsa"), "x");
  for (const [asked, mode] of [[".GIT/config", "write"], [".ENV", "read"], ["id_rſa" /* long s, U+017F */, "read"]] as const) {
    if (existsSync(join(cwd, asked))) expect(() => guardPath(ctx, asked, mode)).toThrow(/denylist|not writable/);
  }
});

test.skipIf(!sandboxAvailable())("the local worker's sandbox builds and works in a project whose path has a backslash (issue #26)", async () => {
  const cwd = join(realpathSync(mkdtempSync(join(tmpdir(), "agenthub-bs-"))), "back\\slash");
  mkdirSync(join(cwd, "private"), { recursive: true });
  writeFileSync(join(cwd, "open.txt"), "visible");
  writeFileSync(join(cwd, "private", "secret.txt"), "hidden");
  const { output } = await sandboxedExec(["/bin/sh", "-c", "cat open.txt; cat private/secret.txt 2>/dev/null || echo blocked-deny; echo made > new.txt && echo wrote-inside"], { cwd, profile: profile(cwd, false, [], ["private/"]) });
  expect(output).toContain("visible");
  expect(output).toContain("blocked-deny");
  expect(output).toContain("wrote-inside");
  expect(output).not.toContain("hidden");
});

test.skipIf(!sandboxAvailable())("git: read-only subcommands run without asking, mutating ones ask, timeouts kill", async () => {
  const { cwd, ctx, asked } = project();
  Bun.spawnSync(["git", "init", "-q"], { cwd });
  expect(await call(ctx, "git", { args: ["status", "--short"] })).toContain("a.txt");
  expect(asked).toHaveLength(0);
  expect(await call(ctx, "git", { args: ["add", "a.txt"] })).toContain("(exit 0)");
  expect(asked).toEqual(["git add a.txt"]);
  const slow = await sandboxedExec(["/bin/sleep", "5"], { cwd, profile: ctx.sandboxProfile, timeoutMs: 200 });
  expect(slow.output).toContain("killed");
  // grandchildren holding the pipe must not keep the call waiting past its timeout
  const t0 = Date.now();
  const tree = await sandboxedExec(["/bin/bash", "-c", "(sleep 30 &) ; sleep 30"], { cwd, profile: ctx.sandboxProfile, timeoutMs: 300 });
  expect(tree.output).toContain("killed");
  expect(Date.now() - t0).toBeLessThan(5000);
});

// issue #39: the deny-default profile still runs the toolchains, and reads less than the old allow-default one.
test.skipIf(!sandboxAvailable())("deny-default: bun, node and git work; outside the system, toolchain and project dirs nothing is readable", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-denydefault-")));
  writeFileSync(join(cwd, "a.test.ts"), 'import { expect, test } from "bun:test";\ntest("t", () => expect(1).toBe(1));\n');
  Bun.spawnSync(["git", "init", "-q"], { cwd }); // outside: init writes .git/hooks, which the sandbox denies in both profiles
  const run = (command: string, base: "deny" | "allow" = "deny") => sandboxedExec(["/bin/sh", "-c", command], { cwd, profile: profile(cwd, false, [], [], base) });
  const tools = await run([
    "node -e 'console.log(\"node-ok\")'",
    "bun -e 'console.log(\"bun-ok\")'",
    "bun test a.test.ts >/dev/null 2>&1 && echo bun-test-ok",
    "git add a.test.ts && git -c user.name=t -c user.email=t@localhost -c commit.gpgsign=false commit -q -m x && git log --oneline | wc -l | tr -d ' ' && echo git-ok",
  ].join("; "));
  for (const expected of ["node-ok", "bun-ok", "bun-test-ok", "git-ok"]) expect(tools.output).toContain(expected);
  const probe = "(ls /private/var/log >/dev/null 2>&1) && echo READ-VAR-LOG || echo blocked-var-log";
  expect((await run(probe)).output).toContain("blocked-var-log");
  expect((await run(probe, "allow")).output).toContain("READ-VAR-LOG"); // what the old profile let through
});

test("no mach broker that acts outside the sandbox: LaunchServices (open starts apps), SecurityServer (Keychain)", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-brokers-")));
  for (const network of [false, true]) {
    const p = profile(cwd, network);
    for (const broker of ["coreservicesd", "launchservicesd", "SecurityServer"]) expect(p).not.toContain(broker);
  }
});
