import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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
